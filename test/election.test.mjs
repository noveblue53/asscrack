import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { createElection } from '../src/network/election.mjs'

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
    // Make 4 nodes and keep the node with the lowest peer ID apart. Its ID is then lower than the ID of each host
    // that the other 3 nodes can elect. A search for a lower random ID can fail (2026-11-19: 200 tries failed).
    const all = (await makeNodes(4)).sort((a, b) => (a.peerId < b.peerId ? -1 : 1))
    const d = all[0]
    const nodes = all.slice(1)
    try {
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        const elected = nodes[0].host()
        const hostNode = nodes.find(n => n.isHost())
        assert.ok(d.peerId < elected.peerId)
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
        await stopAll(all)
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

test('127.0.0.1: an isolated member rejoins the full host without changing its term', { timeout: 30000 }, async t => {
    const timing = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
    const a = await createAsscrackNode({ ...base, ...timing, fullNode: true })
    const nodes = [a]
    t.after(() => stopAll(nodes))
    nodes.push(...await makeNodes(2, { ...timing, fullNode: false }))
    // When the host connection drops first, C must wait for B while their relay session tears down.
    const [b, c] = nodes.slice(1).sort((x, y) => x.peerId < y.peerId ? -1 : 1)
    await connectPair(b, a)
    await connectPair(c, a)
    await waitUntil(() => agree(nodes) && b.peers().includes(c.peerId) && c.peers().includes(b.peerId), 10000)
    const elected = a.host()
    assert.equal(elected.peerId, a.peerId)
    const changes = new Map(nodes.map(n => [n, []]))
    for (const n of nodes) n.events.on('host-changed', h => changes.get(n).push(h.peerId))

    // Block automatic dials while the interface is down, then cut both C's TCP and relay connections.
    let isolated = true
    const gater = c.libp2p.components.connectionGater
    const { denyDialMultiaddr, denyInboundConnection } = gater
    gater.denyDialMultiaddr = () => isolated
    gater.denyInboundConnection = () => isolated
    t.after(() => Object.assign(gater, { denyDialMultiaddr, denyInboundConnection }))
    for (const conn of c.libp2p.getConnections()) conn.abort(new Error('simulated network loss'))
    await waitUntil(() => c.peers().length === 0 && !a.peers().includes(c.peerId) && !b.peers().includes(c.peerId), 5000)
    await delay(timing.hostTimeout + timing.heartbeatInterval)
    assert.equal(c.host(), null, 'C waits without a host throughout isolation')

    isolated = false
    await connectPair(c, a)
    await waitUntil(() => agree(nodes), 5000)
    assert.deepEqual(a.host(), elected)
    assert.deepEqual(changes.get(a), [])
    assert.deepEqual(changes.get(b), [])
    assert.deepEqual(changes.get(c), [null, a.peerId])
})

// Unit tests of the rank (createElection with fake timers and fake send functions).

function unit(selfId, peers, full) {
    const sent = []
    let open = [...peers]
    const e = createElection({
        selfId,
        sendTo: (p, l) => sent.push([p, l]),
        broadcast: l => sent.push(['*', l]),
        openPeers: () => open,
        isFullNode: id => full.includes(id)
    })
    e.start()
    return { e, sent, setOpen: v => { open = v } }
}

test('a member with zero sessions waits for the live host announcement after reconnect', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const c = unit('c', ['a'], ['a'])
    t.after(() => c.e.stop())
    c.e.sessionOpened('a')
    c.e.handleAnnouncement('a', { host: 'a', term: 1 })
    c.setOpen([])
    c.e.sessionClosed('a')
    t.mock.timers.tick(10000)
    assert.equal(c.e.host(), null)
    // Rejoin through a member that ranks below C. Even here, C must allow a fresh election delay.
    c.setOpen(['z'])
    c.e.sessionOpened('z')
    t.mock.timers.tick(1000)
    assert.equal(c.e.host(), null)
    assert.deepEqual(c.sent, [])
    // L6 (P10a): C does not accept the announcement of the host 'a' from the member 'z'. Only 'a' announces itself.
    c.e.handleAnnouncement('z', { type: 'host', host: 'a', term: 1 })
    assert.equal(c.e.host(), null)
    c.setOpen(['z', 'a'])
    c.e.sessionOpened('a')
    c.e.handleAnnouncement('a', { type: 'host', host: 'a', term: 1 })
    assert.deepEqual(c.e.host(), { peerId: 'a', term: 1 })
})

test('a member briefly elected during relay loss waits after the last circuit closes', t => {
    const { e, sent, setOpen } = unit('a', ['h', 'z'], ['h', 'r'])
    t.after(() => e.stop())
    e.sessionOpened('h')
    e.sessionOpened('z')
    e.handleAnnouncement('h', { host: 'h', term: 1 })

    // The direct session to the only full node closes before the remaining circuit.
    setOpen(['z'])
    e.sessionClosed('h')
    assert.deepEqual(e.host(), { peerId: 'a', term: 2 })
    setOpen([])
    e.sessionClosed('z')
    assert.equal(e.host(), null)

    const priorAnnouncements = sent.length
    setOpen(['r'])
    e.sessionOpened('r')
    assert.equal(sent.length, priorAnnouncements, 'the isolated member cannot announce itself as the incumbent')
    e.handleAnnouncement('r', { host: 'r', term: 1 })
    assert.deepEqual(e.host(), { peerId: 'r', term: 1 })
})

test('protected election accepts only live authorized peers announcing their own host authority', t => {
    const announced = []
    const election = createElection({ selfId: 'a', sendTo: (_peer, line) => announced.push(line), broadcast: () => {},
        openPeers: () => ['b', 'h'], hostAllowed: id => id === 'h' })
    t.after(() => election.stop())
    election.handleAnnouncement('b', { host: 'b', term: 1 })
    election.handleAnnouncement('b', { host: 'h', term: 1 })
    assert.equal(election.host(), null)
    election.handleAnnouncement('h', { host: 'h', term: Number.MAX_SAFE_INTEGER })
    assert.equal(election.host(), null)
    election.handleAnnouncement('h', { host: 'h', term: 1 })
    assert.deepEqual(election.host(), { peerId: 'h', term: 1 })
    election.sessionOpened('b')
    assert.deepEqual(announced, [])
})

test('rank: the only full node (highest ID) becomes host in the first election', () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    try {
        const ids = ['a', 'b', 'c']
        const units = ids.map(id => unit(id, ids.filter(x => x !== id), ['c']))
        units.forEach((u, i) => ids.forEach(p => { if (p !== ids[i]) u.e.sessionOpened(p) }))
        mock.timers.tick(3500)
        assert.equal(units[2].e.isHost(), true)
        assert.equal(units[0].e.isHost(), false)
        assert.equal(units[1].e.isHost(), false)
        for (const u of units) u.e.stop()
    } finally {
        mock.timers.reset()
    }
})

test('rank: on failover the full node, not the lower ID, is the next host', () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    try {
        // Self is 'c' (full node). Candidates after the host 'a' goes away: 'b' and 'c'.
        const c = unit('c', ['a', 'b'], ['c'])
        c.e.sessionOpened('a')
        c.e.sessionOpened('b')
        c.e.handleAnnouncement('a', { host: 'a', term: 1 })
        c.setOpen(['b'])
        c.e.sessionClosed('a')
        assert.equal(c.e.isHost(), true)
        assert.deepEqual(c.e.host(), { peerId: 'c', term: 2 })
        // Self is 'b' (not a full node). It waits for 'c' and does not elect itself.
        const b = unit('b', ['a', 'c'], ['c'])
        b.e.sessionOpened('a')
        b.e.sessionOpened('c')
        b.e.handleAnnouncement('a', { host: 'a', term: 1 })
        b.setOpen(['c'])
        b.e.sessionClosed('a')
        assert.equal(b.e.isHost(), false)
        b.e.handleAnnouncement('c', { host: 'c', term: 2 })
        assert.deepEqual(b.e.host(), { peerId: 'c', term: 2 })
        c.e.stop()
        b.e.stop()
    } finally {
        mock.timers.reset()
    }
})

test('rank: a full node that opens a session after a host is live does not become host', () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    try {
        const z = unit('z', ['a'], ['z'])
        z.e.sessionOpened('a')
        z.e.handleAnnouncement('a', { host: 'a', term: 1 })
        for (let i = 0; i < 10; i++) {
            mock.timers.tick(1000)
            z.e.handleAnnouncement('a', { host: 'a', term: 1 })
        }
        assert.equal(z.e.isHost(), false)
        assert.deepEqual(z.e.host(), { peerId: 'a', term: 1 })
        z.e.stop()
    } finally {
        mock.timers.reset()
    }
})

test('rank: with no full node the lowest ID becomes host', () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    try {
        const ids = ['a', 'b', 'c']
        const units = ids.map(id => unit(id, ids.filter(x => x !== id), []))
        units.forEach((u, i) => ids.forEach(p => { if (p !== ids[i]) u.e.sessionOpened(p) }))
        mock.timers.tick(3500)
        assert.deepEqual(units.map(u => u.e.isHost()), [true, false, false])
        for (const u of units) u.e.stop()
    } finally {
        mock.timers.reset()
    }
})

// L6 (P10a): in a legacy room (no hostAllowed), any member could send a host line for any ID and any integer term.
// A term of 1e300 made the term fixed, and a member kept a host that is not a peer. The fix applies the host rules of a
// protected room: the sender announces only itself, with a safe-integer term.
test('L6: a legacy election refuses a host line for another ID and a term that is not a safe integer', t => {
    const { e, sent } = unit('m', ['b', 'x'], [])
    t.after(() => e.stop())
    e.sessionOpened('b')
    e.handleAnnouncement('b', { host: '1', term: 1e300 })
    e.handleAnnouncement('b', { host: 'x', term: 5 })
    assert.equal(e.host(), null)
    e.handleAnnouncement('b', { host: 'b', term: 1e300 })
    e.handleAnnouncement('b', { host: 'b', term: Number.MAX_SAFE_INTEGER })
    e.handleAnnouncement('b', { host: 'b', term: 0 })
    assert.equal(e.host(), null)
    e.handleAnnouncement('b', { host: 'b', term: 3 })
    assert.deepEqual(e.host(), { peerId: 'b', term: 3 })
    // A member does not send the announcement of another host on a new session.
    e.sessionOpened('x')
    assert.deepEqual(sent.filter(([peer]) => peer === 'x'), [])
})

test('L6: 127.0.0.1: a live line in a legacy room shows the name of the session, not its from field', { timeout: 20000 }, async () => {
    const roomKey = (await import('../src/network/invite.mjs')).newRoomKey()
    const bob = await createAsscrackNode({ ...base, roomKey, name: 'Bob' })
    const mallory = await createAsscrackNode({ ...base, roomKey, name: 'Mallory' })
    try {
        await connectPair(bob, mallory)
        assert.equal(mallory.sendTo(bob.peerId, { from: 'Alice', text: 'I am Alice', time: Date.now() }), true)
        await waitUntil(() => bob.history().some(m => m.text === 'I am Alice'), 5000)
        assert.equal(bob.history().find(m => m.text === 'I am Alice').from, 'Mallory')
    } finally {
        await stopAll([bob, mallory])
    }
})
