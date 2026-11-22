import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attachVoiceMonitor, fitVoiceBounds } from '../src/application/voice-monitor.mjs';

const area = { x: -1440, y: 20, width: 1440, height: 850 };
const roomPage = 'file:///asscrack/index.html';
test('detached voice bounds stay inside a scaled work area, including after a display disappears', () => {
    assert.deepEqual(fitVoiceBounds({ x: 2700, y: -400, width: 330, height: 196 }, area),
        { x: -330, y: 20, width: 330, height: 196 });
    assert.deepEqual(fitVoiceBounds({ x: {}, height: -4, width: 'abc' }, area),
        { x: -308, y: 40, width: 288, height: 130 });
    assert.deepEqual(fitVoiceBounds({ x: -1100, y: 100, width: 9000, height: 3840 }, area), area);
});

test('one detached panel uses the live room, closes quietly on shutdown, and saves only geometry', t => {
    const profile = mkdtempSync(path.join(tmpdir(), 'ac-voice-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    let detached, active = true, restored = 0, creates = 0;
    class Window extends EventEmitter {
        webContents = Object.assign(new EventEmitter(), {
            mainFrame: { url: roomPage }, isDestroyed: () => false, send: (...args) => this.sent.push(args),
            setBackgroundThrottling: enabled => { this.throttling = enabled; },
            setWindowOpenHandler() {}
        });
        sent = [];
        destroyed = false;
        constructor(options) { super(); this.options = options; creates++; if (options) detached = this; }
        isDestroyed() { return this.destroyed; }
        show() {}
        focus() { this.focused = true; }
        // I4: the panel loads its page from the app scheme (loadURL), not from a file.
        async loadURL(url) {
            this.webContents.mainFrame.url = url;
            this.webContents.emit('did-finish-load'); this.emit('ready-to-show');
        }
        getBounds() { return area; }
        getNormalBounds() { return { x: -720, y: 98, width: 370, height: 190 }; }
        close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
    }
    const ipc = new EventEmitter(), room = new Window(), stranger = {};
    const monitor = attachVoiceMonitor({ ipc, BrowserWindow: Window, room, roomPage, profile, assets: profile, warn: assert.fail,
        participating: () => active, restoreRoom: () => { restored++; },
        screen: { getDisplayMatching: () => ({ workArea: area }), getDisplayNearestPoint: () => ({ workArea: area }) } });
    const emit = (suffix, win, data) => ipc.emit('asscrack:voice-monitor-' + suffix, { sender: win.webContents, senderFrame: win.webContents?.mainFrame }, data);
    emit('open', stranger); assert.equal(creates, 1);
    emit('open', room); assert.equal(detached.options.alwaysOnTop, true);
    emit('open', room); assert.equal(creates, 2); assert.equal(detached.focused, true);
    assert.equal(room.throttling, false); assert.deepEqual(room.sent.pop(), ['asscrack:voice-monitor-active', true]);
    const state = { muted: true, speakers: ['You'] };
    emit('publish', stranger, state); assert.deepEqual(detached.sent, []);
    emit('publish', room, state); assert.deepEqual(detached.sent.pop(), ['asscrack:voice-monitor-state', state]);
    emit('set-muted', room, true); assert.deepEqual(room.sent, []);
    emit('set-muted', detached, false); assert.deepEqual(room.sent.pop(), ['asscrack:voice-monitor-mute', false]);
    emit('close', detached); assert.equal(restored, 1); assert.equal(room.throttling, true);
    const saved = JSON.parse(readFileSync(path.join(profile, 'voice-window.json')));
    assert.deepEqual(saved, detached.getNormalBounds());
    emit('open', room); assert.equal(detached.options.x, saved.x); assert.equal(detached.options.width, saved.width);
    active = false; monitor.dismiss(); assert.equal(restored, 1);
    emit('open', room); assert.equal(creates, 3);
    room.close(); assert.equal(ipc.listenerCount('asscrack:voice-monitor-open'), 0);
});

// P8b, design W6 check 1: Stop sharing in the panel uses the path of Mute. Only the panel page can send it, and only
// while the room participates. The room window gets asscrack:voice-monitor-stop-share and stops the share there.
test('W6: Stop sharing in the detached panel reaches the room window only from the panel', t => {
    const profile = mkdtempSync(path.join(tmpdir(), 'ac-voice-share-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    let detached, active = true;
    class Window extends EventEmitter {
        webContents = Object.assign(new EventEmitter(), {
            mainFrame: { url: roomPage }, isDestroyed: () => false, send: (...args) => this.sent.push(args),
            setBackgroundThrottling() {}, setWindowOpenHandler() {}
        });
        sent = [];
        destroyed = false;
        constructor(options) { super(); this.options = options; if (options) detached = this; }
        isDestroyed() { return this.destroyed; }
        show() {}
        focus() {}
        async loadURL(url) { this.webContents.mainFrame.url = url; this.webContents.emit('did-finish-load'); }
        getBounds() { return area; }
        getNormalBounds() { return { x: 0, y: 0, width: 300, height: 180 }; }
        close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
    }
    const ipc = new EventEmitter(), room = new Window();
    attachVoiceMonitor({ ipc, BrowserWindow: Window, room, roomPage, profile, assets: profile, warn: () => {},
        participating: () => active, restoreRoom: () => {},
        screen: { getDisplayMatching: () => ({ workArea: area }), getDisplayNearestPoint: () => ({ workArea: area }) } });
    const emit = (suffix, win, data) => ipc.emit('asscrack:voice-monitor-' + suffix, { sender: win.webContents, senderFrame: win.webContents?.mainFrame }, data);
    emit('open', room);
    room.sent.length = 0;
    emit('stop-share', room);
    assert.deepEqual(room.sent, [], 'the room window cannot send it');
    emit('stop-share', detached);
    assert.deepEqual(room.sent, [['asscrack:voice-monitor-stop-share', true]]);
    active = false;
    room.sent.length = 0;
    emit('stop-share', detached);
    assert.deepEqual(room.sent, [], 'no participation, no stop');
});

test('W6: the panel shows "Sharing your screen" and Stop sharing only while the share is on', async () => {
    const { createDom } = await import('./helpers/fake-dom.mjs');
    const vm = await import('node:vm');
    const source = readFileSync(new URL('../src/application/voice-monitor.js', import.meta.url), 'utf8');
    const { document } = createDom([
        { id: 'mic', tag: 'strong' }, { id: 'mute', tag: 'button' },
        { id: 'share-row', hidden: true, children: [{ id: 'share-state', tag: 'strong' }, { id: 'stop-share', tag: 'button' }] },
        { id: 'speakers' }, { id: 'back', tag: 'button' }
    ]);
    let onState = null, stops = 0;
    const window = { voiceMonitor: { onState: fn => { onState = fn; }, setMuted() {}, close() {}, stopShare: () => { stops++; } } };
    vm.runInNewContext(source, { window, document, String });
    const view = sharing => ({ inVoice: true, muted: false, deafened: false, transmitting: false, speakers: [], theme: 'aero-classic', channel: '', sharing });
    onState(view(true));
    assert.equal(document.getElementById('share-row').hidden, false);
    document.getElementById('stop-share').click();
    assert.equal(stops, 1, 'the panel sends Stop sharing');
    onState(view(false));
    assert.equal(document.getElementById('share-row').hidden, true);
    onState({ ...view(true), sharing: undefined });
    assert.equal(document.getElementById('share-row').hidden, true, 'an old view with no field: no share line');
});
