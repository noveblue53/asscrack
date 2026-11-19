import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { pushable } from 'it-pushable'
import { multiaddr } from '@multiformats/multiaddr'
import { createAsscrackNode, CHAT_PROTOCOL } from '../src/network/node.mjs'

// All results of this file are 127.0.0.1 results, not LAN results.

async function waitFor(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (check()) return
        await delay(50)
    }
    assert.ok(check(), 'Timed out waiting for expected node behavior')
}

const opts = room => ({ room, listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false })

function presenceLog(node) {
    const log = []
    node.events.on('presence', e => log.push(e))
    return log
}

async function stopAll(nodes) {
    await Promise.allSettled(nodes.map(n => n.stop()))
}

test('presence: the note has a maximum of 80 code points at the sender and at the receiver', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts('presence-limit'))
    const b = await createAsscrackNode(opts('presence-limit'))
    try {
        const logB = presenceLog(b)
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => logB.length === 1)
        assert.deepEqual(logB[0], { peerId: a.peerId, state: 'available', note: '' })

        const long = '\u{1F600}'.repeat(100)
        const stored = a.setPresence({ state: 'away', note: `  ${long}  ` })
        assert.equal([...stored.note].length, 80)
        assert.equal(stored.note, '\u{1F600}'.repeat(80))
        assert.deepEqual(a.presence(), stored)
        await waitFor(() => logB.length === 2)
        assert.deepEqual(logB[1], { peerId: a.peerId, state: 'away', note: '\u{1F600}'.repeat(80) })

        // A raw line with a long note: the receiver cuts it.
        assert.equal(a.sendTo(b.peerId, { type: 'presence', v: 1, state: 'dnd', note: ` ${'\u{1F431}'.repeat(100)} ` }), true)
        await waitFor(() => logB.length === 3)
        assert.deepEqual(logB[2], { peerId: a.peerId, state: 'dnd', note: '\u{1F431}'.repeat(80) })
        assert.equal([...b.peerPresence()[a.peerId].note].length, 80)

        assert.throws(() => a.setPresence({ state: 'busy' }), TypeError)
        assert.deepEqual(a.setPresence({ state: 'available' }), { state: 'available', note: '' })
    } finally {
        await stopAll([b, a])
    }
})

test('presence: a new session gets the current state at open', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts('presence-snapshot'))
    const b = await createAsscrackNode(opts('presence-snapshot'))
    try {
        a.setPresence({ state: 'away', note: 'lunch' })
        const logB = presenceLog(b)
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => logB.length === 1)
        assert.deepEqual(logB, [{ peerId: a.peerId, state: 'away', note: 'lunch' }])
        assert.deepEqual(b.peerPresence(), { [a.peerId]: { state: 'away', note: 'lunch' } })
        // B is 'available' and sends that also.
        await waitFor(() => a.peerPresence()[b.peerId] !== undefined)
        assert.deepEqual(a.peerPresence(), { [b.peerId]: { state: 'available', note: '' } })
    } finally {
        await stopAll([b, a])
    }
})

test('presence: a late joiner gets the current state', { timeout: 20000 }, async () => {
    const a = await createAsscrackNode(opts('presence-late'))
    const b = await createAsscrackNode(opts('presence-late'))
    const c = await createAsscrackNode(opts('presence-late'))
    try {
        const logB = presenceLog(b)
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => logB.length === 1)
        a.setPresence({ state: 'dnd', note: 'meeting' })
        await waitFor(() => logB.length === 2)
        assert.deepEqual(logB[1], { peerId: a.peerId, state: 'dnd', note: 'meeting' })

        const logC = presenceLog(c)
        await c.connect(a.getMultiaddrs()[0])
        await waitFor(() => logC.some(e => e.peerId === a.peerId))
        assert.deepEqual(logC.find(e => e.peerId === a.peerId), { peerId: a.peerId, state: 'dnd', note: 'meeting' })
        assert.deepEqual(c.peerPresence()[a.peerId], { state: 'dnd', note: 'meeting' })
    } finally {
        await stopAll([c, b, a])
    }
})

test('presence: a replaced peer (same name, new peer ID) has no old state', { timeout: 20000 }, async () => {
    const a = await createAsscrackNode({ ...opts('presence-replace'), name: 'Alice' })
    const b = await createAsscrackNode(opts('presence-replace'))
    let a2 = null
    try {
        a.setPresence({ state: 'away', note: 'old' })
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => b.peerPresence()[a.peerId]?.state === 'away')

        const left = new Promise(resolve => b.events.once('peer-left', resolve))
        await a.stop()
        await left
        assert.deepEqual(b.peerPresence(), {})

        a2 = await createAsscrackNode({ ...opts('presence-replace'), name: 'Alice' })
        assert.notEqual(a2.peerId, a.peerId)
        await a2.connect(b.getMultiaddrs()[0])
        await waitFor(() => b.peerPresence()[a2.peerId] !== undefined)
        assert.deepEqual(b.peerPresence(), { [a2.peerId]: { state: 'available', note: '' } })
        assert.equal(b.peerPresence()[a.peerId], undefined)
    } finally {
        await stopAll([a2, b, a].filter(Boolean))
    }
})

// A node opens only one chat session for each peer. The close handler deletes the entry, so a real connection
// cannot close an old session after a new session of the same peer opened. The most direct real case: a second
// chat stream of the same peer on a second connection. The node refuses it and closes it while the first session
// stays open. The close of that stream must not delete the state.
test('presence: the close of a second stream of the same peer does not delete the state', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts('presence-close'))
    const b = await createAsscrackNode(opts('presence-close'))
    try {
        const logA = presenceLog(a)
        b.setPresence({ state: 'away', note: 'kept' })
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => a.peerPresence()[b.peerId]?.state === 'away')
        assert.equal(logA.length, 1)

        // A second connection, because libp2p allows one chat stream for each connection.
        const conn = await b.libp2p.dial(multiaddr(a.getMultiaddrs()[0]), { force: true })
        assert.equal(b.libp2p.getConnections(a.libp2p.peerId).length, 2)
        const stream = await conn.newStream(CHAT_PROTOCOL, { runOnTransientConnection: true })
        const outgoing = pushable()
        outgoing.push(Buffer.from(JSON.stringify({ type: 'presence', v: 1, state: 'dnd', note: 'stale' }) + '\n'))
        stream.sink(outgoing).catch(() => {})
        // A resets the second stream.
        await (async () => { for await (const chunk of stream.source) void chunk })().catch(() => {})
        outgoing.end()
        assert.notEqual(stream.status, 'open')
        await delay(500)
        assert.deepEqual(a.peers(), [b.peerId])
        assert.deepEqual(a.peerPresence(), { [b.peerId]: { state: 'away', note: 'kept' } })
        assert.equal(logA.length, 1)
    } finally {
        await stopAll([b, a])
    }
})

test('presence: a presence line makes no history entry, no message event and no console line', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts('presence-history'))
    const b = await createAsscrackNode(opts('presence-history'))
    const lines = []
    const original = { log: console.log, info: console.info, warn: console.warn }
    try {
        const messages = []
        a.events.on('message', e => messages.push(e))
        b.events.on('message', e => messages.push(e))
        const logB = presenceLog(b)
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => logB.length === 1)
        for (const k of Object.keys(original)) console[k] = (...args) => lines.push(args.join(' '))
        a.setPresence({ state: 'away', note: 'back soon' })
        await waitFor(() => logB.length === 2)
        await delay(200)
        for (const k of Object.keys(original)) console[k] = original[k]
        assert.deepEqual(b.history(), [])
        assert.deepEqual(a.history(), [])
        assert.deepEqual(messages, [])
        assert.deepEqual(lines.filter(l => /presence/i.test(l)), [])
    } finally {
        for (const k of Object.keys(original)) console[k] = original[k]
        await stopAll([b, a])
    }
})

test('presence: a bad presence line causes no change and no event', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts('presence-bad'))
    const b = await createAsscrackNode(opts('presence-bad'))
    const outgoing = pushable()
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
        const logA = presenceLog(a)
        const joined = new Promise(resolve => a.events.once('peer-joined', resolve))
        const stream = await b.libp2p.dialProtocol(multiaddr(a.getMultiaddrs()[0]), CHAT_PROTOCOL)
        stream.sink(outgoing).catch(() => {})
        await joined
        const send = value => outgoing.push(Buffer.from(JSON.stringify(value) + '\n'))

        send({ type: 'presence', v: 1, state: 'away', note: 'first' })
        await waitFor(() => logA.length === 1)
        send({ type: 'presence', v: 1, state: 'busy', note: 'x' })
        send({ type: 'presence', v: 1, state: 'dnd', note: 5 })
        send({ type: 'presence', v: 1, state: 'dnd' })
        send({ type: 'presence', v: 1, state: 'dnd', note: null })
        // The same value again: no event.
        send({ type: 'presence', v: 1, state: 'away', note: '  first ' })
        // A valid line at the end marks that A read all lines before it.
        send({ type: 'presence', v: 1, state: 'available', note: 'end' })
        await waitFor(() => logA.length === 2)
        await delay(200)
        assert.deepEqual(logA, [
            { peerId: b.peerId, state: 'away', note: 'first' },
            { peerId: b.peerId, state: 'available', note: 'end' }
        ])
        assert.deepEqual(a.peerPresence(), { [b.peerId]: { state: 'available', note: 'end' } })
        assert.deepEqual(a.history(), [])
        assert.deepEqual(warnings.filter(w => w.includes(b.peerId)), [])
        assert.deepEqual(a.peers(), [b.peerId])
    } finally {
        console.warn = originalWarn
        outgoing.end()
        await stopAll([b, a])
    }
})
