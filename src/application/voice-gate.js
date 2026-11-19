'use strict';

// The send gate of the voice capture. voice.js gives each 20 ms block of the microphone to push(). push() returns the
// blocks to encode: none while the gate is closed. No DOM and no audio objects here, thus node:test can load this file.
// - Voice activity ('voice'): the gate opens on a block at or above the threshold (dBFS). It closes when no block was
//   at or above the threshold for the release delay.
// - Push to talk ('ptt'): the gate opens while the key is down. It closes the release delay after the key goes up.
// - Pre-roll: the last PREROLL_BLOCKS blocks before the gate opens go out first, thus the start of a word stays.
// - Fades: a short fade-in at the start of a burst and a fade-out on the last block, thus the edges do not click.
(function () {
    const SAMPLE_RATE = 48000;
    const BLOCK_MS = 20;
    const PREROLL_BLOCKS = 2;
    const FADE_IN_SAMPLES = 240; // 5 ms
    const FLOOR_DB = -100;

    // The RMS level of a block in dBFS. Digital silence gives FLOOR_DB.
    function levelDb(samples) {
        if (!samples || samples.length === 0) return FLOOR_DB;
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        return rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB;
    }

    function fadeIn(samples) {
        const n = Math.min(FADE_IN_SAMPLES, samples.length);
        for (let i = 0; i < n; i++) samples[i] *= i / n;
        return samples;
    }

    function fadeOut(samples) {
        const n = samples.length;
        for (let i = 0; i < n; i++) samples[i] *= (n - 1 - i) / n;
        return samples;
    }

    function pick(settings) {
        const s = settings ?? {};
        return {
            mode: s.mode === 'ptt' ? 'ptt' : 'voice',
            thresholdDb: Number.isFinite(s.vadThresholdDb) ? s.vadThresholdDb : -50,
            vadReleaseMs: Number.isFinite(s.vadReleaseMs) ? Math.max(0, s.vadReleaseMs) : 300,
            pttReleaseMs: Number.isFinite(s.pttReleaseMs) ? Math.max(0, s.pttReleaseMs) : 200
        };
    }

    function createGate(settings) {
        let s = pick(settings);
        let open = false;
        let lastActive = -Infinity;
        let keyDown = false;
        let keyUpAt = -Infinity;
        // A key press between two blocks opens the gate for at least one block.
        let pressed = false;
        let history = [];

        function wantOpen(level, now) {
            if (s.mode === 'ptt') {
                const want = keyDown || pressed || now - keyUpAt < s.pttReleaseMs;
                pressed = false;
                return want;
            }
            if (level >= s.thresholdDb) lastActive = now;
            return now - lastActive <= s.vadReleaseMs;
        }

        return {
            configure(next) {
                const before = s.mode;
                s = pick(next);
                if (s.mode !== before) this.reset();
            },
            // The push-to-talk key. now: the time in ms (the same clock as push()).
            setKey(down, now) {
                if (down) {
                    if (!keyDown) pressed = true;
                    keyDown = true;
                } else if (keyDown) {
                    keyDown = false;
                    keyUpAt = now;
                }
            },
            keyDown: () => keyDown,
            isOpen: () => open,
            reset() {
                open = false;
                lastActive = -Infinity;
                keyDown = false;
                keyUpAt = -Infinity;
                pressed = false;
                history = [];
            },
            // One block of samples (the gate can change the samples). Returns { level, open, send }.
            push(samples, now) {
                const level = levelDb(samples);
                const want = wantOpen(level, now);
                let send = [];
                if (want && !open) {
                    send = [...history, samples];
                    fadeIn(send[0]);
                    history = [];
                } else if (want) {
                    send = [samples];
                } else if (open) {
                    send = [fadeOut(samples)];
                } else {
                    history.push(samples);
                    if (history.length > PREROLL_BLOCKS) history.shift();
                }
                open = want;
                return { level, open, send };
            }
        };
    }

    window.voiceGate = { createGate, levelDb, SAMPLE_RATE, BLOCK_MS, PREROLL_BLOCKS, FLOOR_DB };
})();
