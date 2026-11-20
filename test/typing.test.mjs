import test from 'node:test'
import assert from 'node:assert/strict'
import { createTyping } from '../src/network/typing.mjs'
import { createAsscrackNode } from '../src/network/node.mjs'
import { setTimeout as delay } from 'node:timers/promises'

test('typing is driven by edits, rate limited, peer scoped and expires after the last update', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 })
    const outgoing = [], events = []
    const typing = createTyping({
        now: Date.now, broadcast(active) { outgoing.push(active); return true },
        changed: (peer, active) => events.push([peer, active])
    })
    for (let i = 0; i < 100; i++) typing.edited(true)
    t.mock.timers.tick(2999)
    typing.edited(true)
    assert.deepEqual(outgoing, [true])
    t.mock.timers.tick(1)
    typing.edited(true)
    for (let i = 0; i < 100; i++) { typing.edited(false); typing.edited(true) }
    assert.deepEqual(outgoing, [true, true, false])
    typing.received('a', true)
    t.mock.timers.tick(3000)
    typing.received('a', true)
    typing.received('b', true)
    t.mock.timers.tick(5999)
    assert.deepEqual(events, [['a', true], ['b', true]])
    typing.remove('b')
    t.mock.timers.tick(1)
    assert.deepEqual(events.slice(2), [['b', false], ['a', false]])
    t.mock.timers.tick(6000)
    assert.deepEqual(outgoing, [true, true, false])
    typing.received('a', true)
    typing.stop()
    t.mock.timers.tick(6000)
    assert.deepEqual(events.at(-1), ['a', true])
})

test('127.0.0.1 typing uses only current sessions, clears on live chat and never becomes history', async () => {
    const opt = { room: 'typing', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }
    const nodes = []
    const changes = []
    async function wait(check) {
        for (let i = 0; i < 100; i++) { if (check()) return; await delay(40) }
        assert.ok(check())
    }
    try {
        for (const name of ['same', 'same', 'late']) nodes.push(await createAsscrackNode({ ...opt, name }))
        const [a, b, c] = nodes
        b.events.on('typing', event => changes.push(event))
        c.events.on('typing', () => assert.fail('late join got stale typing'))
        await a.connect(b.getMultiaddrs()[0])
        await wait(() => a.peers().length && b.peers().length)
        a.setTyping(true)
        await wait(() => changes.length === 1)
        await c.connect(a.getMultiaddrs()[0])
        await wait(() => c.peers().length === 1)
        assert.deepEqual(a.history(), [])
        assert.deepEqual(b.history(), [])
        a.send('hello')
        await wait(() => changes.length === 2)
        assert.deepEqual(changes.map(e => [e.peerId, e.active]), [[a.peerId, true], [a.peerId, false]])
        assert.deepEqual(b.history().map(m => m.text), ['hello'])
    } finally { await Promise.all(nodes.map(n => n.stop())) }
})
