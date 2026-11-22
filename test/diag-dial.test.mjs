// Diagnostics metric of rank 2 (work-orders/diagnostics-20261122/REVIEW.md): each dial and reach attempt with its
// route and its result, also the successes, with the time in ms. Real libp2p nodes on 127.0.0.1 (127.0.0.1 results,
// not LAN or internet results).
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'
import { createJournal } from '../src/application/journal.mjs'
import { journalNodeEvents } from '../src/application/diag-events.mjs'
import { localAddress, waitFor } from './helpers/protected-pair.mjs'

const room = 'Dial room'
const timing = { discovery: false, heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350, redialInterval: 500 }

async function closedPort() {
    const socket = createServer().listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const { port } = socket.address()
    await new Promise(resolve => socket.close(resolve))
    return port
}

test('127.0.0.1: the journal has each dial with its route, result and time: connect, dial-back, reserve, relay, and a failure', { timeout: 60000 }, async t => {
    const roomKey = newRoomKey()
    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: false })
    const nodes = []
    const journals = new Map()
    t.after(async () => {
        await Promise.allSettled(nodes.map(node => node.stop()))
        for (const { dir } of journals.values()) rmSync(dir, { recursive: true, force: true })
    })
    const start = async (name, membership, options) => {
        const node = await createAsscrackNode({ room, roomKey, membership, name, listen: ['/ip4/127.0.0.1/tcp/0'], ...timing, ...options })
        nodes.push(node)
        const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-diag-dial-'))
        const journal = createJournal({ dir, budgets: { default: [1e6, 0] } })
        journalNodeEvents((type, fn) => node.events.on(type, fn), (type, fields) => journal.write(type, fields), node.peerId)
        journals.set(node, { dir, journal })
        return node
    }
    const lines = node => {
        const { dir, journal } = journals.get(node)
        journal.flushSync()
        return readdirSync(dir).filter(name => name.endsWith('.jsonl'))
            .flatMap(name => readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)).map(line => JSON.parse(line))
            .filter(line => line.type === 'dial')
    }
    const has = (node, via, result) => lines(node).find(line => line.via === via && line.result === result)

    // The member relays (a full node). The owner can host: it asks for a dial-back and reserves a slot on the member.
    const owner = await start('Owner', ownerMembership, { allowPrivateFullNode: false })
    const relayDevice = createDeviceIdentity()
    const relay = await start('Relay', restoreRoomMembership({ identity: relayDevice, room, roomKey,
        descriptor: ownerMembership.issue(relayDevice.id, true) }), { fullNode: true, allowPrivateFullNode: true })
    await owner.connect(localAddress(relay))
    await waitFor(() => has(owner, 'connect', 'ok'), 'connect ok')
    await waitFor(() => has(owner, 'dial-back', 'ok'), 'dial-back ok')
    await waitFor(() => has(owner, 'reserve', 'ok'), 'reserve ok')
    // A joiner with no host rights: the owner admits it on a direct session, then the joiner reaches the relay. When the
    // direct link to the owner is lost, the owner and the joiner dial each other through the relay.
    const joinDevice = createDeviceIdentity()
    const joiner = await start('Joiner', restoreRoomMembership({ identity: joinDevice, room, roomKey,
        descriptor: ownerMembership.issue(joinDevice.id, false) }), { fullNode: false })
    await joiner.connect(localAddress(owner))
    await waitFor(() => joiner.memberState().admitted && owner.peers().includes(joiner.peerId), 'the owner admits the joiner')
    await joiner.connect(localAddress(relay))
    await waitFor(() => relay.peers().includes(joiner.peerId), 'joiner and relay meet')
    for (const c of joiner.libp2p.getConnections()) if (c.remotePeer.toString() === owner.peerId) c.abort(new Error('link lost'))
    await waitFor(() => has(owner, 'relay', 'ok') || has(joiner, 'relay', 'ok'), 'relay dial ok', 30000)
    await waitFor(() => owner.peers().includes(joiner.peerId) && joiner.peers().includes(owner.peerId), 'owner and joiner meet again')
    // A failed dial also has its time.
    await assert.rejects(owner.connect(`/ip4/127.0.0.1/tcp/${await closedPort()}`))
    await waitFor(() => has(owner, 'connect', 'failed'), 'connect failed')

    const connect = has(owner, 'connect', 'ok')
    assert.equal(connect.peer, relay.peerId)
    assert.equal(connect.addr, 'loopback')
    assert.equal(connect.transport, 'tcp')
    assert.ok(Number.isInteger(connect.ms) && connect.ms >= 0, `connect ms ${connect.ms}`)
    assert.ok(Number.isInteger(has(owner, 'dial-back', 'ok').ms))
    assert.equal(has(owner, 'reserve', 'ok').addr, 'relay')
    const relayed = has(owner, 'relay', 'ok') ?? has(joiner, 'relay', 'ok')
    assert.equal(relayed.addr, 'relay')
    assert.ok(Number.isInteger(relayed.ms))
    const failed = has(owner, 'connect', 'failed')
    assert.equal(failed.reason, 'refused')
    assert.ok(Number.isInteger(failed.ms))
    // No raw address in a dial line.
    for (const node of nodes) for (const line of lines(node)) assert.ok(!JSON.stringify(line).includes('127.0.0.1'))
})

test('127.0.0.1: a negative dial-back goes into the journal as a failed reach attempt, not as a "dial-failed" event', { timeout: 30000 }, async t => {
    const roomKey = newRoomKey()
    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: false })
    const nodes = []
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-diag-dialback-'))
    t.after(async () => { await Promise.allSettled(nodes.map(node => node.stop())); rmSync(dir, { recursive: true, force: true }) })
    // The owner listens on 127.0.0.2 only. The peer sees the connection from 127.0.0.1 and dials back there: refused.
    const owner = await createAsscrackNode({ room, roomKey, membership: ownerMembership, name: 'Owner', listen: ['/ip4/127.0.0.2/tcp/0'],
        ...timing, allowPrivateFullNode: false })
    nodes.push(owner)
    const relayDevice = createDeviceIdentity()
    const relay = await createAsscrackNode({ room, roomKey, name: 'Relay', listen: ['/ip4/127.0.0.1/tcp/0'], ...timing, fullNode: true,
        allowPrivateFullNode: true, membership: restoreRoomMembership({ identity: relayDevice, room, roomKey,
            descriptor: ownerMembership.issue(relayDevice.id, true) }) })
    nodes.push(relay)
    const journal = createJournal({ dir, budgets: { default: [1e6, 0] } })
    journalNodeEvents((type, fn) => owner.events.on(type, fn), (type, fields) => journal.write(type, fields), owner.peerId)
    const failedEvents = []
    owner.events.on('dial-failed', data => failedEvents.push(data))
    const dialLines = () => {
        journal.flushSync()
        return readdirSync(dir).filter(name => name.endsWith('.jsonl'))
            .flatMap(name => readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)).map(line => JSON.parse(line))
            .filter(line => line.type === 'dial')
    }
    await owner.connect(localAddress(relay))
    await waitFor(() => dialLines().some(line => line.via === 'dial-back'), 'a dial-back line')
    const line = dialLines().find(l => l.via === 'dial-back')
    assert.equal(line.result, 'failed')
    assert.equal(line.reason, 'no-dial-back')
    assert.ok(Number.isInteger(line.ms))
    assert.deepEqual(failedEvents.filter(e => e.via === 'dial-back'), [], 'no dial-failed event (terminal and Room activity as before)')
})
