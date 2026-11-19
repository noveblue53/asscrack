import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { multiaddr } from '@multiformats/multiaddr'
import { createAsscrackNode, CHAT_PROTOCOL } from '../src/network/node.mjs'
import { createHistory } from '../src/network/history.mjs'
import { createChatSession } from '../src/network/chat-session.mjs'

const base = {
    room: 'history', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false,
    heartbeatInterval: 300, hostTimeout: 1500, electionDelay: 1000
}

async function makeNodes(count) {
    const nodes = []
    for (let i = 0; i < count; i++) nodes.push(await createAsscrackNode(base))
    return nodes
}

async function waitUntil(check, limit) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        if (check()) return
        await delay(50)
    }
    assert.ok(check(), `Condition not true within ${limit} ms`)
}

async function connectPair(a, b) {
    await a.connect(b.getMultiaddrs()[0])
    await waitUntil(() => a.peers().includes(b.peerId) && b.peers().includes(a.peerId), 5000)
}

async function mesh(nodes) {
    for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++) await connectPair(nodes[i], nodes[j])
}

function agree(nodes) {
    const first = nodes[0].host()
    if (first === null) return false
    return nodes.every(n => n.host()?.peerId === first.peerId && n.host()?.term === first.term)
}

async function stopAll(nodes) {
    await Promise.allSettled(nodes.map(n => n.stop()))
}

function noDuplicates(list) {
    return new Set(list.map(m => m.id)).size === list.length
}

async function sendThree(nodes) {
    nodes[0].send('one')
    await delay(5)
    nodes[1].send('two')
    await delay(5)
    nodes[0].send('three')
    await waitUntil(() => nodes.every(n => n.history().length === 3), 5000)
}

test('a: a late member gets the history from the host', { timeout: 30000 }, async () => {
    const nodes = await makeNodes(3)
    try {
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        await sendThree(nodes)
        const hostNode = nodes.find(n => n.isHost())
        const d = (await makeNodes(1))[0]
        nodes.push(d)
        const t0 = Date.now()
        for (const n of nodes.slice(0, 3)) await connectPair(d, n)
        await waitUntil(() => d.history().length === 3, 5000)
        console.log(`test a: ${Date.now() - t0} ms`)
        await delay(500)
        assert.deepEqual(d.history().map(m => m.id), hostNode.history().map(m => m.id))
        assert.ok(noDuplicates(d.history()))
        assert.equal(d.history().length, 3)
    } finally {
        await stopAll(nodes)
    }
})

test('b: after a failover, the new host gives the history', { timeout: 40000 }, async () => {
    const nodes = await makeNodes(3)
    try {
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        await sendThree(nodes)
        const old = nodes.find(n => n.isHost())
        const others = nodes.filter(n => n !== old)
        await old.stop()
        await waitUntil(() => agree(others) && others[0].host().peerId !== old.peerId, 10000)
        const d = (await makeNodes(1))[0]
        nodes.push(d)
        const t0 = Date.now()
        for (const n of others) await connectPair(d, n)
        await waitUntil(() => d.history().length === 3, 10000)
        console.log(`test b: ${Date.now() - t0} ms`)
        await delay(500)
        assert.equal(d.history().length, 3)
        assert.ok(noDuplicates(d.history()))
        assert.deepEqual(d.history().map(m => m.id), others[0].history().map(m => m.id))
    } finally {
        await stopAll(nodes)
    }
})

test('c: a buffer that gets 250 messages keeps the last 200', () => {
    const t0 = Date.now()
    const h = createHistory(200)
    for (let i = 0; i < 250; i++) h.add({ id: `m${String(i).padStart(3, '0')}`, from: 'x', text: `t${i}`, time: 1000 + i })
    const list = h.list()
    console.log(`test c: ${Date.now() - t0} ms`)
    assert.equal(list.length, 200)
    assert.equal(list[0].text, 't50')
    assert.equal(list[199].text, 't249')
})

test('d: a chat line with no id gives a message event with an id', { timeout: 15000 }, async () => {
    const nodes = await makeNodes(2)
    let raw = null
    try {
        const [a, b] = nodes
        const t0 = Date.now()
        const got = new Promise(resolve => b.events.once('message', resolve))
        const stream = await a.libp2p.dialProtocol(multiaddr(b.getMultiaddrs()[0]), CHAT_PROTOCOL)
        raw = createChatSession(stream, { onMessage: () => {} })
        raw.send(JSON.stringify({ from: 'old', text: 'hello', time: Date.now() }))
        const message = await got
        console.log(`test d: ${Date.now() - t0} ms`)
        assert.equal(typeof message.id, 'string')
        assert.ok(message.id.length > 0)
        assert.equal(message.text, 'hello')
        assert.equal(b.history().length, 1)
        assert.equal(b.history()[0].id, message.id)
    } finally {
        raw?.done.catch(() => {})
        raw?.close()
        await stopAll(nodes)
    }
})

test('e: a member with a session before the first election gets the history', { timeout: 30000 }, async () => {
    const nodes = await makeNodes(2)
    try {
        // Each node has a line that the other node does not have. No host exists yet.
        nodes[0].send('solo zero')
        nodes[1].send('solo one')
        await connectPair(nodes[0], nodes[1])
        assert.equal(nodes[0].host(), null)
        await waitUntil(() => agree(nodes), 5000)
        const hostNode = nodes.find(n => n.isHost())
        const member = nodes.find(n => !n.isHost())
        const hostLine = hostNode.history().find(m => m.text.startsWith('solo'))
        await waitUntil(() => member.history().some(m => m.id === hostLine.id), 5000)
        await delay(500)
        assert.ok(noDuplicates(member.history()))
        assert.equal(member.history().length, 2)
    } finally {
        await stopAll(nodes)
    }
})
