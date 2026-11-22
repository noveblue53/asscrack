// Ready check (milestone 9) on real nodes. All results of this file are 127.0.0.1 results, not LAN results.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'

async function waitFor(check, what) {
    for (let attempt = 0; attempt < 300; attempt++) {
        if (check()) return
        await delay(25)
    }
    assert.ok(check(), `Timed out waiting for ${what}`)
}

const opts = name => ({ room: 'ready-node-test', name, listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false })
const check = node => node.readyCheck().checks[0] ?? null

async function mesh(nodes) {
    for (let i = 1; i < nodes.length; i++) {
        for (let j = 0; j < i; j++) await nodes[i].connect(nodes[j].getMultiaddrs()[0])
    }
    await waitFor(() => nodes.every(n => n.peers().length === nodes.length - 1), 'the full mesh')
}

test('127.0.0.1: the open line reaches a late joiner, the votes arrive, and close ends the check on each node', { timeout: 30000 }, async () => {
    const a = await createAsscrackNode(opts('Ann'))
    const b = await createAsscrackNode(opts('Sam'))
    const c = await createAsscrackNode(opts('Sam'))
    const nodes = [a, b, c]
    try {
        await mesh([a, b])
        const opened = a.openReady('Race in five?')
        const id = opened.checks[0].id
        await waitFor(() => check(b)?.id === id, 'the open line on B')
        assert.equal(check(b).text, 'Race in five?')
        assert.equal(check(b).from, a.peerId)
        b.voteReady(id, 'ready')
        await waitFor(() => check(a)?.votes[b.peerId] === 'ready', 'the vote of B on A')

        // C joins late. It gets the open line from A and the vote of B from B (in any sequence).
        await mesh(nodes)
        await waitFor(() => check(c)?.id === id && check(c).votes[b.peerId] === 'ready', 'the check and the vote on C')
        assert.deepEqual(c.readyCheck().people.sort(), [a.peerId, b.peerId, c.peerId].sort())

        // B and C have the same name: two votes. B changes its vote.
        c.voteReady(id, 'ready')
        b.voteReady(id, 'minute')
        for (const n of nodes) {
            await waitFor(() => check(n)?.votes[b.peerId] === 'minute' && check(n).votes[c.peerId] === 'ready', 'the votes on each node')
            assert.equal(Object.keys(check(n).votes).length, 2)
        }

        a.closeReady(id)
        for (const n of nodes) await waitFor(() => check(n)?.open === false, 'the close on each node')
        assert.throws(() => c.voteReady(id, 'ready'), /not open/)

        // Lines that are not valid: no change on B.
        const before = JSON.stringify(b.readyCheck())
        assert.equal(c.sendTo(b.peerId, { type: 'ready', v: 1, op: 'open', id: 'not-an-id', text: 'x' }), true)
        assert.equal(c.sendTo(b.peerId, { type: 'ready', v: 1, op: 'close', id }), true)
        await delay(200)
        assert.equal(JSON.stringify(b.readyCheck()), before)
    } finally {
        await Promise.allSettled(nodes.map(n => n.stop()))
    }
})

test('127.0.0.1: the check of an initiator that quits (bye line) goes away at once', { timeout: 30000 }, async () => {
    const a = await createAsscrackNode(opts('Ann'))
    const b = await createAsscrackNode(opts('Bob'))
    let aStopped = false
    try {
        await mesh([a, b])
        const id = a.openReady('').checks[0].id
        await waitFor(() => check(b)?.id === id, 'the open line on B')
        assert.equal(check(b).text, 'Ready?')
        await a.stop()
        aStopped = true
        await waitFor(() => b.readyCheck().checks.length === 0, 'the expiry on B')
    } finally {
        if (!aStopped) await a.stop()
        await b.stop()
    }
})
