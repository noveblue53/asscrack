// G7b checks 1 and 2: the offline outbox and the common room (127.0.0.1 on this PC, real friend nodes, a real archive
// in a temp folder for each side). The sender has a controllable clock for the time of each line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAsscrackNode } from '../src/network/node.mjs';
import { createSavedRooms } from '../src/application/saved-rooms.mjs';
import { OUTBOX_CAP } from '../src/application/friend-links.mjs';
import { makeProfile, protectedRoomPair, startLinks, befriend, waitFor, randomBasePort, fakeProtector, hintFiles } from './helpers/friends.mjs';

// A new archive object on the same folder (a restart of the app).
function reopen(profile) {
    profile.rooms.close();
    profile.rooms = createSavedRooms({ dir: path.join(profile.dir, 'saved-rooms'), protector: fakeProtector,
        forgetHints: row => { for (const f of Object.values(hintFiles(profile.dir)(row.name, row.roomKey))) fs.rmSync(f, { force: true }); } });
    return profile;
}

// A clock in the past of this computer (the receiver keeps a time only when it is not in its future), 1 s for each call.
function pastClock() {
    let t = Date.now() - 3600000;
    return () => (t += 1000);
}

// A and B are friends, the links are online, then the room ends and B quits (no session of any kind).
async function friendsThenBQuits(t, optsA = {}, optsB = {}) {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    t.after(() => { A.rooms.close(); B.rooms.close(); });
    const { roomA, roomB } = await protectedRoomPair(t, A, B);
    const port = randomBasePort();
    const a = { basePort: port, discovery: false, nodeOptions: { allowPrivateFullNode: true }, ...optsA };
    const b = { basePort: port + 50, discovery: false, ...optsB };
    const linksA = await startLinks(t, A, a);
    let linksB = await startLinks(t, B, b);
    linksA.attachRoom(roomA);
    linksB.attachRoom(roomB);
    const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online', 'online');
    linksA.attachRoom(null);
    linksB.attachRoom(null);
    await Promise.all([roomA.stop(), roomB.stop()]);
    await linksB.stop();
    await waitFor(() => linksA.friend(friendA).state === 'offline', 'A shows B offline');
    return { A, B, a, b, linksA, friendA, friendB };
}

test('127.0.0.1 outbox: 3 lines with no session arrive once, in order, with away true, and the queue is empty', async t => {
    const { A, B, b, linksA, friendA, friendB } = await friendsThenBQuits(t, { now: pastClock() });
    const sent = ['one', 'two', 'three'].map(text => linksA.send(friendA, text));
    assert.deepEqual(sent.map(s => s.result), ['waiting', 'waiting', 'waiting']);
    assert.equal(linksA.waitingCount(friendA), 3);
    assert.deepEqual(linksA.lines(friendA).map(l => [l.text, l.waiting === true]), [['one', true], ['two', true], ['three', true]]);
    // B starts again: the friend link opens and A sends the queue.
    const receipts = [];
    linksA.events.on('receipt', r => receipts.push(r));
    const linksB = await startLinks(t, B, b);
    const lines = [], batches = [];
    linksB.events.on('line', e => lines.push(e.line));
    linksB.events.on('away', e => batches.push(e));
    await waitFor(() => lines.length === 3 && linksA.waitingCount(friendA) === 0, 'B has the 3 lines and the queue is empty', 30000);
    assert.deepEqual(lines.map(l => l.text), ['one', 'two', 'three']);
    assert.ok(lines.every(l => l.away && l.away.batch === lines[0].away.batch), 'one batch of away lines');
    assert.deepEqual(lines.map(l => l.away.count), [1, 2, 3]);
    assert.deepEqual(sent.map(s => s.line.time), lines.map(l => l.time), 'the original times');
    await waitFor(() => batches.length === 1, 'one away batch event');
    assert.equal(batches[0].count, 3);
    assert.deepEqual(receipts.filter(r => r.result === 'delivered').map(r => r.id).sort(), sent.map(s => s.line.id).sort());
    // A: the own lines are saved with their original times, and none waits.
    assert.deepEqual(linksA.lines(friendA).map(l => [l.text, l.own, l.waiting === true, l.time]),
        sent.map(s => [s.line.text, true, false, s.line.time]));
    // B: each line one time, with its away mark after a new read of the archive.
    const saved = linksB.lines(friendB);
    assert.deepEqual(saved.map(l => l.text), ['one', 'two', 'three']);
    assert.ok(saved.every(l => l.away?.count === 3));
    await delay(500);
    assert.equal(lines.length, 3, 'no repeat');
});

test('127.0.0.1 outbox: a session close before the ack sends the line again, and the receiver shows it once', async t => {
    // B drops its acks while dropAcks is true (a session that closes before the ack).
    let dropAcks = true;
    const createNode = async options => {
        const node = await createAsscrackNode(options);
        const sendTo = node.sendTo;
        node.sendTo = (peerId, line) => (dropAcks && line?.type === 'pm' && line.op === 'ack') ? true : sendTo(peerId, line);
        return node;
    };
    const { B, b, linksA, friendA, friendB } = await friendsThenBQuits(t, { now: pastClock() }, { createNode });
    const sent = linksA.send(friendA, 'once');
    assert.equal(sent.result, 'waiting');
    let linksB = await startLinks(t, B, b);
    let lines = [];
    linksB.events.on('line', e => lines.push(e.line));
    await waitFor(() => lines.length === 1, 'B has the line (no ack)', 30000);
    await linksB.stop();
    await waitFor(() => linksA.friend(friendA).state === 'offline', 'the session closed');
    assert.equal(linksA.waitingCount(friendA), 1, 'the line still waits');
    // The next session: A sends the line again. B knows the id and sends the ack only.
    dropAcks = false;
    const delivered = new Promise(resolve => linksA.events.on('receipt', r => { if (r.id === sent.line.id && r.result === 'delivered') resolve(); }));
    linksB = await startLinks(t, B, b);
    const again = [];
    linksB.events.on('line', e => again.push(e.line));
    await delivered;
    assert.equal(linksA.waitingCount(friendA), 0);
    assert.deepEqual(again, [], 'no second line on B');
    assert.deepEqual(linksB.lines(friendB).map(l => l.text), ['once']);
    assert.deepEqual(linksA.lines(friendA).map(l => [l.text, l.waiting === true]), [['once', false]]);
});

test('127.0.0.1 outbox: a waiting line goes out after a full restart of the sender; the 201st line is refused; Delete', async t => {
    const { A, B, a, b, linksA, friendA, friendB } = await friendsThenBQuits(t, { now: pastClock() });
    const kept = linksA.send(friendA, 'after the restart');
    assert.equal(kept.result, 'waiting');
    for (let i = 1; i < OUTBOX_CAP; i++) assert.equal(linksA.send(friendA, `line ${i}`).result, 'waiting');
    assert.equal(linksA.waitingCount(friendA), 200);
    assert.equal(linksA.send(friendA, 'number 201').result, 'full');
    // Delete removes a waiting line. Then one more line can wait.
    const lines = linksA.lines(friendA);
    const victim = lines.find(l => l.text === 'line 7');
    assert.equal(linksA.deleteWaiting(friendA, victim.id), 'deleted');
    assert.equal(linksA.deleteWaiting(friendA, victim.id), 'gone');
    assert.equal(linksA.waitingCount(friendA), 199);
    assert.ok(!linksA.lines(friendA).some(l => l.text === 'line 7'));
    // Keep only the first line for the restart part.
    for (const line of linksA.lines(friendA)) if (line.id !== kept.line.id) linksA.deleteWaiting(friendA, line.id);
    assert.equal(linksA.waitingCount(friendA), 1);
    // A full restart of A (the archive closes and opens again), then B starts.
    await linksA.stop();
    reopen(A);
    const linksA2 = await startLinks(t, A, a);
    assert.equal(linksA2.waitingCount(friendA), 1, 'the line waits after the restart');
    const linksB = await startLinks(t, B, b);
    const got = [];
    linksB.events.on('line', e => got.push(e.line));
    await waitFor(() => got.length === 1 && linksA2.waitingCount(friendA) === 0, 'the line goes out after the restart', 30000);
    assert.equal(got[0].text, 'after the restart');
    assert.equal(got[0].away.count, 1);
    assert.deepEqual(linksB.lines(friendB).map(l => l.text), ['after the restart']);
});


test('127.0.0.1 outbox: Remove friend deletes the queue of that friend', async t => {
    const { A, linksA, friendA } = await friendsThenBQuits(t);
    assert.equal(linksA.send(friendA, 'for the bin').result, 'waiting');
    assert.equal(A.rooms.friendArchive().listOutbox(friendA).length, 1);
    assert.equal(await linksA.remove(friendA), true);
    assert.deepEqual(A.rooms.friendArchive().listOutbox(friendA), [], 'the queue of the removed friend is deleted');
});

test('127.0.0.1 outbox: after unfriend from the other side the waiting line stays, and a new line is refused', async t => {
    // B drops its acks: the line of A arrives, but it still waits on A when B removes A.
    const createNode = async options => {
        const node = await createAsscrackNode(options);
        const sendTo = node.sendTo;
        node.sendTo = (peerId, line) => (line?.type === 'pm' && line.op === 'ack') ? true : sendTo(peerId, line);
        return node;
    };
    const { B, b, linksA, friendA, friendB } = await friendsThenBQuits(t, {}, { createNode });
    const sent = linksA.send(friendA, 'no ack for this');
    const linksB = await startLinks(t, B, b);
    await waitFor(() => linksB.lines(friendB).length === 1 && linksB.friend(friendB).state === 'online', 'B has the line', 30000);
    assert.equal(await linksB.remove(friendB), true);
    await waitFor(() => linksA.friend(friendA).state === 'removed-you', 'A shows removed-you');
    assert.equal(linksA.waitingCount(friendA), 1, 'the waiting line stays');
    assert.deepEqual(linksA.lines(friendA).map(l => [l.id, l.waiting === true]), [[sent.line.id, true]]);
    assert.equal(linksA.send(friendA, 'more').result, 'removed');
});

// Check 2: friends whose friend nodes cannot connect (no listen address, no mDNS), in one protected room.
test('127.0.0.1 common room: the pm lines go on the room session; the addrs line lets the friend link connect', async t => {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    t.after(() => { A.rooms.close(); B.rooms.close(); });
    const port = randomBasePort();
    const noListen = { discovery: false, nodeOptions: { listen: [] } };
    const optsA = { ...noListen, basePort: port, now: pastClock() };
    const optsB = { ...noListen, basePort: port + 50 };
    const first = await protectedRoomPair(t, A, B);
    const linksA = await startLinks(t, A, optsA);
    let linksB = await startLinks(t, B, optsB);
    linksA.attachRoom(first.roomA, { name: 'Game night' });
    linksB.attachRoom(first.roomB, { name: 'Game night' });
    const { friendA, friendB } = await befriend(linksA, linksB, first.roomA, first.roomB);
    await waitFor(() => linksA.friend(friendA).state === 'room' && linksB.friend(friendB).state === 'room', 'in a common room');
    assert.equal(linksA.friend(friendA).roomName, 'Game night');
    await delay(1500);
    assert.deepEqual(linksA.nodeOf(friendA).peers(), [], 'the friend nodes cannot connect');
    // A live line on the room session: it arrives in the friend conversation of B, and A gets Delivered.
    const receipts = [], lines = [];
    linksA.events.on('receipt', r => receipts.push(r));
    const onLine = e => lines.push(e);
    linksB.events.on('line', onLine);
    const live = linksA.send(friendA, 'through the room');
    assert.equal(live.result, 'sending');
    await waitFor(() => receipts.some(r => r.id === live.line.id && r.result === 'delivered'), 'Delivered through the room');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].friendId, friendB);
    assert.equal(lines[0].line.away, undefined);
    // The room ends: a line waits. A new common room sends it with away: true.
    linksA.attachRoom(null);
    linksB.attachRoom(null);
    await Promise.all([first.roomA.stop(), first.roomB.stop()]);
    await waitFor(() => linksA.friend(friendA).state === 'offline', 'no route');
    const queued = linksA.send(friendA, 'waited for the room');
    assert.equal(queued.result, 'waiting');
    const second = await protectedRoomPair(t, A, B);
    linksA.attachRoom(second.roomA, { name: 'Second room' });
    linksB.attachRoom(second.roomB, { name: 'Second room' });
    await waitFor(() => lines.length === 2 && linksA.waitingCount(friendA) === 0, 'the queue went on the room session');
    assert.equal(lines[1].line.text, 'waited for the room');
    assert.equal(lines[1].line.away.count, 1);
    assert.deepEqual(linksA.nodeOf(friendA).peers(), [], 'still no friend link');
    // B starts its links again with a listen address on a new port (the stored candidates of A for B are not valid):
    // B sends the addrs line in the room, and A dials B at once.
    await linksB.stop();
    linksB = await startLinks(t, B, { basePort: port + 70, discovery: false });
    linksB.attachRoom(second.roomB, { name: 'Second room' });
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online',
        'the friend link connects through the addrs line', 20000);
    assert.ok(A.rooms.friendArchive().listFriends()[0].addrs.length > 0, 'A stored the addresses of B');
});

test('127.0.0.1 availability: the friend sees Away, Do not disturb (with the note) and Idle Peer', async t => {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    t.after(() => { A.rooms.close(); B.rooms.close(); });
    const { roomA, roomB } = await protectedRoomPair(t, A, B);
    const port = randomBasePort();
    const linksA = await startLinks(t, A, { basePort: port, discovery: false, nodeOptions: { allowPrivateFullNode: true } });
    const linksB = await startLinks(t, B, { basePort: port + 50, discovery: false });
    linksA.attachRoom(roomA);
    linksB.attachRoom(roomB);
    const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online', 'online');
    assert.equal(linksB.friend(friendB).availability, null);
    linksA.setAvailability({ state: 'away', note: 'lunch' });
    await waitFor(() => linksB.friend(friendB).availability === 'away', 'Away');
    assert.equal(linksB.friend(friendB).note, 'lunch');
    linksA.setAvailability({ state: 'dnd', note: '' });
    await waitFor(() => linksB.friend(friendB).availability === 'dnd', 'Do not disturb');
    linksA.setAvailability({ idle: true });
    await waitFor(() => linksB.friend(friendB).availability === 'idle', 'Idle Peer');
    linksA.setAvailability({ state: 'available', note: '', idle: false });
    await waitFor(() => linksB.friend(friendB).availability === null, 'available');
});
