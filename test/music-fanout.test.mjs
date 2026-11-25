// Unit tests for src/network/music-fanout.mjs (pure tree coordinator + Opus frame forwarder).
// No network or libp2p. All results are 127.0.0.1 / pure module unit tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    MUSIC_FANOUT_DEFAULTS,
    createMusicFanout,
    createMusicForwarder
} from '../src/network/music-fanout.mjs'

function makeClock(start = 1000) {
    let t = start
    return {
        now: () => t,
        advance: ms => { t += ms; return t },
        set: ms => { t = ms; return t }
    }
}

test('MUSIC_FANOUT_DEFAULTS matches specification', () => {
    assert.deepEqual(MUSIC_FANOUT_DEFAULTS, {
        maxHop: 3,
        maxListeners: 24,
        maxDirectListeners: 2,
        maxRedirects: 3,
        maxChildrenPerNode: 6,
        defaultMaxChildren: 2,
        redirectConfirmMs: 8000,
        parentFailBackoffMs: 30000,
        maxChildQueueFrames: 50,
        dedupWindow: 64
    })
})

test('breadth-first placement up to 24 listeners and full rejection at 25', () => {
    const clock = makeClock()
    const fanout = createMusicFanout({
        djPeerId: 'dj',
        channelId: 'lounge',
        now: clock.now,
        defaultMaxChildren: 4
    })

    // First 2 attach direct to DJ (hop 1)
    for (let i = 1; i <= 2; i++) {
        const res = fanout.requestJoin(`l-${String(i).padStart(2, '0')}`, { capable: true, maxChildren: 4 })
        assert.deepEqual(res, { action: 'direct', parentPeerId: 'dj', hop: 1 })
    }
    assert.deepEqual(fanout.childrenOf('dj').sort(), ['l-01', 'l-02'])

    // Listeners 3..10 fill hop 2 evenly (4 each under l-01 and l-02)
    for (let i = 3; i <= 10; i++) {
        const id = `l-${String(i).padStart(2, '0')}`
        const res = fanout.requestJoin(id, { capable: true, maxChildren: 4 })
        assert.equal(res.action, 'redirect')
        assert.equal(res.hop, 2)
        const expectedParent = i % 2 === 1 ? 'l-01' : 'l-02'
        assert.equal(res.parentPeerId, expectedParent)
        assert.equal(fanout.confirmChild(res.parentPeerId, id).ok, true)
    }

    // Listeners 11..24 fill hop 3 (14 listeners across hop-2 parents)
    for (let i = 11; i <= 24; i++) {
        const id = `l-${String(i).padStart(2, '0')}`
        const res = fanout.requestJoin(id, { capable: true, maxChildren: 4 })
        assert.equal(res.action, 'redirect')
        assert.equal(res.hop, 3)
        assert.equal(fanout.confirmChild(res.parentPeerId, id).ok, true)
    }

    const st = fanout.stats()
    assert.equal(st.listeners, 24)
    assert.equal(st.directListeners, 2)
    assert.equal(st.maxHop, 3)
    assert.deepEqual(st.byHop, { 1: 2, 2: 8, 3: 14 })
    assert.equal(fanout.edges().length, 24)
    assert.equal(fanout.parentOf('l-01'), 'dj')
    assert.equal(fanout.parentOf('l-03'), 'l-01')

    // 25th listener is rejected as full
    assert.deepEqual(fanout.requestJoin('l-25', { capable: true }), { action: 'reject', reason: 'full' })
})

test('hop limit, loop prevention, and maxRedirects fallback to direct', () => {
    const clock = makeClock()
    const fanout = createMusicFanout({
        djPeerId: 'dj',
        now: clock.now,
        maxDirectListeners: 1,
        defaultMaxChildren: 1
    })

    // Hop 1: p1 -> dj
    assert.equal(fanout.requestJoin('p1').action, 'direct')
    // Hop 2: p2 -> p1
    const r2 = fanout.requestJoin('p2')
    assert.equal(r2.action, 'redirect')
    assert.equal(r2.parentPeerId, 'p1')
    assert.equal(r2.hop, 2)
    assert.equal(fanout.confirmChild('p1', 'p2').ok, true)

    // Hop 3: p3 -> p2
    const r3 = fanout.requestJoin('p3')
    assert.equal(r3.action, 'redirect')
    assert.equal(r3.parentPeerId, 'p2')
    assert.equal(r3.hop, 3)
    assert.equal(fanout.confirmChild('p2', 'p3').ok, true)

    // Hop 3 node p3 cannot accept children
    assert.deepEqual(fanout.confirmChild('p3', 'p4'), { ok: false, reason: 'invalid-edge' })

    // Loop check: p2 cannot confirm its ancestor p1 as a child
    assert.deepEqual(fanout.confirmChild('p2', 'p1'), { ok: false, reason: 'loop' })
    assert.deepEqual(fanout.confirmChild('p1', 'p1'), { ok: false, reason: 'invalid-edge' })

    // Redirect limit: after 3 redirects, 4th attempt attaches direct to DJ even if a parent is available
    const fanout2 = createMusicFanout({
        djPeerId: 'dj',
        now: clock.now,
        maxDirectListeners: 4,
        defaultMaxChildren: 2
    })
    // Fill 4 direct slots so redirects are used
    assert.equal(fanout2.requestJoin('h1').action, 'direct')
    assert.equal(fanout2.requestJoin('h2').action, 'direct')
    assert.equal(fanout2.requestJoin('h3').action, 'direct')
    assert.equal(fanout2.requestJoin('h4').action, 'direct')

    const seenParents = new Set()
    for (let attempt = 1; attempt <= 3; attempt++) {
        const dec = fanout2.requestJoin('retry-peer')
        assert.equal(dec.action, 'redirect')
        seenParents.add(dec.parentPeerId)
    }
    assert.equal(seenParents.size, 3)
    const fourth = fanout2.requestJoin('retry-peer')
    assert.deepEqual(fourth, { action: 'direct', parentPeerId: 'dj', hop: 1 })
})

test('parent failure backoff and pending redirect expiry', () => {
    const clock = makeClock(1000)
    const fanout = createMusicFanout({
        djPeerId: 'dj',
        now: clock.now,
        maxDirectListeners: 2,
        defaultMaxChildren: 2
    })

    assert.equal(fanout.requestJoin('p1').action, 'direct')
    assert.equal(fanout.requestJoin('p2').action, 'direct')

    // v1 redirected to p1, then reports failure
    const r1 = fanout.requestJoin('v1')
    assert.equal(r1.parentPeerId, 'p1')
    assert.equal(fanout.reportFailure('v1', 'p1').ok, true)
    assert.equal(fanout.isProbation('v1', 'p1'), true)

    // Next join for v1 skips p1 and picks p2
    const r2 = fanout.requestJoin('v1')
    assert.equal(r2.action, 'redirect')
    assert.equal(r2.parentPeerId, 'p2')

    // Pending redirect expires after redirectConfirmMs (8000ms), freeing slot on p2
    clock.advance(8000)
    fanout.pruneExpired()
    assert.equal(fanout.stats().pending, 0)

    // After parentFailBackoffMs (30000ms total), p1 is eligible again for v1
    clock.advance(22000)
    assert.equal(fanout.isProbation('v1', 'p1'), false)
    const r3 = fanout.requestJoin('v1')
    assert.equal(r3.action, 'redirect')
    assert.equal(r3.parentPeerId, 'p1')
})

test('parent disconnect removes subtree and supports reparenting orphans', () => {
    const clock = makeClock()
    const fanout = createMusicFanout({
        djPeerId: 'dj',
        now: clock.now,
        maxDirectListeners: 2,
        defaultMaxChildren: 2
    })

    assert.equal(fanout.requestJoin('p1').action, 'direct')
    assert.equal(fanout.requestJoin('p2').action, 'direct')

    const r1 = fanout.requestJoin('c1')
    assert.equal(r1.parentPeerId, 'p1')
    assert.equal(fanout.confirmChild('p1', 'c1').ok, true)

    const r2 = fanout.requestJoin('c2')
    assert.equal(r2.parentPeerId, 'p2')
    assert.equal(fanout.confirmChild('p2', 'c2').ok, true)

    const r3 = fanout.requestJoin('c3')
    assert.equal(r3.parentPeerId, 'p1')
    assert.equal(fanout.confirmChild('p1', 'c3').ok, true)

    // p1 disconnects; c1 and c3 are orphaned
    const rem = fanout.removePeer('p1')
    assert.equal(rem.removed, true)
    assert.deepEqual(rem.orphaned.sort(), ['c1', 'c3'])
    assert.equal(fanout.parentOf('p1'), null)
    assert.equal(fanout.parentOf('c1'), null)

    // Reparent c1 and c3: c1 takes open direct slot (hop 1, load 0), then c3 goes to least-loaded hop-1 parent (c1)
    const reparented = fanout.reparent(rem.orphaned.sort())
    assert.deepEqual(reparented[0], { peerId: 'c1', decision: { action: 'direct', parentPeerId: 'dj', hop: 1 } })
    assert.equal(reparented[1].peerId, 'c3')
    assert.equal(reparented[1].decision.action, 'redirect')
    assert.equal(reparented[1].decision.parentPeerId, 'c1')
})

test('legacy 1.0.9 pass-through attaches directly without redirect and never forwards', () => {
    const clock = makeClock()
    const fanout = createMusicFanout({
        djPeerId: 'dj',
        now: clock.now,
        maxDirectListeners: 1,
        defaultMaxChildren: 2
    })

    // Fill capable direct slot
    assert.deepEqual(fanout.requestJoin('cap-1', { capable: true }), {
        action: 'direct',
        parentPeerId: 'dj',
        hop: 1
    })

    // Legacy 1.0.9 peer (capable: false) still attaches direct without redirect
    assert.deepEqual(fanout.requestJoin('legacy-1', { capable: false }), {
        action: 'direct',
        parentPeerId: 'dj',
        hop: 1
    })

    // Legacy peer is never selected as a parent even if cap-1 is full
    const j1 = fanout.requestJoin('cap-2')
    const j2 = fanout.requestJoin('cap-3')
    assert.equal(j1.parentPeerId, 'cap-1')
    assert.equal(j2.parentPeerId, 'cap-1')
    assert.equal(fanout.confirmChild('cap-1', 'cap-2').ok, true)
    assert.equal(fanout.confirmChild('cap-1', 'cap-3').ok, true)

    // Confirming a child under legacy-1 is rejected
    assert.deepEqual(fanout.confirmChild('legacy-1', 'cap-4'), { ok: false, reason: 'invalid-edge' })
})

test('setForwardingCap(peerId, 0) sheds active and pending children and blocks future redirects', () => {
    const clock = makeClock()
    const fanout = createMusicFanout({
        djPeerId: 'dj',
        now: clock.now,
        maxDirectListeners: 1,
        defaultMaxChildren: 3
    })

    assert.equal(fanout.requestJoin('p1').action, 'direct')

    const r1 = fanout.requestJoin('c1')
    assert.equal(fanout.confirmChild('p1', 'c1').ok, true)
    const r2 = fanout.requestJoin('c2')
    assert.equal(fanout.confirmChild('p1', 'c2').ok, true)
    // c3 left pending under p1
    const r3 = fanout.requestJoin('c3')
    assert.equal(r3.action, 'redirect')
    assert.equal(r3.parentPeerId, 'p1')

    const shedRes = fanout.setForwardingCap('p1', 0)
    assert.equal(shedRes.ok, true)
    assert.equal(shedRes.cap, 0)
    assert.deepEqual(shedRes.shed.sort(), ['c1', 'c2', 'c3'])
    assert.deepEqual(fanout.childrenOf('p1'), [])

    // New join cannot be redirected to p1 while cap is 0; falls back to direct
    const next = fanout.requestJoin('c4')
    assert.deepEqual(next, { action: 'direct', parentPeerId: 'dj', hop: 1 })
})

test('topology idlePeers and asymmetric links are excluded from parent selection', () => {
    const clock = makeClock()
    const topo = {
        idlePeers: new Set(['p1']),
        links: {
            dj: ['p1', 'p2', 'v1'],
            p1: ['dj', 'v1'],
            p2: ['dj', 'v1'],
            v1: ['dj', 'p1', 'p2']
        },
        kinds: {
            dj: { p1: 'mesh', p2: 'mesh', v1: 'mesh' },
            p1: { dj: 'mesh', v1: 'mesh' },
            p2: { dj: 'mesh', v1: 'mesh' },
            v1: { dj: 'mesh', p1: 'mesh', p2: 'mesh' }
        }
    }
    const fanout = createMusicFanout({
        djPeerId: 'dj',
        now: clock.now,
        getTopology: () => topo,
        maxDirectListeners: 2,
        defaultMaxChildren: 2
    })

    assert.equal(fanout.requestJoin('p1').action, 'direct')
    assert.equal(fanout.requestJoin('p2').action, 'direct')

    // p1 is idle, so v1 must be redirected to p2
    const r = fanout.requestJoin('v1')
    assert.equal(r.action, 'redirect')
    assert.equal(r.parentPeerId, 'p2')
})

test('forwarder: per-child queue overflow drops oldest and isolates slow child from healthy child', () => {
    const drops = []
    const healthyReceived = []
    const slowReceived = []
    let slowBlocked = true

    const forwarder = createMusicForwarder({
        maxQueueFrames: 50,
        onDrop: (childId, frame) => drops.push({ childId, seq: frame.seq })
    })

    forwarder.addChild('healthy', {
        send: frame => {
            healthyReceived.push(frame.seq)
            return true
        }
    })
    forwarder.addChild('slow', {
        send: frame => {
            if (slowBlocked) return false
            slowReceived.push(frame.seq)
            return true
        }
    })

    // Frame 0 triggers backpressure on slow child; frames 1..55 queue up and overflow by 5
    for (let seq = 0; seq <= 55; seq++) {
        const res = forwarder.pushFrame({ origin: 'dj', seq, data: new Uint8Array([seq & 0xff]) })
        assert.equal(res.duplicate, false)
    }

    // Healthy child received all 56 frames immediately with 0 drops
    assert.equal(healthyReceived.length, 56)
    assert.equal(healthyReceived[0], 0)
    assert.equal(healthyReceived[55], 55)

    // Slow child dropped oldest 5 frames (seq 1..5) after seq 0 was popped and hit backpressure
    // Wait: seq 0 was popped by send() returning false, so seq 1..55 = 55 frames -> 5 drops (1..5), 50 left (6..55)
    assert.equal(drops.length, 5)
    assert.deepEqual(drops.map(d => d.seq), [1, 2, 3, 4, 5])
    assert.equal(forwarder.queueLength('slow'), 50)

    // Unblock slow child and drain remaining 50 frames (6..55)
    slowBlocked = false
    const drained = forwarder.drain('slow')
    assert.equal(drained, 50)
    assert.equal(slowReceived[0], 6)
    assert.equal(slowReceived[49], 55)
    assert.equal(forwarder.queueLength('slow'), 0)
})

test('forwarder: deduplicates sequence numbers per origin within dedupWindow', () => {
    const received = []
    const forwarder = createMusicForwarder({ dedupWindow: 64 })
    forwarder.addChild('c1', { send: f => { received.push(`${f.origin}:${f.seq}`); return true } })

    assert.equal(forwarder.pushFrame({ origin: 'dj', seq: 1, data: new Uint8Array([1]) }).duplicate, false)
    assert.equal(forwarder.pushFrame({ origin: 'dj', seq: 1, data: new Uint8Array([1]) }).duplicate, true)
    // Same seq from a different origin is NOT a duplicate
    assert.equal(forwarder.pushFrame({ origin: 'dj2', seq: 1, data: new Uint8Array([1]) }).duplicate, false)

    // Push 64 more frames for 'dj' (seq 2..65) to evict seq 1 from the 64-entry window
    for (let seq = 2; seq <= 65; seq++) {
        assert.equal(forwarder.pushFrame({ origin: 'dj', seq, data: new Uint8Array([1]) }).duplicate, false)
    }
    // seq 2 is still in window -> duplicate; seq 1 was evicted -> accepted again
    assert.equal(forwarder.pushFrame({ origin: 'dj', seq: 2, data: new Uint8Array([1]) }).duplicate, true)
    assert.equal(forwarder.pushFrame({ origin: 'dj', seq: 1, data: new Uint8Array([1]) }).duplicate, false)
    assert.equal(forwarder.stats().duplicates, 2)
    assert.equal(received.length, 67)
})

test('forwarder: revocation cutoff stops forwarding when allowed(childPeerId) becomes false', () => {
    const allowedSet = new Set(['c1', 'c2'])
    const revoked = []
    const received = { c1: [], c2: [] }

    const forwarder = createMusicForwarder({
        allowed: id => allowedSet.has(id),
        onRevoked: id => revoked.push(id)
    })

    assert.equal(forwarder.addChild('c1', { send: f => { received.c1.push(f.seq); return true } }).ok, true)
    assert.equal(forwarder.addChild('c2', { send: f => { received.c2.push(f.seq); return true } }).ok, true)
    assert.deepEqual(forwarder.addChild('blocked', { send: () => true }), { ok: false, reason: 'refused' })

    forwarder.pushFrame({ origin: 'dj', seq: 1, data: new Uint8Array([1]) })
    assert.deepEqual(received.c1, [1])
    assert.deepEqual(received.c2, [1])

    // Revoke c2
    allowedSet.delete('c2')
    forwarder.pushFrame({ origin: 'dj', seq: 2, data: new Uint8Array([2]) })

    assert.deepEqual(received.c1, [1, 2])
    assert.deepEqual(received.c2, [1])
    assert.equal(forwarder.hasChild('c2'), false)
    assert.deepEqual(revoked, ['blocked', 'c2'])
})
