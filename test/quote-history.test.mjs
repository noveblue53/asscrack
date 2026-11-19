// A quote is one ordinary chat message. These tests send quotes through the chat and history code of
// src/network (not changed by milestone 2) and read them live and after a history replay. 127.0.0.1 only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'

const source = await readFile(new URL('../src/application/quote.js', import.meta.url), 'utf8')
const context = { window: {} }
vm.createContext(context)
vm.runInContext(source, context, { filename: 'quote.js' })
const q = context.window.quoteCore

const base = {
    room: 'quote', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false,
    heartbeatInterval: 300, hostTimeout: 1500, electionDelay: 1000
}

async function makeNodes(names) {
    const nodes = []
    for (const name of names) nodes.push(await createAsscrackNode({ ...base, name }))
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

test('a quote of a repeated name is read live, and after a host change and a replay with the original evicted', { timeout: 60000 }, async () => {
    // Two users have the display name Sam.
    const nodes = await makeNodes(['Sam', 'Sam', 'Ann'])
    try {
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        const [samA, samB, ann] = nodes
        const original = 'the original line\r\nwith a second line'
        samA.send(original)
        await waitUntil(() => nodes.every(n => n.history().length === 1), 5000)
        const originalId = samB.history()[0].id
        // Sam B quotes the line of Sam A. The names repeat, thus the header has the tag of Sam A.
        const quote = q.makeQuote({
            from: 'Sam', peerId: samA.peerId, repeats: q.nameRepeats('Sam', ['Sam', 'Sam', 'Ann']), clock: '14:05', text: original
        })
        const text = q.compose(quote, 'my reply\r\nwith two lines')
        assert.equal(text, `> Sam (${q.peerTag(samA.peerId)}) at 14:05, 2 lines:\n> the original line\n> with a second line\nmy reply\nwith two lines`)
        assert.notEqual(q.peerTag(samA.peerId), q.peerTag(samB.peerId))
        // 199 lines after the original: with the quote, the history (200 lines) evicts the original.
        for (let i = 0; i < 199; i++) ann.send(`filler ${i}`)
        await waitUntil(() => nodes.every(n => n.history().length === 200), 15000)
        const live = []
        for (const n of [samA, ann]) n.events.on('message', m => { if (m.text === text) live.push({ at: n.peerId, ...m }) })
        assert.equal(samB.send(text), 2)
        await waitUntil(() => live.length === 2, 5000)
        for (const m of live) {
            assert.equal(m.text, text, 'live: the text is the same')
            assert.equal(m.from, 'Sam')
            assert.equal(m.peerId, samB.peerId, 'live: the peer ID gives the right Sam')
        }
        for (const n of nodes) {
            assert.equal(n.history().length, 200)
            assert.equal(n.history().some(m => m.id === originalId), false, 'the original is evicted')
        }

        // The host stops. A late member gets the history from the new host.
        const oldHost = nodes.find(n => n.isHost())
        const others = nodes.filter(n => n !== oldHost)
        await oldHost.stop()
        await waitUntil(() => agree(others) && others[0].host().peerId !== oldHost.peerId, 10000)
        const [late] = await makeNodes(['Late'])
        nodes.push(late)
        for (const n of others) await connectPair(late, n)
        await waitUntil(() => late.history().some(m => m.text === text), 10000)
        const replayed = late.history().find(m => m.text === text)
        assert.equal(replayed.from, 'Sam')
        assert.equal(late.history().some(m => m.id === originalId), false)
        // The replayed text still names the quoted Sam and gives the excerpt.
        const parts = q.split(replayed.text)
        assert.ok(parts)
        assert.deepEqual(JSON.parse(JSON.stringify(q.parseHeader(parts.quote.split('\n')[0]))),
            { from: 'Sam', tag: q.peerTag(samA.peerId), clock: '14:05' })
        assert.equal(parts.rest, 'my reply\nwith two lines')
    } finally {
        await stopAll(nodes)
    }
})

test('a quote sent with zero peers goes in the local history and a later member gets it in a replay', { timeout: 30000 }, async () => {
    const nodes = await makeNodes(['Ann', 'Bob'])
    try {
        const texts = nodes.map((n, i) => {
            n.send(`own line ${i}`)
            const text = q.compose(q.makeQuote({ from: n.name, clock: '08:00', text: `own line ${i}` }), `reply ${i}`)
            assert.equal(n.send(text), 0, 'no peer: the send reaches 0 sessions')
            assert.ok(n.history().some(m => m.text === text), 'the quote is in the local history')
            return text
        })
        await connectPair(nodes[0], nodes[1])
        await waitUntil(() => agree(nodes), 5000)
        const hostIndex = nodes.findIndex(n => n.isHost())
        const member = nodes[1 - hostIndex]
        await waitUntil(() => member.history().some(m => m.text === texts[hostIndex]), 5000)
        const got = member.history().find(m => m.text === texts[hostIndex])
        assert.equal(got.from, nodes[hostIndex].name)
        assert.equal(q.split(got.text).rest, `reply ${hostIndex}`)
    } finally {
        await stopAll(nodes)
    }
})
