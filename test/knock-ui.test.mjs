// easy-join part 2: the window part of knock and approve: "Copy room code" (owner only), the knock bar of the owner
// (Allow / Deny), and the status of the joiner while it waits. The real window scripts run in the fake DOM of
// renderer-fixture.mjs. No network, no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const accessControls = [
    { id: 'copy-device-id', tag: 'button' }, { id: 'device-id-note' }, { id: 'room-access-status' },
    { id: 'reach-box', children: [{ id: 'reach-note', tag: 'p' }, { id: 'reach-upnp', tag: 'button' }] },
    { id: 'room-code-box', children: [{ id: 'room-code-copy', tag: 'button' }, { id: 'room-code-new', tag: 'button' }] },
    { id: 'member-invite-form', tag: 'form' }, { id: 'member-device-id', tag: 'input' },
    { id: 'member-can-host', tag: 'input' }, { id: 'member-invite-create', tag: 'button' },
    { id: 'invite-code-label' }, { id: 'room-members-section' }, { id: 'room-members', tag: 'ul' }, { id: 'waiting-peer' },
    { id: 'knock-bar', hidden: true, children: [{ id: 'knock-text', tag: 'p' }, { id: 'knock-allow', tag: 'button' }, { id: 'knock-deny', tag: 'button' }] }
];

async function startRoom({ owner = true, api = {} } = {}) {
    const room = await loadRoomWindow({ scripts: ['room-membership-ui.js', 'knock-ui.js'], elements: accessControls, api });
    const membership = { protected: true, owner, admitted: true, lan: false, members: [] };
    room.window.asscrack.login = async () => ({ room: 'test', internet: true, membership });
    room.window.asscrack.getInvite = async () => ({ membership, reach: { state: 'ready', reason: null, proven: true } });
    room.window.asscrack.getFullNode = async () => ({ self: false, peers: [] });
    await room.login('Ann');
    await settle();
    return room;
}

test('the owner has "Copy room code" and "New room code"; the code shows in the invite box', async () => {
    const asked = [];
    const expires = new Date(2026, 10, 29, 12, 0).getTime();
    const room = await startRoom({ api: { roomCode: async renew => { asked.push(renew); return { code: 'asscrack3:gQroomcode', expires }; } } });
    assert.equal(room.el('room-code-box').hidden, false);
    room.el('room-code-copy').click();
    await settle();
    assert.deepEqual(asked, [false]);
    assert.equal(room.el('invite-code').value, 'asscrack3:gQroomcode');
    assert.equal(room.el('invite-code-label').textContent, 'Room code');
    assert.match(room.el('invite-note').textContent, /^Room code copied\. Valid until .+\.$/);
    room.el('room-code-new').click();
    await settle();
    assert.deepEqual(asked, [false, true]);
    assert.match(room.el('invite-note').textContent, /^New room code copied\. The old code no longer works\. Valid until .+\.$/);
});

test('a member that is not the owner does not see "Copy room code"', async () => {
    const room = await startRoom({ owner: false });
    assert.equal(room.el('room-code-box').hidden, true);
    room.el('room-code-copy').click();
    await settle();
    assert.ok(!room.calls.some(call => call.name === 'roomCode'));
});

test('the knock bar: "<name> #<mark> wants to join." with Allow and Deny, one request at a time', async () => {
    const answers = [];
    const room = await startRoom({ api: { answerKnock: async (id, allow) => { answers.push([id, allow]); return true; } } });
    assert.equal(room.el('knock-bar').hidden, true);
    room.handlers.onKnocks([{ id: 'k1', name: 'Kim', mark: 'a1b2c3' }, { id: 'k2', name: 'Lee', mark: 'zz' }]);
    assert.equal(room.el('knock-bar').hidden, false);
    assert.equal(room.el('knock-text').textContent, 'Kim #a1b2c3 wants to join. (+1 more)');
    room.el('knock-allow').click();
    await settle();
    assert.deepEqual(answers, [['k1', true]]);
    assert.equal(room.el('status').textContent, 'Allowed Kim.');
    assert.equal(room.el('knock-text').textContent, 'Lee wants to join.', 'a mark that is not 6 hex characters does not show');
    room.el('knock-deny').click();
    await settle();
    assert.deepEqual(answers, [['k1', true], ['k2', false]]);
    assert.equal(room.el('status').textContent, 'Denied Lee.');
    assert.equal(room.el('knock-bar').hidden, true);
    room.handlers.onKnocks([]);
    assert.equal(room.el('knock-bar').hidden, true);
    assert.equal(room.window.knockCore.barText({ name: 'A', mark: '123abc' }, 2), 'A #123abc wants to join. (+2 more)');
});

test('the joiner sees the state of its knock while the login waits for the owner', async () => {
    let finish;
    const room = await loadRoomWindow({ elements: accessControls });
    room.window.asscrack.login = () => new Promise((resolve, reject) => { finish = { resolve, reject }; });
    // The login screen shows; the chat screen is hidden (as in index.html).
    room.el('chat-screen').hidden = true;
    room.el('room-type').value = 'join';
    room.el('room-type').dispatchEvent(new room.Event('change'));
    room.el('invite-input').value = 'asscrack3:gQroomcode';
    room.el('username').value = 'Kim';
    room.el('login').click();
    await settle();
    room.handlers.onKnockState({ state: 'looking', room: 'Game night' });
    assert.equal(room.el('status').textContent, 'Looking for the owner of Game night…');
    room.handlers.onKnockState({ state: 'waiting', room: 'Game night' });
    assert.equal(room.el('status').textContent, 'Waiting for the owner of Game night…');
    finish.reject(new Error('The owner declined.'));
    await settle();
    assert.equal(room.el('status').textContent, 'The owner declined.');
    room.handlers.onKnockState({ state: 'waiting', room: 'Game night' });
    assert.equal(room.el('status').textContent, 'The owner declined.', 'no state text after the login ends');
});
