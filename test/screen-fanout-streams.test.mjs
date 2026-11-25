// Session 4 checks: 1->N video fanout streams, seamless failover, slow-grandchild shedding,
// revoked-child drop, 1.0.6 interop (both directions), and 24-viewer limits on 127.0.0.1.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey, readInvite } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'
import { SCREEN_DEFAULTS, SCREEN_END, SCREEN_FANOUT_PROTOCOL, readRecords, record } from '../src/network/screen-share.mjs'
import { SCREEN_TYPE } from '../src/network/screen-rate.mjs'

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

function connTo(x, y) {
    return x.libp2p.getConnections().find(c => c.remotePeer.toString() === y.peerId)
}

const roomName = () => `fanout-${Date.now()}-${Math.random().toString(16).slice(2)}`

// Full mesh room on 127.0.0.1 where every node has an open session and symmetric 'mesh' link with every other node.
async function meshRoom(t, count, extra = {}) {
    const room = roomName()
    const roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    for (let i = 0; i < count; i++) {
        nodes.push(await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast, ...(extra[i] ?? {}) }))
    }
    for (let i = 1; i < count; i++) {
        for (let j = 0; j < i; j++) await nodes[i].connect(localAddr(nodes[j]))
    }
    await waitFor(
        () => nodes.every(n => nodes.every(m => m === n || n.peers().includes(m.peerId))),
        20000,
        'full mesh sessions'
    )
    await waitFor(
        () => {
            const topo = nodes[0].topology()
            return nodes.every(n => nodes.every(m => m === n || topo.kinds?.[n.peerId]?.[m.peerId] === 'mesh'))
        },
        10000,
        'symmetric mesh topology at sharer'
    )
    return { room, roomKey, nodes }
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
    const out = { frames: [], configs: [], ended: [], viewers: [] }
    node.events.on('screen-frame', f => out.frames.push({ peerId: f.peerId, shareId: f.shareId, seq: f.seq, key: f.key, at: Date.now() }))
    node.events.on('screen-config', c => out.configs.push({ ...c, at: Date.now() }))
    node.events.on('screen-ended', e => out.ended.push({ ...e, at: Date.now() }))
    node.events.on('screen-viewers', v => out.viewers.push(v))
    return out
}

describe('screen-fanout-streams (127.0.0.1)', { concurrency: 2 }, () => {

test('limits: maxViewers is 24 and opensPerRoom supports 24-viewer fanout', () => {
    assert.equal(SCREEN_DEFAULTS.maxViewers, 24)
    assert.ok(SCREEN_DEFAULTS.opensPerRoom >= 192)
    assert.ok(SCREEN_DEFAULTS.opensPerPeer >= 24)
})

test('1->N tree fanout: sharer uploads to 1 direct viewer while 4 viewers receive frames and unwatch updates counts', { timeout: 45000 }, async t => {
    const { nodes: [A, B, C, D, E] } = await meshRoom(t, 5)
    const enc = fakeEncoder(A)
    t.after(() => enc.stop())
    const aCol = collect(A)
    const cols = [B, C, D, E].map(collect)

    A.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => [B, C, D, E].every(n => n.screenState().peers[A.peerId]), 5000, 'all peers see share')

    await B.watchScreen(A.peerId)
    assert.equal(B.screenStats().watching.hop, 1)
    assert.equal(B.screenStats().watching.parentPeerId, A.peerId)

    await C.watchScreen(A.peerId)
    await D.watchScreen(A.peerId)
    assert.equal(C.screenStats().watching.hop, 2)
    assert.equal(C.screenStats().watching.parentPeerId, B.peerId)
    assert.equal(D.screenStats().watching.hop, 2)
    assert.equal(D.screenStats().watching.parentPeerId, B.peerId)

    await E.watchScreen(A.peerId)
    assert.equal(E.screenStats().watching.hop, 3)
    assert.ok([C.peerId, D.peerId].includes(E.screenStats().watching.parentPeerId))

    await waitFor(() => cols.every(c => c.frames.length >= 10), 10000, 'all 4 viewers receive frames')
    await waitFor(() => A.screenState().own.viewers.length === 4, 5000, 'sharer reports 4 viewers')

    // Sharer only uploads directly to B.
    assert.equal(A.screenStats().own.viewers.length, 1)
    assert.equal(A.screenStats().own.viewers[0].peerId, B.peerId)
    assert.equal(aCol.viewers.at(-1).viewers.length, 4)

    // Unwatch E and verify sharer viewer count drops to 3.
    assert.equal(E.unwatchScreen(), true)
    await waitFor(() => A.screenState().own.viewers.length === 3, 5000, 'sharer reports 3 viewers after E unwatches')
    assert.equal(E.screenStats().watching, null)
})

test('mid-stream parent disconnect failover: children reparent without screen-ended and keep receiving frames', { timeout: 45000 }, async t => {
    const { nodes: [A, B, C, D] } = await meshRoom(t, 4)
    const enc = fakeEncoder(A)
    t.after(() => enc.stop())
    const cCol = collect(C)
    const dCol = collect(D)

    A.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => [B, C, D].every(n => n.screenState().peers[A.peerId]), 5000, 'all peers see share')

    await B.watchScreen(A.peerId)
    await C.watchScreen(A.peerId)
    await D.watchScreen(A.peerId)
    assert.equal(C.screenStats().watching.parentPeerId, B.peerId)
    assert.equal(D.screenStats().watching.parentPeerId, B.peerId)

    await waitFor(() => cCol.frames.length >= 10 && dCol.frames.length >= 10, 10000, 'C and D receive initial frames')
    const cBefore = cCol.frames.length
    const dBefore = dCol.frames.length

    // Kill parent forwarder B mid-stream.
    await B.stop()

    await waitFor(
        () => cCol.frames.length > cBefore + 5 && dCol.frames.length > dBefore + 5,
        15000,
        'C and D continue receiving frames after B stops'
    )
    assert.equal(cCol.ended.length, 0, 'C did not emit screen-ended during reparent')
    assert.equal(dCol.ended.length, 0, 'D did not emit screen-ended during reparent')
    await waitFor(
        () => {
            const v = A.screenState().own.viewers
            return v.length === 2 && v.includes(C.peerId) && v.includes(D.peerId)
        },
        5000,
        'sharer viewer list reflects C and D'
    )
})

test('slow-grandchild shedding: forwarder sheds slow child, sibling stays uninterrupted, slow child reparents to sharer', { timeout: 45000 }, async t => {
    let bPeerId = null
    const { nodes: [A, B, C, D] } = await meshRoom(t, 4, {
        1: { screen: { forwarderParams: { slowMs: 700, slowExcessMs: 500, slowGraceMs: 300, highMs: 50, lowMs: 25 } } },
        3: {
            screen: {
                beforeRecord: ({ parentPeerId, type }) => {
                    if (parentPeerId === bPeerId && type === SCREEN_TYPE.FRAME) return sleep(200)
                }
            }
        }
    })
    bPeerId = B.peerId
    const enc = fakeEncoder(A)
    t.after(() => enc.stop())
    const cCol = collect(C)
    const dCol = collect(D)

    A.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => [B, C, D].every(n => n.screenState().peers[A.peerId]), 5000, 'all peers see share')

    await B.watchScreen(A.peerId)
    await C.watchScreen(A.peerId)
    await D.watchScreen(A.peerId)
    assert.equal(C.screenStats().watching.parentPeerId, B.peerId)
    assert.equal(D.screenStats().watching.parentPeerId, B.peerId)

    // D should be shed by B and reparent directly to A.
    await waitFor(() => D.screenStats().watching?.parentPeerId === A.peerId, 15000, 'D reparented to sharer A')
    assert.equal(D.screenStats().watching.hop, 1)
    assert.equal(dCol.ended.length, 0, 'D did not emit screen-ended when shed by B')

    const cCount = cCol.frames.length
    const dCount = dCol.frames.length
    await waitFor(() => cCol.frames.length > cCount + 5 && dCol.frames.length > dCount + 5, 10000, 'C and D both receive frames')
    assert.equal(C.screenStats().watching.parentPeerId, B.peerId, 'calm sibling C stayed on B')
})

test('revoked-child drop: revoking a hop-2 child in a protected room ends its stream within 2 s', { timeout: 45000 }, async t => {
    const room = roomName()
    const roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    const start = async (membership, name) => {
        const node = await createAsscrackNode({
            room, roomKey, membership, name, discovery: false, listen: LOCAL, fullNode: false,
            heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350
        })
        nodes.push(node)
        return node
    }
    const owner = await start(createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: true }), 'Owner')
    const idB = createDeviceIdentity()
    const idC = createDeviceIdentity()
    const invB = readInvite(owner.createMemberInvite(idB.id))
    const invC = readInvite(owner.createMemberInvite(idC.id))
    const B = await start(restoreRoomMembership({ identity: idB, room, roomKey, descriptor: invB.membership }), 'MemberB')
    const C = await start(restoreRoomMembership({ identity: idC, room, roomKey, descriptor: invC.membership }), 'MemberC')

    await B.connect(localAddr(owner))
    await C.connect(localAddr(owner))
    await C.connect(localAddr(B))
    await waitFor(() => [owner, B, C].every(n => [owner, B, C].every(m => m === n || n.peers().includes(m.peerId))), 15000, 'protected mesh')
    await waitFor(() => {
        const topo = owner.topology()
        return topo.kinds?.[B.peerId]?.[C.peerId] === 'mesh' && topo.kinds?.[C.peerId]?.[B.peerId] === 'mesh'
    }, 10000, 'symmetric mesh at owner')

    const enc = fakeEncoder(owner)
    t.after(() => enc.stop())
    owner.startScreenShare({ preset: 'standard' })
    await waitFor(() => B.screenState().peers[owner.peerId] && C.screenState().peers[owner.peerId], 5000, 'share state')

    await B.watchScreen(owner.peerId)
    const cCol = collect(C)
    await C.watchScreen(owner.peerId)
    assert.equal(C.screenStats().watching.parentPeerId, B.peerId)
    await waitFor(() => cCol.frames.length > 3, 5000, 'C gets frames via B')

    assert.equal(owner.revokeMember(idC.id), true)
    const revokedAt = Date.now()
    await waitFor(() => cCol.ended.length > 0 && owner.screenState().own.viewers.length === 1, 2000, 'C stream ends and viewer list drops C')
    assert.ok(Date.now() - revokedAt <= 2000)
})

test('1.0.6 interop: legacy viewer and legacy sharer both work directly', { timeout: 45000 }, async t => {
    // Direction 1: 1.0.6 viewer (fanout: false) watches a new fanout sharer that already has a viewer.
    {
        const { nodes: [A, B, legacyC] } = await meshRoom(t, 3, { 2: { screen: { fanout: false } } })
        const enc = fakeEncoder(A)
        t.after(() => enc.stop())
        A.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
        await waitFor(() => B.screenState().peers[A.peerId] && legacyC.screenState().peers[A.peerId], 5000, 'state')
        await B.watchScreen(A.peerId)
        const cCol = collect(legacyC)
        await legacyC.watchScreen(A.peerId)
        assert.equal(legacyC.screenStats().watching.parentPeerId, A.peerId)
        await waitFor(() => cCol.frames.length >= 10, 5000, 'legacy viewer gets frames')
        enc.stop()
    }
    // Direction 2: new fanout viewer watches a 1.0.6 sharer (fanout: false).
    {
        const { nodes: [legacyA, B] } = await meshRoom(t, 2, { 0: { screen: { fanout: false } } })
        const enc = fakeEncoder(legacyA)
        t.after(() => enc.stop())
        legacyA.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
        await waitFor(() => B.screenState().peers[legacyA.peerId], 5000, 'state')
        const bCol = collect(B)
        await B.watchScreen(legacyA.peerId)
        assert.equal(B.screenStats().watching.parentPeerId, legacyA.peerId)
        assert.equal(B.screenStats().watching.forwarder, null)
        await waitFor(() => bCol.frames.length >= 10, 5000, 'new viewer gets frames from legacy sharer')
        enc.stop()
    }
})

test('verified token rejection: forged or expired fanout token receives END refused', { timeout: 30000 }, async t => {
    const { nodes: [A, B, C] } = await meshRoom(t, 3)
    const enc = fakeEncoder(A)
    t.after(() => enc.stop())
    const { shareId } = A.startScreenShare({ preset: 'standard' })
    await waitFor(() => B.screenState().peers[A.peerId] && C.screenState().peers[A.peerId], 5000, 'state')
    await B.watchScreen(A.peerId)

    const stream = await connTo(C, B).newStream(SCREEN_FANOUT_PROTOCOL, { runOnTransientConnection: true })
    const records = []
    const done = readRecords(stream.source, (type, body) => { records.push({ type, body: Buffer.from(body) }) }, 1024).catch(() => {})
    stream.send(record(SCREEN_TYPE.WATCH, Buffer.from(JSON.stringify({
        v: 1,
        shareId,
        sharerPeerId: A.peerId,
        hop: 2,
        tokenSeq: 99,
        exp: Date.now() + 10000,
        sig: 'A'.repeat(86)
    }))))
    await waitFor(() => records.length > 0, 3000, 'END refused from forwarder')
    await done
    assert.equal(records[0].type, SCREEN_TYPE.END)
    assert.equal(records[0].body[0], SCREEN_END.refused)
    assert.equal(B.screenStats().watching.forwarder.children, 0)
})

test('setScreenForwarding(0) sheds active children, respects Idle Peer, and topology().screenEdges propagates Sharer -> Forwarder -> Viewer', async t => {
    const { nodes: [A, B, C, D] } = await meshRoom(t, 4, {
        0: { screen: { maxDirectViewers: 1, maxChildren: 2 } },
        1: { screen: { maxDirectViewers: 1, maxChildren: 2 } },
        2: { screen: { maxDirectViewers: 1, maxChildren: 2 } },
        3: { screen: { maxDirectViewers: 1, maxChildren: 2 } }
    })
    const bConfigs = []
    const cConfigs = []
    B.events.on('screen-config', c => bConfigs.push(c))
    C.events.on('screen-config', c => cConfigs.push(c))

    const enc = fakeEncoder(A)
    t.after(enc.stop)
    const { shareId } = await A.startScreenShare({ preset: 'standard', width: 640, height: 360 })
    await waitFor(() => B.screenState().peers[A.peerId]?.shareId === shareId &&
        C.screenState().peers[A.peerId]?.shareId === shareId &&
        D.screenState().peers[A.peerId]?.shareId === shareId, 3000, 'all peers see share')

    const bWatch = await B.watchScreen(A.peerId)
    assert.equal(bWatch.parentPeerId, A.peerId)
    assert.equal(bWatch.hop, 1)
    assert.equal(bConfigs.at(-1).parentPeerId, A.peerId)

    const cWatch = await C.watchScreen(A.peerId)
    assert.equal(cWatch.parentPeerId, B.peerId)
    assert.equal(cWatch.hop, 2)
    assert.equal(cConfigs.at(-1).parentPeerId, B.peerId)

    // Non-watching observer D receives Sharer -> Forwarder -> Viewer via room control state.
    await waitFor(() => {
        const edges = D.topology().screenEdges
        return edges.some(e => e.from === A.peerId && e.to === B.peerId && e.sharer === A.peerId) &&
            edges.some(e => e.from === B.peerId && e.to === C.peerId && e.sharer === A.peerId)
    }, 3000, 'observer D sees Sharer -> Forwarder -> Viewer screenEdges')

    // Opting out of forwarding on B sheds C and sets effective maxChildren = 0.
    const fwdOff = B.setScreenForwarding(0)
    assert.deepEqual(fwdOff, { maxChildren: 0, effectiveMaxChildren: 0 })
    await waitFor(() => B.screenStats().watching.forwarder.children === 0, 3000, 'B sheds child C')
    assert.equal(B.screenStats().watching.forwarder.maxChildren, 0)

    // Restoring forwarding cap while Idle Peer keeps effectiveMaxChildren at 0.
    B.setIdle(true)
    const whileIdle = B.setScreenForwarding(2)
    assert.deepEqual(whileIdle, { maxChildren: 2, effectiveMaxChildren: 0 })
    B.setIdle(false)
    const afterIdle = B.setScreenForwarding(2)
    assert.deepEqual(afterIdle, { maxChildren: 2, effectiveMaxChildren: 2 })
})

})
