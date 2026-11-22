// A protected room with an owner and one member on 127.0.0.1 (no discovery), for the diagnostics tests.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAsscrackNode } from '../../src/network/node.mjs';
import { newRoomKey, readInvite } from '../../src/network/invite.mjs';
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../../src/network/room-membership.mjs';

export function localAddress(node) {
    return node.getMultiaddrs().find(value => value.startsWith('/ip4/127.0.0.1/tcp/') && !value.includes('/p2p-circuit'));
}

export async function waitFor(predicate, what, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await predicate()) return; await delay(20); }
    assert.fail(`timeout: ${what}`);
}

// options: { room, ownerName, memberName, nodeOptions: role => extra options, onNode: (node, role) => before the connect }.
export async function protectedPair(t, { room = 'Diag room', ownerName = 'Owner', memberName = 'Member', nodeOptions = () => ({}), onNode = () => {} } = {}) {
    const roomKey = newRoomKey();
    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: true });
    const dirs = [];
    const nodes = [];
    t.after(async () => { await Promise.allSettled(nodes.map(n => n.stop())); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
    async function start(membership, name, role) {
        const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-diag-'));
        dirs.push(dir);
        const node = await createAsscrackNode({ room, roomKey, membership, name, discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'],
            fullNode: false, heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350, downloadDir: dir, ...nodeOptions(role) });
        nodes.push(node);
        node.dir = dir;
        onNode(node, role);
        return node;
    }
    const owner = await start(ownerMembership, ownerName, 'owner');
    const identity = createDeviceIdentity();
    const invite = owner.createMemberInvite(identity.id, { canHost: true });
    const member = await start(restoreRoomMembership({ identity, room, roomKey, descriptor: readInvite(invite).membership }), memberName, 'member');
    await member.connect(localAddress(owner));
    await waitFor(() => member.peers().includes(owner.peerId) && owner.peers().includes(member.peerId), 'session');
    await waitFor(() => owner.diagCapable(member.peerId) && member.diagCapable(owner.peerId), 'diag ability in hello');
    return { owner, member, roomKey, invite, dirs };
}
