// A formatted quote goes through the unchanged network code with the same text (127.0.0.1 only, not LAN).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { createHistory } from '../src/network/history.mjs'

const source = await readFile(new URL('../src/application/quote.js', import.meta.url), 'utf8')
const context = { window: {} }
vm.createContext(context)
vm.runInContext(source, context, { filename: 'quote.js' })
const quoteCore = context.window.quoteCore

const base = {
    room: 'quote', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false,
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

const original = 'first line of Alice\r\n\tsecond line \u{1F600}\nthird'
const reply = 'my reply\nwith two lines \u{1F44D}'
const label = quoteCore.authorLabel('Alice', '12D3KooWabcd', 2)
const quoted = quoteCore.composeText({ label, text: original }, reply)

test('a quote goes live and by history replay to a late member with the same text', { timeout: 30000 }, async () => {
    assert.equal(quoted, `> Alice (abcd): first line of Alice second line \u{1F600} third\n${reply}`)
    const nodes = await makeNodes(2)
    try {
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        const live = []
        nodes[1].events.on('message', m => live.push(m))
        nodes[0].send(original)
        await waitUntil(() => nodes.every(n => n.history().length === 1), 5000)
        nodes[0].send(quoted)
        await waitUntil(() => live.some(m => m.text === quoted), 5000)
        await waitUntil(() => nodes.every(n => n.history().length === 2), 5000)
        assert.equal(nodes[1].history()[1].text, quoted)
        const late = (await makeNodes(1))[0]
        nodes.push(late)
        for (const n of nodes.slice(0, 2)) await connectPair(late, n)
        await waitUntil(() => late.history().length === 2, 5000)
        const got = late.history().find(m => m.text.startsWith('> '))
        assert.equal(got.text, quoted)
        assert.equal(Buffer.compare(Buffer.from(got.text, 'utf8'), Buffer.from(quoted, 'utf8')), 0)
        assert.deepEqual({ ...quoteCore.parseQuote(got.text) }, { author: label, excerpt: quoteCore.makeExcerpt(original), reply })
    } finally {
        await stopAll(nodes)
    }
})

test('a small history evicts the original and keeps the complete quote', () => {
    const h = createHistory(3)
    h.add({ id: 'o', from: 'a', text: original, time: 1 })
    h.add({ id: 'q', from: 'b', text: quoted, time: 2 })
    h.add({ id: 'x', from: 'a', text: 'x', time: 3 })
    h.add({ id: 'y', from: 'a', text: 'y', time: 4 })
    assert.equal(h.has('o'), false)
    assert.equal(h.list().find(m => m.id === 'q').text, quoted)
})
