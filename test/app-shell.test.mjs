// G5, the Windows app shell in the room window: the taskbar flash of E1 (attention.js), the title counts of E7
// (title.js, highlights.js, whispers.js), the Leave room dialog of A7 and the Quit dialog of N6 (app-shell.js).
// The real scripts run in the fake DOM of test/helpers/renderer-fixture.mjs. All results are 127.0.0.1 results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createClock } from './helpers/fake-clock.mjs';

const SELF = 'self-peer-id';
const SAM = '12D3KooWsamAAAAAAaaaa01';
const ALEX = '12D3KooWalexBBBBBbbbb02';

const ATTENTION = [
    { id: 'attention-settings', tag: 'dialog', children: [
        { id: 'attention-cues', tag: 'input' }, { id: 'attention-other-cues', tag: 'input' },
        { id: 'attention-message-cues', tag: 'input' }, { id: 'attention-volume', tag: 'input' },
        { id: 'attention-percent', tag: 'output' }, { id: 'attention-tone', tag: 'select', value: 'join' },
        { id: 'attention-preview', tag: 'button' }, { id: 'attention-alerts', tag: 'input' },
        { id: 'attention-windows', tag: 'p' }, { id: 'attention-content', tag: 'input' },
        { id: 'attention-sound', tag: 'input' }, { id: 'attention-status', tag: 'p' },
        { id: 'attention-flash', tag: 'input' }
    ] }
];
const WHISPERS = ['pane', 'title', 'picker', 'open', 'close', 'peer', 'draft', 'lines', 'status', 'send']
    .map(name => ({ id: 'whisper-' + name, hidden: name === 'pane' }));
const SHELL = [
    { id: 'room-options' }, { id: 'leave-room', tag: 'button' },
    { id: 'leave-dialog', tag: 'dialog', children: [
        { id: 'leave-text', tag: 'p' }, { id: 'leave-transfers', tag: 'p', hidden: true }, { id: 'leave-status', tag: 'p' },
        { id: 'leave-confirm', tag: 'button' }
    ] },
    { id: 'quit-dialog', tag: 'dialog', children: [{ id: 'quit-text', tag: 'p' }, { id: 'quit-confirm', tag: 'button' }] },
    { id: 'about-dialog', tag: 'dialog', children: [
        { id: 'about-version', tag: 'p' }, { id: 'about-runtime', tag: 'p' }, { id: 'about-log', tag: 'p', hidden: true },
        { id: 'about-status', tag: 'p' }, { id: 'about-copy', tag: 'button' }, { id: 'about-data', tag: 'button' }
    ] },
    { id: 'shortcuts-dialog', tag: 'dialog', children: [{ id: 'shortcuts-list', tag: 'tbody' }] }
];

// prefs: changes to the defaults of attention.mjs. api: more bridge calls. Returns the fixture after the login of
// Parker, with Sam and Alex in the room.
async function room(prefs = {}, api = {}) {
    const clock = createClock();
    const settings = { voiceCues: true, voiceSound: true, mentionSound: true, whisperSound: true, friendSound: true, volume: 35, mentionAlert: false, whisperAlert: false, friendAlert: false,
        previews: false, sound: false, flash: true, ...prefs };
    const f = await loadRoomWindow({
        clock,
        elements: [...ATTENTION, ...WHISPERS, ...SHELL],
        scripts: ['attention.js', 'whispers.js', 'title.js', 'app-shell.js'],
        globals: {
            navigator: { userAgent: 'test' },
            AudioContext: class { state = 'running'; destination = {}; async resume() {} },
            CSS: { escape: s => s },
            crypto: { randomUUID: () => 'uuid' }
        },
        api: {
            getAttentionSettings: async () => ({ ...settings }),
            setAttentionSettings: async patch => Object.assign(settings, patch) && { ...settings },
            setPresence: async value => value,
            getWhisperPeers: async () => [],
            ...api
        }
    });
    for (const id of ['leave-dialog', 'quit-dialog', 'about-dialog', 'shortcuts-dialog']) {
        const dialog = f.el(id);
        dialog.open = false;
        dialog.showModal = () => { dialog.open = true; };
        dialog.close = () => { dialog.open = false; };
    }
    const state = { idle: false, focus: true };
    f.window.voiceCues = { play: () => true };
    f.window.idlePeer = { isIdle: () => state.idle };
    f.document.hasFocus = () => state.focus;
    f.document.visibilityState = 'visible';
    const titleAtLogin = f.document.title;
    await f.login('Parker');
    for (const [peerId, name] of [[SAM, 'Sam'], [ALEX, 'Alex']]) {
        f.handlers.onPeerJoined({ peerId });
        f.handlers.onPeerName({ peerId, name });
    }
    Object.assign(f, {
        clock, state, settings, titleAtLogin,
        flashes: () => f.calls.filter(c => c.name === 'flashAttention').length,
        async dnd() {
            f.el('presence-state').value = 'dnd';
            f.el('presence-set').click();
            await settle();
        }
    });
    return f;
}

// ---- E1: the taskbar flash uses wanted(target) and its own setting ----

test('a mention outside my view sends the flash with alerts off; a whisper outside its view sends it too', async () => {
    const f = await room({ mentionAlert: false, whisperAlert: false, friendAlert: false });
    f.state.focus = false;
    f.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'm1' });
    assert.equal(f.flashes(), 1);
    f.window.roomAttention.incoming({ kind: 'whisper', peerId: SAM, id: 'w1' });
    assert.equal(f.flashes(), 2);
    assert.deepEqual(f.errors, []);
});

test('no flash: in Do not disturb, in Idle Peer, for my own line, for a conversation in view, for no match', async () => {
    const view = await room();
    view.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'v1' });
    assert.equal(view.flashes(), 0, 'the line is in view and the window has the focus');
    view.state.focus = false;
    view.receive({ from: 'Parker', text: 'Parker here', peerId: SELF, id: 'o1' });
    assert.equal(view.flashes(), 0, 'my own line');
    view.receive({ from: 'Sam', text: 'hello all', peerId: SAM, id: 'n1' });
    assert.equal(view.flashes(), 0, 'no match');
    assert.equal(view.window.roomAttention.wanted({ kind: 'mention', channelId: 'general', id: 'x', from: SELF }), false);
    assert.equal(view.window.roomAttention.wanted({ kind: 'mention', channelId: 'general', id: 'x', from: SAM }), true);

    const dnd = await room();
    dnd.state.focus = false;
    await dnd.dnd();
    dnd.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'd1' });
    dnd.window.roomAttention.incoming({ kind: 'whisper', peerId: SAM, id: 'd2' });
    assert.equal(dnd.flashes(), 0, 'Do not disturb');
    assert.equal(dnd.window.roomAttention.wanted({ kind: 'mention', channelId: 'general', id: 'x', from: SAM }), false);

    const idle = await room();
    idle.state.focus = false;
    idle.state.idle = true;
    idle.window.roomAttention.incoming({ kind: 'whisper', peerId: SAM, id: 'i1' });
    assert.equal(idle.window.roomAttention.wanted({ kind: 'mention', channelId: 'general', id: 'x', from: SAM }), false);
    assert.equal(idle.flashes(), 0, 'Idle Peer');
});

test('the flash setting off sends no flash', async () => {
    const f = await room({ flash: false });
    f.state.focus = false;
    f.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'm1' });
    f.window.roomAttention.incoming({ kind: 'whisper', peerId: SAM, id: 'w1' });
    assert.equal(f.flashes(), 0);
    // The box of the dialog shows the setting and changes it.
    assert.equal(f.el('attention-flash').checked, false);
    f.el('attention-flash').checked = true;
    f.el('attention-flash').dispatchEvent(new f.Event('change'));
    await settle();
    assert.equal(f.settings.flash, true);
    f.receive({ from: 'Sam', text: 'Parker again', peerId: SAM, id: 'm2' });
    assert.equal(f.flashes(), 1);
});

// ---- E7: the window title ----

test('the title is ASSCRACK at login, "<room> – ASSCRACK" in a room, and counts highlights of all channels and whispers', async () => {
    const f = await room();
    assert.equal(f.titleAtLogin, 'ASSCRACK');
    assert.equal(f.document.title, 'test – ASSCRACK');
    // A highlight in view with the focus does not count.
    f.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'v1' });
    assert.equal(f.document.title, 'test – ASSCRACK');
    // A highlight with no focus counts.
    f.state.focus = false;
    f.receive({ from: 'Sam', text: 'Parker, look', peerId: SAM, id: 'h1' });
    assert.equal(f.document.title, '(1) test – ASSCRACK');
    // A highlight row in a channel that is not selected (its list is not #messages) counts too.
    const otherList = f.document.createElement('ul');
    const row = f.document.createElement('li');
    const text = f.document.createElement('span');
    text.className = 'text';
    row.append(text);
    otherList.append(row);
    f.window.chatHighlights.note(row, 'Parker in #paddock', true);
    assert.equal(f.document.title, '(2) test – ASSCRACK');
    assert.equal(f.el('next-highlight').textContent, 'Next highlight (1)', 'the button counts only the open channel');
    // An unread whisper counts.
    f.handlers.onWhisper({ peerId: ALEX, text: 'psst', id: 'w1' });
    assert.equal(f.document.title, '(3) test – ASSCRACK');
    // Open the whisper: it is read.
    f.window.whispers.open(ALEX);
    assert.equal(f.document.title, '(2) test – ASSCRACK');
    // The open channel is read.
    f.window.chatHighlights.clearUnread();
    assert.equal(f.document.title, '(1) test – ASSCRACK');
    // A row that leaves its list does not count.
    row.remove();
    f.window.chatHighlights.updateCount();
    assert.equal(f.document.title, 'test – ASSCRACK');
    assert.deepEqual(f.errors, []);
});

test('in Do not disturb a highlight counts; in Idle Peer nothing changes', async () => {
    const dnd = await room();
    dnd.state.focus = false;
    await dnd.dnd();
    dnd.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'd1' });
    assert.equal(dnd.document.title, '(1) test – ASSCRACK');
    const idle = await room();
    idle.state.focus = false;
    idle.state.idle = true;
    idle.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'i1' });
    idle.handlers.onWhisper({ peerId: ALEX, text: 'psst', id: 'w1' });
    assert.equal(idle.document.title, 'test – ASSCRACK');
});

// ---- A7: Leave room ----

// A transfer of this computer in the state sending: a progress event of an offer that I send.
function sending(f, offerId) {
    f.handlers.onFileProgress({ offerId, peerId: SAM, direction: 'send', name: offerId + '.zip', size: 1000, bytes: 10 });
}

test('the Leave room dialog has the text of each room case, and one more line for the active transfers', async () => {
    let info = { saved: true, owner: true };
    const f = await room({}, { leaveRoomInfo: async () => info });
    f.el('leave-room').click();
    await settle();
    assert.equal(f.el('leave-dialog').open, true);
    assert.equal(f.el('leave-text').textContent,
        'Leave room? It stays in Saved rooms.');
    assert.equal(f.el('leave-transfers').hidden, true);
    f.el('leave-dialog').close();

    info = { saved: false, owner: false };
    await f.window.appShell.openLeave();
    assert.equal(f.el('leave-text').textContent,
        'Leave room? It isn\'t saved. You\'ll need the invite to rejoin.');
    f.el('leave-dialog').close();

    info = { saved: false, owner: true };
    sending(f, 'one');
    await f.window.appShell.openLeave();
    assert.equal(f.el('leave-text').textContent,
        'Leave room? It isn\'t saved, so you can\'t reopen it as owner.');
    assert.equal(f.el('leave-transfers').hidden, false);
    assert.equal(f.el('leave-transfers').textContent, '1 transfer will stop.');
    f.el('leave-dialog').close();

    sending(f, 'two');
    await f.window.appShell.openLeave();
    assert.equal(f.el('leave-transfers').textContent, '2 transfers will stop.');
    // A transfer that ended does not count.
    f.handlers.onFileDone({ offerId: 'one', peerId: SAM, direction: 'send', confirmed: true });
    assert.equal(f.window.roomTransfers.activeCount(), 1);
    assert.deepEqual(f.errors, []);
});

test('Leave room calls leaveRoom of the bridge one time; a failure keeps the dialog open with a text', async () => {
    let result = false;
    let calls = 0;
    const f = await room({}, { leaveRoomInfo: async () => ({ saved: true }), leaveRoom: async () => { calls++; return result; } });
    await f.window.appShell.openLeave();
    f.el('leave-confirm').click();
    f.el('leave-confirm').click();
    await settle();
    assert.equal(calls, 1, 'a second click while the first one runs does nothing');
    assert.equal(f.el('leave-status').textContent, "Couldn't leave the room.");
    assert.equal(f.el('leave-confirm').disabled, false);
    result = true;
    f.el('leave-confirm').click();
    await settle();
    assert.equal(calls, 2);
    assert.equal(f.el('leave-confirm').disabled, true, 'the main process reloads the window');
});

// ---- N6: View, Quit with active transfers ----

test('View, Quit with no active transfer quits at once; with active transfers it asks first', async () => {
    const f = await room();
    const quits = () => f.calls.filter(c => c.name === 'quit').length;
    f.window.appShell.quit();
    assert.equal(quits(), 1);
    assert.equal(f.el('quit-dialog').open, false);
    sending(f, 'one');
    sending(f, 'two');
    f.window.appShell.quit();
    assert.equal(quits(), 1, 'no quit before the answer');
    assert.equal(f.el('quit-dialog').open, true);
    assert.equal(f.el('quit-text').textContent, 'Quit? 2 transfers will stop.');
    f.el('quit-confirm').click();
    assert.equal(quits(), 2);
    assert.equal(f.el('quit-dialog').open, false);
});

// ---- E3 and E6: About and Keyboard shortcuts ----

test('About shows the version values of the main process; the shortcuts list has the push-to-talk key', async () => {
    const f = await room({}, {
        getAbout: async () => ({ version: '9.8.7', electron: '40.1.0', chromium: '144.0.1', system: 'Windows 10.0.19045', debugLog: true }),
        getVoiceSettings: async () => ({ pttKey: null }),
        copyText: async () => true
    });
    await f.window.appShell.openAbout();
    assert.equal(f.el('about-version').textContent, 'ASSCRACK 9.8.7');
    assert.equal(f.el('about-runtime').textContent, 'Electron 40.1.0 · Chromium 144.0.1 · Windows 10.0.19045');
    assert.equal(f.el('about-log').hidden, false);
    await f.window.appShell.openShortcuts();
    const rows = f.el('shortcuts-list').children.map(tr => tr.children.map(cell => cell.textContent));
    assert.deepEqual(rows.map(([key]) => key), ['Enter', 'Shift+Enter', 'Ctrl+F', 'F3 and Shift+F3', 'Escape', 'Alt+J',
        'Up and Down', 'Tab', 'Ctrl+Shift+M', 'Ctrl+Shift+D', 'Shift+F10 and the Menu key', 'Arrow keys', 'F1', 'Not set']);
    // F1 opens the dialog.
    f.el('shortcuts-dialog').close();
    f.key(f.document, 'F1');
    await settle();
    assert.equal(f.el('shortcuts-dialog').open, true);
    assert.deepEqual(f.errors, []);
});
