// Goal easy-join part 1: the friend invite (friend-invite.mjs, friend-links.mjs invite() and inviteCode(),
// friend-join.mjs, the 'invite' op of private-messages.mjs, and the window parts). The network tests run real friend
// nodes and room nodes on 127.0.0.1 on this PC (not a LAN result).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { createAsscrackNode } from '../src/network/node.mjs';
import { makeMemberInvite, newRoomKey, readInvite } from '../src/network/invite.mjs';
import { createDeviceIdentity, createRoomMembership } from '../src/network/room-membership.mjs';
import { createPrivateMessages } from '../src/network/private-messages.mjs';
import { joinAdmission } from '../src/application/room-admission.mjs';
import { checkInvite, INVITE_MARK, inviteText, plainText } from '../src/application/friend-invite.mjs';
import { createFriendJoins } from '../src/application/friend-join.mjs';
import { createFriendLinks } from '../src/application/friend-links.mjs';
import { createDom } from './helpers/fake-dom.mjs';
import { makeProfile, protectedRoomPair, startLinks, befriend, waitFor, randomBasePort } from './helpers/friends.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NODES = [{ id: '12D3KooWGpponMzJoSX1usSBzTdUmp9iaNvRFkvtJh75io6goVuA', addrs: ['/ip4/203.0.113.5/tcp/47000'] }];
const FAST = { discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: false, heartbeatInterval: 200, electionDelay: 300,
    hostTimeout: 1500 };

// A code of an owner for a device (no node).
function codeFor(owner, deviceId, { now = Date.now } = {}) {
    const room = `room-${randomUUID().slice(0, 8)}`, roomKey = newRoomKey();
    const membership = createRoomMembership({ identity: owner, room, roomKey, now });
    return { room, code: makeMemberInvite({ room, key: roomKey, nodes: NODES, membership: membership.issue(deviceId, false) }) };
}

// A LAN protected room of an owner identity on 127.0.0.1 (a LAN room needs no public address for an invite).
async function ownerRoom(t, identity, { name = 'Ann', now = Date.now, room = `game night ${randomUUID().slice(0, 4)}` } = {}) {
    const roomKey = newRoomKey();
    const membership = createRoomMembership({ identity, room, roomKey, lan: true, now });
    const node = await createAsscrackNode({ ...FAST, room, roomKey, membership, name });
    t.after(() => node.stop());
    return { node, room, roomKey };
}

// No line for a window has the code of an invite (it has the room key).
function assertNoCode(lines) {
    for (const line of lines) assert.ok(!String(line.text).includes('asscrack3:') && !String(line.text).includes(INVITE_MARK), 'no code');
}

// A and B are friends on 127.0.0.1 (A owns the room of the friend request).
async function friends(t) {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    t.after(() => { A.rooms.close(); B.rooms.close(); });
    const { roomA, roomB } = await protectedRoomPair(t, A, B);
    const port = randomBasePort();
    const a = { basePort: port, discovery: false, nodeOptions: { allowPrivateFullNode: true } };
    const b = { basePort: port + 50, discovery: false };
    const linksA = await startLinks(t, A, a);
    const linksB = await startLinks(t, B, b);
    linksA.attachRoom(roomA);
    linksB.attachRoom(roomB);
    const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online', 'online');
    return { A, B, a, b, roomA, roomB, linksA, linksB, friendA, friendB };
}

// ---- The checks of friend-invite.mjs (no network) ----

test('checkInvite: ok, wrong device, wrong owner (a forwarded invite), expired and damaged', () => {
    const owner = createDeviceIdentity(), self = createDeviceIdentity(), other = createDeviceIdentity();
    const good = codeFor(owner, self.id);
    const ok = checkInvite(good.code, { selfId: self.id, friendDevice: owner.id });
    assert.equal(ok.state, 'ok');
    assert.equal(ok.room, good.room);
    assert.equal(checkInvite(codeFor(owner, other.id).code, { selfId: self.id, friendDevice: owner.id }).state, 'wrong-device');
    // The owner of the room is not the friend that sent it.
    assert.equal(checkInvite(good.code, { selfId: self.id, friendDevice: other.id }).state, 'wrong-owner');
    let clock = Date.now() - 7 * DAY - 2 * 60 * 60 * 1000;
    assert.equal(checkInvite(codeFor(owner, self.id, { now: () => clock }).code, { selfId: self.id, friendDevice: owner.id }).state, 'expired');
    assert.equal(checkInvite(good.code.slice(0, -3) + 'AAA', { selfId: self.id, friendDevice: owner.id }).state, 'invalid');
    assert.equal(checkInvite('asscrack1:abc', { selfId: self.id, friendDevice: owner.id }).state, 'invalid');
    assert.equal(checkInvite(42, { selfId: self.id, friendDevice: owner.id }).state, 'invalid');
});

test('private messages: the invite op uses the id, the ack and the repeat check of a message; a msg text loses the mark', async () => {
    const a = createDeviceIdentity().id, b = createDeviceIdentity().id;
    const got = [], wire = [];
    let peerB;
    const pmA = createPrivateMessages({ selfDevice: a, friendDevice: b, sessionPeer: () => 'pb',
        sendTo: (_peer, line) => { wire.push(line); queueMicrotask(() => peerB.handle({ peerId: 'pa', deviceId: a, message: line })); return true; },
        receive: () => {} });
    peerB = createPrivateMessages({ selfDevice: b, friendDevice: a, sessionPeer: () => 'pa',
        sendTo: (_peer, line) => { queueMicrotask(() => pmA.handle({ peerId: 'pb', deviceId: b, message: line })); return true; },
        receive: msg => { got.push(msg); } });
    const code = codeFor(createDeviceIdentity(), b).code;
    const id = pmA.newId();
    assert.equal(await pmA.sendInvite(id, code), 'delivered');
    assert.equal(wire[0].op, 'invite');
    assert.equal(wire[0].code, code);
    assert.equal(got.length, 1);
    assert.equal(got[0].invite, code);
    assert.equal(got[0].text, undefined);
    // A repeat of the same id: one line only, and the ack again.
    peerB.handle({ peerId: 'pa', deviceId: a, message: wire[0] });
    assert.equal(got.length, 1);
    assert.equal(await pmA.sendInvite(pmA.newId(), 'asscrack1:nope'), 'invalid');
    pmA.stop();
    peerB.stop();
    assert.equal(plainText(inviteText(code)), INVITE_MARK.slice(1) + code);
    assert.equal(plainText('hello'), 'hello');
});

// ---- 127.0.0.1: friend links with real nodes ----

test('127.0.0.1 friend invite, online friend: the owner invites from the friend row, the friend joins with the code', { timeout: 90000 }, async t => {
    const { A, B, roomA, linksA, linksB, friendA, friendB } = await friends(t);
    // A owns the room of the friend request, but B is in that room now: no item. The call itself gives 'no-address'
    // (an internet room with no public address on 127.0.0.1).
    assert.equal(linksA.friend(friendA).canInvite, false);
    assert.deepEqual(linksA.invite(friendA), { result: 'no-address' });
    // A opens its own LAN protected room R.
    const R = await ownerRoom(t, A.identity);
    linksA.attachRoom(R.node, { name: R.room });
    assert.equal(linksA.friend(friendA).canInvite, true);
    assert.equal(linksA.list().friends[0].canInvite, true);
    const lines = [], invites = [];
    linksB.events.on('line', e => lines.push(e.line));
    linksB.events.on('invite', e => invites.push(e));
    const receipts = [];
    linksA.events.on('receipt', r => receipts.push(r));
    const sent = linksA.invite(friendA);
    assert.equal(sent.result, 'sending');
    assert.deepEqual(sent.line.invite, { state: 'sent', room: R.room });
    assertNoCode([sent.line]);
    await waitFor(() => lines.length === 1 && invites.length === 1, 'B has the invite line', 20000);
    assert.deepEqual(lines[0].invite, { state: 'ok', room: R.room });
    assert.equal(invites[0].room, R.room);
    assert.equal(invites[0].name, roomA.name);
    assertNoCode(lines);
    await waitFor(() => receipts.some(r => r.id === sent.line.id && r.result === 'delivered'), 'A has the receipt');
    // The saved lines of both sides give the card, never the code.
    assert.deepEqual(linksB.lines(friendB).map(l => l.invite), [{ state: 'ok', room: R.room }]);
    assert.deepEqual(linksA.lines(friendA).map(l => l.invite), [{ state: 'sent', room: R.room }]);
    assertNoCode([...linksA.lines(friendA), ...linksB.lines(friendB)]);
    // Join: the code of the main process. The grant is for the device of B and has no host rights.
    const found = linksB.inviteCode(friendB, lines[0].id);
    assert.equal(found.state, 'ok');
    const invite = readInvite(found.code);
    assert.equal(invite.membership.grant.deviceId, B.identity.id);
    assert.equal(invite.membership.grant.canHost, false);
    assert.equal(invite.membership.owner, A.identity.id);
    assert.deepEqual(linksB.inviteCode(friendB, 'no-such-line'), { state: 'gone', room: '' });
    // The same admission path as a pasted code (main.js login: readInvite, then joinAdmission).
    const M = await createAsscrackNode({ ...FAST, room: invite.room, roomKey: invite.key, name: 'Ben',
        membership: joinAdmission(invite, B.identity, null) });
    t.after(() => M.stop());
    await M.connect(R.node.getMultiaddrs().find(addr => addr.startsWith('/ip4/127.0.0.1/')));
    await waitFor(() => M.memberState().admitted === true && R.node.deviceOf(M.peerId) === B.identity.id, 'B is admitted to R');
    const atA = [], atB = [];
    R.node.events.on('message', m => atA.push(m.text));
    M.events.on('message', m => atB.push(m.text));
    await waitFor(() => R.node.peers().includes(M.peerId) && M.peers().includes(R.node.peerId), 'chat session');
    M.send('hi from Ben');
    R.node.send('hi from Ann');
    await waitFor(() => atA.includes('hi from Ben') && atB.includes('hi from Ann'), 'chat in both directions');
});

test('127.0.0.1 friend invite, offline friend: the invite waits in the outbox and arrives when B starts again', { timeout: 90000 }, async t => {
    const { A, B, b, roomA, roomB, linksA, linksB, friendA } = await friends(t);
    linksA.attachRoom(null);
    linksB.attachRoom(null);
    await Promise.all([roomA.stop(), roomB.stop()]);
    await linksB.stop();
    await waitFor(() => linksA.friend(friendA).state === 'offline', 'A shows B offline');
    const R = await ownerRoom(t, A.identity);
    linksA.attachRoom(R.node, { name: R.room });
    const sent = linksA.invite(friendA);
    assert.equal(sent.result, 'waiting');
    assert.deepEqual(sent.line.invite, { state: 'sent', room: R.room });
    assert.equal(linksA.waitingCount(friendA), 1);
    assertNoCode(linksA.lines(friendA));
    assert.equal(linksA.lines(friendA)[0].waiting, true);
    const again = await startLinks(t, B, b);
    const lines = [];
    again.events.on('line', e => lines.push(e.line));
    await waitFor(() => lines.length === 1 && linksA.waitingCount(friendA) === 0, 'B has the queued invite', 40000);
    assert.deepEqual(lines[0].invite, { state: 'ok', room: R.room });
    assert.ok(lines[0].away, 'a queued invite is an away line');
    const friendB = again.list().friends[0].friendId;
    assert.equal(again.inviteCode(friendB, lines[0].id).state, 'ok');
    assertNoCode([...lines, ...again.lines(friendB)]);
});

test('127.0.0.1 friend invite: B refuses an invite for another device and a forwarded invite of a third owner', { timeout: 90000 }, async t => {
    const { A, B, linksA, linksB, friendA, friendB } = await friends(t);
    const lines = [], invites = [];
    linksB.events.on('line', e => lines.push(e.line));
    linksB.events.on('invite', e => invites.push(e));
    const nodeA = linksA.nodeOf(friendA);
    const peerB = nodeA.peers().find(p => nodeA.deviceOf(p) === B.identity.id);
    assert.ok(peerB);
    const raw = code => nodeA.sendTo(peerB, { type: 'pm', v: 1, op: 'invite', id: `${A.identity.id}.${randomUUID()}`, code,
        time: Date.now(), away: false });
    // 1: A owns the room, but the grant is for a different device.
    const wrongDevice = codeFor(A.identity, createDeviceIdentity().id);
    // 2: the grant is for B, but a third person owns the room (A forwards it as its own invite).
    const forwarded = codeFor(createDeviceIdentity(), B.identity.id);
    assert.equal(raw(wrongDevice.code), true);
    assert.equal(raw(forwarded.code), true);
    await waitFor(() => lines.length === 2, 'B has the two lines');
    assert.deepEqual(lines.map(l => l.invite.state).sort(), ['wrong-device', 'wrong-owner']);
    assert.equal(invites.length, 0, 'no invite event, thus no balloon');
    for (const line of lines) assert.equal(linksB.inviteCode(friendB, line.id).state, 'gone', 'no Join');
    assertNoCode([...lines, ...linksB.lines(friendB)]);
});

test('127.0.0.1 friend invite: an expired invite shows "expired" and gives no Join', { timeout: 90000 }, async t => {
    const { A, linksA, linksB, friendA, friendB } = await friends(t);
    // The clock of the owner room is 8 days in the past: the grant expired 1 day ago (L4, 7 days).
    const R = await ownerRoom(t, A.identity, { now: () => Date.now() - 8 * DAY });
    linksA.attachRoom(R.node, { name: R.room });
    const lines = [], invites = [];
    linksB.events.on('line', e => lines.push(e.line));
    linksB.events.on('invite', e => invites.push(e));
    const sent = linksA.invite(friendA);
    assert.equal(sent.result, 'sending');
    assert.equal(sent.line.invite.state, 'expired');
    await waitFor(() => lines.length === 1, 'B has the line');
    assert.equal(lines[0].invite.state, 'expired');
    assert.equal(invites.length, 0);
    assert.equal(linksB.inviteCode(friendB, lines[0].id).state, 'gone');
});

test('127.0.0.1 friend invite: a member that is not the owner has no item and cannot make the invite', { timeout: 90000 }, async t => {
    const { roomB, linksA, linksB, friendA, friendB } = await friends(t);
    // B is a member (not the owner) of the attached room.
    assert.equal(roomB.memberState().owner, false);
    assert.equal(linksB.friend(friendB).canInvite, false);
    const lines = [];
    linksA.events.on('line', e => lines.push(e.line));
    let made = 0;
    const real = roomB.createMemberInvite;
    roomB.createMemberInvite = (...args) => { made += 1; return real(...args); };
    assert.deepEqual(linksB.invite(friendB), { result: 'not-owner' });
    assert.equal(made, 0, 'createMemberInvite is not called');
    // With no room: no item, no invite.
    linksB.attachRoom(null);
    assert.equal(linksB.friend(friendB).canInvite, false);
    assert.deepEqual(linksB.invite(friendB), { result: 'no-room' });
    await delay(500);
    assert.equal(lines.length, 0);
    assert.equal(linksA.lines(friendA).length, 0);
    // A typed text with the mark of a stored invite is refused (it never becomes an invite).
    assert.deepEqual(linksB.send(friendB, inviteText('asscrack3:AAAA')), { result: 'invalid' });
});

test('friend invite: a friend row with no device ID has no item and gives no-device (no throw)', () => {
    const events = new EventEmitter();
    const row = { roomId: 'r1', deviceId: null, nickname: 'Old', slot: 0, state: 'active', addrs: [] };
    const archive = { settings: () => ({ name: 'Ann', upnp: false }), listFriends: () => [row], blocks: () => [],
        getRoom: () => null };
    const links = createFriendLinks({ createNode: async () => { throw new Error('not used'); }, setTimer: () => ({}), clearTimer: () => {} });
    links.start({ id: 'self' }, archive);
    const room = { events, peers: () => [], deviceOf: () => null, sendTo: () => true,
        memberState: () => ({ protected: true, owner: true }), createMemberInvite: () => { throw new Error('not called'); } };
    links.attachRoom(room, { name: 'R' });
    assert.equal(links.friend('r1').canInvite, false);
    assert.deepEqual(links.invite('r1'), { result: 'no-device' });
});

// ---- friend-join.mjs: Join with a one-time token ----

test('friend Join: in a room it asks first, then leaves, reloads and gives a one-time token; the code stays in main', async () => {
    let current = 'Old room', left = 0, reloads = 0, notes = 0;
    const links = { inviteCode: (friendId, id) => (id === 'L1' ? { state: 'ok', room: 'New room', code: 'asscrack3:CODE' }
        : id === 'L2' ? { state: 'expired', room: '' } : { state: 'gone', room: '' }) };
    const joins = createFriendJoins({ links, room: () => current, leave: async () => { left += 1; current = null; return true; },
        reload: () => { reloads += 1; }, notify: () => { notes += 1; }, name: () => 'Ben' });
    assert.deepEqual(await joins.join('f', 'L1'), { result: 'confirm', room: 'New room', current: 'Old room' });
    assert.equal(left, 0);
    assert.deepEqual(await joins.join('f', 'L2'), { result: 'expired', room: '' });
    assert.deepEqual(await joins.join('f', 'L9'), { result: 'gone', room: '' });
    assert.deepEqual(await joins.join('f', 'L1', true), { result: 'joining', room: 'New room' });
    assert.deepEqual([left, reloads, notes], [1, 1, 0]);
    const taken = joins.take();
    assert.equal(taken.room, 'New room');
    assert.equal(taken.name, 'Ben');
    assert.equal(JSON.stringify(taken).includes('CODE'), false, 'the window gets no code');
    assert.equal(joins.take(), null, 'one time');
    assert.equal(joins.code('wrong'), null);
    assert.equal(joins.code(taken.token), 'asscrack3:CODE');
    assert.equal(joins.code(taken.token), null, 'one time');
    // On the login screen: no Leave, the window gets the event.
    assert.deepEqual(await joins.join('f', 'L1'), { result: 'joining', room: 'New room' });
    assert.deepEqual([left, reloads, notes], [1, 1, 1]);
    // A login that runs now: busy.
    const busy = createFriendJoins({ links, room: () => null, busy: () => true, leave: async () => true, reload: () => {} });
    assert.equal((await busy.join('f', 'L1')).result, 'busy');
});

// ---- The window parts ----

test('menu: "Invite to room" only on a friend row with canInvite', async () => {
    const source = await readFile(new URL('../src/application/menu.js', import.meta.url), 'utf8');
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(source, context);
    const { actionsFor, label } = context.window.menuCore;
    assert.equal(JSON.stringify(actionsFor({ kind: 'friend', invite: true })),
        JSON.stringify(['friend-open', 'friend-invite', 'friend-rename', 'friend-remove', 'friend-block']));
    assert.equal(JSON.stringify(actionsFor({ kind: 'friend', invite: false })),
        JSON.stringify(['friend-open', 'friend-rename', 'friend-remove', 'friend-block']));
    assert.equal(label('friend-invite'), 'Invite to room');
});

test('chat window: the invite card with Join / Not now, "Leave <room> and join?", the expired and the refused cards', async () => {
    const source = await readFile(new URL('../src/application/friend-chat.js', import.meta.url), 'utf8');
    const ids = ['friend-name', 'friend-state', 'friend-reach', 'older', 'messages', 'send-status', 'composer', 'message-input'];
    const { document, window } = createDom(ids.map(id => ({ id, tag: id === 'messages' ? 'ul' : id === 'composer' ? 'form' : 'div' })));
    const calls = [];
    const answers = [{ result: 'confirm', room: 'Game night', current: 'Lobby' }, { result: 'joining', room: 'Game night' }];
    window.friendChat = {
        state: async () => ({ name: 'Ann', state: 'online', lastSeen: 1, reach: 'local' }),
        lines: async before => (before ? [] : [
            { id: 'a.1', from: 'Ann', text: '', time: 1000, own: false, invite: { state: 'ok', room: 'Game night' } },
            { id: 'a.2', from: 'Ann', text: '', time: 2000, own: false, invite: { state: 'expired', room: '' } },
            { id: 'a.3', from: 'Ann', text: '', time: 3000, own: false, invite: { state: 'wrong-owner', room: 'X' } },
            { id: 'me.1', from: 'Ben', text: '', time: 4000, own: true, invite: { state: 'sent', room: 'Ben room' } }]),
        send: async () => ({ result: 'unavailable' }), deleteWaiting: async () => 'gone',
        join: async (id, leave) => { calls.push([id, leave]); return answers.shift(); },
        onLine: () => {}, onReceipt: () => {}, onState: () => {}
    };
    window.localStorage = { getItem: () => null };
    window.window = window;
    vm.runInNewContext(source, { window, document, console, Promise, localStorage: window.localStorage, Date });
    await window.friendChatReady;
    const rows = document.getElementById('messages').children;
    const texts = rows.map(r => r.querySelector('.text').textContent);
    assert.deepEqual(texts, ['Ann invites you to Game night.', 'This invite expired. Ask Ann for a new invite.',
        'This room invite is not for this computer. You cannot join with it.', 'You invited Ann to Ben room.']);
    const buttons = row => row.querySelectorAll('button').map(b => b.textContent);
    assert.deepEqual(buttons(rows[0]), ['Join', 'Not now']);
    assert.deepEqual([rows[1], rows[2], rows[3]].map(buttons), [[], [], []]);
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    rows[0].querySelectorAll('button')[0].click();
    await tick();
    assert.equal(rows[0].querySelector('.invite-note').textContent, 'Leave Lobby and join Game night?');
    assert.deepEqual(buttons(rows[0]), ['Leave and join', 'Cancel']);
    rows[0].querySelectorAll('button')[0].click();
    await tick();
    assert.deepEqual(calls, [['a.1', false], ['a.1', true]]);
    assert.equal(rows[0].querySelector('.invite-note').textContent, 'Joining Game night…');
});
