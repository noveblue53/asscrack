import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey, readInvite } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, importDeviceIdentity, restoreRoomMembership } from '../src/network/room-membership.mjs'

const room = 'Protected game room'

test('a protected invitation binds the room policy, receiving device, and live owner admission', () => {
    const roomKey = newRoomKey()
    const ownerId = createDeviceIdentity()
    const identity = createDeviceIdentity()
    const owner = createRoomMembership({ identity: ownerId, room, roomKey, lan: true })
    const descriptor = owner.issue(identity.id, true)
    assert.throws(() => restoreRoomMembership({ identity: createDeviceIdentity(), room, roomKey, descriptor }), /another device/)
    assert.throws(() => restoreRoomMembership({ identity, room, roomKey, descriptor: { ...descriptor, lan: false } }), /authorization/)
    const member = restoreRoomMembership({ identity: importDeviceIdentity(identity.exportPrivate()), room, roomKey, descriptor })
    assert.ok(!member.admitted())
    const challenge = member.memberProof('fresh', 'sender', 'receiver')
    assert.equal(owner.verifyMember(challenge, 'different', 'sender', 'receiver'), null)
    assert.equal(owner.verifyMember(challenge, 'fresh', 'receiver', 'sender'), null)
    const authenticated = owner.verifyMember(challenge, 'fresh', 'sender', 'receiver')
    assert.ok(authenticated.canHost)
    assert.ok(!authenticated.hasAdmission)
    assert.equal(member.verifyMember(challenge, 'fresh', 'sender', 'receiver'), null)
    assert.equal(member.acceptAdmission(owner.admit(authenticated)), true)
    assert.ok(member.admitted() && member.canHost())
    assert.ok(member.verifyMember(member.memberProof('next', 'sender', 'receiver'), 'next', 'sender', 'receiver').hasAdmission)
    owner.setPersistence(() => { throw new Error('write failed') })
    assert.throws(() => owner.revoke(identity.id), /write failed/)
    assert.equal(owner.revoked(identity.id), false)
})

function localAddress(node) {
    return node.getMultiaddrs().find(value => value.startsWith('/ip4/127.0.0.1/tcp/') && !value.includes('/p2p-circuit'))
}

async function waitFor(predicate, description) {
    for (let attempt = 0; attempt < 500; attempt++) {
        if (predicate()) return
        await delay(20)
    }
    assert.fail(description)
}

test('127.0.0.1 protected nodes enforce admission, role, revocation, and authorized host failover', { timeout: 35000 }, async t => {
    const roomKey = newRoomKey()
    const ownerDevice = createDeviceIdentity()
    const ownerMembership = createRoomMembership({ identity: ownerDevice, room, roomKey, lan: true })
    const nodes = new Set()
    t.after(() => Promise.allSettled([...nodes].map(node => node.stop())))
    async function start(membership, name) {
        const node = await createAsscrackNode({ room, roomKey, membership, name, discovery: false,
            listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: false, heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350 })
        nodes.add(node)
        return node
    }
    const owner = await start(ownerMembership, 'Owner')
    assert.equal(owner.invite(), null)

    async function account(name, canHost = false, join = true) {
        const identity = createDeviceIdentity()
        const invitation = readInvite(owner.createMemberInvite(identity.id, { canHost }))
        assert.ok(invitation.lan)
        assert.deepEqual(invitation.nodes, [])
        const membership = restoreRoomMembership({ identity, room, roomKey, descriptor: invitation.membership })
        const node = await start(membership, name)
        if (join) {
            await node.connect(localAddress(owner))
            await waitFor(() => node.peers().includes(owner.peerId) && owner.peers().includes(node.peerId), 'owner admitted the named device')
            assert.equal(node.memberState().admitted, true)
        }
        return { node, identity }
    }
    const { node: ordinary } = await account('Participant')
    await waitFor(() => ordinary.host()?.peerId === owner.peerId, 'only eligible device was elected')
    assert.equal(ordinary.memberState().canHost, false)
    const { node: alternate } = await account('Trusted alternate', true)
    await alternate.connect(localAddress(ordinary))
    await waitFor(() => alternate.peers().includes(ordinary.peerId), 'admitted peers connect directly')
    assert.equal(alternate.memberState().canHost, true)

    const legacy = await start(null, 'Legacy')
    await assert.rejects(legacy.connect(localAddress(owner)))
    assert.ok(!owner.peers().includes(legacy.peerId))

    const { node: removed, identity: removedDevice } = await account('Removed later')
    const savedBeforeRevocation = removed.membershipSnapshot()
    await removed.connect(localAddress(alternate))
    await waitFor(() => alternate.peers().includes(removed.peerId), 'alternate recognized the admitted device')
    assert.equal(owner.revokeMember(removedDevice.id), true)
    await waitFor(() => !alternate.peers().includes(removed.peerId) &&
        alternate.membershipSnapshot().revocations.devices.includes(removedDevice.id), 'revocation reached alternate and closed the session')
    const copy = restoreRoomMembership({ identity: removedDevice, room, roomKey, descriptor: savedBeforeRevocation })
    const stale = await start(copy, 'Previously admitted')
    await stale.connect(localAddress(alternate))
    await delay(250)
    assert.ok(!alternate.peers().includes(stale.peerId))

    const { node: waiting, identity: waitingDevice } = await account('New device', false, false)
    assert.ok(owner.memberState().members.some(member => member.deviceId === waitingDevice.id && !member.connected))
    await owner.stop()
    nodes.delete(owner)
    await waitFor(() => ordinary.host()?.peerId === alternate.peerId, 'only authorized alternate takes over')
    await waiting.connect(localAddress(alternate))
    await delay(250)
    assert.equal(waiting.memberState().admitted, false)
    assert.deepEqual(waiting.peers(), [])
    assert.ok(!alternate.peers().includes(waiting.peerId))

    assert.equal(alternate.sendVoiceFrame(Uint8Array.of(1, 2)), false)
    assert.throws(() => waiting.setVoice({ inVoice: true }), /not admitted/)
    ordinary.setVoice({ inVoice: true })
    await waitFor(() => alternate.voiceStats().streams === 1, 'visible voice member opens stream to active host')
    const frames = []
    alternate.events.on('voice-frame', frame => frames.push(frame))
    ordinary.sendVoiceFrame(Uint8Array.of(1, 2))
    await waitFor(() => frames.length === 1, 'host receives the participating member voice frame')
    ordinary.setVoice({ inVoice: false })
    await waitFor(() => alternate.voiceStats().streams === 0, 'leaving voice closes authorized streams')
})

test('any admitted non-host member in an Internet room can act as a circuit-relay Full Node without host eligibility', { timeout: 25000 }, async t => {
    const roomKey = newRoomKey()
    const membership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey })
    const socket = createServer().listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const ownerAddress = `/ip4/127.0.0.1/tcp/${socket.address().port}`
    await new Promise(resolve => socket.close(resolve))
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(node => node.stop())))
    async function start(options) {
        const node = await createAsscrackNode({ room, roomKey, discovery: false, heartbeatInterval: 100,
            hostTimeout: 700, electionDelay: 350, listen: ['/ip4/127.0.0.1/tcp/0'], ...options })
        nodes.push(node)
        return node
    }
    const owner = await start({ membership, name: 'Owner', listen: [ownerAddress], announce: [ownerAddress], fullNode: true, allowPrivateFullNode: true })
    async function issue(name, canHost, options) {
        const identity = createDeviceIdentity()
        const invitation = readInvite(owner.createMemberInvite(identity.id, { canHost }))
        const member = restoreRoomMembership({ identity, room, roomKey, descriptor: invitation.membership })
        return start({ membership: member, name, ...options })
    }
    const ordinary = await issue('Participant', false, { fullNode: true, allowPrivateFullNode: true })
    let routerChecks = 0
    const automatic = await issue('Another participant', false, {
        fullNode: 'auto', allowPrivateFullNode: true, upnp: true,
        upnpClient: { async externalIp() { routerChecks++; return '100.64.0.1' } }
    })
    assert.equal(ordinary.fullNode(), false, 'unadmitted non-host member is not a full node')
    await ordinary.connect(localAddress(owner))
    await automatic.connect(localAddress(owner))
    await waitFor(() => routerChecks === 1, 'non-host member can run UPnP discovery')
    await waitFor(() => ordinary.fullNode() === true && automatic.fullNode() === true, 'admitted non-host members activate as full nodes')
    assert.equal(ordinary.memberState().canHost, false)
    assert.equal(automatic.memberState().canHost, false)
    assert.ok(ordinary.libp2p.services.relay !== undefined)
    assert.ok(automatic.libp2p.services.relay !== undefined)
    assert.equal(routerChecks, 1)

    const relayOnlyMember = await issue('Relay only', false, { relayOnly: true, fullNode: 'auto', allowPrivateFullNode: true })
    await relayOnlyMember.connect(localAddress(owner))
    await waitFor(() => relayOnlyMember.peers().includes(owner.peerId), 'relayOnly member admitted')
    assert.equal(relayOnlyMember.fullNode(), false)
    assert.equal(relayOnlyMember.canRelay(), false)

    const trusted = await issue('Trusted alternate', true, { fullNode: false, allowPrivateFullNode: true })
    await trusted.connect(localAddress(owner))
    await waitFor(() => trusted.peers().includes(owner.peerId), 'trusted alternate admitted')
    assert.equal(trusted.fullNode(), false)
    await waitFor(() => owner.fullNodes().includes(ordinary.peerId) && owner.fullNodes().includes(automatic.peerId), 'owner sees non-host full nodes')
    await trusted.connect(localAddress(automatic))
    await waitFor(() => trusted.peers().includes(automatic.peerId) && automatic.peers().includes(trusted.peerId), 'trusted connected to automatic')

    // When owner stops, only trusted (canHost: true) can take over as host — never ordinary or automatic.
    await owner.stop()
    nodes.shift()
    await waitFor(() => trusted.isHost() && automatic.host()?.peerId === trusted.peerId, 'only canHost alternate takes over')
    assert.equal(ordinary.isHost(), false)
    assert.equal(automatic.isHost(), false)
})
