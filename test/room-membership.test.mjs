import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey, readInvite } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'

async function waitFor(predicate, description) {
    for (let attempt = 0; attempt < 500; attempt++) {
        if (predicate()) return
        await delay(20)
    }
    assert.fail(description)
}

test('127.0.0.1: non-host admitted member with open port becomes circuit-relay Full Node without host/voice-host election', { timeout: 35000 }, async t => {
    const room = `membership-relay-${Date.now()}`
    const roomKey = newRoomKey()
    const socket = createServer().listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const ownerAddr = `/ip4/127.0.0.1/tcp/${socket.address().port}`
    await new Promise(resolve => socket.close(resolve))

    const nodes = new Set()
    t.after(() => Promise.allSettled([...nodes].map(n => n.stop())))
    const timing = { discovery: false, heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350 }

    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey })
    const owner = await createAsscrackNode({
        room, roomKey, membership: ownerMembership,
        listen: [ownerAddr], announce: [ownerAddr],
        fullNode: true, allowPrivateFullNode: true, ...timing
    })
    nodes.add(owner)

    async function inviteMember(name, canHost, extra) {
        const identity = createDeviceIdentity()
        const invite = readInvite(owner.createMemberInvite(identity.id, { canHost }))
        const membership = restoreRoomMembership({ identity, room, roomKey, descriptor: invite.membership })
        const node = await createAsscrackNode({ room, roomKey, membership, name, ...timing, ...extra })
        nodes.add(node)
        return { node, identity }
    }

    // Pick a non-host Full Node with a lower peerId than the canHost non-full-node alternate
    // to prove full-node rank never overrides hostGrant.
    let relayMember, relayIdentity, alternate
    for (let i = 0; i < 20; i++) {
        const r = await inviteMember('RelayMember', false, { listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: 'auto', allowPrivateFullNode: true })
        const a = await inviteMember('Alternate', true, { listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: false, allowPrivateFullNode: true })
        if (r.node.peerId < a.node.peerId) {
            relayMember = r.node
            relayIdentity = r.identity
            alternate = a.node
            break
        }
        nodes.delete(r.node)
        nodes.delete(a.node)
        await Promise.allSettled([r.node.stop(), a.node.stop()])
    }
    assert.ok(relayMember && alternate && relayMember.peerId < alternate.peerId, 'relayMember has lower peerId than alternate')

    assert.equal(relayMember.canRelay(), false)
    assert.equal(relayMember.fullNode(), false)

    await relayMember.connect(ownerAddr)
    await alternate.connect(ownerAddr)
    await waitFor(() => relayMember.fullNode() === true && owner.fullNodes().includes(relayMember.peerId), 'relayMember promoted to Full Node')
    assert.equal(relayMember.canRelay(), true)
    assert.equal(relayMember.memberState().canHost, false)
    assert.equal(alternate.memberState().canHost, true)
    assert.equal(alternate.fullNode(), false)

    // A relayOnly member connects to owner and sees relayMember as a Full Node.
    const { node: leaf } = await inviteMember('Leaf', false, { relayOnly: true, fullNode: false, allowPrivateFullNode: true })
    await leaf.connect(ownerAddr)
    await waitFor(() => leaf.fullNodes().includes(relayMember.peerId) && alternate.fullNodes().includes(relayMember.peerId), 'leaf and alternate see relayMember as Full Node')
    // Wait for direct TCP sessions to relayMember so reservations and relay routes are active before owner stops.
    await waitFor(() => {
        const lk = leaf.topology().kinds[leaf.peerId]
        const ak = alternate.topology().kinds[alternate.peerId]
        return lk?.[relayMember.peerId] === 'mesh' && ak?.[relayMember.peerId] === 'mesh'
    }, 'leaf and alternate upgraded to direct TCP with relayMember')

    // When owner stops, alternate (canHost: true, non-full-node) becomes room/voice host, NOT relayMember (canHost: false, Full Node).
    await owner.stop()
    nodes.delete(owner)
    await waitFor(() => alternate.isHost() && relayMember.host()?.peerId === alternate.peerId && leaf.host()?.peerId === alternate.peerId, 'alternate elected host over non-host Full Node')
    assert.equal(relayMember.isHost(), false)

    // Voice frames go to alternate as voice host, never to relayMember.
    const frames = []
    alternate.events.on('voice-frame', f => frames.push(f))
    leaf.setVoice({ inVoice: true })
    await waitFor(() => alternate.voiceStats().streams === 1, 'leaf opens voice stream to alternate')
    assert.equal(relayMember.voiceStats().streams, 0)
    leaf.sendVoiceFrame(Uint8Array.of(7, 8, 9))
    await waitFor(() => frames.length === 1, 'alternate receives voice frame')
    leaf.setVoice({ inVoice: false })

    // Re-test revocation on a second non-host Full Node while owner is alive.
    const sock2 = createServer().listen(0, '127.0.0.1')
    await once(sock2, 'listening')
    const o2Addr = `/ip4/127.0.0.1/tcp/${sock2.address().port}`
    await new Promise(resolve => sock2.close(resolve))
    const owner2 = await createAsscrackNode({
        room, roomKey,
        membership: createRoomMembership({ identity: createDeviceIdentity(), room, roomKey }),
        listen: [o2Addr], announce: [o2Addr], fullNode: true, allowPrivateFullNode: true, ...timing
    })
    nodes.add(owner2)
    const revId = createDeviceIdentity()
    const revInvite = readInvite(owner2.createMemberInvite(revId.id, { canHost: false }))
    const revMember = await createAsscrackNode({
        room, roomKey,
        membership: restoreRoomMembership({ identity: revId, room, roomKey, descriptor: revInvite.membership }),
        listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: 'auto', allowPrivateFullNode: true, ...timing
    })
    nodes.add(revMember)
    await revMember.connect(o2Addr)
    await waitFor(() => revMember.fullNode() === true && revMember.canRelay() === true, 'revMember becomes Full Node')
    assert.equal(owner2.revokeMember(revId.id), true)
    await waitFor(() => !revMember.canRelay() && !revMember.fullNode(), 'revocation disables canRelay and fullNode')
})
