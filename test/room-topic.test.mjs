import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { newRoomKey } from '../src/network/invite.mjs'
import { createAsscrackNode } from '../src/network/node.mjs'
import { createRoomTopic } from '../src/network/room-topic.mjs'

async function until(check, label) {
    for (let i = 0; i < 200; i++) {
        if (check()) return
        await delay(25)
    }
    assert.ok(check(), label)
}

test('127.0.0.1: late join, simultaneous topic changes, failover and clearing in a keyed room', async t => {
    const opts = { room: 'Live topic', roomKey: newRoomKey(), discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'],
        heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500, fullNode: false }
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    const a = await createAsscrackNode({ ...opts, fullNode: true })
    nodes.push(a)
    const b = await createAsscrackNode(opts)
    nodes.push(b)
    await b.connect(a.getMultiaddrs()[0])
    await until(() => a.isHost() && b.topic().available, 'capable host')
    a.setTopic('Practice at 8')
    b.setPresence({ state: 'away', note: 'setting up' })
    const c = await createAsscrackNode(opts)
    nodes.push(c)
    await c.connect(b.getMultiaddrs()[0])
    await c.connect(a.getMultiaddrs()[0])
    await until(() => c.topic().text === 'Practice at 8' && c.peerPresence()[b.peerId]?.note === 'setting up', 'late snapshot')

    const seen = []
    a.events.on('topic', v => seen.push(v.text))
    b.setTopic('Oval')
    c.setTopic('Road')
    await until(() => seen.length === 2 && nodes.every(n => n.topic().text === seen.at(-1)), 'both proposals ordered')
    assert.deepEqual(new Set(seen), new Set(['Oval', 'Road']))
    const agreed = seen.at(-1)
    const previous = a.host()
    // A non-host cannot publish state by naming the actual leader. A stale publication from A is ignored too.
    const snapshot = { type: 'topic', op: 'state', v: 1, host: a.peerId, term: previous.term, record: null, revision: 99 }
    b.sendTo(c.peerId, snapshot)
    a.sendTo(c.peerId, { ...snapshot, revision: 0 })
    const marker = a.sendRecord('chat marker')
    const secondMarker = b.sendRecord('non-host marker')
    await until(() => [marker, secondMarker].every(m => c.history().some(x => x.id === m.id)), 'both control streams drained')
    assert.equal(c.topic().text, agreed)
    await a.stop()
    nodes.shift()
    await until(() => b.host()?.peerId === c.host()?.peerId && b.host()?.peerId !== a.peerId &&
        [b, c].every(n => n.topic().available && n.topic().text === agreed), 'topic survived host loss')
    const next = b.isHost() ? b : c
    const follower = b.isHost() ? c : b
    assert.throws(() => next.setTopic('a\nb'), /one line/)
    assert.throws(() => next.setTopic('a'.repeat(161)), /160/)
    follower.setTopic('')
    await until(() => [b, c].every(n => n.topic().text === ''), 'cleared')
    await follower.stop()
    nodes.splice(nodes.indexOf(follower), 1)
    await until(() => !next.peers().includes(follower.peerId), 'departure')
    assert.equal(next.peerPresence()[follower.peerId], undefined)
    const rejoin = await createAsscrackNode(opts)
    nodes.push(rejoin)
    await rejoin.connect(next.getMultiaddrs()[0])
    await until(() => rejoin.topic().available, 'rejoined')
    assert.equal(rejoin.topic().text, '')
    assert.deepEqual(next.history().map(m => m.text).sort(), ['chat marker', 'non-host marker'])
})

test('new host recovers the highest previously accepted edit from a surviving member; a later clear wins', async () => {
    const packets = []
    const topic = createRoomTopic({ selfId: 'b', send: (_id, p) => packets.push(p), broadcast: p => packets.push(p), changed() {} })
    topic.elected({ peerId: 'b', term: 2 })
    await Promise.resolve()
    const recover = r => topic.handle('member', { type: 'topic', v: 1, host: 'b', term: 2, op: 'sync', record: r })
    const record = { host: 'a', term: 1, edit: 7, text: 'retained' }
    recover(record)
    recover({ ...record, edit: 3, text: 'older' })
    assert.deepEqual(topic.view(), { available: true, text: 'retained' })
    topic.set('')
    recover(record)
    recover({ ...record, host: 'b', term: 2, edit: 100, text: 'unaccepted' })
    assert.equal(topic.view().text, '')
    topic.elected({ peerId: 'old', term: 3 })
    assert.equal(topic.view().available, false)
    assert.throws(() => topic.set('x'), /unavailable/)
})


test('a surviving member can offer its last accepted topic through two host losses', async () => {
    const sent = []
    const member = createRoomTopic({ selfId: 'm', send: (peer, msg) => sent.push({ peer, msg }), broadcast() {}, changed() {} })
    const record = { term: 1, host: 'a', edit: 1, text: 'Saturday' }
    function receive(host, term, snapshot) {
        member.elected({ peerId: host, term })
        member.handle(host, { v: 1, op: 'state', host, term, record: snapshot, revision: 0 })
    }
    receive('a', 1, record)
    receive('b', 2, null)
    assert.equal(member.view().text, '')
    member.elected({ peerId: 'c', term: 3 })
    await Promise.resolve()
    assert.deepEqual(sent.at(-1).msg.record, record)
    assert.equal(sent.at(-1).peer, 'c')
})
