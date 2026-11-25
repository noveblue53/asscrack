// 1.0.6: the address refresh of the friend links (friend-refresh.mjs, friend-links.mjs). 127.0.0.1 on this PC, real friend
// nodes and a real archive in a temp folder for each side; not a LAN result. A has no inbound address (listen: [], a PC
// behind NAT). B starts again on new ports: the saved addresses of A for B are old, and B cannot dial A. No mDNS.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSavedRooms } from '../src/application/saved-rooms.mjs';
import { createRateLimit, hereLine, readHere, readWhere, readWhereFor, REFRESH_LIMITS, whereForLine, whereLine,
    whereTag } from '../src/application/friend-refresh.mjs';
import { createDeviceIdentity } from '../src/network/room-membership.mjs';
import { makeProfile, protectedRoomPair, startLinks, waitFor, randomBasePort, fakeProtector, hintFiles } from './helpers/friends.mjs';

const loop = { allowPrivateFullNode: true };
// Short limits for the test run (the defaults are in REFRESH_LIMITS; the timing check of the app uses the defaults).
const fast = { askGapMs: 1500, repeatMs: 2500, debounceMs: 100 };

function reopen(profile) {
    profile.rooms.close();
    profile.rooms = createSavedRooms({ dir: path.join(profile.dir, 'saved-rooms'), protector: fakeProtector,
        forgetHints: row => { for (const f of Object.values(hintFiles(profile.dir)(row.name, row.roomKey))) fs.rmSync(f, { force: true }); } });
    return profile;
}

// X asks Y in the room pair (rx, ry); Y accepts. Returns the friend IDs on both sides.
async function befriend(lx, ly, rx, ry) {
    const nx = lx.list().friends.length, ny = ly.list().friends.length;
    const incoming = new Promise(resolve => {
        const on = e => { if (e.kind === 'incoming') { ly.events.off('request', on); resolve(e); } };
        ly.events.on('request', on);
    });
    assert.equal(lx.request(rx, ry.peerId).result, 'sent');
    assert.equal(ly.respond((await incoming).id, true), true);
    await waitFor(() => lx.list().friends.length === nx + 1 && ly.list().friends.length === ny + 1 && lx.list().waiting.length === 0,
        'both sides saved the friend');
    return { x: lx.list().friends.find(f => f.name === ry.name).friendId, y: ly.list().friends.find(f => f.name === rx.name).friendId };
}

async function pairRoom(t, X, Y, names, lx, ly) {
    const { roomA, roomB } = await protectedRoomPair(t, X, Y, names);
    lx.attachRoom(roomA);
    ly.attachRoom(roomB);
    return { rx: roomA, ry: roomB };
}

async function leaveRoom(lx, ly, rooms) {
    lx.attachRoom(null);
    ly.attachRoom(null);
    await Promise.all([rooms.rx.stop(), rooms.ry.stop()]);
}

const online = (links, id) => links.friend(id)?.status === 'online';

// A (no inbound address), B and C. B-C are friends. friendsAC: A-C are friends too (else C is only in a room with A).
async function trio(t, { optsA = {}, optsB = {}, optsC = {}, friendsAC = true } = {}) {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b'), C = makeProfile(t, 'c');
    t.after(() => { A.rooms.close(); B.rooms.close(); C.rooms.close(); });
    const port = randomBasePort();
    const a = { basePort: port, refreshLimits: fast, nodeOptions: { ...loop, listen: [] }, ...optsA };
    const b = { basePort: port + 30, refreshLimits: fast, nodeOptions: loop, ...optsB };
    const c = { basePort: port + 60, refreshLimits: fast, nodeOptions: loop, ...optsC };
    const linksA = await startLinks(t, A, a), linksC = await startLinks(t, C, c);
    let linksB = await startLinks(t, B, b);
    const journal = { a: [], b: [], c: [] };
    linksA.events.on('journal', e => journal.a.push(e));
    linksC.events.on('journal', e => journal.c.push(e));
    let rooms = await pairRoom(t, A, B, ['Ann', 'Ben'], linksA, linksB);
    const ab = await befriend(linksA, linksB, rooms.rx, rooms.ry);
    await leaveRoom(linksA, linksB, rooms);
    rooms = await pairRoom(t, B, C, ['Ben', 'Cal'], linksB, linksC);
    const bc = await befriend(linksB, linksC, rooms.rx, rooms.ry);
    await leaveRoom(linksB, linksC, rooms);
    let ac = null;
    if (friendsAC) {
        rooms = await pairRoom(t, A, C, ['Ann', 'Cal'], linksA, linksC);
        ac = await befriend(linksA, linksC, rooms.rx, rooms.ry);
        await leaveRoom(linksA, linksC, rooms);
    }
    await waitFor(() => online(linksA, ab.x) && online(linksB, bc.x) && (!ac || online(linksA, ac.x)), 'the friend links are online');
    // B quits (a bye line) and starts again on new ports with a new archive object: the old addresses of B are not valid.
    async function restartB(extra = {}) {
        await linksB.stop();
        await waitFor(() => linksA.friend(ab.x).status === 'offline', 'A shows B offline (B quit)');
        reopen(B);
        linksB = await startLinks(t, B, { ...b, basePort: port + 90, ...extra });
        linksB.events.on('journal', e => journal.b.push(e));
        return linksB;
    }
    return { A, B, C, linksA, linksC, get linksB() { return linksB; }, ab, bc, ac, journal, restartB };
}

describe('friend refresh', { concurrency: 3 }, () => {
test('refresh lines: the tag hides the device ID; each reader refuses a bad line', () => {
    const device = 'd'.repeat(43);
    const tag = whereTag('n'.repeat(22), device);
    assert.match(tag, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(tag, whereTag('m'.repeat(22), device), 'a new nonce gives a new tag');
    const line = whereLine('i'.repeat(22), 'n'.repeat(22), [{ deviceId: device, port: 4001, nodes: [{ id: '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo', addrs: ['/ip4/1.2.3.4/tcp/4001', '/ip4/1.2.3.5/tcp/4001', '/ip4/1.2.3.6/tcp/4001', '/ip4/1.2.3.7/tcp/4001', '/ip4/1.2.3.8/tcp/4001'] }] }]);
    assert.equal(JSON.stringify(line).includes(device), false, 'no device ID in the where line');
    assert.equal(line.ask[0].nodes[0].addrs.length, REFRESH_LIMITS.maxOwnAddrs);
    assert.equal(readWhere(line).ask[0].tag, tag);
    assert.equal(readWhere({ ...line, ask: [] }), null);
    assert.equal(readWhere({ ...line, ask: Array(33).fill({ tag }) }), null, 'at most 32 friends in one line');
    assert.equal(readWhere({ ...line, id: 'x' }), null);
    assert.deepEqual(readWhere({ ...line, ask: [{ tag, port: 0, nodes: [] }] }).ask[0].nodes, [], 'a bad own part is dropped');
    assert.equal(readWhereFor(whereForLine('i'.repeat(22), 'not a device')), null);
    assert.equal(readHere(hereLine('i'.repeat(22), tag, 4001, [])), null, 'an answer with no address');
    assert.equal(readHere({ ...hereLine('i'.repeat(22), tag, 4001, [{ id: 'bad', addrs: ['/ip4/1.2.3.4/tcp/1'] }]) }), null);
    let now = 0;
    const limit = createRateLimit({ limit: 3, windowMs: 60000, now: () => now });
    assert.deepEqual([1, 2, 3, 4].map(() => limit.allow('x')), [true, true, true, false]);
    assert.equal(limit.allow('y'), true, 'each key has its own count');
    now = 60001;
    assert.equal(limit.allow('x'), true, 'the window moves');
});

test('127.0.0.1 friend path: A finds B again through the friend C after B moved to a new port', async t => {
    const s = await trio(t);
    // B does not ask: only the ask of A can find B (B cannot dial A).
    const started = Date.now();
    await s.restartB({ refresh: false });
    await waitFor(() => online(s.linksA, s.ab.x), 'A finds B through C', 20000);
    const ms = Date.now() - started;
    const a = s.journal.a, c = s.journal.c;
    assert.ok(a.some(e => e.event === 'ask' && e.role === 'asker' && e.result === 'sent' && e.friends >= 1), 'A asked its friend C');
    assert.ok(c.some(e => e.event === 'answer' && e.role === 'helper' && e.result === 'forwarded'), 'C forwarded the ask to B');
    assert.ok(c.some(e => e.event === 'answer' && e.role === 'helper' && e.result === 'relayed'), 'C relayed the answer of B');
    assert.ok(s.journal.b.some(e => e.event === 'answer' && e.role === 'friend' && e.result === 'answered'), 'B answered');
    assert.ok(a.some(e => e.event === 'addrs' && e.source === 'ask' && e.result === 'received' && e.count > 0), 'A got addresses');
    await waitFor(() => a.some(e => e.event === 'addrs' && e.source === 'ask' && e.result === 'saved'), 'A saved after the session');
    const saved = s.A.rooms.friendArchive().listFriends().find(f => f.roomId === s.ab.x).addrs;
    assert.ok(saved.some(n => n.id === s.linksB.nodeOf(s.ab.y).peerId), 'the saved address has the new peer ID of B');
    t.diagnostic(`127.0.0.1: A found B again after ${ms} ms (test limits ${JSON.stringify(fast)})`);
});

test('127.0.0.1 with no refresh, A does not find B in the same time (the old addresses only)', async t => {
    const s = await trio(t, { optsA: { refresh: false }, optsB: { refresh: false }, optsC: { refresh: false } });
    await s.restartB({ refresh: false });
    // The same 20 s as the wait of the refresh tests.
    await new Promise(resolve => setTimeout(resolve, 20000));
    assert.equal(online(s.linksA, s.ab.x), false, 'A still has no session with B');
    assert.ok(['offline', 'connecting', 'unreachable'].includes(s.linksA.friend(s.ab.x).status));
});

test('127.0.0.1 the friend side: B asks C about A, and A dials the addresses of B in the forwarded ask', async t => {
    // A does not ask: B (with no route to A) asks C; C forwards to A with the own addresses of B; A dials B.
    const s = await trio(t, { optsA: { refresh: false } });
    await s.restartB();
    await waitFor(() => online(s.linksA, s.ab.x), 'A connects to B after the ask of B', 20000);
    assert.ok(s.journal.b.some(e => e.event === 'ask' && e.role === 'asker' && e.result === 'sent'), 'B asked');
    assert.ok(s.journal.a.some(e => e.event === 'answer' && e.role === 'friend' && e.via === 'friend'), 'A got the forwarded ask');
    assert.ok(s.journal.a.some(e => e.event === 'try' && e.via === 'ask' && e.result === 'ok'), 'A dialed an address of B');
});

test('127.0.0.1 room path: C is only a member of the current room of A, and a friend of B', async t => {
    const s = await trio(t, { friendsAC: false });
    // A and C are in one protected room (not friends). C has the friend link to B.
    const rooms = await pairRoom(t, s.A, s.C, ['Ann', 'Cal'], s.linksA, s.linksC);
    await s.restartB({ refresh: false });
    await waitFor(() => online(s.linksA, s.ab.x), 'A finds B through the room member C', 20000);
    assert.ok(s.journal.a.some(e => e.event === 'ask' && e.result === 'sent' && e.members >= 1), 'A asked the room member');
    assert.ok(s.journal.c.some(e => e.event === 'answer' && e.role === 'helper' && e.via === 'room' && e.result === 'forwarded'));
    assert.ok(s.journal.a.some(e => e.event === 'addrs' && e.source === 'ask' && e.via === 'room'));
    await leaveRoom(s.linksA, s.linksC, rooms);
});

test('127.0.0.1 trust and limits: no answer for a device that is not a friend, no answer to a line that was not asked, the helper rate', async t => {
    const s = await trio(t, { optsA: { refresh: false }, optsB: { refresh: false }, optsC: { refresh: false } });
    const nodeA = s.linksA.nodeOf(s.ac.x), peerC = nodeA.peers()[0];
    const nodeC = s.linksC.nodeOf(s.bc.y), peerB = nodeC.peers()[0];
    const bJournal = [];
    s.linksB.events.on('journal', e => bJournal.push(e));
    // C forwards an ask for a device that is not a friend of B: B does not answer.
    nodeC.sendTo(peerB, whereForLine('f'.repeat(22), createDeviceIdentity().id));
    await waitFor(() => bJournal.filter(e => e.event === 'answer' && e.role === 'friend' && e.result === 'unknown').length >= 1,
        'B refuses the ask for a device that is not its friend');
    assert.equal(bJournal.some(e => e.event === 'answer' && e.result === 'answered'), false);
    // An answer that A did not ask for: A does not dial it.
    const tag = whereTag('n'.repeat(22), s.B.identity.id);
    s.linksC.nodeOf(s.ac.y).sendTo(s.linksC.nodeOf(s.ac.y).peers()[0],
        hereLine('h'.repeat(22), tag, 4001, [{ id: nodeC.peerId, addrs: ['/ip4/127.0.0.1/tcp/9'] }]));
    // A tag of a device that C does not know: no forward. Then the rate of the helper: at most 3 lines each minute.
    for (let i = 0; i < 4; i++) {
        nodeA.sendTo(peerC, whereLine(`${'w'.repeat(21)}${i}`, 'n'.repeat(22), [{ deviceId: 'q'.repeat(43) }]));
    }
    await waitFor(() => s.journal.c.some(e => e.event === 'answer' && e.role === 'helper' && e.result === 'rate'), 'the fourth line is over the rate');
    assert.equal(s.journal.c.some(e => e.result === 'forwarded'), false, 'no forward for an unknown device');
    assert.equal(s.journal.a.some(e => e.event === 'addrs' && e.source === 'ask'), false, 'A ignores an answer it did not ask for');
    assert.equal(s.journal.a.some(e => e.event === 'try' && e.via === 'ask'), false);
});
});
