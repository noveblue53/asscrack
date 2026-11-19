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

test('sendRecord with no session gives accepted 0 and adds the record to history', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts)
    try {
        const rec = a.sendRecord('alone')
        assert.equal(rec.accepted, 0)
        const item = a.history().find(m => m.id === rec.id)
        assert.ok(item)
        assert.equal(item.time, rec.time)
        assert.equal(item.text, 'alone')
    } finally {
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
