// Gap B1: node.stop() sends a bye line. The other node then gets 'peer-left' with left: true. A lost connection
// (no bye) gives left: false. All results are 127.0.0.1 results.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'

async function waitFor(check, what) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (check()) return
        await delay(25)
    }
    assert.ok(check(), `Timed out waiting for ${what}`)
}

async function pair() {
    const opts = { room: 'bye-test', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }
    const a = await createAsscrackNode(opts)
    const b = await createAsscrackNode(opts)
    const left = []
    a.events.on('peer-left', e => left.push(e))
    const joined = []
    a.events.on('peer-joined', e => joined.push(e))
    await b.connect(a.getMultiaddrs()[0])
    await waitFor(() => joined.length === 1 && b.peers().length === 1, 'the session')
    return { a, b, left }
}

test('127.0.0.1: B.stop() gives peer-left with left true on A', { timeout: 20000 }, async () => {
    const { a, b, left } = await pair()
    let bStopped = false
    try {
        const started = Date.now()
        await b.stop()
        bStopped = true
        // The wait of stop() is 200 ms when a session is open.
        assert.ok(Date.now() - started >= 190, 'stop() waits for the bye line')
        await waitFor(() => left.length >= 1, 'peer-left')
        assert.deepEqual(left[0], { peerId: b.peerId, left: true })
    } finally {
        if (!bStopped) await b.stop()
        await a.stop()
    }
})

test('127.0.0.1: an aborted connection gives peer-left with left false', { timeout: 20000 }, async () => {
    const { a, b, left } = await pair()
    try {
        for (const conn of b.libp2p.getConnections()) conn.abort(new Error('simulated network loss'))
        await waitFor(() => left.length >= 1, 'peer-left')
        // Only the first event: the redial can open a new session later.
        assert.deepEqual(left[0], { peerId: b.peerId, left: false })
    } finally {
        await b.stop()
        await a.stop()
    }
})
