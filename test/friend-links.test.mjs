// G7a check 3: the friend links with a real archive in a temp folder (127.0.0.1 and mDNS on this PC).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createSavedRooms } from '../src/application/saved-rooms.mjs';
import { makeProfile, protectedRoomPair, startLinks, befriend, waitFor, randomBasePort, fakeProtector, hintFiles } from './helpers/friends.mjs';
import path from 'node:path';
import net from 'node:net';

// A new archive object on the same folder (a restart of the app).
function reopen(profile) {
    profile.rooms.close();
    profile.rooms = createSavedRooms({ dir: path.join(profile.dir, 'saved-rooms'), protector: fakeProtector,
        forgetHints: row => { for (const f of Object.values(hintFiles(profile.dir)(row.name, row.roomKey))) fs.rmSync(f, { force: true }); } });
    return profile;
}

for (const way of ['stored addresses', 'mDNS']) {
    test(`127.0.0.1 friends connect again after a restart through the ${way}`, async t => {
        const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
        t.after(() => { A.rooms.close(); B.rooms.close(); });
        const { roomA, roomB } = await protectedRoomPair(t, A, B);
        const port = randomBasePort();
        const mdns = way === 'mDNS';
        // Stored addresses: no mDNS, A has a fixed port and allowPrivateFullNode. mDNS: no candidate addresses.
        const optsA = { basePort: port, discovery: mdns, candidates: !mdns, nodeOptions: mdns ? {} : { allowPrivateFullNode: true } };
        const optsB = { basePort: port + 50, discovery: mdns, candidates: !mdns };
        let linksA = await startLinks(t, A, optsA);
        let linksB = await startLinks(t, B, optsB);
        linksA.attachRoom(roomA);
        linksB.attachRoom(roomB);
        const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
        await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online', 'online');
        if (!mdns) assert.ok(B.rooms.friendArchive().listFriends()[0].addrs.length > 0, 'B stored addresses of A');
        else assert.deepEqual(B.rooms.friendArchive().listFriends()[0].addrs, []);
        // Quit: stop the nodes and close the archives. Start again with no room.
        await Promise.all([linksA.stop(), linksB.stop(), roomA.stop(), roomB.stop()]);
        reopen(A); reopen(B);
        linksA = await startLinks(t, A, optsA);
        linksB = await startLinks(t, B, optsB);
        assert.equal(linksA.friend(friendA).state, 'offline');
        await waitFor(() => linksA.friend(friendA)?.state === 'online' && linksB.friend(friendB)?.state === 'online',
            `online again through the ${way}`, 30000);
        assert.notEqual(linksB.friend(friendB).lastSeen, null);
    });
}

test('127.0.0.1 remove deletes the room, the row and the hint files; the other side shows removed-you', async t => {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    t.after(() => { A.rooms.close(); B.rooms.close(); });
    const { roomA, roomB } = await protectedRoomPair(t, A, B);
    const port = randomBasePort();
    const linksA = await startLinks(t, A, { basePort: port, nodeOptions: { allowPrivateFullNode: true } });
    const linksB = await startLinks(t, B, { basePort: port + 50 });
    linksA.attachRoom(roomA);
    linksB.attachRoom(roomB);
    const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online', 'online');
    linksA.send(friendA, 'keep this line');
    await waitFor(() => linksB.lines(friendB).length === 1, 'B has the line');
    const row = B.rooms.getRoom(friendB);
    const hints = B.hints(row.name, row.roomKey);
    await waitFor(() => fs.existsSync(hints.peers), 'B has a hint file of the friend room');
    assert.equal(await linksB.remove(friendB), true);
    assert.equal(fs.existsSync(hints.peers), false, 'hint file deleted');
    assert.equal(B.rooms.getRoom(friendB), null, 'room deleted');
    assert.deepEqual(B.rooms.friendArchive().listFriends(), [], 'row deleted');
    assert.deepEqual(B.rooms.lines(friendB), [], 'lines deleted');
    await waitFor(() => linksA.friend(friendA).state === 'removed-you', 'A shows removed-you');
    assert.equal(linksA.nodeOf(friendA), null, 'A stopped its friend node');
    assert.deepEqual(linksA.lines(friendA).map(l => l.text), ['keep this line'], 'A keeps the lines');
    assert.equal(A.rooms.friendArchive().listFriends()[0].state, 'removed-you');
});

test('127.0.0.1 block refuses a later request with no bar; unblock; the cap', async t => {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    t.after(() => { A.rooms.close(); B.rooms.close(); });
    const { roomA, roomB } = await protectedRoomPair(t, A, B);
    const port = randomBasePort();
    const linksA = await startLinks(t, A, { basePort: port, nodeOptions: { allowPrivateFullNode: true }, rateMs: 1 });
    const linksB = await startLinks(t, B, { basePort: port + 50, rateMs: 1 });
    linksA.attachRoom(roomA);
    linksB.attachRoom(roomB);
    const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
    // Both sides: B sends 'unfriend' only on a session that B knows.
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online', 'online');
    assert.equal(await linksB.block(friendB), true);
    assert.deepEqual(linksB.list().blocked.map(b => b.name), ['Ann']);
    assert.equal(linksB.relation(roomA.peerId), null, 'no Add friend line for a blocked person');
    await waitFor(() => linksA.friend(friendA).state === 'removed-you', 'A shows removed-you');
    await linksA.remove(friendA);
    const bars = [], ends = [];
    linksB.events.on('request', e => { if (e.kind === 'incoming') bars.push(e); });
    linksA.events.on('request', e => { if (e.kind === 'ended') ends.push(e.result); });
    await delay(5);
    assert.equal(linksA.request(roomA, roomB.peerId).result, 'sent');
    await waitFor(() => ends.includes('declined'), 'A gets decline');
    assert.deepEqual(bars, [], 'B shows no bar');
    assert.equal(linksB.unblock(linksB.list().blocked[0].deviceId), true);
    assert.deepEqual(linksB.list().blocked, []);
    assert.equal(linksB.relation(roomA.peerId).kind, 'add');
    // The cap: with no free slot, no menu line and no request.
    const C = makeProfile(t, 'c'), D = makeProfile(t, 'd');
    t.after(() => { C.rooms.close(); D.rooms.close(); });
    const pair = await protectedRoomPair(t, C, D);
    const linksC = await startLinks(t, C, { basePort: port + 80, cap: 0 });
    linksC.attachRoom(pair.roomA);
    assert.equal(linksC.relation(pair.roomB.peerId), null);
    assert.equal(linksC.request(pair.roomA, pair.roomB.peerId).result, 'cap');
});

test('saved rooms: status() and listRooms() have no friend room; the reopen handler refuses a friend room', async t => {
    const A = makeProfile(t, 'a');
    t.after(() => A.rooms.close());
    const fa = A.rooms.friendArchive();
    const { roomId } = fa.saveFriendRoom({ name: 'friend-' + 'q'.repeat(22), roomKey: Buffer.alloc(32, 7).toString('base64url'),
        userName: 'Ann', membership: { v: 2 }, friend: { deviceId: 'dev', nickname: 'Ben', slot: 0, addrs: [] } });
    assert.deepEqual(A.rooms.status().rooms, []);
    assert.equal(A.rooms.isFriendRoom(roomId), true);
    assert.equal(A.rooms.getRoom(roomId).protected, true);
    // main.js: asscrack:reopen-room checks isFriendRoom before the start.
    const main = readFileSync(new URL('../src/application/main.js', import.meta.url), 'utf8');
    const handler = main.slice(main.indexOf("handleRoomIpc('asscrack:reopen-room'"));
    assert.match(handler.slice(0, handler.indexOf('reopenRoom(row')), /isFriendRoom\(roomId\)/);
});

test('127.0.0.1 a friend port in use: the friend node starts on port 0 with one WARN line, and the friends connect', async t => {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    t.after(() => { A.rooms.close(); B.rooms.close(); });
    const { roomA, roomB } = await protectedRoomPair(t, A, B);
    const port = randomBasePort();
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(port + 50, '0.0.0.0', resolve));
    t.after(() => blocker.close());
    const logs = [];
    const linksA = await startLinks(t, A, { basePort: port, nodeOptions: { allowPrivateFullNode: true } });
    const linksB = await startLinks(t, B, { basePort: port + 50, log: (level, text) => logs.push([level, text]) });
    linksA.attachRoom(roomA);
    linksB.attachRoom(roomB);
    const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB);
    assert.deepEqual(logs.filter(([level]) => level === 'WARN').map(([, text]) => text),
        [`Friend port ${port + 50} is in use (EADDRINUSE). Start again with port 0`]);
    assert.ok(!linksB.nodeOf(friendB).getMultiaddrs().some(a => a.includes(`/tcp/${port + 50}`)));
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online', 'online');
});
