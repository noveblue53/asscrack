// easy-join part 3: friend row Join (a knock over the friend link) and "Always allow my friends", with real friend nodes
// and room nodes on 127.0.0.1 on this PC. These are 127.0.0.1 results, not LAN results and not internet results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAsscrackNode } from '../src/network/node.mjs';
import { newRoomKey, readInvite, readRoomCode } from '../src/network/invite.mjs';
import { createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs';
import { knockRoom } from '../src/network/knock-client.mjs';
import { deviceMark } from '../src/network/device-mark.mjs';
import { joinAdmission } from '../src/application/room-admission.mjs';
import { knockResultText } from '../src/application/login-errors.mjs';
import { makeProfile, protectedRoomPair, startLinks, befriend, waitFor, randomBasePort } from './helpers/friends.mjs';

const FAST = { discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: false, heartbeatInterval: 200, electionDelay: 300,
    hostTimeout: 1500 };
const local = node => node.getMultiaddrs().find(addr => addr.startsWith('/ip4/127.0.0.1/') && !addr.includes('/p2p-circuit'));

// Two profiles that are friends on 127.0.0.1. The friend request room stays the current room of each side.
async function friends(t, labels = ['a', 'b'], names = ['Ann', 'Ben']) {
    const A = makeProfile(t, labels[0]), B = makeProfile(t, labels[1]);
    t.after(() => { A.rooms.close(); B.rooms.close(); });
    const { roomA, roomB } = await protectedRoomPair(t, A, B, names);
    const port = randomBasePort();
    const linksA = await startLinks(t, A, { basePort: port, discovery: false, nodeOptions: { allowPrivateFullNode: true } });
    const linksB = await startLinks(t, B, { basePort: port + 50, discovery: false });
    linksA.attachRoom(roomA, { name: 'friends-test' });
    linksB.attachRoom(roomB, { name: 'friends-test' });
    const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online', 'online');
    return { A, B, roomA, roomB, linksA, linksB, friendA, friendB };
}

// A LAN protected room of an owner identity on 127.0.0.1, with the knock of the app.
async function ownerRoom(t, identity, { name = 'Ann', room = `game night ${randomUUID().slice(0, 4)}` } = {}) {
    const roomKey = newRoomKey();
    const membership = createRoomMembership({ identity, room, roomKey, lan: true });
    const node = await createAsscrackNode({ ...FAST, room, roomKey, membership, name, knock: true });
    t.after(() => node.stop());
    return { node, room, roomKey, membership };
}

// A member device of a room of an owner: admitted (the admission signature of the owner), or only invited.
async function memberRoom(t, owner, identity, { admitted = true, name = 'Fay' } = {}) {
    const descriptor = owner.membership.issue(identity.id, false);
    if (admitted) descriptor.admission = owner.membership.admit({ deviceId: identity.id, grant: descriptor.grant });
    const membership = restoreRoomMembership({ identity, room: owner.room, roomKey: owner.roomKey, descriptor });
    const node = await createAsscrackNode({ ...FAST, room: owner.room, roomKey: owner.roomKey, membership, name, knock: true });
    t.after(() => node.stop());
    return node;
}

// The prompts of an owner node. answer: true (Allow), false (Deny) or null (no answer).
function answerPrompts(node, answer) {
    const prompts = [];
    node.events.on('knocks', ({ added }) => {
        if (!added) return;
        prompts.push(added);
        if (answer !== null) setImmediate(() => node.answerKnock(added.id, answer));
    });
    return prompts;
}

// The joiner uses the device invite of Allow on the normal admission path (main.js login: readInvite, joinAdmission).
// Then chat in both directions with the owner node.
async function joinAndChat(t, identity, invite, ownerNode, name = 'Ben') {
    const code = readInvite(invite);
    assert.equal(code.membership.grant.deviceId, identity.id);
    assert.equal(code.membership.grant.canHost, false);
    const M = await createAsscrackNode({ ...FAST, room: code.room, roomKey: code.key, name, membership: joinAdmission(code, identity, null) });
    t.after(() => M.stop());
    await M.connect(local(ownerNode));
    await waitFor(() => M.memberState().admitted === true && ownerNode.deviceOf(M.peerId) === identity.id, 'the joiner is admitted', 30000);
    const atOwner = [], atJoiner = [];
    ownerNode.events.on('message', m => atOwner.push(m.text));
    M.events.on('message', m => atJoiner.push(m.text));
    await waitFor(() => ownerNode.peers().includes(M.peerId) && M.peers().includes(ownerNode.peerId), 'chat session');
    M.send(`hi from ${name}`);
    ownerNode.send('hi from the owner');
    await waitFor(() => atOwner.includes(`hi from ${name}`) && atJoiner.includes('hi from the owner'), 'chat in both directions');
    return M;
}

test('127.0.0.1 friend Join to a friend that is the owner: the row shows Join, the owner prompt, Allow, admission and chat', { timeout: 90000 }, async t => {
    const { A, B, linksA, linksB, friendA, friendB } = await friends(t);
    // The room announce lines of A: no key, no code and no address.
    const announced = [];
    const friendNodeA = linksA.nodeOf(friendA);
    const send = friendNodeA.sendTo.bind(friendNodeA);
    friendNodeA.sendTo = (peer, line) => { if (line?.op === 'room') announced.push(JSON.stringify(line)); return send(peer, line); };
    const R = await ownerRoom(t, A.identity);
    const prompts = answerPrompts(R.node, true);
    linksA.attachRoom(R.node, { name: R.room });
    await waitFor(() => linksB.friend(friendB).join?.room === R.room, 'B sees Join on the row of A');
    assert.deepEqual(linksB.friend(friendB).join, { room: R.room, ask: false });
    assert.deepEqual(linksB.joinTarget(friendB), { state: 'ok', room: R.room, roomId: R.membership.roomId });
    assert.ok(announced.length >= 1);
    for (const text of announced) assert.ok(!text.includes(R.roomKey) && !text.includes('asscrack3:') && !text.includes('/ip4/'), 'no key, code or address');
    // A friend in the current room of this device: no Join (A sees B in the friend request room, not in R).
    assert.equal(linksA.friend(friendA).join, undefined);
    const states = [];
    const outcome = await linksB.knock(friendB, { name: 'Ben', onState: state => states.push(state) });
    assert.equal(outcome.result, 'allowed', JSON.stringify(outcome));
    assert.equal(outcome.room, R.room);
    assert.equal(prompts.length, 1, 'the owner saw the prompt');
    assert.equal(prompts[0].name, 'Ben');
    assert.equal(prompts[0].mark, deviceMark(B.identity.id));
    assert.deepEqual(states, ['waiting']);
    await joinAndChat(t, B.identity, outcome.invite, R.node);
});

test('127.0.0.1 friend Join to a friend that is the owner: Deny gives "The owner did not let you in."', { timeout: 90000 }, async t => {
    const { A, linksA, linksB, friendB } = await friends(t);
    const R = await ownerRoom(t, A.identity);
    const prompts = answerPrompts(R.node, false);
    linksA.attachRoom(R.node, { name: R.room });
    await waitFor(() => linksB.friend(friendB).join?.room === R.room, 'B sees Join');
    const outcome = await linksB.knock(friendB, { name: 'Ben' });
    assert.equal(outcome.result, 'denied');
    assert.equal(knockResultText(outcome), 'The owner did not let you in.');
    assert.equal(prompts.length, 1);
    assert.equal(R.membership.issued().length, 0, 'no grant');
});

test('127.0.0.1 friend Join through a friend that is not the owner: the member forwards the knock, the owner allows, the joiner joins', { timeout: 120000 }, async t => {
    // F (Fay) and J (Jo) are friends. O owns room R; F is an admitted member of R with a session to O. J is not a friend of O.
    const { A: F, B: J, linksA: linksF, linksB: linksJ, friendB: friendJ } = await friends(t, ['f', 'j'], ['Fay', 'Jo']);
    const O = makeProfile(t, 'o');
    t.after(() => O.rooms.close());
    const R = await ownerRoom(t, O.identity, { name: 'Olga' });
    const FR = await memberRoom(t, R, F.identity);
    await FR.connect(local(R.node));
    await waitFor(() => R.node.deviceOf(FR.peerId) === F.identity.id && FR.memberState().admitted === true, 'F has a session with the owner');
    const prompts = answerPrompts(R.node, true);
    linksF.attachRoom(FR, { name: R.room });
    await waitFor(() => linksJ.friend(friendJ).join?.room === R.room, 'J sees Join on the row of F');
    assert.deepEqual(linksJ.friend(friendJ).join, { room: R.room, ask: false });
    const outcome = await linksJ.knock(friendJ, { name: 'Jo' });
    assert.equal(outcome.result, 'allowed', JSON.stringify(outcome));
    assert.equal(prompts.length, 1, 'the owner saw the normal prompt');
    assert.equal(prompts[0].name, 'Jo');
    assert.equal(prompts[0].mark, deviceMark(J.identity.id), 'the owner checked the device of the joiner, not of the forwarder');
    assert.equal(prompts[0].deviceId, J.identity.id);
    await joinAndChat(t, J.identity, outcome.invite, R.node, 'Jo');
});

test('127.0.0.1 friend Join: a member that is not admitted shows "Ask <friend> for an invite"; the owner not online gives the part 2 text', { timeout: 120000 }, async t => {
    const { A: F, B: J, linksA: linksF, linksB: linksJ, friendB: friendJ } = await friends(t, ['f', 'j'], ['Fay', 'Jo']);
    const O = makeProfile(t, 'o');
    t.after(() => O.rooms.close());
    const R = await ownerRoom(t, O.identity, { name: 'Olga' });
    // 1. F has an invite of R but no admission yet: F cannot forward.
    const waiting = await memberRoom(t, R, F.identity, { admitted: false });
    assert.equal(waiting.memberState().admitted, false);
    linksF.attachRoom(waiting, { name: R.room });
    await waitFor(() => linksJ.friend(friendJ).join?.room === R.room, 'J sees the room of F');
    assert.deepEqual(linksJ.friend(friendJ).join, { room: R.room, ask: true });
    assert.equal(linksJ.joinTarget(friendJ).state, 'ask');
    assert.deepEqual(await linksJ.knock(friendJ, { name: 'Jo' }), { result: 'refused', reason: 'ask', room: R.room });
    // 2. F is admitted, but the owner is not online (F has no session with the owner): 'offline'.
    linksF.attachRoom(null);
    await waiting.stop();
    await R.node.stop();
    const alone = await memberRoom(t, R, F.identity);
    assert.equal(alone.memberState().admitted, true);
    linksF.attachRoom(alone, { name: R.room });
    await waitFor(() => linksJ.friend(friendJ).join?.ask === false, 'J sees Join on the row of F');
    const started = Date.now();
    const outcome = await linksJ.knock(friendJ, { name: 'Jo' });
    assert.deepEqual(outcome, { result: 'offline', room: R.room });
    assert.equal(knockResultText(outcome), 'The owner is not online. Try again later.');
    assert.ok(Date.now() - started < 15000, 'the answer comes at once, not after the prompt time');
});

test('127.0.0.1 a knock stream of a peer that is not admitted cannot use the friend code: old-code', { timeout: 60000 }, async t => {
    const A = makeProfile(t, 'a');
    t.after(() => A.rooms.close());
    const R = await ownerRoom(t, A.identity);
    const S = makeProfile(t, 's');
    t.after(() => S.rooms.close());
    const prompts = answerPrompts(R.node, null);
    const code = { ...readRoomCode(R.node.roomCode().code), codeId: 'friend' };
    const outcome = await knockRoom({ code, identity: S.identity, name: 'Sam' });
    assert.deepEqual(outcome, { result: 'refused', reason: 'old-code' });
    assert.equal(prompts.length, 0);
});
