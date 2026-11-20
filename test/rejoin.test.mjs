import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode } from '../src/network/node.mjs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeInvite, readInvite, newRoomKey } from '../src/network/invite.mjs'

// All results of this file are 127.0.0.1 results, not LAN results.
const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500, redialInterval: 500 }
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

// Get a free 127.0.0.1 TCP address (no peer ID) and a peer ID that is not in use after the call.
async function freeAddr(room, roomKey) {
    const probe = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast })
    const addr = localAddr(probe).replace(/\/p2p\/.*$/, '')
    const oldId = probe.peerId
    await probe.stop()
    return { addr, oldId }
}

function fullNodeAt(room, roomKey, addr) {
    return createAsscrackNode({ room, roomKey, listen: [addr], announce: [addr], discovery: false, fullNode: true, ...fast })
}

test('rejoin: a member finds the full node again after it starts with a new peer ID', { timeout: 60000 }, async () => {
    const room = `rejoin-${Date.now()}`
    const roomKey = newRoomKey()
    const nodes = []
    try {
        const { addr } = await freeAddr(room, roomKey)
        const A = await fullNodeAt(room, roomKey, addr)
        nodes.push(A)
        const B = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast })
        nodes.push(B)
        await B.connect(localAddr(A))
        await waitFor(() => B.peers().includes(A.peerId) && B.fullNodes().includes(A.peerId), 10000, 'B session with full node A')
        await waitFor(() => B.knownFullNodes()[A.peerId] !== undefined, 5000, 'B knows A addrs')
        await A.stop()
        await waitFor(() => !B.peers().includes(A.peerId), 10000, 'B session with A closes')
        const A2 = await fullNodeAt(room, roomKey, addr)
        nodes.push(A2)
        assert.notEqual(A2.peerId, A.peerId)
        const lines = []
        A2.events.on('message', m => lines.push(m))
        const t0 = Date.now()
        await waitFor(() => B.peers().includes(A2.peerId), 20000, 'B session with A2 in 20 s')
        console.info(`B session with A2 after ${Date.now() - t0} ms (127.0.0.1)`)
        // The node line of A2 replaces the stale entry of A (same address list).
        await waitFor(() => B.knownFullNodes()[A2.peerId] !== undefined && B.knownFullNodes()[A.peerId] === undefined, 5000, 'stale entry of A removed')
        B.send('hello A2')
        await waitFor(() => lines.some(m => m.text === 'hello A2'), 5000, 'chat line from B at A2')
    } finally {
        await stopAll(nodes)
    }
})

test('rejoin: an invite node with an old peer ID connects to the new node at that address', { timeout: 60000 }, async () => {
    const room = `rejoin-inv-${Date.now()}`
    const roomKey = newRoomKey()
    const nodes = []
    try {
        const { addr } = await freeAddr(room, roomKey)
        const original = await fullNodeAt(room, roomKey, addr)
        const oldId = original.peerId
        const originalCode = original.invite()
        await original.stop()
        const A2 = await fullNodeAt(room, roomKey, addr)
        nodes.push(A2)
        assert.notEqual(A2.peerId, oldId)
        const B = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, inviteNodes: readInvite(originalCode).nodes, ...fast })
        nodes.push(B)
        await waitFor(() => B.peers().includes(A2.peerId), 20000, 'B session with A2 from the invite')
        await waitFor(() => B.knownFullNodes()[A2.peerId] !== undefined && B.knownFullNodes()[oldId] === undefined, 5000, 'old invite entry replaced')
        const record = B.sendRecord('original invite still works')
        await waitFor(() => A2.history().some(line => line.id === record.id), 5000, 'fresh line at restarted host')
    } finally {
        await stopAll(nodes)
    }
})

test('rejoin: an invite node at the own address gives no session with self and no stop', { timeout: 30000 }, async () => {
    const room = `rejoin-self-${Date.now()}`
    const roomKey = newRoomKey()
    const nodes = []
    try {
        const { addr, oldId } = await freeAddr(room, roomKey)
        const B = await createAsscrackNode({ room, roomKey, listen: [addr], discovery: false, fullNode: false, inviteNodes: [{ id: oldId, addrs: [addr] }], ...fast })
        nodes.push(B)
        // Let the start dial and some redials run.
        await sleep(2500)
        assert.deepEqual(B.peers(), [])
        assert.ok(!B.peers().includes(B.peerId))
        assert.equal(B.send('alone'), 0)
        // The node still works: a new peer can join it.
        const C = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast })
        nodes.push(C)
        await C.connect(localAddr(B))
        await waitFor(() => B.peers().includes(C.peerId), 10000, 'C session with B')
    } finally {
        await stopAll(nodes)
    }
})


test('rejoin: pasted invite and saved hints both get a dial, even when one contains an obsolete endpoint', { timeout: 30000 }, async t => {
    const key = newRoomKey()
    const room = 'changed endpoint'
    const nodes = []
    const dir = mkdtempSync(path.join(tmpdir(), 'rejoin-'))
    t.after(async () => { await stopAll(nodes); rmSync(dir, { recursive: true, force: true }) })
    const { addr } = await freeAddr(room, key)
    const a = await fullNodeAt(room, key, addr)
    nodes.push(a)
    const { addr: retired } = await freeAddr(room, key)
    const newInvite = a.invite()
    const oldInvite = makeInvite({ room, key, nodes: [{ id: a.peerId, addrs: [retired] }] })
    const clean = await createAsscrackNode({ room, roomKey: key, inviteNodes: readInvite(oldInvite).nodes,
        relayOnly: true, fullNode: false, ...fast })
    nodes.push(clean)
    const failures = []
    clean.events.on('dial-failed', event => failures.push(event))
    await waitFor(() => failures.some(e => e.via === 'address'), 5000, 'clean member tried old endpoint with and without its ID')
    assert.deepEqual(clean.peers(), [])
    assert.equal(clean.sendRecord('waiting').accepted, 0)
    await clean.stop()
    nodes.pop()
    const storePath = path.join(dir, 'room.json')
    // First, an existing member imports the new code while the old address is in their profile.
    writeFileSync(storePath, JSON.stringify({ fullNodes: { [a.peerId]: [retired] } }))
    for (const invite of [newInvite, oldInvite]) {
        const parsed = readInvite(invite)
        const b = await createAsscrackNode({ room: parsed.room, roomKey: parsed.key, inviteNodes: parsed.nodes,
            relayOnly: true, fullNode: false, storePath, ...fast })
        nodes.push(b)
        await waitFor(() => b.fullNodes().includes(a.peerId) && a.peers().includes(b.peerId), 5000, 'authenticated connection to A')
        assert.equal(b.send('still the same room'), 1)
        assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')).fullNodes[a.peerId], [addr])
        const shared = readInvite(b.invite())
        assert.deepEqual(shared, readInvite(newInvite))
        await b.stop()
        nodes.pop()
        await waitFor(() => !a.peers().includes(b.peerId), 5000, 'peer left before next import')
        // On the second pass the working address is cached but the pasted original code is stale.
    }
})

test('rejoin: a fresh profile persists the authenticated invite endpoint for an invite-free reopen', { timeout: 30000 }, async t => {
    const key = newRoomKey()
    const room = 'saved endpoint'
    const dir = mkdtempSync(path.join(tmpdir(), 'rejoin-'))
    const storePath = path.join(dir, 'room.json')
    const nodes = []
    t.after(async () => { await stopAll(nodes); rmSync(dir, { recursive: true, force: true }) })
    const { addr } = await freeAddr(room, key)
    const a = await fullNodeAt(room, key, addr)
    nodes.push(a)
    const opts = { room, roomKey: key, relayOnly: true, fullNode: false, storePath, ...fast }
    const b = await createAsscrackNode({ ...opts, inviteNodes: readInvite(a.invite()).nodes })
    nodes.push(b)
    await waitFor(() => b.fullNodes().includes(a.peerId), 5000, 'full node from invite')
    assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')).fullNodes, { [a.peerId]: [addr] })
    await b.stop()
    nodes.pop()
    const reopened = await createAsscrackNode(opts)
    nodes.push(reopened)
    await waitFor(() => reopened.fullNodes().includes(a.peerId), 5000, 'full node from saved hints only')
    const record = reopened.sendRecord('reopened')
    await waitFor(() => a.history().some(line => line.id === record.id), 5000, 'fresh message at host')
})
