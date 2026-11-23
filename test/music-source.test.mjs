// Room music: the YouTube source (music-source.mjs) with a fake youtubei.js module, the sandbox of the player script
// (music-eval.mjs) with fake Electron objects, and the IPC of the music bar (music-ipc.mjs). No network: no request
// goes to YouTube.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createYouTubeSource, YOUTUBE_CLIENTS } from '../src/application/music-source.mjs';
import { createMusicEval } from '../src/application/music-eval.mjs';
import { attachMusic } from '../src/application/music-ipc.mjs';

const V1 = 'dQw4w9WgXcQ';

// A fake youtubei.js module. statusOf(video, client) gives the playability status. Each call and its arguments go
// into calls.
function fakeLibrary({ statusOf = () => 'OK', decipherCalls = [], playlist = null, createFails = false } = {}) {
    const calls = [];
    const lib = {
        Log: { Level: { NONE: 0 }, setLevel: level => calls.push(['setLevel', level]) },
        Platform: { shim: { eval: () => { throw new Error('no evaluator'); } } },
        Constants: { CLIENTS: { ANDROID_VR: { USER_AGENT: 'VR-UA' } } },
        Innertube: {
            async create(options) {
                calls.push(['create', Object.keys(options).sort()]);
                if (createFails) throw new Error('parser broke');
                return {
                    session: { player: { id: 'player' } },
                    async getBasicInfo(video, options) {
                        calls.push(['getBasicInfo', video, options.client]);
                        return {
                            playability_status: { status: statusOf(video, options.client) },
                            basic_info: { title: `Title of ${video}`, duration: 212 },
                            chooseFormat(opts) {
                                calls.push(['chooseFormat', opts.type, opts.format]);
                                return { mime_type: 'audio/webm; codecs="opus"', content_length: 3400000,
                                    async decipher(player) {
                                        decipherCalls.push(player);
                                        // The library calls the evaluator of the platform for the n parameter.
                                        const result = await lib.Platform.shim.eval({ output: 'return process("abc")' }, { n: 'abc' });
                                        return `https://rr1---sn-x.googlevideo.com/videoplayback?id=${video}&n=${result.n}&c=${options.client}`;
                                    } };
                            }
                        };
                    },
                    async getPlaylist(id) {
                        calls.push(['getPlaylist', id]);
                        if (!playlist) throw new Error('This playlist does not exist');
                        return { items: playlist };
                    }
                };
            }
        }
    };
    return { lib, calls };
}

test('YouTube source: only the ID goes to the library; the evaluator is the sandbox; a refused client tries the next one', async () => {
    const { lib, calls } = fakeLibrary({ statusOf: (video, client) => (client === 'ANDROID_VR' ? 'LOGIN_REQUIRED' : 'OK') });
    const evaluated = [];
    const probes = [];
    const source = createYouTubeSource({
        load: async () => lib,
        evaluate: async code => { evaluated.push(code); return { n: 'xyz' }; },
        fetch: async (url, init) => { probes.push([url, init.headers['user-agent']]); return new Response(new Uint8Array(1024), { status: 206 }); }
    });
    assert.deepEqual(await source.describe({ video: V1 }), [{ video: V1, title: `Title of ${V1}`, dur: 212 }]);
    const stream = await source.stream(V1);
    assert.equal(stream.client, 'WEB_EMBEDDED');
    assert.match(stream.url, /^https:\/\/rr1---sn-x\.googlevideo\.com\/videoplayback\?id=dQw4w9WgXcQ&n=xyz/);
    assert.equal(stream.size, 3400000);
    assert.deepEqual(evaluated, ['return process("abc")'], 'the player code went to the sandbox evaluator');
    assert.equal(probes.length, 1);
    assert.match(probes[0][0], /&range=0-1023$/);
    // No room data: each argument of the library is an ID, a client name or an option of the source.
    const args = calls.flatMap(c => c.slice(1)).flat().filter(v => typeof v === 'string');
    for (const value of args) assert.ok([V1, ...YOUTUBE_CLIENTS, 'audio', 'webm', 'fetch', 'retrieve_player'].includes(value), `argument ${value}`);
    assert.ok(calls.some(c => c[0] === 'setLevel' && c[1] === 0), 'the log of the library is off');
    await assert.rejects(source.stream('not-an-id'), err => err.kind === 'refused');
});

test('YouTube source: a refused video, a broken library and a playlist with a cap of 50 and bad IDs', async () => {
    const refused = createYouTubeSource({ load: async () => fakeLibrary({ statusOf: () => 'UNPLAYABLE' }).lib, evaluate: async () => ({}) });
    await assert.rejects(refused.describe({ video: V1 }), err => err.kind === 'refused');
    await assert.rejects(refused.stream(V1), err => err.kind === 'refused');
    const broken = createYouTubeSource({ load: async () => fakeLibrary({ createFails: true }).lib, evaluate: async () => ({}) });
    await assert.rejects(broken.describe({ video: V1 }), err => err.kind === 'unavailable' && /YouTube source unavailable/.test(err.message));
    const missing = createYouTubeSource({ load: async () => { throw new Error('Cannot find module'); }, evaluate: async () => ({}) });
    await assert.rejects(missing.stream(V1), err => err.kind === 'unavailable');
    const items = [{ id: 'bad id', title: { text: 'x' } }, { id: V1, title: { text: 'off' }, is_playable: false },
        ...Array.from({ length: 70 }, (_, i) => ({ id: `v${String(i).padStart(10, '0')}`, title: { text: `T${i}` }, duration: { seconds: i } }))];
    const list = createYouTubeSource({ load: async () => fakeLibrary({ playlist: items }).lib, evaluate: async () => ({}) });
    const out = await list.describe({ list: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG' });
    assert.equal(out.length, 50);
    assert.deepEqual(out[0], { video: 'v0000000000', title: 'T0', dur: 0 });
    const noList = createYouTubeSource({ load: async () => fakeLibrary().lib, evaluate: async () => ({}) });
    await assert.rejects(noList.describe({ list: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG' }), err => err.kind === 'refused');
    await assert.rejects(noList.describe({ list: 'RDxyz' }), err => err.kind === 'refused');
});

function fakeElectron() {
    const ipc = new EventEmitter();
    const windows = [];
    class Win extends EventEmitter {
        constructor(options) {
            super(); this.options = options; this.destroyed = false; windows.push(this);
            this.webContents = Object.assign(new EventEmitter(), { sent: [], send: (...args) => this.webContents.sent.push(args) });
        }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; this.emit('closed'); }
        async loadURL(url) { this.url = url; }
    }
    return { ipc, windows, Win };
}

test('player script sandbox: a sandboxed window, a result only from its frame, only string fields, a timeout closes it', async () => {
    const { ipc, windows, Win } = fakeElectron();
    const timers = [];
    const sandbox = createMusicEval({ BrowserWindow: Win, ipc, page: 'asscrack-app://app/music-eval.html', preload: 'p.cjs',
        isFrame: (win, event) => event.sender === win.webContents,
        setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {} });
    const first = sandbox.run('return process("a")');
    await new Promise(r => setImmediate(r));
    const win = windows[0];
    assert.equal(win.options.webPreferences.sandbox, true);
    assert.equal(win.options.webPreferences.nodeIntegration, false);
    assert.equal(win.options.show, false);
    assert.equal(win.url, 'asscrack-app://app/music-eval.html');
    const [channel, id, code] = win.webContents.sent[0];
    assert.equal(channel, 'asscrack:music-eval');
    assert.equal(code, 'return process("a")');
    // Another sender is ignored.
    ipc.emit('asscrack:music-evaluated', { sender: {} }, id, '{"n":"evil"}');
    ipc.emit('asscrack:music-evaluated', { sender: win.webContents }, id, '{"n":"ok","sig":"s","x":{"a":1}}');
    assert.deepEqual(await first, { n: 'ok', sig: 's' });
    const second = sandbox.run('x');
    await new Promise(r => setImmediate(r));
    ipc.emit('asscrack:music-evaluated', { sender: win.webContents }, win.webContents.sent[1][1], '{"n":{"toString":1}}');
    assert.equal(await second, null, 'a field that is not a string');
    const third = sandbox.run('while(true){}');
    await new Promise(r => setImmediate(r));
    timers.filter(t => t.ms === 5000).at(-1).fn();
    assert.equal(await third, null);
    assert.equal(win.destroyed, true, 'a timeout closes the window');
    assert.equal(await sandbox.run(''), null);
    assert.equal(await sandbox.run('x'.repeat(4 * 1024 * 1024 + 1)), null);
});

test('music IPC: a link gives only an ID to the node; files only from the own pick with the path rules', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'music-ipc-'));
    try {
        const song = path.join(dir, 'My Song.mp3');
        await writeFile(song, Buffer.alloc(100));
        const handlers = new Map();
        const adds = [];
        const locals = [];
        let playing = null;
        const fakeNode = { music: {
            add: async request => { adds.push(request); return { ok: true, sent: true }; },
            addLocal: items => { locals.push(...items); playing = { id: '00000000000000aa', src: 'file', local: items[0].local }; return { ok: true, count: items.length }; },
            playing: () => playing, state: () => ({}), failed: () => {}, ended: () => {}
        } };
        const blocked = path.join(dir, 'private');
        const music = attachMusic({
            handle: (channel, fn) => handlers.set(channel, fn), on: (channel, fn) => handlers.set(channel, fn),
            getNode: () => fakeNode, dialog: { showOpenDialog: async () => { throw new Error('no dialog in this test'); } },
            chosenFile: file => { if (file.startsWith(blocked)) throw new Error('private'); return file; },
            settingsFile: () => path.join(dir, 'music-settings.json'), pick: [song, path.join(blocked, 'x.mp3'), path.join(dir, 'x.txt')],
            evaluate: async () => null, loadYouTube: async () => { throw new Error('no YouTube in this test'); }
        });
        const call = (channel, ...args) => handlers.get(channel)({}, ...args);
        assert.deepEqual(await call('asscrack:music-add', 'https://evil.example/watch?v=' + V1), { ok: false, kind: 'link' });
        assert.deepEqual(await call('asscrack:music-add', 'https://www.youtube.com/watch?list=RDabc'), { ok: false, kind: 'mix' });
        await call('asscrack:music-add', `https://youtu.be/${V1}?si=tracking`);
        assert.deepEqual(adds, [{ video: V1 }], 'only the video ID goes to the node');
        assert.deepEqual(await call('asscrack:music-add-files'), { ok: true, count: 1 }, 'the blocked and the non-audio file are left out');
        assert.equal(locals[0].title, 'My Song');
        assert.ok(!locals[0].local.includes(dir), 'the node gets a key, not the path');
        const opened = await call('asscrack:music-open', '00000000000000aa');
        assert.match(opened.url, /^asscrack-music:\/\/track\//);
        const res = await music.serve(new Request(opened.url));
        assert.equal(res.status, 200);
        assert.equal((await res.arrayBuffer()).byteLength, 100);
        assert.deepEqual(await call('asscrack:music-open', '00000000000000bb'), { error: 'error' }, 'only the current item');
        music.reset();
        assert.equal((await music.serve(new Request(opened.url))).status, 404, 'Leave room revokes the URL');
        assert.deepEqual(await call('asscrack:set-music-settings', { volume: 33, folder: 'C:\\Windows' }), { volume: 33, ducking: true });
        assert.deepEqual(await call('asscrack:music-folder'), { folder: '', files: [] }, 'the window did not set a folder');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
