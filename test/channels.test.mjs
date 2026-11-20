import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { createChannels } from '../src/network/channels.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

async function waitFor(check, label) {
    const end = Date.now() + 20000
    while (!check() && Date.now() < end) await delay(25)
    assert.ok(check(), label)
}

function group(t) {
    const nodes = new Set()
    const opts = { room: 'channel room', roomKey: newRoomKey(), listen: ['/ip4/127.0.0.1/tcp/0'],
        discovery: false, fullNode: false, heartbeatInterval: 200, hostTimeout: 1500, electionDelay: 500 }
    t.after(() => Promise.all([...nodes].map(n => n.stop())))
    return {
        async make(options = {}) {
            const n = await createAsscrackNode({ ...opts, ...options })
            nodes.add(n)
            return n
        },
        async stop(n) { await n.stop(); nodes.delete(n) }
    }
}

const channelIds = n => n.channels().channels.map(c => c.id)
function counts(n) {
    const out = {}
    for (const row of n.history()) {
        const id = row.channelId ?? 'general'
        out[id] = (out[id] || 0) + 1
    }
    return out
}

test('127.0.0.1 channels preserve live and replay identities, empty and evicted channels, and host replacement', async t => {
    const g = group(t)
    const a = await g.make({ fullNode: true, name: 'initial' })
    const b = await g.make({ name: 'member' })
    await b.connect(a.getMultiaddrs()[0])
    await waitFor(() => a.isHost() && b.channels().available, 'known capable host')
    const first = b.createChannel('Talk')
    const second = a.createChannel('Music')
    const empty = b.createChannel('No posts')
    const evicted = a.createChannel('Archived discussion')
    await waitFor(() => [a,b].every(n => channelIds(n).length === 5), 'converged catalog')
    const firstRow = b.sendRecord('aged past the room window', evicted)
    await waitFor(() => a.history().some(m => m.id === firstRow.id), 'old post arrived')
    for (let i = 0; i < 200; ++i) a.send('general message ' + i)
    await waitFor(() => b.history().length === 200 && !b.history().some(m => m.id === firstRow.id), 'eviction')
    const m1 = b.sendRecord('same body', first)
    const m2 = a.sendRecord('same body', second)
    const expected = { general: 198, [first]: 1, [second]: 1 }
    await waitFor(() => [a,b].every(n => n.history().some(m => m.id === m1.id) && n.history().some(m => m.id === m2.id)), 'named chat')
    const c = await g.make({ name: 'late' })
    // Establish B–C directly before either can select A as its circuit relay.
    await c.connect(b.getMultiaddrs()[0])
    await c.connect(a.getMultiaddrs()[0])
    await waitFor(() => c.host()?.peerId === a.peerId && c.history().length === 200, 'late join has all routed lines')
    for (const n of [a,b,c]) {
        assert.deepEqual(counts(n), expected)
        assert.deepEqual(channelIds(n), ['general', ...[first, second, empty, evicted].sort()])
    }
    assert.ok(c.libp2p.getConnections(b.libp2p.peerId).every(conn => !conn.remoteAddr.toString().includes('p2p-circuit')))
    await waitFor(() => c.peers().includes(b.peerId) && b.peers().includes(c.peerId), 'independent survivor route')
    await g.stop(a)
    await waitFor(() => b.host()?.peerId && c.host()?.peerId === b.host().peerId
        && [b,c].some(n => n.isHost()) && [b,c].every(n => n.channels().available), 'capable successor host')
    const m3 = c.sendRecord('after host replacement', first)
    await waitFor(() => b.history().some(m => m.id === m3.id && m.channelId === first), 'new host preserves target')
    for (const n of [b,c]) {
        assert.deepEqual(counts(n), { general: 197, [first]: 2, [second]: 1 })
        assert.ok(channelIds(n).includes(empty))
        assert.ok(channelIds(n).includes(evicted))
    }
})

test('127.0.0.1 fresh nodes after a complete stop converge on seeded catalogs and replay', async t => {
    const g = group(t)
    const original = await g.make({ fullNode: true }), member = await g.make()
    await member.connect(original.getMultiaddrs()[0])
    await waitFor(() => original.isHost() && member.channels().available, 'initial host')
    // Concurrent equal labels are distinct identities. All peers order them by ID.
    const left = original.createChannel('Projects'), right = member.createChannel('Projects')
    assert.notEqual(left, right)
    const empty = original.createChannel('Idle')
    await waitFor(() => [original, member].every(n => channelIds(n).length === 4), 'concurrent catalog entries replicated')
    original.sendRecord('left', left)
    member.sendRecord('right', right)
    await waitFor(() => [original, member].every(n => n.history().length === 2), 'separate channel identities')
    const seedChannels = original.channels().channels, seedHistory = member.history()
    await Promise.all([g.stop(original), g.stop(member)])
    const reopened = await g.make({ fullNode: true, seedChannels, seedHistory })
    assert.equal(reopened.channels().available, false, 'isolated restart is read-only')
    assert.throws(() => reopened.sendRecord('offline', left), /read-only/)
    assert.deepEqual(channelIds(reopened), ['general', ...[left, right, empty].sort()])
    const fresh = await g.make()
    await fresh.connect(reopened.getMultiaddrs()[0])
    await waitFor(() => fresh.history().length === 2 && fresh.channels().available, 'fresh member received stored catalog and replay')
    assert.deepEqual(fresh.channels().channels, seedChannels)
    assert.deepEqual(counts(fresh), { [left]: 1, [right]: 1 })
    assert.equal(fresh.history().find(m => m.channelId === right).text, 'right')
    assert.equal(fresh.history().find(m => m.channelId === left).text, 'left')
})

test('catalog convergence and validation are independent of peer arrival order', () => {
    const id = randomUUID(), other = randomUUID()
    const alpha = { id, name: 'Alpha' }, beta = { id, name: 'Beta' }, quiet = { id: other, name: 'No posts' }
    for (const [first, second] of [[alpha, beta], [beta, alpha]]) {
        const c = createChannels({ self: 'me', host: () => 'me', send() {}, ready() {}, changed() {} })
        c.handle('peer', { v: 1, op: 'add', rows: [alpha] })
        assert.deepEqual(c.view().channels.map(x => x.id), ['general'])
        c.handle('peer', { v: 1, op: 'hello' })
        for (const row of [first, second, quiet, { id: 'general', name: 'Replaced' }, { id: randomUUID(), name: 'line\nbreak' }]) {
            c.handle('peer', { v: 1, op: 'add', rows: [row] })
        }
        assert.deepEqual(c.view().channels.map(x => x.id), ['general', ...[id, other].sort()])
        assert.equal(c.view().channels.find(x => x.id === id).name, 'Alpha')
        assert.throws(() => c.create('general'), /already exists/)
    }
})
