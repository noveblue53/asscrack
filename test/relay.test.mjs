import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode } from '../src/network/node.mjs'

const LOCAL = ['/ip4/127.0.0.1/tcp/0']

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await new Promise(r => setTimeout(r, 20))
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

const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }

test('two relay-only nodes chat through a full node, beyond the default relay data limit', { timeout: 60000 }, async () => {
    const room = `relay-${Date.now()}`
    const nodes = []
    try {
        // R must not have the lowest peer ID. Make new nodes until that is true.
        let R, A, B
        for (let i = 0; i < 20; i++) {
            R = await createAsscrackNode({ room, listen: LOCAL, discovery: false, fullNode: true, ...fast })
            A = await createAsscrackNode({ room, relayOnly: true, fullNode: false, ...fast })
            B = await createAsscrackNode({ room, relayOnly: true, fullNode: false, ...fast })
            if (R.peerId > A.peerId || R.peerId > B.peerId) break
            await stopAll([R, A, B])
        }
        nodes.push(R, A, B)
        assert.ok(R.peerId > A.peerId || R.peerId > B.peerId, 'R is not the lowest peer ID')
        assert.equal(A.getMultiaddrs().length, 0, 'relay-only node has no listen address')

        const rAddr = localAddr(R)
        await A.connect(rAddr)
        await B.connect(rAddr)

        await waitFor(() => A.peers().includes(B.peerId) && B.peers().includes(A.peerId), 20000, 'A-B session through R')
        assert.deepEqual(A.fullNodes(), [R.peerId])
        assert.equal(R.fullNode(), true)
        assert.equal(A.fullNode(), false)

        for (const c of A.libp2p.getConnections()) {
            if (c.remotePeer.toString() === B.peerId) assert.ok(c.remoteAddr.toString().includes('/p2p-circuit'), `A-B connection ${c.remoteAddr} is relayed`)
        }

        await waitFor(() => {
            const k = A.topology().kinds[A.peerId]
            return k[B.peerId] === 'relay' && k[R.peerId] === 'mesh'
        }, 5000, 'link kinds on A')
        assert.ok(Array.isArray(A.topology().links[A.peerId]))

        // More than 128 KiB of chat lines from A to B.
        // A host replay on R's direct link can beat the original on A's relayed link.
        // 'live' counts the bytes from A. 'message' and 'history' together count the rows presented to B.
        const got = []
        const shownIds = []
        B.events.on('live', m => { if (m.peerId === A.peerId) got.push({ id: m.id, text: m.text }) })
        B.events.on('message', m => shownIds.push(m.id))
        B.events.on('history', ({ messages }) => shownIds.push(...messages.map(m => m.id)))
        const sent = []
        for (let i = 0; i < 200; i++) {
            const text = `${String(i).padStart(4, '0')}:${'x'.repeat(995)}`
            const record = A.sendRecord(text)
            assert.ok(record.accepted >= 1)
            sent.push({ id: record.id, text })
        }
        await waitFor(() => got.length >= 200, 20000, 'B gets 200 lines')
        assert.deepEqual(got, sent)
        assert.deepEqual(shownIds.sort(), sent.map(m => m.id).sort())
        assert.ok(A.peers().includes(B.peerId), 'session stays open')

        // R is the host after the first election (rule 7).
        await waitFor(() => A.host()?.peerId === R.peerId && B.host()?.peerId === R.peerId && R.isHost(), 15000, 'R is host')
    } finally {
        await stopAll(nodes)
    }
})

test("'auto' with allowPrivateFullNode makes a full node on 127.0.0.1; relayOnly does not", { timeout: 30000 }, async () => {
    const room = `auto-${Date.now()}`
    const nodes = []
    try {
        const N = await createAsscrackNode({ room, listen: LOCAL, discovery: false, allowPrivateFullNode: true, ...fast })
        nodes.push(N)
        const P = await createAsscrackNode({ room, relayOnly: true, allowPrivateFullNode: true, ...fast })
        nodes.push(P)
        assert.equal(N.fullNode(), false)
        const changes = []
        N.events.on('full-node', e => changes.push(e))
        await P.connect(localAddr(N))
        await waitFor(() => N.fullNode() === true, 10000, 'N becomes a full node')
        assert.deepEqual(changes.filter(e => e.peerId === N.peerId), [{ peerId: N.peerId, fullNode: true }])
        await waitFor(() => P.fullNodes().includes(N.peerId), 5000, 'P sees N as full node')
        await new Promise(r => setTimeout(r, 500))
        assert.equal(P.fullNode(), false)
    } finally {
        await stopAll(nodes)
    }
})

test("'auto' without allowPrivateFullNode gives no full node on 127.0.0.1", { timeout: 30000 }, async () => {
    const room = `auto-priv-${Date.now()}`
    const nodes = []
    try {
        const N = await createAsscrackNode({ room, listen: LOCAL, discovery: false, ...fast })
        nodes.push(N)
        const P = await createAsscrackNode({ room, listen: LOCAL, discovery: false, ...fast })
        nodes.push(P)
        await P.connect(localAddr(N))
        await waitFor(() => N.peers().includes(P.peerId) && P.peers().includes(N.peerId), 5000, 'session')
        await new Promise(r => setTimeout(r, 1500))
        assert.equal(N.fullNode(), false)
        assert.equal(P.fullNode(), false)
        assert.deepEqual(N.fullNodes(), [])
    } finally {
        await stopAll(nodes)
    }
})
