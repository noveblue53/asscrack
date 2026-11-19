import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode } from '../src/network/node.mjs'

// All results of this file are 127.0.0.1 results, not LAN results.
// F2: the time from Join voice (setVoice) to the first frame at the other member, and no gap in the sequence numbers.

const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const FRAME_MS = 20
// One Opus frame is 20 ms. The test accepts a start time of at most 50 frames: a wide limit for a loaded PC.
const START_LIMIT_MS = 1000

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

// H: full node and host. A and B: members, connected only to H (no direct stream between A and B).
async function oneRun() {
    const nodes = []
    try {
        const room = `vs-${Date.now()}-${Math.random().toString(16).slice(2)}`
        const H = await createAsscrackNode({ room, listen: LOCAL, discovery: false, fullNode: true, ...fast })
        nodes.push(H)
        const A = await createAsscrackNode({ room, listen: LOCAL, discovery: false, fullNode: false, ...fast })
        nodes.push(A)
        const B = await createAsscrackNode({ room, listen: LOCAL, discovery: false, fullNode: false, ...fast })
        nodes.push(B)
        await A.connect(localAddr(H))
        await B.connect(localAddr(H))
        await waitFor(() => A.peers().includes(H.peerId) && B.peers().includes(H.peerId), 20000, 'sessions')
        await waitFor(() => [H, A, B].every(n => n.host()?.peerId === H.peerId), 20000, 'H is the host')
        H.setVoice({ inVoice: true })
        B.setVoice({ inVoice: true })
        await waitFor(() => H.voiceStats().streams === 1, 15000, 'stream of B on H')
        const got = []
        B.events.on('voice-frame', f => { if (f.origin === A.peerId) got.push({ seq: f.seq, at: performance.now() }) })
        const t0 = performance.now()
        A.setVoice({ inVoice: true })
        // Send frames as the app does: one frame each 20 ms from the click of Join voice.
        let sent = 0
        const timer = setInterval(() => { A.sendVoiceFrame(new Uint8Array([sent & 255, 1, 2, 3])); sent++ }, FRAME_MS)
        A.sendVoiceFrame(new Uint8Array([sent & 255, 1, 2, 3])); sent++
        await waitFor(() => got.length > 0 || performance.now() - t0 > 6000, 8000, 'first frame or 6 s')
        await sleep(1000)
        clearInterval(timer)
        await sleep(300)
        const first = got[0]
        const seqs = got.map(g => g.seq)
        return { startMs: first ? first.at - t0 : Infinity, firstSeq: first?.seq ?? null, seqs, sent }
    } finally {
        for (const n of nodes.reverse()) await n.stop().catch(() => {})
    }
}

test('voice start: the other member gets the frames of A soon after Join voice, with no gap (127.0.0.1)', { timeout: 180000 }, async () => {
    const runs = []
    for (let i = 0; i < 5; i++) runs.push(await oneRun())
    const starts = runs.map(r => r.startMs).sort((a, b) => a - b)
    const median = starts[Math.floor(starts.length / 2)]
    console.log(`voice start (127.0.0.1): median ${median.toFixed(1)} ms, runs ${runs.map(r => `${r.startMs.toFixed(1)} ms first seq ${r.firstSeq} got ${r.seqs.length}/${r.sent}`).join('; ')}`)
    for (const r of runs) {
        assert.equal(r.firstSeq, 0, 'B gets the first frame of A (sent at Join voice)')
        // After the stream opens, each frame arrives (no gap in the sequence numbers).
        for (let i = 1; i < r.seqs.length; i++) assert.equal(r.seqs[i], r.seqs[i - 1] + 1, `no gap after seq ${r.seqs[i - 1]}`)
    }
    assert.ok(median <= START_LIMIT_MS, `median start ${median.toFixed(1)} ms is at most ${START_LIMIT_MS} ms`)
})
