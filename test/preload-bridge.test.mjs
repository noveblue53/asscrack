// The bridge of the room window (src/application/preload.cjs): the file runs in node:vm with a fake electron module.
// The tests call the functions of window.asscrack and check the IPC channel and the arguments that go to the main
// process, and the events that come back. These tests replace the source-text checks of preload.cjs in
// test/app-events.test.mjs and test/saved-rooms-ui.test.mjs. Electron does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/preload.cjs', import.meta.url), 'utf8');

// Run preload.cjs. The main window runs it with sandbox: true, thus require('electron') is its only module.
function loadBridge() {
    const worlds = {};
    const invoked = [];
    const sent = [];
    const listeners = {};
    const touched = [];
    const ipcRenderer = {
        invoke: (channel, ...args) => {
            invoked.push([channel, ...args]);
            return Promise.resolve({ channel });
        },
        send: (channel, ...args) => sent.push([channel, ...args]),
        on: (channel, fn) => (listeners[channel] ??= []).push(fn)
    };
    const electron = {
        contextBridge: { exposeInMainWorld: (name, api) => { worlds[name] = api; } },
        ipcRenderer,
        webUtils: { getPathForFile: file => file?.path ?? '' }
    };
    // A module or a property that the bridge must not use (for example shell, to open a path) is recorded.
    const guarded = new Proxy(electron, {
        get(target, name) {
            if (!(name in target)) touched.push(String(name));
            return target[name];
        }
    });
    const require = name => {
        if (name !== 'electron') {
            touched.push(`require(${name})`);
            throw new Error(`module not available in a sandboxed preload: ${name}`);
        }
        return guarded;
    };
    vm.runInNewContext(source, { require, Promise, Error, Number, String, Uint8Array }, { filename: 'preload.cjs' });
    // An event from the main process to the window.
    const emit = (channel, data) => {
        for (const fn of listeners[channel] ?? []) fn({ sender: 'main' }, data);
    };
    return { api: worlds.asscrack, worlds, invoked, sent, listeners, touched, emit };
}

test('the bridge exposes the room API and uses only ipcRenderer, contextBridge and webUtils of electron', () => {
    const b = loadBridge();
    // G7a adds the world 'friends' (the Friends panel, the request bar and the buddy menu lines).
    // easy-join part 3 adds the world 'clipboardJoin' (the prompt for a device invite in the clipboard).
    assert.deepEqual(Object.keys(b.worlds).sort(), ['asscrack', 'clipboardJoin', 'desktopFrame', 'friends', 'roomVoiceMonitor']);
    assert.deepEqual(b.touched, []);
    for (const [name, fn] of Object.entries(b.api)) assert.equal(typeof fn, 'function', name);
});

test('the clipboardJoin world sends only the prompt id and true or false', async () => {
    const b = loadBridge();
    const api = b.worlds.clipboardJoin;
    assert.deepEqual(Object.keys(api).sort(), ['dismiss', 'join', 'onPrompt', 'take']);
    await api.take();
    await api.join('p1', 'yes');
    await api.join({ code: 'x' }, true);
    await api.dismiss('p1');
    assert.deepEqual(b.invoked, [['asscrack:clipboard-join-take'], ['asscrack:clipboard-join', 'p1', false],
        ['asscrack:clipboard-join', '[object Object]', true], ['asscrack:clipboard-join-dismiss', 'p1']]);
    const got = [];
    api.onPrompt(data => got.push(data));
    b.emit('asscrack:clipboard-join', null);
    assert.deepEqual(got, [null]);
});

test('each on* function of the bridge gives the data of its event to the callback, with no IPC event object', () => {
    const b = loadBridge();
    for (const [name, channel] of [['onHistory', 'asscrack:history'], ['onTopology', 'asscrack:topology'],
        ['onLineSaved', 'asscrack:line-saved'], ['onSaveFailed', 'asscrack:save-failed'],
        ['onFileDone', 'asscrack:file-done'], ['onMessage', 'asscrack:message']]) {
        const got = [];
        b.api[name](data => got.push(data));
        const data = { marker: name };
        b.emit(channel, data);
        assert.deepEqual(got, [data], name);
    }
    // A callback gets only the events of its own channel.
    const history = [];
    b.api.onHistory(data => history.push(data));
    b.emit('asscrack:topology', { other: true });
    assert.deepEqual(history, []);
});

test('the topology and the transfer calls send the IPC channel and the arguments that the main process expects', async () => {
    const b = loadBridge();
    assert.deepEqual(await b.api.getTopology(), { channel: 'asscrack:topology' });
    assert.deepEqual(await b.api.getMapTraffic(), { channel: 'asscrack:map-traffic' });
    b.api.cancelFile('offer-1', 'peer-2');
    b.api.acceptFile('offer-1');
    b.api.refuseFile('offer-1');
    assert.deepEqual(b.invoked, [
        ['asscrack:topology'],
        ['asscrack:map-traffic'],
        ['asscrack:cancel-file', 'offer-1', 'peer-2'],
        ['asscrack:accept-file', 'offer-1'],
        ['asscrack:refuse-file', 'offer-1']
    ]);
});

test('revealFile sends only a text key, never a path or an object, and the bridge has no shell access', () => {
    const b = loadBridge();
    const key = { toString: () => 'offer-1|peer-2', path: 'C:\\Users\\x\\secret.txt' };
    b.api.revealFile(key);
    b.api.revealFile('offer-3|peer-4');
    assert.deepEqual(b.invoked, [['asscrack:reveal-file', 'offer-1|peer-2'], ['asscrack:reveal-file', 'offer-3|peer-4']]);
    assert.equal(typeof b.invoked[0][1], 'string');
    assert.deepEqual(b.touched, [], 'no shell, no other electron module');
    // A new reveal function must come with a test of its arguments: the window never gives a path.
    assert.deepEqual(Object.keys(b.api).filter(name => /^reveal|path/i.test(name)).sort(), ['revealFile', 'revealSavedOriginal']);
    b.api.revealSavedOriginal('message-1', 'descriptor-2');
    assert.deepEqual(b.invoked.at(-1), ['asscrack:reveal-saved-original', 'message-1', 'descriptor-2']);
});

test('the saved-room calls of part 2 send the room ID as text and a strict true or false', () => {
    const b = loadBridge();
    b.api.savedRoomLines(7, { before: { time: '12', id: 5 }, channelId: 'general' });
    b.api.savedRoomLines('r');
    b.api.setKeepHistory('r', 'yes');
    b.api.setKeepHistory('r', true);
    b.api.clearHistory(42);
    b.api.forgetRoom('r');
    // The objects come from the vm context: JSON makes plain objects of this realm (an undefined value goes away).
    assert.deepEqual(JSON.parse(JSON.stringify(b.invoked)), [
        ['asscrack:saved-room-lines', '7', { before: { time: 12, id: '5' }, channelId: 'general' }],
        ['asscrack:saved-room-lines', 'r', { before: null }],
        ['asscrack:set-keep-history', 'r', false],
        ['asscrack:set-keep-history', 'r', true],
        ['asscrack:clear-history', '42'],
        ['asscrack:forget-room', 'r']
    ]);
});

test('the listening calls of G4 send the peer ID as text, a strict true or false, and a number', () => {
    const b = loadBridge();
    b.api.getListening(7);
    b.api.setListening('peer-1', 'yes', '150');
    b.api.setListening('peer-2', true, 40);
    assert.deepEqual(b.invoked, [
        ['asscrack:get-listening', '7'],
        ['asscrack:set-listening', 'peer-1', false, 150],
        ['asscrack:set-listening', 'peer-2', true, 40]
    ]);
});

// Goal G3 (gaps D2 and N7) adds two bridge functions. openLink sends only a text to asscrack:open-link; the main
// process checks it (link-policy.mjs). canSendFile gives only true or false, never the path of the file.
test('openLink sends the href as text, and canSendFile gives a boolean and never the path', () => {
    const b = loadBridge();
    b.api.openLink('https://example.com/a(b)');
    b.api.openLink({ toString: () => 'https://example.com/x' });
    assert.deepEqual(b.invoked, [['asscrack:open-link', 'https://example.com/a(b)'], ['asscrack:open-link', 'https://example.com/x']]);
    assert.equal(b.api.canSendFile({ path: 'C:/Users/x/report.docx' }), true);
    assert.equal(b.api.canSendFile({ name: 'screenshot.png' }), false);
    assert.equal(b.api.canSendFile(null), false);
    assert.deepEqual(b.touched, []);
});

// Goal G6 adds five bridge functions for the voice channels. Each call sends only text to its own IPC channel; the
// main process asks the node, and the node checks the owner and the name.
test('the voice channel calls of G6 send the channel ID and the name as text', async () => {
    const b = loadBridge();
    assert.deepEqual(await b.api.getVoiceChannels(), { channel: 'asscrack:voice-channels' });
    b.api.createVoiceChannel('Raid');
    b.api.renameVoiceChannel({ toString: () => 'id-1' }, 42);
    b.api.deleteVoiceChannel('id-2');
    assert.deepEqual(b.invoked, [
        ['asscrack:voice-channels'],
        ['asscrack:voice-channel-create', 'Raid'],
        ['asscrack:voice-channel-rename', 'id-1', '42'],
        ['asscrack:voice-channel-delete', 'id-2']
    ]);
    const got = [];
    b.api.onVoiceChannels(view => got.push(view));
    b.emit('asscrack:voice-channels', { seq: 1 });
    assert.deepEqual(got, [{ seq: 1 }]);
    assert.deepEqual(b.touched, []);
});

// Milestone 9 (ready check) adds five bridge functions. Each call sends only texts; the node checks the values.
test('the ready check calls send the text, the check ID and the vote as text, and onReady gives the view', () => {
    const b = loadBridge();
    b.api.getReady();
    b.api.openReady('Race in five?');
    b.api.openReady();
    b.api.voteReady(7, 'ready');
    b.api.closeReady({ toString: () => 'id-1' });
    assert.deepEqual(b.invoked, [
        ['asscrack:ready-state'],
        ['asscrack:ready-open', 'Race in five?'],
        ['asscrack:ready-open', ''],
        ['asscrack:ready-vote', '7', 'ready'],
        ['asscrack:ready-close', 'id-1']
    ]);
    const got = [];
    b.api.onReady(view => got.push(view));
    b.emit('asscrack:ready', { checks: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(got)), [{ checks: [] }]);
});

// G5: the calls of the Windows app shell. The window gives no path and no room ID: the main process has them.
test('the G5 calls send their IPC channel with no path, and the alias call sends at most 64 IDs as text', () => {
    const b = loadBridge();
    b.api.leaveRoom('C:\secret');
    b.api.leaveRoomInfo('room-id');
    b.api.getAbout();
    b.api.openDataFolder('C:\other');
    assert.deepEqual(b.invoked, [['asscrack:leave-room'], ['asscrack:leave-room-info'], ['asscrack:about'],
        ['asscrack:open-data-folder']]);
    b.api.flashAttention({ text: 'private' });
    assert.deepEqual(b.sent, [['asscrack:attention-flash']]);
    b.api.getActivityAliases(Array.from({ length: 70 }, (_, i) => i));
    const [channel, ids] = b.invoked.at(-1);
    assert.equal(channel, 'asscrack:activity-aliases');
    assert.equal(ids.length, 64);
    assert.equal(ids[3], '3');
    b.api.getActivityAliases('not a list');
    // The array comes from the vm context of the preload (another Array prototype): compare the JSON text.
    assert.equal(JSON.stringify(b.invoked.at(-1)), JSON.stringify(['asscrack:activity-aliases', []]));
    assert.deepEqual(b.touched, []);
});

// P9C: the update calls. The window gives no path and no URL: the main process has the file and the release address.
// Only a strict true turns the check on or forces a restart in voice or during a transfer.
test('the P9C update calls send their IPC channel and a strict true or false, and onUpdate gives the view', () => {
    const b = loadBridge();
    b.api.getUpdate('C:\other');
    b.api.checkUpdate('https://example.com');
    b.api.setUpdateCheck('yes');
    b.api.setUpdateCheck(true);
    b.api.downloadUpdate('C:\file.exe');
    b.api.updateLater();
    b.api.restartToUpdate('yes');
    b.api.restartToUpdate(true);
    assert.deepEqual(b.invoked, [['asscrack:update'], ['asscrack:update-check'], ['asscrack:update-auto', false],
        ['asscrack:update-auto', true], ['asscrack:update-download'], ['asscrack:update-later'],
        ['asscrack:update-restart', false], ['asscrack:update-restart', true]]);
    const got = [];
    b.api.onUpdate(view => got.push(view));
    b.emit('asscrack:update', { current: '1.0.0', update: null });
    assert.deepEqual(got, [{ current: '1.0.0', update: null }]);
    assert.deepEqual(b.touched, []);
});

// G7a: the friend calls of the room window send only text and a strict true or false. The chat window bridge
// (friend-chat-preload.cjs) sends no friend ID: the main process binds each chat window to its friend.
test('the G7a friend calls send text and a strict boolean; the chat window bridge sends no friend ID', async () => {
    const b = loadBridge();
    const f = b.worlds.friends;
    f.list();
    f.relations([1, 'p2']);
    f.relations('not a list');
    f.request(7);
    f.respond('r1', 'yes');
    f.respond('r1', true);
    f.remove('f1'); f.block('f1'); f.unblock('d1'); f.rename('f1', 42); f.setName('Ann');
    f.setUpnp('on'); f.setUpnp(true); f.openChat('f1'); f.retry();
    assert.equal(JSON.stringify(b.invoked), JSON.stringify([
        ['asscrack:friends'], ['asscrack:friend-relations', ['1', 'p2']], ['asscrack:friend-relations', []],
        ['asscrack:friend-request', '7'], ['asscrack:friend-respond', 'r1', false], ['asscrack:friend-respond', 'r1', true],
        ['asscrack:friend-remove', 'f1'], ['asscrack:friend-block', 'f1'], ['asscrack:friend-unblock', 'd1'],
        ['asscrack:friend-rename', 'f1', '42'], ['asscrack:friend-name', 'Ann'], ['asscrack:friend-upnp', false],
        ['asscrack:friend-upnp', true], ['asscrack:friend-open-chat', 'f1'], ['asscrack:unlock-archive']
    ]));
    const got = [];
    f.onChanged(view => got.push(view));
    f.onRequest(event => got.push(event));
    // G7b adds the event onAttention (a friend line for the attention rules of attention.js).
    f.onAttention(target => got.push(target));
    b.emit('asscrack:friends', { state: 'open' });
    b.emit('asscrack:friend-request', { kind: 'incoming' });
    b.emit('asscrack:friend-attention', { friendId: 'f1', id: 'l1', away: 0, focused: false });
    assert.deepEqual(got, [{ state: 'open' }, { kind: 'incoming' }, { friendId: 'f1', id: 'l1', away: 0, focused: false }]);
    assert.deepEqual(b.touched, []);

    const chatSource = await readFile(new URL('../src/application/friend-chat-preload.cjs', import.meta.url), 'utf8');
    const worlds = {}, invoked = [];
    const electron = { contextBridge: { exposeInMainWorld: (name, api) => { worlds[name] = api; } },
        ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve(null); }, on() {} } };
    vm.runInNewContext(chatSource, { require: () => electron, Promise, Number, String });
    assert.deepEqual(Object.keys(worlds).sort(), ['asscrack', 'friendChat']);
    assert.deepEqual(Object.keys(worlds.asscrack), ['openLink']);
    worlds.friendChat.state();
    worlds.friendChat.lines(null);
    worlds.friendChat.lines({ time: '5', id: 9, path: 'C:/x' });
    worlds.friendChat.send(12);
    // G7b adds deleteWaiting: Delete of a waiting line sends only the line ID as text.
    worlds.friendChat.deleteWaiting(34);
    worlds.asscrack.openLink({ toString: () => 'https://example.com' });
    assert.equal(JSON.stringify(invoked), JSON.stringify([
        ['asscrack:friend-chat-state'], ['asscrack:friend-chat-lines', null],
        ['asscrack:friend-chat-lines', { time: 5, id: '9' }], ['asscrack:friend-chat-send', '12'],
        ['asscrack:friend-chat-delete', '34'], ['asscrack:friend-chat-open-link', 'https://example.com']
    ]));
});

// P7b adds four calls and six events for Pause, Resume and Discard of a received file. Each call sends only the
// offer ID or the partial key as text; main.js checks the length and the form of each.
test('the P7b calls send the offer ID or the partial key as text, and the partial events reach the window', () => {
    const b = loadBridge();
    b.api.pauseFile('offer-1');
    b.api.resumeFile({ toString: () => 'offer-2' });
    b.api.discardPartial(`${'a'.repeat(64)}-5`);
    b.api.listPartials('ignored');
    assert.deepEqual(b.invoked, [
        ['asscrack:pause-file', 'offer-1'],
        ['asscrack:resume-file', 'offer-2'],
        ['asscrack:discard-partial', `${'a'.repeat(64)}-5`],
        ['asscrack:list-partials']
    ]);
    for (const [name, channel] of [['onFilePaused', 'asscrack:file-paused'], ['onFileResumed', 'asscrack:file-resumed'],
        ['onFileRestarted', 'asscrack:file-restarted'], ['onFileDiscarded', 'asscrack:file-discarded'],
        ['onFileExpired', 'asscrack:file-expired'], ['onFilePartials', 'asscrack:file-partials']]) {
        const got = [];
        b.api[name](data => got.push(data));
        b.emit(channel, { marker: name });
        assert.deepEqual(got, [{ marker: name }], name);
    }
    assert.deepEqual(b.touched, []);
});

// P8b (design section 4, IPC): the screen calls send their channel with IDs as text, numbers, and the frame bytes.
// The voice panel world gets one more event: Stop sharing in the panel.
test('the P8b screen calls send the channel and the arguments that the main process expects', async () => {
    const b = loadBridge();
    b.api.getScreenSources();
    b.api.pickScreenSource(7, 'auto');
    // 1.0.4: the third argument asks for the window itself (the border switch); only a strict true is true.
    b.api.pickScreenSource('window:5:0', 'max', { border: true, other: 1 });
    b.api.pickScreenSource('window:5:0', 'max', { border: 'yes' });
    b.api.startScreenShare({ preset: 'max', width: '2560', height: 1440 });
    b.api.watchScreen(42);
    b.api.getScreenState();
    b.api.getScreenQuality();
    assert.deepEqual(JSON.parse(JSON.stringify(b.invoked)), [
        ['asscrack:screen-sources'],
        ['asscrack:screen-pick', '7', 'auto', { border: false }],
        ['asscrack:screen-pick', 'window:5:0', 'max', { border: true }],
        ['asscrack:screen-pick', 'window:5:0', 'max', { border: false }],
        ['asscrack:screen-start', { preset: 'max', width: 2560, height: 1440 }],
        ['asscrack:screen-watch', '42'],
        ['asscrack:screen-state'],
        ['asscrack:screen-last-quality']
    ]);
    const data = new Uint8Array([1, 2, 3]);
    b.api.sendScreenFrame({ tier: 1, key: 1, timestampMs: 12, data });
    b.api.stopScreenShare();
    b.api.setScreenSize({ tier: '2', width: 1280, height: 720 });
    assert.equal(b.sent.at(-1)[1].tier, 2, 'the tier ID is a number');
    b.api.reportScreenEncoder({ tiers: [] });
    b.api.unwatchScreen();
    b.api.requestScreenKey();
    assert.deepEqual(b.sent.map(s => s[0]), ['asscrack:screen-frame', 'asscrack:screen-stop', 'asscrack:screen-size',
        'asscrack:screen-report', 'asscrack:screen-unwatch', 'asscrack:screen-keyreq']);
    assert.equal(b.sent[0][1].data, data, 'the frame bytes go as they are');
    assert.equal(b.sent[0][1].key, false, 'key is a strict true');
    assert.equal(b.sent[1][1], 'stopped');
    for (const [name, channel] of [['onScreenState', 'asscrack:screen-state'], ['onScreenViewers', 'asscrack:screen-viewers'],
        ['onScreenEncoder', 'asscrack:screen-encoder'], ['onScreenConfig', 'asscrack:screen-config'],
        ['onScreenFrame', 'asscrack:screen-frame'], ['onScreenEnded', 'asscrack:screen-ended'], ['onScreenGuard', 'asscrack:screen-guard']]) {
        const got = [];
        b.api[name](value => got.push(value));
        b.emit(channel, { marker: name });
        assert.deepEqual(got, [{ marker: name }], name);
    }
    const stops = [];
    b.worlds.roomVoiceMonitor.onStopShare(value => stops.push(value));
    b.emit('asscrack:voice-monitor-stop-share', true);
    assert.deepEqual(stops, [true]);
});

// 1.0.4: the automatic status: the own state after an automatic change, and the two settings (no other field).
test('the automatic status calls send the channel and only the two settings', async () => {
    const b = loadBridge();
    b.api.getAutoStatus();
    b.api.setAutoStatus({ awayMinutes: 5, dndFullscreen: true, idleMs: 1 });
    b.api.setAutoStatus({ awayMinutes: 0 });
    assert.deepEqual(JSON.parse(JSON.stringify(b.invoked)), [
        ['asscrack:auto-status'],
        ['asscrack:set-auto-status', { awayMinutes: 5, dndFullscreen: true }],
        ['asscrack:set-auto-status', { awayMinutes: 0 }]
    ]);
    const got = [];
    b.api.onOwnPresence(value => got.push(value));
    b.emit('asscrack:own-presence', { state: 'away', note: '' });
    assert.deepEqual(got, [{ state: 'away', note: '' }]);
});

test('the What\'s new calls send their IPC channel with no argument', () => {
    const b = loadBridge();
    b.api.getWhatsNew('C:\secret');
    b.api.whatsNewDone('1.0.5');
    assert.deepEqual(b.invoked, [['asscrack:whats-new'], ['asscrack:whats-new-done']]);
});
