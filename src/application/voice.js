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
    // The settings panel is open: the capture runs for the input meter, also out of voice. Nothing goes out.
    let previewWanted = false;
    let settings = null;
    const gate = gateLib.createGate(null);
    let transmitting = false;
    let inputLevel = gateLib.FLOOR_DB;
    // The input device of the settings was not found: the capture uses the default device.
    let inputFallback = false;

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
        const dec = new AudioDecoder({
            output: audio => {
                try {
                    const samples = new Float32Array(audio.numberOfFrames);
                    audio.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
                    let sum = 0;
                    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
                    o.audioLevel = Math.sqrt(sum / Math.max(1, samples.length));
                    if (playbackNode && inVoice) {
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
        if (!o) return;
        origins.delete(origin);
        if (o.decoder && o.decoder.state !== 'closed') o.decoder.close();
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

    async function openMicrophone() {
        const useDevice = Boolean(settings?.inputDeviceId);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(useDevice) });
            inputFallback = false;
            return stream;
        } catch (err) {
            if (!useDevice || !['OverconstrainedError', 'NotFoundError'].includes(err?.name)) throw err;
            console.warn(`Voice input device not found (${err.name}); the default device is used`);
            const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(false) });
            inputFallback = true;
            return stream;
        }
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

    async function applySink() {
        if (!context || typeof context.setSinkId !== 'function') return;
        const wanted = settings?.outputDeviceId ?? '';
        if (context.sinkId === wanted) return;
        try {
            await context.setSinkId(wanted);
            console.info(`Voice output device: ${wanted === '' ? 'default' : 'selected device'}`);
        } catch (err) {
            console.warn(`Voice output device not set (${err?.name ?? err}); the default device is used`);
            if (context.sinkId !== '') await context.setSinkId('').catch(() => {});
        }
    }

    async function ensureContext() {
        if (context) return;
        context = new AudioContext({ sampleRate: SAMPLE_RATE });
        await context.audioWorklet.addModule('voice-worklet.js');
        await applySink();
    }

    function closeCapture() {
        try { sourceNode?.disconnect(); } catch { /* already disconnected */ }
        sourceNode = null;
        if (localStream) for (const track of localStream.getTracks()) track.stop();
        localStream = null;
    }

    // Open the microphone (again) and connect it to the capture worklet. Close the old capture first: while a track of
    // the device is open, Chromium gives the new track the same source, thus the old processing settings (measured).
    async function startCapture() {
        await ensureContext();
        // RNNoise first: its result decides the noise suppression of Chromium for the new track.
        if ((settings?.noiseSuppression ?? 'rnnoise') === 'rnnoise') await ensureRnnoiseNode();
        closeCapture();
        const stream = await openMicrophone();
        localStream = stream;
        const track = stream.getAudioTracks()[0];
        if (track) track.enabled = !muted;
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
        gate.reset();
        inputLevel = gateLib.FLOOR_DB;
        if (transmitting) {
            transmitting = false;
            changed();
        }
    }

    async function startAudio() {
        if (typeof AudioEncoder !== 'function' || typeof AudioDecoder !== 'function') {
            throw new Error('this window has no AudioEncoder or AudioDecoder (WebCodecs)');
        }
        const support = await AudioEncoder.isConfigSupported({
            codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: BITRATE
        });
        if (!support?.supported) throw new Error('the Opus encoder is not supported');
        try {
            if (!localStream) await startCapture();
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
    api.onVoiceState(({ peerId, inVoice: memberInVoice, streamId, muted: memberMuted } = {}) => {
        members.set(peerId, { inVoice: memberInVoice === true, streamId: streamId ?? null, muted: memberMuted === true });
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
        async join() {
            if (inVoice) return;
            await refreshHost();
            await settingsReady;
            await serial(startAudio);
            muted = false;
            const track = localStream?.getAudioTracks()[0];
            if (track) track.enabled = true;
            inVoice = true;
            try {
                await api.setVoice({ inVoice: true, streamId: localStream.id });
            } catch (err) {
                inVoice = false;
                await serial(async () => {
                    stopAudio();
                    if (previewWanted) await startCapture();
                });
                throw err;
            }
            changed();
        },
        async leave() {
            inVoice = false;
            muted = false;
            await serial(async () => {
                stopAudio();
                if (previewWanted) {
                    await startCapture().catch(err => console.warn('Voice preview failed:', err?.message ?? err));
                }
            });
            await api.setVoice({ inVoice: false, streamId: null });
            changed();
        },
        setMuted(muted_) {
            muted = muted_ === true;
            const track = localStream?.getAudioTracks()[0];
            if (!track) return;
            track.enabled = !muted;
            if (muted && transmitting) {
                transmitting = false;
                changed();
            }
            api.setVoice({ inVoice: true, streamId: localStream.id, muted })
                .catch(err => console.warn('Voice state send failed:', err?.message ?? err));
        },
        // The push-to-talk key went down or up (voice-panel.js listens to the keys).
        setPushToTalk(down) {
            gate.setKey(down === true, performance.now());
        },
        settings: () => settings,
        // New settings (the full object from the main process). A change of the processing or of the input device
        // opens the microphone again: applyConstraints() does not change the processing in Chromium (measured).
        applySettings(next) {
            const before = settings;
            settings = next;
            gate.configure(next);
            return serial(async () => {
                if (!localStream) return;
                if (captureKey(before) !== captureKey(next)) {
                    await startCapture();
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
            previewWanted = true;
            return serial(async () => {
                if (previewWanted && !localStream) await startCapture();
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
                inputLevel,
                inputFallback,
                capturing: localStream !== null,
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
