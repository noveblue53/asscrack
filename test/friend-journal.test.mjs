// 1.0.6: the friend link events of the diagnostics journal (friend-links.mjs 'journal', diag-events.mjs
// projectFriendEvent, journal.mjs type 'friend'). The friend is a peer ID and a device tag: no name, no device ID, no
// friend room, no address. 127.0.0.1 on this PC for the real nodes; not a LAN result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { friendTag, projectFriendEvent } from '../src/application/diag-events.mjs';
import { createJournal, redact } from '../src/application/journal.mjs';
import { dialErrorCode } from '../src/network/node.mjs';
import { makeProfile, protectedRoomPair, startLinks, befriend, waitFor, randomBasePort } from './helpers/friends.mjs';

const KEY = '0123456789abcdef0123456789abcdef';
const PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const DEVICE = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8';

const write = data => {
    const projected = projectFriendEvent(data, KEY);
    return projected && redact(projected[0], projected[1]);
};

test('friend journal: each event names its fields; the device ID becomes a tag; an address becomes a class', () => {
    const tag = friendTag(DEVICE, KEY);
    assert.match(tag, /^[0-9a-f]{8}$/);
    assert.equal(friendTag(DEVICE, KEY), tag, 'the same tag in each run of the data folder');
    assert.notEqual(friendTag(DEVICE, 'f'.repeat(32)), tag, 'another data folder gives another tag');
    assert.equal(friendTag(DEVICE, null), undefined);
    assert.deepEqual(write({ event: 'try', deviceId: DEVICE, peer: PEER, node: PEER, via: 'full-node', result: 'failed',
        reason: 'refused', error: 'ECONNREFUSED', addr: `/ip4/203.0.113.7/tcp/47201/p2p/${PEER}`, ms: 2034, name: 'Ben' }),
    { type: 'friend', event: 'try', peer: PEER, node: PEER, tag, via: 'full-node', result: 'failed', reason: 'refused',
        error: 'ECONNREFUSED', addr: 'public', transport: 'tcp', port: 47201, ms: 2034 });
    assert.deepEqual(write({ event: 'session', deviceId: DEVICE, peer: PEER, state: 'closed', cause: 'bye', secs: 12.34 }),
        { type: 'friend', event: 'session', peer: PEER, tag, state: 'closed', secs: 12.34, cause: 'bye' });
    assert.equal(write({ event: 'session', state: 'refused', cause: 'wrong proof for this room' }).cause, 'wrong-proof');
    assert.deepEqual(write({ event: 'state', deviceId: DEVICE, from: 'unreachable', to: 'offline', cause: 'timeout', ms: 300000 }),
        { type: 'friend', event: 'state', tag, from: 'unreachable', to: 'offline', cause: 'timeout', ms: 300000 });
    assert.equal(write({ event: 'state', from: null, to: 'connecting', cause: 'start' }).from, undefined);
    assert.deepEqual(write({ event: 'addrs', deviceId: DEVICE, source: 'ask', via: 'room', result: 'saved', count: 2 }),
        { type: 'friend', event: 'addrs', tag, source: 'ask', via: 'room', result: 'saved', count: 2 });
    assert.deepEqual(write({ event: 'ask', deviceId: DEVICE, role: 'asker', reason: 'failed', result: 'sent', friends: 1, members: 2, count: 0 }),
        { type: 'friend', event: 'ask', tag, role: 'asker', reason: 'failed', result: 'sent', friends: 1, members: 2, count: 0 });
    assert.deepEqual(write({ event: 'network', cause: 'resume', count: 3, deviceId: DEVICE }), { type: 'friend', event: 'network', cause: 'resume', count: 3 });
    assert.equal(write({ event: 'try', error: 'connect ECONNREFUSED 203.0.113.7:47201' }).error, undefined, 'an error text is not a code');
    assert.equal(projectFriendEvent({ event: 'line', text: 'hi' }), null);
    assert.equal(dialErrorCode(Object.assign(new Error('x'), { name: 'AggregateError', errors: [Object.assign(new Error('y'), { code: 'ECONNREFUSED' })] })), 'ECONNREFUSED');
    assert.equal(dialErrorCode(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'AbortError');
    assert.equal(dialErrorCode(new Error('plain')), undefined);
});

test('127.0.0.1 friend journal: a start, the session, a bye, the statuses and the failed tries, with no name, device ID or address', async t => {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    t.after(() => { A.rooms.close(); B.rooms.close(); });
    // Canary names: the room names become the friend nicknames.
    const names = ['CanaryAnnQx7', 'CanaryBenQx7'];
    const { roomA, roomB } = await protectedRoomPair(t, A, B, names);
    const port = randomBasePort();
    const linksA = await startLinks(t, A, { basePort: port, nodeOptions: { allowPrivateFullNode: true } });
    const linksB = await startLinks(t, B, { basePort: port + 50, nodeOptions: { allowPrivateFullNode: true } });
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-friend-journal-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const journal = createJournal({ dir, budgets: { default: [1e6, 0] } });
    const raw = [];
    linksA.events.on('journal', data => {
        raw.push(data);
        const projected = projectFriendEvent(data, KEY);
        if (projected) journal.write(projected[0], projected[1]);
    });
    linksA.attachRoom(roomA);
    linksB.attachRoom(roomB);
    const { friendA } = await befriend(linksA, linksB, roomA, roomB);
    await waitFor(() => linksA.friend(friendA).status === 'online', 'online');
    linksA.attachRoom(null);
    linksB.attachRoom(null);
    await Promise.all([roomA.stop(), roomB.stop()]);
    await linksB.stop();
    await waitFor(() => linksA.friend(friendA).status === 'offline', 'offline after the bye');
    // A network change gives a try now: B is gone, thus the try fails (refused).
    linksA.networkChanged('changed');
    await waitFor(() => raw.some(e => e.event === 'try' && e.result === 'failed'), 'a failed try', 10000);
    journal.flushSync();
    const files = readdirSync(dir).filter(n => n.endsWith('.jsonl'));
    const bytes = Buffer.concat(files.map(n => readFileSync(path.join(dir, n))));
    const lines = bytes.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.type === 'friend');
    const tag = friendTag(B.identity.id, KEY);
    const seq = lines.map(l => `${l.event}:${l.to ?? l.state ?? l.result ?? l.cause ?? ''}`);
    for (const want of ['start:', 'state:connecting', 'session:open', 'state:online', 'session:closed', 'state:offline',
        'network:changed', 'try:failed']) assert.ok(seq.includes(want), `the journal has ${want}: ${seq.join(' ')}`);
    assert.ok(lines.filter(l => l.event !== 'network').every(l => l.tag === tag), 'each friend line has the device tag of B');
    const closed = lines.find(l => l.event === 'session' && l.state === 'closed');
    assert.equal(closed.cause, 'bye');
    const offline = lines.find(l => l.event === 'state' && l.to === 'offline');
    assert.equal(offline.cause, 'bye');
    const failed = lines.find(l => l.event === 'try' && l.result === 'failed');
    assert.ok(failed.reason && failed.addr && failed.error, `a failed try has the reason, the address class and the error code: ${JSON.stringify(failed)}`);
    // No name, no nickname, no device ID, no friend room and no IP address in the bytes (UTF-8 and UTF-16LE).
    const room = A.rooms.getRoom(friendA);
    const ips = [...new Set(raw.map(e => /\/ip4\/([^/]+)/.exec(e.addr ?? '')?.[1]).filter(Boolean))];
    assert.ok(ips.length > 0, 'the raw events had addresses');
    for (const needle of [...names, A.identity.id, B.identity.id, room.name, room.roomKey, ...ips]) {
        for (const encoding of ['utf8', 'utf16le']) {
            assert.equal(bytes.includes(Buffer.from(needle, encoding)), false, `the journal has no ${needle.slice(0, 12)}… (${encoding})`);
        }
    }
});
