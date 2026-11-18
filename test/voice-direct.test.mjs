import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { encodeFrame } from '../src/network/voice-relay.mjs'

// A literal value, so that the test also loads on a build with no direct voice and fails on its assertions.
const VOICE_DIRECT_PROTOCOL = '/asscrack/voice-direct/1.0.0'

// All results of this file are 127.0.0.1 results, not LAN results.

const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await sleep(20)
    }
    throw new Error(`timeout: ${what}`)
}

function localAddr(n) {
    const a = n.getMultiaddrs().find(m => m.startsWith('/ip4/127.0.0.1/') && !m.includes('p2p-circuit'))
    assert.ok(a, 'node has a 127.0.0.1 address')
    return a
}

function record(node) {
    const got = []
    node.events.on('voice-frame', f => got.push(f))
    return got
}

function forwarded(H, origin, target) {
    return H.voiceStats().forwardedTo[origin]?.[target] ?? 0
}

// Keyed room. H: full node and host. A and B: members with a direct connection. C: relay-only member.
async function room(nodes) {
    const room = `vd-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roomKey = newRoomKey()
    const H = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, ...fast })
    nodes.push(H)
    const A = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast })
    nodes.push(A)
    const B = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast })
    nodes.push(B)
    const C = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast })
    nodes.push(C)
    const hAddr = localAddr(H)
    await A.connect(hAddr)
    await B.connect(hAddr)
    await A.connect(localAddr(B))
    await C.connect(hAddr)
    await waitFor(() => A.peers().includes(B.peerId) && A.peers().includes(H.peerId) && B.peers().includes(H.peerId) &&
        C.peers().includes(H.peerId), 20000, 'sessions A-B, A-H, B-H, C-H')
    await waitFor(() => [H, A, B, C].every(n => n.host()?.peerId === H.peerId), 20000, 'H is the host of all nodes')
    return { H, A, B, C }
}

test('voice: A sends directly to B, H forwards no frame of A to B, relay-only C gets A through H', { timeout: 90000 }, async () => {
    const nodes = []
    try {
        const { H, A, B, C } = await room(nodes)
        const gotB = record(B)
        const gotC = record(C)
        for (const n of [H, A, B, C]) n.setVoice({ inVoice: true })
        await waitFor(() => H.voiceStats().streams === 3, 15000, 'three voice streams on H')
        await waitFor(() => A.voiceStats().directStreams >= 1 && B.voiceStats().directStreams >= 1, 15000, 'direct streams A-B')
        // C has no direct path: its connections to A and B (if any) are relayed.
        assert.equal(C.voiceStats().directStreams, 0, 'C has no direct stream')
        // Wait until H has the direct report of A.
        const before = forwarded(H, A.peerId, B.peerId)
        await sleep(500)
        const setup = forwarded(H, A.peerId, B.peerId)
        const setupC = forwarded(H, A.peerId, C.peerId)

        for (let i = 0; i < 100; i++) {
            A.sendVoiceFrame(new Uint8Array(120).fill(i & 0xff))
            await sleep(20)
        }
        await waitFor(() => gotB.filter(f => f.origin === A.peerId).length >= 100 &&
            gotC.filter(f => f.origin === A.peerId).length >= 100, 5000, 'B and C get the frames of A').catch(() => {})
        const fromA = gotB.filter(f => f.origin === A.peerId)
        const fromAatC = gotC.filter(f => f.origin === A.peerId)
        const sA = A.voiceStats()
        const sB = B.voiceStats()
        const sH = H.voiceStats()
        console.log(`127.0.0.1 direct voice: B got ${fromA.length}, C got ${fromAatC.length}, ` +
            `A directSent ${sA.directSent}, B directReceived ${sB.directReceived}, B duplicates ${sB.duplicates}, ` +
            `H forwarded A->B ${forwarded(H, A.peerId, B.peerId) - setup} (before ${before}), ` +
            `H forwarded A->C ${forwarded(H, A.peerId, C.peerId) - setupC}, H forwarded total ${sH.forwarded}`)
        assert.ok(fromA.length >= 98, `B got ${fromA.length} of 100 frames`)
        for (let i = 1; i < fromA.length; i++) assert.ok(fromA[i].seq > fromA[i - 1].seq, 'sequence numbers increase')
        assert.ok(sB.directReceived >= 98, `B got ${sB.directReceived} frames on the direct stream`)
        assert.equal(forwarded(H, A.peerId, B.peerId) - setup, 0, 'H forwards 0 frames of A to B after the setup')
        assert.ok(fromAatC.length >= 98, `C got ${fromAatC.length} of 100 frames through H`)
        assert.ok(forwarded(H, A.peerId, C.peerId) - setupC >= 98, 'H forwards the frames of A to C')
    } finally {
        await Promise.allSettled(nodes.map(n => n.stop()))
    }
})

test('voice: the receiver drops a frame with a false origin on a direct voice stream', { timeout: 90000 }, async () => {
    const nodes = []
    const warn = console.warn
    const warnings = []
    console.warn = (...args) => { warnings.push(args.join(' ')); warn(...args) }
    try {
        const { H, A, B, C } = await room(nodes)
        const gotB = record(B)
        for (const n of [H, A, B]) n.setVoice({ inVoice: true })
        await waitFor(() => H.voiceStats().streams === 2, 15000, 'two voice streams on H')
        // A opens its own direct stream to B and writes frames with the origin of C and of H.
        const conn = A.libp2p.getConnections().find(c => c.remotePeer.toString() === B.peerId && !c.remoteAddr.toString().includes('/p2p-circuit'))
        assert.ok(conn, 'A has a direct connection to B')
        const stream = await conn.newStream(VOICE_DIRECT_PROTOCOL)
        const fake = []
        for (let seq = 0; seq < 5; seq++) fake.push(encodeFrame({ origin: C.peerId, seq: 1000 + seq, data: new Uint8Array(50) }))
        fake.push(encodeFrame({ origin: H.peerId, seq: 2000, data: new Uint8Array(50) }))
        fake.push(encodeFrame({ origin: A.peerId, seq: 3000, data: new Uint8Array(50) }))
        stream.sink((async function * () { yield * fake })()).catch(() => {})
        await waitFor(() => gotB.some(f => f.origin === A.peerId && f.seq === 3000), 5000, 'B gets the true frame of A')
        assert.equal(B.voiceStats().droppedOrigin, 6, 'B drops 6 frames with a false origin')
        assert.equal(gotB.filter(f => f.origin === C.peerId || f.origin === H.peerId).length, 0, 'B delivers no false frame')
        assert.equal(warnings.filter(w => w.includes('is not the sender') && w.includes('(direct)')).length, 1, 'one warning for each stream')
    } finally {
        console.warn = warn
        await Promise.allSettled(nodes.map(n => n.stop()))
    }
})
