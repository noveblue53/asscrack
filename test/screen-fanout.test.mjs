// Unit tests for src/network/screen-fanout.mjs (Session 2 — Pure Tree Coordinator).
// No network or libp2p. All results are 127.0.0.1 / pure module unit tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGlobalSlotLedger, createScreenFanout, FANOUT_DEFAULTS } from '../src/network/screen-fanout.mjs'

function makeClock(start = 1000) {
    let t = start
    return {
        now: () => t,
        advance: ms => { t += ms; return t },
        set: ms => { t = ms; return t }
    }
}

function makeFullMeshTopology(peers, { relayPairs = [], idlePeers = [], useLinkKinds = false } = {}) {
    const relaySet = new Set(relayPairs.map(([a, b]) => `${a}\n${b}`))
    const links = {}
    const kindsMap = {}
    for (const a of peers) {
        links[a] = []
        kindsMap[a] = {}
        for (const b of peers) {
            if (a === b) continue
            links[a].push(b)
            kindsMap[a][b] = relaySet.has(`${a}\n${b}`) || relaySet.has(`${b}\n${a}`) ? 'relay' : 'mesh'
        }
    }
    return useLinkKinds
        ? { links, linkKinds: kindsMap, idlePeers }
        : { links, kinds: kindsMap, idlePeers }
}

test('placement: breadth-first, least-loaded across symmetric mesh links', () => {
    const clock = makeClock()
    const peers = ['sharer', 'p1', 'p2', 'v1', 'v2', 'v3', 'v4', 'v5']
    const topo = makeFullMeshTopology(peers)
    const fanout = createScreenFanout({
        selfId: 'sharer',
        getTopology: () => topo,
        now: clock.now,
        options: { maxDirectViewers: 2 }
    })

    // First two viewers attach direct (hop 1)
    const d1 = fanout.planWatch('p1', { fanout: 1, maxChildren: 2 })
    const d2 = fanout.planWatch('p2', { fanout: 1, maxChildren: 2 })
    assert.deepEqual(d1, { action: 'direct', parentPeerId: 'sharer', hop: 1 })
    assert.deepEqual(d2, { action: 'direct', parentPeerId: 'sharer', hop: 1 })

    // Next viewers should balance evenly across p1 and p2 (least-loaded at hop 1)
    const r1 = fanout.planWatch('v1', { fanout: 1, maxChildren: 2 })
    assert.equal(r1.action, 'redirect')
    assert.equal(r1.parentPeerId, 'p1')
    assert.equal(r1.hop, 2)
    assert.equal(r1.tokenSeq, 1)
    assert.equal(fanout.handleReport('p1', { event: 'child-joined', childPeerId: 'v1' }).ok, true)

    const r2 = fanout.planWatch('v2', { fanout: 1, maxChildren: 2 })
    assert.equal(r2.action, 'redirect')
    assert.equal(r2.parentPeerId, 'p2')
    assert.equal(r2.hop, 2)
    assert.equal(r2.tokenSeq, 2)
    assert.equal(fanout.handleReport('p2', { event: 'child-joined', childPeerId: 'v2' }).ok, true)

    // Still filling hop-2 slots before hop-3
    const r3 = fanout.planWatch('v3', { fanout: 1, maxChildren: 2 })
    assert.equal(r3.action, 'redirect')
    assert.equal(r3.parentPeerId, 'p1')
    assert.equal(r3.hop, 2)
    assert.equal(fanout.handleReport('p1', { event: 'child-joined', childPeerId: 'v3' }).ok, true)

    const r4 = fanout.planWatch('v4', { fanout: 1, maxChildren: 2 })
    assert.equal(r4.action, 'redirect')
    assert.equal(r4.parentPeerId, 'p2')
    assert.equal(r4.hop, 2)
    assert.equal(fanout.handleReport('p2', { event: 'child-joined', childPeerId: 'v4' }).ok, true)

    // Now hop-1 parents are full; v5 goes to hop 3 under a hop-2 parent (v1)
    const r5 = fanout.planWatch('v5', { fanout: 1, maxChildren: 2 })
    assert.equal(r5.action, 'redirect')
    assert.equal(r5.hop, 3)
    assert.ok(['v1', 'v2', 'v3', 'v4'].includes(r5.parentPeerId))
})

test('placement: forbids relay parent->child edges, asymmetric links, and idlePeers', () => {
    const clock = makeClock()
    const peers = ['sharer', 'p1', 'v1', 'v2', 'v3']
    // sharer->p1 is relay (allowed for depth-1!), p1->v1 is relay (forbidden!), p1->v2 is mesh (allowed!)
    const topo = makeFullMeshTopology(peers, {
        relayPairs: [['sharer', 'p1'], ['p1', 'v1']],
        idlePeers: ['v3']
    })
    // Also make p1<->v2 asymmetric to test missing reverse mesh link
    const fanout = createScreenFanout({
        selfId: 'sharer',
        getTopology: () => topo,
        now: clock.now
    })

    // p1 attaches direct even over relay from sharer
    assert.deepEqual(fanout.planWatch('p1', { fanout: 1, maxChildren: 2 }), {
        action: 'direct', parentPeerId: 'sharer', hop: 1
    })

    // v1 has only a relay link to p1 -> must fall back to direct
    assert.deepEqual(fanout.planWatch('v1', { fanout: 1, maxChildren: 0 }), {
        action: 'direct', parentPeerId: 'sharer', hop: 1
    })

    // Asymmetric link: p1->v2 is 'mesh' but v2->p1 is 'relay' -> forbidden
    topo.kinds.v2.p1 = 'relay'
    assert.deepEqual(fanout.planWatch('v2', { fanout: 1, maxChildren: 2 }), {
        action: 'direct', parentPeerId: 'sharer', hop: 1
    })

    // Restore symmetric mesh for v2, but test idlePeers exclusion for v3
    topo.kinds.v2.p1 = 'mesh'
    const r2 = fanout.planWatch('v2', { fanout: 1, maxChildren: 2 })
    assert.equal(r2.action, 'redirect')
    assert.equal(r2.parentPeerId, 'p1')

    // v3 is in idlePeers -> cannot be placed under p1
    assert.deepEqual(fanout.planWatch('v3', { fanout: 1, maxChildren: 2 }), {
        action: 'direct', parentPeerId: 'sharer', hop: 1
    })
})

test('placement: supports linkKinds alias and enforces maxViewers', () => {
    const clock = makeClock()
    const topo = makeFullMeshTopology(['sharer', 'a', 'b', 'c'], { useLinkKinds: true })
    const fanout = createScreenFanout({
        selfId: 'sharer',
        getTopology: () => topo,
        now: clock.now,
        options: { maxViewers: 2 }
    })

    assert.equal(fanout.planWatch('a', { fanout: 1, maxChildren: 2 }).action, 'direct')
    assert.equal(fanout.planWatch('b', { fanout: 1, maxChildren: 2 }).action, 'redirect') // pending counts toward maxViewers
    assert.deepEqual(fanout.planWatch('c', { fanout: 1, maxChildren: 2 }), { action: 'reject', reason: 'full' })
    assert.deepEqual(fanout.planWatch('sharer', { fanout: 1, maxChildren: 2 }), { action: 'reject', reason: 'refused' })
})

test('loop prevention: strictly increasing hop, maxHop=3 cap, and maxRedirects guard', () => {
    const clock = makeClock()
    const topo = makeFullMeshTopology(['sharer', 'h1', 'h2', 'h3', 'h4'])
    const fanout = createScreenFanout({
        selfId: 'sharer',
        getTopology: () => topo,
        now: clock.now
    })

    // Build chain h1(hop 1) -> h2(hop 2) -> h3(hop 3)
    assert.equal(fanout.planWatch('h1', { fanout: 1, maxChildren: 1 }).hop, 1)
    const r2 = fanout.planWatch('h2', { fanout: 1, maxChildren: 1 })
    assert.equal(r2.hop, 2)
    fanout.handleReport('h1', { event: 'child-joined', childPeerId: 'h2' })

    const r3 = fanout.planWatch('h3', { fanout: 1, maxChildren: 2 })
    assert.equal(r3.parentPeerId, 'h2')
    assert.equal(r3.hop, 3)
    fanout.handleReport('h2', { event: 'child-joined', childPeerId: 'h3' })

    // h3 is at maxHop = 3, so h4 cannot attach under h3 -> falls back to direct
    const d4 = fanout.planWatch('h4', { fanout: 1, maxChildren: 2 })
    assert.deepEqual(d4, { action: 'direct', parentPeerId: 'sharer', hop: 1 })

    // maxRedirects guard: 3 failed redirects force direct on 4th WATCH
    const topo2 = makeFullMeshTopology(['sharer', 'p1', 'p2', 'p3', 'p4', 'v'])
    const fanout2 = createScreenFanout({ selfId: 'sharer', getTopology: () => topo2, now: clock.now })
    for (const p of ['p1', 'p2', 'p3', 'p4']) {
        fanout2.planWatch(p, { fanout: 1, maxChildren: 1 })
    }
    // Need maxDirectViewers: 4? No, default maxDirectViewers=1 so p2..p4 redirected; let's just confirm with maxDirectViewers: 4
    const fanout3 = createScreenFanout({
        selfId: 'sharer',
        getTopology: () => topo2,
        now: clock.now,
        options: { maxDirectViewers: 4 }
    })
    for (const p of ['p1', 'p2', 'p3', 'p4']) {
        assert.equal(fanout3.planWatch(p, { fanout: 1, maxChildren: 1 }).action, 'direct')
    }
    const a1 = fanout3.planWatch('v', { fanout: 1, maxChildren: 0 })
    const a2 = fanout3.planWatch('v', { fanout: 1, maxChildren: 0 })
    const a3 = fanout3.planWatch('v', { fanout: 1, maxChildren: 0 })
    assert.equal(a1.action, 'redirect')
    assert.equal(a2.action, 'redirect')
    assert.equal(a3.action, 'redirect')
    assert.equal(new Set([a1.parentPeerId, a2.parentPeerId, a3.parentPeerId]).size, 3)
    assert.ok(a1.tokenSeq < a2.tokenSeq && a2.tokenSeq < a3.tokenSeq)

    // 4th attempt hits maxRedirects = 3 -> forced direct
    const a4 = fanout3.planWatch('v', { fanout: 1, maxChildren: 0 })
    assert.deepEqual(a4, { action: 'direct', parentPeerId: 'sharer', hop: 1 })

    // Explicit redirectCount >= maxRedirects also forces direct
    const a5 = fanout3.planWatch('w', { fanout: 1, maxChildren: 0, redirectCount: FANOUT_DEFAULTS.maxRedirects })
    assert.deepEqual(a5, { action: 'direct', parentPeerId: 'sharer', hop: 1 })
})

test('probation: failed parent excluded for 30s per (viewer, parent) and pending expires after 8s', () => {
    const clock = makeClock()
    const topo = makeFullMeshTopology(['sharer', 'p1', 'p2', 'v1', 'v2'])
    const fanout = createScreenFanout({
        selfId: 'sharer',
        getTopology: () => topo,
        now: clock.now,
        options: { maxDirectViewers: 2 }
    })

    fanout.planWatch('p1', { fanout: 1, maxChildren: 2 })
    fanout.planWatch('p2', { fanout: 1, maxChildren: 2 })

    // v1 gets redirected to p1, then retries WATCH before confirming -> p1 in probation for v1
    const r1 = fanout.planWatch('v1', { fanout: 1, maxChildren: 0 })
    assert.equal(r1.parentPeerId, 'p1')
    const r2 = fanout.planWatch('v1', { fanout: 1, maxChildren: 0 })
    assert.equal(r2.parentPeerId, 'p2')
    assert.equal(fanout.isProbation('v1', 'p1'), true)

    // v2 can still use p1 (probation is per (viewer, parent))
    const rOther = fanout.planWatch('v2', { fanout: 1, maxChildren: 0 })
    assert.equal(rOther.parentPeerId, 'p1')

    // Pending reservation on p1 for v2 expires after redirectConfirmMs (8000ms)
    clock.advance(FANOUT_DEFAULTS.redirectConfirmMs)
    fanout.pruneExpired()
    assert.equal(fanout.getNode('p1').pendingChildren.size, 0)

    // After parentFailBackoffMs (30000ms total), v1's probation with p1 clears
    clock.advance(FANOUT_DEFAULTS.parentFailBackoffMs)
    assert.equal(fanout.isProbation('v1', 'p1'), false)
})

test('reparenting: parent disconnect, child-left, child-shed congested, child-shed slow, and capacity', () => {
    const clock = makeClock()
    const topo = makeFullMeshTopology(['sharer', 'p1', 'p2', 'c1', 'c2', 'c3'])
    const fanout = createScreenFanout({
        selfId: 'sharer',
        getTopology: () => topo,
        now: clock.now,
        options: { maxDirectViewers: 2 }
    })

    fanout.planWatch('p1', { fanout: 1, maxChildren: 2 })
    fanout.planWatch('p2', { fanout: 1, maxChildren: 2 })

    // Attach c1 under p1, c2 under p2, c3 under p1
    assert.equal(fanout.planWatch('c1', { fanout: 1, maxChildren: 1 }).parentPeerId, 'p1')
    fanout.handleReport('p1', { event: 'child-joined', childPeerId: 'c1' })
    assert.equal(fanout.planWatch('c2', { fanout: 1, maxChildren: 1 }).parentPeerId, 'p2')
    fanout.handleReport('p2', { event: 'child-joined', childPeerId: 'c2' })
    assert.equal(fanout.planWatch('c3', { fanout: 1, maxChildren: 1 }).parentPeerId, 'p1')
    fanout.handleReport('p1', { event: 'child-joined', childPeerId: 'c3' })

    // child-left frees slot on p1
    const leftRes = fanout.handleReport('p1', { event: 'child-left', childPeerId: 'c3', reason: 'stopped' })
    assert.equal(leftRes.ok, true)
    assert.equal(fanout.getNode('p1').children.size, 1)

    // child-shed congested puts p1 in 30s congested cooldown AND (c1, p1) in probation
    const shedCongested = fanout.handleReport('p1', {
        event: 'child-shed', childPeerId: 'c1', reason: 'congested', congested: true
    })
    assert.equal(shedCongested.ok, true)
    assert.equal(fanout.getNode('p1').congested, true)
    assert.equal(fanout.isProbation('c1', 'p1'), true)

    // New viewer c3 must go to p2 (not congested p1)
    const rC3 = fanout.planWatch('c3', { fanout: 1, maxChildren: 1 })
    assert.equal(rC3.parentPeerId, 'p2')
    fanout.handleReport('p2', { event: 'child-joined', childPeerId: 'c3' })

    // child-shed slow forces c3 direct on next WATCH
    fanout.handleReport('p2', { event: 'child-shed', childPeerId: 'c3', reason: 'slow' })
    assert.deepEqual(fanout.planWatch('c3', { fanout: 1, maxChildren: 1 }), {
        action: 'direct', parentPeerId: 'sharer', hop: 1
    })

    // Parent disconnect (p2 leaves) detaches c2 as orphan and puts c2 in probation with p2
    const disc = fanout.onPeerLeft('p2')
    assert.equal(disc.removed, true)
    assert.deepEqual(disc.orphaned, ['c2'])

    // Clear p1 congestion after cooldown -> c2 can reparent onto p1
    clock.advance(FANOUT_DEFAULTS.congestedBackoffMs)
    fanout.handleReport('p1', { event: 'capacity', maxChildren: 2, congested: false })
    const reparented = fanout.reparent(disc.orphaned)
    assert.equal(reparented.length, 1)
    assert.equal(reparented[0].decision.action, 'redirect')
    assert.equal(reparented[0].decision.parentPeerId, 'p1')
})

test('1.0.1-1.0.6 compat: legacy viewer without fanout is always direct and never a parent', () => {
    const clock = makeClock()
    const topo = makeFullMeshTopology(['sharer', 'legacy', 'modern1', 'modern2'])
    const fanout = createScreenFanout({
        selfId: 'sharer',
        getTopology: () => topo,
        now: clock.now,
        options: { maxDirectViewers: 1 }
    })

    // Legacy viewer omits fanout
    assert.deepEqual(fanout.planWatch('legacy', {}), {
        action: 'direct', parentPeerId: 'sharer', hop: 1
    })
    assert.equal(fanout.getNode('legacy').maxChildren, 0)

    // Modern viewer cannot use legacy as parent, so it attaches direct
    assert.deepEqual(fanout.planWatch('modern1', { fanout: 1, maxChildren: 2 }), {
        action: 'direct', parentPeerId: 'sharer', hop: 1
    })

    // Even when modern1 is available as a parent, a legacy viewer ALWAYS gets direct
    assert.deepEqual(fanout.planWatch('modern2', {}), {
        action: 'direct', parentPeerId: 'sharer', hop: 1
    })
})

test('global slot accounting: maxShares=3 ledger enforces per-node cap and own-share priority', () => {
    const clock = makeClock()
    const ledger = createGlobalSlotLedger({ maxShares: 3, defaultCap: 2, maxCap: 8 })
    const topo = makeFullMeshTopology(['s1', 's2', 's3', 'p1', 'p2', 'v1', 'v2', 'v3'])

    const f1 = createScreenFanout({ selfId: 's1', shareId: 'share-1', getTopology: () => topo, now: clock.now, slotLedger: ledger })
    const f2 = createScreenFanout({ selfId: 's2', shareId: 'share-2', getTopology: () => topo, now: clock.now, slotLedger: ledger })
    const f3 = createScreenFanout({ selfId: 's3', shareId: 'share-3', getTopology: () => topo, now: clock.now, slotLedger: ledger })

    // 4th concurrent share cannot register
    assert.equal(ledger.registerShare('share-4'), false)
    assert.equal(ledger.shareCount(), 3)

    // p1 has global cap 2: takes 1 child on share-1 and 1 child on share-2
    f1.planWatch('p1', { fanout: 1, maxChildren: 4 })
    assert.equal(f1.planWatch('v1', { fanout: 1, maxChildren: 0 }).parentPeerId, 'p1')
    f1.handleReport('p1', { event: 'child-joined', childPeerId: 'v1' })

    f2.planWatch('p1', { fanout: 1, maxChildren: 4 })
    assert.equal(f2.planWatch('v2', { fanout: 1, maxChildren: 0 }).parentPeerId, 'p1')
    f2.handleReport('p1', { event: 'child-joined', childPeerId: 'v2' })

    assert.equal(ledger.activeChildren('p1'), 2)
    assert.equal(ledger.availableSlots('p1'), 0)

    // On share-3, p1 has 0 global slots left, so v3 must fall back to direct (or another parent)
    f3.planWatch('p1', { fanout: 1, maxChildren: 4 })
    assert.deepEqual(f3.planWatch('v3', { fanout: 1, maxChildren: 0 }), {
        action: 'direct', parentPeerId: 's3', hop: 1
    })

    // Releasing v1 on share-1 frees 1 global slot for share-3
    f1.handleReport('p1', { event: 'child-left', childPeerId: 'v1', reason: 'stopped' })
    assert.equal(ledger.availableSlots('p1'), 1)

    const r3After = f3.planWatch('v3', { fanout: 1, maxChildren: 0 })
    assert.equal(r3After.action, 'redirect')
    assert.equal(r3After.parentPeerId, 'p1')

    // Own-share priority rule: when p1 starts its own share, availableSlots drops to 0
    ledger.setOwnSharing('p1', true)
    assert.equal(ledger.availableSlots('p1'), 0)
    ledger.setOwnSharing('p1', false)
    assert.equal(ledger.availableSlots('p1'), 0) // still 2 active (v2 on s2, v3 pending on s3)

    // Destroy share-2 -> frees p1 slot and allows share-4 to register
    f2.destroy()
    assert.equal(ledger.shareCount(), 2)
    assert.equal(ledger.availableSlots('p1'), 1)
    assert.equal(ledger.registerShare('share-4'), true)
})
