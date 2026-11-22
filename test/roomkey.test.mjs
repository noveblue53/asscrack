import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { multiaddr } from '@multiformats/multiaddr'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await new Promise(r => setTimeout(r, 20))
    }
    throw new Error(`timeout: ${what}`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function localAddr(n) {
    const a = n.getMultiaddrs().find(m => m.startsWith('/ip4/127.0.0.1/') && !m.includes('p2p-circuit'))
    assert.ok(a, 'node has a 127.0.0.1 address')
    return a
}

async function stopAll(nodes) {
    await Promise.allSettled(nodes.filter(Boolean).map(n => n.stop()))
}

test('keyed room: relay chat works with key K; a wrong key gets no session and no reservation', { timeout: 60000 }, async () => {
    const room = `key-${Date.now()}`
    const K = newRoomKey()
    const nodes = []
    try {
        const R = await createAsscrackNode({ room, roomKey: K, listen: LOCAL, discovery: false, fullNode: true, ...fast })
        nodes.push(R)
        const A = await createAsscrackNode({ room, roomKey: K, relayOnly: true, fullNode: false, ...fast })
        nodes.push(A)
        const B = await createAsscrackNode({ room, roomKey: K, relayOnly: true, fullNode: false, ...fast })
        nodes.push(B)
        assert.equal(R.roomKey(), K)
        await A.connect(localAddr(R))
        await B.connect(localAddr(R))
        await waitFor(() => A.peers().includes(B.peerId) && B.peers().includes(A.peerId), 20000, 'A-B session through R')
        const got = []
        B.events.on('message', m => got.push(m))
        A.send('hello through R')
        await waitFor(() => got.length === 1, 5000, 'B gets the line')
        assert.equal(got[0].text, 'hello through R')
        assert.equal(got[0].peerId, A.peerId)

        const W = await createAsscrackNode({ room, roomKey: newRoomKey(), relayOnly: true, fullNode: false, ...fast })
        nodes.push(W)
        await W.connect(localAddr(R)).catch(() => {})
        await sleep(3000)
        assert.ok(!R.peers().includes(W.peerId), 'R has no session with W')
        assert.deepEqual(W.peers(), [])
        assert.ok(!A.peers().includes(W.peerId) && !B.peers().includes(W.peerId), 'A and B do not show W')
        assert.ok(!Object.values(A.topology().links).flat().includes(W.peerId), 'W is not in the topology of A')
        // W tries a reservation on R. The gater of R refuses it.
        let reserved = true
        try {
            await W.libp2p.components.transportManager.listen([multiaddr(`${localAddr(R)}/p2p-circuit`)])
            reserved = W.libp2p.getMultiaddrs().some(m => m.toString().includes('/p2p-circuit'))
        } catch {
            reserved = false
        }
        assert.equal(reserved, false, 'W has no reservation on R')
    } finally {
        await stopAll(nodes)
    }
})

test('a keyed node and a node with no key in the same room get no session', { timeout: 30000 }, async () => {
    const room = `mixed-${Date.now()}`
    const nodes = []
    try {
        const K = await createAsscrackNode({ room, roomKey: newRoomKey(), listen: LOCAL, discovery: false, ...fast })
        nodes.push(K)
        const L = await createAsscrackNode({ room, listen: LOCAL, discovery: false, ...fast })
        nodes.push(L)
        await L.connect(localAddr(K)).catch(() => {})
        await sleep(3000)
        assert.deepEqual(K.peers(), [])
        assert.deepEqual(L.peers(), [])
    } finally {
        await stopAll(nodes)
    }
})

test('two LAN nodes with no key get a session with an old-style hello', { timeout: 30000 }, async () => {
    const room = `lan-${Date.now()}`
    const nodes = []
    try {
        const A = await createAsscrackNode({ room, name: 'alpha', listen: LOCAL, discovery: false, ...fast })
        nodes.push(A)
        const B = await createAsscrackNode({ room, name: 'beta', listen: LOCAL, discovery: false, ...fast })
        nodes.push(B)
        assert.equal(A.roomKey(), null)
        assert.equal(A.invite(), null)
        await B.connect(localAddr(A))
        await waitFor(() => A.peers().includes(B.peerId) && B.peers().includes(A.peerId), 5000, 'session')
        await waitFor(() => A.peerNames()[B.peerId] === 'beta', 5000, 'name from hello')
    } finally {
        await stopAll(nodes)
    }
})

test('store: A joins R again after a restart with no connect()', { timeout: 60000 }, async () => {
    const room = `store-${Date.now()}`
    const key = newRoomKey()
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-store-'))
    const storePath = path.join(dir, 'room.json')
    const nodes = []
    try {
        // R listens on a free port first; then a second R with the same port announces it.
        const probe = await createAsscrackNode({ room, roomKey: key, listen: LOCAL, discovery: false, ...fast })
        const addr = localAddr(probe).replace(/\/p2p\/.*$/, '')
        await probe.stop()
        const R = await createAsscrackNode({ room, roomKey: key, listen: [addr], announce: [addr], discovery: false, fullNode: true, ...fast })
        nodes.push(R)
        // L1 (P10a): allowPrivateFullNode, because the address of R is a 127.0.0.1 address.
        let A = await createAsscrackNode({ room, roomKey: key, relayOnly: true, fullNode: false, storePath, allowPrivateFullNode: true, ...fast })
        nodes.push(A)
        const seen = []
        A.events.on('full-node-addrs', e => seen.push(e))
        await A.connect(localAddr(R))
        await waitFor(() => seen.length === 1, 5000, 'A learns R addrs')
        assert.deepEqual(seen[0], { peerId: R.peerId, addrs: [addr] })
        assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')), { fullNodes: { [R.peerId]: [addr] } })
        const code = A.invite()
        assert.ok(code.startsWith('asscrack1:'))
        await A.stop()
        await waitFor(() => !R.peers().includes(A.peerId), 5000, 'R sees A leave')

        A = await createAsscrackNode({ room, roomKey: key, relayOnly: true, fullNode: false, storePath, allowPrivateFullNode: true, ...fast })
        nodes.push(A)
        await waitFor(() => A.peers().includes(R.peerId) && R.peers().includes(A.peerId), 10000, 'A joins R from the store')
    } finally {
        await stopAll(nodes)
        rmSync(dir, { recursive: true, force: true })
    }
})
