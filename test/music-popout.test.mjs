// Room music: the player in its own window (src/application/music-popout.mjs, music-window-preload.cjs) and the
// settings of the visualizer and the layout (music-settings.mjs, music-ipc.mjs). Fake Electron objects; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const app = name => new URL(`../src/application/${name}`, import.meta.url);
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

function fakeElectron() {
    const created = [];
    class Window extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.sent = [];
            this.destroyed = false;
            this.webContents = Object.assign(new EventEmitter(), {
                mainFrame: { url: '' }, isDestroyed: () => this.destroyed, send: (...args) => this.sent.push(args),
                setWindowOpenHandler() {}
            });
            created.push(this);
        }
        isDestroyed() { return this.destroyed; }
        isMinimized() { return false; }
        isMaximized() { return false; }
        show() { this.shown = true; }
        focus() { this.focused = (this.focused ?? 0) + 1; }
        removeMenu() {}
        async loadURL(url) { this.webContents.mainFrame.url = url; this.emit('ready-to-show'); }
        getNormalBounds() { return { x: 50, y: 70, width: 444, height: 555 }; }
        close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
    }
    const handlers = {};
    const listeners = {};
    const ipc = {
        handle: (channel, fn) => { assert.equal(handlers[channel], undefined, channel); handlers[channel] = fn; },
        on: (channel, fn) => { listeners[channel] = fn; }
    };
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const screen = { getDisplayMatching: () => ({ workArea: area }), getPrimaryDisplay: () => ({ workArea: area }) };
    return { Window, created, handlers, listeners, ipc, screen };
}

test('the music window: one window, own checked channels, the controls of the room, saved bounds, remembered state', async t => {
    const { attachMusicPopout, MUSIC_WINDOW_FILE, WINDOW_CHANNELS } = await import('../src/application/music-popout.mjs');
    const profile = mkdtempSync(path.join(tmpdir(), 'ac-music-window-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const { Window, created, handlers, listeners, ipc, screen } = fakeElectron();
    const calls = [];
    const controls = new Map(Object.keys(WINDOW_CHANNELS).map(channel => [channel, (event, ...args) => {
        calls.push([channel, ...args]);
        return channel === 'asscrack:music-state' ? { inVoice: true, dj: 'p1', queue: [] } : { ok: true };
    }]));
    const remembered = [];
    const states = [];
    let pulls = 0;
    const popout = attachMusicPopout({ BrowserWindow: Window, ipc, screen, profile, assets: profile, controls,
        names: () => ({ p1: 'Ann' }), remember: on => remembered.push(on), onState: s => states.push(s.open),
        pull: () => { pulls++; }, warn: assert.fail });
    assert.deepEqual(Object.keys(handlers).sort(), Object.values(WINDOW_CHANNELS).sort());
    assert.ok(Object.values(WINDOW_CHANNELS).every(c => c.startsWith('asscrack:music-window-')));

    // A first open: the default size in the middle of the display, the own preload, the sandbox.
    assert.equal(popout.isOpen(), false);
    assert.equal(popout.open(), true);
    await settle();
    assert.equal(created.length, 1);
    const win = created[0];
    assert.equal(win.webContents.mainFrame.url, 'asscrack-app://app/music-window.html');
    assert.deepEqual([win.options.width, win.options.height, win.options.x, win.options.y], [420, 560, 750, 240]);
    assert.equal(path.basename(win.options.webPreferences.preload), 'music-window-preload.cjs');
    assert.equal(win.options.webPreferences.sandbox, true);
    assert.equal(win.options.webPreferences.contextIsolation, true);
    assert.equal(win.options.webPreferences.nodeIntegration, false);
    assert.equal(win.shown, true);
    assert.deepEqual([remembered, states], [[true], [true]]);
    // One window at most: a second open focuses it.
    assert.equal(popout.open(), true);
    assert.equal(created.length, 1);
    assert.equal(win.focused, 1);

    // The channels accept only the main frame of this window.
    const from = w => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame });
    const stranger = new Window({});
    stranger.webContents.mainFrame.url = 'asscrack-app://app/index.html';
    await assert.rejects(handlers['asscrack:music-window-skip'](from(stranger)), /Unknown music window/);
    listeners['asscrack:music-window-viz-pull'](from(stranger));
    assert.equal(pulls, 0);
    assert.deepEqual(calls, []);
    // The same functions as the room window; the state has the names of the room.
    assert.deepEqual(await handlers['asscrack:music-window-state'](from(win)), { inVoice: true, dj: 'p1', queue: [], names: { p1: 'Ann' } });
    await handlers['asscrack:music-window-pause'](from(win), true);
    await handlers['asscrack:music-window-set-settings'](from(win), { visualizer: 'vu' });
    assert.deepEqual(calls.slice(1), [['asscrack:music-pause', true], ['asscrack:set-music-settings', { visualizer: 'vu' }]]);
    listeners['asscrack:music-window-viz-pull'](from(win));
    assert.equal(pulls, 1);

    // The live data: the view (with names), the notices, the settings, the frames (18 bytes, else null).
    popout.view({ inVoice: true, dj: 'p1', queue: [] });
    popout.notice({ kind: 'full' });
    popout.settings({ visualizer: 'off' });
    popout.viz(new Uint8Array(18).fill(7));
    popout.viz(new Uint8Array(500));
    popout.viz('text');
    assert.deepEqual(win.sent.map(([channel]) => channel), ['asscrack:music-window-view', 'asscrack:music-window-notice',
        'asscrack:music-window-settings-changed', 'asscrack:music-window-viz', 'asscrack:music-window-viz', 'asscrack:music-window-viz']);
    assert.deepEqual(win.sent[0][1].names, { p1: 'Ann' });
    assert.equal(win.sent[3][1].length, 18);
    assert.deepEqual([win.sent[4][1], win.sent[5][1]], [null, null]);

    // The app closes it (Leave room, Quit): the bounds are saved, the setting stays.
    popout.close();
    assert.equal(popout.isOpen(), false);
    assert.deepEqual(JSON.parse(readFileSync(path.join(profile, MUSIC_WINDOW_FILE), 'utf8')),
        { x: 50, y: 70, width: 444, height: 555, maximized: false });
    assert.deepEqual([remembered, states], [[true], [true, false]]);
    popout.view({ inVoice: false });
    assert.equal(win.sent.length, 6, 'nothing to a closed window');

    // The next open uses the saved bounds; a close by the user (the window or Pop in) clears the setting.
    popout.open();
    await settle();
    const second = created.at(-1);
    assert.deepEqual([second.options.x, second.options.y, second.options.width, second.options.height], [50, 70, 444, 555]);
    second.close();
    assert.deepEqual(remembered, [true, true, false]);
    popout.open();
    await settle();
    popout.closeByUser();
    assert.deepEqual(remembered, [true, true, false, true, false]);
    assert.equal(popout.isOpen(), false);
});

test('the music window bridge: own channels, text and strict values', async () => {
    const source = await readFile(app('music-window-preload.cjs'), 'utf8');
    const worlds = {}, invoked = [], sent = [], listeners = {};
    const electron = { contextBridge: { exposeInMainWorld: (name, api) => { worlds[name] = api; } },
        ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve(null); }, send: (...args) => sent.push(args),
            on: (channel, fn) => { listeners[channel] = fn; } } };
    vm.runInNewContext(source, { require: name => { assert.equal(name, 'electron'); return electron; }, Promise, String, Number });
    assert.deepEqual(Object.keys(worlds), ['asscrack']);
    const a = worlds.asscrack;
    a.musicAdd(null); a.musicPause('yes'); a.musicPause(true); a.musicMove(7, '2'); a.musicRemove({ toString: () => 'i1' });
    a.musicVizPull();
    assert.deepEqual(invoked, [['asscrack:music-window-add', ''], ['asscrack:music-window-pause', false],
        ['asscrack:music-window-pause', true], ['asscrack:music-window-move', '7', 2], ['asscrack:music-window-remove', 'i1']]);
    assert.deepEqual(sent, [['asscrack:music-window-viz-pull']]);
    const got = [];
    a.onMusicViz(data => got.push(data));
    listeners['asscrack:music-window-viz']({}, null);
    assert.deepEqual(got, [null]);
    assert.ok(invoked.every(([channel]) => channel.startsWith('asscrack:music-window-')));
    assert.equal(a.musicOpen, undefined, 'no track URL in this window');
    assert.equal(a.sendMusicFrame, undefined, 'no music frames from this window');
});

test('the settings: the visualizer and the layout of this PC, bad values, the popout field only from the main process', async t => {
    const settings = await import('../src/application/music-settings.mjs');
    const dir = mkdtempSync(path.join(tmpdir(), 'ac-music-settings-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'music-settings.json');
    assert.deepEqual(settings.load(file), { volume: 60, ducking: true, folder: '', visualizer: 'spectrum', collapsed: false,
        hidden: false, popout: false });
    writeFileSync(file, JSON.stringify({ visualizer: 'disco', collapsed: 'yes', hidden: 1, popout: null }));
    assert.deepEqual(settings.load(file), settings.normalize(null), 'bad values give the defaults');
    const merged = settings.merge(settings.normalize(null), { visualizer: 'vu', collapsed: true, hidden: true, popout: true, folder: 'C:\\x' });
    assert.deepEqual([merged.visualizer, merged.collapsed, merged.hidden, merged.popout, merged.folder], ['vu', true, true, false, ''],
        'a window cannot set popout or the folder');
    assert.equal(settings.merge(merged, { visualizer: 'loud' }).visualizer, 'vu', 'a bad change keeps the value');
    assert.equal(settings.merge(merged, { popout: true }, ['popout']).popout, true, 'the main process sets popout');
    assert.deepEqual(Object.keys(settings.windowView({ folder: 'C:\\Music' })).sort(),
        ['collapsed', 'ducking', 'hidden', 'popout', 'visualizer', 'volume'], 'no folder path to a window');

    // music-ipc.mjs: the room channels, the change event for the windows, the popout of the main process.
    const { attachMusic } = await import('../src/application/music-ipc.mjs');
    const handlers = new Map();
    const pushed = [];
    const music = attachMusic({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {}, getNode: () => null,
        dialog: {}, chosenFile: f => f, settingsFile: () => file, evaluate: async () => null, onSettings: v => pushed.push(v),
        loadYouTube: async () => { throw new Error('no YouTube in this test'); } });
    assert.deepEqual(await handlers.get('asscrack:set-music-settings')({}, { visualizer: 'off', collapsed: true, popout: true }),
        { volume: 60, ducking: true, visualizer: 'off', collapsed: true, hidden: false, popout: false });
    assert.equal(pushed.length, 1);
    assert.equal(music.setPopout(true).popout, true);
    assert.equal(pushed.at(-1).popout, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).popout, true, 'saved for the next start');
    assert.equal(music.settings().visualizer, 'off');
    assert.ok(music.controls.has('asscrack:music-skip') && !music.controls.has('asscrack:music-open'),
        'the window controls, not the track URL of the DJ');
});
