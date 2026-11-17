import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'

const base = { room: 'election', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }

async function makeNodes(count, extra = {}) {
    const nodes = []
    for (let i = 0; i < count; i++) nodes.push(await createAsscrackNode({ ...base, ...extra }))
    return nodes
}

async function connectPair(a, b) {
    const before = a.peers().length
    await a.connect(b.getMultiaddrs()[0])
    await waitUntil(() => a.peers().includes(b.peerId) && b.peers().includes(a.peerId), 5000)
    return before
}

async function mesh(nodes) {
    for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++) await connectPair(nodes[i], nodes[j])
}

async function waitUntil(check, limit) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        if (check()) return
        await delay(50)
    }
    assert.ok(check(), `Condition not true within ${limit} ms`)
}

// True when all nodes report the same host and the same term.
function agree(nodes) {
    const first = nodes[0].host()
    if (first === null) return false
    return nodes.every(n => {
        const h = n.host()
        return h !== null && h.peerId === first.peerId && h.term === first.term
    })
}

async function stopAll(nodes) {
    await Promise.allSettled(nodes.map(n => n.stop()))
}

function elapsed(start, label) {
    console.log(`${label}: ${Date.now() - start} ms`)
}

test('a+b: 3 nodes elect one host, and a 4th node does not change it', { timeout: 30000 }, async () => {
    const nodes = await makeNodes(3)
    try {
        const t0 = Date.now()
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        elapsed(t0, 'test a')
        const elected = nodes[0].host()
        assert.ok(nodes.some(n => n.isHost()))
        assert.equal(nodes.filter(n => n.isHost()).length, 1)

        const t1 = Date.now()
        const d = (await makeNodes(1))[0]
        nodes.push(d)
        for (const n of nodes.slice(0, 3)) await connectPair(d, n)
        await delay(4000)
        elapsed(t1, 'test b')
        for (const n of nodes) assert.deepEqual(n.host(), elected)
        assert.equal(d.isHost(), elected.peerId === d.peerId)
    } finally {
        await stopAll(nodes)
    }
})

test('c: a host with paused heartbeats is replaced', { timeout: 30000 }, async () => {
    const nodes = await makeNodes(3)
    try {
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        const old = nodes.find(n => n.isHost())
        const others = nodes.filter(n => n !== old)
        const t0 = Date.now()
        old.pauseHeartbeats(true)
        await waitUntil(() => agree(others) && others[0].host().peerId !== old.peerId, 10000)
        elapsed(t0, 'test c')
        for (const n of others) assert.deepEqual(n.peers().sort(), nodes.filter(x => x !== n).map(x => x.peerId).sort())
    } finally {
        await stopAll(nodes)
    }
})

test('d: a stopped host is replaced', { timeout: 30000 }, async () => {
    const nodes = await makeNodes(3)
    try {
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        const old = nodes.find(n => n.isHost())
        const others = nodes.filter(n => n !== old)
        const t0 = Date.now()
        await old.stop()
        await waitUntil(() => agree(others) && others[0].host().peerId !== old.peerId, 10000)
        elapsed(t0, 'test d')
    } finally {
        await stopAll(nodes)
    }
})

test('e: two groups merge to one host', { timeout: 30000 }, async () => {
    const nodes = await makeNodes(4)
    try {
        const g1 = nodes.slice(0, 2)
        const g2 = nodes.slice(2)
        await mesh(g1)
        await mesh(g2)
        await waitUntil(() => agree(g1) && agree(g2), 5000)
        const t0 = Date.now()
        for (const a of g1) for (const b of g2) await connectPair(a, b)
        await waitUntil(() => agree(nodes), 10000)
        elapsed(t0, 'test e')
        assert.equal(nodes.filter(n => n.isHost()).length, 1)
    } finally {
        await stopAll(nodes)
    }
})

test('f: a new node with a lower peer ID, alone for 4 s, does not take the role from a live host', { timeout: 60000 }, async () => {
    const nodes = await makeNodes(3)
    let d = null
    try {
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        const elected = nodes[0].host()
        const hostNode = nodes.find(n => n.isHost())
        // Create new nodes until one has a lower peer ID than the host. Stop the others.
        for (let i = 0; i < 200 && d === null; i++) {
            const candidate = (await makeNodes(1))[0]
            if (candidate.peerId < elected.peerId) d = candidate
            else await candidate.stop()
        }
        assert.ok(d, 'No node with a lower peer ID than the host was made')
        const t0 = Date.now()
        await delay(4000)
        assert.equal(d.host(), null)
        const members = nodes.filter(n => n !== hostNode)
        await connectPair(d, members[0])
        await delay(2000)
        for (const n of [members[1], hostNode]) await connectPair(d, n)
        await delay(4000)
        elapsed(t0, 'test f')
        for (const n of [...nodes, d]) assert.deepEqual(n.host(), elected)
        assert.equal(d.isHost(), false)
    } finally {
        if (d) nodes.push(d)
        await stopAll(nodes)
    }
})

test('g: a node alone has no host', { timeout: 15000 }, async () => {
    const nodes = await makeNodes(1)
    try {
        const t0 = Date.now()
        await delay(4000)
        elapsed(t0, 'test g')
        assert.equal(nodes[0].host(), null)
        assert.equal(nodes[0].isHost(), false)
    } finally {
        await stopAll(nodes)
    }
})
