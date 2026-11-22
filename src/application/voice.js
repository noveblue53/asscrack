'use strict';

// Voice over libp2p. The main process sends the Opus frames on a libp2p stream to the room host,
// and the host forwards them to the other voice members (star topology). There is no RTCPeerConnection.
// Capture: microphone (echo cancellation, gain control and noise suppression of Chromium)
//   -> RNNoise worklet (noise suppression 'rnnoise', @sapphi-red/web-noise-suppressor) -> AudioWorklet (20 ms blocks)
//   -> send gate (voice-gate.js: voice activity or push to talk) -> AudioEncoder (Opus) -> api.sendVoiceFrame.
// 'rnnoise' keeps the noise suppression of Chromium on and adds RNNoise after it: RNNoise alone did not always
// suppress a steady noise in the first seconds after a join (measured, DECISIONS.md). 'standard': Chromium only.
// RNNoise comes before the gate, thus noise that RNNoise removes does not open voice activity.
// Playback: api.onVoiceFrame -> one AudioDecoder for each origin -> playback worklet (60 ms jitter buffer, mix).
// Chromium's echo canceller uses all audio that this window plays as its reference, also the playback worklet
// (measured, DECISIONS.md). Do not use echoCancellation: 'remote-only': it removes only RTCPeerConnection audio.
// A closed gate or a mute sends no frames. The 0.6.0 peers and the relay already accept this (a muted member).
// G4: a microphone error does not stop Join (state "in voice, no capture": playback only, muted: true to the peers).
// Deafen stops the playback of the voice of the others and mutes the microphone. The mute state stays through Leave
// and Join while the window runs (not saved to disk). Idle Peer sets it to off.
(function () {
    const api = window.asscrack;
    const gateLib = window.voiceGate;

    const SAMPLE_RATE = 48000;
    const BLOCK = 960;
    const BITRATE = 32000;
    // An origin with no frame for this time has level 0.
    const LEVEL_HOLD_MS = 300;

    let selfId = null;
    let hostId = null;
    let inVoice = false;
    let muted = false;
    // Deafen (C2): no samples go to the playback node and the microphone is muted. mutedBeforeDeafen comes back at
    // Deafen off.
    let deafened = false;
    let mutedBeforeDeafen = false;
    // The settings panel is open: the capture runs for the input meter, also out of voice. Nothing goes out.
    let previewWanted = false;
    // A pending microphone request can finish after the window has entered and reopened from Idle Peer.
    let captureGeneration = 0;
    function checkCapture(generation) {
        if (generation !== captureGeneration || window.idlePeer?.isIdle()) throw new Error('Voice capture ended');
    }
    let settings = null;
    const gate = gateLib.createGate(null);
    let transmitting = false;
    let inputLevel = gateLib.FLOOR_DB;
    // The input device of the settings was not found: the capture uses the default device.
    let inputFallback = false;
    // The last microphone error, when no capture is open (C1, C7): 'not-found', 'not-allowed', 'not-readable', 'other'.
    let captureError = null;
    // The output device of the settings did not open or is not connected: the playback uses the default device.
    let outputFallback = false;
    // The errors of getUserMedia. Only these keep the user in voice. A different error still stops Join.
    const microphoneErrors = new WeakSet();

    let localStream = null;
    let context = null;
    let captureNode = null;
    let playbackNode = null;
    let sourceNode = null;
    let encoder = null;
    let timestamp = 0;
    // RNNoise: the WASM bytes (one read for each start of the window), the worklet module of this context, the node.
    const RNNOISE_PROCESSOR = '@sapphi-red/web-noise-suppressor/rnnoise';
    let rnnoiseBinary = null;
    let rnnoiseUrl = null;
    let rnnoiseError = null;
    let rnnoiseInContext = false;
    let rnnoiseNode = null;
    // peerId -> { inVoice, streamId, muted } of the other peers.
    const members = new Map();
    // origin -> { decoder, bytesReceived, audioLevel, lastAt, timestamp }
    const origins = new Map();
    // This listener's choices for the current chat sessions, keyed by the original speaker.
    const listening = new Map();
    function listeningFor(origin) {
        return { muted: false, volume: 100, ...listening.get(origin) };
    }
    function applyGain(origin) {
        const { muted, volume } = listeningFor(origin);
        playbackNode?.port.postMessage({ type: 'gain', origin, gain: muted ? 0 : volume / 100 });
    }
    const listeners = [];
    const levelListeners = [];

    // One audio change at a time: join, leave, a settings change and the preview use the same objects.
    let queue = Promise.resolve();
    function serial(fn) {
        const run = queue.then(fn);
        queue = run.catch(() => {});
        return run;
    }

    function changed() {
        for (const callback of listeners) {
            try {
                callback();
            } catch (err) {
                console.warn('voice onChange callback failed:', err);
            }
        }
    }

    function canSend() {
        return typeof api.sendVoiceFrame === 'function';
    }

    function encodeBlock(samples) {
        if (!encoder || encoder.state !== 'configured' || !canSend()) return;
        const data = new AudioData({
            format: 'f32',
            sampleRate: SAMPLE_RATE,
            numberOfFrames: samples.length,
            numberOfChannels: 1,
            timestamp,
            data: samples
        });
        timestamp += Math.round(samples.length * 1e6 / SAMPLE_RATE);
        try {
            encoder.encode(data);
        } catch (err) {
            console.warn('Voice encode failed:', err?.message ?? err);
        } finally {
            data.close();
        }
    }

    // Each 20 ms block of the microphone.
    function onBlock(samples) {
        const result = gate.push(samples, performance.now());
        inputLevel = result.level;
        const sending = inVoice && !muted;
        if (sending) for (const b of result.send) encodeBlock(b);
        const next = sending && result.open;
        if (next !== transmitting) {
            transmitting = next;
            changed();
        }
        for (const callback of levelListeners) {
            try {
                callback(inputLevel, result.open);
            } catch (err) {
                console.warn('voice onLevel callback failed:', err);
            }
        }
    }

    function makeEncoder() {
        const enc = new AudioEncoder({
            output: chunk => {
                const bytes = new Uint8Array(chunk.byteLength);
                chunk.copyTo(bytes);
                if (!canSend()) return;
                Promise.resolve(api.sendVoiceFrame(bytes))
                    .catch(err => console.warn('Voice frame send failed:', err?.message ?? err));
            },
            error: err => console.warn('Voice encoder error:', err?.message ?? err)
        });
        enc.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: BITRATE });
        return enc;
    }

    function originEntry(origin) {
        let o = origins.get(origin);
        if (o) return o;
        o = { decoder: null, bytesReceived: 0, audioLevel: 0, lastAt: 0, timestamp: 0 };
        origins.set(origin, o);
        return o;
    }

    function makeDecoder(origin, o) {
        applyGain(origin);
        const dec = new AudioDecoder({
            output: audio => {
                try {
                    const samples = new Float32Array(audio.numberOfFrames);
                    audio.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
                    let sum = 0;
                    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
                    o.audioLevel = Math.sqrt(sum / Math.max(1, samples.length));
                    // Deafen: the level above still updates, but no samples go to the playback node.
                    if (playbackNode && inVoice && !deafened) {
                        playbackNode.port.postMessage({ type: 'samples', origin, samples }, [samples.buffer]);
                    }
                } finally {
                    audio.close();
                }
            },
            error: err => {
                console.warn('Voice decoder error:', err?.message ?? err);
                o.decoder = null;
            }
        });
        dec.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
        return dec;
    }

    function handleFrame({ origin, data } = {}) {
        if (typeof origin !== 'string' || !data || origin === selfId) return;
        const o = originEntry(origin);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        o.bytesReceived += bytes.length;
        o.lastAt = performance.now();
        // A host that is not in voice does not play.
        if (!inVoice || !playbackNode || typeof AudioDecoder !== 'function') return;
        if (!o.decoder) o.decoder = makeDecoder(origin, o);
        try {
            o.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: o.timestamp, data: bytes }));
            o.timestamp += Math.round(BLOCK * 1e6 / SAMPLE_RATE);
        } catch (err) {
            console.warn('Voice decode failed:', err?.message ?? err);
        }
    }

    function removeOrigin(origin) {
        const o = origins.get(origin);
        origins.delete(origin);
        if (o?.decoder && o.decoder.state !== 'closed') o.decoder.close();
        playbackNode?.port.postMessage({ type: 'remove', origin });
    }

    // ---- Audio objects ----

    // The noise suppressor in use: 'rnnoise', 'standard' or 'off'. When RNNoise did not load, 'standard'.
    function suppressor() {
        const wanted = settings?.noiseSuppression ?? 'rnnoise';
        if (wanted === 'rnnoise' && rnnoiseError) return 'standard';
        return wanted === 'standard' || wanted === 'off' ? wanted : 'rnnoise';
    }

    // WebAssembly SIMD check (the same bytes as wasm-feature-detect in the package).
    const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
        65, 0, 253, 15, 253, 98, 11]);

    // Load RNNoise one time. A failure sets rnnoiseError, and the capture uses the noise suppression of Chromium.
    // The worklet compiles the WASM itself and gives no error to this window, thus compile it here first as a check.
    async function loadRnnoise() {
        if (rnnoiseBinary || rnnoiseError) return;
        try {
            if (typeof api.getRnnoise !== 'function') throw new Error('no RNNoise in this build');
            const simd = WebAssembly.validate(SIMD_TEST);
            const { workletUrl, wasm } = await api.getRnnoise(simd);
            const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
            const binary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            await WebAssembly.compile(binary);
            rnnoiseBinary = binary;
            rnnoiseUrl = workletUrl;
            console.info(`Voice RNNoise loaded (${simd ? 'SIMD' : 'no SIMD'}, ${bytes.byteLength} bytes)`);
        } catch (err) {
            rnnoiseError = err?.message ?? String(err);
            console.warn(`Voice RNNoise not available (${rnnoiseError}); the standard noise suppression is used`);
        }
    }

    async function ensureRnnoiseNode() {
        if (rnnoiseNode) return true;
        await loadRnnoise();
        if (!rnnoiseBinary) return false;
        try {
            if (!rnnoiseInContext) {
                await context.audioWorklet.addModule(rnnoiseUrl);
                rnnoiseInContext = true;
            }
            rnnoiseNode = new AudioWorkletNode(context, RNNOISE_PROCESSOR, {
                numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
                outputChannelCount: [1], processorOptions: { maxChannels: 1, wasmBinary: rnnoiseBinary }
            });
            return true;
        } catch (err) {
            rnnoiseError = err?.message ?? String(err);
            console.warn(`Voice RNNoise worklet failed (${rnnoiseError}); the standard noise suppression is used`);
            return false;
        }
    }

    // One RNNoise node for each audio context. It is not made again for a settings change: the 'destroy' message of
    // the package does not arrive (its processor listens with addEventListener and no port.start()), thus each new
    // node stays alive until the context closes. With no input the processor does no work.
    function dropRnnoiseNode() {
        if (!rnnoiseNode) return;
        try { rnnoiseNode.disconnect(); } catch { /* already disconnected */ }
        rnnoiseNode = null;
    }

    // source -> (RNNoise) -> capture worklet.
    function wireCapture() {
        if (!sourceNode || !captureNode) return;
        try { sourceNode.disconnect(); } catch { /* already disconnected */ }
        try { rnnoiseNode?.disconnect(); } catch { /* already disconnected */ }
        if (suppressor() === 'rnnoise' && rnnoiseNode) {
            sourceNode.connect(rnnoiseNode);
            rnnoiseNode.connect(captureNode);
        } else {
            sourceNode.connect(captureNode);
        }
    }

    function audioConstraints(useDevice) {
        const s = settings ?? {};
        const audio = {
            echoCancellation: s.echoCancellation !== false,
            noiseSuppression: suppressor() !== 'off',
            autoGainControl: s.autoGainControl !== false,
            channelCount: { ideal: 1 },
            sampleRate: { ideal: SAMPLE_RATE }
        };
        if (useDevice && s.inputDeviceId) audio.deviceId = { exact: s.inputDeviceId };
        return audio;
    }

    function getMicrophone(constraints) {
        return navigator.mediaDevices.getUserMedia(constraints).catch(err => {
            if (err && typeof err === 'object') microphoneErrors.add(err);
            throw err;
        });
    }

    async function openMicrophone(generation) {
        const useDevice = Boolean(settings?.inputDeviceId);
        try {
            const stream = await getMicrophone({ audio: audioConstraints(useDevice) });
            inputFallback = false;
            return stream;
        } catch (err) {
            if (!useDevice || !['OverconstrainedError', 'NotFoundError'].includes(err?.name)) throw err;
            checkCapture(generation);
            console.warn(`Voice input device not found (${err.name}); the default device is used`);
            const stream = await getMicrophone({ audio: audioConstraints(false) });
            inputFallback = true;
            return stream;
        }
    }

    // C7: the class of a microphone error, by err.name.
    const ERROR_CODES = { NotFoundError: 'not-found', NotAllowedError: 'not-allowed', NotReadableError: 'not-readable' };
    const errorCode = name => ERROR_CODES[name] ?? 'other';

    // C1 and C7: the text for a microphone error. error: an error object, an err.name or a captureError code of
    // voice.state(). listening: the user is in voice and can listen.
    function microphoneErrorText(error, listening = false) {
        const codes = Object.values(ERROR_CODES);
        const code = codes.includes(error) || error === 'other' ? error
            : errorCode(typeof error === 'string' ? error : error?.name);
        const until = listening ? ' You can listen until then.' : '';
        if (code === 'not-found') {
            return 'No microphone. You can listen, but the others cannot hear you. Connect a microphone and ASSCRACK uses it.';
        }
        if (code === 'not-allowed') {
            return 'Windows does not let ASSCRACK use the microphone. Open Windows Settings, Privacy, Microphone, ' +
                'and allow desktop apps.' + until;
        }
        if (code === 'not-readable') {
            return 'The microphone did not start. A different app can have it in use. Close that app, or select a ' +
                'different microphone in Voice settings.' + until;
        }
        return 'The microphone did not start.';
    }

    function logCapture(stream) {
        const track = stream.getAudioTracks()[0];
        if (!track) return;
        const applied = track.getSettings();
        console.info(`Voice capture: device "${track.label}" suppressor ${suppressor()} settings ${JSON.stringify({
            echoCancellation: applied.echoCancellation,
            noiseSuppression: applied.noiseSuppression,
            autoGainControl: applied.autoGainControl,
            sampleRate: applied.sampleRate,
            channelCount: applied.channelCount,
            latency: applied.latency
        })}`);
    }

    // outputFallback: the selected output device did not open, thus the default device plays.
    async function applySink() {
        if (!context || typeof context.setSinkId !== 'function') return;
        const wanted = settings?.outputDeviceId ?? '';
        if (context.sinkId === wanted) {
            outputFallback = false;
            return;
        }
        try {
            await context.setSinkId(wanted);
            outputFallback = false;
            console.info(`Voice output device: ${wanted === '' ? 'default' : 'selected device'}`);
        } catch (err) {
            console.warn(`Voice output device not set (${err?.name ?? err}); the default device is used`);
            outputFallback = true;
            if (context && context.sinkId !== '') await context.setSinkId('').catch(() => {});
        }
    }

    // C1: after a device change. The selected output is not in the list: use the default device. It is back: use it.
    async function checkOutput() {
        if (!context || typeof context.setSinkId !== 'function') return;
        const wanted = settings?.outputDeviceId ?? '';
        const list = wanted ? await navigator.mediaDevices.enumerateDevices() : [];
        if (!wanted || list.some(d => d.kind === 'audiooutput' && d.deviceId === wanted)) {
            await applySink();
            return;
        }
        if (!outputFallback) console.warn('Voice output device not connected; the default device is used');
        outputFallback = true;
        if (context && context.sinkId !== '') await context.setSinkId('').catch(() => {});
    }

    async function ensureContext() {
        if (context) return;
        context = new AudioContext({ sampleRate: SAMPLE_RATE });
        // C1: an error of the output device (for example, the device went away) gives the same check as a device change.
        context.addEventListener?.('error', deviceChanged);
        await context.audioWorklet.addModule('voice-worklet.js');
        await applySink();
    }

    // The track sends nothing while the user is muted in voice. Out of voice the preview meter shows the microphone.
    function applyTrack() {
        const track = localStream?.getAudioTracks()[0];
        if (track) track.enabled = !(inVoice && muted);
    }

    // The state for the peers. With no capture the others cannot hear this user: muted.
    function sendState() {
        if (!inVoice) return Promise.resolve();
        return Promise.resolve(api.setVoice({
            inVoice: true, streamId: localStream?.id ?? null, muted: muted || localStream === null, deafened
        })).catch(err => console.warn('Voice state send failed:', err?.message ?? err));
    }

    // C1: open the capture again (the track ended, a device came, or a new device choice). Call it in the serial
    // queue. A microphone error keeps the state "in voice, no capture". before: the stream before this change. The
    // peers get a new state when the capture starts or stops.
    async function reopenCapture(before = localStream) {
        if (!inVoice && !previewWanted) return;
        try {
            await startCapture();
        } catch (err) {
            if (!microphoneErrors.has(err) && err?.message !== 'Voice capture ended') {
                console.warn('Voice capture did not open again:', err?.message ?? err);
            }
        }
        if ((before === null) !== (localStream === null)) await sendState();
        changed();
    }

    function captureEnded(stream) {
        if (stream !== localStream) return;
        console.warn('Voice microphone track ended; the capture opens again');
        const generation = captureGeneration;
        serial(async () => {
            if (stream !== localStream || generation !== captureGeneration) return;
            closeCapture();
            await reopenCapture(stream);
        });
    }

    // C1: a device change while in voice, 500 ms after the last event.
    const DEVICE_SETTLE_MS = 500;
    let deviceTimer = null;
    function deviceChanged() {
        if (!inVoice) return;
        if (deviceTimer !== null) clearTimeout(deviceTimer);
        deviceTimer = setTimeout(() => {
            deviceTimer = null;
            const generation = captureGeneration;
            serial(async () => {
                if (!inVoice || generation !== captureGeneration) return;
                let reopen = localStream === null;
                if (!reopen && inputFallback && settings?.inputDeviceId) {
                    // Open again only when the selected microphone is back: else the audio stops for no reason.
                    const list = await navigator.mediaDevices.enumerateDevices();
                    reopen = list.some(d => d.kind === 'audioinput' && d.deviceId === settings.inputDeviceId);
                }
                if (reopen) await reopenCapture();
                await checkOutput().catch(err => console.warn('Voice output check failed:', err?.message ?? err));
                changed();
            });
        }, DEVICE_SETTLE_MS);
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', deviceChanged);

    function closeCapture() {
        try { sourceNode?.disconnect(); } catch { /* already disconnected */ }
        sourceNode = null;
        if (localStream) for (const track of localStream.getTracks()) track.stop();
        localStream = null;
    }

    // Open the microphone (again) and connect it to the capture worklet. Close the old capture first: while a track of
    // the device is open, Chromium gives the new track the same source, thus the old processing settings (measured).
    async function startCapture(generation = captureGeneration) {
        checkCapture(generation);
        await ensureContext();
        // RNNoise first: its result decides the noise suppression of Chromium for the new track.
        if ((settings?.noiseSuppression ?? 'rnnoise') === 'rnnoise') await ensureRnnoiseNode();
        closeCapture();
        checkCapture(generation);
        let stream;
        try {
            stream = await openMicrophone(generation);
        } catch (err) {
            if (microphoneErrors.has(err) && generation === captureGeneration) {
                captureError = errorCode(err?.name);
                console.warn(`Voice microphone did not open (${err?.name ?? 'Error'}: ${err?.message ?? err})`);
                changed();
            }
            throw err;
        }
        try { checkCapture(generation); } catch (err) {
            for (const track of stream.getTracks()) track.stop();
            throw err;
        }
        localStream = stream;
        captureError = null;
        const track = stream.getAudioTracks()[0];
        applyTrack();
        // C1: the device of the track went away (for example a USB microphone). Open the capture again.
        track?.addEventListener?.('ended', () => captureEnded(stream));
        logCapture(stream);
        if (!captureNode) {
            captureNode = new AudioWorkletNode(context, 'voice-capture', {
                numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit'
            });
            captureNode.port.onmessage = ({ data }) => onBlock(data);
        }
        sourceNode = context.createMediaStreamSource(stream);
        wireCapture();
        if (context.state === 'suspended') await context.resume();
    }

    function startPlayback() {
        if (!playbackNode) {
            playbackNode = new AudioWorkletNode(context, 'voice-playback', {
                numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]
            });
            playbackNode.connect(context.destination);
        }
        if (!encoder) {
            encoder = makeEncoder();
            timestamp = 0;
        }
    }

    function stopPlayback() {
        if (encoder && encoder.state !== 'closed') encoder.close();
        encoder = null;
        for (const o of origins.values()) {
            if (o.decoder && o.decoder.state !== 'closed') o.decoder.close();
            o.decoder = null;
        }
        try { playbackNode?.disconnect(); } catch { /* already disconnected */ }
        playbackNode = null;
    }

    function stopAudio() {
        stopPlayback();
        closeCapture();
        dropRnnoiseNode();
        rnnoiseInContext = false;
        if (captureNode) captureNode.port.onmessage = null;
        try { captureNode?.disconnect(); } catch { /* already disconnected */ }
        captureNode = null;
        if (context) context.close().catch(() => {});
        context = null;
        outputFallback = false;
        gate.reset();
        inputLevel = gateLib.FLOOR_DB;
        if (transmitting) {
            transmitting = false;
            changed();
        }
    }

    async function startAudio(generation) {
        checkCapture(generation);
        if (typeof AudioEncoder !== 'function' || typeof AudioDecoder !== 'function') {
            throw new Error('this window has no AudioEncoder or AudioDecoder (WebCodecs)');
        }
        const support = await AudioEncoder.isConfigSupported({
            codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: BITRATE
        });
        if (!support?.supported) throw new Error('the Opus encoder is not supported');
        try {
            if (!localStream) {
                // C1 and N1: with no microphone the user stays in voice and listens.
                try {
                    await startCapture(generation);
                } catch (err) {
                    if (!microphoneErrors.has(err)) throw err;
                    checkCapture(generation);
                    await ensureContext();
                }
            }
            checkCapture(generation);
            startPlayback();
            if (context.state === 'suspended') await context.resume();
        } catch (err) {
            stopAudio();
            throw err;
        }
    }

    // The fields that change the track. 'rnnoise' and 'standard' both open the track with Chromium noise
    // suppression, thus a failure of RNNoise does not change the track.
    function captureKey(s) {
        if (!s) return '';
        const ns = s.noiseSuppression === 'off' ? 'off' : 'on';
        return `${s.echoCancellation}|${ns}|${s.autoGainControl}|${s.inputDeviceId}`;
    }

    // ---- Host and members ----

    // All callers share one pending query.
    let hostQuery = null;
    function refreshHost() {
        if (!hostQuery) {
            hostQuery = api.getHost().then(info => {
                selfId = info.self;
                hostId = info.host?.peerId ?? null;
            }).finally(() => { hostQuery = null; });
        }
        return hostQuery;
    }

    function refreshIds() {
        if (selfId !== null) return;
        refreshHost().then(changed).catch(err => console.warn('Host query failed:', err?.message ?? err));
    }

    if (typeof api.onVoiceFrame === 'function') api.onVoiceFrame(handleFrame);
    api.onVoiceState(({ peerId, inVoice: memberInVoice, streamId, muted: memberMuted, deafened: memberDeafened } = {}) => {
        members.set(peerId, { inVoice: memberInVoice === true, streamId: streamId ?? null, muted: memberMuted === true,
            deafened: memberInVoice === true && memberDeafened === true });
        if (memberInVoice !== true) removeOrigin(peerId);
        refreshIds();
        changed();
    });
    api.onHostChanged(info => {
        hostId = info?.peerId ?? null;
        refreshIds();
        changed();
    });
    api.onPeerLeft(({ peerId } = {}) => {
        members.delete(peerId);
        listening.delete(peerId);
        removeOrigin(peerId);
        changed();
    });

    // The saved settings. The window can join voice before this read ends: then the defaults apply until it ends.
    const settingsReady = typeof api.getVoiceSettings === 'function'
        ? api.getVoiceSettings().then(value => {
            if (!settings) {
                settings = value;
                gate.configure(value);
            }
        }).catch(err => console.warn('Voice settings read failed:', err?.message ?? err))
        : Promise.resolve();

    window.voice = {
        listeningFor,
        setListening(origin, muted, volume) {
            // G4: 0 to 200 %. Above 100 % the playback worklet limits the output, thus it does not clip.
            if (!Number.isInteger(volume) || volume < 0 || volume > 200 || typeof muted !== 'boolean') return;
            if (!muted && volume === 100) listening.delete(origin);
            else listening.set(origin, { muted, volume });
            applyGain(origin);
        },
        async join() {
            if (inVoice) return;
            const generation = captureGeneration;
            checkCapture(generation);
            await refreshHost();
            await settingsReady;
            await serial(() => startAudio(generation));
            checkCapture(generation);
            // C8: the mute state from before Join stays.
            deafened = false;
            inVoice = true;
            applyTrack();
            try {
                await api.setVoice({ inVoice: true, streamId: localStream?.id ?? null, muted: muted || localStream === null,
                    deafened: false });
                checkCapture(generation);
            } catch (err) {
                inVoice = false;
                applyTrack();
                await serial(async () => {
                    stopAudio();
                    if (previewWanted) await startCapture();
                }).catch(() => {});
                throw err;
            }
            changed();
        },
        enterIdle() {
            captureGeneration++;
            inVoice = false;
            muted = false;
            deafened = false;
            mutedBeforeDeafen = false;
            previewWanted = false;
            transmitting = false;
            gate.reset();
            stopPlayback();
            closeCapture();
            changed();
            // Drain any pending device request, then dispose its context and worklets before a later join.
            return serial(stopAudio);
        },
        async leave() {
            inVoice = false;
            // C2: Leave turns Deafen off, and the mute state from before Deafen comes back. C8: the mute state stays.
            if (deafened) muted = mutedBeforeDeafen;
            deafened = false;
            await serial(async () => {
                stopAudio();
                if (previewWanted) {
                    await startCapture().catch(err => console.warn('Voice preview failed:', err?.message ?? err));
                }
            });
            await api.setVoice({ inVoice: false, streamId: null });
            changed();
        },
        // C8: also before Join (then nothing goes to the peers). C2: Unmute while deafened also turns Deafen off.
        setMuted(muted_) {
            muted = muted_ === true;
            if (!muted) deafened = false;
            applyTrack();
            if (muted) transmitting = false;
            void sendState();
            changed();
        },
        // C2: only in voice. Deafen off gives back the mute state from before Deafen.
        setDeafened(deafened_) {
            const next = deafened_ === true;
            if (!inVoice || next === deafened) return;
            if (next) {
                mutedBeforeDeafen = muted;
                muted = true;
            } else {
                muted = mutedBeforeDeafen;
            }
            deafened = next;
            applyTrack();
            if (muted) transmitting = false;
            void sendState();
            changed();
        },
        microphoneErrorText,
        // The push-to-talk key went down or up (voice-panel.js listens to the keys).
        setPushToTalk(down) {
            const before = gate.keyDown();
            gate.setKey(!window.idlePeer?.isIdle() && down === true, performance.now());
            if (before !== gate.keyDown()) changed();
        },
        settings: () => settings,
        // New settings (the full object from the main process). A change of the processing or of the input device
        // opens the microphone again: applyConstraints() does not change the processing in Chromium (measured).
        applySettings(next) {
            const before = settings;
            settings = next;
            gate.configure(next);
            return serial(async () => {
                if (!localStream) {
                    // C1: in voice with no capture, a new choice of the devices can open the microphone.
                    if (inVoice) {
                        await applySink();
                        await reopenCapture();
                    }
                    return;
                }
                if (captureKey(before) !== captureKey(next)) {
                    if (inVoice) await reopenCapture();
                    else await startCapture();
                } else {
                    if (suppressor() === 'rnnoise') await ensureRnnoiseNode();
                    wireCapture();
                }
                await applySink();
                changed();
            });
        },
        // The meter of the settings panel: the capture runs while the panel is open.
        startPreview() {
            if (window.idlePeer?.isIdle()) return Promise.resolve();
            previewWanted = true;
            return serial(async () => {
                if (!previewWanted || localStream) return;
                // In voice with no capture (C1): a new try, and the peers get the state when it opens.
                if (inVoice) await reopenCapture();
                else await startCapture();
            });
        },
        stopPreview() {
            previewWanted = false;
            return serial(async () => {
                if (!inVoice && !previewWanted) stopAudio();
            });
        },
        onLevel(callback) {
            if (typeof callback === 'function') levelListeners.push(callback);
        },
        async devices() {
            const list = await navigator.mediaDevices.enumerateDevices();
            const pick = kind => list
                .filter(d => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
                .map(d => ({ id: d.deviceId, label: d.label || 'Unnamed device' }));
            return { inputs: pick('audioinput'), outputs: pick('audiooutput') };
        },
        // origin -> { bytesReceived, audioLevel }, as before.
        async stats() {
            const result = {};
            const now = performance.now();
            for (const [origin, o] of origins) {
                const level = now - o.lastAt > LEVEL_HOLD_MS ? 0 : o.audioLevel;
                result[origin] = { bytesReceived: o.bytesReceived, audioLevel: level };
            }
            return result;
        },
        onChange(callback) {
            if (typeof callback === 'function') listeners.push(callback);
        },
        // State for tests and step 5.
        state() {
            return {
                self: selfId,
                host: hostId,
                inVoice,
                // The gate is open and this window sends frames.
                transmitting,
                inputMode: settings?.mode ?? 'voice',
                pttHeld: gate.keyDown(),
                inputLevel,
                inputFallback,
                capturing: localStream !== null,
                // C1: the last microphone error while no capture is open, and the output fallback.
                captureError: localStream === null ? captureError : null,
                outputFallback,
                muted,
                deafened,
                // The noise suppressor in use, and the reason when RNNoise did not load.
                suppressor: suppressor(),
                rnnoiseError,
                members: Object.fromEntries(members),
                // The origins that sent frames to this window.
                connections: [...origins.keys()]
            };
        }
    };
})();
