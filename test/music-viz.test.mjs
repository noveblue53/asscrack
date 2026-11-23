// Room music: the visualizer (src/application/music-viz-core.js, music-viz.js) and the layout of the music bar
// (music-ui.js: collapse, pop-out, hide). The files run in node:vm with the fake DOM; no audio, no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom } from './helpers/fake-dom.mjs';

const app = name => new URL(`../src/application/${name}`, import.meta.url);
const sources = Object.fromEntries(await Promise.all(['music-core.js', 'music-ui.js', 'music-viz-core.js', 'music-viz.js']
    .map(async name => [name, await readFile(app(name), 'utf8')])));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

const coreContext = { window: {}, Math, Number, Array, Uint8Array, Object };
vm.createContext(coreContext);
vm.runInContext(sources['music-viz-core.js'], coreContext, { filename: 'music-viz-core.js' });
const vc = coreContext.window.musicVizCore;

// The bins of getByteFrequencyData for one sine (a peak at its bin, 0 elsewhere).
function sineBins(hz, { sampleRate = 48000, fftSize = 2048 } = {}) {
    const bins = new Uint8Array(fftSize / 2);
    bins[Math.round(hz / (sampleRate / fftSize))] = 255;
    return bins;
}

test('bands: 16 log-spaced bands from bass to treble, each with a bin, no overlap', () => {
    const edges = vc.bandEdges({ sampleRate: 48000, fftSize: 2048 });
    assert.equal(edges.length, 16);
    for (let i = 0; i < edges.length; i++) {
        const [start, end] = edges[i];
        assert.ok(end > start, `band ${i} has a bin`);
        if (i > 0) assert.ok(start >= edges[i - 1][1], `band ${i} starts after band ${i - 1}`);
    }
    assert.ok(edges[0][0] * 48000 / 2048 < 60, 'the first band is bass');
    assert.ok(edges[15][1] * 48000 / 2048 > 12000, 'the last band is treble');
    // A sine lights the band of its frequency, and only that band.
    const bandOf = hz => edges.findIndex(([s, e]) => { const bin = Math.round(hz / (48000 / 2048)); return bin >= s && bin < e; });
    for (const hz of [50, 100, 440, 1000, 4000, 10000]) {
        const levels = vc.bandLevels(sineBins(hz), edges);
        const lit = Array.from(levels.map((v, i) => (v > 0 ? i : -1)).filter(i => i >= 0));
        assert.deepEqual(lit, [bandOf(hz)], `${hz} Hz`);
    }
    assert.ok(bandOf(50) < bandOf(440) && bandOf(440) < bandOf(4000) && bandOf(4000) < bandOf(10000));
    // Other FFT sizes and rates.
    for (const [sampleRate, fftSize] of [[44100, 2048], [48000, 1024], [48000, 4096]]) {
        const other = vc.bandEdges({ sampleRate, fftSize });
        assert.equal(other.length, 16);
        assert.ok(other.every(([s, e], i) => e > s && e <= fftSize / 2 && (i === 0 || s >= other[i - 1][1])), `${sampleRate}/${fftSize}`);
    }
});

test('LEDs: 14 segments, green to yellow to orange to red from the bottom; the level gives the lit count', () => {
    const colors = Array.from({ length: 14 }, (_, i) => vc.ledColor(i, 14));
    const { green, yellow, orange, red } = vc.COLORS;
    assert.deepEqual(colors, [...Array(8).fill(green), ...Array(3).fill(yellow), ...Array(2).fill(orange), red]);
    assert.equal(vc.ledColor(9, 10), red, 'the VU strip: the top LED is red');
    assert.equal(vc.ledColor(0, 10), green);
    assert.equal(vc.litSegments(0), 0);
    assert.equal(vc.litSegments(1), 14);
    assert.equal(vc.litSegments(0.5), 7);
    assert.equal(vc.litSegments(2), 14, 'above 1');
    assert.equal(vc.litSegments(NaN), 0);
});

test('peak caps: a new high holds 0.3 s, then falls to the level', () => {
    const peaks = vc.createPeaks(1);
    assert.deepEqual(peaks.update([0.8], 0), [0.8]);
    assert.deepEqual(peaks.update([0.2], 100), [0.8], 'held');
    assert.deepEqual(peaks.update([0.2], 300), [0.8], 'held to 0.3 s');
    const falling = peaks.update([0.2], 400)[0];
    assert.ok(falling < 0.8 && falling > 0.6, `falls after the hold: ${falling}`);
    assert.ok(Math.abs(falling - (0.8 - vc.FALL_PER_S * 0.1)) < 1e-9, 'the fall starts at the end of the hold');
    const later = peaks.update([0.2], 600)[0];
    assert.ok(later < falling, 'continues to fall');
    assert.equal(peaks.update([0.2], 2000)[0], 0.2, 'stops at the level');
    assert.equal(peaks.update([0.5], 2033)[0], 0.5, 'a new high');
    assert.equal(peaks.update([0.4], 2200)[0], 0.5, 'holds again');
    peaks.reset();
    assert.equal(peaks.update([0], 3000)[0], 0);
});

test('VU: RMS on a dB scale, a fast rise and a slow fall', () => {
    assert.equal(vc.vuLevel(new Float32Array(512)), 0, 'silence');
    assert.equal(vc.vuLevel(new Float32Array(512).fill(1)), 1, '0 dBFS');
    const quiet = vc.vuLevel(new Float32Array(512).fill(0.01));
    const loud = vc.vuLevel(new Float32Array(512).fill(0.3));
    assert.ok(quiet > 0 && quiet < loud && loud < 1, `${quiet} < ${loud}`);
    assert.equal(vc.release(0.2, 0.9, 33), 0.9, 'rises at once');
    const fallen = vc.release(0.9, 0, 100);
    assert.ok(Math.abs(fallen - 0.7) < 1e-9, `falls slowly: ${fallen}`);
    assert.equal(vc.release(0.1, 0, 1000), 0);
});

test('the frame of the pop-out window: 18 bytes; a bad frame gives null', () => {
    const frame = vc.encodeFrame(Array.from({ length: 16 }, (_, i) => i / 15), 0.5, 2);
    assert.equal(frame.length, 18);
    assert.equal(frame[0], 0);
    assert.equal(frame[15], 255);
    assert.equal(frame[17], 255, 'clamped');
    const back = vc.decodeFrame(frame);
    assert.equal(back.bands.length, 16);
    assert.ok(Math.abs(back.left - 0.5) < 0.01);
    assert.equal(vc.decodeFrame(new Uint8Array(17)), null);
    assert.equal(vc.decodeFrame(null), null);
});

test('drawing: each column has its LEDs and a white cap above the peak; the panel is the CSS background', () => {
    const rects = [];
    const ctx = { fillStyle: '', clearRect: () => rects.push('clear'), fillRect(x, y, w, h) { rects.push({ color: this.fillStyle, x, y, w, h }); } };
    vc.drawColumns(ctx, 160, 56, [{ level: 1, peak: 1 }, { level: 0.5, peak: 0.75 }, { level: 0, peak: 0 }], 14);
    assert.equal(rects[0], 'clear');
    const leds = rects.slice(1);
    assert.equal(leds.length, 14 * 3 + 2, '14 LEDs each column and two caps');
    const first = leds.slice(0, 14);
    assert.ok(first.every(r => r.color !== vc.COLORS.unlit), 'full level: all lit');
    assert.equal(first[13].color, vc.COLORS.red);
    assert.equal(leds[14].color, vc.COLORS.peak, 'the cap of a full column is the top LED');
    const second = leds.slice(15, 29);
    assert.equal(second.filter(r => r.color !== vc.COLORS.unlit).length, 7);
    assert.deepEqual([leds[29].color, leds[29].y], [vc.COLORS.peak, second[Math.round(0.75 * 14)].y], 'the cap: the LED above the peak level');
    assert.ok(leds.slice(30).every(r => r.color === vc.COLORS.unlit), 'no level, no cap');
    assert.ok(first.every((r, i) => i === 0 || r.y < first[i - 1].y), 'from the bottom up');
});

test('bar target: nothing with Off, with no music, or when the bar or the room window is not on the screen', () => {
    const on = { mode: 'spectrum', playing: true, barShown: true, collapsed: false, popoutOpen: false, roomShown: true };
    assert.equal(vc.barTarget(on), 'spectrum');
    assert.equal(vc.barTarget({ ...on, mode: 'vu' }), 'vu');
    assert.equal(vc.barTarget({ ...on, collapsed: true }), 'vu', 'the strip has the VU meter');
    assert.equal(vc.barTarget({ ...on, popoutOpen: true }), 'vu', 'the bar is a strip while the pop-out window is open');
    assert.equal(vc.barTarget({ ...on, mode: 'off' }), null);
    assert.equal(vc.barTarget({ ...on, mode: 'bad' }), null);
    assert.equal(vc.barTarget({ ...on, playing: false }), null, 'no music or paused');
    assert.equal(vc.barTarget({ ...on, barShown: false }), null, 'hidden bar (View menu, out of voice)');
    assert.equal(vc.barTarget({ ...on, roomShown: false }), null, 'minimized or hidden room window');
});

test('the draw loop: at most 30 frames each second, a stop when the target goes, a start again on refresh', () => {
    let queue = [];
    let now = 0;
    let target = 'spectrum';
    const drawn = [];
    let stops = 0;
    const loop = vc.createLoop({ schedule: fn => { queue.push(fn); return queue.length; }, cancel: () => { queue = []; },
        now: () => now, decide: () => target, draw: (t, at) => drawn.push([t, at]), stopped: () => { stops++; } });
    const frame = () => { const run = queue; queue = []; run.forEach(fn => fn()); };
    loop.refresh();
    assert.equal(loop.running(), true);
    // A 60 Hz display for 1 s: about 30 frames.
    for (let i = 0; i < 60; i++) { now = i * (1000 / 60); frame(); }
    assert.ok(drawn.length >= 29 && drawn.length <= 31, `${drawn.length} frames`);
    loop.refresh();
    assert.equal(queue.length, 1, 'a refresh does not start a second loop');
    // The window goes away: the next frame stops the loop and nothing more is scheduled.
    target = null;
    now += 17;
    frame();
    assert.equal(loop.running(), false);
    assert.equal(queue.length, 0);
    assert.equal(stops, 1);
    const count = drawn.length;
    frame();
    assert.equal(drawn.length, count);
    // A refresh with no target does nothing; with a target the loop runs again.
    loop.refresh();
    assert.equal(queue.length, 0);
    target = 'vu';
    loop.refresh();
    assert.equal(loop.running(), true);
    // A refresh while it runs and the target went: an immediate stop.
    target = null;
    loop.refresh();
    assert.equal(loop.running(), false);
    assert.equal(stops, 2);
});

// ---- The room window and the pop-out window (music-ui.js, music-viz.js) ----

const BAR_IDS = ['music-title', 'music-meta', 'music-pause', 'music-skip', 'music-stop', 'music-volume', 'music-ducking',
    'music-queue-toggle', 'music-queue-panel', 'music-count', 'music-add-form', 'music-link', 'music-files', 'music-folder',
    'music-folder-list', 'music-queue', 'music-status', 'music-visualizer'];

function load({ windowMode = false, settings = {}, playing = true, view: start } = {}) {
    const layout = [{ id: 'music-bar', hidden: !windowMode, children: [
        { id: 'music-spectrum', tag: 'canvas' }, { id: 'music-vu', tag: 'canvas', hidden: true },
        ...BAR_IDS.map(id => ({ id, tag: id === 'music-add-form' ? 'form' : 'div' })),
        ...(windowMode ? [] : [{ id: 'music-collapse', tag: 'button' }, { id: 'music-popout', tag: 'button' }])] },
    ...(windowMode ? [] : [{ id: 'music-mark', tag: 'button', hidden: true }, { id: 'view-music', tag: 'li' }, { id: 'status', tag: 'p' }])];
    const { document, window, Event } = createDom(layout);
    const el = id => document.getElementById(id);
    if (windowMode) el('music-bar').dataset.mode = 'window';
    document.visibilityState = 'visible';
    const draws = { 'music-spectrum': 0, 'music-vu': 0 };
    for (const id of ['music-spectrum', 'music-vu']) {
        const canvas = el(id);
        canvas.clientWidth = 150;
        canvas.clientHeight = id === 'music-vu' ? 24 : 46;
        canvas.getContext = () => ({ clearRect() { draws[id]++; }, fillRect() {}, fillStyle: '' });
    }
    let s = { volume: 60, ducking: true, visualizer: 'spectrum', collapsed: false, hidden: false, popout: false, ...settings };
    const changes = [];
    const fire = () => changes.forEach(fn => fn());
    const tapState = { playing };
    const analyser = level => ({ fftSize: 1024, frequencyBinCount: 1024, getByteFrequencyData: a => a.fill(200),
        getFloatTimeDomainData: a => a.fill(level) });
    window.music = {
        settings: () => ({ ...s }),
        async setSettings(patch) { s = { ...s, ...patch }; fire(); return s; },
        onChange: fn => changes.push(fn),
        tap: () => (tapState.playing === null ? null : { spectrum: { ...analyser(0), fftSize: 2048 }, left: analyser(0.5), right: analyser(0.1),
            sampleRate: 48000, playing: tapState.playing })
    };
    const hooks = {};
    const calls = [];
    // Each file adds its own listener; a hook call runs each.
    const hook = name => fn => { const list = hooks[`_${name}`] ??= []; list.push(fn); hooks[name] = data => list.forEach(f => f(data)); };
    let view = start ?? { inVoice: true, dj: 'p1', self: 'p2', mine: false, now: { id: 'a', title: 'Song A' }, paused: false, queue: [] };
    window.asscrack = {
        onMusic: hook('music'), onMusicNotice: hook('notice'), onPeerName: hook('name'), getMusic: async () => view,
        getMusicSettings: async () => ({ ...s }), musicPopout: async open => { calls.push(['popout', open]); return open; },
        onMusicPopout: hook('popout'), onMusicVizPull: hook('pull'), onMusicRoomShown: hook('roomShown'), onMusicViz: hook('viz'),
        sendMusicViz: bytes => calls.push(['viz', bytes]), musicVizPull: () => calls.push(['pull'])
    };
    window.window = window;
    let frames = [];
    let clock = 0;
    const context = { window, document, Event, console, Promise, Math, Number, String, Object, Array, JSON, Uint8Array,
        Float32Array, setTimeout, clearTimeout, setInterval: () => 0, performance: { now: () => clock },
        requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame: () => { frames = []; } };
    vm.createContext(context);
    for (const name of ['music-core.js', 'music-ui.js', 'music-viz-core.js', 'music-viz.js']) vm.runInContext(sources[name], context, { filename: name });
    const tick = (ms = 34) => { clock += ms; const run = frames; frames = []; run.forEach(fn => fn()); };
    const setView = next => { view = next; hooks.music(next); };
    return { el, window, document, hooks, calls, draws, tick, tapState, setView, settings: () => s, viz: () => window.musicViz.state(),
        frames: () => frames.length };
}

test('room window: the spectrum in the bar while music plays; the loop stops when the room window is minimized', async () => {
    const room = load();
    await settle();
    assert.equal(room.el('music-bar').hidden, false);
    assert.equal(room.el('music-spectrum').hidden, false);
    assert.equal(room.el('music-vu').hidden, true);
    assert.equal(room.viz().running, true);
    for (let i = 0; i < 5; i++) room.tick();
    assert.ok(room.viz().frames >= 4, `${room.viz().frames} frames`);
    assert.ok(room.draws['music-spectrum'] >= 4);
    assert.ok(room.viz().last.bands.every(v => v > 0.7), 'the bands of the analyser');
    // Minimized (main.js): the next frame stops the loop; no more frames are scheduled.
    room.hooks.roomShown(false);
    room.tick();
    assert.equal(room.viz().running, false);
    assert.equal(room.frames(), 0);
    const count = room.viz().frames;
    room.tick();
    assert.equal(room.viz().frames, count);
    room.hooks.roomShown(true);
    assert.equal(room.viz().running, true, 'restore: the loop starts again');
    // The page is hidden.
    room.document.visibilityState = 'hidden';
    room.document.dispatchEvent(new (createDom().Event)('visibilitychange'));
    room.tick();
    assert.equal(room.viz().running, false);
    room.document.visibilityState = 'visible';
    room.document.dispatchEvent(new (createDom().Event)('visibilitychange'));
    assert.equal(room.viz().running, true);
    // Pause and no music: the loop stops.
    room.tapState.playing = false;
    room.tick();
    assert.equal(room.viz().running, false);
});

test('room window: Off hides the visualizer and stops the loop; VU shows the meter', async () => {
    const room = load();
    await settle();
    room.el('music-visualizer').value = 'off';
    room.el('music-visualizer').dispatchEvent(new (createDom().Event)('change'));
    await settle();
    assert.equal(room.settings().visualizer, 'off');
    assert.equal(room.viz().running, false);
    assert.equal(room.el('music-spectrum').hidden, true);
    assert.equal(room.el('music-vu').hidden, true);
    room.el('music-visualizer').value = 'vu';
    room.el('music-visualizer').dispatchEvent(new (createDom().Event)('change'));
    await settle();
    assert.equal(room.el('music-vu').hidden, false);
    assert.equal(room.el('music-spectrum').hidden, true);
    assert.equal(room.viz().running, true);
    room.tick();
    assert.ok(room.viz().last.left > room.viz().last.right, 'two channels');
});

test('room window: Collapse folds the bar to the strip with the VU meter; the setting remembers it', async () => {
    const room = load();
    await settle();
    room.el('music-collapse').click();
    await settle();
    assert.equal(room.settings().collapsed, true);
    assert.equal(room.el('music-bar').classList.contains('collapsed'), true);
    assert.equal(room.el('music-collapse').getAttribute('aria-expanded'), 'false');
    assert.equal(room.el('music-vu').hidden, false, 'the VU meter in the strip');
    assert.equal(room.el('music-spectrum').hidden, true);
    assert.equal(room.el('music-pause').hidden, false, 'Pause and Skip stay');
    room.tick();
    assert.equal(room.viz().target, 'vu');
    // A new start with the saved setting: the strip at once.
    const again = load({ settings: { collapsed: true } });
    await settle();
    assert.equal(again.el('music-bar').classList.contains('collapsed'), true);
    room.el('music-collapse').click();
    await settle();
    assert.equal(room.el('music-bar').classList.contains('collapsed'), false);
});

test('room window: View > Music player hides the bar; the status bar mark shows the track and brings it back', async () => {
    const room = load();
    await settle();
    assert.equal(room.el('view-music').getAttribute('aria-checked'), 'true');
    await room.window.musicUi.toggleHidden();
    await settle();
    assert.equal(room.settings().hidden, true);
    assert.equal(room.el('music-bar').hidden, true);
    assert.equal(room.el('music-mark').hidden, false);
    assert.equal(room.el('music-mark').textContent, 'Music: Song A');
    assert.equal(room.el('view-music').getAttribute('aria-checked'), 'false');
    room.tick();
    assert.equal(room.viz().running, false, 'no drawing for a hidden bar');
    // Out of voice: no mark.
    room.setView({ inVoice: false, dj: null, now: null, queue: [] });
    assert.equal(room.el('music-mark').hidden, true);
    room.setView({ inVoice: true, dj: 'p1', self: 'p2', now: { id: 'b', title: 'Song B' }, paused: false, queue: [] });
    assert.equal(room.el('music-mark').textContent, 'Music: Song B');
    room.el('music-mark').click();
    await settle();
    assert.equal(room.settings().hidden, false);
    assert.equal(room.el('music-bar').hidden, false);
    assert.equal(room.el('music-mark').hidden, true);
    assert.equal(room.viz().running, true);
});

test('room window: the pop-out window folds the bar; a remembered pop-out opens again one time in each voice session', async () => {
    const room = load();
    await settle();
    room.el('music-popout').click();
    await settle();
    assert.deepEqual(room.calls.filter(c => c[0] === 'popout'), [['popout', true]]);
    room.hooks.popout({ open: true });
    assert.equal(room.el('music-bar').classList.contains('collapsed'), true);
    assert.equal(room.el('music-collapse').hidden, true);
    assert.equal(room.el('music-popout').getAttribute('aria-pressed'), 'true');
    room.tick();
    assert.equal(room.viz().target, 'vu');
    // The pull of the pop-out window: 18 bytes of the levels.
    room.hooks.pull();
    const sent = room.calls.filter(c => c[0] === 'viz').at(-1)[1];
    assert.equal(sent.length, 18);
    assert.ok(sent[0] > 150, 'the spectrum mode sends the bands');
    room.tapState.playing = false;
    room.hooks.pull();
    assert.equal(room.calls.filter(c => c[0] === 'viz').at(-1)[1], null, 'no music: null');
    room.el('music-popout').click();
    await settle();
    assert.deepEqual(room.calls.filter(c => c[0] === 'popout').at(-1), ['popout', false]);
    room.hooks.popout({ open: false });
    assert.equal(room.el('music-bar').classList.contains('collapsed'), false);

    const again = load({ settings: { popout: true }, view: { inVoice: false, dj: null, now: null, queue: [] } });
    await settle();
    assert.deepEqual(again.calls.filter(c => c[0] === 'popout'), [], 'not out of voice');
    again.setView({ inVoice: true, dj: 'p1', self: 'p2', now: null, queue: [] });
    again.setView({ inVoice: true, dj: 'p1', self: 'p2', now: null, queue: [] });
    await settle();
    assert.deepEqual(again.calls.filter(c => c[0] === 'popout'), [['popout', true]], 'one open in this voice session');
    again.setView({ inVoice: false, dj: null, now: null, queue: [] });
    again.setView({ inVoice: true, dj: 'p1', self: 'p2', now: null, queue: [] });
    await settle();
    assert.equal(again.calls.filter(c => c[0] === 'popout').length, 2, 'the next voice session');
});

test('pop-out window: the large spectrum asks the room window for each frame; it stops when hidden or paused', async () => {
    const win = load({ windowMode: true });
    await settle();
    assert.equal(win.el('music-bar').hidden, false);
    assert.equal(win.el('music-spectrum').hidden, false);
    assert.equal(win.viz().running, true);
    win.tick();
    assert.equal(win.calls.filter(c => c[0] === 'pull').length, 1);
    win.tick();
    assert.equal(win.calls.filter(c => c[0] === 'pull').length, 1, 'one pull waits for its answer');
    win.hooks.viz(new Uint8Array(18).fill(255));
    assert.ok(win.viz().last.bands.every(v => v === 1));
    win.tick();
    assert.equal(win.calls.filter(c => c[0] === 'pull').length, 2);
    // Minimized or hidden: no pulls.
    win.document.visibilityState = 'hidden';
    win.document.dispatchEvent(new (createDom().Event)('visibilitychange'));
    win.tick();
    win.tick();
    assert.equal(win.viz().running, false);
    assert.equal(win.calls.filter(c => c[0] === 'pull').length, 2);
    win.document.visibilityState = 'visible';
    win.document.dispatchEvent(new (createDom().Event)('visibilitychange'));
    assert.equal(win.viz().running, true);
    win.setView({ inVoice: true, dj: 'p1', self: 'p2', now: { id: 'a', title: 'Song A' }, paused: true, queue: [] });
    win.tick();
    assert.equal(win.viz().running, false, 'paused');
    // Out of voice: the window stays, with no music.
    win.setView({ inVoice: false, dj: null, now: null, queue: [] });
    assert.equal(win.el('music-bar').hidden, false);
    assert.equal(win.el('music-title').textContent, 'Not in voice');
});
