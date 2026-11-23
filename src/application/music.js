'use strict';

// Room music in the window (DECISIONS.md MU-2, MU-5). Not the voice path: no noise suppression, no gate, no voice
// worklet, no voice decoder.
// - DJ: the <audio> element plays the URL of the main process (asscrack-music://, music-media.mjs) -> media element
//   source -> 'music-capture' worklet (stereo, 20 ms) -> AudioEncoder (Opus, stereo, 128 kbit/s) -> api.sendMusicFrame.
//   The DJ hears the element through the music gain.
// - Listener: api.onMusicFrame (only the frames of the DJ of the own channel) -> AudioDecoder (stereo) ->
//   'music-playback' worklet (jitter buffer) -> the music gain -> the output device of the voice settings.
// - The music gain: the music volume of this listener and the ducking while someone talks (music-core.js).
// Music plays only in voice and not while deafened.
(function () {
    const api = window.asscrack;
    const core = window.musicCore;
    if (!api || !core || typeof api.onMusic !== 'function') return;

    const SAMPLE_RATE = 48000;
    const BITRATE = 128000;
    const FRAME_US = 20000;
    const LEVEL_HOLD_MS = 300;

    let view = null;
    let settings = { volume: 60, ducking: true };
    let context = null;
    let contextReady = null;
    let captureNode = null;
    let playbackNode = null;
    let gainNode = null;
    let encoder = null;
    let encodeTs = 0;
    let decoder = null;
    let decoderOrigin = null;
    let decodeTs = 0;
    // The track of this DJ: { id, audio, source, opened }.
    let track = null;
    let talkingNow = false;
    const stats = { sent: 0, sentBytes: 0, received: 0, receivedBytes: 0, decodeErrors: 0, encodeErrors: 0,
        level: 0, levelAt: 0, ownLevel: 0 };
    const listeners = [];

    const voiceState = () => window.voice?.state?.() ?? { inVoice: false, deafened: false };
    const canHear = () => {
        const v = voiceState();
        return v.inVoice === true && v.deafened !== true;
    };
    const changed = () => { for (const fn of listeners) { try { fn(); } catch (err) { console.warn('music onChange failed:', err); } } };

    // ---- Audio objects ----

    async function applySink() {
        const wanted = window.voice?.settings?.()?.outputDeviceId ?? '';
        if (!context || typeof context.setSinkId !== 'function' || context.sinkId === wanted) return;
        await context.setSinkId(wanted).catch(() => context.setSinkId('').catch(() => {}));
    }

    function ensureContext() {
        if (contextReady) return contextReady;
        contextReady = (async () => {
            const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
            context = ctx;
            await ctx.audioWorklet.addModule('music-worklet.js');
            if (context !== ctx) throw new Error('Music audio closed');
            gainNode = ctx.createGain();
            gainNode.gain.value = targetGain();
            gainNode.connect(ctx.destination);
            playbackNode = new AudioWorkletNode(ctx, 'music-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
            playbackNode.connect(gainNode);
            captureNode = new AudioWorkletNode(ctx, 'music-capture', {
                numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
            captureNode.port.onmessage = ({ data }) => onBlock(data);
            await applySink();
            if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
            return ctx;
        })();
        contextReady.catch(err => {
            console.warn('Music audio did not start:', err?.message ?? err);
            closeAudio();
        });
        return contextReady;
    }

    function closeAudio() {
        stopTrack();
        closeEncoder();
        closeDecoder();
        try { playbackNode?.disconnect(); } catch { /* already */ }
        try { gainNode?.disconnect(); } catch { /* already */ }
        if (captureNode) captureNode.port.onmessage = null;
        playbackNode = null;
        gainNode = null;
        captureNode = null;
        const ctx = context;
        context = null;
        contextReady = null;
        if (ctx) ctx.close().catch(() => {});
    }

    function targetGain() {
        return core.musicGain({ volume: settings.volume, ducking: settings.ducking, talking: talkingNow });
    }

    function applyGain() {
        if (!gainNode || !context) return;
        gainNode.gain.setTargetAtTime(targetGain(), context.currentTime, 0.08);
    }

    // ---- DJ: encode and send ----

    async function makeEncoder() {
        const base = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: BITRATE };
        const music = { ...base, opus: { application: 'audio', signal: 'music' } };
        const config = (await AudioEncoder.isConfigSupported(music).catch(() => null))?.supported ? music : base;
        const enc = new AudioEncoder({
            output: chunk => {
                const bytes = new Uint8Array(chunk.byteLength);
                chunk.copyTo(bytes);
                stats.sent++;
                stats.sentBytes += bytes.length;
                try { api.sendMusicFrame(bytes); } catch { /* the room closed */ }
            },
            error: err => { stats.encodeErrors++; console.warn('Music encoder error:', err?.message ?? err); }
        });
        enc.configure(config);
        return enc;
    }

    function closeEncoder() {
        if (encoder && encoder.state !== 'closed') encoder.close();
        encoder = null;
    }

    function onBlock({ left, right } = {}) {
        if (!track || !track.audio || track.audio.paused || !view?.mine || !encoder || encoder.state !== 'configured') return;
        let sum = 0;
        for (let i = 0; i < left.length; i++) sum += left[i] * left[i];
        stats.ownLevel = Math.sqrt(sum / Math.max(1, left.length));
        const planes = new Float32Array(left.length * 2);
        planes.set(left, 0);
        planes.set(right, left.length);
        const data = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: left.length,
            numberOfChannels: 2, timestamp: encodeTs, data: planes });
        encodeTs += Math.round(left.length * 1e6 / SAMPLE_RATE);
        try { encoder.encode(data); } catch (err) { stats.encodeErrors++; } finally { data.close(); }
    }

    function stopTrack() {
        const t = track;
        track = null;
        if (!t) return;
        clearInterval(t.progressTimer);
        try { t.source?.disconnect(); } catch { /* already */ }
        if (t.audio) {
            t.audio.onended = null;
            t.audio.onerror = null;
            t.audio.pause();
            t.audio.removeAttribute('src');
            t.audio.load();
        }
    }

    function mediaKind(audio) {
        // A YouTube stream that the main process could not fetch, or a file that Chromium cannot decode.
        const code = audio?.error?.code;
        return code === 4 ? 'error' : 'error';
    }

    async function startTrack(item) {
        stopTrack();
        const own = { id: item.id, audio: null, source: null, progressTimer: null };
        track = own;
        let opened;
        try { opened = await api.musicOpen(item.id); } catch { opened = null; }
        if (track !== own) return;
        if (!opened?.url) {
            track = null;
            api.musicFailed(item.id, opened?.error ?? 'error');
            return;
        }
        try {
            await ensureContext();
            if (!encoder) { encoder = await makeEncoder(); encodeTs = 0; }
        } catch (err) {
            if (track === own) { track = null; api.musicFailed(item.id, 'error'); }
            return;
        }
        if (track !== own) return;
        const audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.preload = 'auto';
        own.audio = audio;
        own.source = context.createMediaElementSource(audio);
        own.source.connect(captureNode);
        own.source.connect(gainNode);
        audio.onended = () => { if (track === own) api.musicEnded(item.id); };
        audio.onerror = () => {
            if (track !== own) return;
            track = null;
            stopTrackObjects(own);
            api.musicFailed(item.id, mediaKind(audio));
        };
        const start = Number(view?.pos) > 1 ? Number(view.pos) : 0;
        if (start > 0) audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = start; } catch { /* no seek */ } }, { once: true });
        audio.src = opened.url;
        own.progressTimer = setInterval(() => {
            if (track === own && !audio.paused) api.musicProgress(item.id, audio.currentTime);
        }, 5000);
        syncPause();
        changed();
    }

    function stopTrackObjects(own) {
        clearInterval(own.progressTimer);
        try { own.source?.disconnect(); } catch { /* already */ }
        try { own.audio?.pause(); } catch { /* already */ }
    }

    function syncPause() {
        const audio = track?.audio;
        if (!audio) return;
        if (view?.paused) audio.pause();
        else if (audio.paused) audio.play().catch(err => console.warn('Music play failed:', err?.message ?? err));
    }

    // ---- Listener: decode and play ----

    function closeDecoder() {
        if (decoder && decoder.state !== 'closed') decoder.close();
        decoder = null;
        decoderOrigin = null;
        playbackNode?.port.postMessage({ type: 'clear' });
    }

    function makeDecoder(origin) {
        const dec = new AudioDecoder({
            output: audio => {
                try {
                    const left = new Float32Array(audio.numberOfFrames);
                    const right = new Float32Array(audio.numberOfFrames);
                    audio.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
                    if (audio.numberOfChannels > 1) audio.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
                    else right.set(left);
                    let sum = 0;
                    for (let i = 0; i < left.length; i++) sum += left[i] * left[i];
                    stats.level = Math.sqrt(sum / Math.max(1, left.length));
                    stats.levelAt = performance.now();
                    if (playbackNode && canHear()) playbackNode.port.postMessage({ type: 'samples', left, right }, [left.buffer, right.buffer]);
                } finally {
                    audio.close();
                }
            },
            error: err => { stats.decodeErrors++; console.warn('Music decoder error:', err?.message ?? err); decoder = null; }
        });
        dec.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 2 });
        decoder = dec;
        decoderOrigin = origin;
        decodeTs = 0;
    }

    api.onMusicFrame?.(({ origin, data } = {}) => {
        if (!view?.dj || view.mine || origin !== view.dj || !data || !canHear()) return;
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        stats.received++;
        stats.receivedBytes += bytes.length;
        if (!context) { void ensureContext().catch(() => {}); return; }
        if (!playbackNode || typeof AudioDecoder !== 'function') return;
        if (!decoder || decoderOrigin !== origin) {
            closeDecoder();
            makeDecoder(origin);
        }
        try {
            decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: decodeTs, data: bytes }));
            decodeTs += FRAME_US;
        } catch (err) {
            stats.decodeErrors++;
        }
    });

    // ---- The view of the node ----

    function update() {
        const hear = canHear();
        const active = Boolean(view?.dj) && voiceState().inVoice === true;
        if (!active) {
            if (context) closeAudio();
            changed();
            return;
        }
        if (hear || view.mine) void ensureContext().catch(() => {});
        if (view.mine) {
            if (decoder) closeDecoder();
            const now = view.now;
            if (!now) stopTrack();
            else if (track?.id !== now.id) void startTrack(now);
            else syncPause();
        } else {
            stopTrack();
            closeEncoder();
            if (!hear) closeDecoder();
        }
        changed();
    }

    function apply(next) {
        view = next ?? null;
        update();
    }

    api.onMusic(apply);
    window.voice?.onChange?.(() => update());
    Promise.resolve(api.getMusic?.()).then(value => { if (value && !view) apply(value); }).catch(() => {});
    Promise.resolve(api.getMusicSettings?.()).then(value => { if (value) { settings = value; applyGain(); } }).catch(() => {});

    // Ducking: each 100 ms, the voice levels of the others and the own send state.
    if (typeof setInterval === 'function') {
        setInterval(async () => {
            if (!context) return;
            let voiceStats = {};
            try { voiceStats = await window.voice?.stats?.() ?? {}; } catch { voiceStats = {}; }
            const next = core.talking(voiceStats, voiceState().transmitting === true);
            if (next !== talkingNow) {
                talkingNow = next;
                applyGain();
            }
            void applySink();
        }, 100);
    }

    window.music = {
        view: () => view,
        settings: () => ({ ...settings }),
        async setSettings(patch) {
            const value = await api.setMusicSettings(patch);
            if (value) settings = value;
            applyGain();
            changed();
            return settings;
        },
        onChange(fn) { if (typeof fn === 'function') listeners.push(fn); },
        // For the checks and the panel: the counters and the level of the last 300 ms.
        state() {
            const now = performance.now();
            return { ...stats, level: now - stats.levelAt > LEVEL_HOLD_MS ? 0 : stats.level, gain: gainNode?.gain.value ?? null,
                talking: talkingNow, audio: context?.state ?? 'closed', playing: track?.id ?? null,
                position: track?.audio?.currentTime ?? null, mine: view?.mine === true };
        }
    };
})();
