import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { createVoiceRelay, VOICE_PROTOCOL, encodeFrame } from '../src/network/voice-relay.mjs'

// F4: the known gaps of decision 64. The first test is a 127.0.0.1 result, not a LAN result.
// The other tests use fake streams and no network.

// Literal values, so that the file also loads on the base build.
const VOICE_DIRECT_PROTOCOL = '/asscrack/voice-direct/1.0.0'
const FORWARD_CAP = 64

async function waitUntil(check, limit, what = 'condition') {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        if (check()) return
        await delay(20)
    }
    assert.ok(check(), `${what}: not true within ${limit} ms`)
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

test('a closed direct voice stream opens again with no host change (127.0.0.1)', { timeout: 30000 }, async () => {
    const [a, h, b] = await Promise.all([makeNode(), makeNode(), makeNode()])
    const relays = {}
    try {
        const ids = { a: a.peerId.toString(), h: h.peerId.toString(), b: b.peerId.toString() }
        await a.dial(h.getMultiaddrs()[0])
        await b.dial(h.getMultiaddrs()[0])
        await a.dial(b.getMultiaddrs()[0])
        for (const [k, node] of Object.entries({ a, h, b })) {
            relays[k] = createVoiceRelay({
                libp2p: node,
                selfId: ids[k],
                hostId: () => ids.h,
                voicePeers: () => [ids.a, ids.h, ids.b],
                connectionFor: peerId => node.getConnections().find(c => c.remotePeer.toString() === peerId),
                onFrame: () => {},
                directCandidates: () => k === 'a' ? [ids.b] : []
            })
            await node.handle(VOICE_PROTOCOL, relays[k].handle, { runOnTransientConnection: true })
            await node.handle(VOICE_DIRECT_PROTOCOL, relays[k].handleDirect, { runOnTransientConnection: true })
        }
        for (const r of Object.values(relays)) r.hostChanged()
        await waitUntil(() => relays.a.stats().directStreams === 1 && relays.b.stats().directIn === 1, 5000, 'direct stream A-B')
        // B closes the direct stream (as a network fault does). Nobody calls hostChanged() after this point.
        const conn = b.getConnections().find(c => c.remotePeer.toString() === ids.a)
        for (const s of conn.streams.filter(s => s.protocol === VOICE_DIRECT_PROTOCOL)) s.abort(new Error('test close'))
        await waitUntil(() => relays.b.stats().directIn === 0, 5000, 'direct stream closed on B')
        await waitUntil(() => relays.a.stats().directStreams === 1 && relays.b.stats().directIn === 1, 8000, 'direct stream open again')
        const before = relays.b.stats().directReceived
        relays.a.sendFrame(new Uint8Array([1, 2, 3]))
        await waitUntil(() => relays.b.stats().directReceived === before + 1, 3000, 'frame on the new direct stream')
    } finally {
        for (const r of Object.values(relays)) r.stop()
        await Promise.allSettled([a, h, b].map(n => n.stop()))
    }
})

// A fake inbound stream for the host: it gives one frame, then stays open until close.
function fakeStream(origin) {
    let release
    const closed = new Promise(r => { release = r })
    const wire = encodeFrame({ origin, seq: 0, data: new Uint8Array([7]) })
    return {
        stream: {
            sink: async src => { for await (const _ of src) { /* drop */ } },
            source: (async function * () { yield wire; await closed })(),
            close: async () => release(),
            abort: () => release()
        },
        connection: { remotePeer: { toString: () => origin } },
        release
    }
}

function hostRelay(peers) {
    return createVoiceRelay({
        libp2p: null,
        selfId: 'host',
        hostId: () => 'host',
        voicePeers: () => ['host', ...peers],
        connectionFor: () => null,
        onFrame: () => {}
    })
}

test('the host keeps forwardedTo below a cap, and peerLeft removes the rows (fake streams)', async () => {
    const peers = Array.from({ length: 100 }, (_, i) => `peer-${String(i).padStart(3, '0')}`)
    const fakes = []
    const relay = hostRelay(peers)
    try {
        // Each peer opens its stream after the peers before it, so that its frame goes to all of them.
        for (const p of peers) {
            const f = fakeStream(p)
            fakes.push(f)
            relay.handle(f)
            await delay(1)
        }
        await waitUntil(() => relay.stats().streams === peers.length, 5000, 'all fake streams')
        // The first peers open a new stream and send one more frame to all other peers.
        for (const p of peers.slice(0, 5)) {
            const f = fakeStream(p)
            fakes.push(f)
            relay.handle(f)
        }
        await delay(50)
        const ft = relay.stats().forwardedTo
        assert.ok(Object.keys(ft).length <= FORWARD_CAP, `origins in forwardedTo: ${Object.keys(ft).length}`)
        for (const [origin, row] of Object.entries(ft)) {
            assert.ok(Object.keys(row).length <= FORWARD_CAP, `targets of ${origin}: ${Object.keys(row).length}`)
        }
        for (const p of peers) relay.peerLeft(p)
        assert.deepEqual(relay.stats().forwardedTo, {}, 'no row after all peers left')
    } finally {
        relay.stop()
        for (const f of fakes) f.release()
    }
})

test('sendFrame returns false when it sent no frame (host with no voice member)', () => {
    const relay = hostRelay([])
    try {
        assert.equal(relay.sendFrame(new Uint8Array([1, 2, 3])), false)
    } finally {
        relay.stop()
    }
})

test('sendFrame returns false for a member with no host connection and no direct stream', () => {
    const relay = createVoiceRelay({
        libp2p: null,
        selfId: 'a',
        hostId: () => 'host',
        voicePeers: () => ['a', 'host'],
        connectionFor: () => null,
        onFrame: () => {}
    })
    try {
        relay.hostChanged()
        assert.equal(relay.sendFrame(new Uint8Array([1, 2, 3])), false)
    } finally {
        relay.stop()
    }
})
