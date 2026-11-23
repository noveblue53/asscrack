// Profile pictures (src/network/avatar.mjs): the announce, the fetch on a miss, the limits and the trust of the
// picture lines. The first tests use fake sessions and a fake clock. The last tests start real nodes on 127.0.0.1.
// All results of this file are 127.0.0.1 results, not LAN results.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createAvatarLines, avatarHash, AVATAR_MAX_BYTES, AVATAR_LIMITS } from '../src/network/avatar.mjs'
import { createAsscrackNode } from '../src/network/node.mjs'
import { createClock } from './helpers/fake-clock.mjs'
import { protectedPair, waitFor } from './helpers/protected-pair.mjs'

function hubOf(bytes = null) {
    let own = bytes ? { hash: avatarHash(bytes), bytes } : null
    const subs = new Set()
    return {
        own: () => own,
        subscribe: fn => { subs.add(fn); return () => subs.delete(fn) },
        set(next) { own = next ? { hash: avatarHash(next), bytes: next } : null; for (const fn of subs) fn() }
    }
}

// Two sides A and B with fake sessions. Each line that one side sends goes to the handle() of the other side.
function pair({ hubA = hubOf(), hubB = hubOf(), allowedA = () => true, allowedB = () => true, limits = {} } = {}) {
    const clock = createClock()
    const sent = { A: [], B: [] }
    const events = { A: [], B: [] }
    const sides = {}
    const make = (name, other, hub, allowed) => createAvatarLines({
        hub, allowed, now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, limits,
        sessionFor: peer => peer === other ? { send: line => { sent[name].push(JSON.parse(line)); sides[other].handle(name, JSON.parse(line)); return true } } : undefined,
        sessions: () => [[other, { send: line => { sent[name].push(JSON.parse(line)); sides[other].handle(name, JSON.parse(line)); return true } }]],
        emit: (type, data) => events[name].push({ type, ...data })
    })
    sides.A = make('A', 'B', hubA, allowedA)
    sides.B = make('B', 'A', hubB, allowedB)
    return { clock, sent, events, ...sides }
}

test('avatar lines: a new session gets the hash, and a miss fetches the bytes once', () => {
    const picture = randomBytes(5000)
    const p = pair({ hubA: hubOf(picture) })
    p.A.opened('B')
    assert.deepEqual(p.sent.A, [{ type: 'avatar', v: 1, hash: avatarHash(picture), size: 5000 }])
    assert.deepEqual(p.events.B, [{ type: 'avatar', peerId: 'A', hash: avatarHash(picture) }])
    // The same announce again gives no second event.
    p.A.opened('B')
    assert.equal(p.events.B.length, 1)
    assert.equal(p.B.request('A', avatarHash(picture)), 'sent')
    assert.equal(p.sent.B[0].type, 'avatar-get')
    const data = p.events.B.find(e => e.type === 'avatar-data')
    assert.ok(data, 'the data event')
    assert.ok(Buffer.from(data.bytes).equals(picture))
    // A request for a hash that the peer did not announce is not sent.
    assert.equal(p.B.request('A', 'f'.repeat(64)), 'no')
})

test('avatar lines: no picture gives hash null, and a removed picture tells the peers', () => {
    const hubA = hubOf(randomBytes(100))
    const p = pair({ hubA })
    p.A.opened('B')
    hubA.set(null)
    p.A.share()
    assert.deepEqual(p.sent.A.at(-1), { type: 'avatar', v: 1, hash: null })
    assert.deepEqual(p.events.B.at(-1), { type: 'avatar', peerId: 'A', hash: null })
    assert.equal(p.B.peers().A, null)
})

test('avatar lines: unasked data, a wrong hash and too many bytes are refused', () => {
    const picture = randomBytes(1000)
    const p = pair({ hubA: hubOf(picture) })
    p.A.opened('B')
    // Data that B did not ask for.
    p.B.handle('A', { type: 'avatar-data', v: 1, hash: avatarHash(picture), data: picture.toString('base64') })
    assert.equal(p.events.B.filter(e => e.type === 'avatar-data').length, 0)
    // A request in flight that gets other bytes.
    const sessionless = createAvatarLines({ hub: hubOf(), sessionFor: () => ({ send: () => true }), sessions: () => [],
        emit: (type, data) => p.events.B.push({ type, ...data }) })
    sessionless.handle('X', { type: 'avatar', v: 1, hash: avatarHash(picture), size: 1000 })
    assert.equal(sessionless.request('X', avatarHash(picture)), 'sent')
    sessionless.handle('X', { type: 'avatar-data', v: 1, hash: avatarHash(picture), data: randomBytes(1000).toString('base64') })
    assert.equal(p.events.B.at(-1).type, 'avatar-failed')
    assert.equal(p.events.B.at(-1).reason, 'hash')
    // An announce with a size over the limit is ignored.
    const big = randomBytes(AVATAR_MAX_BYTES + 1)
    sessionless.handle('Y', { type: 'avatar', v: 1, hash: avatarHash(big), size: big.length })
    assert.equal(sessionless.peers().Y, undefined)
    // Data over the limit is refused before the hash check.
    sessionless.handle('Z', { type: 'avatar', v: 1, hash: avatarHash(big), size: 1000 })
    assert.equal(sessionless.request('Z', avatarHash(big)), 'sent')
    sessionless.handle('Z', { type: 'avatar-data', v: 1, hash: avatarHash(big), data: big.toString('base64') })
    assert.equal(p.events.B.at(-1).reason, 'size')
})

test('avatar lines: the announce, fetch and reply limits of one minute', () => {
    const p = pair({ hubA: hubOf(randomBytes(200)) })
    // Announces over the limit are ignored until the next minute.
    for (let i = 0; i < AVATAR_LIMITS.announcesPerMinute + 5; i++) {
        p.B.handle('A', { type: 'avatar', v: 1, hash: avatarHash(Buffer.from([i])), size: 1 })
    }
    assert.equal(p.events.B.filter(e => e.type === 'avatar').length, AVATAR_LIMITS.announcesPerMinute)
    p.clock.advance(60000)
    p.B.handle('A', { type: 'avatar', v: 1, hash: avatarHash(Buffer.from([200])), size: 1 })
    assert.equal(p.events.B.filter(e => e.type === 'avatar').length, AVATAR_LIMITS.announcesPerMinute + 1)

    // Fetches: the peer does not answer (its hub has another picture). Each request times out.
    const q = pair({ limits: { fetchTimeoutMs: 1000 } })
    let n = 0
    const next = () => {
        const hash = avatarHash(Buffer.from([++n]))
        q.B.handle('A', { type: 'avatar', v: 1, hash, size: 1 })
        return hash
    }
    for (let i = 0; i < AVATAR_LIMITS.fetchesPerMinute; i++) {
        assert.equal(q.B.request('A', next()), 'sent')
        q.clock.advance(1000)
    }
    assert.equal(q.events.B.filter(e => e.type === 'avatar-failed' && e.reason === 'timeout').length, AVATAR_LIMITS.fetchesPerMinute)
    const waiting = next()
    assert.equal(q.B.request('A', waiting), 'later')
    assert.equal(q.B.request('A', waiting), 'pending')
    const gets = () => q.sent.B.filter(l => l.type === 'avatar-get').length
    assert.equal(gets(), AVATAR_LIMITS.fetchesPerMinute)
    q.clock.advance(60000)
    assert.equal(gets(), AVATAR_LIMITS.fetchesPerMinute + 1, 'the waiting request goes when the window opens')

    // Replies: a peer that asks again and again gets at most repliesPerMinute answers.
    const picture = randomBytes(300)
    const r = pair({ hubA: hubOf(picture) })
    for (let i = 0; i < AVATAR_LIMITS.repliesPerMinute + 3; i++) r.A.handle('B', { type: 'avatar-get', v: 1, hash: avatarHash(picture) })
    assert.equal(r.sent.A.filter(l => l.type === 'avatar-data').length, AVATAR_LIMITS.repliesPerMinute)
    // A request for another hash gets no answer.
    r.clock.advance(60000)
    r.A.handle('B', { type: 'avatar-get', v: 1, hash: 'a'.repeat(64) })
    assert.equal(r.sent.A.filter(l => l.type === 'avatar-data').length, AVATAR_LIMITS.repliesPerMinute)
})

test('avatar lines: a peer that is not allowed gets no announce and no bytes, and its lines are ignored', () => {
    const picture = randomBytes(400)
    const p = pair({ hubA: hubOf(picture), allowedA: () => false, allowedB: () => false })
    p.A.opened('B')
    p.A.share()
    assert.deepEqual(p.sent.A, [])
    p.A.handle('B', { type: 'avatar-get', v: 1, hash: avatarHash(picture) })
    assert.deepEqual(p.sent.A, [])
    p.B.handle('A', { type: 'avatar', v: 1, hash: avatarHash(picture), size: 400 })
    assert.deepEqual(p.events.B, [])
})

test('avatar lines: with no hub (the terminal demo) a node sends nothing and ignores the lines', () => {
    const sent = []
    const events = []
    const lines = createAvatarLines({ hub: null, sessionFor: () => ({ send: l => { sent.push(l); return true } }),
        sessions: () => [['A', { send: l => { sent.push(l); return true } }]], emit: (type, data) => events.push({ type, ...data }) })
    lines.opened('A')
    lines.share()
    lines.handle('A', { type: 'avatar', v: 1, hash: 'a'.repeat(64), size: 10 })
    assert.deepEqual(sent, [])
    assert.deepEqual(events, [])
})

test('avatar lines on real nodes: a protected pair announces, fetches, changes and removes a picture', { timeout: 30000 }, async t => {
    const first = randomBytes(6000)
    const second = randomBytes(7000)
    const hubOwner = hubOf(first)
    const hubMember = hubOf()
    const { owner, member } = await protectedPair(t, {
        nodeOptions: role => ({ avatars: role === 'owner' ? hubOwner : hubMember })
    })
    const seen = []
    member.events.on('avatar', e => seen.push(e))
    const data = []
    member.events.on('avatar-data', e => data.push(e))
    await waitFor(() => member.peerAvatars()[owner.peerId] === avatarHash(first), 'announce of the first picture')
    // The member has no picture: the owner knows hash null.
    await waitFor(() => owner.peerAvatars()[member.peerId] === null, 'announce of no picture')
    assert.equal(member.requestAvatar(owner.peerId, avatarHash(first)), 'sent')
    await waitFor(() => data.length === 1, 'the bytes of the first picture')
    assert.ok(Buffer.from(data[0].bytes).equals(first))

    hubOwner.set(second)
    await waitFor(() => member.peerAvatars()[owner.peerId] === avatarHash(second), 'announce of the change')
    assert.equal(member.requestAvatar(owner.peerId, avatarHash(second)), 'sent')
    await waitFor(() => data.length === 2, 'the bytes of the second picture')
    assert.ok(Buffer.from(data[1].bytes).equals(second))

    hubOwner.set(null)
    await waitFor(() => member.peerAvatars()[owner.peerId] === null, 'announce of the removal')
    assert.deepEqual(seen.map(e => e.hash).slice(-2), [avatarHash(second), null])
})

test('avatar lines on real nodes: a node with no hub (as an old client) ignores the lines with no error', { timeout: 30000 }, async t => {
    const hub = hubOf(randomBytes(3000))
    const errors = []
    const warn = console.warn
    console.warn = (...args) => { errors.push(args.join(' ')); warn(...args) }
    t.after(() => { console.warn = warn })
    const { owner, member } = await protectedPair(t, { nodeOptions: role => (role === 'owner' ? { avatars: hub } : {}) })
    const events = []
    member.events.on('avatar', e => events.push(e))
    // The owner sends its announce; the member ignores it. The owner gets no announce from the member.
    hub.set(randomBytes(3001))
    assert.equal(owner.sendTo(member.peerId, { type: 'avatar-data', v: 1, hash: 'a'.repeat(64), data: 'AAAA' }), true)
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.deepEqual(events, [])
    assert.deepEqual(owner.peerAvatars(), {})
    assert.ok(member.peers().includes(owner.peerId), 'the session stays open')
    assert.deepEqual(errors.filter(e => /avatar|Ignored/.test(e)), [])
})

test('avatar lines on real nodes: a legacy room node sends the announce too', { timeout: 30000 }, async () => {
    const hub = hubOf(randomBytes(2000))
    const a = await createAsscrackNode({ room: 'avatar-legacy', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false, avatars: hub })
    const b = await createAsscrackNode({ room: 'avatar-legacy', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false, avatars: hubOf() })
    try {
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => b.peerAvatars()[a.peerId] === hub.own().hash, 'announce in a legacy room')
    } finally {
        await Promise.allSettled([a.stop(), b.stop()])
    }
})
