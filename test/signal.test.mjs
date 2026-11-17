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

const opts = { room: 'signal', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }

test('sendTo sends a signal line to one peer', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts)
    const b = await createAsscrackNode(opts)
    try {
        const signals = []
        b.events.on('signal', e => signals.push(e))
        assert.equal(a.sendTo(b.peerId, { type: 'signal', data: { x: 1 } }), false)
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => a.peers().length === 1)
        assert.equal(a.sendTo(b.peerId, { type: 'signal', data: { sdp: 'offer', n: 2 } }), true)
        a.sendTo(b.peerId, { type: 'signal', data: 'not an object' })
        await waitFor(() => signals.length === 1)
        await delay(200)
        assert.deepEqual(signals, [{ peerId: a.peerId, data: { sdp: 'offer', n: 2 } }])
        assert.deepEqual(b.history(), [])
    } finally {
        await Promise.allSettled([a.stop(), b.stop()])
    }
})

test('setVoice sends the voice state to open and new sessions', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts)
    const b = await createAsscrackNode(opts)
    try {
        const states = []
        b.events.on('voice-state', e => states.push(e))
        a.setVoice({ inVoice: true, streamId: 'stream-1' })
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => states.length === 1)
        assert.deepEqual(states[0], { peerId: a.peerId, inVoice: true, streamId: 'stream-1' })
        a.setVoice({ inVoice: false, streamId: null })
        await waitFor(() => states.length === 2)
        assert.deepEqual(states[1], { peerId: a.peerId, inVoice: false, streamId: null })
    } finally {
        await Promise.allSettled([a.stop(), b.stop()])
    }
})
