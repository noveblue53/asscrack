// W1 checks of work-orders/astra/P8/DESIGN.md (revision 2): the screen protocol and the share state.
// All results of this file are 127.0.0.1 results on one computer, not LAN results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { identify } from '@libp2p/identify'
import { multiaddr } from '@multiformats/multiaddr'
import { createStreamCompatibleLibp2p } from '../src/network/libp2p-streams.mjs'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey, readInvite } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'
import { SCREEN_PROTOCOL, SCREEN_END, readRecords, record } from '../src/network/screen-share.mjs'
import { SCREEN_TYPE } from '../src/network/screen-rate.mjs'

const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await sleep(20)
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
const roomName = () => `screen-${Date.now()}-${Math.random().toString(16).slice(2)}`

// A keyed room with direct TCP sessions. The first node listens, the others connect to it.
async function directRoom(t, count, extra = {}) {
    const room = roomName()
    const roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    for (let i = 0; i < count; i++) {
        nodes.push(await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast, ...(extra[i] ?? {}) }))
    }
    for (const n of nodes.slice(1)) await n.connect(localAddr(nodes[0]))
    await waitFor(() => nodes.slice(1).every(n => n.peers().includes(nodes[0].peerId) && nodes[0].peers().includes(n.peerId)), 15000, 'sessions')
    return { room, roomKey, nodes }
}

// The window side of the sharer for a test: it answers each new tier preset with setScreenSize (rule E7) and gives
// frames at a fixed frame rate for each active tier. A frame is a keyframe when the network asked for one (rule E2).
function fakeEncoder(node, { fps = 15, size = () => 1000, run = true } = {}) {
    const tiers = new Map() // tier -> { preset, key }
    const events = []
    node.events.on('screen-encoder', e => {
        events.push(e)
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
    let n = 0
    const start = Date.now()
    const timer = run ? setInterval(() => {
        for (const [tier, s] of tiers) {
            const key = s.key
            s.key = false
            node.sendScreenFrame({ tier, key, timestampMs: Date.now() - start, data: randomBytes(size(key, n++)) })
        }
    }, 1000 / fps) : null
    return { tiers, events, stop: () => clearInterval(timer), keyAsked: () => events.some(e => e.tiers.some(t => t.keyFrame)) }
}

function collect(node) {
    const out = { frames: [], configs: [], ended: [], states: [] }
    node.events.on('screen-frame', f => out.frames.push({ ...f, data: Buffer.from(f.data), at: Date.now() }))
    node.events.on('screen-config', c => out.configs.push({ ...c, at: Date.now() }))
    node.events.on('screen-ended', e => out.ended.push({ ...e, at: Date.now() }))
    node.events.on('screen-state', s => out.states.push({ ...s, at: Date.now() }))
    return out
}

// A raw screen stream from x to y with no node logic. Gives the records that come and the end of the stream.
async function rawStream(x, y) {
    const stream = await connTo(x, y).newStream(SCREEN_PROTOCOL, { runOnTransientConnection: true })
    const got = { records: [], ended: false, error: null }
    got.done = readRecords(stream.source, (type, body) => { got.records.push({ type, body: Buffer.from(body) }) }, 2 * 1024 * 1024)
        .then(() => { got.ended = true }, err => { got.ended = true; got.error = err })
    return { stream, got }
}

// Sends the frames of a list at 15 frames each second.
async function sendFrames(node, tier, list) {
    for (const f of list) {
        assert.equal(node.sendScreenFrame({ tier, key: f.key, timestampMs: 0, data: f.data }), true)
        await sleep(66)
    }
}
const tierOf = node => node.screenState().own.tiers[0].tier

test('check 1: the share state reaches each session, also a late session', { timeout: 30000 }, async t => {
    const { nodes: [A, B, C] } = await directRoom(t, 3)
    const bState = collect(B)
    const { shareId } = A.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    const started = Date.now()
    await waitFor(() => bState.states.some(s => s.peerId === A.peerId && s.sharing && s.shareId === shareId), 1000, 'B gets the state')
    assert.ok(Date.now() - started <= 1000)
    assert.equal(C.screenState().peers[A.peerId]?.shareId, shareId)
    // 1.0.6: a second member can share at the same time (test/multi-share.test.mjs has the checks of several shares).
    A.stopScreenShare()
    const stopped = Date.now()
    await waitFor(() => B.screenState().peers[A.peerId] === undefined && C.screenState().peers[A.peerId] === undefined, 1000, 'stop reaches B and C')
    assert.ok(Date.now() - stopped <= 1000)
})

test('check 1 (late join): a member that joins later gets the state when its session opens', { timeout: 30000 }, async t => {
    const { room, roomKey, nodes: [A, B] } = await directRoom(t, 2)
    const { shareId } = A.startScreenShare({ preset: 'auto', width: 1920, height: 1080 })
    await waitFor(() => B.screenState().peers[A.peerId]?.shareId === shareId, 1000, 'B gets the state')
    const C = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast })
    t.after(() => C.stop())
    const cState = collect(C)
    await C.connect(localAddr(A))
    await waitFor(() => C.peers().includes(A.peerId), 10000, 'C session')
    await waitFor(() => cState.states.some(s => s.peerId === A.peerId && s.sharing && s.shareId === shareId && s.preset === 'auto'), 1000, 'C gets the state')
    A.stopScreenShare()
    await waitFor(() => !B.screenState().peers[A.peerId] && !C.screenState().peers[A.peerId], 1000, 'B and C get sharing false')
})

async function watchAndCompare(A, B) {
    const got = collect(B)
    const enc = fakeEncoder(A, { run: false })
    A.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => B.screenState().peers[A.peerId], 2000, 'B knows the share')
    const config = await B.watchScreen(A.peerId)
    assert.equal(config.width, 1280)
    assert.equal(config.height, 720)
    assert.equal(config.fps, 15)
    await waitFor(() => enc.keyAsked(), 3000, 'the network asks for a keyframe')
    const list = Array.from({ length: 60 }, (_, i) => ({ key: i === 0, data: randomBytes(1000) }))
    await sendFrames(A, tierOf(A), list)
    await waitFor(() => got.frames.length >= 60, 5000, '60 frames at B')
    await sleep(300)
    assert.equal(got.frames.length, 60)
    assert.ok(got.configs[0].at <= got.frames[0].at, 'CONFIG comes first')
    for (let i = 0; i < 60; i++) {
        assert.equal(got.frames[i].seq, i)
        assert.equal(got.frames[i].key, i === 0)
        assert.ok(got.frames[i].data.equals(list[i].data), `frame ${i} has the same bytes`)
    }
    const stats = A.screenStats().own.viewers[0]
    assert.equal(stats.dropped, 0)
}

test('check 2: direct route, CONFIG then 60 frames with the same bytes', { timeout: 30000 }, async t => {
    const { nodes: [A, B] } = await directRoom(t, 2)
    assert.ok(!connTo(B, A).remoteAddr.toString().includes('/p2p-circuit'), 'direct connection')
    await watchAndCompare(A, B)
})

test('check 3: circuit route through a full node, the same result', { timeout: 40000 }, async t => {
    const room = roomName()
    const roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    const H = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, ...fast })
    nodes.push(H)
    const A = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast })
    nodes.push(A)
    const B = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast })
    nodes.push(B)
    await A.connect(localAddr(H))
    await B.connect(localAddr(H))
    await waitFor(() => A.peers().includes(B.peerId) && B.peers().includes(A.peerId), 20000, 'A-B session through H')
    assert.ok(connTo(B, A).remoteAddr.toString().includes('/p2p-circuit'), 'circuit connection')
    await watchAndCompare(A, B)
})

test('check 4: a late viewer gets a keyframe first', { timeout: 30000 }, async t => {
    const { nodes: [A, B, C] } = await directRoom(t, 3)
    const enc = fakeEncoder(A)
    t.after(() => enc.stop())
    A.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => B.screenState().peers[A.peerId] && C.screenState().peers[A.peerId], 2000, 'state')
    const b = collect(B)
    await B.watchScreen(A.peerId)
    await waitFor(() => b.frames.length > 20, 5000, 'B gets frames')
    const keysBefore = enc.events.filter(e => e.tiers.some(x => x.keyFrame)).length
    const c = collect(C)
    await C.watchScreen(A.peerId)
    await waitFor(() => c.frames.length > 3, 5000, 'C gets frames')
    assert.ok(enc.events.filter(e => e.tiers.some(x => x.keyFrame)).length > keysBefore, 'the screen-encoder event asks for a keyframe')
    assert.equal(c.frames[0].key, true)
    assert.equal(c.frames[0].seq, 0)
    const before = b.frames.length
    await sleep(500)
    assert.ok(b.frames.length > before, 'B continues')
})

test('check 5a: a libp2p node with no session gets a reset and no record', { timeout: 30000 }, async t => {
    const { nodes: [A, B] } = await directRoom(t, 2)
    A.startScreenShare({ preset: 'standard' })
    const stranger = await createStreamCompatibleLibp2p({
        addresses: { listen: [] }, transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
        services: { identify: identify() }
    })
    t.after(() => stranger.stop())
    const connection = await stranger.dial(multiaddr(`${localAddr(A)}`))
    let bytes = 0
    let failed = false
    try {
        const stream = await connection.newStream(SCREEN_PROTOCOL, { runOnTransientConnection: true })
        stream.send(record(SCREEN_TYPE.WATCH, Buffer.from(JSON.stringify({ v: 1, shareId: A.screenState().own.shareId }))))
        for await (const chunk of stream.source) bytes += chunk.byteLength ?? chunk.length
    } catch { failed = true }
    assert.equal(bytes, 0, 'no record')
    assert.ok(failed || bytes === 0)
    assert.equal(A.screenState().own.viewers.length, 0)
    assert.ok(B)
})

test('check 5b: a revoked viewer in a protected room loses the stream in 2 s', { timeout: 40000 }, async t => {
    const room = roomName()
    const roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    const start = async (membership, name) => {
        const node = await createAsscrackNode({ room, roomKey, membership, name, discovery: false, listen: LOCAL, fullNode: false,
            heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350 })
        nodes.push(node)
        return node
    }
    const owner = await start(createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: true }), 'Owner')
    const identity = createDeviceIdentity()
    const invitation = readInvite(owner.createMemberInvite(identity.id))
    const member = await start(restoreRoomMembership({ identity, room, roomKey, descriptor: invitation.membership }), 'Member')
    await member.connect(localAddr(owner))
    await waitFor(() => member.peers().includes(owner.peerId) && owner.peers().includes(member.peerId), 10000, 'admitted')
    const enc = fakeEncoder(owner)
    t.after(() => enc.stop())
    owner.startScreenShare({ preset: 'standard' })
    await waitFor(() => member.screenState().peers[owner.peerId], 2000, 'member knows the share')
    const got = collect(member)
    await member.watchScreen(owner.peerId)
    await waitFor(() => got.frames.length > 3, 5000, 'member gets frames')
    assert.equal(owner.revokeMember(identity.id), true)
    const revoked = Date.now()
    await waitFor(() => got.ended.length > 0 && owner.screenState().own.viewers.length === 0, 2000, 'the stream of the revoked viewer ends')
    assert.ok(Date.now() - revoked <= 2000)
})

test('check 5c and 5d: a wrong share ID gets END refused; a stream with no WATCH closes after 5 s', { timeout: 30000 }, async t => {
    const { nodes: [A, B] } = await directRoom(t, 2)
    A.startScreenShare({ preset: 'standard' })
    const wrong = await rawStream(B, A)
    wrong.stream.send(record(SCREEN_TYPE.WATCH, Buffer.from(JSON.stringify({ v: 1, shareId: randomUUID() }))))
    await waitFor(() => wrong.got.records.length > 0, 3000, 'END refused')
    assert.equal(wrong.got.records[0].type, SCREEN_TYPE.END)
    assert.equal(wrong.got.records[0].body[0], SCREEN_END.refused)
    const silent = await rawStream(B, A)
    const opened = Date.now()
    await waitFor(() => silent.got.ended, 8000, 'the stream with no WATCH closes')
    const ms = Date.now() - opened
    assert.ok(ms >= 4500 && ms <= 7000, `closed after ${ms} ms`)
    assert.equal(silent.got.records.length, 0)
    assert.equal(A.screenState().own.viewers.length, 0)
})

test('check 6: the record limits', { timeout: 45000 }, async t => {
    const { nodes: [A, B] } = await directRoom(t, 2)
    const enc = fakeEncoder(A, { run: false })
    A.startScreenShare({ preset: 'standard' })
    await waitFor(() => B.screenState().peers[A.peerId], 2000, 'state')
    // A record of 257 bytes from the viewer aborts the stream.
    const big = await rawStream(B, A)
    big.stream.send(record(SCREEN_TYPE.WATCH, Buffer.from(JSON.stringify({ v: 1, shareId: A.screenState().own.shareId }))))
    await waitFor(() => A.screenState().own.viewers.length === 1, 3000, 'raw viewer accepted')
    big.stream.send(record(SCREEN_TYPE.KEYREQ, Buffer.alloc(256)))
    await waitFor(() => big.got.ended && A.screenState().own.viewers.length === 0, 3000, 'the stream aborts')
    // sendScreenFrame with 1 048 577 bytes gives false and writes nothing.
    const b = collect(B)
    await B.watchScreen(A.peerId)
    await waitFor(() => enc.tiers.size > 0, 2000, 'tier')
    const tier = tierOf(A)
    const sent = () => A.screenStats().own.viewers[0].framesSent
    const before = sent()
    assert.equal(A.sendScreenFrame({ tier, key: true, timestampMs: 0, data: new Uint8Array(1048577) }), false)
    assert.equal(sent(), before)
    assert.equal(A.sendScreenFrame({ tier, key: true, timestampMs: 0, data: new Uint8Array(1048576) }), true)
    // At the start rate (500 kbit/s x 1.25 of the pacer) a frame of 1 MiB takes about 13 s.
    await waitFor(() => b.frames.length === 1, 20000, 'a frame of 1 048 576 bytes arrives')
    B.unwatchScreen()
    // A record length of 1 048 587 from the sharer makes the viewer abort with error.
    await A.libp2p.unhandle(SCREEN_PROTOCOL)
    await A.libp2p.handle(SCREEN_PROTOCOL, ({ stream }) => {
        const head = Buffer.alloc(5)
        head.writeUInt32BE(1048587, 0)
        head[4] = SCREEN_TYPE.FRAME
        stream.send(head)
    }, { runOnTransientConnection: true })
    const ended = b.ended.length
    await assert.rejects(B.watchScreen(A.peerId))
    await waitFor(() => b.ended.length > ended, 3000, 'screen-ended at the viewer')
    assert.equal(b.ended.at(-1).reason, 'error')
})

test('check 7: the viewer after the limit gets END full', { timeout: 30000 }, async t => {
    const { nodes: [A, B, C, D] } = await directRoom(t, 4, { 0: { screen: { maxViewers: 2 } } })
    const enc = fakeEncoder(A)
    t.after(() => enc.stop())
    A.startScreenShare({ preset: 'standard' })
    await waitFor(() => [B, C, D].every(n => n.screenState().peers[A.peerId]), 2000, 'state')
    await B.watchScreen(A.peerId)
    await C.watchScreen(A.peerId)
    const d = collect(D)
    await assert.rejects(D.watchScreen(A.peerId), /full/)
    assert.equal(d.ended.at(-1).reason, 'full')
    assert.equal(A.screenState().own.viewers.length, 2)
})

test('check 8: stop gives END stopped, no FRAME after END, and sendScreenFrame gives false', { timeout: 30000 }, async t => {
    const { nodes: [A, B, C] } = await directRoom(t, 3)
    const enc = fakeEncoder(A)
    t.after(() => enc.stop())
    A.startScreenShare({ preset: 'standard' })
    await waitFor(() => B.screenState().peers[A.peerId] && C.screenState().peers[A.peerId], 2000, 'state')
    const b = collect(B)
    const c = collect(C)
    await B.watchScreen(A.peerId)
    await C.watchScreen(A.peerId)
    await waitFor(() => b.frames.length > 5 && c.frames.length > 5, 5000, 'frames')
    const tier = tierOf(A)
    assert.equal(A.stopScreenShare(), true)
    await waitFor(() => b.ended.length && c.ended.length, 3000, 'END at each viewer')
    assert.equal(b.ended[0].reason, 'stopped')
    assert.equal(c.ended[0].reason, 'stopped')
    assert.equal(A.sendScreenFrame({ tier, key: true, timestampMs: 0, data: new Uint8Array(10) }), false)
    await sleep(500)
    assert.ok(b.frames.every(f => f.at <= b.ended[0].at), 'no FRAME after END at B')
    assert.ok(c.frames.every(f => f.at <= c.ended[0].at), 'no FRAME after END at C')
    assert.equal(A.stopScreenShare(), false)
})

test('check 9: Idle Peer stops the share and the watch', { timeout: 30000 }, async t => {
    const { nodes: [A, B] } = await directRoom(t, 2)
    const enc = fakeEncoder(A)
    t.after(() => enc.stop())
    A.startScreenShare({ preset: 'standard' })
    await waitFor(() => B.screenState().peers[A.peerId], 2000, 'state')
    const b = collect(B)
    await B.watchScreen(A.peerId)
    A.setIdle(true)
    await waitFor(() => b.ended.length && !B.screenState().peers[A.peerId], 2000, 'END idle and state false')
    assert.equal(b.ended[0].reason, 'idle')
    assert.equal(A.screenState().own, null)
    assert.throws(() => A.startScreenShare({ preset: 'standard' }), /Idle Peer/)
    A.setIdle(false)
    A.startScreenShare({ preset: 'standard' })
    await waitFor(() => B.screenState().peers[A.peerId], 2000, 'state again')
    await B.watchScreen(A.peerId)
    await waitFor(() => A.screenState().own.viewers.length === 1, 2000, 'one viewer')
    B.setIdle(true)
    const idleAt = Date.now()
    await waitFor(() => A.screenState().own.viewers.length === 0, 1000, 'A has 0 viewers in 1 s')
    assert.ok(Date.now() - idleAt <= 1000)
    assert.equal(B.screenState().watching, null)
})

test('check 10: the end of the sharer gives screen-ended in 2 s and no state after peer-left', { timeout: 30000 }, async t => {
    const { nodes: [A, B] } = await directRoom(t, 2)
    const enc = fakeEncoder(A)
    t.after(() => enc.stop())
    A.startScreenShare({ preset: 'standard' })
    await waitFor(() => B.screenState().peers[A.peerId], 2000, 'state')
    const b = collect(B)
    await B.watchScreen(A.peerId)
    let left = false
    B.events.on('peer-left', ({ peerId }) => { if (peerId === A.peerId) left = true })
    const stopAt = Date.now()
    await A.stop()
    await waitFor(() => b.ended.length > 0, 2000, 'screen-ended at B')
    assert.ok(Date.now() - stopAt <= 2000)
    await waitFor(() => left, 5000, 'peer-left')
    assert.equal(B.screenState().peers[A.peerId], undefined)
    assert.equal(B.screenState().watching, null)
})

// 1.0.6: two shares at the same moment are permitted below the share limit. This check uses a limit of 1, so that the
// rule of the limit race (the higher peer ID stops) has the same result as the old rule of section 2.6, item 6.
test('check 11: two shares at the same moment over the share limit: the lower peer ID continues', { timeout: 30000 }, async t => {
    const { nodes: [A, B] } = await directRoom(t, 2, { 0: { screen: { maxShares: 1 } }, 1: { screen: { maxShares: 1 } } })
    const ended = []
    for (const n of [A, B]) n.events.on('screen-ended', e => { if (e.own) ended.push({ node: n.peerId, ...e }) })
    A.startScreenShare({ preset: 'standard' })
    B.startScreenShare({ preset: 'standard' })
    await sleep(2000)
    const [low, high] = A.peerId < B.peerId ? [A, B] : [B, A]
    assert.ok(low.screenState().own, 'the lower peer ID shares')
    assert.equal(high.screenState().own, null, 'the higher peer ID stopped')
    assert.equal(ended.length, 1)
    assert.equal(ended[0].node, high.peerId)
    assert.equal(ended[0].reason, 'limit')
    assert.equal(ended[0].by, low.peerId)
    assert.ok(high.screenState().peers[low.peerId])
    assert.equal(low.screenState().peers[high.peerId], undefined)
    assert.throws(() => high.startScreenShare({ preset: 'standard' }), /Share limit reached \(1\)/)
})

test('check 12: a sharer with no session stops after the isolated time; a session again keeps it', { timeout: 30000 }, async t => {
    const { room, roomKey, nodes: [A, B] } = await directRoom(t, 2, { 0: { screen: { isolatedMs: 1500 } } })
    const ended = []
    A.events.on('screen-ended', e => { if (e.own) ended.push({ ...e, at: Date.now() }) })
    A.startScreenShare({ preset: 'standard' })
    await B.stop()
    await waitFor(() => A.peers().length === 0, 5000, 'A has no session')
    const alone = Date.now()
    // C opens a session in the time: A continues.
    const C = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast })
    t.after(() => C.stop())
    await C.connect(localAddr(A))
    await waitFor(() => A.peers().includes(C.peerId), 5000, 'C session')
    assert.ok(Date.now() - alone < 1500, 'C came in the time')
    await sleep(2500)
    assert.ok(A.screenState().own, 'A continues')
    assert.equal(ended.length, 0)
    await C.stop()
    await waitFor(() => A.peers().length === 0, 5000, 'A has no session again')
    const alone2 = Date.now()
    await waitFor(() => ended.length === 1, 4000, 'isolated stop')
    assert.equal(ended[0].reason, 'isolated')
    assert.ok(ended[0].at - alone2 >= 1300, `stopped after ${ended[0].at - alone2} ms`)
    assert.equal(A.screenState().own, null)
})

test('check 13: setScreenSize sends CONFIG with the new size and asks for a keyframe', { timeout: 30000 }, async t => {
    const { nodes: [A, B] } = await directRoom(t, 2)
    const enc = fakeEncoder(A)
    t.after(() => enc.stop())
    A.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => B.screenState().peers[A.peerId], 2000, 'state')
    const b = collect(B)
    await B.watchScreen(A.peerId)
    await waitFor(() => b.frames.length > 5, 5000, 'frames')
    const keyEvents = () => enc.events.filter(e => e.tiers.some(x => x.keyFrame)).length
    const keysBefore = keyEvents()
    assert.equal(A.setScreenSize({ tier: tierOf(A), width: 1024, height: 576 }), true)
    await waitFor(() => b.configs.some(c => c.width === 1024 && c.height === 576), 2000, 'CONFIG with the new size')
    await waitFor(() => keyEvents() > keysBefore, 3000, 'a keyframe request')
    const configAt = b.configs.find(c => c.width === 1024).at
    await waitFor(() => b.frames.some(f => f.at >= configAt), 3000, 'frames after the CONFIG')
    assert.equal(b.frames.find(f => f.at >= configAt).key, true, 'the first frame after CONFIG is a keyframe')
    assert.equal(A.setScreenSize({ tier: tierOf(A), width: 2561, height: 576 }), false)
})

test('check 13a: the numbers of each stream have no gap across a tier move; a T2 drop gives a gap before a keyframe', { timeout: 40000 }, async t => {
    const { nodes: [A, B, C] } = await directRoom(t, 3)
    let big = false
    const enc = fakeEncoder(A, { size: () => big ? 20000 : 1000 })
    t.after(() => enc.stop())
    A.startScreenShare({ preset: 'auto', width: 1280, height: 720 })
    await waitFor(() => B.screenState().peers[A.peerId] && C.screenState().peers[A.peerId], 2000, 'state')
    const b = collect(B)
    const c = collect(C)
    await B.watchScreen(A.peerId)
    await C.watchScreen(A.peerId)
    await waitFor(() => b.frames.length > 10 && c.frames.length > 10, 5000, 'frames')
    // The test hook of rule A7: C goes to the slow tier, then back.
    A.screenTestRate().forceSlow(C.peerId, true)
    await waitFor(() => A.screenState().own.tiers.length === 2, 2000, 'two tiers')
    const configs = c.configs.length
    await waitFor(() => c.configs.length > configs, 3000, 'CONFIG of the slow tier')
    const movedAt = c.configs.at(-1).at
    await waitFor(() => c.frames.some(f => f.at > movedAt), 4000, 'C gets frames of the slow tier')
    A.screenTestRate().forceSlow(C.peerId, false)
    await waitFor(() => A.screenState().own.tiers.length === 1, 2000, 'one tier again')
    const back = c.configs.length
    await waitFor(() => c.configs.length > back, 3000, 'CONFIG of the fast tier')
    await sleep(2500)
    for (const got of [b, c]) {
        got.frames.forEach((f, i) => assert.equal(f.seq, i, `no gap: frame ${i}`))
    }
    // Rule T2: frames of 20 kB at 15 frames each second fill the queue of 1 s at the pacer rate.
    big = true
    await sleep(6000)
    big = false
    enc.stop()
    const gaps = []
    for (let i = 1; i < b.frames.length; i++) if (b.frames[i].seq !== b.frames[i - 1].seq + 1) gaps.push(b.frames[i])
    assert.ok(gaps.length > 0, 'a T2 drop gave a gap')
    assert.ok(gaps.every(f => f.key), 'each frame after a gap is a keyframe')
    assert.ok(A.screenStats().own.viewers.every(v => v.dropped > 0))
})

// L11 (P10b): a screen line with sharing true needs no stream. One fake line blocked each Start ("Another member shares
// a screen."), and a fake line of a lower peer ID stopped a running share with the reason conflict. The node had no rate
// limit for screen lines (2000 lines gave 2001 screen-state events). The fix has three parts. These tests use a node
// with an unchanged node.mjs that sends the lines with sendTo (a changed client).
// 1.0.6: a fake line takes one place of the share limit (one place for each member). The first two tests use a limit
// of 1, so that one fake line is at the limit, as before.
const fakeShare = () => ({ type: 'screen', v: 1, sharing: true, shareId: randomUUID(), preset: 'standard' })

test('L11: a share that sends no CONFIG goes out of the list after the Watch timeout; then Start works', { timeout: 30000 }, async t => {
    const { nodes: [M, P] } = await directRoom(t, 2, { 1: { screen: { watchTimeoutMs: 500, maxShares: 1 } } })
    // M answers no screen stream: the stream opens and no record comes (a changed client).
    await M.libp2p.unhandle(SCREEN_PROTOCOL)
    await M.libp2p.handle(SCREEN_PROTOCOL, () => {}, { runOnTransientConnection: true })
    assert.equal(M.sendTo(P.peerId, fakeShare()), true)
    await waitFor(() => P.screenState().peers[M.peerId], 5000, 'P has the fake share')
    assert.throws(() => P.startScreenShare({ preset: 'standard' }), /Share limit reached \(1\)/)
    await assert.rejects(P.watchScreen(M.peerId), /not available \(timeout\)/)
    assert.equal(P.screenState().peers[M.peerId], undefined)
    P.startScreenShare({ preset: 'standard' })
    assert.ok(P.screenState().own)
})

test('L11: a share line of a lower peer ID after the conflict time does not stop a running share', { timeout: 30000 }, async t => {
    const { nodes } = await directRoom(t, 2, { 0: { screen: { conflictMs: 300, maxShares: 1 } }, 1: { screen: { conflictMs: 300, maxShares: 1 } } })
    const [low, high] = nodes[0].peerId < nodes[1].peerId ? nodes : [nodes[1], nodes[0]]
    const ended = []
    high.events.on('screen-ended', e => { if (e.own) ended.push(e) })
    high.startScreenShare({ preset: 'standard' })
    await sleep(600)
    assert.equal(low.sendTo(high.peerId, fakeShare()), true)
    await waitFor(() => high.screenState().peers[low.peerId], 5000, 'high has the line of low')
    await sleep(200)
    assert.ok(high.screenState().own, 'the share of high continues')
    assert.deepEqual(ended, [])
})

test('L11: 2000 screen lines of one peer give at most 30 screen-state events', { timeout: 30000 }, async t => {
    const { nodes: [M, P] } = await directRoom(t, 2)
    let events = 0
    P.events.on('screen-state', e => { if (e.peerId === M.peerId) events++ })
    // The chat queue holds 512 lines: send in parts of 200.
    for (let i = 0; i < 2000; i++) {
        assert.equal(M.sendTo(P.peerId, fakeShare()), true)
        if (i % 200 === 199) await sleep(50)
    }
    M.sendTo(P.peerId, { type: 'presence', v: 1, state: 'away', note: 'end of the screen lines' })
    await waitFor(() => P.peerPresence()[M.peerId]?.note === 'end of the screen lines', 15000, 'P read all lines')
    assert.ok(events <= 30, `screen-state events: ${events}`)
})
