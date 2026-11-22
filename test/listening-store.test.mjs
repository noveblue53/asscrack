// G4 addition: the saved listening choice of each person (src/application/listening-store.mjs), and the identity that
// keys it (node.memberDevice). The node test is a 127.0.0.1 result, not a LAN result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { listeningRoomTag, listeningStore } from '../src/application/listening-store.mjs';
import { createAsscrackNode } from '../src/network/node.mjs';
import { newRoomKey, readInvite } from '../src/network/invite.mjs';
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs';

function folder(t) {
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-listening-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'listening.json');
}

test('a listening choice stays after a restart, per room and per device; the default (Reset) removes it', t => {
    const file = folder(t);
    const roomA = listeningRoomTag('key-of-room-a');
    const roomB = listeningRoomTag('key-of-room-b');
    assert.notEqual(roomA, roomB);
    assert.equal(listeningRoomTag(null), null);
    const store = listeningStore(file);
    assert.equal(store.set(roomA, 'device-sam', { muted: false, volume: 150 }), true);
    assert.equal(store.set(roomA, 'device-alex', { muted: true, volume: 40 }), true);
    assert.equal(store.set(roomB, 'device-sam', { muted: false, volume: 60 }), true);
    // A restart reads the file again.
    const again = listeningStore(file);
    assert.deepEqual(again.get(roomA, 'device-sam'), { muted: false, volume: 150 });
    assert.deepEqual(again.get(roomA, 'device-alex'), { muted: true, volume: 40 });
    assert.deepEqual(again.get(roomB, 'device-sam'), { muted: false, volume: 60 }, 'each room has its own choice');
    assert.equal(again.get(roomB, 'device-alex'), null);
    // Reset: not muted and 100 %.
    assert.equal(again.set(roomA, 'device-sam', { muted: false, volume: 100 }), true);
    assert.equal(listeningStore(file).get(roomA, 'device-sam'), null);
    // The file has no room key and no name.
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /key-of-room/);
});

test('the store refuses a choice that is not valid, and a file that is not valid gives an empty store', t => {
    const file = folder(t);
    const store = listeningStore(file);
    const room = listeningRoomTag('k');
    for (const bad of [{ muted: false, volume: 201 }, { muted: false, volume: -1 }, { muted: 'no', volume: 50 },
        { muted: false, volume: 50.5 }, null]) {
        assert.equal(store.set(room, 'device', bad), false, JSON.stringify(bad));
    }
    assert.equal(store.set(room, '', { muted: true, volume: 50 }), false);
    assert.equal(store.set(room, 'x'.repeat(129), { muted: true, volume: 50 }), false);
    assert.equal(store.set(room, 'device', { muted: false, volume: 200 }), true);
    assert.equal(store.set(room, 'device', { muted: false, volume: 0 }), true);
    writeFileSync(file, '{not json');
    assert.equal(listeningStore(file).get(room, 'device'), null);
    writeFileSync(file, JSON.stringify({ rooms: { [room]: { device: { muted: false, volume: 999 }, other: { muted: true, volume: 30 } } } }));
    assert.equal(listeningStore(file).get(room, 'device'), null);
    assert.deepEqual(listeningStore(file).get(room, 'other'), { muted: true, volume: 30 });
});

async function waitFor(check, what) {
    for (let i = 0; i < 400 && !check(); i++) await delay(20);
    assert.ok(check(), what);
}

test('127.0.0.1: the device ID of a person stays across a restart; the libp2p peer ID does not', { timeout: 30000 }, async t => {
    const room = 'Listening room';
    const roomKey = newRoomKey();
    const nodes = new Set();
    t.after(() => Promise.allSettled([...nodes].map(node => node.stop())));
    const start = async membership => {
        const node = await createAsscrackNode({ room, roomKey, membership, discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'],
            fullNode: false, heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350 });
        nodes.add(node);
        return node;
    };
    const address = node => node.getMultiaddrs().find(a => a.startsWith('/ip4/127.0.0.1/tcp/') && !a.includes('/p2p-circuit'));
    const ownerDevice = createDeviceIdentity();
    const owner = await start(createRoomMembership({ identity: ownerDevice, room, roomKey, lan: true }));
    const friend = createDeviceIdentity();
    const descriptor = readInvite(owner.createMemberInvite(friend.id)).membership;
    let member = await start(restoreRoomMembership({ identity: friend, room, roomKey, descriptor }));
    await member.connect(address(owner));
    await waitFor(() => owner.peers().includes(member.peerId) && member.peers().includes(owner.peerId), 'admitted');
    assert.equal(owner.memberDevice(member.peerId), friend.id);
    assert.equal(member.memberDevice(owner.peerId), ownerDevice.id);
    const firstPeerId = member.peerId;
    const snapshot = member.membershipSnapshot();
    await member.stop();
    nodes.delete(member);
    // The same person starts again.
    member = await start(restoreRoomMembership({ identity: friend, room, roomKey, descriptor: snapshot }));
    await member.connect(address(owner));
    await waitFor(() => owner.peers().includes(member.peerId), 'admitted again');
    assert.notEqual(member.peerId, firstPeerId, 'a new libp2p peer ID at each start: not a stable key');
    assert.equal(owner.memberDevice(member.peerId), friend.id, 'the same device ID');
    assert.equal(owner.memberDevice('12D3KooWnotapeer'), null);
    // A room with no membership has no device ID.
    const plain = await createAsscrackNode({ room: 'plain', roomKey: newRoomKey(), discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'] });
    nodes.add(plain);
    assert.equal(plain.memberDevice(owner.peerId), null);
});
