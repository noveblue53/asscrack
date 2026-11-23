// easy-join part 2: knock and approve with real libp2p nodes on 127.0.0.1 (owner, relaying member, knocker). These
// are 127.0.0.1 results, not internet results and not LAN results.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode, keyedServiceTag } from '../src/network/node.mjs'
import { newRoomKey, readRoomCode } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'
import { knockRoom } from '../src/network/knock-client.mjs'
import { checkAllowedInvite } from '../src/network/knock.mjs'

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

// An owner, and (internet room) a member that can host and relays. The owner has no public address: a knock reaches it
// only through the relay circuit of the member.
async function setup(t, { lan = false, relay = !lan, knock = true } = {}) {
    const roomKey = newRoomKey()
    const ownerDevice = createDeviceIdentity()
    const ownerMembership = createRoomMembership({ identity: ownerDevice, room, roomKey, lan })
    const nodes = new Set()
    t.after(() => Promise.allSettled([...nodes].map(node => node.stop())))
    const start = async options => {
        const node = await createAsscrackNode({ room, roomKey, listen: ['/ip4/127.0.0.1/tcp/0'], ...timing, ...options })
        nodes.add(node)
        return node
    }
    const owner = await start({ membership: ownerMembership, name: 'Owner', fullNode: false, allowPrivateFullNode: true, knock })
    let member = null
    if (relay) {
        const memberDevice = createDeviceIdentity()
        const descriptor = ownerMembership.issue(memberDevice.id, true)
        member = await start({ membership: restoreRoomMembership({ identity: memberDevice, room, roomKey, descriptor }),
            name: 'Relay', fullNode: true, allowPrivateFullNode: true, knock: true })
        await owner.connect(localAddress(member))
        await waitFor(() => member.fullNode() && owner.getMultiaddrs().some(addr => addr.includes('/p2p-circuit')),
            'the owner has a reservation on the relaying member')
    }
    return { roomKey, ownerDevice, ownerMembership, owner, member, start, nodes }
}

// The knock of a new device. answer: true (Allow), false (Deny) or null (no answer).
async function knockWith(owner, code, answer, { identity = createDeviceIdentity(), name = 'Kim', serviceTag = null } = {}) {
    const prompts = []
    const onKnocks = ({ added }) => {
        if (!added) return
        prompts.push(added)
        if (answer !== null) setImmediate(() => owner.answerKnock(added.id, answer))
    }
    owner.events.on('knocks', onKnocks)
    try {
        const states = []
        const outcome = await knockRoom({ code: readRoomCode(code), identity, name, serviceTag, onState: state => states.push(state) })
        return { outcome, prompts, identity, states }
    } finally {
        owner.events.off('knocks', onKnocks)
    }
}

test('127.0.0.1 knock through a relaying member: Allow gives a device invite with no host rights, then the normal admission and chat', { timeout: 60000 }, async t => {
    const { roomKey, owner, member, start } = await setup(t)
    assert.deepEqual(owner.publicAddrs(), [], 'the owner has no public address')
    const { code } = owner.roomCode()
    const parsed = readRoomCode(code)
    assert.equal(parsed.ownerPeer, owner.peerId)
    assert.ok(parsed.nodes[0].addrs.every(addr => addr.includes('/p2p-circuit')), 'the code has only the relay circuit of the owner')

    const { outcome, prompts, identity, states } = await knockWith(owner, code, true)
    assert.equal(outcome.result, 'allowed')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].name, 'Kim')
    assert.equal(prompts[0].deviceId, identity.id)
    assert.match(prompts[0].mark, /^[0-9a-f]{6}$/)
    assert.ok(states.includes('waiting'))
    assert.deepEqual(owner.knocks(), [])
    const invite = checkAllowedInvite(parsed, identity, outcome.invite)
    assert.equal(invite.membership.grant.canHost, false)

    // The normal admission path with the device invite of the answer (the joiner reaches the owner by the relay).
    const joiner = await start({ membership: restoreRoomMembership({ identity, room, roomKey, descriptor: invite.membership }),
        name: 'Kim', fullNode: false, allowPrivateFullNode: true, inviteNodes: invite.nodes, knock: true })
    await waitFor(() => joiner.memberState().admitted && joiner.peers().includes(owner.peerId), 'the owner admits the joiner', 1500)
    await waitFor(() => joiner.peers().includes(member.peerId), 'the admitted joiner opens a session with the relaying member', 1500)
    const heard = once(owner.events, 'message')
    joiner.send('hello from the joiner')
    assert.equal((await heard)[0].text, 'hello from the joiner')
    const back = once(joiner.events, 'message')
    owner.send('hello from the owner')
    assert.equal((await back)[0].text, 'hello from the owner')
})

test('127.0.0.1 knock Deny: the joiner gets "denied", and the same device gets "denied" with no prompt in the cool-down', { timeout: 40000 }, async t => {
    const { owner } = await setup(t)
    const { code } = owner.roomCode()
    const first = await knockWith(owner, code, false)
    assert.equal(first.outcome.result, 'denied')
    assert.equal(first.prompts.length, 1)
    const again = await knockWith(owner, code, true, { identity: first.identity })
    assert.equal(again.outcome.result, 'denied')
    assert.equal(again.prompts.length, 0, 'no prompt in the cool-down')
    const other = await knockWith(owner, code, false)
    assert.equal(other.prompts.length, 1, 'another device gets a prompt')
})

test('127.0.0.1 knock when the owner is offline or does not answer', { timeout: 40000 }, async t => {
    const { owner, member } = await setup(t, { knock: { limits: { promptMs: 1500 } } })
    const { code } = owner.roomCode()
    const silent = await knockWith(owner, code, null)
    assert.equal(silent.prompts.length, 1)
    assert.equal(silent.outcome.result, 'timeout', 'no answer in the prompt time')
    assert.deepEqual(owner.knocks(), [])
    await owner.stop()
    await waitFor(() => !member.peers().includes(owner.peerId), 'the owner left')
    const offline = await knockWith(owner, code, true)
    assert.equal(offline.outcome.result, 'offline')
    assert.equal(offline.prompts.length, 0)
})

test('127.0.0.1 knock flood: at most 5 prompts, then a clear answer and no prompt; a rate limit for each path', { timeout: 60000 }, async t => {
    const { owner } = await setup(t, { relay: false, lan: true, knock: { limits: { promptMs: 20000, perVia: 8 } } })
    const { code } = owner.roomCode()
    const prompts = []
    owner.events.on('knocks', ({ added }) => { if (added) prompts.push(added) })
    const parsed = readRoomCode(code)
    const waiting = []
    // libp2p accepts at most 5 inbound connections in one second from one host (inboundConnectionThreshold). The
    // knocks of this test thus come one by one, with a gap.
    const next = () => delay(300)
    for (let i = 0; i < 5; i++) {
        waiting.push(knockRoom({ code: parsed, identity: createDeviceIdentity(), name: `Guest ${i}` }))
        await waitFor(() => prompts.length === i + 1, `prompt ${i + 1}`)
        await next()
    }
    const sixth = await knockRoom({ code: parsed, identity: createDeviceIdentity(), name: 'Guest 5' })
    assert.deepEqual(sixth, { result: 'refused', reason: 'busy' })
    assert.equal(prompts.length, 5)
    assert.equal(owner.knocks().length, 5)
    // perVia 8: knocks 7, 8 and 9 on the same path (127.0.0.1) in one minute.
    await next()
    const seventh = await knockRoom({ code: parsed, identity: createDeviceIdentity(), name: 'Guest 6' })
    assert.deepEqual(seventh, { result: 'refused', reason: 'busy' })
    await next()
    const eighth = await knockRoom({ code: parsed, identity: createDeviceIdentity(), name: 'Guest 7' })
    assert.deepEqual(eighth, { result: 'refused', reason: 'busy' })
    await next()
    const ninth = await knockRoom({ code: parsed, identity: createDeviceIdentity(), name: 'Guest 8' })
    assert.deepEqual(ninth, { result: 'refused', reason: 'rate' })
    assert.equal(prompts.length, 5, 'no prompt over a limit')
    for (const entry of owner.knocks()) owner.answerKnock(entry.id, false)
    const results = await Promise.all(waiting)
    assert.deepEqual(results.map(r => r.result), ['denied', 'denied', 'denied', 'denied', 'denied'])
})

test('127.0.0.1 knock flood through a relaying member: at most 5 prompts, then "busy" and no prompt', { timeout: 60000 }, async t => {
    const { owner } = await setup(t, { knock: { limits: { promptMs: 20000 } } })
    const parsed = readRoomCode(owner.roomCode().code)
    const prompts = []
    owner.events.on('knocks', ({ added }) => { if (added) prompts.push(added) })
    const waiting = []
    for (let i = 0; i < 5; i++) {
        waiting.push(knockRoom({ code: parsed, identity: createDeviceIdentity(), name: `Guest ${i}` }))
        await waitFor(() => prompts.length === i + 1, `prompt ${i + 1} through the relay`)
        await delay(300)
    }
    const sixth = await knockRoom({ code: parsed, identity: createDeviceIdentity(), name: 'Guest 5' })
    assert.deepEqual(sixth, { result: 'refused', reason: 'busy' })
    assert.equal(prompts.length, 5)
    for (const entry of owner.knocks()) owner.answerKnock(entry.id, false)
    assert.deepEqual((await Promise.all(waiting)).map(r => r.result), ['denied', 'denied', 'denied', 'denied', 'denied'])
})

test('127.0.0.1 knock with an old room code after "New room code"', { timeout: 40000 }, async t => {
    const { owner } = await setup(t)
    const old = owner.roomCode()
    assert.equal(owner.roomCode().code === old.code || readRoomCode(owner.roomCode().code).codeId === readRoomCode(old.code).codeId, true,
        'Copy room code again gives the same code ID')
    const renewed = owner.roomCode({ renew: true })
    assert.notEqual(readRoomCode(renewed.code).codeId, readRoomCode(old.code).codeId)
    const stale = await knockWith(owner, old.code, true)
    assert.deepEqual(stale.outcome, { result: 'refused', reason: 'old-code' })
    assert.equal(stale.prompts.length, 0)
    const fresh = await knockWith(owner, renewed.code, true)
    assert.equal(fresh.outcome.result, 'allowed')
})

test('127.0.0.1 knock in a LAN room (private addresses of the owner, no relay)', { timeout: 40000 }, async t => {
    const { owner, roomKey, start } = await setup(t, { lan: true })
    const { code } = owner.roomCode()
    const parsed = readRoomCode(code)
    assert.equal(parsed.lan, true)
    assert.ok(parsed.nodes[0].addrs.length > 0 && parsed.nodes[0].addrs.every(addr => !addr.includes('/p2p-circuit')))
    const { outcome, identity } = await knockWith(owner, code, true)
    assert.equal(outcome.result, 'allowed')
    const invite = checkAllowedInvite(parsed, identity, outcome.invite)
    assert.ok(invite.lan)
    assert.deepEqual(invite.nodes, [])
    const joiner = await start({ membership: restoreRoomMembership({ identity, room, roomKey, descriptor: invite.membership }),
        name: 'Kim', fullNode: false, knock: true })
    await joiner.connect(localAddress(owner))
    await waitFor(() => joiner.memberState().admitted && owner.peers().includes(joiner.peerId), 'the LAN owner admits the joiner')
})

// A free TCP port on 127.0.0.1.
async function freePort() {
    const socket = createServer().listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const { port } = socket.address()
    await new Promise(resolve => socket.close(resolve))
    return port
}

test('127.0.0.1 knock with an old room code after a restart of the owner (new peer ID): mDNS in a LAN room, the address with no peer ID in an internet room', { timeout: 60000 }, async t => {
    for (const lan of [true, false]) {
        const iterRoom = `${room}-${process.pid}-${randomBytes(4).toString('hex')}`
        const roomKey = newRoomKey()
        const ownerDevice = createDeviceIdentity()
        const saved = []
        const first = createRoomMembership({ identity: ownerDevice, room: iterRoom, roomKey, lan })
        first.setPersistence(snapshot => saved.push(snapshot))
        const nodes = new Set()
        t.after(() => Promise.allSettled([...nodes].map(node => node.stop())))
        const port = lan ? 0 : await freePort()
        const address = `/ip4/127.0.0.1/tcp/${port}`
        // LAN: mDNS on (the room tag). Internet: a public address on a fixed port (the announce address).
        const options = lan ? { discovery: true, discoveryInterval: 500 } : { announce: [address] }
        const start = async membership => {
            const node = await createAsscrackNode({ room: iterRoom, roomKey, membership, name: 'Owner', ...timing, ...options,
                listen: [address], fullNode: false, knock: true })
            nodes.add(node)
            return node
        }
        const before = await start(first)
        const { code } = before.roomCode()
        const oldPeer = before.peerId
        await before.stop()
        nodes.delete(before)
        // The restart: the saved membership (with the code ID), a new peer ID and, in a LAN room, a new port.
        const restored = restoreRoomMembership({ identity: ownerDevice, room: iterRoom, roomKey, descriptor: saved.at(-1) })
        const after = await start(restored)
        assert.notEqual(after.peerId, oldPeer)
        assert.equal(readRoomCode(code).ownerPeer, oldPeer)
        const { outcome, prompts, identity } = await knockWith(after, code, true, { serviceTag: lan ? keyedServiceTag(iterRoom, roomKey) : null })
        assert.equal(outcome.result, 'allowed', `${lan ? 'LAN' : 'internet'} room: the old code finds the owner`)
        assert.equal(prompts.length, 1)
        assert.equal(checkAllowedInvite(readRoomCode(code), identity, outcome.invite).membership.grant.canHost, false)
    }
})
