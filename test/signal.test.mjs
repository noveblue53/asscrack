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

// L9 (P10a): the node had a 'signal' line with any object of up to 512 KB. Each line went to the window IPC as an
// event, and the window had no listener for it. 40 lines gave 19.5 MiB of events. The fix removes the line type.
test('L9: a signal line from a peer gives no event and does not close the session', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts)
    const b = await createAsscrackNode(opts)
    try {
        const signals = []
        b.events.on('signal', e => signals.push(e))
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => a.peers().length === 1 && b.peers().length === 1)
        const big = { blob: 'x'.repeat(400 * 1024) }
        for (let i = 0; i < 5; i++) assert.equal(a.sendTo(b.peerId, { type: 'signal', data: big }), true)
        a.send('after the signal lines')
        await waitFor(() => b.history().some(m => m.text === 'after the signal lines'))
        assert.deepEqual(signals, [])
        assert.deepEqual(b.peers(), [a.peerId])
    } finally {
        await Promise.allSettled([a.stop(), b.stop()])
    }
})

// L9 (P10a): the streamId of a voice line had no length limit. The limit is 64 characters.
test('L9: a voice line with a streamId of more than 64 characters gives streamId null', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode(opts)
    const b = await createAsscrackNode(opts)
    try {
        const states = []
        b.events.on('voice-state', e => states.push(e))
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => a.peers().length === 1)
        a.sendTo(b.peerId, { type: 'voice', inVoice: true, streamId: 's'.repeat(65), muted: false })
        await waitFor(() => states.length === 1)
        assert.equal(states[0].streamId, null)
        a.sendTo(b.peerId, { type: 'voice', inVoice: true, streamId: 's'.repeat(64), muted: false })
        await waitFor(() => states.length === 2)
        assert.equal(states[1].streamId, 's'.repeat(64))
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
        assert.deepEqual(states[0], { peerId: a.peerId, inVoice: true, streamId: 'stream-1', muted: false, deafened: false, channel: 'general' })
        a.setVoice({ inVoice: true, streamId: 'stream-1', muted: true })
        await waitFor(() => states.length === 2)
        assert.deepEqual(states[1], { peerId: a.peerId, inVoice: true, streamId: 'stream-1', muted: true, deafened: false, channel: 'general' })
        a.setVoice({ inVoice: false, streamId: null })
        await waitFor(() => states.length === 3)
        assert.deepEqual(states[2], { peerId: a.peerId, inVoice: false, streamId: null, muted: false, deafened: false, channel: 'general' })
    } finally {
        await Promise.allSettled([a.stop(), b.stop()])
    }
})
