import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { pushable } from 'it-pushable'
import { multiaddr } from '@multiformats/multiaddr'
import { createAsscrackNode, CHAT_PROTOCOL } from '../src/network/node.mjs'

async function waitFor(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (check()) return
        await delay(50)
    }
    assert.ok(check(), 'Timed out waiting for expected node behavior')
}

// The random id makes an exact deepEqual impossible: check the id, then remove it.
function withoutId(messages) {
    return messages.map(({ id, ...rest }) => {
        assert.equal(typeof id, 'string')
        assert.ok(id.length > 0)
        return rest
    })
}

// Remove the time after a check that it is a number, so tests can compare exact values.
function withoutTime(messages) {
    return messages.map(({ time, ...rest }) => {
        assert.equal(typeof time, 'number')
        return rest
    })
}

function record(node) {
    const log = { joined: [], left: [], messages: [] }
    node.events.on('peer-joined', e => log.joined.push(e))
    node.events.on('peer-left', e => log.left.push(e))
    node.events.on('message', e => log.messages.push(e))
    return log
}

test('two nodes chat through createAsscrackNode', { timeout: 15000 }, async () => {
    const opts = { room: 'test', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }
    const a = await createAsscrackNode(opts)
    const b = await createAsscrackNode(opts)
    let bStopped = false
    try {
        const logA = record(a)
        const logB = record(b)
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => logA.joined.length === 1 && logB.joined.length === 1)
        assert.deepEqual(logA.joined, [{ peerId: b.peerId }])
        assert.deepEqual(logB.joined, [{ peerId: a.peerId }])
        assert.deepEqual(a.peers(), [b.peerId])
        assert.deepEqual(b.peers(), [a.peerId])

        assert.equal(a.send('hello from A'), 1)
        assert.equal(b.send('hello from B'), 1)
        await waitFor(() => logA.messages.length === 1 && logB.messages.length === 1)
        await delay(200)
        assert.deepEqual(withoutTime(withoutId(logB.messages)), [{ peerId: a.peerId, from: a.name, text: 'hello from A' }])
        assert.deepEqual(withoutTime(withoutId(logA.messages)), [{ peerId: b.peerId, from: b.name, text: 'hello from B' }])

        await b.stop()
        bStopped = true
        await waitFor(() => logA.left.length === 1)
        assert.deepEqual(logA.left, [{ peerId: b.peerId }])
        assert.deepEqual(a.peers(), [])
    } finally {
        if (!bStopped) await b.stop()
        await a.stop()
    }
})

test('two nodes in one room connect through mDNS discovery', { timeout: 30000 }, async () => {
    const opts = { room: 'auto-test', listen: ['/ip4/0.0.0.0/tcp/0'], discovery: true, discoveryInterval: 1000 }
    const a = await createAsscrackNode(opts)
    const b = await createAsscrackNode(opts)
    try {
        const logA = record(a)
        const logB = record(b)
        const deadline = Date.now() + 15000
        while (!(logA.joined.length >= 1 && logB.joined.length >= 1) && Date.now() < deadline) await delay(50)
        assert.deepEqual(logA.joined, [{ peerId: b.peerId }])
        assert.deepEqual(logB.joined, [{ peerId: a.peerId }])

        assert.equal(a.send('auto hello from A'), 1)
        assert.equal(b.send('auto hello from B'), 1)
        await waitFor(() => logA.messages.length === 1 && logB.messages.length === 1)
        await delay(200)
        assert.deepEqual(withoutTime(withoutId(logB.messages)), [{ peerId: a.peerId, from: a.name, text: 'auto hello from A' }])
        assert.deepEqual(withoutTime(withoutId(logA.messages)), [{ peerId: b.peerId, from: b.name, text: 'auto hello from B' }])
        assert.equal(a.peers().length, 1)
        assert.equal(b.peers().length, 1)
    } finally {
        await b.stop()
        await a.stop()
    }
})

test('nodes in different rooms do not connect', { timeout: 15000 }, async () => {
    const base = { listen: ['/ip4/0.0.0.0/tcp/0'], discovery: true, discoveryInterval: 1000 }
    const a = await createAsscrackNode({ ...base, room: 'room-one' })
    const b = await createAsscrackNode({ ...base, room: 'room-two' })
    try {
        await delay(5000)
        assert.deepEqual(a.peers(), [])
        assert.deepEqual(b.peers(), [])
    } finally {
        await b.stop()
        await a.stop()
    }
})

test('structured messages carry the sender name, text and time in both directions', { timeout: 15000 }, async () => {
    const base = { room: 'test', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }
    const a = await createAsscrackNode({ ...base, name: 'Alice' })
    const b = await createAsscrackNode(base)
    try {
        assert.equal(a.name, 'Alice')
        assert.equal(b.name, b.peerId.slice(-8))
        const logA = record(a)
        const logB = record(b)
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => logA.joined.length === 1 && logB.joined.length === 1)

        const texts = ['hello', 'Unicode: h\u00e9llo \u{1F30D}', '']
        for (const text of texts) {
            assert.equal(a.send(text), 1)
            assert.equal(b.send(text), 1)
        }
        await waitFor(() => logA.messages.length === texts.length && logB.messages.length === texts.length)
        await delay(200)
        assert.deepEqual(withoutTime(withoutId(logB.messages)), texts.map(text => ({ peerId: a.peerId, from: 'Alice', text })))
        assert.deepEqual(withoutTime(withoutId(logA.messages)), texts.map(text => ({ peerId: b.peerId, from: b.name, text })))
    } finally {
        await b.stop()
        await a.stop()
    }
})

test('a node ignores lines that are not valid and keeps the session open', { timeout: 15000 }, async () => {
    const base = { room: 'test', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }
    const a = await createAsscrackNode(base)
    const b = await createAsscrackNode(base)
    const outgoing = pushable()
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
        const logA = record(a)
        const stream = await b.libp2p.dialProtocol(multiaddr(a.getMultiaddrs()[0]), CHAT_PROTOCOL)
        stream.sink(outgoing).catch(() => {})
        await waitFor(() => logA.joined.length === 1)

        outgoing.push(Buffer.from('not json\n'))
        outgoing.push(Buffer.from(JSON.stringify({ from: 'raw', text: 5, time: 1 }) + '\n'))
        outgoing.push(Buffer.from(JSON.stringify({ from: 'raw', text: 'valid', time: 123 }) + '\n'))
        await waitFor(() => logA.messages.length === 1)
        await delay(200)
        assert.deepEqual(withoutId(logA.messages), [{ peerId: b.peerId, from: 'raw', text: 'valid', time: 123 }])
        assert.equal(warnings.filter(w => w.includes(b.peerId)).length, 2)
        assert.deepEqual(a.peers(), [b.peerId])
        assert.deepEqual(logA.left, [])
    } finally {
        console.warn = originalWarn
        outgoing.end()
        await b.stop()
        await a.stop()
    }
})

test('two nodes send their names in a hello line with no chat message', { timeout: 15000 }, async () => {
    const opts = { room: 'test', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }
    const a = await createAsscrackNode({ ...opts, name: 'Alice' })
    const b = await createAsscrackNode({ ...opts, name: 'Bob' })
    let bStopped = false
    try {
        const namesA = []
        const namesB = []
        a.events.on('peer-name', e => namesA.push(e))
        b.events.on('peer-name', e => namesB.push(e))
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => namesA.length === 1 && namesB.length === 1)
        assert.deepEqual(namesA, [{ peerId: b.peerId, name: 'Bob' }])
        assert.deepEqual(namesB, [{ peerId: a.peerId, name: 'Alice' }])
        assert.deepEqual(a.peerNames(), { [b.peerId]: 'Bob' })

        await b.stop()
        bStopped = true
        await waitFor(() => a.peers().length === 0)
        assert.deepEqual(a.peerNames(), {})
    } finally {
        if (!bStopped) await b.stop()
        await a.stop()
    }
})

test('a node ignores a hello line with a name that is not valid', { timeout: 15000 }, async () => {
    const base = { room: 'test', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }
    const a = await createAsscrackNode(base)
    const b = await createAsscrackNode(base)
    const outgoing = pushable()
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
        const logA = record(a)
        const namesA = []
        a.events.on('peer-name', e => namesA.push(e))
        const stream = await b.libp2p.dialProtocol(multiaddr(a.getMultiaddrs()[0]), CHAT_PROTOCOL)
        stream.sink(outgoing).catch(() => {})
        await waitFor(() => logA.joined.length === 1)

        outgoing.push(Buffer.from(JSON.stringify({ type: 'hello', name: 5 }) + '\n'))
        outgoing.push(Buffer.from(JSON.stringify({ type: 'hello', name: '   ' }) + '\n'))
        outgoing.push(Buffer.from(JSON.stringify({ from: 'raw', text: 'valid', time: 123 }) + '\n'))
        await waitFor(() => logA.messages.length === 1)
        await delay(200)
        assert.deepEqual(namesA, [])
        assert.deepEqual(warnings.filter(w => w.includes('Ignored')), [])
        assert.deepEqual(a.peers(), [b.peerId])
        assert.deepEqual(logA.left, [])
        assert.deepEqual(a.peerNames(), {})
    } finally {
        console.warn = originalWarn
        outgoing.end()
        await b.stop()
        await a.stop()
    }
})

test('the host and the member log the history that they send and apply', { timeout: 20000 }, async () => {
    const opts = {
        room: 'test', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false,
        heartbeatInterval: 300, hostTimeout: 1500, electionDelay: 1000
    }
    const lines = []
    const originalInfo = console.info
    console.info = (...args) => { lines.push(args.join(' ')) }
    // A node with no session never elects itself. Two nodes elect a host first.
    const first = await createAsscrackNode(opts)
    const second = await createAsscrackNode(opts)
    let member
    try {
        await second.connect(first.getMultiaddrs()[0])
        await waitFor(() => first.isHost() || second.isHost())
        const host = first.isHost() ? first : second
        host.send('one')
        host.send('two')
        assert.equal(host.history().length, 2)
        member = await createAsscrackNode(opts)
        await member.connect(host.getMultiaddrs()[0])
        await waitFor(() => lines.includes(`History sent to ${member.peerId}: 2 messages`)
            && lines.includes('History applied: 2 of 2 messages are new'))
    } finally {
        console.info = originalInfo
        if (member) await member.stop()
        await second.stop()
        await first.stop()
    }
})
