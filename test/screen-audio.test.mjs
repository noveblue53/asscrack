// Screen share audio tests:
// 1. Companion libp2p protocol /asscrack/screen-audio/1.0.0 (real nodes on 127.0.0.1).
// 2. Windows WASAPI process-loopback helper (screen-audio-capture.mjs) with a fake spawned child.
// 3. Main-process source selection, lastAudio memory, and Chromium loopback fallback (screen-sources.mjs).
// 4. Per-sharer screen audio persistence (listening-store.mjs with maxVolume: 100, defaultVolume: 80).
// 5. Preload bridge screen audio IPC calls (preload.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createAsscrackNode } from '../src/network/node.mjs';
import { newRoomKey } from '../src/network/invite.mjs';
import { SCREEN_AUDIO_DEFAULTS, SCREEN_AUDIO_PROTOCOL, SCREEN_AUDIO_TYPE } from '../src/network/screen-audio.mjs';
import { readRecords, record, SCREEN_END } from '../src/network/screen-share.mjs';
import {
    AUDIO_BLOCK_BYTES, AUDIO_BLOCK_FRAMES, createScreenAudioCapture, PCM_MAGIC,
    processLoopbackSupported, READY_MAGIC
} from '../src/application/screen-audio-capture.mjs';
import {
    acceptScreenAudioFrame, createScreenSources, LOOPBACK_FALLBACK_WARNING
} from '../src/application/screen-sources.mjs';
import { listeningRoomTag, listeningStore } from '../src/application/listening-store.mjs';
import { createDom } from './helpers/fake-dom.mjs';

const LOCAL = ['/ip4/127.0.0.1/tcp/0'];
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 };

const waitFor = (emitter, event, match = () => true, ms = 10000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, on); reject(new Error(`timeout waiting for ${event}`)); }, ms);
    const on = data => {
        if (!match(data)) return;
        clearTimeout(timer);
        emitter.off(event, on);
        resolve(data);
    };
    emitter.on(event, on);
});

async function waitUntil(fn, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (fn()) return;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('timeout');
}

async function directPair(t, room) {
    const roomKey = newRoomKey();
    const a = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast });
    const b = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast });
    t.after(() => Promise.allSettled([a.stop(), b.stop()]));
    const addr = a.getMultiaddrs().find(m => m.startsWith('/ip4/127.0.0.1/') && !m.includes('p2p-circuit'));
    await b.connect(addr);
    await waitUntil(() => a.peers().includes(b.peerId) && b.peers().includes(a.peerId));
    return [a, b];
}

test('screen-audio protocol: sharer advertises audio, viewer streams Opus frames, mute closes stream, stop ends audio', async t => {
    const [a, b] = await directPair(t, 'audio-room');

    const stateEv = waitFor(b.events, 'screen-state', d => d.peerId === a.peerId && d.sharing === true);
    const { shareId } = a.startScreenShare({ preset: 'standard', width: 1280, height: 720, audio: true });
    const st = await stateEv;
    assert.equal(st.shareId, shareId);
    assert.equal(st.audio, true);
    assert.equal(b.screenState().peers[a.peerId].audio, true);
    assert.equal(a.screenState().own.audio, true);

    await b.watchScreenAudio(a.peerId);
    await waitUntil(() => a.screenAudioStats().listeners.length === 1);
    assert.deepEqual(a.screenAudioStats().listeners, [b.peerId]);

    const frameEv = waitFor(b.events, 'screen-audio-frame', d => d.peerId === a.peerId && d.shareId === shareId);
    const opusBytes = Uint8Array.of(0xf8, 0x01, 0x02, 0x03, 0x04);
    assert.equal(a.sendScreenAudioFrame(opusBytes), true);
    const got = await frameEv;
    assert.equal(got.seq, 1);
    assert.deepEqual([...got.data], [...opusBytes]);

    // Muting closes the audio stream to save bandwidth
    assert.equal(b.unwatchScreenAudio(), true);
    await waitUntil(() => a.screenAudioStats().listeners.length === 0);
    assert.deepEqual(a.screenAudioStats().listeners, []);

    // Unmuting re-opens the audio stream, and stopping the share emits screen-audio-ended
    await b.watchScreenAudio(a.peerId);
    await waitUntil(() => a.screenAudioStats().listeners.length === 1);
    const endedEv = waitFor(b.events, 'screen-audio-ended', d => d.peerId === a.peerId && d.shareId === shareId);
    a.stopScreenShare('stopped');
    const ended = await endedEv;
    assert.equal(ended.reason, 'stopped');
});

test('screen-audio protocol: watchScreenAudio rejects when share has no audio', async t => {
    const [a, b] = await directPair(t, 'no-audio-room');

    const stateEv = waitFor(b.events, 'screen-state', d => d.peerId === a.peerId && d.sharing === true);
    a.startScreenShare({ preset: 'standard', width: 1280, height: 720, audio: false });
    const st = await stateEv;
    assert.equal(st.audio, false);
    await assert.rejects(b.watchScreenAudio(a.peerId), /no audio/);
});

test('screen-audio-capture: processLoopbackSupported checks Windows build >= 20348', () => {
    assert.equal(processLoopbackSupported('win32', '10.0.20348'), true);
    assert.equal(processLoopbackSupported('win32', '10.0.22631'), true);
    assert.equal(processLoopbackSupported('win32', '10.0.19045'), false);
    assert.equal(processLoopbackSupported('linux', '6.8.0'), false);
    assert.equal(processLoopbackSupported('darwin', '23.0.0'), false);
});

test('screen-audio-capture: streams stereo float32 PCM blocks and respects pause', async () => {
    let fakeChild = null;
    const spawn = () => {
        fakeChild = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            killed: false,
            kill() { this.killed = true; this.emit('exit', 0); }
        });
        return fakeChild;
    };
    const cap = createScreenAudioCapture({ spawn, platform: 'win32', release: '10.0.22631', ownPid: 4242, startupTimeoutMs: 500 });
    assert.equal(cap.supported(), true);

    const blocks = [];
    const startPromise = cap.start({ mode: 'include', hwnd: 1234, onBlock: b => blocks.push(b) });
    fakeChild.stdout.emit('data', READY_MAGIC);
    const res = await startPromise;
    assert.deepEqual(res, { ok: true });
    assert.equal(cap.active(), true);

    // Build one 20ms interleaved stereo float32 block (L=0.25, R=-0.5)
    const pcm = Buffer.alloc(AUDIO_BLOCK_BYTES);
    for (let i = 0; i < AUDIO_BLOCK_FRAMES; i++) {
        pcm.writeFloatLE(0.25, i * 8);
        pcm.writeFloatLE(-0.5, i * 8 + 4);
    }
    const hdr = Buffer.alloc(8);
    PCM_MAGIC.copy(hdr, 0);
    hdr.writeUInt32LE(AUDIO_BLOCK_BYTES, 4);
    fakeChild.stdout.emit('data', Buffer.concat([hdr, pcm]));

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].left.length, AUDIO_BLOCK_FRAMES);
    assert.equal(blocks[0].left[0], 0.25);
    assert.equal(blocks[0].right[0], -0.5);

    // Pause suppresses blocks (Alt-Tab window guard)
    cap.setPaused(true);
    fakeChild.stdout.emit('data', Buffer.concat([hdr, pcm]));
    assert.equal(blocks.length, 1);
    cap.setPaused(false);
    fakeChild.stdout.emit('data', Buffer.concat([hdr, pcm]));
    assert.equal(blocks.length, 2);

    cap.stop();
    assert.equal(fakeChild.killed, true);
    assert.equal(cap.active(), false);
});

test('screen-sources: audio pick uses process loopback when supported, falls back to Chromium loopback otherwise, and remembers lastAudio', async () => {
    const roomFrame = { url: 'file:///asscrack/index.html' };
    const list = [
        { id: 'screen:0:0', name: 'Screen 1', thumbnail: { isEmpty: () => false, toPNG: () => Buffer.alloc(100, 1) } },
        { id: 'window:77:0', name: 'Game', thumbnail: { isEmpty: () => false, toPNG: () => Buffer.alloc(100, 1) } }
    ];
    const startCalls = [];
    let nextOk = true;
    const fakeCapture = {
        supported: () => true,
        start: async opts => { startCalls.push(opts); return nextOk ? { ok: true } : { ok: false, reason: 'failed' }; },
        stop: () => {}
    };
    const sources = createScreenSources({
        desktopCapturer: { getSources: async () => list },
        isRoomFrame: f => f === roomFrame,
        isIdle: () => false,
        audioCapture: fakeCapture
    });
    await sources.list();
    assert.equal(sources.lastAudio(), false);

    // Window share with audio -> mode 'include' with hwnd 77
    const winPick = await sources.pick('window:77:0', 'auto', { audio: true });
    assert.equal(winPick.audioMode, 'process');
    assert.equal(winPick.audioWarning, undefined);
    assert.equal(sources.lastAudio(), true);
    assert.equal(startCalls[0].mode, 'include');
    assert.equal(startCalls[0].hwnd, 77);

    // In 'process' mode, Chromium displayMedia must still refuse audioRequested: true
    let granted = null;
    sources.handleDisplayMedia({ frame: roomFrame, videoRequested: true, audioRequested: true, userGesture: true }, v => { granted = v; });
    assert.equal(granted, null);
    sources.handleDisplayMedia({ frame: roomFrame, videoRequested: true, audioRequested: false, userGesture: true }, v => { granted = v; });
    assert.deepEqual(Object.keys(granted), ['video']);

    // Screen share with audio -> mode 'exclude'
    const scrPick = await sources.pick('screen:0:0', 'auto', { audio: true });
    assert.equal(scrPick.audioMode, 'process');
    assert.equal(startCalls[1].mode, 'exclude');
    assert.equal(startCalls[1].hwnd, null);

    // Helper failure -> falls back to Chromium loopback with warning
    nextOk = false;
    const fbPick = await sources.pick('screen:0:0', 'auto', { audio: true });
    assert.equal(fbPick.audioMode, 'loopback');
    assert.equal(fbPick.audioWarning, LOOPBACK_FALLBACK_WARNING);
    sources.handleDisplayMedia({ frame: roomFrame, videoRequested: true, audioRequested: true, userGesture: true }, v => { granted = v; });
    assert.equal(granted.video, list[0]);
    assert.equal(granted.audio, 'loopback');

    // acceptScreenAudioFrame bounds
    assert.equal(acceptScreenAudioFrame(new Uint8Array(10), true), true);
    assert.equal(acceptScreenAudioFrame(new Uint8Array(10), false), false);
    assert.equal(acceptScreenAudioFrame(new Uint8Array(0), true), false);
    assert.equal(acceptScreenAudioFrame(new Uint8Array(4001), true), false);
});

test('listeningStore with screen audio defaults (maxVolume: 100, defaultVolume: 80)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'asscrack-screen-listen-'));
    try {
        const file = path.join(dir, 'screen-listening.json');
        const tag = listeningRoomTag('room-secret-key');
        const store = listeningStore(file, { maxVolume: 100, defaultVolume: 80 });
        assert.equal(store.get(tag, 'dev-1'), null);
        assert.equal(store.set(tag, 'dev-1', { muted: false, volume: 101 }), false, 'rejects > 100');
        assert.equal(store.set(tag, 'dev-1', { muted: true, volume: 45 }), true);
        assert.deepEqual(store.get(tag, 'dev-1'), { muted: true, volume: 45 });

        // Re-open from disk
        const store2 = listeningStore(file, { maxVolume: 100, defaultVolume: 80 });
        assert.deepEqual(store2.get(tag, 'dev-1'), { muted: true, volume: 45 });
        // Default choice removes entry
        assert.equal(store2.set(tag, 'dev-1', { muted: false, volume: 80 }), true);
        assert.equal(store2.get(tag, 'dev-1'), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('preload bridge exposes screen audio IPC channels cleanly', async () => {
    const source = await readFile(new URL('../src/application/preload.cjs', import.meta.url), 'utf8');
    const worlds = {};
    const invoked = [];
    const sent = [];
    const listeners = {};
    const electron = {
        contextBridge: { exposeInMainWorld: (name, api) => { worlds[name] = api; } },
        ipcRenderer: {
            invoke: (channel, ...args) => { invoked.push([channel, ...args]); return Promise.resolve(); },
            send: (channel, ...args) => sent.push([channel, ...args]),
            on: (channel, fn) => (listeners[channel] ??= []).push(fn)
        },
        webUtils: { getPathForFile: () => '' }
    };
    vm.runInNewContext(source, { require: () => electron, Promise, Error, Number, String, Uint8Array }, { filename: 'preload.cjs' });
    const api = worlds.asscrack;

    api.getScreenAudio();
    api.pickScreenSource('window:1:0', 'auto', { audio: true });
    api.startScreenShare({ preset: 'auto', width: 1280, height: 720, audio: true });
    api.watchScreenAudio('peer-1');
    api.getScreenListening('peer-1');
    api.setScreenListening('peer-1', true, 65);
    assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
        ['asscrack:screen-last-audio'],
        ['asscrack:screen-pick', 'window:1:0', 'auto', { border: false, audio: true }],
        ['asscrack:screen-start', { preset: 'auto', width: 1280, height: 720, audio: true }],
        ['asscrack:screen-audio-watch', 'peer-1'],
        ['asscrack:get-screen-listening', 'peer-1'],
        ['asscrack:set-screen-listening', 'peer-1', true, 65]
    ]);

    const buf = Uint8Array.of(1, 2, 3);
    api.sendScreenAudioFrame(buf);
    api.unwatchScreenAudio();
    assert.deepEqual(sent, [
        ['asscrack:screen-audio-frame', buf],
        ['asscrack:screen-audio-unwatch']
    ]);

    for (const [fn, ch] of [['onScreenAudioPcm', 'asscrack:screen-audio-pcm'],
        ['onScreenAudioFrame', 'asscrack:screen-audio-frame'],
        ['onScreenAudioEnded', 'asscrack:screen-audio-ended']]) {
        const got = [];
        api[fn](d => got.push(d));
        for (const l of listeners[ch] ?? []) l({}, { ok: ch });
        assert.deepEqual(got, [{ ok: ch }], fn);
    }
});

test('screen-audio UI: viewer loads per-sharer prefs, mutes/unmutes/deafens by closing and reopening audio stream', async () => {
    const SCRIPTS = ['screen-frame-check.js', 'screen-audio.js', 'screen-view.js'];
    const codes = await Promise.all(SCRIPTS.map(f => readFile(new URL(`../src/application/${f}`, import.meta.url), 'utf8')));
    const SHARE = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
    const LAYOUT = [
        { id: 'screen-banner', hidden: true, children: [{ id: 'screen-banner-text', tag: 'span' }, { id: 'screen-watch', tag: 'button' }] },
        { id: 'screen-notice', tag: 'p', hidden: true },
        { id: 'screen-stage', tag: 'section', hidden: true, children: [
            { id: 'screen-stage-title', tag: 'h2' }, { id: 'screen-stage-info', tag: 'span' },
            { id: 'screen-stage-note', tag: 'span', hidden: true }, { id: 'screen-switcher', tag: 'span', hidden: true },
            { id: 'screen-audio-controls', tag: 'span', hidden: true, children: [
                { id: 'screen-audio-mute', tag: 'button' },
                { id: 'screen-audio-volume', tag: 'input' },
                { id: 'screen-audio-pct', tag: 'span' }
            ] },
            { id: 'screen-fill', tag: 'button' }, { id: 'screen-unwatch', tag: 'button' }, { id: 'screen-canvas', tag: 'canvas' }
        ] }
    ];
    const { document, window, Event } = createDom(LAYOUT);
    const canvas = document.getElementById('screen-canvas');
    canvas.getContext = () => ({ drawImage() {}, clearRect() {} });
    const handlers = {};
    const audioCalls = [];
    const savedPrefs = new Map([['peer-A', { muted: false, volume: 65 }]]);
    let voiceDeafened = false;
    const voiceListeners = [];

    const api = {
        watchScreen: async () => ({ shareId: SHARE, width: 1280, height: 720, fps: 15 }),
        unwatchScreen: () => {},
        requestScreenKey: () => {},
        watchScreenAudio: async peerId => { audioCalls.push(['watch', peerId]); return { shareId: SHARE }; },
        unwatchScreenAudio: () => { audioCalls.push(['unwatch']); },
        getScreenListening: async peerId => savedPrefs.get(peerId) ?? null,
        setScreenListening: async (peerId, muted, volume) => {
            audioCalls.push(['save', peerId, muted, volume]);
            savedPrefs.set(peerId, { muted, volume });
            return true;
        },
        getScreenState: async () => ({ own: null, peers: {}, watching: null }),
        getIdlePeer: async () => ({ idle: false })
    };
    const bridge = new Proxy(api, {
        get(t, k) {
            if (k in t) return t[k];
            if (typeof k === 'string' && k.startsWith('on')) return fn => { (handlers[k] ??= []).push(fn); };
            return undefined;
        }
    });
    window.asscrack = bridge;
    window.voice = {
        state: () => ({ inVoice: false, deafened: voiceDeafened }),
        settings: () => ({ outputDeviceId: '' }),
        onChange: fn => voiceListeners.push(fn)
    };
    const ctx = vm.createContext({
        window, document, Event, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
        performance: { now: () => 1000 }, peerNames: new Map([['peer-A', 'Alice']]), peerItems: new Map(),
        Uint8Array, Float32Array, Map, Set, Promise, Math, Number, String, Boolean, Array, Object,
        VideoDecoder: class { configure() {} reset() {} close() {} get state() { return 'configured'; } }
    });
    for (let i = 0; i < SCRIPTS.length; i++) vm.runInContext(codes[i], ctx, { filename: SCRIPTS[i] });
    const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

    // Emit share with audio: true
    for (const fn of handlers.onScreenState ?? []) fn({ peerId: 'peer-A', sharing: true, shareId: SHARE, preset: 'standard', audio: true });
    await window.screenView.watch('peer-A');
    await flush();

    // Controls visible, saved volume 65% applied, audio stream opened even while NOT in voice
    assert.equal(document.getElementById('screen-audio-controls').hidden, false);
    assert.equal(document.getElementById('screen-audio-volume').value, '65');
    assert.equal(document.getElementById('screen-audio-pct').textContent, '65%');
    assert.deepEqual(audioCalls, [['watch', 'peer-A']]);

    // Clicking Mute saves pref and closes audio stream to save bandwidth
    document.getElementById('screen-audio-mute').dispatchEvent(new Event('click'));
    await flush();
    assert.deepEqual(audioCalls.slice(1), [['save', 'peer-A', true, 65], ['unwatch']]);
    assert.equal(document.getElementById('screen-audio-mute').textContent, 'Unmute');

    // Clicking Unmute saves pref and re-opens audio stream
    document.getElementById('screen-audio-mute').dispatchEvent(new Event('click'));
    await flush();
    assert.deepEqual(audioCalls.slice(3), [['save', 'peer-A', false, 65], ['watch', 'peer-A']]);

    // Deafen closes audio stream; undeafen re-opens it
    voiceDeafened = true;
    for (const fn of voiceListeners) fn();
    await flush();
    assert.equal(audioCalls.at(-1)[0], 'unwatch');
    assert.equal(document.getElementById('screen-audio-mute').disabled, true);

    voiceDeafened = false;
    for (const fn of voiceListeners) fn();
    await flush();
    assert.deepEqual(audioCalls.at(-1), ['watch', 'peer-A']);

    // Setting volume to 0 closes audio stream
    const volEl = document.getElementById('screen-audio-volume');
    volEl.value = '0';
    volEl.dispatchEvent(new Event('input'));
    await flush();
    assert.equal(audioCalls.at(-1)[0], 'unwatch');

    // Clean up waitTimer interval
    document.getElementById('screen-unwatch').dispatchEvent(new Event('click'));
});

async function meshRoom(t, count) {
    const room = `audio-fanout-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const roomKey = newRoomKey();
    const nodes = [];
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())));
    for (let i = 0; i < count; i++) {
        nodes.push(await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast }));
    }
    const localAddr = n => n.getMultiaddrs().find(m => m.startsWith('/ip4/127.0.0.1/') && !m.includes('p2p-circuit'));
    for (let i = 1; i < count; i++) {
        for (let j = 0; j < i; j++) await nodes[i].connect(localAddr(nodes[j]));
    }
    await waitUntil(() => nodes.every(n => nodes.every(m => m === n || n.peers().includes(m.peerId))), 20000);
    await waitUntil(() => {
        const topo = nodes[0].topology();
        return nodes.every(n => nodes.every(m => m === n || topo.kinds?.[n.peerId]?.[m.peerId] === 'mesh'));
    }, 10000);
    return nodes;
}

function fakeEncoder(node) {
    const tiers = new Map();
    node.events.on('screen-encoder', e => {
        for (const t of e.tiers) {
            const known = tiers.get(t.tier);
            if (!known || known.preset !== t.preset) {
                tiers.set(t.tier, { preset: t.preset, key: true });
                node.setScreenSize({ tier: t.tier, width: t.width, height: t.height });
            }
            if (t.keyFrame) tiers.get(t.tier).key = true;
        }
    });
    const start = Date.now();
    const timer = setInterval(() => {
        for (const [tier, s] of tiers) {
            const key = s.key;
            s.key = false;
            node.sendScreenFrame({ tier, key, timestampMs: Date.now() - start, data: Uint8Array.of(0x00, 0x01, 0x02, 0x03) });
        }
    }, 100);
    return { stop: () => clearInterval(timer) };
}

test('screen-audio limits: maxListeners is 24 and opensPerRoom supports 24-viewer fanout', () => {
    assert.equal(SCREEN_AUDIO_DEFAULTS.maxListeners, 24);
    assert.ok(SCREEN_AUDIO_DEFAULTS.opensPerRoom >= 192);
});

test('screen-audio fanout (127.0.0.1): routes through video parent and rejects non-child LISTEN', { timeout: 30000 }, async t => {
    const [A, B, C, D, E] = await meshRoom(t, 5);
    const enc = fakeEncoder(A);
    t.after(() => enc.stop());
    const { shareId } = A.startScreenShare({ preset: 'standard', width: 1280, height: 720, audio: true });
    await waitUntil(() => [B, C, D, E].every(n => n.screenState().peers[A.peerId]?.audio === true), 5000);

    await B.watchScreen(A.peerId);
    await C.watchScreen(A.peerId);
    await D.watchScreen(A.peerId);
    assert.equal(B.screenStats().watching.parentPeerId, A.peerId);
    assert.equal(C.screenStats().watching.parentPeerId, B.peerId);
    assert.equal(D.screenStats().watching.parentPeerId, B.peerId);

    await B.watchScreenAudio(A.peerId);
    await C.watchScreenAudio(A.peerId);
    await D.watchScreenAudio(A.peerId);

    await waitUntil(() =>
        A.screenAudioStats().listeners.length === 1 &&
        B.screenAudioStats().forwardedListeners.length === 2, 5000);

    assert.deepEqual(A.screenAudioStats().listeners, [B.peerId]);
    assert.equal(C.screenAudioStats().watching.parentPeerId, B.peerId);
    assert.equal(D.screenAudioStats().watching.parentPeerId, B.peerId);
    assert.deepEqual(new Set(B.screenAudioStats().forwardedListeners), new Set([C.peerId, D.peerId]));

    // Non-child E attempting to open screen-audio LISTEN directly to B is refused.
    const connEB = E.libp2p.getConnections().find(c => c.remotePeer.toString() === B.peerId);
    const badStream = await connEB.newStream(SCREEN_AUDIO_PROTOCOL, { runOnTransientConnection: true });
    const badRecords = [];
    const doneBad = readRecords(badStream.source, (type, body) => badRecords.push({ type, code: body[0] }), 256).catch(() => {});
    badStream.send(record(SCREEN_AUDIO_TYPE.LISTEN, Buffer.from(JSON.stringify({ v: 1, shareId }))));
    await waitUntil(() => badRecords.length > 0, 5000);
    await doneBad;
    assert.equal(badRecords[0].type, SCREEN_AUDIO_TYPE.END);
    assert.equal(badRecords[0].code, SCREEN_END.refused);

    // Sharer sends an Opus frame; B, C, and D all receive it with sharer peerId and exact bytes.
    const opusBytes = Uint8Array.of(0xf8, 0xaa, 0xbb, 0xcc);
    const pB = waitFor(B.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId);
    const pC = waitFor(C.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId);
    const pD = waitFor(D.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId);
    assert.equal(A.sendScreenAudioFrame(opusBytes), true);
    const [fB, fC, fD] = await Promise.all([pB, pC, pD]);
    for (const f of [fB, fC, fD]) {
        assert.equal(f.seq, 1);
        assert.deepEqual([...f.data], [...opusBytes]);
    }
});

test('screen-audio parent mute rule (127.0.0.1): keeps upstream open for active child, closes when idle, opens on demand', { timeout: 30000 }, async t => {
    const [A, B, C] = await meshRoom(t, 3);
    const enc = fakeEncoder(A);
    t.after(() => enc.stop());
    const { shareId } = A.startScreenShare({ preset: 'standard', width: 1280, height: 720, audio: true });
    await waitUntil(() => [B, C].every(n => n.screenState().peers[A.peerId]?.audio === true), 5000);

    await B.watchScreen(A.peerId);
    await C.watchScreen(A.peerId);
    assert.equal(C.screenStats().watching.parentPeerId, B.peerId);

    await B.watchScreenAudio(A.peerId);
    await C.watchScreenAudio(A.peerId);
    await waitUntil(() => B.screenAudioStats().forwardedListeners.includes(C.peerId), 5000);

    // 1. Parent B mutes locally while child C is listening: upstream to A stays open, B suppresses local playback.
    let bFrames = 0;
    B.events.on('screen-audio-frame', () => { bFrames++; });
    assert.equal(B.unwatchScreenAudio(), true);
    assert.equal(B.screenAudioStats().watching.localListening, false);
    assert.deepEqual(A.screenAudioStats().listeners, [B.peerId]);

    const cFrame1 = waitFor(C.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId);
    assert.equal(A.sendScreenAudioFrame(Uint8Array.of(0xf8, 0x11, 0x22)), true);
    const got1 = await cFrame1;
    assert.deepEqual([...got1.data], [0xf8, 0x11, 0x22]);
    assert.equal(bFrames, 0, 'muted parent B suppresses local screen-audio-frame');

    // 2. Last audio child C mutes: B closes upstream audio stream to A.
    assert.equal(C.unwatchScreenAudio(), true);
    await waitUntil(() => A.screenAudioStats().listeners.length === 0 && B.screenAudioStats().watching === null, 5000);

    // 3. While B is still muted, C unmutes: B opens upstream audio on demand and forwards to C without local playback.
    await C.watchScreenAudio(A.peerId);
    await waitUntil(() =>
        A.screenAudioStats().listeners.includes(B.peerId) &&
        B.screenAudioStats().watching?.localListening === false &&
        B.screenAudioStats().forwardedListeners.includes(C.peerId), 5000);

    const cFrame2 = waitFor(C.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId);
    assert.equal(A.sendScreenAudioFrame(Uint8Array.of(0xf8, 0x33, 0x44)), true);
    const got2 = await cFrame2;
    assert.deepEqual([...got2.data], [0xf8, 0x33, 0x44]);
    assert.equal(bFrames, 0, 'on-demand forwarder B still suppresses local playback while muted');

    // 4. B unmutes: reuses existing upstream stream and receives local frames again.
    await B.watchScreenAudio(A.peerId);
    assert.equal(B.screenAudioStats().watching.localListening, true);
    const bFrame3 = waitFor(B.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId);
    const cFrame3 = waitFor(C.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId);
    assert.equal(A.sendScreenAudioFrame(Uint8Array.of(0xf8, 0x55, 0x66)), true);
    await Promise.all([bFrame3, cFrame3]);
});

test('screen-audio parent-disconnect failover (127.0.0.1): children reparent audio without screen-audio-ended', { timeout: 30000 }, async t => {
    const [A, B, C, D] = await meshRoom(t, 4);
    const enc = fakeEncoder(A);
    t.after(() => enc.stop());
    const { shareId } = A.startScreenShare({ preset: 'standard', width: 1280, height: 720, audio: true });
    await waitUntil(() => [B, C, D].every(n => n.screenState().peers[A.peerId]?.audio === true), 5000);

    await B.watchScreen(A.peerId);
    await C.watchScreen(A.peerId);
    await D.watchScreen(A.peerId);
    assert.equal(C.screenStats().watching.parentPeerId, B.peerId);
    assert.equal(D.screenStats().watching.parentPeerId, B.peerId);

    await B.watchScreenAudio(A.peerId);
    await C.watchScreenAudio(A.peerId);
    await D.watchScreenAudio(A.peerId);
    await waitUntil(() => B.screenAudioStats().forwardedListeners.length === 2, 5000);

    const cEnded = [];
    const dEnded = [];
    C.events.on('screen-audio-ended', e => cEnded.push(e));
    D.events.on('screen-audio-ended', e => dEnded.push(e));

    const pC1 = waitFor(C.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId);
    const pD1 = waitFor(D.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId);
    assert.equal(A.sendScreenAudioFrame(Uint8Array.of(0xf8, 0x01)), true);
    await Promise.all([pC1, pD1]);

    // Disconnect parent B mid-stream.
    await B.stop();

    await waitUntil(() =>
        C.screenStats().watching?.parentPeerId !== B.peerId &&
        D.screenStats().watching?.parentPeerId !== B.peerId &&
        C.screenAudioStats().watching?.parentPeerId === C.screenStats().watching?.parentPeerId &&
        D.screenAudioStats().watching?.parentPeerId === D.screenStats().watching?.parentPeerId &&
        A.screenAudioStats().listeners.length >= 1, 15000);

    assert.equal(cEnded.length, 0, 'C did not emit screen-audio-ended on parent disconnect');
    assert.equal(dEnded.length, 0, 'D did not emit screen-audio-ended on parent disconnect');

    const pC2 = waitFor(C.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId && f.seq >= 2);
    const pD2 = waitFor(D.events, 'screen-audio-frame', f => f.peerId === A.peerId && f.shareId === shareId && f.seq >= 2);
    assert.equal(A.sendScreenAudioFrame(Uint8Array.of(0xf8, 0x02, 0x03)), true);
    const [fC2, fD2] = await Promise.all([pC2, pD2]);
    assert.deepEqual([...fC2.data], [0xf8, 0x02, 0x03]);
    assert.deepEqual([...fD2.data], [0xf8, 0x02, 0x03]);
});
