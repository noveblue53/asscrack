// Room music on real nodes (127.0.0.1, not a LAN result): the music stream of the DJ goes on its own relay
// (MUSIC_PROTOCOL), separate from voice. The host cost with 3 listeners and no direct streams, and with direct streams.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const sleep = ms => new Promise(r => setTimeout(r, ms))
// 128 kbit/s in 20 ms Opus frames.
const FRAME_BYTES = 320
const FRAMES = 250

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

// H: full node and host (not in voice). D: the DJ. A, B, C: listeners. All connect to each other directly.
async function room(nodes, options = {}) {
    const room = `mu-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roomKey = newRoomKey()
    const make = async extra => {
        const n = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, ...fast, ...options, ...extra })
        nodes.push(n)
        return n
    }
    const H = await make({ fullNode: true })
    const D = await make({ fullNode: false })
    const A = await make({ fullNode: false })
    const B = await make({ fullNode: false })
    const C = await make({ fullNode: false })
    const all = [H, D, A, B, C]
    // The direct connections first: else the sessions of the members can open on a relay circuit of H.
    for (const [x, y] of [[D, A], [D, B], [D, C], [A, B], [A, C], [B, C]]) await x.connect(localAddr(y))
    for (const n of [D, A, B, C]) await n.connect(localAddr(H))
    await waitFor(() => all.every(n => all.every(m => m === n || n.peers().includes(m.peerId))), 20000, 'full mesh of sessions')
    await waitFor(() => all.every(n => n.host()?.peerId === H.peerId), 20000, 'H is the host of all nodes')
    return { H, D, A, B, C }
}

function record(node) {
    const got = { music: [], voice: [] }
    node.events.on('music-frame', f => got.music.push(f))
    node.events.on('voice-frame', f => got.voice.push(f))
    return got
}

// One frame each 20 ms on average (the timers of Windows have steps of about 16 ms).
async function play(D, frames = FRAMES) {
    const t0 = performance.now()
    for (let i = 0; i < frames; i++) {
        assert.equal(D.sendMusicFrame(new Uint8Array(FRAME_BYTES).fill(i & 0xff)), true, `frame ${i} went out`)
        await sleep(Math.max(0, t0 + (i + 1) * 20 - performance.now()))
    }
}

test('music: the DJ stream goes on the music relay only; a non-DJ sends no music; deafen and other channels get none',
    { timeout: 120000 }, async () => {
        const nodes = []
        try {
            // All frames go through the host H here. On a direct stream a deafened member gets the frames, and its window
            // plays nothing (music.js, as voice.js for voice).
            const { H, D, A, B, C } = await room(nodes, { musicDirect: false })
            const got = { A: record(A), B: record(B), C: record(C) }
            for (const n of [D, A, B, C]) n.setVoice({ inVoice: true })
            await waitFor(() => H.musicStats().streams === 4, 15000, 'four music streams on H')
            assert.equal(A.sendMusicFrame(new Uint8Array(10)), false, 'a member that is not the DJ sends no music frame')
            assert.equal(D.sendMusicFrame(new Uint8Array(10)), false, 'no frame before the DJ has music')
            D.music.addLocal([{ title: 'test.ogg', local: 'k1' }])
            await waitFor(() => A.music.state().dj === D.peerId && B.music.state().dj === D.peerId, 5000, 'A and B see the DJ')
            assert.equal(A.music.state().now.title, 'test.ogg')
            // B deafens, C moves to a different channel (General and one more: a legacy-free keyed room has only General,
            // thus C leaves voice in place of a move).
            B.setVoice({ inVoice: true, deafened: true })
            C.setVoice({ inVoice: false })
            await sleep(600)
            const voiceBefore = got.A.voice.length
            const sendVoice = (async () => { for (let i = 0; i < 100; i++) { D.sendVoiceFrame(new Uint8Array(60)); await sleep(20) } })()
            await play(D, 100)
            await sendVoice
            await waitFor(() => got.A.music.length >= 98, 5000, 'A gets the music').catch(() => {})
            console.log(`127.0.0.1 music: A music ${got.A.music.length} voice ${got.A.voice.length - voiceBefore}, ` +
                `B music ${got.B.music.length}, C music ${got.C.music.length}`)
            assert.ok(got.A.music.length >= 98, `A got ${got.A.music.length} of 100 music frames`)
            assert.ok(got.A.music.every(f => f.origin === D.peerId && f.data.length === FRAME_BYTES), 'music frames of D')
            assert.ok(got.A.voice.length - voiceBefore >= 98, 'voice frames still arrive as voice')
            assert.ok(got.A.voice.slice(voiceBefore).every(f => f.data.length === 60), 'no music frame in the voice events')
            for (let i = 1; i < got.A.music.length; i++) assert.ok(got.A.music[i].seq > got.A.music[i - 1].seq, 'music sequence')
            assert.equal(got.B.music.length, 0, 'the host forwards no music to a deafened member')
            assert.equal(got.C.music.length, 0, 'a member out of voice gets no music')
        } finally {
            await Promise.allSettled(nodes.map(n => n.stop()))
        }
    })

test('music relay cost: 3 listeners, with and without direct streams (127.0.0.1)', { timeout: 180000 }, async () => {
    const rows = []
    for (const direct of [false, true]) {
        const nodes = []
        try {
            const { H, D, A, B, C } = await room(nodes, { musicDirect: direct })
            const got = { A: record(A), B: record(B), C: record(C) }
            for (const n of [D, A, B, C]) n.setVoice({ inVoice: true })
            await waitFor(() => H.musicStats().streams === 4, 15000, 'four music streams on H')
            if (direct) await waitFor(() => D.musicStats().directStreams === 3, 15000, 'three direct music streams of D')
            D.music.addLocal([{ title: 'test.ogg', local: 'k1' }])
            await sleep(800)
            const before = H.musicStats().forwarded
            const t0 = performance.now()
            await play(D)
            const secs = (performance.now() - t0) / 1000
            await waitFor(() => ['A', 'B', 'C'].every(k => got[k].music.length >= FRAMES - 2), 5000, 'all listeners').catch(() => {})
            const forwarded = H.musicStats().forwarded - before
            // The wire size of one forwarded frame: length (4), version (1), origin length (1), origin, sequence (4), Opus.
            const wire = 4 + 2 + Buffer.byteLength(D.peerId) + 4 + FRAME_BYTES
            const sD = D.musicStats()
            const row = { direct, secs: Math.round(secs * 10) / 10, listeners: ['A', 'B', 'C'].map(k => got[k].music.length),
                hostForwarded: forwarded, hostKbps: Math.round(forwarded * wire * 8 / secs / 1000),
                djDirectSent: sD.directSent, djKbps: Math.round(((direct ? sD.directSent : FRAMES) * wire) * 8 / secs / 1000) }
            rows.push(row)
            console.log(`127.0.0.1 music relay cost: ${JSON.stringify(row)}`)
            for (const k of ['A', 'B', 'C']) assert.ok(got[k].music.length >= FRAMES - 2, `${k} got ${got[k].music.length} of ${FRAMES}`)
            if (direct) assert.equal(forwarded, 0, 'with direct streams the host forwards no music frame')
            else assert.ok(forwarded >= 3 * (FRAMES - 2), `with no direct streams the host forwards to 3 listeners (${forwarded})`)
        } finally {
            await Promise.allSettled(nodes.map(n => n.stop()))
        }
    }
    assert.equal(rows.length, 2)
})
