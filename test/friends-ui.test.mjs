// G7a check 4: the window part of Friends (friends-ui.js, friend-requests-ui.js, friend-chat.js) with a stub bridge.
// No network, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createDom } from './helpers/fake-dom.mjs';

const panel = { id: 'friends-panel', children: [
    { id: 'friends-close', tag: 'button' }, { id: 'friends-locked', tag: 'p' }, { id: 'friends-retry', tag: 'button' },
    { id: 'friends-empty', tag: 'p' }, { id: 'friend-list', tag: 'ul' }, { id: 'friend-waiting', tag: 'ul' },
    { id: 'friends-settings', children: [{ id: 'friends-reach', tag: 'p' }, { id: 'friends-upnp', tag: 'button' },
        { id: 'friends-name', tag: 'span' }, { id: 'friends-name-change', tag: 'button' },
        { id: 'friends-blocked', children: [{ id: 'friend-blocked-list', tag: 'ul' }] }] },
    { id: 'friends-status', tag: 'p' }
] };
const ELEMENTS = [panel, { id: 'friends-toggle', tag: 'button', children: [{ id: 'friends-unread', tag: 'span' }] },
    { id: 'friend-request-bar', hidden: true, children: [{ id: 'friend-request-text', tag: 'p' },
        { id: 'friend-request-accept', tag: 'button' }, { id: 'friend-request-decline', tag: 'button' }] },
    { id: 'friend-confirm', tag: 'dialog', children: [{ id: 'friend-confirm-text', tag: 'p' }, { id: 'friend-confirm-yes', tag: 'button' }] },
    { id: 'friend-name-dialog', tag: 'dialog', children: [{ id: 'friend-name-form', tag: 'form', children: [
        { id: 'friend-name-title' }, { id: 'friend-name-input', tag: 'input' }, { id: 'friend-name-error' },
        { id: 'friend-name-cancel', tag: 'button' }, { id: 'friend-name-save', tag: 'button' }] }] }];

function stubFriends(view, relations = {}) {
    const calls = [], on = {};
    const api = {
        list: async () => view,
        relations: async ids => Object.fromEntries(ids.filter(id => relations[id]).map(id => [id, relations[id]])),
        request: async peerId => { calls.push(['request', peerId]); return { result: 'sent', name: 'Sam' }; },
        respond: async (id, accept) => { calls.push(['respond', id, accept]); return true; },
        openChat: async id => { calls.push(['openChat', id]); return true; },
        remove: async id => { calls.push(['remove', id]); return true; },
        block: async id => { calls.push(['block', id]); return true; },
        unblock: async id => { calls.push(['unblock', id]); return true; },
        rename: async () => true, setName: async () => 'Ann', setUpnp: async on2 => { calls.push(['upnp', on2]); return on2; },
        retry: async () => ({}),
        onChanged: fn => { on.changed = fn; }, onRequest: fn => { on.request = fn; }
    };
    return { api, calls, on };
}
const open = (extra = {}) => ({ state: 'open', cap: 16, count: 0, name: null, upnp: false, reach: 'local',
    friends: [], waiting: [], blocked: [], ...extra });

async function load(view, relations) {
    const friends = stubFriends(view, relations);
    const room = await loadRoomWindow({ elements: ELEMENTS, scripts: ['friends-ui.js', 'friend-requests-ui.js'],
        window: { friends: friends.api } });
    await settle();
    return { room, ...friends };
}
const rowTexts = room => room.el('friend-list').children.map(r => r.querySelector('.friend-state').textContent);

test('Friends panel: the empty, the locked and the list states, the reach line and the Blocked section', async () => {
    const { room, on } = await load(open());
    assert.equal(room.el('friends-empty').hidden, false);
    // The fixed texts are in index.html.
    const html = await readFile(new URL('../src/application/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('No friends yet. Right-click someone in a room to add them.'));
    assert.ok(html.includes('Friends are locked: secure storage is unavailable.'));
    // UI copy pass (U13): a dot and a short label; the tooltip has the reason.
    assert.equal(room.el('friends-reach').textContent, 'LAN only');
    assert.equal(room.el('friends-reach').title, 'Friends elsewhere need an open port on one side');
    assert.equal(room.el('friends-reach').dataset.reach, 'warn');
    assert.equal(room.el('friends-upnp').hidden, false);
    assert.equal(room.el('friends-name').textContent, 'your room name');
    on.changed({ state: 'locked' });
    assert.equal(room.el('friends-locked').hidden, false);
    assert.equal(room.el('friends-retry').hidden, false);
    assert.equal(room.el('friends-settings').hidden, true);
    const lastSeen = new Date(2026, 10, 21, 21, 4).getTime();
    on.changed(open({ reach: 'reachable', name: 'Ann', upnp: true, count: 4,
        friends: [
            { friendId: 'f1', name: 'Ben', state: 'online', lastSeen, unread: 2 },
            { friendId: 'f2', name: 'Cat', state: 'offline', lastSeen, unread: 0 },
            { friendId: 'f3', name: 'Dan', state: 'offline', lastSeen: null, unread: 0 },
            { friendId: 'f4', name: 'Eve', state: 'removed-you', lastSeen, unread: 0 }],
        waiting: [{ name: 'Sam' }], blocked: [{ deviceId: 'd9', name: 'Zed' }] }));
    assert.equal(room.el('friends-locked').hidden, true);
    assert.equal(room.el('friends-empty').hidden, true);
    const states = rowTexts(room);
    assert.equal(states[0], 'Online');
    assert.match(states[1], /^Offline · last seen (21:04|\d+ \w+ 21:04)$/);
    assert.equal(states[2], 'Offline');
    assert.equal(states[3], 'Removed you as a friend');
    // U15: the name and a "Pending" tag; the tooltip of the tag has the sentence.
    assert.equal(room.el('friend-waiting').children[0].textContent, 'Sam Pending');
    assert.equal(room.el('friend-waiting').children[0].querySelector('.state-tag').title, 'Waiting for Sam to accept');
    assert.equal(room.el('friends-reach').textContent, 'Reachable');
    assert.equal(room.el('friends-reach').dataset.reach, 'ok');
    assert.equal(room.el('friends-upnp').hidden, true);
    assert.equal(room.el('friends-name').textContent, 'Ann');
    assert.equal(room.el('friends-blocked').hidden, false);
    assert.equal(room.el('friend-blocked-list').children[0].textContent.includes('Zed'), true);
    assert.equal(room.el('friends-unread').textContent, '2');
    assert.equal(room.window.friendsCore.reachText('asking'), 'Opening port…');
});

test('Friends panel: a click opens the chat; the row menu asks before Remove and Block', async () => {
    const { room, calls } = await load(open({ friends: [{ friendId: 'f1', name: 'Ben', state: 'online', lastSeen: 1, unread: 0 }] }));
    const row = room.el('friend-list').children[0];
    row.click();
    await settle();
    assert.deepEqual(calls.at(-1), ['openChat', 'f1']);
    // The array comes from the vm context: compare the JSON text.
    assert.equal(JSON.stringify(room.window.menuCore.actionsFor(room.window.roomActions.rowInfo(row))),
        JSON.stringify(['friend-open', 'friend-rename', 'friend-remove', 'friend-block']));
    assert.deepEqual(['friend-open', 'friend-rename', 'friend-remove', 'friend-block'].map(a => room.window.menuCore.label(a)),
        ['Open chat', 'Rename…', 'Remove friend…', 'Block…']);
    room.window.roomActions.run('friend-remove', row);
    assert.equal(room.el('friend-confirm-text').textContent,
        'Remove Ben? Your messages with Ben are deleted from this PC.');
    room.el('friend-confirm-yes').click();
    await settle();
    assert.deepEqual(calls.at(-1), ['remove', 'f1']);
    room.window.roomActions.run('friend-block', row);
    assert.equal(room.el('friend-confirm-text').textContent, 'Block Ben? They\'re removed and can\'t send you requests.');
});

test('the friend request bar: the text, Accept and the end texts in the status line', async () => {
    const { room, on, calls } = await load(open());
    await room.login('Me');
    on.request({ kind: 'incoming', id: 'r1', name: 'Sam' });
    assert.equal(room.el('friend-request-bar').hidden, false);
    assert.equal(room.el('friend-request-text').textContent, 'Sam wants to be friends. Accepting shares your IP address with Sam.');
    room.el('friend-request-accept').click();
    await settle();
    assert.deepEqual(calls.at(-1), ['respond', 'r1', true]);
    assert.equal(room.el('friend-request-bar').hidden, true);
    for (const [result, text] of [['friend', 'Sam is now your friend.'], ['declined', 'Sam declined.'], ['no-answer', 'No answer from Sam.']]) {
        on.request({ kind: 'ended', side: 'out', id: 'x', name: 'Sam', result });
        assert.equal(room.el('status').textContent, text);
    }
    // A request that ends (120 s or the session close) removes its bar.
    on.request({ kind: 'incoming', id: 'r2', name: 'Kim' });
    on.request({ kind: 'ended', side: 'in', id: 'r2', name: 'Kim', result: 'no-answer' });
    assert.equal(room.el('friend-request-bar').hidden, true);
});

test('the buddy menu: "Add friend…" only in a protected room, "Open friend chat" for a friend, none in a legacy room', async () => {
    const { room, calls } = await load(open(), { 'peer-sam': { kind: 'add' }, 'peer-ben': { kind: 'open', friendId: 'f1' } });
    await room.login('Me');
    for (const [peerId, name] of [['peer-sam', 'Sam'], ['peer-ben', 'Ben'], ['peer-old', 'Old']]) {
        room.handlers.onPeerJoined({ peerId });
        room.handlers.onPeerName({ peerId, name });
    }
    await settle();
    const actions = peerId => room.window.menuCore.actionsFor(room.window.roomActions.rowInfo(
        room.el('peers').querySelector(`[data-peer-id="${peerId}"]`)));
    assert.ok(actions('peer-sam').includes('add-friend'));
    assert.equal(room.window.menuCore.label('add-friend'), 'Add friend…');
    assert.ok(actions('peer-ben').includes('open-friend-chat'));
    assert.equal(room.window.menuCore.label('open-friend-chat'), 'Open friend chat');
    // A legacy room (and a person with no proved device) gets no relation from the main process: no line.
    assert.ok(!actions('peer-old').some(a => a === 'add-friend' || a === 'open-friend-chat'));
    await room.window.roomActions.run('add-friend', room.el('peers').querySelector('[data-peer-id="peer-sam"]'));
    assert.deepEqual(calls.find(c => c[0] === 'request'), ['request', 'peer-sam']);
    assert.equal(room.el('status').textContent, 'Friend request sent to Sam.');
});

test('the friend chat window: the state line, the marks and the text when the friend is not connected', async () => {
    const source = await readFile(new URL('../src/application/friend-chat.js', import.meta.url), 'utf8');
    const ids = ['friend-name', 'friend-state', 'friend-reach', 'older', 'messages', 'send-status', 'composer', 'message-input'];
    const { document, window, Event } = createDom(ids.map(id => ({ id, tag: id === 'messages' ? 'ul' : id === 'composer' ? 'form' : 'div' })));
    const on = {};
    let sendResult = { result: 'unavailable' };
    let state = { name: 'Ben', state: 'offline', lastSeen: null, reach: 'local' };
    window.friendChat = {
        state: async () => state,
        lines: async () => [{ id: 'a.1', from: 'Ben', text: 'old line', time: 1000, own: false }],
        send: async () => sendResult,
        onLine: fn => { on.line = fn; }, onReceipt: fn => { on.receipt = fn; }, onState: fn => { on.state = fn; }
    };
    window.localStorage = { getItem: () => 'aero-night' };
    const context = { window, document, console, Promise, localStorage: window.localStorage, Date };
    window.window = window;
    vm.runInNewContext(source, context);
    await window.friendChatReady;
    // G7b: a message to a friend with no session waits in the outbox, thus the state line says so (the old text "You can
    // send when Ben is online" is not true any more).
    assert.equal(document.getElementById('friend-state').textContent, 'Offline. Messages send when you\'re both online.');
    assert.equal(document.getElementById('friend-reach').hidden, false);
    assert.equal(document.getElementById('messages').children.length, 1);
    assert.equal(document.documentElement.dataset.theme, 'aero-night');
    const input = document.getElementById('message-input');
    input.value = 'draft';
    input.dispatchEvent(new Event('keydown', { key: 'Enter' }));
    await new Promise(r => setTimeout(r, 0));
    assert.equal(document.getElementById('send-status').textContent, 'Not sent: Ben is offline.');
    assert.equal(input.value, 'draft', 'the draft stays');
    on.state({ name: 'Ben', state: 'online', lastSeen: 1, reach: 'local' });
    assert.equal(document.getElementById('friend-state').textContent, 'Online');
    assert.equal(document.getElementById('friend-reach').hidden, true);
    sendResult = { result: 'sending', line: { id: 'me.1', text: 'draft', time: 2000, own: true } };
    input.dispatchEvent(new Event('keydown', { key: 'Enter' }));
    await new Promise(r => setTimeout(r, 0));
    assert.equal(input.value, '');
    const mark = () => document.getElementById('messages').children.at(-1).querySelector('.mark').textContent;
    assert.equal(mark(), 'Sending');
    on.receipt({ id: 'me.1', result: 'delivered' });
    assert.equal(mark(), 'Delivered');
    on.receipt({ id: 'me.1', result: 'unconfirmed' });
    assert.equal(mark(), 'Not confirmed');
    on.line({ id: 'b.2', from: 'Ben', text: 'live line', time: 3000, own: false });
    assert.equal(document.getElementById('messages').children.length, 3);
    // Shift+Enter does not send.
    input.value = 'two\nlines';
    const shift = new Event('keydown', { key: 'Enter', shiftKey: true });
    input.dispatchEvent(shift);
    assert.equal(shift.defaultPrevented, false);
});

// L3 (P10b): the name of a friend request is the text of the requester. The bar shows the device mark beside it.
test('L3: the friend request bar shows the device mark beside the name', async () => {
    const { room, on } = await load(open())
    await room.login('Me')
    on.request({ kind: 'incoming', id: 'r1', name: 'Sam', mark: 'a1b2c3' })
    assert.match(room.el('friend-request-text').textContent, /^Sam #a1b2c3 wants to be friends\./)
})
