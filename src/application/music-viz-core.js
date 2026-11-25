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
    const VIZ_MODES = Object.freeze(['bars', 'scope', 'analog-vu', 'starfield']);
    const VIZ_MODE_LABELS = Object.freeze({
        bars: 'LED Bars',
        scope: 'Scope',
        'analog-vu': 'Analog VU',
        starfield: 'Starfield'
    });
    const VIZ_MODE_KEY = 'asscrack.musicVizMode.v1';
    const COLORS = Object.freeze({ green: '#2bdc4f', yellow: '#f0e231', orange: '#f7962a', red: '#f0302c',
        peak: '#ffffff', unlit: 'rgba(255, 255, 255, 0.08)' });

    const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
    const clampSigned = value => (Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0);

    function normalizeVizMode(value) {
        return VIZ_MODES.includes(value) ? value : 'bars';
    }

    function nextVizMode(current) {
        const idx = VIZ_MODES.indexOf(normalizeVizMode(current));
        return VIZ_MODES[(idx + 1) % VIZ_MODES.length];
    }

    function vizModeLabel(mode) {
        return VIZ_MODE_LABELS[normalizeVizMode(mode)];
    }

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

    // Sample a time-domain buffer around a rising zero crossing for a stable oscilloscope trace.
    function sampleWaveform(samples, points = 64) {
        const count = Math.max(0, Math.floor(points));
        if (!samples?.length || count <= 0) return new Array(count).fill(0);
        const half = Math.floor(samples.length / 2);
        let trigger = 0;
        for (let i = 1; i < half; i++) {
            if (samples[i - 1] <= 0 && samples[i] > 0) { trigger = i; break; }
        }
        const span = Math.max(1, samples.length - trigger);
        const out = new Array(count);
        for (let i = 0; i < count; i++) {
            const idx = Math.min(samples.length - 1, trigger + Math.floor(i * span / count));
            out[i] = clampSigned(samples[idx]);
        }
        return out;
    }

    // Synthesize an audio-reactive waveform from 16 band levels when only frame bytes are available (popout window).
    function synthesizeWaveform(bands, left = 0, right = 0, timeMs = 0, points = 64) {
        const count = Math.max(0, Math.floor(points));
        if (count <= 0) return [];
        const b = Array.isArray(bands) ? bands : [];
        const amp = Math.max(clamp01(left), clamp01(right));
        let maxBand = 0;
        for (let i = 0; i < b.length; i++) if (clamp01(b[i]) > maxBand) maxBand = clamp01(b[i]);
        if (amp <= 0 && maxBand <= 0) return new Array(count).fill(0);
        const phase = (Number.isFinite(timeMs) ? timeMs : 0) * 0.008;
        const bass = b.length ? (clamp01(b[0]) + clamp01(b[1]) + clamp01(b[2])) / 3 : amp;
        const mid = b.length > 7 ? (clamp01(b[4]) + clamp01(b[5]) + clamp01(b[6]) + clamp01(b[7])) / 4 : amp * 0.6;
        const treble = b.length > 13 ? (clamp01(b[10]) + clamp01(b[11]) + clamp01(b[12]) + clamp01(b[13])) / 4 : amp * 0.4;
        const gain = Math.max(0.15, Math.min(1, amp * 0.7 + maxBand * 0.5));
        const out = new Array(count);
        for (let i = 0; i < count; i++) {
            const u = i / Math.max(1, count - 1);
            const v = (0.55 * bass + 0.25) * Math.sin(u * Math.PI * 2 + phase)
                + 0.45 * mid * Math.sin(u * Math.PI * 6 - phase * 1.4)
                + 0.3 * treble * Math.sin(u * Math.PI * 14 + phase * 2.3);
            out[i] = clampSigned(v * gain);
        }
        return out;
    }

    // Draw a CRT phosphor oscilloscope trace on a 2D context.
    function drawOscilloscope(ctx, width, height, wave) {
        ctx.clearRect(0, 0, width, height);
        if (width <= 0 || height <= 0) return;
        const midY = height / 2;
        ctx.save?.();
        ctx.strokeStyle = 'rgba(57, 255, 122, 0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        for (let i = 1; i < 4; i++) {
            const x = width * i / 4;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
        }
        ctx.stroke();

        const points = Array.isArray(wave) && wave.length ? wave : [0, 0];
        const amp = Math.max(2, height * 0.42);
        const trace = () => {
            ctx.beginPath();
            for (let i = 0; i < points.length; i++) {
                const x = points.length === 1 ? width / 2 : i * width / (points.length - 1);
                const y = midY - clampSigned(points[i]) * amp;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        };
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(43, 220, 79, 0.35)';
        ctx.lineWidth = Math.max(3, Math.round(height * 0.08));
        trace();
        ctx.strokeStyle = '#6bff95';
        ctx.lineWidth = Math.max(1.25, height * 0.025);
        trace();
        ctx.restore?.();
    }

    // Map a 0..1 VU level to a needle angle in radians (-0.78*PI to -0.22*PI).
    function vuNeedleAngle(level) {
        const min = -Math.PI * 0.78;
        const max = -Math.PI * 0.22;
        return min + clamp01(level) * (max - min);
    }

    // Ballistic needle smoothing: fast rise, damped release.
    function smoothNeedle(current, target, dtMs) {
        const cur = clamp01(current);
        const tgt = clamp01(target);
        const dt = Math.min(250, Math.max(0, Number.isFinite(dtMs) ? dtMs : 0)) / 1000;
        if (dt <= 0) return cur;
        const rate = tgt >= cur ? 9 : 3.2;
        const alpha = 1 - Math.exp(-rate * dt);
        return clamp01(cur + (tgt - cur) * alpha);
    }

    // Draw dual backlit analog VU needle meters (L and R).
    function drawAnalogVu(ctx, width, height, left, right, leftPeak = left, rightPeak = right) {
        ctx.clearRect(0, 0, width, height);
        if (width <= 0 || height <= 0) return;
        const pad = Math.max(2, Math.round(Math.min(width, height) * 0.06));
        const gap = Math.max(4, Math.round(width * 0.04));
        const meterW = (width - pad * 2 - gap) / 2;
        const meterH = height - pad * 2;
        if (meterW <= 4 || meterH <= 4) return;
        const channels = [
            { label: 'L', level: clamp01(left), peak: clamp01(leftPeak), x: pad },
            { label: 'R', level: clamp01(right), peak: clamp01(rightPeak), x: pad + meterW + gap }
        ];
        const minA = vuNeedleAngle(0);
        const maxA = vuNeedleAngle(1);
        const redA = vuNeedleAngle(0.78);
        ctx.save?.();
        for (const ch of channels) {
            const cx = ch.x + meterW / 2;
            const cy = pad + meterH * 0.92;
            const radius = Math.min(meterW * 0.56, meterH * 0.78);
            ctx.fillStyle = '#1f1910';
            ctx.fillRect(ch.x, pad, meterW, meterH);
            ctx.strokeStyle = 'rgba(246, 214, 148, 0.35)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(cx, cy, radius, minA, redA);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(240, 48, 44, 0.85)';
            ctx.beginPath();
            ctx.arc(cx, cy, radius, redA, maxA);
            ctx.stroke();
            for (let t = 0; t <= 4; t++) {
                const a = vuNeedleAngle(t / 4);
                const r0 = radius * 0.84;
                const r1 = radius * 1.02;
                ctx.strokeStyle = t >= 3 ? '#f0302c' : 'rgba(246, 214, 148, 0.65)';
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
                ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
                ctx.stroke();
            }
            if (ch.peak > 0.02) {
                const pa = vuNeedleAngle(ch.peak);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.lineWidth = 1.25;
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(pa) * (radius * 0.78), cy + Math.sin(pa) * (radius * 0.78));
                ctx.lineTo(cx + Math.cos(pa) * (radius * 1.04), cy + Math.sin(pa) * (radius * 1.04));
                ctx.stroke();
            }
            const na = vuNeedleAngle(ch.level);
            ctx.strokeStyle = '#ffdfb0';
            ctx.lineWidth = Math.max(1.5, meterW * 0.022);
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(na) * (radius * 0.96), cy + Math.sin(na) * (radius * 0.96));
            ctx.stroke();
            ctx.fillStyle = '#d9b57e';
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(2, radius * 0.08), 0, Math.PI * 2);
            ctx.fill();
            if (height >= 36 && typeof ctx.fillText === 'function') {
                ctx.fillStyle = 'rgba(246, 214, 148, 0.8)';
                ctx.font = `${Math.max(8, Math.round(meterH * 0.16))}px monospace`;
                ctx.fillText(ch.label, ch.x + 4, pad + Math.max(10, Math.round(meterH * 0.22)));
            }
        }
        ctx.restore?.();
    }

    // Aggregate 16 bands into bass, mid, treble, and overall energy (0..1).
    function bandEnergies(bands) {
        const b = Array.isArray(bands) ? bands : [];
        const avg = (from, to) => {
            let sum = 0;
            let count = 0;
            for (let i = from; i <= to && i < b.length; i++) { sum += clamp01(b[i]); count++; }
            return count ? clamp01(sum / count) : 0;
        };
        const bass = avg(0, 3);
        const mid = avg(4, 9);
        const treble = avg(10, 15);
        const energy = clamp01(0.45 * bass + 0.35 * mid + 0.2 * treble);
        return { bass, mid, treble, energy };
    }

    // Deterministic 3D warp starfield state.
    function createStarfield(count = 48) {
        const total = Math.max(1, Math.floor(count));
        let seed = 0x51a7f1ed;
        const rand = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        const spawn = star => {
            let x = 0;
            let y = 0;
            while (Math.abs(x) < 0.08 && Math.abs(y) < 0.08) {
                x = rand() * 2 - 1;
                y = rand() * 2 - 1;
            }
            star.x = x;
            star.y = y;
            star.z = 0.08 + rand() * 0.92;
            star.pz = star.z;
            return star;
        };
        let stars = [];
        function reset() {
            seed = 0x51a7f1ed;
            stars = Array.from({ length: total }, () => spawn({ x: 0, y: 0, z: 1, pz: 1 }));
        }
        reset();
        return {
            step(dtMs, energy = 0, bass = 0) {
                const dt = Math.min(100, Math.max(0, Number.isFinite(dtMs) ? dtMs : 0)) / 1000;
                const speed = 0.18 + clamp01(energy) * 1.1 + clamp01(bass) * 0.9;
                const projected = [];
                for (let i = 0; i < stars.length; i++) {
                    const s = stars[i];
                    s.pz = s.z;
                    s.z -= speed * dt;
                    if (s.z <= 0.05) {
                        spawn(s);
                        s.z = 1;
                        s.pz = 1;
                    }
                    projected.push({
                        sx: s.x / s.z,
                        sy: s.y / s.z,
                        px: s.x / s.pz,
                        py: s.y / s.pz,
                        brightness: clamp01(1 - s.z * 0.85),
                        size: 1 + (1 - s.z) * 1.8
                    });
                }
                return projected;
            },
            reset
        };
    }

    // 3-wave sine interference plasma color in a retro indigo/magenta/cyan/violet palette.
    function plasmaColor(nx, ny, phase, bass = 0, mid = 0, treble = 0) {
        const p = Number.isFinite(phase) ? phase : 0;
        const v1 = Math.sin(nx * 4.2 + p);
        const v2 = Math.sin(ny * 3.8 - p * 0.8);
        const v3 = Math.sin((nx + ny) * 3.1 + p * 0.6 + clamp01(bass) * 2.2);
        const mix = (v1 + v2 + v3) / 3;
        const boost = 0.65 + clamp01(bass) * 0.25 + clamp01(mid) * 0.2 + clamp01(treble) * 0.15;
        const r = Math.min(255, Math.max(0, Math.round((45 + 65 * (0.5 + 0.5 * Math.sin(mix * Math.PI + 0.4))) * boost)));
        const g = Math.min(255, Math.max(0, Math.round((18 + 55 * (0.5 + 0.5 * Math.sin(mix * Math.PI + 2.4))) * boost)));
        const b = Math.min(255, Math.max(0, Math.round((75 + 90 * (0.5 + 0.5 * Math.sin(mix * Math.PI + 4.1))) * boost)));
        return `rgb(${r}, ${g}, ${b})`;
    }

    // Draw retro plasma backdrop with audio-driven warp starfield streaks.
    function drawStarfieldPlasma(ctx, width, height, starfield, bands, now, dtMs = 33) {
        ctx.clearRect(0, 0, width, height);
        if (width <= 0 || height <= 0) return;
        const { bass, mid, treble, energy } = bandEnergies(bands);
        const phase = (Number.isFinite(now) ? now : 0) * 0.0022;
        const cols = 12;
        const rows = 6;
        const cellW = width / cols;
        const cellH = height / rows;
        ctx.save?.();
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                ctx.fillStyle = plasmaColor((c + 0.5) / cols, (r + 0.5) / rows, phase, bass, mid, treble);
                ctx.fillRect(Math.floor(c * cellW), Math.floor(r * cellH), Math.ceil(cellW), Math.ceil(cellH));
            }
        }
        const stars = starfield?.step ? starfield.step(dtMs, energy, bass) : [];
        const cx = width / 2;
        const cy = height / 2;
        const scale = Math.min(width, height) * 0.5;
        for (let i = 0; i < stars.length; i++) {
            const s = stars[i];
            const x = cx + s.sx * scale;
            const y = cy + s.sy * scale;
            if (x < -8 || x > width + 8 || y < -8 || y > height + 8) continue;
            const px = cx + s.px * scale;
            const py = cy + s.py * scale;
            const alpha = (0.35 + s.brightness * 0.65).toFixed(2);
            ctx.strokeStyle = `rgba(232, 248, 255, ${alpha})`;
            ctx.lineWidth = Math.max(1, s.size * 0.65);
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(x, y);
            ctx.stroke();
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            const sz = Math.max(1, Math.round(s.size));
            ctx.fillRect(Math.round(x - sz / 2), Math.round(y - sz / 2), sz, sz);
        }
        ctx.restore?.();
    }

    window.musicVizCore = Object.freeze({ BANDS, SEGMENTS, VU_SEGMENTS, HOLD_MS, FALL_PER_S, FRAME_MS, MODES,
        VIZ_MODES, VIZ_MODE_LABELS, VIZ_MODE_KEY, COLORS,
        bandEdges, bandLevels, vuLevel, release, litSegments, ledColor, createPeaks, barTarget, createLoop,
        encodeFrame, decodeFrame, drawColumns, normalizeVizMode, nextVizMode, vizModeLabel,
        sampleWaveform, synthesizeWaveform, drawOscilloscope, vuNeedleAngle, smoothNeedle, drawAnalogVu,
        bandEnergies, createStarfield, plasmaColor, drawStarfieldPlasma });
})();
