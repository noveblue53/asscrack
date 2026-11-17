import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { createChatSession } from '../src/network/chat-session.mjs'

async function waitFor(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (check()) return
        await delay(50)
    }
    assert.ok(check(), 'Timed out waiting for expected chat behavior')
}

test('one duplex stream carries chat both ways and cleans up on disconnect', { timeout: 15000 }, async () => {
    const nodes = []
    const sessions = []
    const received = [[], []]
    let incomingStreams = 0
    function attach(stream, index) {
        const session = createChatSession(stream, { onMessage: message => received[index].push(message) })
        // A remote connection abort is an expected session outcome.
        session.done.catch(() => {})
        sessions[index] = session
    }
    try {
        for (let index = 0; index < 2; index++) {
            const node = await createLibp2p({
                addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
                transports: [tcp()], streamMuxers: [yamux()],
                connectionEncryption: [noise()],
                connectionManager: { minConnections: 0 }
            })
            nodes.push(node)
            node.addEventListener('connection:close', () => sessions[index]?.close())
            await node.handle('/asscrack/chat/receive', ({ stream }) => {
                incomingStreams++
                attach(stream, index)
            })
        }
        const stream = await nodes[1].dialProtocol(nodes[0].getMultiaddrs()[0], '/asscrack/chat/receive')
        attach(stream, 1)
        await waitFor(() => sessions[0] != null)
        for (let index = 0; index < 2; index++) {
            sessions[index].send('hello from ' + index)
            sessions[index].send('Unicode: héllo 🌍')
            sessions[index].send('')
        }
        await waitFor(() => received.every(messages => messages.length === 3))
        for (let index = 0; index < 2; index++) {
            assert.deepEqual(received[index], ['hello from ' + (1 - index), 'Unicode: héllo 🌍', ''])
        }
        await delay(1000)
        assert.equal(incomingStreams, 1, 'Receiving must not open return streams')
        for (const node of nodes) {
            assert.equal(node.getConnections().reduce((count, connection) => count + connection.streams.length, 0), 1)
        }
        let closed = false
        sessions[0].done.finally(() => { closed = true }).catch(() => {})
        for (const connection of nodes[1].getConnections()) connection.abort(new Error('Simulated peer disconnect'))
        await waitFor(() => closed)
        assert.equal(sessions[0].send('after disconnect'), false)
        assert.equal(nodes[0].status, 'started', 'Remaining peer stays running')
    } finally {
        for (const session of sessions) session?.close()
        for (const node of nodes) {
            for (const connection of node.getConnections()) connection.abort(new Error('Test cleanup'))
        }
        await Promise.all(nodes.map(node => node.stop()))
        await Promise.allSettled(sessions.filter(Boolean).map(session => session.done))
    }
})
