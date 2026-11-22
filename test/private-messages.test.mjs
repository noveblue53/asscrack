// G7a check 2: private messages and receipts (design F8). The last test runs on 127.0.0.1 with real friend nodes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createPrivateMessages, validPmText } from '../src/network/private-messages.mjs';
import { createDeviceIdentity } from '../src/network/room-membership.mjs';
import { makeProfile, protectedRoomPair, startLinks, befriend, waitFor, randomBasePort } from './helpers/friends.mjs';

const devA = createDeviceIdentity().id, devB = createDeviceIdentity().id, devX = createDeviceIdentity().id;

function fakeTimers() {
    let now = 5_000_000, seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimer: id => timers.delete(id),
        advance(ms) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } }
    };
}

// A (devA) and B (devB) with a line transport. drop: B gets no line (no ack).
function pair({ drop = () => false } = {}) {
    const clock = fakeTimers();
    const got = [], acks = [], sentByB = [], receipts = [];
    let a, b;
    a = createPrivateMessages({ selfDevice: devA, friendDevice: devB, sessionPeer: () => 'peerB',
        sendTo: (_p, line) => { if (!drop(line)) queueMicrotask(() => b.handle({ peerId: 'peerA', deviceId: devA, message: line })); return true; },
        receive: () => {}, acked: (id, result) => receipts.push([id, result]), ...clock });
    b = createPrivateMessages({ selfDevice: devB, friendDevice: devA, sessionPeer: () => 'peerA',
        sendTo: (_p, line) => { sentByB.push(line); if (line.op === 'ack') acks.push(line.id); queueMicrotask(() => a.handle({ peerId: 'peerB', deviceId: devB, message: line })); return true; },
        receive: msg => { got.push(msg); }, ...clock });
    return { a, b, clock, got, acks, sentByB, receipts };
}

test('private message: msg and ack; the same id twice shows once and gets two acks', async () => {
    const { a, b, got, acks } = pair();
    const id = a.newId();
    assert.match(id, new RegExp(`^${devA}\\.`));
    assert.equal(await a.send(id, 'hello'), 'delivered');
    assert.equal(got.length, 1);
    assert.equal(got[0].text, 'hello');
    // A resend of the same id (for example after a lost ack).
    b.handle({ peerId: 'peerA', deviceId: devA, message: { type: 'pm', v: 1, op: 'msg', id, text: 'hello', time: Date.now() } });
    await delay(1);
    assert.equal(got.length, 1, 'shown one time');
    assert.deepEqual(acks, [id, id], 'two acks');
});

test('private message: a line from a device that is not the friend is ignored', async () => {
    const { b, got, sentByB } = pair();
    const id = `${devX}.00000000-0000-4000-8000-000000000000`;
    b.handle({ peerId: 'peerX', deviceId: devX, message: { type: 'pm', v: 1, op: 'msg', id, text: 'spoof' } });
    // The friend device with an id of another device is also ignored.
    b.handle({ peerId: 'peerA', deviceId: devA, message: { type: 'pm', v: 1, op: 'msg', id, text: 'spoof' } });
    b.handle({ peerId: 'peerX', deviceId: devX, message: { type: 'pm', v: 1, op: 'unfriend' } });
    await delay(1);
    assert.deepEqual(got, []);
    assert.deepEqual(sentByB, []);
});

test('private message: the text limits (1 to 4096 characters, not only spaces)', async () => {
    assert.equal(validPmText('x'), true);
    assert.equal(validPmText('x'.repeat(4096)), true);
    assert.equal(validPmText('x'.repeat(4097)), false);
    assert.equal(validPmText(''), false);
    assert.equal(validPmText('   \n '), false);
    const { a, b, got } = pair();
    assert.equal(await a.send(a.newId(), ' '), 'invalid');
    assert.equal(await a.send(a.newId(), 'x'.repeat(4097)), 'invalid');
    b.handle({ peerId: 'peerA', deviceId: devA, message: { type: 'pm', v: 1, op: 'msg', id: a.newId(), text: 'y'.repeat(4097) } });
    await delay(1);
    assert.deepEqual(got, []);
});

test("private message: 'unconfirmed' after 15 s (controllable clock), and a late ack gives 'delivered'", async () => {
    let held = null;
    const p = pair({ drop: line => { if (line.op === 'msg') { held = line; return true; } return false; } });
    const id = p.a.newId();
    const result = p.a.send(id, 'late');
    p.clock.advance(14999);
    await delay(1);
    assert.deepEqual(p.receipts, []);
    p.clock.advance(1);
    assert.equal(await result, 'unconfirmed');
    p.b.handle({ peerId: 'peerA', deviceId: devA, message: held });
    await delay(5);
    assert.deepEqual(p.receipts, [[id, 'unconfirmed'], [id, 'delivered']]);
    // No session: 'unavailable'.
    const none = createPrivateMessages({ selfDevice: devA, friendDevice: devB, sessionPeer: () => null, sendTo: () => true, receive: () => {} });
    assert.equal(await none.send(none.newId(), 'x'), 'unavailable');
});

test('127.0.0.1 private message between two friend nodes: Delivered, saved on both sides', async t => {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    const { roomA, roomB } = await protectedRoomPair(t, A, B);
    const port = randomBasePort();
    const linksA = await startLinks(t, A, { basePort: port, nodeOptions: { allowPrivateFullNode: true } });
    const linksB = await startLinks(t, B, { basePort: port + 50 });
    linksA.attachRoom(roomA);
    linksB.attachRoom(roomB);
    const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online', 'online');
    const receipts = [], lines = [];
    linksA.events.on('receipt', r => receipts.push(r));
    linksB.events.on('line', l => lines.push(l));
    const sent = linksA.send(friendA, 'hi Ben');
    assert.equal(sent.result, 'sending');
    await waitFor(() => receipts.some(r => r.id === sent.line.id && r.result === 'delivered'), 'Delivered');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].line.text, 'hi Ben');
    assert.equal(linksB.friend(friendB).unread, 1);
    assert.deepEqual(linksB.lines(friendB).map(l => [l.text, l.own]), [['hi Ben', false]]);
    assert.deepEqual(linksA.lines(friendA).map(l => [l.text, l.own]), [['hi Ben', true]]);
    // The friend lines are not lines of a saved room of the list.
    assert.deepEqual(A.rooms.status().rooms, []);
    assert.equal(linksA.send(friendA, '   ').result, 'invalid');
});
