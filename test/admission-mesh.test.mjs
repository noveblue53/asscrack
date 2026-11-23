// The session between two members after the first admission of the second member (protected rooms). Before the
// 'room-admitted' line of the owner, the new member refuses the proof of each other member, and each other member
// refuses the device proof of the new member. The new member must dial these members again after its admission.
// Real libp2p nodes on 127.0.0.1: these are 127.0.0.1 results, not LAN results and not internet results.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode, keyedServiceTag } from '../src/network/node.mjs'
import { newRoomKey, readRoomCode } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'
import { knockRoom } from '../src/network/knock-client.mjs'
import { checkAllowedInvite } from '../src/network/knock.mjs'

const timing = { heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350, redialInterval: 500 }

function localAddress(node) {
    return node.getMultiaddrs().find(value => value.startsWith('/ip4/127.0.0.1/tcp/') && !value.includes('/p2p-circuit'))
}

async function waitFor(predicate, description, ms = 10000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (predicate()) return
        await delay(20)
    }
    assert.fail(description)
}

// An owner (Mira) and a room. mdns: discovery by mDNS (the LAN room of the app), else connect() only.
async function setup(t, { lan, mdns = false }) {
    const room = `Mesh room ${process.pid} ${Math.random()}`
    const roomKey = newRoomKey()
    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan })
    const nodes = new Set()
    t.after(() => Promise.allSettled([...nodes].map(node => node.stop())))
    const refused = []
    const start = async (membership, name, options = {}) => {
        const node = await createAsscrackNode({ room, roomKey, membership, name, listen: ['/ip4/127.0.0.1/tcp/0'], ...timing,
            discovery: mdns, ...(mdns ? { discoveryInterval: 500 } : {}), fullNode: false, allowPrivateFullNode: true,
            knock: true, ...options })
        node.events.on('session-refused', ({ cause }) => refused.push(`${name}: ${cause}`))
        nodes.add(node)
        return node
    }
    const owner = await start(ownerMembership, 'Mira')
    // A new device with a device invite of the owner (no admission yet).
    const member = (name, options = {}) => {
        const identity = createDeviceIdentity()
        return start(restoreRoomMembership({ identity, room, roomKey, descriptor: ownerMembership.issue(identity.id, options.fullNode === true) }),
            name, options)
    }
    // A new device that knocks with the room code; the owner selects Allow.
    const knocker = async name => {
        const parsed = readRoomCode(owner.roomCode().code)
        const allow = ({ added }) => { if (added) setImmediate(() => owner.answerKnock(added.id, true)) }
        owner.events.on('knocks', allow)
        const identity = createDeviceIdentity()
        let outcome
        try {
            outcome = await knockRoom({ code: parsed, identity, name, serviceTag: mdns ? keyedServiceTag(room, roomKey) : null })
        } finally {
            owner.events.off('knocks', allow)
        }
        assert.equal(outcome.result, 'allowed')
        const invite = checkAllowedInvite(parsed, identity, outcome.invite)
        return start(restoreRoomMembership({ identity, room, roomKey, descriptor: invite.membership }), name)
    }
    return { owner, member, knocker, refused }
}

// Each node has a session with each other node, and a chat line of each node reaches each other node.
async function assertMesh(nodes, refused) {
    for (const node of nodes) {
        await waitFor(() => node.memberState().admitted, `${node.name} is admitted`)
    }
    for (const a of nodes) {
        for (const b of nodes) {
            if (a === b) continue
            await waitFor(() => a.peers().includes(b.peerId), `${a.name} has a session with ${b.name} (refused: ${refused.join('; ') || 'none'})`)
        }
    }
    for (const sender of nodes) {
        const text = `line from ${sender.name}`
        const heard = nodes.filter(node => node !== sender).map(node => new Promise(resolve => {
            const on = message => { if (message.text === text) { node.events.off('message', on); resolve() } }
            node.events.on('message', on)
        }))
        assert.equal(sender.send(text), nodes.length - 1, `${sender.name} sends to each other member`)
        await Promise.race([Promise.all(heard), delay(5000).then(() => assert.fail(`each member gets the line of ${sender.name}`))])
    }
}

const named = (node, name) => Object.assign(node, { name })

test('127.0.0.1 LAN room: a new member that meets a member before the owner gets a session with that member after its admission', { timeout: 60000 }, async t => {
    const { owner, member, refused } = await setup(t, { lan: true })
    const jonas = named(await member('Jonas'), 'Jonas')
    await jonas.connect(localAddress(owner))
    await waitFor(() => jonas.memberState().admitted && jonas.peers().includes(owner.peerId), 'Jonas is admitted')
    const priya = named(await member('Priya'), 'Priya')
    // Priya meets Jonas first: both sides refuse the session, because Priya has no admission yet.
    await priya.connect(localAddress(jonas)).catch(() => {})
    await waitFor(() => refused.length > 0, 'the session of Priya and Jonas is refused before the admission')
    assert.equal(priya.memberState().admitted, false)
    await priya.connect(localAddress(owner))
    await assertMesh([named(owner, 'Mira'), jonas, priya], refused)
})

test('127.0.0.1 LAN room: a new member that meets a member and the owner at the same time gets both sessions', { timeout: 60000 }, async t => {
    const { owner, member, refused } = await setup(t, { lan: true })
    const jonas = named(await member('Jonas'), 'Jonas')
    await jonas.connect(localAddress(owner))
    await waitFor(() => jonas.memberState().admitted && jonas.peers().includes(owner.peerId), 'Jonas is admitted')
    const priya = named(await member('Priya'), 'Priya')
    await Promise.allSettled([priya.connect(localAddress(jonas)), priya.connect(localAddress(owner))])
    await assertMesh([named(owner, 'Mira'), jonas, priya], refused)
})

test('127.0.0.1 internet room: a new member that meets a relaying member before the owner gets a session with it after its admission', { timeout: 60000 }, async t => {
    const { owner, member, refused } = await setup(t, { lan: false })
    const jonas = named(await member('Jonas', { fullNode: true }), 'Jonas')
    await jonas.connect(localAddress(owner))
    await waitFor(() => jonas.memberState().admitted && jonas.fullNode(), 'Jonas is admitted and a full node')
    const priya = named(await member('Priya'), 'Priya')
    await priya.connect(localAddress(jonas)).catch(() => {})
    await waitFor(() => refused.length > 0, 'the session of Priya and Jonas is refused before the admission')
    await priya.connect(localAddress(owner))
    await assertMesh([named(owner, 'Mira'), jonas, priya], refused)
})

// The path of the app in a LAN room: mDNS finds each node. The first and the second member join by a device invite or
// by a knock with the room code, in the two orders.
for (const order of [['invite', 'knock'], ['knock', 'invite']]) {
    test(`127.0.0.1 LAN room with mDNS: an owner and two members (${order.join(', then ')}) all get sessions and all chat lines`, { timeout: 90000 }, async t => {
        const { owner, member, knocker, refused } = await setup(t, { lan: true, mdns: true })
        const join = (how, name) => how === 'knock' ? knocker(name) : member(name)
        const jonas = named(await join(order[0], 'Jonas'), 'Jonas')
        await waitFor(() => jonas.memberState().admitted && jonas.peers().includes(owner.peerId), 'Jonas is admitted')
        const priya = named(await join(order[1], 'Priya'), 'Priya')
        await assertMesh([named(owner, 'Mira'), jonas, priya], refused)
    })
}
