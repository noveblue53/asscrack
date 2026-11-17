'use strict';

// Voice over libp2p. The main process sends the Opus frames on a libp2p stream to the room host,
// and the host forwards them to the other voice members (star topology). There is no RTCPeerConnection.
// Capture: microphone -> AudioWorklet (20 ms blocks) -> AudioEncoder (Opus) -> api.sendVoiceFrame.
// Playback: api.onVoiceFrame -> one AudioDecoder for each origin -> playback worklet (60 ms jitter buffer, mix).
(function () {
    const api = window.asscrack;

    const SAMPLE_RATE = 48000;
    const BLOCK = 960;
    const BITRATE = 32000;
    // An origin with no frame for this time has level 0.
    const LEVEL_HOLD_MS = 300;

    let selfId = null;
    let hostId = null;
    let inVoice = false;
    let muted = false;
    let localStream = null;
    let context = null;
    let captureNode = null;
    let playbackNode = null;
    let sourceNode = null;
    let encoder = null;
    let timestamp = 0;
    // peerId -> { inVoice, streamId, muted } of the other peers.
    const members = new Map();
    // origin -> { decoder, bytesReceived, audioLevel, lastAt, timestamp }
    const origins = new Map();
    const listeners = [];

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
        if (!inVoice || muted || !encoder || encoder.state !== 'configured' || !canSend()) return;
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

    async function startAudio() {
        if (typeof AudioEncoder !== 'function' || typeof AudioDecoder !== 'function') {
            throw new Error('this window has no AudioEncoder or AudioDecoder (WebCodecs)');
        }
        const support = await AudioEncoder.isConfigSupported({
            codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: BITRATE
        });
        if (!support?.supported) throw new Error('the Opus encoder is not supported');
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        try {
            context = new AudioContext({ sampleRate: SAMPLE_RATE });
            await context.audioWorklet.addModule('voice-worklet.js');
            sourceNode = context.createMediaStreamSource(localStream);
            captureNode = new AudioWorkletNode(context, 'voice-capture', {
                numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit'
            });
            captureNode.port.onmessage = ({ data }) => encodeBlock(data);
            sourceNode.connect(captureNode);
            playbackNode = new AudioWorkletNode(context, 'voice-playback', {
                numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]
            });
            playbackNode.connect(context.destination);
            encoder = makeEncoder();
            timestamp = 0;
            if (context.state === 'suspended') await context.resume();
        } catch (err) {
            stopAudio();
            throw err;
        }
    }

    function stopAudio() {
        if (encoder && encoder.state !== 'closed') encoder.close();
        encoder = null;
        for (const o of origins.values()) {
            if (o.decoder && o.decoder.state !== 'closed') o.decoder.close();
            o.decoder = null;
        }
        if (captureNode) captureNode.port.onmessage = null;
        try { sourceNode?.disconnect(); } catch { /* already disconnected */ }
        try { captureNode?.disconnect(); } catch { /* already disconnected */ }
        try { playbackNode?.disconnect(); } catch { /* already disconnected */ }
        sourceNode = null;
        captureNode = null;
        playbackNode = null;
        if (localStream) for (const track of localStream.getTracks()) track.stop();
        localStream = null;
        if (context) context.close().catch(() => {});
        context = null;
    }

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

    window.voice = {
        async join() {
            if (inVoice) return;
            await refreshHost();
            await startAudio();
            muted = false;
            inVoice = true;
            try {
                await api.setVoice({ inVoice: true, streamId: localStream.id });
            } catch (err) {
                inVoice = false;
                stopAudio();
                throw err;
            }
            changed();
        },
        async leave() {
            inVoice = false;
            muted = false;
            stopAudio();
            await api.setVoice({ inVoice: false, streamId: null });
            changed();
        },
        setMuted(muted_) {
            muted = muted_ === true;
            const track = localStream?.getAudioTracks()[0];
            if (!track) return;
            track.enabled = !muted;
            api.setVoice({ inVoice: true, streamId: localStream.id, muted })
                .catch(err => console.warn('Voice state send failed:', err?.message ?? err));
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
                members: Object.fromEntries(members),
                // The origins that sent frames to this window.
                connections: [...origins.keys()]
            };
        }
    };
})();
