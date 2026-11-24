'use strict';

// Screen share audio engine in the room window: 48 kHz stereo Opus at 96 kbps (20 ms frames).
// - Sharer: encodes stereo Float32 blocks from either the Windows WASAPI process-loopback helper ('process' mode via
//   api.onScreenAudioPcm) or Chromium's loopback MediaStream track ('loopback' mode via 'screen-audio-capture' worklet)
//   using WebCodecs AudioEncoder and sends Opus frames over api.sendScreenAudioFrame.
// - Viewer: decodes incoming Opus frames from api.onScreenAudioFrame using WebCodecs AudioDecoder ->
//   'screen-audio-playback' low-latency worklet -> GainNode (0..100 %) -> voice output device.
// Exposes window.screenAudio for screen-share.js, screen-view.js and voice.js.
(function () {
    const api = window.asscrack;
    if (!api) return;

    const SAMPLE_RATE = 48000;
    const BITRATE = 96000;
    const FRAME_US = 20000;
    const BLOCK_FRAMES = 960;

    // ---- Sharer capture state ----
    let captureActive = false;
    let captureMode = 'none';
    let capturePaused = false;
    let encoder = null;
    let encodeTs = 0;
    let capCtx = null;
    let capSource = null;
    let capNode = null;

    // ---- Viewer playback state ----
    let playTarget = null; // { peerId, shareId }
    let playVolume = 80;
    let playCtx = null;
    let playCtxReady = null;
    let playNode = null;
    let gainNode = null;
    let decoder = null;
    let decodeTs = 0;

    const stats = {
        sent: 0, sentBytes: 0, received: 0, receivedBytes: 0,
        encodeErrors: 0, decodeErrors: 0
    };

    // ---- Sharer side ----

    function closeEncoder() {
        const enc = encoder;
        encoder = null;
        if (enc) {
            try { if (enc.state !== 'closed') enc.close(); } catch { /* closed */ }
        }
        encodeTs = 0;
    }

    function ensureEncoder() {
        if (encoder && encoder.state === 'configured') return encoder;
        if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
        closeEncoder();
        const enc = new AudioEncoder({
            output(chunk) {
                if (!captureActive || capturePaused) return;
                const bytes = new Uint8Array(chunk.byteLength);
                chunk.copyTo(bytes);
                if (bytes.length > 0 && bytes.length <= 4000) {
                    api.sendScreenAudioFrame?.(bytes);
                    stats.sent++;
                    stats.sentBytes += bytes.length;
                }
            },
            error() {
                stats.encodeErrors++;
                if (encoder === enc) closeEncoder();
            }
        });
        enc.configure({
            codec: 'opus',
            sampleRate: SAMPLE_RATE,
            numberOfChannels: 2,
            bitrate: BITRATE
        });
        encoder = enc;
        return enc;
    }

    function encodeStereoBlock(left, right) {
        if (!captureActive || capturePaused) return;
        if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== right.length || left.length === 0) return;
        const enc = ensureEncoder();
        if (!enc || enc.encodeQueueSize > 8) return;
        try {
            const frames = left.length;
            const planar = new Float32Array(frames * 2);
            planar.set(left, 0);
            planar.set(right, frames);
            const data = new AudioData({
                format: 'f32-planar',
                sampleRate: SAMPLE_RATE,
                numberOfFrames: frames,
                numberOfChannels: 2,
                timestamp: encodeTs,
                data: planar
            });
            encodeTs += Math.round((frames / SAMPLE_RATE) * 1000000);
            enc.encode(data);
            data.close();
        } catch {
            stats.encodeErrors++;
        }
    }

    async function startCapture({ mode, stream = null } = {}) {
        stopCapture();
        if (mode !== 'process' && mode !== 'loopback') return false;
        captureActive = true;
        captureMode = mode;
        capturePaused = false;
        ensureEncoder();
        if (mode === 'loopback' && stream && typeof AudioContext !== 'undefined') {
            try {
                const tracks = stream.getAudioTracks?.() ?? [];
                if (!tracks.length) return true;
                const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
                capCtx = ctx;
                await ctx.audioWorklet.addModule('screen-audio-worklet.js');
                if (capCtx !== ctx || !captureActive) {
                    ctx.close().catch(() => {});
                    return false;
                }
                const audioOnly = new MediaStream(tracks);
                capSource = ctx.createMediaStreamSource(audioOnly);
                capNode = new AudioWorkletNode(ctx, 'screen-audio-capture', {
                    numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit'
                });
                capNode.port.onmessage = ({ data }) => {
                    if (data?.left && data?.right) encodeStereoBlock(data.left, data.right);
                };
                capSource.connect(capNode);
                if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
            } catch (err) {
                console.warn('Screen loopback audio capture did not start:', err?.message ?? err);
            }
        }
        return true;
    }

    function stopCapture() {
        captureActive = false;
        captureMode = 'none';
        capturePaused = false;
        closeEncoder();
        try { capSource?.disconnect(); } catch { /* closed */ }
        try { capNode?.disconnect(); } catch { /* closed */ }
        capSource = null;
        capNode = null;
        const ctx = capCtx;
        capCtx = null;
        if (ctx) ctx.close().catch(() => {});
    }

    function setCapturePaused(paused) {
        capturePaused = paused === true;
    }

    api.onScreenAudioPcm?.(block => {
        if (captureActive && captureMode === 'process' && !capturePaused && block?.left && block?.right) {
            const left = block.left instanceof Float32Array ? block.left : new Float32Array(block.left);
            const right = block.right instanceof Float32Array ? block.right : new Float32Array(block.right);
            encodeStereoBlock(left, right);
        }
    });

    // ---- Viewer side ----

    async function applyOutputDevice() {
        const wanted = window.voice?.settings?.()?.outputDeviceId ?? '';
        if (!playCtx || typeof playCtx.setSinkId !== 'function' || playCtx.sinkId === wanted) return;
        await playCtx.setSinkId(wanted).catch(() => playCtx.setSinkId('').catch(() => {}));
    }

    function ensurePlaybackContext() {
        if (playCtxReady) return playCtxReady;
        if (typeof AudioContext === 'undefined') return Promise.resolve(null);
        playCtxReady = (async () => {
            const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
            playCtx = ctx;
            await ctx.audioWorklet.addModule('screen-audio-worklet.js');
            if (playCtx !== ctx) throw new Error('Screen audio playback closed');
            gainNode = ctx.createGain();
            gainNode.gain.value = Math.max(0, Math.min(1, playVolume / 100));
            gainNode.connect(ctx.destination);
            playNode = new AudioWorkletNode(ctx, 'screen-audio-playback', {
                numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]
            });
            playNode.connect(gainNode);
            await applyOutputDevice();
            if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
            return ctx;
        })();
        playCtxReady.catch(() => {
            playCtxReady = null;
            closePlaybackContext();
        });
        return playCtxReady;
    }

    function closePlaybackContext() {
        playCtxReady = null;
        try { playNode?.port?.postMessage({ type: 'clear' }); } catch { /* closed */ }
        try { playNode?.disconnect(); } catch { /* closed */ }
        try { gainNode?.disconnect(); } catch { /* closed */ }
        playNode = null;
        gainNode = null;
        const ctx = playCtx;
        playCtx = null;
        if (ctx) ctx.close().catch(() => {});
    }

    function closeDecoder() {
        const dec = decoder;
        decoder = null;
        if (dec) {
            try { if (dec.state !== 'closed') dec.close(); } catch { /* closed */ }
        }
        decodeTs = 0;
    }

    function ensureDecoder() {
        if (decoder && decoder.state === 'configured') return decoder;
        if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') return null;
        closeDecoder();
        const dec = new AudioDecoder({
            output(audioData) {
                try {
                    if (!playTarget || !playNode) return;
                    const frames = audioData.numberOfFrames;
                    const left = new Float32Array(frames);
                    const right = new Float32Array(frames);
                    if (audioData.format && audioData.format.endsWith('-planar')) {
                        audioData.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
                        audioData.copyTo(right, { planeIndex: audioData.numberOfChannels > 1 ? 1 : 0, format: 'f32-planar' });
                    } else {
                        const interleaved = new Float32Array(frames * Math.max(1, audioData.numberOfChannels));
                        audioData.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
                        if (audioData.numberOfChannels > 1) {
                            for (let i = 0; i < frames; i++) {
                                left[i] = interleaved[i * 2];
                                right[i] = interleaved[i * 2 + 1];
                            }
                        } else {
                            left.set(interleaved);
                            right.set(interleaved);
                        }
                    }
                    playNode.port.postMessage({ type: 'samples', left, right }, [left.buffer, right.buffer]);
                } finally {
                    audioData.close();
                }
            },
            error() {
                stats.decodeErrors++;
                if (decoder === dec) closeDecoder();
            }
        });
        dec.configure({
            codec: 'opus',
            sampleRate: SAMPLE_RATE,
            numberOfChannels: 2
        });
        decoder = dec;
        return dec;
    }

    function setVolume(volume) {
        const v = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
        playVolume = v;
        if (gainNode && playCtx) {
            try { gainNode.gain.setTargetAtTime(v / 100, playCtx.currentTime, 0.015); }
            catch { gainNode.gain.value = v / 100; }
        }
    }

    function startPlayback({ peerId, shareId, volume = 80 } = {}) {
        if (!peerId || !shareId) return;
        const same = playTarget && playTarget.peerId === peerId && playTarget.shareId === shareId;
        playTarget = { peerId, shareId };
        setVolume(volume);
        if (!same) {
            closeDecoder();
            try { playNode?.port?.postMessage({ type: 'clear' }); } catch { /* closed */ }
        }
        ensurePlaybackContext().then(ctx => {
            if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
        });
        ensureDecoder();
    }

    function stopPlayback() {
        playTarget = null;
        closeDecoder();
        try { playNode?.port?.postMessage({ type: 'clear' }); } catch { /* closed */ }
    }

    api.onScreenAudioFrame?.(frame => {
        if (!playTarget || !frame || frame.peerId !== playTarget.peerId || frame.shareId !== playTarget.shareId) return;
        const data = frame.data instanceof Uint8Array ? frame.data : null;
        if (!data || data.length === 0) return;
        stats.received++;
        stats.receivedBytes += data.length;
        const dec = ensureDecoder();
        if (!dec || dec.decodeQueueSize > 12) return;
        try {
            dec.decode(new EncodedAudioChunk({
                type: 'key',
                timestamp: decodeTs,
                duration: FRAME_US,
                data
            }));
            decodeTs += FRAME_US;
        } catch {
            stats.decodeErrors++;
        }
    });

    window.screenAudio = Object.freeze({
        startCapture,
        stopCapture,
        setCapturePaused,
        startPlayback,
        stopPlayback,
        setVolume,
        applyOutputDevice,
        stats: () => ({ ...stats, capturing: captureActive, mode: captureMode, playing: Boolean(playTarget), volume: playVolume })
    });
})();
