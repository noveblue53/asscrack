// easy-join part 2: the relay rule of a knock, with real libp2p nodes on 127.0.0.1 (owner, relaying member, another
// member, and a peer that is not admitted). These are 127.0.0.1 results, not internet results. This file imports only
// modules that exist on af40267, thus a run on af40267 shows the old rule (each circuit of a peer that is not admitted
// is refused).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { multiaddr } from '@multiformats/multiaddr'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'

const room = 'Knock room'
const timing = { discovery: false, heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350, redialInterval: 500 }

function localAddress(node) {
    return node.getMultiaddrs().find(value => value.startsWith('/ip4/127.0.0.1/tcp/') && !value.includes('/p2p-circuit'))
}

async function waitFor(predicate, description, tries = 500) {
    for (let attempt = 0; attempt < tries; attempt++) {
        if (predicate()) return
        await delay(20)
    }
    assert.fail(description)
}

// An owner with no public address, and a member that can host and relays (the owner has a reservation on it).
async function setup(t, { relayKnock = true } = {}) {
    const roomKey = newRoomKey()
    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey })
    const nodes = new Set()
    t.after(() => Promise.allSettled([...nodes].map(node => node.stop())))
    const start = async options => {
        const node = await createAsscrackNode({ room, roomKey, listen: ['/ip4/127.0.0.1/tcp/0'], ...timing, ...options })
        nodes.add(node)
        return node
    }
    const owner = await start({ membership: ownerMembership, name: 'Owner', fullNode: false, allowPrivateFullNode: true, knock: true })
    const memberDevice = createDeviceIdentity()
    const member = await start({ membership: restoreRoomMembership({ identity: memberDevice, room, roomKey,
        descriptor: ownerMembership.issue(memberDevice.id, true) }), name: 'Relay', fullNode: true, allowPrivateFullNode: true, knock: relayKnock })
    await owner.connect(localAddress(member))
    await waitFor(() => member.fullNode() && owner.getMultiaddrs().some(addr => addr.includes('/p2p-circuit')),
        'the owner has a reservation on the relaying member')
    return { roomKey, ownerMembership, owner, member, start, nodes }
}

test('127.0.0.1 relay: a peer that is not admitted gets a circuit to the owner peer, but not to a member that is not the owner', { timeout: 40000 }, async t => {
    const { owner, member, roomKey, ownerMembership, start, nodes } = await setup(t)
    // A second member (not the owner) with a reservation on the relaying member.
    const otherDevice = createDeviceIdentity()
    const other = await start({ membership: restoreRoomMembership({ identity: otherDevice, room, roomKey,
        descriptor: ownerMembership.issue(otherDevice.id, false) }), name: 'Other', fullNode: false, allowPrivateFullNode: true, knock: true })
    await other.connect(localAddress(owner))
    await other.connect(localAddress(member))
    await waitFor(() => other.getMultiaddrs().some(addr => addr.includes('/p2p-circuit')), 'the other member has a reservation')
    // A plain libp2p node with no membership (the same transports as the knock node).
    const stranger = await createAsscrackNode({ room: 'another room', roomKey: newRoomKey(), listen: ['/ip4/127.0.0.1/tcp/0'], ...timing, fullNode: false })
    nodes.add(stranger)
    const relayAddr = localAddress(member)
    assert.ok(relayAddr.endsWith(`/p2p/${member.peerId}`))
    await assert.rejects(stranger.libp2p.dial(multiaddr(`${relayAddr}/p2p-circuit/p2p/${other.peerId}`)),
        /PERMISSION_DENIED|permission|denied/i, 'no circuit to a member that is not the owner')
    const toOwner = await stranger.libp2p.dial(multiaddr(`${relayAddr}/p2p-circuit/p2p/${owner.peerId}`))
    assert.equal(toOwner.remotePeer.toString(), owner.peerId, 'a circuit to the owner peer')
    assert.ok(toOwner.remoteAddr.toString().includes('/p2p-circuit'))
})

test('127.0.0.1 relay: a knock circuit ends at its data limit and at its time limit', { timeout: 40000 }, async t => {
    const { owner, member, nodes } = await setup(t, { relayKnock: { circuitMs: 1500, circuitBytes: 16 * 1024 } })
    const stranger = await createAsscrackNode({ room: 'another room', roomKey: newRoomKey(), listen: ['/ip4/127.0.0.1/tcp/0'], ...timing, fullNode: false })
    nodes.add(stranger)
    const circuit = `${localAddress(member)}/p2p-circuit/p2p/${owner.peerId}`
    // Data: a stream to the owner with more than the data limit (the owner reads the chat stream until the proof).
    const first = await stranger.libp2p.dial(multiaddr(circuit))
    const stream = await first.newStream('/asscrack/chat/2.0.0', { runOnTransientConnection: true })
    const junk = Buffer.alloc(4096, 0x61)
    for (let i = 0; i < 8 && first.status === 'open'; i++) {
        stream.send(junk)
        await delay(50)
    }
    await waitFor(() => first.status !== 'open', 'the relay ends the circuit after the data limit', 250)
    // Time: a quiet circuit ends after the time limit.
    await delay(1100)
    const second = await stranger.libp2p.dial(multiaddr(circuit), { force: true })
    assert.equal(second.status, 'open')
    await delay(1000)
    assert.equal(second.status, 'open', 'the circuit is open before the time limit')
    await waitFor(() => second.status !== 'open', 'the relay ends the circuit after the time limit', 250)
})
