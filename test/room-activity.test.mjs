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
