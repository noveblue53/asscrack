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

function record(node) {
    const log = { joined: [], left: [], messages: [] }
    node.events.on('peer-joined', e => log.joined.push(e))
    node.events.on('peer-left', e => log.left.push(e))
    node.events.on('message', e => log.messages.push(e))
    return log
}

test('two nodes chat through createAsscrackNode', { timeout: 15000 }, async () => {
    const opts = { room: 'test', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }
    const a = await createAsscrackNode(opts)
    const b = await createAsscrackNode(opts)
    let bStopped = false
    try {
        const logA = record(a)
        const logB = record(b)
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => logA.joined.length === 1 && logB.joined.length === 1)
        assert.deepEqual(logA.joined, [{ peerId: b.peerId }])
        assert.deepEqual(logB.joined, [{ peerId: a.peerId }])
        assert.deepEqual(a.peers(), [b.peerId])
        assert.deepEqual(b.peers(), [a.peerId])

        assert.equal(a.send('hello from A'), 1)
        assert.equal(b.send('hello from B'), 1)
        await waitFor(() => logA.messages.length === 1 && logB.messages.length === 1)
        await delay(200)
        assert.deepEqual(logB.messages, [{ peerId: a.peerId, text: 'hello from A' }])
        assert.deepEqual(logA.messages, [{ peerId: b.peerId, text: 'hello from B' }])

        await b.stop()
        bStopped = true
        await waitFor(() => logA.left.length === 1)
        assert.deepEqual(logA.left, [{ peerId: b.peerId }])
        assert.deepEqual(a.peers(), [])
    } finally {
        if (!bStopped) await b.stop()
        await a.stop()
    }
})
