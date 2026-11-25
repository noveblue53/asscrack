// Session 7 checks: non-watching full-node fanout hubs (127.0.0.1).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await sleep(25)
    }
    throw new Error(`timeout: ${what}`)
}

function localAddr(n) {
    const a = n.getMultiaddrs().find(m => m.startsWith('/ip4/127.0.0.1/') && !m.includes('p2p-circuit'))
    assert.ok(a, 'node has a 127.0.0.1 address')
    return a
}

function assertRelayed(x, y) {
    const conns = x.libp2p.getConnections().filter(c => c.remotePeer.toString() === y.peerId)
    assert.ok(conns.length > 0, `connection exists to ${y.peerId}`)
    for (const c of conns) assert.ok(c.remoteAddr.toString().includes('/p2p-circuit'), `connection ${c.remoteAddr} is relayed`)
}

// 1 full node R + 1 NAT'd sharer S (relayOnly) + N NAT'd viewers V1..VN (relayOnly).
// S <-> V_i are /p2p-circuit ('relay'); S <-> R and R <-> V_i are direct TCP ('mesh').
async function relayedRoom(t, viewerCount, { hubScreen = {}, sharerScreen = {}, viewerScreen = {} } = {}) {
    const room = `hub-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))

    const R = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, ...fast, screen: hubScreen })
    nodes.push(R)
    const S = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast, screen: sharerScreen })
    nodes.push(S)
    const viewers = []
    for (let i = 0; i < viewerCount; i++) {
        const V = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast, screen: viewerScreen })
        nodes.push(V)
        viewers.push(V)
    }

    await S.connect(localAddr(R))
    for (const V of viewers) await V.connect(localAddr(R))

    await waitFor(
        () => nodes.every(n => nodes.every(m => m === n || n.peers().includes(m.peerId))),
        25000,
        'full room sessions via R'
    )
    for (const V of viewers) {
        assertRelayed(S, V)
        assertRelayed(V, S)
    }
    await waitFor(
        () => {
            const topo = S.topology()
            if (topo.kinds?.[S.peerId]?.[R.peerId] !== 'mesh' || topo.kinds?.[R.peerId]?.[S.peerId] !== 'mesh') return false
            return viewers.every(V =>
                topo.kinds?.[R.peerId]?.[V.peerId] === 'mesh' &&
                topo.kinds?.[V.peerId]?.[R.peerId] === 'mesh'
            )
        },
        15000,
        'symmetric mesh links S<->R and R<->V_i at S'
    )
    return { R, S, viewers }
}

function fakeEncoder(node, { fps = 15, size = 1000 } = {}) {
    const tiers = new Map()
    node.events.on('screen-encoder', e => {
        const seen = new Set()
        for (const t of e.tiers) {
            seen.add(t.tier)
            const known = tiers.get(t.tier)
            if (!known || known.preset !== t.preset) {
                tiers.set(t.tier, { preset: t.preset, key: true })
                node.setScreenSize({ tier: t.tier, width: t.width, height: t.height })
            }
            if (t.keyFrame) tiers.get(t.tier).key = true
        }
        for (const id of [...tiers.keys()]) if (!seen.has(id)) tiers.delete(id)
    })
    const start = Date.now()
    const timer = setInterval(() => {
        for (const [tier, s] of tiers) {
            const key = s.key
            s.key = false
            node.sendScreenFrame({ tier, key, timestampMs: Date.now() - start, data: randomBytes(size) })
        }
    }, 1000 / fps)
    return { stop: () => clearInterval(timer) }
}

function collect(node) {
    const out = { frames: [], configs: [], watches: [], ended: [], viewers: [] }
    node.events.on('screen-frame', f => out.frames.push({ peerId: f.peerId, shareId: f.shareId, seq: f.seq, at: Date.now() }))
    node.events.on('screen-config', c => out.configs.push({ ...c, at: Date.now() }))
    node.events.on('screen-watch', w => out.watches.push({ ...w, at: Date.now() }))
    node.events.on('screen-ended', e => out.ended.push({ ...e, at: Date.now() }))
    node.events.on('screen-viewers', v => out.viewers.push(v))
    return out
}

describe('screen-fanout-hubs (127.0.0.1)', { concurrency: 1 }, () => {

test('1 upload from NATd sharer -> full-node hub -> 3 viewers, with automatic teardown at 0 children', { timeout: 60000 }, async t => {
    const { R, S, viewers: [V1, V2, V3] } = await relayedRoom(t, 3, {
        hubScreen: { hubForwarding: true, maxChildren: 4, hubIdleTeardownMs: 300 }
    })
    const enc = fakeEncoder(S)
    t.after(() => enc.stop())
    const rCol = collect(R)
    const vCols = [V1, V2, V3].map(collect)

    const { shareId } = S.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => [R, V1, V2, V3].every(n => n.screenState().peers[S.peerId]?.shareId === shareId), 5000, 'all peers see share')

    const res = await Promise.all([V1.watchScreen(S.peerId), V2.watchScreen(S.peerId), V3.watchScreen(S.peerId)])
    for (const r of res) {
        assert.equal(r.parentPeerId, R.peerId)
        assert.equal(r.hop, 2)
    }

    await waitFor(() => vCols.every(c => c.frames.length >= 10), 15000, 'all 3 viewers receive frames via hub R')

    // Sharer uploads only once directly to hub R, while reporting the 3 actual viewers.
    assert.equal(S.screenStats().own.viewers.length, 1)
    assert.equal(S.screenStats().own.viewers[0].peerId, R.peerId)
    await waitFor(() => {
        const v = S.screenState().own.viewers
        return v.length === 3 && v.includes(V1.peerId) && v.includes(V2.peerId) && v.includes(V3.peerId)
    }, 5000, 'sharer screenState lists 3 viewers and excludes hub R')

    // Hub R does not emit local watch/frame/config/ended UI events.
    assert.equal(rCol.frames.length, 0)
    assert.equal(rCol.configs.length, 0)
    assert.equal(rCol.watches.length, 0)
    assert.equal(rCol.ended.length, 0)
    assert.equal(R.screenStats().hubs.length, 1)
    assert.equal(R.screenStats().hubs[0].forwarder.children, 3)

    // Unwatching all viewers triggers automatic teardown when child count reaches 0.
    V1.unwatchScreen()
    V2.unwatchScreen()
    V3.unwatchScreen()
    await waitFor(() => R.screenStats().hubs.length === 0, 5000, 'hub R tears down automatically at 0 children')
    await waitFor(() => S.screenStats().own.viewers.length === 0, 5000, 'sharer S has 0 direct streams after hub teardown')
})

test('hub consent defaults to opt-out and mid-stream opt-out seamlessly reparents viewers', { timeout: 60000 }, async t => {
    const { R, S, viewers: [V1, V2] } = await relayedRoom(t, 2, {
        hubScreen: { maxChildren: 4, hubIdleTeardownMs: 300 }
    })
    const enc = fakeEncoder(S)
    t.after(() => enc.stop())

    S.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => [R, V1, V2].every(n => n.screenState().peers[S.peerId]), 5000, 'peers see share')

    // Default hubForwarding: false -> R declines HUB_OFFER, V1 falls back directly to S.
    const w1 = await V1.watchScreen(S.peerId)
    assert.equal(w1.parentPeerId, S.peerId)
    assert.equal(w1.hop, 1)
    assert.equal(R.screenStats().hubs.length, 0)
    V1.unwatchScreen()
    await waitFor(() => S.screenStats().own.viewers.length === 0, 5000, 'S cleared after V1 unwatch')

    // Opt in on R; wait for probation from the earlier decline to not block if we restart share, or enable and test fresh share.
    S.stopScreenShare()
    await waitFor(() => [R, V1, V2].every(n => !n.screenState().peers[S.peerId]), 5000, 'share stopped')

    assert.deepEqual(R.setScreenHubForwarding(true), { hubForwarding: true, activeHubs: 0 })
    S.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => [R, V1, V2].every(n => n.screenState().peers[S.peerId]), 5000, 'peers see second share')

    const v1Col = collect(V1)
    const v2Col = collect(V2)
    await Promise.all([V1.watchScreen(S.peerId), V2.watchScreen(S.peerId)])
    assert.equal(V1.screenStats().watching.parentPeerId, R.peerId)
    assert.equal(V2.screenStats().watching.parentPeerId, R.peerId)
    await waitFor(() => v1Col.frames.length >= 10 && v2Col.frames.length >= 10, 10000, 'V1 and V2 receive frames via R')

    const f1Before = v1Col.frames.length
    const f2Before = v2Col.frames.length

    // Mid-stream opt-out on R tears down the hub and viewers seamlessly reparent to S.
    assert.deepEqual(R.setScreenHubForwarding(false), { hubForwarding: false, activeHubs: 0 })
    await waitFor(
        () => V1.screenStats().watching?.parentPeerId === S.peerId && V2.screenStats().watching?.parentPeerId === S.peerId,
        15000,
        'V1 and V2 reparent to S'
    )
    await waitFor(() => v1Col.frames.length > f1Before + 5 && v2Col.frames.length > f2Before + 5, 10000, 'V1 and V2 continue receiving frames')
    assert.equal(v1Col.ended.length, 0)
    assert.equal(v2Col.ended.length, 0)
})

test('Idle Peer on hub tears down active hub and viewers reparent seamlessly', { timeout: 60000 }, async t => {
    const { R, S, viewers: [V1] } = await relayedRoom(t, 1, {
        hubScreen: { hubForwarding: true, maxChildren: 4 }
    })
    const enc = fakeEncoder(S)
    t.after(() => enc.stop())
    const v1Col = collect(V1)

    S.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => [R, V1].every(n => n.screenState().peers[S.peerId]), 5000, 'peers see share')

    await V1.watchScreen(S.peerId)
    assert.equal(V1.screenStats().watching.parentPeerId, R.peerId)
    await waitFor(() => v1Col.frames.length >= 8, 10000, 'V1 receives frames via R')
    const fBefore = v1Col.frames.length

    R.setIdle(true)
    await waitFor(() => R.screenStats().hubs.length === 0, 5000, 'R tears down hub on Idle Peer')
    await waitFor(() => V1.screenStats().watching?.parentPeerId === S.peerId, 15000, 'V1 reparents to S')
    await waitFor(() => v1Col.frames.length > fBefore + 5, 10000, 'V1 continues receiving frames')
    assert.equal(v1Col.ended.length, 0)
})

})
