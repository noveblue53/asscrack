import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { multiaddr } from '@multiformats/multiaddr'
import { createAsscrackNode, CHAT_PROTOCOL } from '../src/network/node.mjs'
import { createHistory, HISTORY_LIMIT, MAX_MESSAGE_BYTES, historyLines, validHistoryItem } from '../src/network/history.mjs'
import { createChatSession, MAX_CHAT_FRAME_BYTES } from '../src/network/chat-session.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'

const base = {
    room: 'history', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false,
    heartbeatInterval: 300, hostTimeout: 1500, electionDelay: 1000
}

async function makeNodes(count, seeds = []) {
    const nodes = []
    for (let i = 0; i < count; i++) nodes.push(await createAsscrackNode({ ...base, seedHistory: seeds[i] ?? [] }))
    return nodes
}

async function waitUntil(check, limit) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        if (check()) return
        await delay(50)
    }
    assert.ok(check(), `Condition not true within ${limit} ms`)
}

async function connectPair(a, b) {
    await a.connect(b.getMultiaddrs()[0])
    await waitUntil(() => a.peers().includes(b.peerId) && b.peers().includes(a.peerId), 5000)
}

async function mesh(nodes) {
    for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++) await connectPair(nodes[i], nodes[j])
}

function agree(nodes) {
    const first = nodes[0].host()
    if (first === null) return false
    return nodes.every(n => n.host()?.peerId === first.peerId && n.host()?.term === first.term)
}

async function stopAll(nodes) {
    await Promise.allSettled(nodes.map(n => n.stop()))
}

function noDuplicates(list) {
    return new Set(list.map(m => m.id)).size === list.length
}

async function sendThree(nodes) {
    nodes[0].send('one')
    await delay(5)
    nodes[1].send('two')
    await delay(5)
    nodes[0].send('three')
    await waitUntil(() => nodes.every(n => n.history().length === 3), 5000)
}

describe('history', { concurrency: 4 }, () => {

test('a: a late member gets the history from the host', { timeout: 30000 }, async () => {
    const nodes = await makeNodes(3)
    try {
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        await sendThree(nodes)
        const hostNode = nodes.find(n => n.isHost())
        const d = (await makeNodes(1))[0]
        nodes.push(d)
        const t0 = Date.now()
        for (const n of nodes.slice(0, 3)) await connectPair(d, n)
        await waitUntil(() => d.history().length === 3, 5000)
        console.log(`test a: ${Date.now() - t0} ms`)
        await delay(500)
        assert.deepEqual(d.history().map(m => m.id), hostNode.history().map(m => m.id))
        assert.ok(noDuplicates(d.history()))
        assert.equal(d.history().length, 3)
    } finally {
        await stopAll(nodes)
    }
})

test('b: after a failover, the new host gives the history', { timeout: 40000 }, async () => {
    const nodes = await makeNodes(3)
    try {
        await mesh(nodes)
        await waitUntil(() => agree(nodes), 5000)
        await sendThree(nodes)
        const old = nodes.find(n => n.isHost())
        const others = nodes.filter(n => n !== old)
        await old.stop()
        await waitUntil(() => agree(others) && others[0].host().peerId !== old.peerId, 10000)
        const d = (await makeNodes(1))[0]
        nodes.push(d)
        const t0 = Date.now()
        for (const n of others) await connectPair(d, n)
        await waitUntil(() => d.history().length === 3, 10000)
        console.log(`test b: ${Date.now() - t0} ms`)
        await delay(500)
        assert.equal(d.history().length, 3)
        assert.ok(noDuplicates(d.history()))
        assert.deepEqual(d.history().map(m => m.id), others[0].history().map(m => m.id))
    } finally {
        await stopAll(nodes)
    }
})

test('c: a buffer that gets 250 messages keeps the last 200', () => {
    const t0 = Date.now()
    const h = createHistory(200)
    for (let i = 0; i < 250; i++) h.add({ id: `m${String(i).padStart(3, '0')}`, from: 'x', text: `t${i}`, time: 1000 + i })
    const list = h.list()
    console.log(`test c: ${Date.now() - t0} ms`)
    assert.equal(list.length, 200)
    assert.equal(list[0].text, 't50')
    assert.equal(list[199].text, 't249')
})

test('d: a chat line with no id gives a message event with an id', { timeout: 15000 }, async () => {
    const nodes = await makeNodes(2)
    let raw = null
    try {
        const [a, b] = nodes
        const t0 = Date.now()
        const got = new Promise(resolve => b.events.once('message', resolve))
        const stream = await a.libp2p.dialProtocol(multiaddr(b.getMultiaddrs()[0]), CHAT_PROTOCOL)
        raw = createChatSession(stream, { onMessage: () => {} })
        raw.send(JSON.stringify({ from: 'old', text: 'hello', time: Date.now() }))
        const message = await got
        console.log(`test d: ${Date.now() - t0} ms`)
        assert.equal(typeof message.id, 'string')
        assert.ok(message.id.length > 0)
        assert.equal(message.text, 'hello')
        assert.equal(b.history().length, 1)
        assert.equal(b.history()[0].id, message.id)
    } finally {
        raw?.done.catch(() => {})
        raw?.close()
        await stopAll(nodes)
    }
})

test('e: a member with a session before the first election gets the history', { timeout: 30000 }, async () => {
    // Each node has a line that the other node does not have. No host exists yet.
    // A send with no session stays local (milestone 6), thus the lines come from seedHistory.
    const now = Date.now()
    const nodes = await makeNodes(2, [
        [{ id: 'solo-0', from: 'zero', text: 'solo zero', time: now }],
        [{ id: 'solo-1', from: 'one', text: 'solo one', time: now + 1 }]
    ])
    try {
        await connectPair(nodes[0], nodes[1])
        assert.equal(nodes[0].host(), null)
        await waitUntil(() => agree(nodes), 5000)
        const hostNode = nodes.find(n => n.isHost())
        const member = nodes.find(n => !n.isHost())
        const hostLine = hostNode.history().find(m => m.text.startsWith('solo'))
        await waitUntil(() => member.history().some(m => m.id === hostLine.id), 5000)
        await delay(500)
        assert.ok(noDuplicates(member.history()))
        assert.equal(member.history().length, 2)
    } finally {
        await stopAll(nodes)
    }
})

test('history batches fit by encoded bytes and record count, including JSON escaping', () => {
    const record = (id, text) => ({ id, from: 'A', text, time: 1 })
    const first = record('a', '\0'.repeat(MAX_MESSAGE_BYTES - 1))
    const second = record('b', '')
    const envelope = JSON.stringify({ type: 'history', messages: [first, second] })
    const roomLeft = MAX_CHAT_FRAME_BYTES - Buffer.byteLength(envelope)
    second.text = '\0'.repeat(Math.floor(roomLeft / 6)) + 'x'.repeat(roomLeft % 6)
    assert.ok(validHistoryItem(first) && validHistoryItem(second))
    const [exact, next] = [...historyLines([first, second, record('c', 'x')])]
    assert.equal(Buffer.byteLength(exact), MAX_CHAT_FRAME_BYTES)
    assert.deepEqual(JSON.parse(exact).messages, [first, second])
    assert.deepEqual(JSON.parse(next).messages, [record('c', 'x')])

    const short = Array.from({ length: HISTORY_LIMIT + 1 }, (_, i) => record(String(i), 'x'))
    assert.deepEqual([...historyLines(short)].map(line => JSON.parse(line).messages.length), [200, 1])
    assert.equal(validHistoryItem({ ...first, text: first.text + 'x' }), false)
    assert.equal(validHistoryItem({ ...first, id: '🌍'.repeat(33) }), false)
    assert.equal(validHistoryItem({ ...first, time: Infinity }), false)
})

test('127.0.0.1: a late join receives a split replay and rejects invalid live and replay records', { timeout: 15000 }, async () => {
    const records = Array.from({ length: 200 }, (_, i) =>
        ({ id: String(i), time: i, from: 'A', text: '\0'.repeat(600) }))
    const a = await createAsscrackNode({ ...base, fullNode: true, name: 'A', seedHistory: records })
    const b = await createAsscrackNode({ ...base, fullNode: false })
    const batches = []
    const live = []
    b.events.on('history', ({ messages }) => batches.push(messages))
    b.events.on('live', m => live.push(m))
    try {
        await connectPair(a, b)
        await waitUntil(() => b.host()?.peerId === a.peerId && b.history().length === 200, 5000)
        assert.deepEqual(b.history(), records)
        assert.ok(batches.filter(batch => batch.length).length > 1)

        const bad = { id: 'bad', time: 1, from: '', text: '🌍'.repeat(MAX_MESSAGE_BYTES / 4) + 'x' }
        const marker = { id: 'marker', time: 300, from: 'A', text: 'still connected' }
        assert.throws(() => a.sendRecord(bad.text), /UTF-8 bytes/)
        a.sendTo(b.peerId, bad)
        a.sendTo(b.peerId, { type: 'history', messages: [{ ...marker, id: 'too-many' }, ...records.map(m => ({ ...m, text: '-' }))] })
        a.sendTo(b.peerId, { type: 'history', messages: [bad, { ...marker, id: 'valid' }] })
        a.sendTo(b.peerId, marker)
        await waitUntil(() => live.some(m => m.id === marker.id), 5000)
        assert.deepEqual(live.map(m => m.id), ['marker'])
        assert.ok(b.history().some(m => m.id === 'valid'))
        assert.ok(!b.history().some(m => ['too-many', 'bad'].includes(m.id)))
    } finally {
        await stopAll([a, b])
    }
})

test('127.0.0.1: pending replay waits for host authority and drops cleared IDs', { timeout: 15000 }, async () => {
    const [a, b] = await makeNodes(2)
    let raw
    try {
        const stream = await a.libp2p.dialProtocol(multiaddr(b.getMultiaddrs()[0]), CHAT_PROTOCOL)
        raw = createChatSession(stream, { onMessage() {} })
        const control = m => assert.equal(raw.send(JSON.stringify(m)), true)
        const row = id => ({ id, from: 'a', time: 1, text: id })
        control({ type: 'history', messages: [row('one'), row('cleared')] })
        control({ type: 'history', messages: [row('two')] })
        control(row('marker'))  // delivery is ordered on this stream
        await waitUntil(() => b.history().some(m => m.id === 'marker'), 5000)
        assert.deepEqual(b.history().map(m => m.id), ['marker'])
        b.removeHistory(['cleared', 'marker'])
        control({ type: 'host', host: a.peerId, term: 7 })
        await waitUntil(() => b.host()?.peerId === a.peerId, 5000)
        assert.deepEqual(b.history().map(m => m.id), ['one', 'two'])
    } finally {
        raw?.done.catch(() => {})
        raw?.close()
        await stopAll([a, b])
    }
})

test('attachment projection keeps only validated public fields and downgrades invalid descriptors to text', () => {
    const history = createHistory()
    const attachment = { id: 'b2c204e7-4d85-4844-b5ca-9e2574d350e5', source: '12D3KooWQ2SdLZ5PxnAqMgXdLDyqBXhAVabbqVmmZbrXQY1zXkbP',
        sha256: 'a'.repeat(64), size: 32, name: 'image.png', kind: 'image', expires: 1234 }
    const line = { id: 'message', from: 'Sam', text: 'caption and filename', time: 10 }
    history.add({ ...line, attachment: { ...attachment, localPath: 'private' } })
    history.add({ ...line, id: 'bad', attachment: { ...attachment, name: '../note.png' } })
    const byId = Object.fromEntries(history.list().map(row => [row.id, row]))
    assert.deepEqual(byId.message.attachment, attachment)
    assert.deepEqual(byId.bad, { ...line, id: 'bad' })
})

test('127.0.0.1: protected room non-host members backfill own messages to reconnecting host without duplicates or loops', { timeout: 40000 }, async () => {
    const room = 'history-backfill', roomKey = newRoomKey()
    const timing = { discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'], heartbeatInterval: 100, hostTimeout: 700, electionDelay: 300 }
    const ownerId = createDeviceIdentity()
    const relayId = createDeviceIdentity()
    const memberId = createDeviceIdentity()
    const ownerMembership = createRoomMembership({ identity: ownerId, room, roomKey, lan: false })
    const relayDesc = ownerMembership.issue(relayId.id, false)
    const memberDesc = ownerMembership.issue(memberId.id, false)

    const nodes = []
    const start = async opts => { const n = await createAsscrackNode({ room, roomKey, ...timing, ...opts }); nodes.push(n); return n }
    try {
        const O0 = await start({ membership: ownerMembership, name: 'Owner', fullNode: false, electionDelay: 5000 })
        const R = await start({ membership: restoreRoomMembership({ identity: relayId, room, roomKey, descriptor: relayDesc }), name: 'Relay', fullNode: true, allowPrivateFullNode: true })
        const M = await start({ membership: restoreRoomMembership({ identity: memberId, room, roomKey, descriptor: memberDesc }), name: 'Member', fullNode: false })

        await connectPair(R, O0)
        await connectPair(M, O0)
        await connectPair(M, R)
        await waitUntil(() => R.memberState().admitted && M.memberState().admitted, 8000)

        const ownerSnap = O0.membershipSnapshot()
        await O0.stop()
        await waitUntil(() => !R.peers().includes(O0.peerId) && !M.peers().includes(O0.peerId), 5000)
        assert.equal(R.host(), null)
        assert.equal(M.host(), null)

        assert.equal(M.send('waow'), 1)
        assert.equal(R.send('relay-note'), 1)
        await waitUntil(() => R.history().some(m => m.text === 'waow') && M.history().some(m => m.text === 'relay-note'), 5000)

        const O = await start({ membership: restoreRoomMembership({ identity: ownerId, room, roomKey, descriptor: ownerSnap }), name: 'Owner', fullNode: false })
        const events = { O: [], R: [], M: [] }
        O.events.on('history', ({ messages }) => events.O.push(messages))
        R.events.on('history', ({ messages }) => events.R.push(messages))
        M.events.on('history', ({ messages }) => events.M.push(messages))

        await connectPair(O, R)
        await connectPair(O, M)
        await waitUntil(() => agree([O, R, M]) && O.isHost() &&
            O.history().some(m => m.text === 'waow') &&
            O.history().some(m => m.text === 'relay-note'), 10000)

        const waow = O.history().find(m => m.text === 'waow')
        const relayNote = O.history().find(m => m.text === 'relay-note')
        assert.equal(waow.from, 'Member')
        assert.equal(waow.unverified, undefined)
        assert.equal(relayNote.from, 'Relay')
        assert.equal(relayNote.unverified, undefined)
        assert.ok(events.O.some(batch => batch.some(m => m.text === 'waow')))
        assert.ok(noDuplicates(O.history()))
        assert.ok(noDuplicates(R.history()))
        assert.ok(noDuplicates(M.history()))

        // No-loop / deduplication check: history event counts remain stable.
        const countsBefore = { O: events.O.length, R: events.R.length, M: events.M.length }
        await delay(600)
        assert.deepEqual({ O: events.O.length, R: events.R.length, M: events.M.length }, countsBefore)
        assert.ok(noDuplicates(O.history()))
        assert.ok(noDuplicates(R.history()))
        assert.ok(noDuplicates(M.history()))
    } finally {
        await stopAll(nodes)
    }
})

})
