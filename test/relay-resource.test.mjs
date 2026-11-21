import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { RELAY_V2_HOP_CODEC } from '@libp2p/circuit-relay-v2'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

test('an established relay circuit consumes each inbound payload exactly once', { timeout: 10000 }, async t => {
    const nodes = []
    const roomKey = newRoomKey()
    async function member(opts) {
        const node = await createAsscrackNode({ room: 'Relay fixture', roomKey, discovery: false, ...opts })
        nodes.push(node)
        return node
    }
    t.after(() => Promise.allSettled(nodes.map(node => node.stop())))
    const relay = await member({ fullNode: true, listen: ['/ip4/127.0.0.1/tcp/0'] })
    const a = await member({ fullNode: false, relayOnly: true })
    const b = await member({ fullNode: false, relayOnly: true })
    const endpoint = relay.getMultiaddrs().find(addr => addr.startsWith('/ip4/127.0.0.1/'))
    await a.connect(endpoint)
    await b.connect(endpoint)
    for (let i = 0; i < 250 && !(a.peers().includes(b.peerId) && b.peers().includes(a.peerId)); i++) await delay(20)
    assert.ok(a.peers().includes(b.peerId) && b.peers().includes(a.peerId))

    const ingress = relay.libp2p.getConnections().flatMap(connection => connection.streams)
        .filter(stream => stream.protocol === RELAY_V2_HOP_CODEC && stream.status === 'open')
    assert.equal(ingress.length, 1)
    // The circuit byte counter and the shared duplex reader each need one listener.
    // A third listener is an unread queue left by wrapping the return sink separately.
    assert.equal(ingress[0].listenerCount('message'), 2)

    const messages = []
    b.events.on('message', record => messages.push(record.text))
    a.send('hello across the admitted circuit')
    for (let i = 0; i < 50 && messages.length === 0; i++) await delay(20)
    assert.deepEqual(messages, ['hello across the admitted circuit'])
})
