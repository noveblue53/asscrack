// G7a test helpers: two protected room nodes on 127.0.0.1, a real archive in a temp folder for each side, and a
// friend-links instance for each side. No Electron.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAsscrackNode, keyedServiceTag } from '../../src/network/node.mjs';
import { newRoomKey } from '../../src/network/invite.mjs';
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../../src/network/room-membership.mjs';
import { createSavedRooms } from '../../src/application/saved-rooms.mjs';
import { createFriendLinks } from '../../src/application/friend-links.mjs';

export const fakeProtector = { available: () => true, wrap: b => Buffer.concat([Buffer.from('p:'), b]), unwrap: b => Buffer.from(b.subarray(2)) };

export async function waitFor(check, description, ms = 20000) {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await delay(25);
    assert.ok(check(), description);
}

// Disjoint TCP port blocks below Windows ephemeral range (49152+) and 47200 so parallel friend files never collide.
const FILE_PORT_BLOCKS = Object.freeze({
    'device-marks.test.mjs': 20000,
    'friend-auto-allow.test.mjs': 22000,
    'friend-invite.test.mjs': 24000,
    'friend-knock-node.test.mjs': 26000,
    'friend-links.test.mjs': 28000,
    'friend-requests.test.mjs': 30000,
    'friends-offline.test.mjs': 32000,
    'peer-addrs.test.mjs': 34000,
    'private-messages.test.mjs': 36000
});
const callerBlock = FILE_PORT_BLOCKS[path.basename(process.argv[1] || '')];
const portBlockBase = callerBlock ?? 38000;
const portSlots = callerBlock !== undefined ? 20 : 90;
let nextPortSlot = randomInt(portSlots);
export const randomBasePort = () => portBlockBase + ((nextPortSlot++ % portSlots) * 100);

// A profile: the device identity, the archive folder and the saved rooms of one side.
export function makeProfile(t, label, dir = fs.mkdtempSync(path.join(os.tmpdir(), `friends-${label}-`))) {
    const rooms = createSavedRooms({ dir: path.join(dir, 'saved-rooms'), protector: fakeProtector,
        forgetHints: row => { for (const f of Object.values(hintFiles(dir)(row.name, row.roomKey))) fs.rmSync(f, { force: true }); } });
    const identity = createDeviceIdentity();
    const profile = { dir, rooms, identity, hints: hintFiles(dir) };
    t?.after?.(() => { try { profile.rooms?.close(); } catch {} });
    return profile;
}

export const hintFiles = dir => (room, roomKey) => {
    const tag = keyedServiceTag(room, roomKey);
    return { peers: path.join(dir, 'rooms', `${tag}.json`), host: path.join(dir, 'rooms', `${tag}.host.json`) };
};

// Two admitted devices in one protected room (A owner, B admitted), connected on 127.0.0.1.
export async function protectedRoomPair(t, a, b, names = ['Ann', 'Ben']) {
    const room = 'friends-test', roomKey = newRoomKey();
    const ownerMembership = createRoomMembership({ identity: a.identity, room, roomKey });
    const descriptor = ownerMembership.issue(b.identity.id, false);
    descriptor.admission = ownerMembership.admit({ deviceId: b.identity.id, grant: descriptor.grant });
    const memberMembership = restoreRoomMembership({ identity: b.identity, room, roomKey, descriptor });
    const opts = { room, roomKey, listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false, fullNode: false,
        heartbeatInterval: 200, electionDelay: 300, hostTimeout: 1500 };
    const roomA = await createAsscrackNode({ ...opts, membership: ownerMembership, name: names[0] });
    const roomB = await createAsscrackNode({ ...opts, membership: memberMembership, name: names[1] });
    t.after(() => Promise.all([roomA.stop(), roomB.stop()]));
    await roomB.connect(roomA.getMultiaddrs()[0]);
    await waitFor(() => roomA.deviceOf(roomB.peerId) === b.identity.id && roomB.deviceOf(roomA.peerId) === a.identity.id,
        'the two room nodes have a proved session');
    return { roomA, roomB };
}

// A friend-links instance of a profile, started with the open archive.
export async function startLinks(t, profile, options = {}) {
    if (profile.rooms.friendArchive() === null) await profile.rooms.open?.();
    const links = createFriendLinks({ createNode: createAsscrackNode, hintFiles: profile.hints, startStep: 0,
        discovery: false, ...options });
    links.start(profile.identity, profile.rooms.friendArchive());
    t.after(() => links.stop());
    return links;
}

// The request flow: A asks B, B accepts. Resolves when both sides have the friend.
export async function befriend(linksA, linksB, roomA, roomB) {
    const incoming = new Promise(resolve => linksB.events.once('request', e => resolve(e)));
    const sent = linksA.request(roomA, roomB.peerId);
    assert.equal(sent.result, 'sent');
    const request = await incoming;
    assert.equal(request.kind, 'incoming');
    assert.equal(request.name, roomA.name);
    assert.equal(linksB.respond(request.id, true), true);
    await waitFor(() => linksA.list().friends.length === 1 && linksB.list().friends.length === 1 &&
        linksA.list().waiting.length === 0, 'both sides saved the friend');
    return { friendA: linksA.list().friends[0].friendId, friendB: linksB.list().friends[0].friendId };
}
