import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStreamCompatibleLibp2p } from '../src/network/libp2p-streams.mjs'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { createVoiceRelay, VOICE_PROTOCOL } from '../src/network/voice-relay.mjs'

// All results of this file are 127.0.0.1 results, not LAN results.
// F2: a stream open that takes longer than one frame (20 ms), as in the busy main process of the app.
// The member must open only one stream to the host, and the other member must get the frames from the start.

const OPEN_DELAY_MS = 100
const FRAME_MS = 20

async function makeNode() {
    return createStreamCompatibleLibp2p({
        addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        connectionManager: { minConnections: 0 }
    })
}

async function oneRun() {
    const [a, h, b] = await Promise.all([makeNode(), makeNode(), makeNode()])
    try {
        const ids = { a: a.peerId.toString(), h: h.peerId.toString(), b: b.peerId.toString() }
        await a.dial(h.getMultiaddrs()[0])
        await b.dial(h.getMultiaddrs()[0])
        const voice = new Set([ids.h, ids.b])
        const got = []
        let opens = 0
        const relays = {}
        for (const [k, node] of Object.entries({ a, h, b })) {
            relays[k] = createVoiceRelay({
                libp2p: node,
                selfId: ids[k],
                hostId: () => ids.h,
                voicePeers: () => [...voice],
                connectionFor: peerId => {
                    const conn = node.getConnections().find(c => c.remotePeer.toString() === peerId)
                    if (!conn || k !== 'a') return conn
                    // A slow stream open on A.
                    return { remotePeer: conn.remotePeer, newStream: async (...args) => { opens++; const s = await conn.newStream(...args); await delay(OPEN_DELAY_MS); return s } }
                },
                onFrame: f => { if (k === 'b' && f.origin === ids.a) got.push({ seq: f.seq, at: performance.now() }) }
            })
            await node.handle(VOICE_PROTOCOL, relays[k].handle, { runOnTransientConnection: true })
        }
        relays.h.hostChanged()
        relays.b.hostChanged()
        const deadline = Date.now() + 5000
        while (relays.h.stats().streams < 1 && Date.now() < deadline) await delay(20)
        const t0 = performance.now()
        voice.add(ids.a)
        relays.a.hostChanged()
        let sent = 0
        relays.a.sendFrame(new Uint8Array([1, 2, 3])); sent++
        const timer = setInterval(() => { relays.a.sendFrame(new Uint8Array([1, 2, 3])); sent++ }, FRAME_MS)
        await delay(3000)
        clearInterval(timer)
        await delay(300)
        const seqs = got.map(g => g.seq)
        return { startMs: got.length ? got[0].at - t0 : Infinity, firstSeq: seqs[0] ?? null, seqs, sent, opens,
            streams: relays.h.stats().streams }
    } finally {
        await Promise.all([a, h, b].map(n => n.stop().catch(() => {})))
    }
}

test('voice start with a slow stream open: one stream, frames from the start, no gap (127.0.0.1)', { timeout: 120000 }, async () => {
    const runs = []
    for (let i = 0; i < 5; i++) runs.push(await oneRun())
    const starts = runs.map(r => r.startMs).sort((x, y) => x - y)
    const median = starts[Math.floor(starts.length / 2)]
    console.log(`voice start slow open (127.0.0.1): median ${median.toFixed(1)} ms, runs ${runs.map(r => `${r.startMs.toFixed(1)} ms first seq ${r.firstSeq} got ${r.seqs.length}/${r.sent} opens ${r.opens}`).join('; ')}`)
    for (const r of runs) {
        assert.equal(r.opens, 1, 'A opens one stream to the host')
        assert.equal(r.firstSeq, 0, 'B gets the first frame of A')
        for (let i = 1; i < r.seqs.length; i++) assert.equal(r.seqs[i], r.seqs[i - 1] + 1, `no gap after seq ${r.seqs[i - 1]}`)
    }
    // A wide limit: the start time includes the open delay and the load of a full regression on all CPUs.
    assert.ok(median <= OPEN_DELAY_MS + 1000, `median start ${median.toFixed(1)} ms`)
})
