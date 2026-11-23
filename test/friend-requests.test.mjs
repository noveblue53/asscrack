// G7a check 1: friend requests (127.0.0.1, real protected room nodes, design F3 and F5a).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createFriendRequests, validFriendRoom, validNodes } from '../src/network/friend-requests.mjs';
import { createDeviceIdentity, createRoomMembership } from '../src/network/room-membership.mjs';
import { newRoomKey } from '../src/network/invite.mjs';
import { makeProfile, protectedRoomPair, startLinks, befriend, waitFor, randomBasePort } from './helpers/friends.mjs';

// A clock with timers that run only on advance(ms).
function fakeTimers() {
    let now = 1_000_000, seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimer: id => timers.delete(id),
        advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
        }
    };
}

// Two request instances that send their lines to each other (no network).
function wiredPair({ isBlockedB = () => false, makeGrant, acceptGrant, undo = () => {} } = {}) {
    const clock = fakeTimers();
    const events = { a: [], b: [] };
    const lines = [];
    let a, b;
    const deliver = (to, from, peer, device) => (peerId, line) => {
        lines.push({ from, op: line.op });
        queueMicrotask(() => to().handle({ peerId: peer, deviceId: device, message: line }));
        return true;
    };
    a = createFriendRequests({ send: deliver(() => b, 'a', 'peerA', 'devA'), changed: e => events.a.push(e), undo,
        makeGrant: makeGrant ?? (async () => ({ room: 'friend-' + 'x'.repeat(22), key: newRoomKey(), descriptor: {}, port: 47200, nodes: [] })),
        ...clock });
    b = createFriendRequests({ send: deliver(() => a, 'b', 'peerB', 'devB'), changed: e => events.b.push(e),
        isBlocked: isBlockedB, acceptGrant: acceptGrant ?? (async () => ({ port: 47201, nodes: [] })), ...clock });
    return { a, b, clock, events, lines };
}
const settle = () => delay(5);

describe('friend requests', { concurrency: 4 }, () => {

test('friend request lines: the room name form and the node rules of readInvite', () => {
    assert.equal(validFriendRoom('friend-' + 'A'.repeat(22)), true);
    assert.equal(validFriendRoom('friend-' + 'A'.repeat(21)), false);
    assert.equal(validFriendRoom('room-' + 'A'.repeat(22)), false);
    assert.deepEqual(validNodes([]), []);
    assert.equal(validNodes([{ id: 'bad', addrs: ['/ip4/1.2.3.4/tcp/1'] }]), null);
    assert.equal(validNodes(Array(17).fill(null)), null);
});

test('friend request: decline, the 120 s end and the 60 s rule (controllable clock)', async () => {
    const { a, b, clock, events } = wiredPair();
    assert.equal(a.request('peerB', 'devB', 'Ann', 'Ben'), 'sent');
    assert.equal(a.request('peerB', 'devB', 'Ann', 'Ben'), 'busy', 'one open request for each peer');
    await settle();
    const incoming = events.b.find(e => e.kind === 'incoming');
    assert.equal(incoming.name, 'Ann');
    assert.equal(b.respond(incoming.id, false), true);
    await settle();
    assert.equal(events.a.at(-1).result, 'declined');
    // A second request within 60 s from the same device gets no bar.
    assert.equal(a.request('peerB', 'devB', 'Ann', 'Ben'), 'sent');
    await settle();
    assert.equal(events.b.filter(e => e.kind === 'incoming').length, 1, 'the 60 s rule');
    clock.advance(120000);
    assert.equal(events.a.at(-1).result, 'no-answer', 'the request ends after 120 s');
    // After 60 s a new request shows again, and it ends at 120 s on both sides.
    assert.equal(a.request('peerB', 'devB', 'Ann', 'Ben'), 'sent');
    await settle();
    assert.equal(events.b.filter(e => e.kind === 'incoming').length, 2);
    clock.advance(119999);
    assert.equal(b.incoming().length, 1);
    clock.advance(1);
    assert.equal(b.incoming().length, 0);
    assert.equal(events.b.at(-1).result, 'no-answer');
});

test('friend request: a blocked device gets decline with no bar; a session close ends the request', async () => {
    const { a, b, events } = wiredPair({ isBlockedB: device => device === 'devA' });
    a.request('peerB', 'devB', 'Ann', 'Ben');
    await settle();
    assert.equal(events.b.length, 0, 'no bar');
    assert.equal(events.a.at(-1).result, 'declined');
    const pair = wiredPair();
    pair.a.request('peerB', 'devB', 'Ann', 'Ben');
    await settle();
    pair.a.closed('peerB');
    pair.b.closed('peerA');
    assert.equal(pair.events.a.at(-1).result, 'closed');
    assert.equal(pair.events.b.at(-1).result, 'closed');
});

test('friend request: a refused grant gives failed on both sides, and A undoes its room', async () => {
    const undone = [];
    const { a, b, events } = wiredPair({ acceptGrant: async () => { throw new Error('refused'); }, undo: e => undone.push(e.deviceId) });
    a.request('peerB', 'devB', 'Ann', 'Ben');
    await settle();
    b.respond(events.b[0].id, true);
    await waitFor(() => events.a.some(e => e.result === 'failed') && events.b.some(e => e.result === 'failed'), 'failed both sides');
    assert.deepEqual(undone, ['devB']);
});

test('127.0.0.1 Add friend: request, accept, grant, done; the friend nodes connect with no further admission', async t => {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    const { roomA, roomB } = await protectedRoomPair(t, A, B);
    const port = randomBasePort();
    const linksA = await startLinks(t, A, { basePort: port });
    const linksB = await startLinks(t, B, { basePort: port + 50 });
    linksA.attachRoom(roomA);
    linksB.attachRoom(roomB);
    assert.deepEqual(linksA.relation(roomB.peerId), { kind: 'add' });
    const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
    assert.equal(friendA, friendB, 'the same friend room on both sides');
    assert.equal(linksA.list().friends[0].name, 'Ben');
    assert.equal(linksB.list().friends[0].name, 'Ann');
    assert.equal(linksA.relation(roomB.peerId).kind, 'open');
    // The descriptor restored on B: the friend nodes open a session with no invite and no owner step.
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online',
        'the two friend nodes have a session');
    const nodeB = linksB.nodeOf(friendB);
    assert.equal(nodeB.memberState().admitted, true);
    assert.equal(nodeB.memberState().owner, false);
    // B saved the room: it is not a saved room of the list.
    assert.deepEqual(B.rooms.status().rooms, []);
    assert.equal(B.rooms.isFriendRoom(friendB), true);
});

for (const forge of ['other-owner', 'other-device']) {
    test(`127.0.0.1 a grant ${forge === 'other-owner' ? 'with a different owner' : 'for a different device'} is refused and nothing is saved`, async t => {
        const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
        const { roomA, roomB } = await protectedRoomPair(t, A, B);
        const port = randomBasePort();
        const linksA = await startLinks(t, A, { basePort: port });
        const linksB = await startLinks(t, B, { basePort: port + 50 });
        const send = roomA.sendTo.bind(roomA);
        // A forged grant: the descriptor of another owner, or of A for another device.
        roomA.sendTo = (peerId, line) => {
            if (line?.type === 'friend' && line.op === 'grant') {
                const other = createDeviceIdentity();
                const owner = forge === 'other-owner' ? createRoomMembership({ identity: other, room: line.room, roomKey: line.key }) : null;
                if (owner) {
                    const d = owner.issue(B.identity.id, true);
                    d.admission = owner.admit({ deviceId: B.identity.id, grant: d.grant });
                    line = { ...line, descriptor: d };
                } else {
                    line = { ...line, descriptor: { ...line.descriptor, grant: { ...line.descriptor.grant, deviceId: other.id } } };
                }
            }
            return send(peerId, line);
        };
        linksA.attachRoom(roomA);
        linksB.attachRoom(roomB);
        const results = [];
        linksA.events.on('request', e => { if (e.kind === 'ended') results.push(e.result); });
        const incoming = new Promise(resolve => linksB.events.once('request', resolve));
        assert.equal(linksA.request(roomA, roomB.peerId).result, 'sent');
        linksB.respond((await incoming).id, true);
        await waitFor(() => results.includes('failed'), 'A gets failed');
        assert.equal(linksB.list().friends.length, 0, 'B saved nothing');
        await waitFor(() => linksA.list().friends.length === 0, 'A forgets its friend room');
        assert.deepEqual(B.rooms.friendArchive().listFriends(), []);
    });
}

for (const withCandidates of [true, false]) {
    test(`127.0.0.1 first contact: discovery off, no UPnP, ${withCandidates ? 'the candidates give a session' : 'no session with no candidates'}`, async t => {
        const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
        const { roomA, roomB } = await protectedRoomPair(t, A, B);
        const port = randomBasePort();
        // A: allowPrivateFullNode and a fixed port. Both: discovery false and upnp false (the start options).
        const linksA = await startLinks(t, A, { basePort: port, candidates: withCandidates, nodeOptions: { allowPrivateFullNode: true } });
        const linksB = await startLinks(t, B, { basePort: port + 50, candidates: withCandidates });
        linksA.attachRoom(roomA);
        linksB.attachRoom(roomB);
        const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
        assert.equal(linksA.nodeOf(friendA).getMultiaddrs().some(a => a.includes(`/tcp/${port}/`) || a.endsWith(`/tcp/${port}`)), true, 'the fixed friend port');
        if (withCandidates) {
            await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online',
                'a session through the candidates only', 15000);
        } else {
            await delay(5000);
            // G7b: the two are still in a common room, thus the state is 'room' (design F5 item 4), not 'online'. The
            // friend link itself has no session.
            assert.equal(linksA.friend(friendA).state, 'room');
            assert.equal(linksB.friend(friendB).state, 'room');
            assert.deepEqual(linksA.nodeOf(friendA).peers(), []);
            assert.deepEqual(linksB.nodeOf(friendB).peers(), []);
        }
    });
}

});
