'use strict';

// Room music: the pure parts of the visualizer (music-viz.js). The node tests load this file in node:vm.
// - The LED spectrum: 16 bands from bass to treble (log spaced), 14 LED segments each, green, yellow, orange and red
//   from the bottom up, a white peak cap that holds 0.3 s and then falls.
// - The stereo VU meter: two LED columns with the same colors and peak caps.
// - The draw loop: at most about 30 frames each second, only while a canvas is on the screen and music plays.
// - The frame of the pop-out window: 16 bands and the two VU levels, one byte each.
(function () {
    const BANDS = 16;
    const SEGMENTS = 14;
    const VU_SEGMENTS = 10;
    const LOW_HZ = 40;
    const HIGH_HZ = 16000;
    const HOLD_MS = 300;
    // A peak cap falls the full height in about 0.8 s.
    const FALL_PER_S = 1.25;
    // The VU level falls the full height in about 0.5 s (the release of a meter).
    const VU_FALL_PER_S = 2;
    // The VU scale: -42 dBFS (no LED) to 0 dBFS (all LEDs).
    const VU_FLOOR_DB = -42;
    const FRAME_MS = 1000 / 30;
    const MODES = Object.freeze(['spectrum', 'vu', 'off']);
    const COLORS = Object.freeze({ green: '#2bdc4f', yellow: '#f0e231', orange: '#f7962a', red: '#f0302c',
        peak: '#ffffff', unlit: 'rgba(255, 255, 255, 0.08)' });

    const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

    // The analyser bins of each band: [[start, end), ...] for bins of sampleRate / fftSize Hz. The edges are log spaced
    // from LOW_HZ to HIGH_HZ. Each band has one bin or more, and the bands do not overlap.
    function bandEdges({ sampleRate = 48000, fftSize = 2048, bands = BANDS, low = LOW_HZ, high = HIGH_HZ } = {}) {
        const bins = Math.floor(fftSize / 2);
        const width = sampleRate / fftSize;
        const edges = [];
        let previous = 0;
        for (let k = 0; k < bands; k++) {
            const from = low * (high / low) ** (k / bands);
            const to = low * (high / low) ** ((k + 1) / bands);
            const start = Math.min(bins - 1, Math.max(previous, Math.round(from / width)));
            const end = Math.min(bins, Math.max(start + 1, Math.round(to / width)));
            edges.push([start, end]);
            previous = end;
        }
        return edges;
    }

    // The level (0 to 1) of each band: the largest bin of the band. data: the bytes of getByteFrequencyData (0 to 255).
    function bandLevels(data, edges) {
        return edges.map(([start, end]) => {
            let max = 0;
            for (let i = start; i < end && i < data.length; i++) if (data[i] > max) max = data[i];
            return max / 255;
        });
    }

    // The VU level (0 to 1) of one channel: the RMS of the samples (-1 to 1) on a dB scale.
    function vuLevel(samples) {
        if (!samples?.length) return 0;
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        if (rms <= 0) return 0;
        return clamp01((20 * Math.log10(rms) - VU_FLOOR_DB) / -VU_FLOOR_DB);
    }

    // A meter falls slowly and rises at once.
    function release(previous, next, ms, perSecond = VU_FALL_PER_S) {
        const fallen = clamp01(previous) - perSecond * Math.max(0, ms) / 1000;
        return Math.max(clamp01(next), fallen, 0);
    }

    // The lit segments of a level: 0 to segments.
    const litSegments = (level, segments = SEGMENTS) => Math.min(segments, Math.max(0, Math.round(clamp01(level) * segments)));

    // The color of segment index (0 = the bottom). 14 segments: 8 green, 3 yellow, 2 orange, 1 red.
    function ledColor(index, segments = SEGMENTS) {
        if (index < Math.round(segments * 0.57)) return COLORS.green;
        if (index < Math.round(segments * 0.79)) return COLORS.yellow;
        if (index < Math.round(segments * 0.93)) return COLORS.orange;
        return COLORS.red;
    }

    // The peak caps of n columns. update(levels, now) gives the peaks: a new high value holds for holdMs, then falls at
    // fallPerSecond (full height each second) until it meets the level.
    function createPeaks(n, { holdMs = HOLD_MS, fallPerSecond = FALL_PER_S } = {}) {
        const peaks = new Array(n).fill(0);
        const heldAt = new Array(n).fill(-Infinity);
        let last = null;
        return {
            update(levels, now) {
                const since = last === null ? 0 : Math.max(0, now - last);
                for (let i = 0; i < n; i++) {
                    const level = clamp01(levels[i]);
                    if (level >= peaks[i]) {
                        peaks[i] = level;
                        heldAt[i] = now;
                        continue;
                    }
                    const fallFrom = Math.max(now - since, heldAt[i] + holdMs);
                    if (now > fallFrom) peaks[i] = Math.max(level, peaks[i] - fallPerSecond * (now - fallFrom) / 1000);
                }
                last = now;
                return peaks.slice();
            },
            reset() { peaks.fill(0); heldAt.fill(-Infinity); last = null; }
        };
    }

    // What to draw now. s: { mode, playing, barShown, collapsed, popoutOpen, roomShown }.
    // - bar: 'spectrum', 'vu' or null. The collapsed bar (also while the pop-out is open) has the VU meter.
    // Nothing when the mode is Off, when no music plays or when the bar or the room window is not on the screen.
    function barTarget({ mode, playing, barShown, collapsed, popoutOpen, roomShown } = {}) {
        if (!MODES.includes(mode) || mode === 'off' || playing !== true) return null;
        if (barShown !== true || roomShown !== true) return null;
        if (collapsed === true || popoutOpen === true || mode === 'vu') return 'vu';
        return 'spectrum';
    }

    // The draw loop. schedule(fn) and cancel(handle): requestAnimationFrame or a timer. now(): ms. decide(): the
    // target of this frame or null. draw(target, now): one frame. stopped(): the loop stops (clear the canvas).
    // refresh(): call after each change of the state; the loop starts again when decide() gives a target.
    function createLoop({ schedule, cancel = () => {}, now, decide, draw, stopped = () => {}, frameMs = FRAME_MS }) {
        let handle = null;
        let last = -Infinity;
        let frames = 0;
        function tick() {
            handle = null;
            const target = decide();
            if (!target) { stopped(); return; }
            const t = now();
            // A small margin: a 60 Hz display gives each second frame.
            if (t - last >= frameMs - 2) {
                last = t;
                frames++;
                draw(target, t);
            }
            handle = schedule(tick);
        }
        return {
            refresh() {
                if (handle !== null) {
                    if (decide()) return;
                    cancel(handle);
                    handle = null;
                    stopped();
                    return;
                }
                if (decide()) handle = schedule(tick);
            },
            stop() {
                if (handle !== null) cancel(handle);
                handle = null;
                stopped();
            },
            running: () => handle !== null,
            frames: () => frames
        };
    }

    // The frame of the pop-out window: BANDS band bytes, then the left and the right VU byte.
    function encodeFrame(bands, left, right) {
        const out = new Uint8Array(BANDS + 2);
        for (let i = 0; i < BANDS; i++) out[i] = Math.round(clamp01(bands[i]) * 255);
        out[BANDS] = Math.round(clamp01(left) * 255);
        out[BANDS + 1] = Math.round(clamp01(right) * 255);
        return out;
    }
    function decodeFrame(bytes) {
        if (!bytes || bytes.length !== BANDS + 2) return null;
        const values = Array.from(bytes, b => clamp01(Number(b) / 255));
        return { bands: values.slice(0, BANDS), left: values[BANDS], right: values[BANDS + 1] };
    }

    // Draw LED columns on a 2D context (the canvas pixels). columns: [{ level, peak }]. The panel color comes from
    // the CSS background of the canvas (the theme); this draws only the LEDs.
    function drawColumns(ctx, width, height, columns, segments = SEGMENTS) {
        ctx.clearRect(0, 0, width, height);
        const n = columns.length;
        if (!n || width <= 0 || height <= 0) return;
        const pad = Math.max(1, Math.round(Math.min(width, height) * 0.04));
        const gapX = Math.max(1, Math.round((width - pad * 2) / n * 0.2));
        const colW = Math.max(1, Math.floor((width - pad * 2 - gapX * (n - 1)) / n));
        const used = colW * n + gapX * (n - 1);
        const x0 = Math.floor((width - used) / 2);
        const pitch = (height - pad * 2) / segments;
        const gapY = pitch >= 3 ? Math.max(1, Math.round(pitch * 0.25)) : pitch >= 2 ? 1 : 0;
        const ledH = Math.max(1, Math.floor(pitch - gapY));
        const top = i => Math.round(height - pad - (i + 1) * pitch + gapY / 2);
        for (let c = 0; c < n; c++) {
            const x = x0 + c * (colW + gapX);
            const lit = litSegments(columns[c].level, segments);
            for (let i = 0; i < segments; i++) {
                ctx.fillStyle = i < lit ? ledColor(i, segments) : COLORS.unlit;
                ctx.fillRect(x, top(i), colW, ledH);
            }
            // The cap is the LED above the peak level (the top LED at full level).
            const peak = litSegments(columns[c].peak, segments);
            if (peak > 0) {
                ctx.fillStyle = COLORS.peak;
                ctx.fillRect(x, top(Math.min(segments - 1, peak)), colW, ledH);
            }
        }
    }

    window.musicVizCore = Object.freeze({ BANDS, SEGMENTS, VU_SEGMENTS, HOLD_MS, FALL_PER_S, FRAME_MS, MODES, COLORS,
        bandEdges, bandLevels, vuLevel, release, litSegments, ledColor, createPeaks, barTarget, createLoop,
        encodeFrame, decodeFrame, drawColumns });
})();
