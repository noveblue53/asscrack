import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { VOICE_PROTOCOL, encodeFrame } from '../src/network/voice-relay.mjs'
import { multiaddr } from '@multiformats/multiaddr'

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

async function stopAll(nodes) {
    await Promise.allSettled(nodes.filter(Boolean).map(n => n.stop()))
}

function percentile(sorted, p) {
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

function record(node) {
    const got = []
    node.events.on('voice-frame', f => got.push({ ...f, at: performance.now() }))
    return got
}

// A sends 200 frames of 120 bytes, 20 ms apart. Returns the sorted latencies A -> B.
async function sendAndCheck(A, B, gotB, label) {
    const sentAt = []
    for (let i = 0; i < 200; i++) {
        sentAt.push(performance.now())
        A.sendVoiceFrame(new Uint8Array(120).fill(i & 0xff))
        await sleep(20)
    }
    await waitFor(() => gotB.filter(f => f.origin === A.peerId).length >= 200, 3000, 'all frames').catch(() => {})
    const fromA = gotB.filter(f => f.origin === A.peerId)
    assert.ok(fromA.length >= 195, `B got ${fromA.length} of 200 frames`)
    for (let i = 1; i < fromA.length; i++) assert.ok(fromA[i].seq > fromA[i - 1].seq, 'sequence numbers increase')
    assert.equal(fromA[0].data.length, 120)
    const lat = fromA.map(f => f.at - sentAt[f.seq]).sort((x, y) => x - y)
    console.log(`127.0.0.1 voice latency ${label}: median ${percentile(lat, 0.5).toFixed(2)} ms, ` +
        `p95 ${percentile(lat, 0.95).toFixed(2)} ms, frames ${fromA.length}`)
}

test('keyed room: voice from relay-only A through full node R (host) to relay-only B', { timeout: 60000 }, async () => {
    const room = `voice-${Date.now()}`
    const K = newRoomKey()
    const nodes = []
    try {
        const R = await createAsscrackNode({ room, roomKey: K, listen: LOCAL, discovery: false, fullNode: true, ...fast })
        nodes.push(R)
        const A = await createAsscrackNode({ room, roomKey: K, relayOnly: true, fullNode: false, ...fast })
        nodes.push(A)
        const B = await createAsscrackNode({ room, roomKey: K, relayOnly: true, fullNode: false, ...fast })
        nodes.push(B)
        const rAddr = localAddr(R)
        await A.connect(rAddr)
        await B.connect(rAddr)
        await waitFor(() => A.peers().includes(R.peerId) && B.peers().includes(R.peerId), 20000, 'A-R and B-R sessions')
        await waitFor(() => [R, A, B].every(n => n.host()?.peerId === R.peerId), 20000, 'R is the host of all nodes')

        // A and B have no direct TCP path: each connection of A and B to a peer other than R is relayed.
        for (const [x, y] of [[A, B], [B, A]]) {
            assert.ok(x.libp2p.getConnections().some(c => c.remotePeer.toString() === R.peerId), 'chat connection to R')
            for (const c of x.libp2p.getConnections()) {
                if (c.remotePeer.toString() === y.peerId) assert.ok(c.remoteAddr.toString().includes('/p2p-circuit'), `connection ${c.remoteAddr} is relayed`)
            }
        }

        const gotA = record(A)
        const gotB = record(B)
        const gotR = record(R)
        A.setVoice({ inVoice: true })
        B.setVoice({ inVoice: true })
        await waitFor(() => R.voiceStats().streams === 2, 10000, 'two voice streams on R')

        await sendAndCheck(A, B, gotB, 'keyed room A->R->B')
        assert.ok(gotR.filter(f => f.origin === A.peerId).length >= 195, 'R gets the frames of A')
        assert.equal(gotA.filter(f => f.origin === A.peerId).length, 0, 'A does not get its own frames')
    } finally {
        await stopAll(nodes)
    }
})

test('LAN room (no key): voice from member A through the host to member B', { timeout: 60000 }, async () => {
    const room = `voice-lan-${Date.now()}`
    const nodes = []
    try {
        for (let i = 0; i < 3; i++) nodes.push(await createAsscrackNode({ room, listen: LOCAL, discovery: false, ...fast }))
        for (let i = 0; i < 3; i++)
            for (let j = i + 1; j < 3; j++) await nodes[i].connect(localAddr(nodes[j]))
        await waitFor(() => nodes.every(n => n.peers().length === 2), 10000, 'full mesh')
        await waitFor(() => {
            const h = nodes[0].host()?.peerId
            return h && nodes.every(n => n.host()?.peerId === h)
        }, 20000, 'one host')
        const hostId = nodes[0].host().peerId
        const H = nodes.find(n => n.peerId === hostId)
        const [A, B] = nodes.filter(n => n !== H)
        const gotB = record(B)
        const gotH = record(H)
        A.setVoice({ inVoice: true })
        B.setVoice({ inVoice: true })
        await waitFor(() => H.voiceStats().streams === 2, 10000, 'two voice streams on the host')
        await sendAndCheck(A, B, gotB, 'LAN room A->host->B')
        assert.ok(gotH.filter(f => f.origin === A.peerId).length >= 195, 'the host gets the frames of A')
    } finally {
        await stopAll(nodes)
    }
})

test('keyed room: a node with a wrong key cannot send voice frames through the host', { timeout: 60000 }, async () => {
    const room = `voice-key-${Date.now()}`
    const K = newRoomKey()
    const K2 = newRoomKey()
    const nodes = []
    try {
        const R = await createAsscrackNode({ room, roomKey: K, listen: LOCAL, discovery: false, fullNode: true, ...fast })
        nodes.push(R)
        const A = await createAsscrackNode({ room, roomKey: K, relayOnly: true, fullNode: false, ...fast })
        nodes.push(A)
        const W = await createAsscrackNode({ room, roomKey: K2, listen: LOCAL, discovery: false, fullNode: false, ...fast })
        nodes.push(W)
        const rAddr = localAddr(R)
        await A.connect(rAddr)
        await waitFor(() => A.peers().includes(R.peerId) && [R, A].every(n => n.host()?.peerId === R.peerId), 20000, 'A-R session, R is the host')
        const gotR = record(R)
        const gotA = record(A)
        R.setVoice({ inVoice: true })
        A.setVoice({ inVoice: true })
        await waitFor(() => R.voiceStats().streams === 1, 10000, 'voice stream of A on R')

        // W dials R and writes frames with its own origin on a voice stream that it opens itself.
        const conn = await W.libp2p.dial(multiaddr(rAddr))
        let opened = false
        try {
            const stream = await conn.newStream(VOICE_PROTOCOL, { runOnTransientConnection: true })
            opened = true
            const frames = []
            for (let seq = 0; seq < 50; seq++) frames.push(encodeFrame({ origin: W.peerId, seq, data: new Uint8Array(100) }))
            await stream.sink((async function * () {
                for (const f of frames) { yield f; await sleep(10) }
            })()).catch(() => {})
        } catch {
            // R can refuse the stream at once. That is also a pass.
        }
        // A sends frames too, so that the path is shown to work during the same time.
        for (let i = 0; i < 20; i++) { A.sendVoiceFrame(new Uint8Array(100)); await sleep(20) }
        await waitFor(() => gotR.filter(f => f.origin === A.peerId).length >= 19, 5000, 'R gets the frames of A')
        await sleep(500)
        console.log(`wrong-key voice stream opened on W: ${opened}`)
        assert.equal(W.peers().includes(R.peerId), false, 'W has no session with R')
        assert.equal(gotR.filter(f => f.origin === W.peerId).length, 0, 'R delivers no frame from W')
        assert.equal(gotA.filter(f => f.origin === W.peerId).length, 0, 'A gets no frame from W')
    } finally {
        await stopAll(nodes)
    }
})
