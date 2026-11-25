'use strict';

// Room music: the visualizer (operator design 2026-11-23). The LED spectrum (16 bands) or the stereo VU meter of the
// music as it plays on this PC, from the analysers of music.js (the music before the volume: the bars move at each
// volume). No network traffic.
// - The room window: the canvas of the music bar. The collapsed bar (also while the pop-out window is open) has the
//   VU meter. The window also gives the levels to the pop-out window (a pull of main.js, 18 bytes).
// - The pop-out window (music-window.html): the large canvas. It asks the room window for each frame.
// The loop (music-viz-core.js) draws at most about 30 frames each second, only while the canvas is on the screen and
// music plays. It stops when the window or the bar is hidden or minimized, with the setting Off, and with no music.
(function () {
    const api = window.asscrack;
    const vc = window.musicVizCore;
    const byId = id => document.getElementById(id);
    const bar = byId('music-bar');
    const spectrumCanvas = byId('music-spectrum');
    const vuCanvas = byId('music-vu');
    const modePill = byId('music-viz-mode');
    if (!api || !vc || !window.music || !bar || !spectrumCanvas || !vuCanvas) return;
    const vizWrap = spectrumCanvas.parentElement?.classList?.contains('music-viz-wrap') ? spectrumCanvas.parentElement : null;
    const windowMode = bar.dataset.mode === 'window';

    let view = null;
    // The room window is not minimized or hidden (main.js). The page visibility alone is not enough: the voice
    // pop-out window stops the background throttling of the room window.
    let roomShown = true;
    let edges = null;
    let edgesKey = '';
    let bins = null;
    let samples = null;
    let waveSamples = null;
    let vu = [0, 0];
    let vuAt = 0;
    let analogVu = [0, 0];
    let analogAt = 0;
    let starAt = 0;
    let last = null;
    let pullAt = 0;
    // The pop-out window: the room window answered null (no music on this PC, for example while deafened). The loop
    // stops; the slow check asks again one time each second.
    let roomSilent = false;
    const bandPeaks = vc.createPeaks(vc.BANDS);
    const vuPeaks = vc.createPeaks(2);
    const analogPeaks = vc.createPeaks(2);
    const starfield = vc.createStarfield(48);

    const readStoredVizMode = () => {
        if (typeof window.music.vizMode === 'function') return vc.normalizeVizMode(window.music.vizMode());
        try {
            return vc.normalizeVizMode(typeof localStorage !== 'undefined' ? localStorage.getItem(vc.VIZ_MODE_KEY) : null);
        } catch {
            return 'bars';
        }
    };
    let vizMode = readStoredVizMode();

    function syncModeUi() {
        const label = vc.vizModeLabel(vizMode);
        if (modePill) {
            modePill.textContent = label;
            modePill.title = 'Switch visualizer';
        }
        spectrumCanvas.title = `${label} — click to switch`;
    }

    const mode = () => {
        const value = window.music.settings?.()?.visualizer;
        return vc.MODES.includes(value) ? value : 'spectrum';
    };
    const pageShown = () => document.visibilityState !== 'hidden';
    const collapsed = () => bar.classList.contains('collapsed');

    // ---- The levels (the room window) ----

    // need: { spectrum, vu, scope }. Gives { bands, left, right, wave, playing } or null with no audio.
    function readLevels(now, need) {
        const tap = window.music.tap?.();
        if (!tap) return null;
        const bands = new Array(vc.BANDS).fill(0);
        if (need.spectrum) {
            const key = `${tap.sampleRate}/${tap.spectrum.fftSize}`;
            if (key !== edgesKey) {
                edgesKey = key;
                edges = vc.bandEdges({ sampleRate: tap.sampleRate, fftSize: tap.spectrum.fftSize });
                bins = new Uint8Array(tap.spectrum.frequencyBinCount);
            }
            tap.spectrum.getByteFrequencyData(bins);
            const levels = vc.bandLevels(bins, edges);
            for (let i = 0; i < vc.BANDS; i++) bands[i] = levels[i];
        }
        if (need.vu) {
            if (!samples || samples.length !== tap.left.fftSize) samples = new Float32Array(tap.left.fftSize);
            tap.left.getFloatTimeDomainData(samples);
            const left = vc.vuLevel(samples);
            tap.right.getFloatTimeDomainData(samples);
            const right = vc.vuLevel(samples);
            const ms = vuAt ? now - vuAt : 0;
            vu = [vc.release(vu[0], left, ms), vc.release(vu[1], right, ms)];
            vuAt = now;
        }
        let wave = null;
        if (need.scope) {
            const source = typeof tap.spectrum?.getFloatTimeDomainData === 'function' ? tap.spectrum : tap.left;
            if (source && typeof source.getFloatTimeDomainData === 'function') {
                if (!waveSamples || waveSamples.length !== source.fftSize) waveSamples = new Float32Array(source.fftSize);
                source.getFloatTimeDomainData(waveSamples);
                wave = vc.sampleWaveform(waveSamples, 64);
            }
        }
        return { bands, left: vu[0], right: vu[1], wave, playing: tap.playing === true };
    }

    // ---- Drawing ----

    function surface(canvas) {
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const ctx = canvas.getContext('2d');
        return ctx ? { ctx, width, height } : null;
    }

    function drawSpectrum(levels, now) {
        const s = surface(spectrumCanvas);
        if (!s) return;
        if (vizMode === 'scope') {
            const wave = levels.wave ?? vc.synthesizeWaveform(levels.bands, levels.left, levels.right, now, 64);
            vc.drawOscilloscope(s.ctx, s.width, s.height, wave);
            return;
        }
        if (vizMode === 'analog-vu') {
            const dt = analogAt ? Math.max(0, now - analogAt) : 33;
            analogAt = now;
            analogVu = [vc.smoothNeedle(analogVu[0], levels.left, dt), vc.smoothNeedle(analogVu[1], levels.right, dt)];
            const peaks = analogPeaks.update(analogVu, now);
            vc.drawAnalogVu(s.ctx, s.width, s.height, analogVu[0], analogVu[1], peaks[0], peaks[1]);
            return;
        }
        if (vizMode === 'starfield') {
            const dt = starAt ? Math.max(0, now - starAt) : 33;
            starAt = now;
            vc.drawStarfieldPlasma(s.ctx, s.width, s.height, starfield, levels.bands, now, dt);
            return;
        }
        const peaks = bandPeaks.update(levels.bands, now);
        vc.drawColumns(s.ctx, s.width, s.height, levels.bands.map((level, i) => ({ level, peak: peaks[i] })), vc.SEGMENTS);
    }

    function drawVu(levels, now) {
        const s = surface(vuCanvas);
        if (!s) return;
        const peaks = vuPeaks.update([levels.left, levels.right], now);
        // The thin strip has fewer LEDs.
        const segments = vuCanvas.clientHeight < 40 ? vc.VU_SEGMENTS : vc.SEGMENTS;
        vc.drawColumns(s.ctx, s.width, s.height, [{ level: levels.left, peak: peaks[0] }, { level: levels.right, peak: peaks[1] }], segments);
    }

    function draw(target, levels, now) {
        last = levels;
        if (target === 'spectrum') drawSpectrum(levels, now);
        else drawVu(levels, now);
    }

    // No music or a stop: the LEDs go dark.
    const silent = () => ({ bands: new Array(vc.BANDS).fill(0), left: 0, right: 0, wave: new Array(64).fill(0) });
    function clear() {
        bandPeaks.reset();
        vuPeaks.reset();
        analogPeaks.reset();
        starfield.reset();
        vu = [0, 0];
        vuAt = 0;
        analogVu = [0, 0];
        analogAt = 0;
        starAt = 0;
        last = null;
        if (!spectrumCanvas.hidden && spectrumCanvas.clientWidth) drawSpectrum(silent(), 0);
        if (!vuCanvas.hidden && vuCanvas.clientWidth) drawVu(silent(), 0);
    }

    // Which canvas shows: the setting and the layout of music-ui.js.
    function showCanvases() {
        const m = mode();
        if (windowMode) {
            spectrumCanvas.hidden = m !== 'spectrum';
            vuCanvas.hidden = m !== 'vu';
            if (modePill) modePill.hidden = spectrumCanvas.hidden;
            if (vizWrap) vizWrap.hidden = spectrumCanvas.hidden;
            return;
        }
        const strip = collapsed();
        spectrumCanvas.hidden = m !== 'spectrum' || strip;
        vuCanvas.hidden = m === 'off' || !(strip || m === 'vu');
        if (modePill) modePill.hidden = spectrumCanvas.hidden;
        if (vizWrap) vizWrap.hidden = spectrumCanvas.hidden;
    }

    function applyVizMode(next, { persist = true } = {}) {
        const normalized = vc.normalizeVizMode(next);
        if (persist) {
            if (typeof window.music.setVizMode === 'function') window.music.setVizMode(normalized);
            else {
                try {
                    if (typeof localStorage !== 'undefined') localStorage.setItem(vc.VIZ_MODE_KEY, normalized);
                } catch { /* storage unavailable */ }
            }
        }
        vizMode = normalized;
        analogAt = 0;
        starAt = 0;
        syncModeUi();
        if (!spectrumCanvas.hidden && spectrumCanvas.clientWidth) {
            drawSpectrum(last ?? silent(), typeof performance !== 'undefined' ? performance.now() : 0);
        }
    }

    const cycleVizMode = () => applyVizMode(vc.nextVizMode(vizMode));

    // ---- The loop ----

    // The pop-out window: the setting, the view of the node and the page let it draw.
    function wanted() {
        const playing = view?.inVoice === true && Boolean(view?.now) && view.paused !== true;
        return mode() !== 'off' && playing && pageShown();
    }

    function decide() {
        if (windowMode) {
            return wanted() && !roomSilent ? mode() : null;
        }
        const tap = window.music.tap?.();
        return vc.barTarget({ mode: mode(), playing: tap?.playing === true, barShown: !bar.hidden, collapsed: collapsed(),
            popoutOpen: window.musicUi?.popoutOpen?.() === true, roomShown: roomShown && pageShown() });
    }

    const schedule = typeof requestAnimationFrame === 'function' ? fn => requestAnimationFrame(fn) : fn => setTimeout(fn, 16);
    const cancel = typeof cancelAnimationFrame === 'function' ? handle => cancelAnimationFrame(handle) : handle => clearTimeout(handle);
    const loop = vc.createLoop({
        schedule, cancel, now: () => performance.now(), decide,
        draw(target, now) {
            if (windowMode) {
                // The room window has the music: ask it for one frame (the answer draws). A lost answer: ask again.
                if (now - pullAt > 250 || pullAt === 0) {
                    pullAt = now;
                    api.musicVizPull?.();
                }
                return;
            }
            const levels = readLevels(now, {
                spectrum: target === 'spectrum' && (vizMode === 'bars' || vizMode === 'starfield'),
                vu: target === 'vu' || (target === 'spectrum' && vizMode === 'analog-vu'),
                scope: target === 'spectrum' && vizMode === 'scope'
            });
            draw(target, levels ?? silent(), now);
        },
        stopped: clear
    });

    // The LEDs of a shown canvas are dark before the first frame and after a stop.
    let idleShown = '';
    function refresh() {
        showCanvases();
        loop.refresh();
        const shown = `${spectrumCanvas.hidden}/${vuCanvas.hidden}/${collapsed()}/${bar.hidden}`;
        if (!loop.running() && idleShown !== shown) {
            idleShown = shown;
            clear();
        } else if (loop.running()) idleShown = '';
    }

    if (windowMode) {
        api.onMusicViz?.(bytes => {
            pullAt = 0;
            const wasSilent = roomSilent;
            roomSilent = !bytes;
            if (roomSilent !== wasSilent) refresh();
            const target = decide();
            if (!target) return;
            const frame = vc.decodeFrame(bytes instanceof Uint8Array ? bytes : bytes ? new Uint8Array(bytes) : null);
            draw(target, frame ?? silent(), performance.now());
        });
    } else {
        // The pop-out window asks for one frame: the levels of its mode. null: no music on this PC.
        api.onMusicVizPull?.(() => {
            const m = mode();
            const levels = m === 'off' ? null : readLevels(performance.now(), { spectrum: m === 'spectrum', vu: true });
            api.sendMusicViz?.(levels?.playing ? vc.encodeFrame(levels.bands, levels.left, levels.right) : null);
        });
        api.onMusicRoomShown?.(shown => {
            roomShown = shown !== false;
            refresh();
        });
    }

    spectrumCanvas.addEventListener('click', cycleVizMode);
    modePill?.addEventListener('click', event => {
        event.stopPropagation();
        cycleVizMode();
    });
    window.addEventListener('storage', event => {
        if (event.key === vc.VIZ_MODE_KEY) applyVizMode(event.newValue, { persist: false });
    });

    api.onMusic?.(next => {
        view = next ?? null;
        // A new track or the end of a pause: ask again at once.
        roomSilent = false;
        refresh();
    });
    Promise.resolve(api.getMusic?.()).then(value => { if (value && !view) { view = value; refresh(); } }).catch(() => {});
    window.music.onChange?.(() => {
        if (typeof window.music.vizMode === 'function') {
            const next = vc.normalizeVizMode(window.music.vizMode());
            if (next !== vizMode) applyVizMode(next, { persist: false });
        }
        refresh();
    });
    bar.addEventListener('musiclayout', refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('resize', () => { if (!loop.running()) clear(); });
    // The audio starts after the view (the context, the first frames of the DJ): a slow check starts the loop.
    setInterval(() => {
        if (loop.running()) return;
        if (windowMode && roomSilent && wanted()) api.musicVizPull?.();
        else refresh();
    }, 1000);
    syncModeUi();
    refresh();

    // For the checks: the loop state and the last levels (rounded).
    window.musicViz = {
        state: () => ({ running: loop.running(), frames: loop.frames(), target: decide(), mode: mode(), vizMode, roomShown,
            page: document.visibilityState,
            spectrumShown: !spectrumCanvas.hidden, vuShown: !vuCanvas.hidden,
            last: last ? { bands: last.bands.map(v => Math.round(v * 100) / 100), left: Math.round(last.left * 100) / 100,
                right: Math.round(last.right * 100) / 100 } : null }),
        cycleMode: cycleVizMode
    };
})();
