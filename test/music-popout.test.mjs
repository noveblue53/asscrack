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
            this.bounds = {
                x: options.x ?? 0,
                y: options.y ?? 0,
                width: options.width ?? 420,
                height: options.height ?? 560
            };
            this.minSize = [options.minWidth ?? 0, options.minHeight ?? 0];
            this.maxSize = [options.maxWidth ?? 0, options.maxHeight ?? 0];
            this.maximizable = options.maximizable !== false;
            this.alwaysOnTop = options.alwaysOnTop === true;
            this.maximized = false;
            this.minimized = false;
            this.sent = [];
            this.destroyed = false;
            this.webContents = Object.assign(new EventEmitter(), {
                mainFrame: { url: '' }, isDestroyed: () => this.destroyed, send: (...args) => this.sent.push(args),
                setWindowOpenHandler() {}
            });
            created.push(this);
        }
        isDestroyed() { return this.destroyed; }
        isMinimized() { return this.minimized; }
        isMaximized() { return this.maximized; }
        show() { this.shown = true; }
        focus() { this.focused = (this.focused ?? 0) + 1; }
        minimize() { this.minimized = true; }
        maximize() { this.maximized = true; }
        unmaximize() { this.maximized = false; }
        setAlwaysOnTop(flag) { this.alwaysOnTop = Boolean(flag); }
        setMinimumSize(w, h) { this.minSize = [w, h]; }
        setMaximumSize(w, h) { this.maxSize = [w, h]; }
        setMaximizable(flag) { this.maximizable = Boolean(flag); }
        setBounds(b) { this.bounds = { ...this.bounds, ...b }; }
        removeMenu() {}
        async loadURL(url) { this.webContents.mainFrame.url = url; this.emit('ready-to-show'); }
        getNormalBounds() { return { ...this.bounds }; }
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
    const { attachMusicPopout, MUSIC_WINDOW_FILE, WINDOW_CHANNELS, POPOUT_CHANNELS } = await import('../src/application/music-popout.mjs');
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
    assert.deepEqual(Object.keys(handlers).sort(), [...Object.values(WINDOW_CHANNELS), ...Object.values(POPOUT_CHANNELS)].sort());
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
    win.setBounds({ x: 50, y: 70, width: 444, height: 555 });
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

test('music popout shade mode and always-on-top pin: bounds separation, persistence across reopens, and window actions', async t => {
    const { attachMusicPopout, MUSIC_WINDOW_FILE, MUSIC_WINDOW_STATE_FILE, MUSIC_SHADE_HEIGHT, MUSIC_SHADE_MIN_WIDTH,
        MUSIC_WINDOW_MIN, WINDOW_CHANNELS, POPOUT_CHANNELS } = await import('../src/application/music-popout.mjs');
    const profile = mkdtempSync(path.join(tmpdir(), 'ac-music-shade-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const { Window, created, handlers, ipc, screen } = fakeElectron();
    const controls = new Map(Object.keys(WINDOW_CHANNELS).map(channel => [channel, () => ({ ok: true })]));
    const popout = attachMusicPopout({ BrowserWindow: Window, ipc, screen, profile, assets: profile, controls, warn: assert.fail });

    popout.open();
    await settle();
    const win = created[0];
    assert.equal(win.options.frame, false, 'frameless custom titlebar');
    assert.equal(win.options.alwaysOnTop, false);

    const from = w => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame });
    const stranger = new Window({});
    stranger.webContents.mainFrame.url = 'asscrack-app://app/index.html';
    await assert.rejects(handlers[POPOUT_CHANNELS.state](from(stranger)), /Unknown music window/);
    await assert.rejects(handlers[POPOUT_CHANNELS.setState](from(stranger), { shaded: true }), /Unknown music window/);
    await assert.rejects(handlers[POPOUT_CHANNELS.action](from(stranger), 'close'), /Unknown music window/);

    assert.deepEqual(await handlers[POPOUT_CHANNELS.state](from(win)), { shaded: false, pinned: false });

    // Move full window to custom bounds, then toggle pin and shade mode.
    win.setBounds({ x: 120, y: 140, width: 460, height: 580 });
    const pinnedState = await handlers[POPOUT_CHANNELS.setState](from(win), { pinned: true });
    assert.deepEqual(pinnedState, { shaded: false, pinned: true });
    assert.equal(win.alwaysOnTop, true);

    const shadedState = await handlers[POPOUT_CHANNELS.setState](from(win), { shaded: true });
    assert.deepEqual(shadedState, { shaded: true, pinned: true });
    assert.equal(win.bounds.height, MUSIC_SHADE_HEIGHT);
    assert.ok(win.bounds.width >= MUSIC_SHADE_MIN_WIDTH);
    assert.deepEqual(win.minSize, [MUSIC_SHADE_MIN_WIDTH, MUSIC_SHADE_HEIGHT]);
    assert.deepEqual(win.maxSize, [16384, MUSIC_SHADE_HEIGHT]);
    assert.equal(win.maximizable, false);

    // Full bounds in music-window.json remain untouched while shaded.
    assert.deepEqual(JSON.parse(readFileSync(path.join(profile, MUSIC_WINDOW_FILE), 'utf8')),
        { x: 120, y: 140, width: 460, height: 580, maximized: false });

    // Move/resize shade bar and close while shaded; reopen starts directly in shade mode + pinned.
    win.setBounds({ x: 300, y: 40, width: 520, height: MUSIC_SHADE_HEIGHT });
    await handlers[POPOUT_CHANNELS.action](from(win), 'minimize');
    assert.equal(win.minimized, true);
    popout.close();

    const savedState = JSON.parse(readFileSync(path.join(profile, MUSIC_WINDOW_STATE_FILE), 'utf8'));
    assert.equal(savedState.shaded, true);
    assert.equal(savedState.pinned, true);
    assert.deepEqual(savedState.shadeBounds, { x: 300, y: 40, width: 520, height: MUSIC_SHADE_HEIGHT });

    popout.open();
    await settle();
    const reopened = created.at(-1);
    assert.equal(reopened.options.alwaysOnTop, true);
    assert.equal(reopened.options.height, MUSIC_SHADE_HEIGHT);
    assert.equal(reopened.options.width, 520);
    assert.equal(reopened.options.x, 300);
    assert.equal(reopened.options.y, 40);
    assert.equal(reopened.options.maxHeight, MUSIC_SHADE_HEIGHT);
    assert.equal(reopened.options.maximizable, false);

    // Unshading restores full bounds and resets max size.
    const unshadedState = await handlers[POPOUT_CHANNELS.setState](from(reopened), { shaded: false });
    assert.deepEqual(unshadedState, { shaded: false, pinned: true });
    assert.deepEqual(reopened.bounds, { x: 120, y: 140, width: 460, height: 580 });
    assert.deepEqual(reopened.maxSize, [0, 0]);
    assert.deepEqual(reopened.minSize, [MUSIC_WINDOW_MIN.width, MUSIC_WINDOW_MIN.height]);
    assert.equal(reopened.maximizable, true);

    await handlers[POPOUT_CHANNELS.action](from(reopened), 'close');
    assert.equal(popout.isOpen(), false);
});

test('music window preload bridge sanitizes ui-state and action calls', async () => {
    const source = await readFile(app('music-window-preload.cjs'), 'utf8');
    const worlds = {}, invoked = [], listeners = {};
    const electron = {
        contextBridge: { exposeInMainWorld: (name, api) => { worlds[name] = api; } },
        ipcRenderer: {
            invoke: (...args) => { invoked.push(args); return Promise.resolve(null); },
            send: () => {},
            on: (channel, fn) => { listeners[channel] = fn; }
        }
    };
    vm.runInNewContext(source, { require: name => (assert.equal(name, 'electron'), electron), Promise, String, Number });
    const a = worlds.asscrack;
    await a.getMusicWindowState();
    await a.setMusicWindowState({ shaded: true, pinned: 'yes', extra: 123 });
    await a.musicWindowAction(null);
    await a.musicWindowAction('minimize');
    assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
        ['asscrack:music-window-ui-state'],
        ['asscrack:music-window-set-ui-state', { shaded: true }],
        ['asscrack:music-window-action', ''],
        ['asscrack:music-window-action', 'minimize']
    ]);
    const got = [];
    a.onMusicViz?.(() => {});
    a.onMusicWindowState(s => got.push(s));
    listeners['asscrack:music-window-ui-state-changed']({}, { shaded: true, pinned: false });
    assert.deepEqual(got, [{ shaded: true, pinned: false }]);
});

test('music-window.js applies shaded/pinned state, button labels, and marquee class on overflow', async () => {
    const source = await readFile(app('music-window.js'), 'utf8');
    const attrs = new Map();
    const makeEl = (id, props = {}) => {
        const classes = new Set();
        const elAttrs = new Map();
        const styleProps = new Map();
        const listeners = {};
        return {
            id,
            textContent: '',
            title: '',
            scrollWidth: 100,
            clientWidth: 100,
            parentElement: null,
            ...props,
            setAttribute(k, v) { elAttrs.set(k, String(v)); },
            getAttribute(k) { return elAttrs.get(k); },
            addEventListener(ev, fn) { (listeners[ev] ??= []).push(fn); },
            async click() { for (const fn of listeners.click ?? []) await fn({ target: this }); },
            classList: {
                add: c => classes.add(c),
                remove: c => classes.delete(c),
                contains: c => classes.has(c)
            },
            style: {
                setProperty: (k, v) => styleProps.set(k, v),
                removeProperty: k => styleProps.delete(k),
                getPropertyValue: k => styleProps.get(k) ?? ''
            }
        };
    };
    const marqueeEl = makeEl('marquee', { clientWidth: 120 });
    const titleEl = makeEl('music-title', { scrollWidth: 240, parentElement: marqueeEl });
    const pinButton = makeEl('music-pin');
    const shadeButton = makeEl('music-shade');
    const minButton = makeEl('music-win-min');
    const closeButton = makeEl('music-win-close');
    const titlebar = makeEl('music-titlebar');
    const elements = new Map([
        ['music-title', titleEl], ['music-pin', pinButton], ['music-shade', shadeButton],
        ['music-win-min', minButton], ['music-win-close', closeButton], ['music-titlebar', titlebar]
    ]);
    let stateListener = null;
    const setCalls = [];
    const actions = [];
    const windowListeners = {};
    const docEl = { dataset: {} };
    let curState = { shaded: true, pinned: true };
    const ctx = {
        localStorage: { getItem: () => null },
        document: {
            documentElement: docEl,
            getElementById: id => elements.get(id) ?? null
        },
        window: {
            asscrack: {
                getMusicSettings: async () => ({}),
                getMusicWindowState: async () => ({ ...curState }),
                setMusicWindowState: async patch => { setCalls.push(patch); curState = { ...curState, ...patch }; return { ...curState }; },
                onMusicWindowState: fn => { stateListener = fn; },
                musicWindowAction: async a => { actions.push(a); }
            },
            addEventListener: (ev, fn) => { (windowListeners[ev] ??= []).push(fn); },
            dispatchEvent: () => {}
        },
        Promise, Math, Number, String, Event: function Event() {}
    };
    vm.runInNewContext(source, ctx);
    await settle();

    assert.equal(docEl.dataset.shaded, 'true');
    assert.equal(docEl.dataset.pinned, 'true');
    assert.equal(shadeButton.getAttribute('aria-pressed'), 'true');
    assert.equal(shadeButton.textContent, '▾');
    assert.equal(pinButton.getAttribute('aria-pressed'), 'true');
    assert.equal(titleEl.classList.contains('scrolling'), true);
    assert.equal(titleEl.style.getPropertyValue('--marquee-distance'), '-132px');

    // Short title removes scrolling class.
    titleEl.scrollWidth = 80;
    for (const fn of windowListeners.resize ?? []) fn();
    assert.equal(titleEl.classList.contains('scrolling'), false);

    // State update from main process unshades and unpins.
    curState = { shaded: false, pinned: false };
    stateListener({ ...curState });
    assert.equal(docEl.dataset.shaded, 'false');
    assert.equal(shadeButton.textContent, '▴');
    assert.equal(pinButton.getAttribute('aria-pressed'), 'false');

    await shadeButton.click();
    await pinButton.click();
    await minButton.click();
    await closeButton.click();
    assert.deepEqual(JSON.parse(JSON.stringify(setCalls)), [{ shaded: true }, { pinned: true }]);
    assert.deepEqual(actions, ['minimize', 'close']);
    assert.equal(attrs.size, 0);
});
