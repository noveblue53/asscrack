import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { observeRoomActivity } from '../src/application/room-activity.mjs'

const member = () => ({ events: new EventEmitter(), peerId: 'local-peer' })

test('room diagnostics expose locally observed facts and keep raw values out of the copy', () => {
    const node = member()
    const otherRoom = member()
    const feed = observeRoomActivity(node, () => 0)
    const otherFeed = observeRoomActivity(otherRoom, () => 0)
    const hostile = {
        peer: '/ip4/192.0.2.4/tcp/4444', relay: 'asscrack1:sample', addr: '192.0.2.4',
        reason: 'sensitive reason', via: 'sensitive route', error: 'sensitive text', roomKey: 'private-key',
        name: 'private-filename', from: 'personal-name', text: 'private-body'
    }
    node.events.emit('connection', { ...hostile, state: 'session', type: 'relay' })
    otherRoom.events.emit('connection', { ...hostile, state: 'session', type: 'relay' })
    assert.notDeepEqual(otherFeed(), feed(), 'pseudonyms change between rooms')
    node.events.emit('dial-failed', hostile)
    node.events.emit('host-changed', { peerId: node.peerId })
    node.events.emit('host-changed', { peerId: null })
    node.events.emit('upnp', { ...hostile, state: 'mapped' })
    node.events.emit('connection', { ...hostile, state: 'closed', type: 'hostile-value' })
    for (const type of ['message', 'history', 'file-offer', 'presence', 'typing', 'voice-frame', 'topology']) {
        node.events.emit(type, hostile)
    }
    const lines = feed()
    assert.equal(lines.length, 6)
    assert.match(lines[0], /Chat opened \(relayed\) with peer [0-9a-f]{8} via peer [0-9a-f]{8}$/)
    assert.match(lines[1], /Dial failed \(unknown route, other\)/)
    assert.match(lines[2], /Host observed: this device/)
    assert.match(lines[3], /Waiting for a host/)
    assert.match(lines[4], /Local UPnP mapping created/)
    assert.match(lines[5], /Chat closed \(unknown route\)/)
    for (const value of Object.values(hostile)) assert.ok(!lines.join('\n').includes(value))
    assert.doesNotMatch(lines.join('\n'), /voice|recovered/i)
})

test('room diagnostics retain 100 events and coalesce equivalent dial failures across raw addresses', () => {
    const node = member()
    let now = 0
    const feed = observeRoomActivity(node, () => now)
    const fail = addr => node.events.emit('dial-failed', { peer: 'remote', via: 'relay', reason: 'timeout', addr })
    fail('address-one')
    now += 59000
    fail('address-two')
    assert.equal(feed().length, 1)
    assert.match(feed()[0], /×2/)
    now += 1000
    fail('address-three')
    assert.equal(feed().length, 2)
    for (let i = 0; i < 102; i++) {
        now += 1000
        node.events.emit('host-changed', { peerId: node.peerId })
    }
    const result = feed()
    assert.equal(result.length, 100)
    assert.ok(result.every(line => line.includes('Host observed: this device')))
    assert.ok(result[0].startsWith(new Date(63000).toISOString()))
    result.length = 0
    assert.equal(feed().length, 100)
})

test('the peer and transfer filters select redacted local outcomes, including past outcomes', () => {
    const node = member()
    const read = observeRoomActivity(node, () => 0)
    const sensitive = { offerId: 'private-offer-id', name: 'private-name', path: '/secret/path', reason: 'sensitive-file' }
    node.events.emit('connection', { state: 'session', peer: 'buddy-A', type: 'relay', relay: 'buddy-B' })
    node.events.emit('file-done', { ...sensitive, peerId: 'buddy-A', direction: 'send', confirmed: true })
    node.events.emit('file-done', { ...sensitive, peerId: 'buddy-B', direction: 'send', confirmed: false })
    node.events.emit('file-failed', { ...sensitive, peerId: 'buddy-A', direction: 'receive' })
    node.events.emit('file-refused', { ...sensitive, peerId: 'buddy-A' })
    node.events.emit('file-cancelled', { ...sensitive, peerId: 'buddy-B', direction: 'send' })
    node.events.emit('topology', { transfers: [{ ...sensitive, from: 'buddy-A', to: 'buddy-B' }] })
    const all = read()
    assert.equal(all.length, 6)
    for (const value of [...Object.values(sensitive), 'buddy-A', 'buddy-B']) {
        assert.ok(!all.join('\n').includes(value))
    }
    const a = read({ peerId: 'buddy-A', transfersOnly: true })
    assert.equal(a.length, 3)
    assert.match(a[0], /Send to peer [0-9a-f]{8} · offer [0-9a-f]{8} · delivered$/)
    assert.match(a[1], /Receive from peer .* · failed$/)
    assert.match(a[2], /Send to peer .* · refused$/)
    const b = read({ peerId: 'buddy-B' })
    assert.equal(b.length, 3)
    assert.match(b[0], /relayed/)
    assert.match(b[1], /sent \(unconfirmed\)$/)
    assert.match(b[2], /cancelled$/)
    assert.equal(new Set(read({ transfersOnly: true }).map(line => line.match(/offer [0-9a-f]+/)[0])).size, 1)
    assert.deepEqual(read({ peerId: 'another-buddy' }), [])
    for (let i = 0; i < 100; i++) node.events.emit('upnp', { state: 'mapped' })
    assert.equal(read().length, 100)
    assert.deepEqual(read({ transfersOnly: true }), [])
})

// G5 (gap B5): the alias of a peer ID is the pseudonym in the lines. The lines do not change.
test('the alias of a peer ID is the pseudonym of that peer in the lines', () => {
    const node = member()
    const feed = observeRoomActivity(node, () => 0)
    node.events.emit('connection', { state: 'session', type: 'direct', peer: 'peer-one' })
    node.events.emit('dial-failed', { peer: 'peer-two', via: 'relay', reason: 'timeout' })
    const [one, two, self, bad] = feed.aliases(['peer-one', 'peer-two', 'local-peer', ''])
    assert.match(one, /^peer [0-9a-f]{8}$/)
    assert.notEqual(one, two)
    assert.equal(self, 'this device')
    assert.equal(bad, 'unknown peer')
    const lines = feed()
    assert.ok(lines[0].endsWith('with ' + one))
    assert.ok(lines[1].endsWith('to ' + two))
    assert.deepEqual(feed({ peerId: 'peer-one' }), [lines[0]])
    // At most 64 IDs, and no throw for a value that is not a list.
    assert.equal(feed.aliases(Array.from({ length: 100 }, (_, i) => 'p' + i)).length, 64)
    assert.deepEqual(feed.aliases('peer-one'), [])
})
