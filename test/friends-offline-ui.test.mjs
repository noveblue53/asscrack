// G7b check 3: the window part of the friends offline goal. The friend chat window (the away note and marks, the waiting
// lines and Delete), the availability texts of the Friends panel, the 'friend' kind in wanted() of attention.js (with
// test/helpers/renderer-fixture.mjs), and the friend notification of attention.mjs. No network, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom } from './helpers/fake-dom.mjs';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createAttention, friendNotice } from '../src/application/attention.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// The chat window with a stub bridge. lines: the first page. Returns the DOM, the bridge events and the calls.
async function chatWindow({ state, lines = [], send = { result: 'unavailable' }, deleteResult = 'deleted' }) {
    const source = await readFile(new URL('../src/application/friend-chat.js', import.meta.url), 'utf8');
    const ids = ['friend-name', 'friend-state', 'friend-reach', 'older', 'messages', 'send-status', 'composer', 'message-input'];
    const { document, window, Event } = createDom(ids.map(id => ({ id, tag: id === 'messages' ? 'ul' : id === 'composer' ? 'form' : 'div' })));
    const on = {}, calls = [];
    const box = { send };
    window.friendChat = {
        state: async () => state,
        lines: async before => (before ? [] : lines),
        send: async text => { calls.push(['send', text]); return box.send; },
        deleteWaiting: async id => { calls.push(['delete', id]); return deleteResult; },
        onLine: fn => { on.line = fn; }, onReceipt: fn => { on.receipt = fn; }, onState: fn => { on.state = fn; }
    };
    window.localStorage = { getItem: () => null };
    window.window = window;
    vm.runInNewContext(source, { window, document, console, Promise, localStorage: window.localStorage, Date });
    await window.friendChatReady;
    const list = document.getElementById('messages');
    const rows = () => list.children.map(row => ({
        kind: row.dataset.kind ?? 'line', text: row.dataset.kind ? row.textContent : row.querySelector('.text')?.textContent,
        away: row.querySelector('.away-mark')?.textContent ?? null, mark: row.querySelector('.mark')?.textContent ?? null,
        button: row.querySelector('button')?.textContent ?? null
    }));
    async function type(text) {
        const input = document.getElementById('message-input');
        input.value = text;
        input.dispatchEvent(new Event('keydown', { key: 'Enter' }));
        await tick();
    }
    return { document, window, on, calls, rows, type, box, list, status: () => document.getElementById('send-status').textContent };
}

test('chat window: one away note before each batch, the mark on each away line, and no button on the note', async () => {
    const b1 = { batch: 'b1', count: 2 }, b2 = { batch: 'b2', count: 1 };
    const w = await chatWindow({
        state: { name: 'Ben', state: 'online', lastSeen: 1, reach: 'local' },
        lines: [
            { id: 'x.0', from: 'Ben', text: 'before', time: 1000, own: false },
            { id: 'x.1', from: 'Ben', text: 'away one', time: 2000, own: false, away: b1 },
            { id: 'x.2', from: 'Ben', text: 'away two', time: 3000, own: false, away: b1 },
            { id: 'me.1', from: 'Ann', text: 'mine', time: 4000, own: true },
            { id: 'x.3', from: 'Ben', text: 'away three', time: 5000, own: false, away: b2 }
        ]
    });
    const NOTE = 'sent while you were away';
    assert.deepEqual(w.rows().map(r => [r.kind, r.text, r.away]), [
        ['line', 'before', null],
        ['away', 'Ben sent 2 messages while you were away.', null],
        ['line', 'away one', NOTE], ['line', 'away two', NOTE],
        ['line', 'mine', null],
        ['away', 'Ben sent a message while you were away.', null],
        ['line', 'away three', NOTE]
    ]);
    assert.ok(w.rows().filter(r => r.kind === 'away').every(r => r.button === null), 'a note row has no button');
    // A live batch: the note comes before its first line, and its count grows with each line.
    w.on.line({ id: 'x.4', from: 'Ben', text: 'live away 1', time: 6000, own: false, away: { batch: 'b3', count: 1 } });
    w.on.line({ id: 'x.5', from: 'Ben', text: 'live away 2', time: 7000, own: false, away: { batch: 'b3', count: 2 } });
    w.on.line({ id: 'x.6', from: 'Ben', text: 'live now', time: 8000, own: false });
    assert.deepEqual(w.rows().slice(-4).map(r => [r.kind, r.text, r.away]), [
        ['away', 'Ben sent 2 messages while you were away.', null],
        ['line', 'live away 1', NOTE], ['line', 'live away 2', NOTE], ['line', 'live now', null]
    ]);
});

test('chat window: a waiting line shows "Waiting" and Delete; Delivered removes Delete; the 200 limit; removed you', async () => {
    const w = await chatWindow({
        state: { name: 'Ben', state: 'offline', lastSeen: null, reach: 'local' },
        lines: [{ id: 'me.0', from: 'Ann', text: 'old waiting', time: 1000, own: true, waiting: true }]
    });
    // UI copy pass (U14): a waiting line shows a clock icon; the words are the tooltip of the mark.
    const WAITING = '';
    assert.equal(w.document.getElementById('friend-state').textContent, 'Offline. Messages send when you\'re both online.');
    assert.deepEqual(w.rows().map(r => [r.text, r.mark, r.button]), [['old waiting', WAITING, 'Delete']]);
    assert.equal(w.list.children[0].querySelector('.mark').title, "Queued. Sends when you're both online");
    // A new line with no session waits too; the composer is empty.
    w.box.send = { result: 'waiting', line: { id: 'me.1', from: 'Ann', text: 'new waiting', time: 2000, own: true, waiting: true } };
    await w.type('new waiting');
    assert.equal(w.document.getElementById('message-input').value, '');
    assert.equal(w.status(), '');
    assert.deepEqual(w.rows().map(r => [r.text, r.mark, r.button]), [['old waiting', WAITING, 'Delete'], ['new waiting', WAITING, 'Delete']]);
    // Delete removes the row (the main process deletes the queue row).
    w.list.children[0].querySelector('button').click();
    await tick();
    assert.deepEqual(w.calls.filter(c => c[0] === 'delete'), [['delete', 'me.0']]);
    assert.deepEqual(w.rows().map(r => r.text), ['new waiting']);
    // The friend comes online and acknowledges the line.
    w.on.receipt({ id: 'me.1', result: 'delivered' });
    assert.deepEqual(w.rows().map(r => [r.mark, r.button]), [['Delivered', null]]);
    // 200 lines wait: the 201st is refused and the draft stays.
    w.box.send = { result: 'full' };
    await w.type('number 201');
    assert.equal(w.status(), 'Too many unsent messages for Ben. Try again when Ben is online.');
    assert.equal(w.document.getElementById('message-input').value, 'number 201');
    // After 'unfriend' from the other side, a waiting line is not delivered.
    w.box.send = { result: 'waiting', line: { id: 'me.2', from: 'Ann', text: 'too late', time: 3000, own: true, waiting: true } };
    await w.type('too late');
    w.on.state({ name: 'Ben', state: 'removed-you', lastSeen: 1, reach: 'local' });
    assert.deepEqual(w.rows().at(-1).mark, 'Not delivered: Ben removed you as a friend.');
    assert.equal(w.rows().at(-1).button, 'Delete');
    w.box.send = { result: 'removed' };
    await w.type('again');
    assert.equal(w.status(), 'Not sent: Ben removed you as a friend.');
});

test('chat window: Delete of a line that goes out now keeps the row and says why', async () => {
    const w = await chatWindow({
        state: { name: 'Ben', state: 'online', lastSeen: 1, reach: 'local' },
        lines: [{ id: 'me.0', from: 'Ann', text: 'in flight', time: 1000, own: true, waiting: true }], deleteResult: 'sending'
    });
    w.list.children[0].querySelector('button').click();
    await tick();
    assert.equal(w.rows().length, 1);
    assert.equal(w.status(), 'Already sending. Can\'t delete.');
});

test('the availability texts of the Friends panel and of the chat window', async () => {
    const panelSource = await readFile(new URL('../src/application/friends-ui.js', import.meta.url), 'utf8');
    const chatSource = await readFile(new URL('../src/application/friend-chat.js', import.meta.url), 'utf8');
    const window = {};
    vm.runInNewContext(panelSource, { window, Date });
    vm.runInNewContext(chatSource, { window, Date });
    const panel = window.friendsCore.stateText, chat = window.friendChatCore.stateText;
    const cases = [
        [{ state: 'online', availability: null }, 'Online'],
        [{ state: 'online', availability: 'away', note: '' }, 'Online · Away'],
        [{ state: 'online', availability: 'dnd', note: '' }, 'Online · Do not disturb'],
        [{ state: 'online', availability: 'idle', note: '' }, 'Online · Idle Peer'],
        [{ state: 'online', availability: 'away', note: 'lunch' }, 'Online · Away · lunch'],
        [{ state: 'room', roomName: 'Game night' }, 'Online · in Game night']
    ];
    for (const [friend, text] of cases) {
        assert.equal(panel({ name: 'Ben', ...friend }), text);
        assert.equal(chat({ name: 'Ben', ...friend }), text);
    }
});

// ---- The 'friend' kind in wanted() (attention.js in the room window fixture) ----

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

async function attentionWindow() {
    const on = {};
    const settings = { voiceCues: true, otherVoiceCues: true, messageCues: true, volume: 35, alerts: true,
        previews: false, sound: false, flash: true };
    const f = await loadRoomWindow({
        elements: ATTENTION,
        scripts: ['attention.js'],
        globals: {
            navigator: { userAgent: 'test' },
            AudioContext: class { state = 'running'; destination = {}; async resume() {} },
            CSS: { escape: s => s }
        },
        window: { friends: { onAttention: fn => { on.attention = fn; } } },
        api: { getAttentionSettings: async () => ({ ...settings }), setPresence: async value => value }
    });
    const state = { idle: false };
    let cues = 0;
    f.window.voiceCues = { play: () => { cues += 1; return true; } };
    f.window.idlePeer = { isIdle: () => state.idle };
    f.document.hasFocus = () => true;
    f.document.visibilityState = 'visible';
    await settle();
    // A plain copy (the objects come from the vm realm).
    const notices = () => f.calls.filter(c => c.name === 'addAttention').map(c => JSON.parse(JSON.stringify(c.args[0])));
    return { f, on, state, notices, cues: () => cues };
}

test("wanted(): a friend line is wanted on the login screen and in a room, but not in DND, not in Idle Peer, and not when its chat window has the focus", async () => {
    const w = await attentionWindow();
    const line = (id, extra = {}) => ({ friendId: 'f1', id, away: 0, focused: false, ...extra });
    // The login screen: the room window has the focus, but the line is in its own chat window.
    w.on.attention(line('l1'));
    await settle();
    assert.equal(w.notices().length, 1);
    assert.deepEqual(w.notices()[0], { kind: 'friend', friendId: 'f1', id: 'l1', away: 0 });
    assert.equal(w.cues(), 1, 'the message cue of P11');
    // The chat window of that friend has the focus: no notification and no cue.
    w.on.attention(line('l2', { focused: true }));
    await settle();
    assert.equal(w.notices().length, 1);
    assert.equal(w.f.window.roomAttention.wanted({ kind: 'friend', friendId: 'f1', id: 'x', focused: true }), false);
    assert.equal(w.f.window.roomAttention.wanted({ kind: 'friend', friendId: 'f1', id: 'x', focused: false }), true);
    // One batch of away lines: one notification with the count.
    w.on.attention(line('batch-1', { away: 3 }));
    await settle();
    assert.equal(w.notices().at(-1).away, 3);
    // In a room with Do not disturb: none.
    await w.f.login('Parker');
    w.f.el('presence-state').value = 'dnd';
    w.f.el('presence-set').click();
    await settle();
    const before = w.notices().length;
    w.on.attention(line('l3'));
    await settle();
    assert.equal(w.notices().length, before, 'Do not disturb');
    assert.equal(w.f.window.roomAttention.wanted({ kind: 'friend', friendId: 'f1', id: 'x', focused: false }), false);
    w.f.el('presence-state').value = 'available';
    w.f.el('presence-set').click();
    await settle();
    // Idle Peer: none.
    w.state.idle = true;
    w.on.attention(line('l4'));
    await settle();
    assert.equal(w.notices().length, before, 'Idle Peer');
    w.state.idle = false;
    w.on.attention(line('l5'));
    await settle();
    assert.equal(w.notices().length, before + 1, 'available again');
    assert.deepEqual(w.f.errors, []);
});

// ---- The friend notification of the main process (attention.mjs) ----

test('attention.mjs: a friend notification needs no room, has the name, and one notice for a batch of away lines', () => {
    const shown = [], timers = [];
    const notice = options => {
        const handlers = {};
        const n = { options, once: (name, fn) => { handlers[name] = fn; }, show() { shown.push(options); }, close() {}, handlers };
        return n;
    };
    let quiet = false;
    const attention = createAttention({
        settings: () => ({ alerts: true, previews: false, sound: false }), room: () => null, quiet: () => quiet,
        allowed: target => target.kind === 'friend' && target.friendId === 'f1', notify: notice, navigate: () => {},
        friendName: id => (id === 'f1' ? 'Ben' : ''),
        schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {}
    });
    attention.add({ kind: 'friend', friendId: 'f1', id: 'batch', away: 3 });
    timers.shift()();
    assert.deepEqual(shown.map(o => o.body), ['Ben sent you 3 messages while you were away.']);
    attention.add({ kind: 'friend', friendId: 'f1', id: 'l1', away: 0 });
    attention.add({ kind: 'friend', friendId: 'f1', id: 'l2', away: 0 });
    timers.shift()();
    assert.equal(shown.at(-1).body, '2 new private messages from Ben');
    // Not a friend of this device, or quiet (DND or Idle Peer in main.js): nothing.
    attention.add({ kind: 'friend', friendId: 'other', id: 'l3', away: 0 });
    quiet = true;
    attention.add({ kind: 'friend', friendId: 'f1', id: 'l4', away: 0 });
    assert.equal(timers.length, 0);
    assert.equal(friendNotice('Ben', 1, 1), 'Ben sent you a message while you were away.');
    assert.equal(friendNotice('Ben', 1, 0), 'New private message from Ben');
});
