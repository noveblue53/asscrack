import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'

async function waitFor(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (check()) return
        await delay(50)
    }
    assert.ok(check(), 'Timed out waiting for expected node behavior')
}

const opts = { room: 'test', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }

async function pair() {
    const a = await createAsscrackNode(opts)
    const b = await createAsscrackNode(opts)
    const messagesB = []
    b.events.on('message', e => messagesB.push(e))
    await b.connect(a.getMultiaddrs()[0])
    await waitFor(() => a.peers().length === 1 && b.peers().length === 1)
    return { a, b, messagesB }
}

test('sendRecord gives the same id, from, text and time as the received message', { timeout: 15000 }, async () => {
    const { a, b, messagesB } = await pair()
    try {
        const rec = a.sendRecord('x')
        assert.equal(typeof rec.id, 'string')
        assert.equal(typeof rec.time, 'number')
        assert.equal(rec.from, a.name)
        assert.equal(rec.text, 'x')
        assert.equal(rec.accepted, 1)
        await waitFor(() => messagesB.length === 1)
        const got = messagesB[0]
        assert.equal(got.id, rec.id)
        assert.equal(got.from, rec.from)
        assert.equal(got.text, rec.text)
        assert.equal(got.time, rec.time)
        assert.equal('accepted' in got, false)
    } finally {
        await b.stop()
        await a.stop()
    }
})

// Milestone 6 part 2 changed this test: a send that no session accepted stays local (plan section 6 part 2).
// Before, the test expected the record in the history.
test('sendRecord with no session gives accepted 0 and does not add the record to history', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts)
    try {
        const rec = a.sendRecord('alone')
        assert.equal(rec.accepted, 0)
        assert.equal(typeof rec.id, 'string')
        assert.equal(rec.text, 'alone')
        assert.equal(a.history().some(m => m.id === rec.id), false)
    } finally {
        await a.stop()
    }
})

test('a peer that connects after a send with no session does not get the record in a replay', { timeout: 30000 }, async () => {
    const a = await createAsscrackNode(opts)
    const b = await createAsscrackNode(opts)
    const replayed = []
    b.events.on('history', e => replayed.push(...e.messages))
    a.events.on('history', e => replayed.push(...e.messages))
    try {
        const rec = a.sendRecord('alone before b')
        assert.equal(rec.accepted, 0)
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => a.peers().length === 1 && b.peers().length === 1)
        await waitFor(() => a.host() !== null && b.host() !== null && a.host()?.peerId === b.host()?.peerId)
        await delay(1000)
        assert.equal(b.history().some(m => m.id === rec.id), false)
        assert.equal(replayed.some(m => m.id === rec.id), false)
        // A later send with a session goes in the history.
        const rec2 = a.sendRecord('with b')
        assert.equal(rec2.accepted, 1)
        assert.equal(a.history().some(m => m.id === rec2.id), true)
    } finally {
        await b.stop()
        await a.stop()
    }
})

test('a live line whose id came first in a host replay gives a live event and no message event', { timeout: 30000 }, async () => {
    const now = Date.now()
    const recA = { id: 'seed-a', from: 'a', text: 'seed of a', time: now }
    const recB = { id: 'seed-b', from: 'b', text: 'seed of b', time: now + 1 }
    const a = await createAsscrackNode({ ...opts, seedHistory: [recA] })
    const b = await createAsscrackNode({ ...opts, seedHistory: [recB] })
    const seen = { a: { live: [], message: [] }, b: { live: [], message: [] } }
    for (const [k, n] of [['a', a], ['b', b]]) {
        n.events.on('live', e => seen[k].live.push(e))
        n.events.on('message', e => seen[k].message.push(e))
    }
    try {
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => a.peers().length === 1 && b.peers().length === 1)
        await waitFor(() => a.host() !== null && a.host()?.peerId === b.host()?.peerId)
        const hostIsA = a.isHost()
        const [host, member, rec, m] = hostIsA ? [a, b, recA, 'b'] : [b, a, recB, 'a']
        // The member gets the record of the host in the replay.
        await waitFor(() => member.history().some(x => x.id === rec.id))
        // The same record now comes as a live line.
        assert.equal(host.sendTo(member.peerId, rec), true)
        await waitFor(() => seen[m].live.some(e => e.id === rec.id))
        const live = seen[m].live.find(e => e.id === rec.id)
        assert.equal(live.text, rec.text)
        assert.equal(live.time, rec.time)
        assert.equal(live.peerId, host.peerId)
        assert.equal(seen[m].message.some(e => e.id === rec.id), false)
        // A new live line gives both events, one time each.
        host.sendRecord('new line')
        await waitFor(() => seen[m].message.some(e => e.text === 'new line'))
        await waitFor(() => seen[m].live.some(e => e.text === 'new line'))
        assert.equal(seen[m].message.filter(e => e.text === 'new line').length, 1)
    } finally {
        await b.stop()
        await a.stop()
    }
})

test('send still returns the session count', { timeout: 15000 }, async () => {
    const { a, b } = await pair()
    try {
        assert.equal(a.send('y'), 1)
    } finally {
        await b.stop()
        await a.stop()
    }
})
