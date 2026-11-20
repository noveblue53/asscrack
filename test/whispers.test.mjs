import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { createWhispers } from '../src/network/whispers.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { createSavedRooms } from '../src/application/saved-rooms.mjs'
import { observeRoomActivity } from '../src/application/room-activity.mjs'

async function waitFor(check, description) {
    const end = Date.now() + 20000
    while (!check() && Date.now() < end) await delay(25)
    assert.ok(check(), description)
}

for (const relayed of [false, true]) {
    test('127.0.0.1 keyed whispers isolate duplicate names, public history and the host on a ' +
        (relayed ? 'circuit route' : 'direct route'), async t => {
        const nodes = [], received = [], bystander = [], events = [], logs = []
        const room = 'whisper', roomKey = newRoomKey()
        const opt = { room, roomKey, listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false,
            fullNode: false, heartbeatInterval: 200, electionDelay: 500, hostTimeout: 1200 }
        const make = async options => {
            const node = await createAsscrackNode({ ...opt, ...options })
            nodes.push(node)
            return node
        }
        t.after(() => Promise.all(nodes.map(n => n.stop())))
        for (const method of ['info', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args))
        const host = await make({ fullNode: true, name: 'same', receiveWhisper: m => bystander.push(m) })
        const a = await make({ name: 'a', relayOnly: relayed, receiveWhisper: () => true })
        const b = await make({ name: 'same', relayOnly: relayed, receiveWhisper(message) {
            received.push(message)
            if (message.text === 'private-drop-fixture') {
                for (const c of b.libp2p.getConnections(a.libp2p.peerId)) c.abort(new Error('test connection loss'))
                return false
            }
        } })
        const activity = observeRoomActivity(host)
        const emit = host.events.emit.bind(host.events)
        t.mock.method(host.events, 'emit', (type, ...args) => { events.push([type, ...args]); return emit(type, ...args) })
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'))
        const rooms = createSavedRooms({ dir, protector: { available: () => true, wrap: b => b, unwrap: b => b },
            log: (...args) => logs.push(args) })
        t.after(() => { rooms.close(); fs.rmSync(dir, { recursive: true, force: true }) })
        rooms.attachNode(host)
        const saved = rooms.afterLogin({ room, roomKey, userName: 'same', save: true, keepHistory: true })
        assert.equal(saved.saved, true)
        await a.connect(host.getMultiaddrs()[0])
        await waitFor(() => a.host()?.peerId === host.peerId && host.isHost(), 'full node is the live host before B joins')
        if (!relayed) await a.connect(b.getMultiaddrs()[0])
        await b.connect(host.getMultiaddrs()[0])
        await waitFor(() => a.whisperPeers().includes(b.peerId) && b.whisperPeers().includes(a.peerId)
            && [a, b, host].every(n => n.host()?.peerId === host.peerId), 'host elected, recipient capable')
        assert.equal(a.peerNames()[b.peerId], a.peerNames()[host.peerId])
        const connections = a.libp2p.getConnections(b.libp2p.peerId)
        assert.ok(connections.length > 0)
        assert.ok(connections.every(c => c.remoteAddr.toString().includes('/p2p-circuit') === relayed))
        const text = 'private-marker-fixture', id = randomUUID()
        assert.equal(await a.sendWhisper(b.peerId, text, id), 'received')
        assert.deepEqual(received.map(({ peerId, id, text }) => ({ peerId, id, text })), [{ peerId: a.peerId, id, text }])
        assert.equal(await a.sendWhisper(b.peerId, text, id), 'received')
        assert.equal(received.length, 1)
        const publicText = 'public control line'
        a.send(publicText)
        await waitFor(() => rooms.lines(saved.roomId).length === 1, 'archive records the ordinary public control')
        const late = await make({ name: 'same' }) // An unadvertised receiver, with the same display name and a new keypair.
        // Lock in the direct route before host discovery can enqueue a competing circuit dial.
        if (!relayed) await a.connect(late.getMultiaddrs()[0])
        await late.connect(host.getMultiaddrs()[0])
        await waitFor(() => late.history().some(row => row.text === publicText), 'late peer receives public history')
        await waitFor(() => a.peers().includes(late.peerId), 'replacement identity connected')
        assert.equal(await a.sendWhisper(late.peerId, text, randomUUID()), 'unavailable')
        assert.equal(await a.sendWhisper(b.peerId, 'private-drop-fixture', randomUUID()), 'unconfirmed')
        await b.stop()
        nodes.splice(nodes.indexOf(b), 1)
        const replacement = await make({ name: 'same', relayOnly: relayed, receiveWhisper: m => bystander.push(m) })
        if (!relayed) await replacement.connect(a.getMultiaddrs()[0])
        await replacement.connect(host.getMultiaddrs()[0])
        await waitFor(() => a.whisperPeers().includes(replacement.peerId) && !a.whisperPeers().includes(b.peerId)
            && replacement.history().some(m => m.text === publicText), 'same name, changed identity now online')
        assert.equal(await a.sendWhisper(b.peerId, text, randomUUID()), 'unavailable')
        assert.deepEqual(bystander, [])
        assert.deepEqual(rooms.lines(saved.roomId).map(m => m.text), [publicText])
        for (const n of nodes) assert.deepEqual(n.history().map(m => m.text), [publicText])
        assert.doesNotMatch(JSON.stringify([events, logs, activity()]), /private-marker-fixture|private-drop-fixture/)
        assert.ok(!events.some(([type]) => ['whisper', 'typing', 'file-offer'].includes(type)))
    })
}

test('127.0.0.1 unkeyed chat sessions never advertise or accept private messages', async t => {
    const opt = { room: 'unkeyed', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false, receiveWhisper: assert.fail }
    const a = await createAsscrackNode(opt)
    const b = await createAsscrackNode(opt)
    t.after(() => Promise.all([a.stop(), b.stop()]))
    await a.connect(b.getMultiaddrs()[0])
    const msg = { type: 'whisper', v: 1, op: 'cap', to: a.peerId }
    b.sendTo(a.peerId, msg)
    b.sendTo(a.peerId, { ...msg, op: 'send', text: 'private', id: randomUUID() })
    b.send('ordinary chat')
    await waitFor(() => a.history().length, 'ordinary chat operational')
    assert.deepEqual(a.whisperPeers(), [])
    assert.deepEqual(b.whisperPeers(), [])
    assert.equal(await a.sendWhisper(b.peerId, 'private', randomUUID()), 'unavailable')
    assert.deepEqual(a.history().map(m => m.text), ['ordinary chat'])
})

test('only the same live peer and stream can acknowledge; loss, replacement and timeout retain uncertainty', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const first = { send: () => true }, bystander = { send: () => true }, next = { send: () => true }
    const sessions = new Map([['b', first], ['c', bystander]])
    const received = []
    const w = createWhispers({ self: 'a', sessionFor: id => sessions.get(id), receive: m => received.push(m),
        changed() {}, timeoutMs: 250 })
    const cap = { v: 1, to: 'a', op: 'cap' }
    w.handle('b', first, cap)
    w.handle('c', bystander, cap)
    const id = randomUUID(), ack = { ...cap, op: 'received', id }
    const p = w.send('b', 'test', id)
    w.handle('c', bystander, ack)
    w.handle('b', next, ack)
    w.handle('b', first, { ...ack, to: 'c' })
    w.closed('b', first)
    assert.equal(await p, 'unconfirmed')
    sessions.set('b', next)
    assert.equal(await w.send('b', 'test', id), 'unavailable')
    w.handle('b', next, cap)
    w.handle('b', first, { ...cap, op: 'send', text: 'stale', id })
    assert.deepEqual(received, [])
    const p2 = w.send('b', 'test', id)
    t.mock.timers.tick(250)
    assert.equal(await p2, 'unconfirmed')
    w.stop()
})
