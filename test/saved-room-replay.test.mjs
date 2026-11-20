import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createSavedRooms } from '../src/application/saved-rooms.mjs'
import { createAsscrackNode } from '../src/network/node.mjs'

const room = 'race-night'
const roomKey = Buffer.alloc(32, 13).toString('base64url')
const opts = { room, roomKey, discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'],
    heartbeatInterval: 100, electionDelay: 200, hostTimeout: 1000 }
// Only the OS key wrapper is a fixture. Every profile uses the real on-disk encrypted database.
const protector = { available: () => true, wrap: b => b, unwrap: b => b }

test('a cold saved-room host serves its newest 200 eligible rows to a fresh peer and honors Clear', async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'replay-'))
    const profile = () => createSavedRooms({ dir, protector })
    const first = profile()
    const nodes = []
    let second
    t.after(async () => {
        await Promise.all(nodes.map(n => n.stop()))
        first.close()
        second?.close()
        await rm(dir, { recursive: true, force: true })
    })
    const oldNode = { events: new EventEmitter() }
    first.attachNode(oldNode)
    first.afterLogin({ room, roomKey: Buffer.alloc(32, 14), save: true })
    first.recordSend({ id: 'other', from: 'B', text: 'same name, different key', time: 999, accepted: 1 })
    const { roomId } = first.afterLogin({ room, roomKey, save: true })
    const ids = []
    for (let i = 1; i <= 250; i++) {
        const m = { id: String(i), text: String(i), time: i, from: i % 2 ? 'A' : 'B' }
        ids.push(m.id)
        if (i % 2) first.recordSend({ ...m, accepted: 1 })
        else oldNode.events.emit('live', { ...m, peerId: 'B' })
    }
    oldNode.events.emit('history', { messages: [{ id: 'historical', text: 'catch-up', time: 500, from: 'B' }] })
    first.recordSend({ id: 'local', from: 'A', text: 'no sessions', time: 998, accepted: 0 })
    // A v2 archive created before the wire ID was bounded can contain such a row.
    first.recordSend({ id: 'x'.repeat(129), from: 'A', text: 'old record', time: 1000, accepted: 1 })
    first.setKeepHistory(roomId, false)
    first.close()

    second = profile()
    const host = await createAsscrackNode({ ...opts, fullNode: true,
        seedHistory: invalidate => second.prepareReplay(room, roomKey, invalidate) })
    nodes.push(host)
    second.attachNode(host)
    const reopened = second.afterLogin({ room, roomKey })
    assert.equal(reopened.keepHistory, false)
    assert.deepEqual(host.history().map(m => m.id), ids.slice(-200))
    const newcomer = await createAsscrackNode({ ...opts, fullNode: false })
    nodes.push(newcomer)
    const replayed = once(newcomer.events, 'history', { signal: AbortSignal.timeout(10000) })
    await newcomer.connect(host.getMultiaddrs()[0])
    const [batch] = await replayed
    assert.deepEqual(batch.messages.map(m => m.id), ids.slice(-200))
    assert.equal(second.lines(roomId, { limit: 500 }).length, 251)

    second.clear(roomId)
    assert.deepEqual(host.history(), [])
    const postClear = host.sendRecord('new live traffic while saving is off')
    assert.equal(postClear.accepted, 1)
    assert.equal(second.recordSend(postClear).saved, false)
    const late = await createAsscrackNode({ ...opts, fullNode: false })
    nodes.push(late)
    const lateReplay = once(late.events, 'history', { signal: AbortSignal.timeout(10000) })
    await late.connect(host.getMultiaddrs()[0])
    assert.deepEqual((await lateReplay)[0].messages.map(m => m.id), [postClear.id])
    assert.deepEqual(second.lines(roomId), [])
})

test('Clear and Forget invalidate a prepared replay during login and delayed old-node events cannot cross rooms', async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'replay-'))
    const saved = createSavedRooms({ dir, protector })
    t.after(async () => { saved.close(); await rm(dir, { recursive: true, force: true }) })
    const oldNode = { events: new EventEmitter() }
    const otherNode = { events: new EventEmitter() }
    const source = { id: 'saved', text: 'saved', from: 'A', time: 100, accepted: 1 }
    saved.attachNode(oldNode)
    const { roomId } = saved.afterLogin({ room, roomKey, save: true })
    saved.recordSend(source)
    let ids = saved.prepareReplay(room, roomKey, removed => { ids = ids.filter(id => !removed.has(id)) }).map(m => m.id)
    const later = Promise.resolve().then(() => saved.recordSend(source))
    saved.clear(roomId)
    assert.deepEqual(ids, [])
    assert.equal((await later).saved, false)
    const laterRow = { ...source, id: 'later' }
    assert.equal(saved.recordSend(laterRow).saved, true)
    saved.attachNode(otherNode)
    const other = saved.afterLogin({ room, roomKey: Buffer.alloc(32, 15), save: true })
    ids = saved.prepareReplay(room, roomKey, removed => { ids = ids.filter(id => !removed.has(id)) }).map(m => m.id)
    assert.deepEqual(ids, ['later'])
    saved.forget(roomId)
    assert.deepEqual(ids, [])
    await delay(0)
    oldNode.events.emit('live', source)
    assert.deepEqual(saved.lines(other.roomId), [])
    assert.deepEqual(saved.prepareReplay(room, roomKey, () => {}), [])
})

test('a locally queued multi-frame replay rechecks deleted rows before the next transport write', async () => {
    const { createChatSession } = await import('../src/network/chat-session.mjs')
    const { createHistory, MAX_MESSAGE_BYTES } = await import('../src/network/history.mjs')
    const history = createHistory()
    const sourceEnded = Promise.withResolvers()
    let outbound
    const session = createChatSession({
        source: (async function* () { await sourceEnded.promise })(),
        async sink(frames) {
            outbound = frames[Symbol.asyncIterator]()
            await sourceEnded.promise
        },
        abort() { sourceEnded.resolve() }
    }, { onMessage() {} })
    try {
        // JSON escaping makes the three valid records exceed one frame in aggregate.
        for (let i = 0; i < 3; i++) history.add({ id: String(i), from: '', text: '\u0000'.repeat(MAX_MESSAGE_BYTES), time: i })
        session.sendReplay(history.replayLines(() => true))
        session.send('ordinary live traffic')
        const read = async () => (await outbound.next()).value.toString().trimEnd()
        assert.deepEqual(JSON.parse(await read()).messages.map(m => m.id), ['0'])
        history.removeIds(new Set(['1']))
        history.add({ id: 'new', from: 'A', text: 'available after clearing', time: 5 })
        assert.deepEqual(JSON.parse(await read()).messages.map(m => m.id), ['2'])
        assert.equal(await read(), 'ordinary live traffic')
    } finally {
        sourceEnded.resolve()
        await session.done
    }
})

test('a queued history snapshot cannot overtake a subsequent live message', async () => {
    const { createHistory } = await import('../src/network/history.mjs')
    const history = createHistory()
    history.add({ id: 'past', from: 'A', text: 'saved', time: 1 })
    const queued = history.replayLines(() => true)
    history.add({ id: 'live', from: 'A', text: 'Parker, next', time: 2 })
    assert.deepEqual([...queued].flatMap(line => JSON.parse(line).messages.map(m => m.id)), ['past'])
})

test('a delayed duplicate of a seed pruned from disk before Clear cannot return to the archive', async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'replay-'))
    const saved = createSavedRooms({ dir, protector, limits: { maxRows: 1 } })
    t.after(async () => { saved.close(); await rm(dir, { recursive: true, force: true }) })
    const { roomId } = saved.afterLogin({ room, roomKey, save: true })
    const old = { id: 'pruned', from: 'a', text: 'old', time: 1, accepted: 1 }
    saved.recordSend(old)
    saved.prepareReplay(room, roomKey, () => {})
    saved.recordSend({ ...old, id: 'latest', time: 2 })
    assert.deepEqual(saved.lines(roomId).map(m => m.id), ['latest'])
    saved.clear(roomId)
    assert.equal(saved.recordSend(old).saved, false)
    assert.deepEqual(saved.lines(roomId), [])
})
