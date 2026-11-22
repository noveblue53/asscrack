// 1.0.1: the Friends window (friends-popout.mjs, friends-window.html, friends-window-preload.cjs) and the Pop out
// button of the Friends drawer (friends-ui.js). Fake Electron objects and the fake DOM; no network, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createDom } from './helpers/fake-dom.mjs';

const app = name => new URL(`../src/application/${name}`, import.meta.url);
const uiSource = await readFile(app('friends-ui.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

const view = (extra = {}) => ({ state: 'open', cap: 16, count: 1, name: 'Ann', upnp: false, reach: 'local',
    friends: [{ friendId: 'f1', name: 'Ben', state: 'offline', lastSeen: null, unread: 0 }], waiting: [], blocked: [], ...extra });

test('the Friends window module: one window, own checked channels, live data, saved bounds, close', async t => {
    const { attachFriendsPopout, FRIENDS_WINDOW_FILE } = await import('../src/application/friends-popout.mjs');
    const profile = mkdtempSync(path.join(tmpdir(), 'ac-friends-window-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
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
        getNormalBounds() { return { x: 40, y: 60, width: 333, height: 444 }; }
        close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
    }
    const handlers = {};
    const ipc = { handle: (channel, fn) => { assert.equal(handlers[channel], undefined, channel); handlers[channel] = fn; } };
    const events = new EventEmitter();
    const calls = [];
    const links = { events, list: () => view(), setName: name => { calls.push(['name', name]); return name; },
        setUpnp: on => { calls.push(['upnp', on]); return on; }, unblock: id => { calls.push(['unblock', id]); return true; } };
    const screen = { getDisplayMatching: () => ({ workArea: area }), getPrimaryDisplay: () => ({ workArea: area }) };
    const popout = attachFriendsPopout({ BrowserWindow: Window, ipc, screen, profile, assets: profile, links,
        openChat: id => { calls.push(['chat', id]); return true; }, warn: assert.fail });
    assert.deepEqual(Object.keys(handlers).sort(), ['asscrack:friends-window-list', 'asscrack:friends-window-name',
        'asscrack:friends-window-open-chat', 'asscrack:friends-window-unblock', 'asscrack:friends-window-upnp']);

    // A first open: the default size in the middle of the display, the own preload, the sandbox.
    assert.equal(popout.open(), true);
    await settle();
    assert.equal(created.length, 1);
    const win = created[0];
    assert.equal(win.webContents.mainFrame.url, 'asscrack-app://app/friends-window.html');
    assert.deepEqual([win.options.width, win.options.height, win.options.x, win.options.y], [320, 520, 800, 260]);
    assert.equal(path.basename(win.options.webPreferences.preload), 'friends-window-preload.cjs');
    assert.equal(win.options.webPreferences.sandbox, true);
    assert.equal(win.options.webPreferences.contextIsolation, true);
    assert.equal(win.shown, true);
    // One window at most: a second open focuses it.
    assert.equal(popout.open(), true);
    assert.equal(created.length, 1);
    assert.equal(win.focused, 1);

    // The channels accept only the main frame of this window.
    const from = w => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame });
    const stranger = new Window({});
    stranger.webContents.mainFrame.url = 'asscrack-app://app/index.html';
    assert.equal(handlers['asscrack:friends-window-list'](from(stranger)), null);
    assert.throws(() => handlers['asscrack:friends-window-open-chat'](from(stranger), 'f1'), /Unknown friends window/);
    assert.deepEqual(calls, []);
    assert.deepEqual(handlers['asscrack:friends-window-list'](from(win)), view());
    assert.equal(handlers['asscrack:friends-window-open-chat'](from(win), 'f1'), true);
    assert.equal(handlers['asscrack:friends-window-open-chat'](from(win), ''), false);
    handlers['asscrack:friends-window-name'](from(win), 'Ann B');
    handlers['asscrack:friends-window-upnp'](from(win), 'yes');
    handlers['asscrack:friends-window-unblock'](from(win), 'd1');
    assert.deepEqual(calls, [['chat', 'f1'], ['name', 'Ann B'], ['upnp', false], ['unblock', 'd1']]);

    // Live data: each change of the friend links goes to the window.
    events.emit('changed', view({ name: 'New' }));
    assert.deepEqual(win.sent.at(-1), ['asscrack:friends-window-changed', view({ name: 'New' })]);

    // close() closes the window and saves its bounds. The next open uses them.
    assert.equal(popout.isOpen(), true);
    popout.close();
    assert.equal(popout.isOpen(), false);
    const saved = JSON.parse(readFileSync(path.join(profile, FRIENDS_WINDOW_FILE), 'utf8'));
    assert.deepEqual(saved, { x: 40, y: 60, width: 333, height: 444, maximized: false });
    events.emit('changed', view());
    assert.equal(win.sent.length, 1);
    popout.open();
    await settle();
    assert.equal(created.length, 3);
    assert.deepEqual([created[2].options.x, created[2].options.y, created[2].options.width, created[2].options.height], [40, 60, 333, 444]);
});

test('the Friends window page: the CSP, the window mode of the panel and the scripts', async () => {
    const html = await readFile(app('friends-window.html'), 'utf8');
    assert.match(html, /style-src 'self'/);
    assert.doesNotMatch(html, /style="/);
    assert.match(html, /<aside id="friends-panel" data-mode="window"/);
    assert.match(html, /<script src="friends-window.js"><\/script>\s*<script src="friends-ui.js"><\/script>/);
    const main = await readFile(app('main.js'), 'utf8');
    assert.match(main, /handleRoomIpc\('asscrack:friends-popout', \(\) => \(node \? friendsPopout\.open\(\) : false\)\)/);
    assert.match(main, /mainWindow\.on\('closed', \(\) => \{[^\n]*friendsPopout\.close\(\)/);
});

function panelLayout(windowMode) {
    return [
        { id: 'friends-panel', children: [
            ...(windowMode ? [] : [{ id: 'friends-popout', tag: 'button', hidden: true }, { id: 'friends-close', tag: 'button' }]),
            { id: 'friends-locked', tag: 'p' }, { id: 'friends-retry', tag: 'button' }, { id: 'friends-empty', tag: 'p' },
            { id: 'friend-list', tag: 'ul' }, { id: 'friend-waiting', tag: 'ul' },
            { id: 'friends-settings', children: [{ id: 'friends-reach', tag: 'p' }, { id: 'friends-upnp', tag: 'button' },
                { id: 'friends-name', tag: 'span' }, { id: 'friends-name-change', tag: 'button' },
                { id: 'friends-blocked', children: [{ id: 'friend-blocked-list', tag: 'ul' }] }] },
            { id: 'friends-status', tag: 'p' }] },
        ...(windowMode ? [] : [{ id: 'login-screen', hidden: true },
            { id: 'friends-toggle', tag: 'button', children: [{ id: 'friends-unread', tag: 'span' }] }]),
        { id: 'friend-confirm', tag: 'dialog', children: [{ id: 'friend-confirm-text', tag: 'p' }, { id: 'friend-confirm-yes', tag: 'button' }] },
        { id: 'friend-name-dialog', tag: 'dialog', children: [{ id: 'friend-name-form', tag: 'form', children: [
            { id: 'friend-name-title' }, { id: 'friend-name-input', tag: 'input' }, { id: 'friend-name-error' },
            { id: 'friend-name-cancel', tag: 'button' }, { id: 'friend-name-save', tag: 'button' }] }] }
    ];
}
function loadPanel({ windowMode, api }) {
    const { document, window } = createDom(panelLayout(windowMode));
    if (windowMode) document.getElementById('friends-panel').dataset.mode = 'window';
    window.friends = api;
    window.window = window;
    vm.runInNewContext(uiSource, { window, document, console, Promise, Date, setTimeout });
    return { document, window, el: id => document.getElementById(id) };
}

test('the Friends window runs friends-ui.js with no drawer: the list, live changes, a click opens the chat', async () => {
    const calls = [];
    let changed;
    // The bridge of friends-window-preload.cjs: no retry, no popOut, no request, no relations.
    const api = { list: async () => view(), openChat: async id => { calls.push(['chat', id]); return true; },
        setName: async () => true, setUpnp: async () => true, unblock: async () => true, onChanged: fn => { changed = fn; } };
    const { el } = loadPanel({ windowMode: true, api });
    await settle();
    assert.deepEqual(el('friend-list').children.map(row => row.dataset.friendId), ['f1']);
    assert.equal(el('friends-name').textContent, 'Ann');
    assert.equal(el('friends-panel').hidden, false);
    changed(view({ friends: [{ friendId: 'f1', name: 'Ben', state: 'online', lastSeen: null, unread: 2 },
        { friendId: 'f2', name: 'Cat', state: 'offline', lastSeen: null, unread: 0 }], waiting: [{ name: 'Dan' }] }));
    assert.deepEqual(el('friend-list').children.map(row => row.querySelector('.friend-state').textContent), ['Online', 'Not connected yet']);
    assert.equal(el('friend-waiting').children[0].textContent, 'Waiting for Dan to accept…');
    el('friend-list').children[1].click();
    await settle();
    assert.deepEqual(calls, [['chat', 'f2']]);
    // Locked: no Try again button in this window (the archive opens from the room window).
    changed({ state: 'locked' });
    assert.equal(el('friends-locked').hidden, false);
    assert.equal(el('friends-retry').hidden, true);
});

test('the Friends drawer: Pop out shows in a room, opens the window and closes the drawer', async () => {
    const calls = [];
    const api = { list: async () => view(), relations: async () => ({}), openChat: async () => true, retry: async () => ({}),
        popOut: async () => { calls.push('popOut'); return true; }, onChanged() {} };
    const { el } = loadPanel({ windowMode: false, api });
    await settle();
    assert.equal(el('friends-popout').hidden, false);
    el('friends-toggle').click();
    assert.equal(el('friends-panel').hidden, false);
    el('friends-popout').click();
    await settle();
    assert.deepEqual(calls, ['popOut']);
    assert.equal(el('friends-panel').hidden, true);
    assert.equal(el('friends-toggle').getAttribute('aria-expanded'), 'false');
    // With no popOut in the bridge, the button stays hidden.
    const old = loadPanel({ windowMode: false, api: { ...api, popOut: undefined } });
    await settle();
    assert.equal(old.el('friends-popout').hidden, true);
});

test('the Friends window bridge sends text and a strict boolean on its own channels', async () => {
    const source = await readFile(app('friends-window-preload.cjs'), 'utf8');
    const worlds = {}, invoked = [], listeners = {};
    const electron = { contextBridge: { exposeInMainWorld: (name, api) => { worlds[name] = api; } },
        ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve(null); },
            on: (channel, fn) => { listeners[channel] = fn; } } };
    vm.runInNewContext(source, { require: name => { assert.equal(name, 'electron'); return electron; }, Promise, String });
    assert.deepEqual(Object.keys(worlds), ['friends']);
    const f = worlds.friends;
    assert.deepEqual(Object.keys(f).sort(), ['list', 'onChanged', 'openChat', 'setName', 'setUpnp', 'unblock']);
    f.list(); f.openChat(7); f.setName(null); f.setUpnp('yes'); f.setUpnp(true); f.unblock({ toString: () => 'd1' });
    assert.deepEqual(invoked, [['asscrack:friends-window-list'], ['asscrack:friends-window-open-chat', '7'],
        ['asscrack:friends-window-name', ''], ['asscrack:friends-window-upnp', false], ['asscrack:friends-window-upnp', true],
        ['asscrack:friends-window-unblock', 'd1']]);
    const got = [];
    f.onChanged(data => got.push(data));
    listeners['asscrack:friends-window-changed']({}, { state: 'open' });
    assert.deepEqual(got, [{ state: 'open' }]);
});
