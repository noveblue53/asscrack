import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { identify } from '@libp2p/identify'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { multiaddr } from '@multiformats/multiaddr'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

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

function assertRelayed(x, y) {
    const conns = x.libp2p.getConnections().filter(c => c.remotePeer.toString() === y.peerId)
    assert.ok(conns.length > 0, 'a connection exists')
    for (const c of conns) assert.ok(c.remoteAddr.toString().includes('/p2p-circuit'), `connection ${c.remoteAddr} is relayed`)
}

// R (full node), A and B (relayOnly) with one room key. A and B have a session through R.
async function relayRoom(nodes, extra = {}) {
    const room = `rp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roomKey = newRoomKey()
    const R = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, ...fast })
    nodes.push(R)
    const A = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast, ...(extra.A ?? {}) })
    nodes.push(A)
    const B = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast, ...(extra.B ?? {}) })
    nodes.push(B)
    await A.connect(localAddr(R))
    await B.connect(localAddr(R))
    await waitFor(() => A.peers().includes(B.peerId) && B.peers().includes(A.peerId), 20000, 'A-B session through R')
    assertRelayed(A, B)
    assertRelayed(B, A)
    return { room, roomKey, R, A, B }
}

test('history: a late relay-only member gets the earlier lines through R', { timeout: 60000 }, async () => {
    const nodes = []
    try {
        const { room, roomKey, R, A, B } = await relayRoom(nodes)
        A.send('one')
        await sleep(20)
        B.send('two')
        await sleep(20)
        A.send('three')
        await waitFor(() => [R, A, B].every(n => n.history().length === 3), 10000, 'three lines everywhere')
        // R is the host after the first election (rule 7). The host sends the history to a new member.
        await waitFor(() => R.isHost() && A.host()?.peerId === R.peerId && B.host()?.peerId === R.peerId, 15000, 'R is host')
        const C = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast })
        nodes.push(C)
        await C.connect(localAddr(R))
        await waitFor(() => [R, A, B].every(n => C.peers().includes(n.peerId)), 20000, 'C sessions with R, A and B')
        assertRelayed(C, A)
        assertRelayed(C, B)
        await waitFor(() => C.history().length >= 3, 10000, 'C gets the history')
        await sleep(500)
        const texts = C.history().map(m => m.text)
        assert.deepEqual(texts, ['one', 'two', 'three'])
        assert.equal(new Set(C.history().map(m => m.id)).size, C.history().length, 'no duplicates')
    } finally {
        await stopAll(nodes)
    }
})

test('voice signal: voice state and signal go from A to B through R', { timeout: 60000 }, async () => {
    const nodes = []
    try {
        const { A, B } = await relayRoom(nodes)
        const states = []
        const signals = []
        B.events.on('voice-state', e => { if (e.peerId === A.peerId) states.push(e) })
        B.events.on('signal', e => signals.push(e))
        A.setVoice({ inVoice: true, streamId: 'stream-r' })
        assert.equal(A.sendTo(B.peerId, { type: 'signal', data: { sdp: 'offer', n: 1 } }), true)
        await waitFor(() => states.some(s => s.inVoice) && signals.length === 1, 10000, 'B gets voice state and signal')
        const s = states.find(x => x.inVoice)
        assert.equal(s.streamId, 'stream-r')
        assert.deepEqual(signals, [{ peerId: A.peerId, data: { sdp: 'offer', n: 1 } }])
        assertRelayed(A, B)
    } finally {
        await stopAll(nodes)
    }
})

test('file transfer: 3 MiB from A to B through R with the same SHA-256', { timeout: 90000 }, async () => {
    const nodes = []
    const dirs = []
    try {
        const src = await fsp.mkdtemp(path.join(os.tmpdir(), 'asscrack-rp-src-'))
        const dlA = await fsp.mkdtemp(path.join(os.tmpdir(), 'asscrack-rp-a-'))
        const dlB = await fsp.mkdtemp(path.join(os.tmpdir(), 'asscrack-rp-b-'))
        dirs.push(src, dlA, dlB)
        const { A, B } = await relayRoom(nodes, { A: { downloadDir: dlA }, B: { downloadDir: dlB } })
        const SIZE = 3 * 1024 * 1024
        const data = randomBytes(SIZE)
        const file = path.join(src, 'relay.bin')
        await fsp.writeFile(file, data)
        const want = createHash('sha256').update(data).digest('hex')
        const done = []
        const failed = []
        B.events.on('file-offer', ({ offerId }) => B.acceptFile(offerId))
        B.events.on('file-done', e => done.push(e))
        B.events.on('file-failed', e => failed.push(e))
        const t0 = Date.now()
        const offer = await A.offerFile(file)
        assert.equal(offer.peers, 2, 'R and B get the offer')
        await waitFor(() => done.length === 1 || failed.length > 0, 60000, 'B gets the file')
        const ms = Date.now() - t0
        assert.deepEqual(failed, [])
        assert.equal(done[0].direction, 'receive')
        assert.equal(path.dirname(done[0].path), dlB)
        const got = createHash('sha256').update(await fsp.readFile(done[0].path)).digest('hex')
        assert.equal(got, want)
        assert.equal(offer.sha256, want)
        console.log(`127.0.0.1 relay file: 3 MiB in ${ms} ms, ${(SIZE / 1048576 / (ms / 1000)).toFixed(2)} MiB/s`)
        assertRelayed(A, B)
    } finally {
        await stopAll(nodes)
        await Promise.allSettled(dirs.map(d => fsp.rm(d, { recursive: true, force: true })))
    }
})

test('gater: a peer with no session gets no reservation on R; A has one', { timeout: 60000 }, async () => {
    const nodes = []
    let X
    try {
        const { R, A } = await relayRoom(nodes)
        X = await createLibp2p({
            addresses: { listen: [] },
            transports: [tcp(), circuitRelayTransport()],
            services: { identify: identify() },
            connectionManager: { minConnections: 0 },
            streamMuxers: [yamux()],
            connectionEncryption: [noise()]
        })
        await X.start()
        await X.dial(multiaddr(localAddr(R)))
        await sleep(500)
        let reserved = true
        try {
            await X.components.transportManager.listen([multiaddr(`${localAddr(R)}/p2p-circuit`)])
            reserved = X.getMultiaddrs().some(m => m.toString().includes('/p2p-circuit'))
        } catch {
            reserved = false
        }
        assert.equal(reserved, false, 'X has no reservation on R')
        assert.ok(!R.peers().includes(X.peerId.toString()), 'R has no session with X')
        await waitFor(() => A.getMultiaddrs().some(m => m.includes('/p2p-circuit') && m.includes(R.peerId)), 10000, 'A has a reservation on R')
    } finally {
        if (X) await X.stop().catch(() => {})
        await stopAll(nodes)
    }
})
