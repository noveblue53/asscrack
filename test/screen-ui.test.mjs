// P8b, design work packages W4 (checks 1, 2, 3, 3a) and W5 (check 4) (work-orders/astra/P8/DESIGN.md, sections 2.2,
// 2.7 and 3.2). screen-share.js and screen-view.js run in node:vm with the fake DOM of test/helpers/fake-dom.mjs, a
// bridge that the test controls, a fake clock (performance.now), and fakes of VideoEncoder, VideoFrame,
// MediaStreamTrackProcessor, getDisplayMedia and VideoDecoder. No Electron, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom } from './helpers/fake-dom.mjs';

const SCRIPTS = ['screen-frame-check.js', 'screen-share.js', 'screen-view.js'];
const sources = await Promise.all(SCRIPTS.map(name => readFile(new URL(`../src/application/${name}`, import.meta.url), 'utf8')));
const SHARE = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

const LAYOUT = [
    { id: 'voice-controls', children: [{ id: 'share-screen', tag: 'button' }] },
    { id: 'share-bar', hidden: true, children: [
        { id: 'share-bar-source', tag: 'strong' }, { id: 'share-bar-viewers', tag: 'span' },
        { id: 'share-bar-quality', tag: 'span' }, { id: 'share-bar-notes', tag: 'span', hidden: true },
        { id: 'share-preview', tag: 'video', hidden: true }, { id: 'share-preview-toggle', tag: 'button' },
        { id: 'share-stop', tag: 'button' }
    ] },
    { id: 'share-error', tag: 'p', hidden: true },
    { id: 'screen-banner', hidden: true, children: [{ id: 'screen-banner-text', tag: 'span' }, { id: 'screen-watch', tag: 'button' }] },
    { id: 'screen-notice', tag: 'p', hidden: true },
    { id: 'screen-stage', tag: 'section', hidden: true, children: [
        { id: 'screen-stage-title', tag: 'h2' }, { id: 'screen-stage-info', tag: 'span' },
        { id: 'screen-stage-note', tag: 'span', hidden: true }, { id: 'screen-fill', tag: 'button' },
        { id: 'screen-unwatch', tag: 'button' }, { id: 'screen-canvas', tag: 'canvas' }
    ] },
    { id: 'screen-picker', tag: 'dialog', children: [
        { id: 'screen-picker-status', tag: 'p' }, { id: 'screen-list-screens', tag: 'ul' }, { id: 'screen-list-windows', tag: 'ul' },
        { id: 'screen-quality', tag: 'select' }, { id: 'screen-share-go', tag: 'button' }, { id: 'screen-cancel', tag: 'button' }
    ] },
    { id: 'peers', tag: 'ul' }
];

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

function load({ storage = new Map(), sources: list = [{ id: 'screen:0:0', kind: 'screen', name: 'Screen 1', thumbnail: null },
    { id: 'window:5:0', kind: 'window', name: 'Check window', thumbnail: null }], settings = { width: 2560, height: 1440, frameRate: 60 } } = {}) {
    const { document, window, Event } = createDom(LAYOUT);
    const clock = { t: 1000 };
    const order = []; // track.stop and the IPC calls, in sequence
    const calls = [];
    const handlers = {};
    const encoders = [];
    const decoders = [];
    let sourcesResolve;
    let displayRequests = 0;
    const picker = document.getElementById('screen-picker');
    picker.open = false;
    picker.showModal = () => { picker.open = true; };
    picker.close = () => { picker.open = false; picker.dispatchEvent(new Event('close')); };
    const canvas = document.getElementById('screen-canvas');
    canvas.draws = 0;
    canvas.getContext = () => ({ drawImage: () => { canvas.draws++; } });
    document.createElement = (orig => tag => {
        const el = orig(tag);
        if (String(tag).toLowerCase() === 'canvas') el.getContext = () => ({ drawImage() {} });
        return el;
    })(document.createElement.bind(document));

    const record = (name, ...args) => { calls.push({ name, args }); order.push(name); };
    const api = {
        getScreenSources: () => { record('getScreenSources'); return new Promise(resolve => { sourcesResolve = () => resolve(list); }); },
        getScreenQuality: async () => 'auto',
        pickScreenSource: async (id, quality) => { record('pickScreenSource', id, quality); return { name: list.find(s => s.id === id)?.name, width: 2560, height: 1440, frameRate: 60, bitrate: 12000000 }; },
        startScreenShare: async options => { record('startScreenShare', options); return { shareId: SHARE }; },
        stopScreenShare: reason => record('stopScreenShare', reason),
        sendScreenFrame: frame => record('sendScreenFrame', frame),
        reportScreenEncoder: report => record('reportScreenEncoder', report),
        setScreenSize: size => record('setScreenSize', size),
        watchScreen: peerId => { record('watchScreen', peerId); return new Promise((resolve, reject) => { api.pendingWatch = { resolve, reject }; }); },
        unwatchScreen: () => record('unwatchScreen'),
        requestScreenKey: () => record('requestScreenKey'),
        getScreenState: async () => ({ own: null, peers: {}, watching: null }),
        getIdlePeer: async () => ({ idle: false })
    };
    const bridge = new Proxy(api, {
        get(target, name) {
            if (name in target) return target[name];
            if (typeof name === 'string' && name.startsWith('on')) return fn => { (handlers[name] ??= []).push(fn); };
            return undefined;
        }
    });
    const emit = (name, data) => { for (const fn of handlers[name] ?? []) fn(data); };

    const track = {
        readyState: 'live', listeners: {}, constraints: [],
        stop() { this.readyState = 'ended'; order.push('track.stop'); },
        getSettings: () => settings,
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
        applyConstraints(c) { this.constraints.push(c); return Promise.resolve(); }
    };
    const capture = { queue: [], waiting: null };
    class FakeVideoFrame {
        constructor(src, init = {}) {
            this.displayWidth = src.displayWidth; this.displayHeight = src.displayHeight;
            this.codedWidth = src.codedWidth ?? src.displayWidth; this.codedHeight = src.codedHeight ?? src.displayHeight;
            this.timestamp = init.timestamp ?? src.timestamp ?? 0; this.closed = false;
        }
        clone() { return new FakeVideoFrame(this); }
        close() { this.closed = true; }
    }
    class FakeEncoder {
        constructor({ output, error }) { this.output = output; this.error = error; this.state = 'unconfigured'; this.encodeQueueSize = 0; this.configs = []; this.frames = []; encoders.push(this); }
        configure(config) { this.configs.push(config); this.state = 'configured'; }
        encode(frame, options) { this.frames.push({ timestamp: frame.timestamp, key: options?.keyFrame === true }); }
        close() { this.state = 'closed'; }
        // The test makes the encoder give a chunk for its last frame.
        out(bytes, key = false) {
            const last = this.frames.at(-1);
            this.output({ byteLength: bytes, type: key ? 'key' : 'delta', timestamp: last.timestamp, copyTo: target => target.fill(7) });
        }
    }
    class FakeDecoder {
        constructor({ output, error }) { this.output = output; this.error = error; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.configs = []; this.chunks = []; decoders.push(this); }
        configure(config) { this.configs.push(config); this.state = 'configured'; }
        decode(chunk) { this.chunks.push(chunk); }
        reset() { this.state = 'unconfigured'; }
        close() { this.state = 'closed'; }
    }
    const context = {
        window, document, console: { log() {}, info() {}, warn() {}, error() {} },
        performance: { now: () => clock.t },
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout, setInterval: () => 0, clearInterval: () => {},
        // The preview of the own share: a MediaStream of the track, and the stored choice.
        MediaStream: class { constructor(tracks) { this.tracks = tracks; } getVideoTracks() { return this.tracks; } },
        localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
        queueMicrotask, Promise, Map, Set, Object, Math, Number, String, Array, JSON, Uint8Array, Error,
        VideoEncoder: FakeEncoder, VideoFrame: FakeVideoFrame, VideoDecoder: FakeDecoder,
        EncodedVideoChunk: class { constructor(init) { Object.assign(this, init); } },
        MediaStreamTrackProcessor: class {
            constructor() {
                this.readable = { getReader: () => ({
                    read: () => capture.queue.length ? Promise.resolve(capture.queue.shift()) : new Promise(resolve => { capture.waiting = resolve; }),
                    cancel: () => { capture.waiting?.({ done: true }); return Promise.resolve(); }
                }) };
            }
        },
        navigator: { mediaDevices: { getDisplayMedia: async constraints => {
            displayRequests++;
            record('getDisplayMedia', constraints);
            return { getVideoTracks: () => [track], getTracks: () => [track] };
        } } },
        peerNames: new Map([['peer-a', 'Ann'], ['peer-b', 'Bo']]),
        peerItems: new Map(),
        selfLine: null,
        updateVoiceView: () => {}
    };
    window.asscrack = bridge;
    window.window = window;
    window.document = document;
    vm.createContext(context);
    for (let i = 0; i < SCRIPTS.length; i++) vm.runInContext(sources[i], context, { filename: SCRIPTS[i] });
    const el = id => document.getElementById(id);
    // One captured frame of the source.
    const frame = (width = 2560, height = 1440) => {
        const value = new FakeVideoFrame({ displayWidth: width, displayHeight: height, timestamp: clock.t * 1000 });
        if (capture.waiting) { const resolve = capture.waiting; capture.waiting = null; resolve({ value, done: false }); }
        else capture.queue.push({ value, done: false });
        return value;
    };
    return { window, document, Event, el, clock, calls, order, emit, track, encoders, decoders, frame, picker, canvas,
        context, resolveSources: () => sourcesResolve(), displayRequests: () => displayRequests, api };
}

function names(calls, name) { return calls.filter(c => c.name === name); }

async function startShare(f, quality = 'auto') {
    f.el('share-screen').click();
    await flush();
    f.resolveSources();
    await flush();
    f.el('screen-list-screens').querySelector('.screen-source').click();
    f.el('screen-quality').value = quality;
    f.el('screen-share-go').click();
    await flush();
}

test('W4 check 1: the picker shows Loading sources, then the two lists; Share waits for a source; Cancel and Escape capture nothing', async () => {
    const f = load();
    f.el('share-screen').click();
    await flush();
    assert.equal(f.picker.open, true);
    assert.equal(f.el('screen-picker-status').textContent, 'Loading sources…');
    assert.equal(f.el('screen-picker-status').hidden, false);
    assert.equal(f.el('screen-share-go').disabled, true);
    const quality = f.el('screen-quality');
    assert.deepEqual(quality.children.map(o => o.value), ['auto', 'standard', 'smooth', 'balanced', 'high', 'max']);
    assert.deepEqual(quality.children.map(o => o.textContent), ['Auto', 'Standard (720p, 15 fps)',
        'Smooth (720p, 30 fps)', 'Balanced (1080p, 30 fps)', 'High (1080p, 60 fps)', 'Max (1440p, 60 fps)']);
    assert.equal(quality.value, 'auto', 'Auto is selected');
    f.resolveSources();
    await flush();
    assert.equal(f.el('screen-picker-status').hidden, true);
    assert.deepEqual(f.el('screen-list-screens').querySelectorAll('.screen-source-name').map(n => n.textContent), ['Screen 1']);
    assert.deepEqual(f.el('screen-list-windows').querySelectorAll('.screen-source-name').map(n => n.textContent), ['Check window']);
    assert.equal(f.el('screen-share-go').disabled, true, 'no source selected yet');
    f.el('screen-list-windows').querySelector('.screen-source').click();
    assert.equal(f.el('screen-share-go').disabled, false);
    // Cancel.
    f.el('screen-cancel').click();
    assert.equal(f.picker.open, false);
    // Escape: the native dialog closes itself (the cancel event), the same as close().
    f.el('share-screen').click();
    await flush();
    f.picker.close();
    f.resolveSources();
    await flush();
    assert.equal(names(f.calls, 'pickScreenSource').length, 0);
    assert.equal(f.displayRequests(), 0, 'no capture function');
    assert.equal(names(f.calls, 'startScreenShare').length, 0);
});

test('W4 check 2: Share screen is disabled in Idle Peer and while another member shares', async () => {
    const f = load();
    await flush();
    const share = f.el('share-screen');
    assert.equal(share.disabled, false);
    f.emit('onIdlePeer', { idle: true });
    assert.equal(share.disabled, true, 'Idle Peer');
    f.emit('onIdlePeer', { idle: false });
    assert.equal(share.disabled, false);
    f.emit('onScreenState', { peerId: 'peer-a', sharing: true, shareId: SHARE, preset: 'auto' });
    assert.equal(share.disabled, true, 'another member shares');
    share.click();
    await flush();
    assert.equal(f.picker.open, false, 'a click does nothing');
    f.emit('onScreenState', { peerId: 'peer-a', sharing: false, shareId: null, preset: null });
    assert.equal(share.disabled, false);
});

test('W4 check 3: Stop sharing calls track.stop() before it sends asscrack:screen-stop, and the bar goes away', async () => {
    const f = load();
    await startShare(f, 'standard');
    assert.deepEqual(names(f.calls, 'pickScreenSource')[0].args, ['screen:0:0', 'standard']);
    assert.deepEqual(JSON.parse(JSON.stringify(names(f.calls, 'getDisplayMedia')[0].args[0])),
        { video: { width: { max: 2560 }, height: { max: 1440 }, frameRate: { max: 60 } }, audio: false });
    assert.deepEqual(JSON.parse(JSON.stringify(names(f.calls, 'startScreenShare')[0].args[0])), { preset: 'standard', width: 2560, height: 1440 });
    assert.equal(f.picker.open, false);
    assert.equal(f.el('share-bar').hidden, false);
    assert.equal(f.el('share-bar-source').textContent, 'You are sharing: Screen 1');
    assert.equal(f.el('share-bar-viewers').textContent, 'No one is watching');
    assert.equal(f.el('share-screen').textContent, 'Stop sharing');
    f.order.length = 0;
    f.el('share-stop').click();
    assert.deepEqual(f.order, ['track.stop', 'stopScreenShare'], 'track.stop() first, in the same task');
    assert.equal(f.el('share-bar').hidden, true);
    assert.equal(f.el('share-screen').textContent, 'Share screen');
    assert.equal(f.window.screenShare.stats().trackState, 'ended');
    // The button in the voice controls is the same path.
    await startShare(f);
    f.order.length = 0;
    f.el('share-screen').click();
    assert.deepEqual(f.order, ['track.stop', 'stopScreenShare']);
});

test('W4 check 1 and 2.8: a refusal of the capture closes the picker and shows the reason', async () => {
    const f = load();
    f.context.navigator.mediaDevices.getDisplayMedia = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
    await startShare(f);
    assert.equal(f.picker.open, false);
    assert.equal(f.el('share-error').textContent, 'Couldn\'t start the share: NotAllowedError');
    assert.equal(f.el('share-error').hidden, false);
    assert.equal(names(f.calls, 'startScreenShare').length, 0, 'no screen line');
    assert.equal(f.el('share-bar').hidden, true);
});

test('W4 check 3a: frame slots, E1, the full bucket of E3, the E11 report and a new preset of one tier', async () => {
    const f = load();
    await startShare(f);
    const view = tiers => ({ tiers, capture: { preset: 'max', width: 2560, height: 1440, fps: 60 }, cap: 'max' });
    f.emit('onScreenEncoder', view([
        { tier: 1, preset: 'standard', width: 1280, height: 720, fps: 15, bitrate: 1500000 },
        { tier: 2, preset: 'smooth', width: 1280, height: 720, fps: 30, bitrate: 3000000 },
        { tier: 3, preset: 'high', width: 1920, height: 1080, fps: 60, bitrate: 9000000 }
    ]));
    // A capture at 60 frames each second for 2 s. The second second has exactly the frame rate of each preset.
    const second = async () => {
        for (let i = 0; i < 60; i++) {
            f.frame();
            await flush();
            f.clock.t += 1000 / 60;
        }
    };
    await second();
    const [a, b, c] = f.encoders;
    const before = [a.frames.length, b.frames.length, c.frames.length];
    await second();
    assert.deepEqual([a.frames.length - before[0], b.frames.length - before[1], c.frames.length - before[2]], [15, 30, 60],
        'E10: 15, 30 and 60 frames in 1 s');
    assert.equal(a.configs[0].width, 1280, 'the encoder scales the frame to the fit of its preset');
    assert.equal(c.configs[0].height, 1080);
    assert.deepEqual(JSON.parse(JSON.stringify(a.configs[0])), { codec: 'vp8', width: 1280, height: 720, bitrate: 1500000, framerate: 15, latencyMode: 'realtime', hardwareAcceleration: 'prefer-software' });
    assert.equal(a.frames[0].key, true, 'the first frame of an encoder is a keyframe');
    assert.equal(a.frames[1].key, false);
    assert.deepEqual(JSON.parse(JSON.stringify(names(f.calls, 'setScreenSize').map(c => c.args[0]))),
        [{ tier: 1, width: 1280, height: 720 }, { tier: 2, width: 1280, height: 720 }, { tier: 3, width: 1920, height: 1080 }],
        'P8a-3: the size of each tier after its configure');
    // E11: a report each 500 ms with the slots of each tier.
    const reports = names(f.calls, 'reportScreenEncoder').map(c => c.args[0]);
    assert.ok(reports.length >= 1);
    assert.deepEqual([...reports[0].tiers.map(t => t.tier)], [1, 2, 3]);
    assert.ok(reports[0].tiers[2].slots >= 29 && reports[0].tiers[2].slots <= 31, `slots ${reports[0].tiers[2].slots}`);

    // E3: the bucket starts full (1 s of 1.5 Mbit/s = 187 500 bytes). A chunk of 400 000 bytes empties it: the next
    // slots are skipped. E4: a queue of 2 drops.
    a.out(400000, false);
    const sent = names(f.calls, 'sendScreenFrame').at(-1).args[0];
    assert.equal(sent.tier, 1);
    assert.equal(sent.data.length, 400000);
    f.calls.length = 0;
    c.encodeQueueSize = 2;
    for (let i = 0; i < 61; i++) {
        f.frame();
        await flush();
        f.clock.t += 1000 / 60;
    }
    const after = names(f.calls, 'reportScreenEncoder').map(r => r.args[0].tiers);
    const sum = (tier, key) => after.flat().filter(t => t.tier === tier).reduce((n, t) => n + t[key], 0);
    assert.ok(sum(1, 'skipped') >= 7, `E3 skipped ${sum(1, 'skipped')} slots of tier a`);
    assert.equal(sum(2, 'skipped'), 0);
    assert.ok(sum(3, 'dropped') >= 28, `E4 dropped ${sum(3, 'dropped')} slots of tier c`);
    c.encodeQueueSize = 0;

    // E1: tier b leaves the list: its encoder closes. A new preset of tier a: a new encoder, only for tier a.
    f.calls.length = 0;
    f.emit('onScreenEncoder', view([
        { tier: 1, preset: 'smooth', width: 1280, height: 720, fps: 30, bitrate: 2000000 },
        { tier: 3, preset: 'high', width: 1920, height: 1080, fps: 60, bitrate: 9000000 }
    ]));
    assert.equal(b.state, 'closed', 'E1');
    assert.equal(a.state, 'closed', 'the old encoder of tier a');
    assert.equal(c.state, 'configured', 'tier c does not change');
    f.frame();
    await flush();
    const a2 = f.encoders[3];
    assert.equal(f.encoders.length, 4, 'one new encoder');
    assert.equal(a2.configs[0].framerate, 30);
    assert.equal(a2.frames[0].key, true, 'a keyframe after the new preset');
    assert.deepEqual(JSON.parse(JSON.stringify(names(f.calls, 'setScreenSize').map(c => c.args[0]))), [{ tier: 1, width: 1280, height: 720 }]);
    // A chunk of the closed encoder goes nowhere.
    f.calls.length = 0;
    b.out(1000);
    assert.equal(names(f.calls, 'sendScreenFrame').length, 0);
});

test('W4: a keyframe request with an old kept frame encodes it at once, and a refresh tick encodes it again', async () => {
    const f = load();
    await startShare(f);
    const view = flags => ({ tiers: [{ tier: 1, preset: 'standard', width: 1280, height: 720, fps: 15, bitrate: 1500000, ...flags }] });
    f.emit('onScreenEncoder', view({}));
    f.frame();
    await flush();
    const encoder = f.encoders[0];
    assert.equal(encoder.frames.length, 1);
    f.clock.t += 500;
    f.emit('onScreenEncoder', view({ keyFrame: true }));
    assert.equal(encoder.frames.length, 2, 'E5: the kept frame at once');
    assert.equal(encoder.frames[1].key, true);
    f.clock.t += 1000;
    f.emit('onScreenEncoder', view({ refresh: true }));
    assert.equal(encoder.frames.length, 3);
    assert.equal(encoder.frames[2].key, false, 'a refresh frame');
    // E6: a bitrate change of 5 % or more reconfigures at most each 1 s.
    f.emit('onScreenEncoder', view({ bitrate: 1000000 }));
    f.clock.t += 100;
    f.frame();
    await flush();
    assert.equal(encoder.configs.at(-1).bitrate, 1000000);
    const count = encoder.configs.length;
    f.emit('onScreenEncoder', view({ bitrate: 800000 }));
    f.clock.t += 100;
    f.frame();
    await flush();
    assert.equal(encoder.configs.length, count, 'no second configure in 1 s');
    // The track ends (the source closed): the share stops with the reason source.
    f.calls.length = 0;
    for (const fn of f.track.listeners.ended ?? []) fn();
    assert.deepEqual(names(f.calls, 'stopScreenShare').map(c => c.args[0]), ['source']);
    f.emit('onScreenEnded', { peerId: 'self', reason: 'source', own: true });
    assert.equal(f.el('share-error').textContent, 'Sharing stopped: the source closed.');
});

test('W5 check 4: the banner, the END texts, peer-left, and a watch again after a lost connection', async () => {
    const f = load();
    await flush();
    const banner = f.el('screen-banner');
    f.emit('onScreenState', { peerId: 'peer-a', sharing: true, shareId: SHARE, preset: 'auto' });
    assert.equal(banner.hidden, false);
    assert.equal(f.el('screen-banner-text').textContent, 'Ann is sharing a screen.');
    f.emit('onScreenState', { peerId: 'peer-a', sharing: false, shareId: null, preset: null });
    assert.equal(banner.hidden, true, 'sharing false');
    // peer-left: the node emits the state false for the peer (screen-share.mjs peerLeft).
    f.emit('onScreenState', { peerId: 'peer-a', sharing: true, shareId: SHARE, preset: 'auto' });
    f.emit('onScreenState', { peerId: 'peer-a', sharing: false, shareId: null, preset: null });
    assert.equal(banner.hidden, true, 'peer-left');

    // Watch, then the END texts of section 3.2.
    const texts = { stopped: 'Ann stopped sharing.', source: 'Ann stopped sharing.', idle: 'Ann stopped sharing.',
        slow: 'Your connection is too slow for this share.', full: 'Viewer limit reached (6).',
        refused: 'This share is not available.', error: "Ann's share stopped." };
    for (const [reason, text] of Object.entries(texts)) {
        f.emit('onScreenState', { peerId: 'peer-a', sharing: true, shareId: SHARE, preset: 'auto' });
        f.el('screen-watch').click();
        await flush();
        assert.equal(f.el('screen-stage').hidden, false);
        assert.equal(f.el('screen-stage-note').textContent, 'Connecting to Ann…');
        f.api.pendingWatch.resolve({ shareId: SHARE, width: 1920, height: 1080, fps: 60 });
        await flush();
        assert.equal(f.el('screen-stage-info').textContent, '1920 x 1080, 60 fps');
        assert.equal(f.canvas.width, 1920, 'the canvas has the size of CONFIG');
        assert.equal(banner.hidden, true, 'no banner while watching');
        f.emit('onScreenEnded', { peerId: 'peer-a', reason, own: false });
        assert.equal(f.el('screen-stage').hidden, true, reason);
        assert.equal(f.el('screen-notice').textContent, text, reason);
        if (reason === 'slow' || reason === 'full') assert.equal(banner.hidden, false, `${reason}: the banner with Watch`);
    }

    // A stream that closes with no END (lost): the stage stays, and the same share ID in 60 s gives a new watch.
    f.emit('onScreenState', { peerId: 'peer-a', sharing: true, shareId: SHARE, preset: 'auto' });
    f.el('screen-watch').click();
    await flush();
    f.api.pendingWatch.resolve({ shareId: SHARE, width: 1280, height: 720, fps: 15 });
    await flush();
    f.calls.length = 0;
    f.emit('onScreenEnded', { peerId: 'peer-a', reason: 'lost', own: false });
    assert.equal(f.el('screen-stage').hidden, false, 'the stage stays');
    assert.equal(f.el('screen-stage-note').textContent, 'The connection to Ann was lost. Trying again…');
    // The session closes (peer-left) and opens again with the same share.
    f.emit('onScreenState', { peerId: 'peer-a', sharing: false, shareId: null, preset: null });
    assert.equal(f.el('screen-stage').hidden, false, 'the stage stays with the last picture');
    f.emit('onScreenState', { peerId: 'peer-a', sharing: true, shareId: SHARE, preset: 'auto' });
    await flush();
    assert.deepEqual(names(f.calls, 'watchScreen').map(c => c.args[0]), ['peer-a'], 'a new stream with no user action');
});

test('W5: the viewer drops a keyframe with a wrong size, asks for a keyframe after a gap, and Stop watching unwatches', async () => {
    const f = load();
    await flush();
    f.emit('onScreenState', { peerId: 'peer-a', sharing: true, shareId: SHARE, preset: 'auto' });
    f.el('screen-watch').click();
    await flush();
    f.api.pendingWatch.resolve({ shareId: SHARE, width: 1280, height: 720, fps: 30 });
    await flush();
    const decoder = f.decoders[0];
    assert.deepEqual(JSON.parse(JSON.stringify(decoder.configs[0])), { codec: 'vp8', codedWidth: 1280, codedHeight: 720, optimizeForLatency: true });
    const key = (w, h) => { const b = new Uint8Array(32); b[0] = 0x10; b.set([0x9d, 0x01, 0x2a], 3); b[6] = w & 255; b[7] = w >> 8; b[8] = h & 255; b[9] = h >> 8; return b; };
    const delta = () => { const b = new Uint8Array(32); b[0] = 0x11; return b; };
    f.emit('onScreenFrame', { peerId: 'peer-a', key: true, seq: 0, timestampMs: 5, data: key(1280, 720) });
    f.emit('onScreenFrame', { peerId: 'peer-a', key: false, seq: 1, timestampMs: 40, data: delta() });
    assert.equal(decoder.chunks.length, 2);
    assert.equal(decoder.chunks[0].type, 'key');
    assert.equal(decoder.chunks[1].timestamp, 40000);
    // A gap: no decode, one KEYREQ.
    f.calls.length = 0;
    f.emit('onScreenFrame', { peerId: 'peer-a', key: false, seq: 3, timestampMs: 80, data: delta() });
    f.emit('onScreenFrame', { peerId: 'peer-a', key: false, seq: 4, timestampMs: 120, data: delta() });
    assert.equal(decoder.chunks.length, 2);
    assert.equal(names(f.calls, 'requestScreenKey').length, 1);
    // A decoded frame with the size of CONFIG is drawn and closed.
    const frame = { codedWidth: 1280, codedHeight: 720, closed: false, close() { this.closed = true; } };
    decoder.output(frame);
    assert.equal(f.canvas.draws, 1);
    assert.equal(frame.closed, true);
    // A keyframe of another size: the viewer stops with an error.
    f.calls.length = 0;
    f.emit('onScreenFrame', { peerId: 'peer-a', key: true, seq: 5, timestampMs: 160, data: key(1920, 1080) });
    assert.equal(f.el('screen-stage').hidden, true);
    assert.equal(names(f.calls, 'unwatchScreen').length, 1);
    assert.equal(f.el('screen-notice').textContent, 'Can\'t play this share on this PC.');
    // Stop watching.
    f.el('screen-watch').click();
    await flush();
    f.api.pendingWatch.resolve({ shareId: SHARE, width: 1280, height: 720, fps: 30 });
    await flush();
    f.calls.length = 0;
    f.el('screen-unwatch').click();
    assert.equal(names(f.calls, 'unwatchScreen').length, 1);
    assert.equal(f.el('screen-stage').hidden, true);
    assert.equal(f.el('screen-banner').hidden, false);
});

test('W5: Fill window sets the body class, and unfill (the Escape dispatcher) goes back', async () => {
    const f = load();
    await flush();
    f.emit('onScreenState', { peerId: 'peer-a', sharing: true, shareId: SHARE, preset: 'auto' });
    f.el('screen-watch').click();
    await flush();
    f.api.pendingWatch.resolve({ shareId: SHARE, width: 1280, height: 720, fps: 30 });
    await flush();
    f.el('screen-fill').click();
    assert.equal(f.document.body.classList.contains('screen-fill'), true);
    assert.equal(f.window.screenView.isFilled(), true);
    assert.equal(f.window.screenView.unfill(), true);
    assert.equal(f.document.body.classList.contains('screen-fill'), false);
    assert.equal(f.window.screenView.unfill(), false, 'nothing to close');
    f.el('screen-fill').click();
    f.el('screen-fill').click();
    assert.equal(f.document.body.classList.contains('screen-fill'), false, 'the same button goes back');
});

// W6 check 1: the view that renderer.js publishes to the detached voice panel has the field of the share.
test('W6: the published voice panel view has the field sharing from window.screenShare', async () => {
    const { loadRoomWindow, settle } = await import('./helpers/renderer-fixture.mjs');
    const published = [];
    let activate = null;
    let sharing = false;
    const room = await loadRoomWindow({ window: {
        roomVoiceMonitor: { open() {}, publish: view => published.push(view), onActive: fn => { activate = fn; }, onMute() {}, onStopShare() {} },
        screenShare: { isSharing: () => sharing }
    } });
    await room.login('Ann');
    activate(true);
    await settle();
    assert.equal(published.at(-1).sharing, false);
    sharing = true;
    room.context?.updateVoiceView?.();
    activate(true);
    await settle();
    assert.equal(published.at(-1).sharing, true);
});

// Operator 2026-11-22: "i cant see my own preview". The share bar shows the own capture in a small muted video, on
// this computer only. The toggle hides it, and the choice stays. A hidden window gives the video no track.
test('the share bar shows a preview of the own capture; the toggle hides it and the choice stays', async () => {
    const storage = new Map();
    const f = load({ storage });
    const video = f.el('share-preview');
    video.plays = 0;
    video.play = () => { video.plays++; return Promise.resolve(); };
    video.pause = () => {};
    assert.equal(video.hidden, true, 'no share: no preview');
    await startShare(f, 'standard');
    assert.equal(video.hidden, false);
    assert.equal(video.muted, true);
    assert.equal(video.srcObject.getVideoTracks()[0], f.track, 'the captured track, no copy and no encode');
    assert.ok(video.plays >= 1);
    const sends = names(f.calls, 'sendScreenFrame').length;
    const toggle = f.el('share-preview-toggle');
    assert.equal(toggle.textContent, 'Hide preview');
    toggle.click();
    assert.equal(video.hidden, true);
    assert.equal(video.srcObject, null, 'off: the video has no track');
    assert.equal(toggle.textContent, 'Show preview');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(storage.get('asscrack.sharePreview.v1'), 'false');
    toggle.click();
    assert.equal(video.hidden, false);
    assert.equal(video.srcObject.getVideoTracks()[0], f.track);
    // A hidden window: no track in the video. Visible again: the track comes back.
    f.document.visibilityState = 'hidden';
    f.document.dispatchEvent(new f.Event('visibilitychange'));
    assert.equal(video.srcObject, null);
    f.document.visibilityState = 'visible';
    f.document.dispatchEvent(new f.Event('visibilitychange'));
    assert.equal(video.srcObject.getVideoTracks()[0], f.track);
    assert.equal(names(f.calls, 'sendScreenFrame').length, sends, 'the preview sends nothing');
    f.el('share-stop').click();
    assert.equal(video.hidden, true);
    assert.equal(video.srcObject, null, 'stop: the preview lets the track go');
    // The stored choice: a new window starts with the preview off.
    storage.set('asscrack.sharePreview.v1', 'false');
    const g = load({ storage });
    await startShare(g, 'standard');
    assert.equal(g.el('share-preview').hidden, true);
    assert.equal(g.el('share-preview-toggle').textContent, 'Show preview');
});
