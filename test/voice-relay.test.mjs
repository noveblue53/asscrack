import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { createVoiceRelay, VOICE_PROTOCOL, MAX_BODY, encodeFrame } from '../src/network/voice-relay.mjs'

// All results of this file are 127.0.0.1 results, not LAN results.

async function waitUntil(check, limit) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        if (check()) return
        await delay(20)
    }
    assert.ok(check(), `Condition not true within ${limit} ms`)
}

async function makeNode() {
    return createLibp2p({
        addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
        transports: [tcp()],
        connectionEncryption: [noise()],
        streamMuxers: [yamux()],
        // No auto-dial: its 5 s timer stays after stop() in libp2p 1.x and keeps the test process open.
        connectionManager: { minConnections: 0 }
    })
}

function percentile(sorted, p) {
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

async function setup() {
    const [a, h, b] = await Promise.all([makeNode(), makeNode(), makeNode()])
    const ids = { a: a.peerId.toString(), h: h.peerId.toString(), b: b.peerId.toString() }
    await a.dial(h.getMultiaddrs()[0])
    await b.dial(h.getMultiaddrs()[0])
    const voice = new Set([ids.a, ids.h, ids.b])
    const got = { a: [], h: [], b: [] }
    const relays = {}
    for (const [k, node] of Object.entries({ a, h, b })) {
        relays[k] = createVoiceRelay({
            libp2p: node,
            selfId: ids[k],
            hostId: () => ids.h,
            voicePeers: () => [...voice],
            connectionFor: peerId => node.getConnections().find(c => c.remotePeer.toString() === peerId),
            onFrame: f => got[k].push({ ...f, at: performance.now() })
        })
        await node.handle(VOICE_PROTOCOL, relays[k].handle, { runOnTransientConnection: true })
    }
    relays.a.hostChanged()
    relays.b.hostChanged()
    relays.h.hostChanged()
    return { nodes: { a, h, b }, ids, got, relays }
}

async function cleanup({ nodes, relays }) {
    for (const r of Object.values(relays)) r.stop()
    await Promise.allSettled(Object.values(nodes).map(n => n.stop()))
}

test('voice frames go from member A through host H to member B (127.0.0.1)', async () => {
    const ctx = await setup()
    const { ids, got, relays } = ctx
    try {
        // Both members open their stream to the host.
        await waitUntil(() => relays.h.stats().streams === 2, 5000)
        const sentAt = []
        for (let i = 0; i < 200; i++) {
            sentAt.push(performance.now())
            assert.equal(relays.a.sendFrame(new Uint8Array(120).fill(i & 0xff)), true)
            await delay(20)
        }
        await waitUntil(() => got.b.length >= 200, 3000).catch(() => {})
        const fromA = got.b.filter(f => f.origin === ids.a)
        assert.ok(fromA.length >= 195, `B got ${fromA.length} of 200 frames`)
        for (let i = 1; i < fromA.length; i++) assert.ok(fromA[i].seq > fromA[i - 1].seq, 'sequence numbers increase')
        assert.equal(fromA[0].data.length, 120)
        assert.ok(got.h.filter(f => f.origin === ids.a).length >= 195, 'H gets the frames of A')
        assert.equal(got.a.filter(f => f.origin === ids.a).length, 0, 'A does not get its own frames')

        const lat = fromA.map(f => f.at - sentAt[f.seq]).sort((x, y) => x - y)
        console.log(`127.0.0.1 voice latency A->H->B: median ${percentile(lat, 0.5).toFixed(2)} ms, ` +
            `p95 ${percentile(lat, 0.95).toFixed(2)} ms, frames ${fromA.length}`)

        // The host sends its own frames.
        for (let i = 0; i < 20; i++) {
            relays.h.sendFrame(new Uint8Array(80))
            await delay(5)
        }
        await waitUntil(() => got.a.filter(f => f.origin === ids.h).length === 20 &&
            got.b.filter(f => f.origin === ids.h).length === 20, 3000)
        assert.equal(got.h.filter(f => f.origin === ids.h).length, 0)
    } finally {
        await cleanup(ctx)
    }
})

test('voice relay drops a frame with a body above 4,000 bytes (127.0.0.1)', async () => {
    const ctx = await setup()
    const { ids, got, relays } = ctx
    const warn = console.warn
    const warnings = []
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
        await waitUntil(() => relays.h.stats().streams === 2, 5000)
        assert.equal(encodeFrame({ origin: ids.a, seq: 0, data: new Uint8Array(MAX_BODY) }), null)
        assert.equal(relays.a.sendFrame(new Uint8Array(MAX_BODY)), false)
        assert.equal(relays.a.sendFrame(new Uint8Array(MAX_BODY)), false)
        assert.equal(relays.a.stats().droppedOversize, 2)
        assert.equal(warnings.filter(w => w.includes('Voice frame dropped')).length, 1, 'one warning only')
        relays.a.sendFrame(new Uint8Array(100))
        await waitUntil(() => got.b.length === 1, 3000)
        assert.equal(got.b[0].data.length, 100)
        assert.equal(got.b[0].origin, ids.a)
    } finally {
        console.warn = warn
        await cleanup(ctx)
    }
})

test('the host drops a frame whose origin is not the sender of the stream (127.0.0.1)', async () => {
    const ctx = await setup()
    const { nodes, ids, got, relays } = ctx
    const warn = console.warn
    const warnings = []
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
        await waitUntil(() => relays.h.stats().streams === 2, 5000)
        // A writes frames with the origin of B on its own stream to H.
        const conn = nodes.a.getConnections().find(c => c.remotePeer.toString() === ids.h)
        const stream = await conn.newStream(VOICE_PROTOCOL)
        const fake = [0, 1, 2].map(seq => encodeFrame({ origin: ids.b, seq, data: new Uint8Array(50) }))
        stream.sink((async function * () { yield * fake })()).catch(() => {})
        await waitUntil(() => relays.h.stats().droppedOrigin === 3, 3000)
        assert.equal(warnings.filter(w => w.includes('is not the sender')).length, 1, 'one warning for each stream')
        assert.equal(got.h.length, 0)
        assert.equal(got.b.length, 0)
    } finally {
        console.warn = warn
        await cleanup(ctx)
    }
})
