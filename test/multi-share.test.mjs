// Multi-person screen share, step 1 (1.0.6): several members share at the same time, at most SCREEN_DEFAULTS.maxShares
// shares in a room, each viewer watches one share and switches. The wire format of 1.0.1 to 1.0.5 does not change.
// Real libp2p nodes on 127.0.0.1 (127.0.0.1 results on one computer, not LAN results).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { SCREEN_DEFAULTS, SCREEN_PROTOCOL, readRecords, record } from '../src/network/screen-share.mjs'
import { SCREEN_TYPE } from '../src/network/screen-rate.mjs'
import { createJournal } from '../src/application/journal.mjs'
import { journalNodeEvents } from '../src/application/diag-events.mjs'

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
const roomName = () => `multi-share-${Date.now()}-${Math.random().toString(16).slice(2)}`

// A keyed room with direct TCP sessions. Each node connects to each earlier node (a full mesh, so that each screen
// line reaches each member at once).
async function directRoom(t, count, extra = {}) {
    const room = roomName()
    const roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    for (let i = 0; i < count; i++) {
        nodes.push(await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast, ...(extra[i] ?? {}) }))
    }
    for (let i = 1; i < count; i++) for (let j = 0; j < i; j++) await nodes[i].connect(localAddr(nodes[j]))
    await waitFor(() => nodes.every(n => nodes.every(m => m === n || n.peers().includes(m.peerId))), 20000, 'sessions')
    return { room, roomKey, nodes }
}

// The window side of a sharer: the size of each new tier preset (rule E7), then frames at a fixed rate.
function fakeEncoder(node, { fps = 15, size = 1000 } = {}) {
    const tiers = new Map()
    node.events.on('screen-encoder', e => {
        const seen = new Set()
        for (const tier of e.tiers) {
            seen.add(tier.tier)
            const known = tiers.get(tier.tier)
            if (!known || known.preset !== tier.preset) {
                tiers.set(tier.tier, { preset: tier.preset, key: true })
                node.setScreenSize({ tier: tier.tier, width: tier.width, height: tier.height })
            }
            if (tier.keyFrame) tiers.get(tier.tier).key = true
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
    const out = { frames: [], configs: [], ended: [], states: [] }
    node.events.on('screen-frame', f => out.frames.push({ peerId: f.peerId, shareId: f.shareId, seq: f.seq, key: f.key, at: Date.now() }))
    node.events.on('screen-config', c => out.configs.push({ ...c, at: Date.now() }))
    node.events.on('screen-ended', e => out.ended.push({ ...e, at: Date.now() }))
    node.events.on('screen-state', s => out.states.push({ ...s, at: Date.now() }))
    return out
}
const ownEnds = nodes => {
    const ended = []
    for (const n of nodes) n.events.on('screen-ended', e => { if (e.own) ended.push({ node: n.peerId, ...e }) })
    return ended
}

test('the share limit of a room is 3', () => {
    assert.equal(SCREEN_DEFAULTS.maxShares, 3)
})

test('two members share at the same time; no share stops; each member knows both shares', { timeout: 30000 }, async t => {
    const { nodes: [A, B, C] } = await directRoom(t, 3)
    const ended = ownEnds([A, B])
    const a = A.startScreenShare({ preset: 'standard' })
    await waitFor(() => B.screenState().peers[A.peerId], 2000, 'B knows the share of A')
    const b = B.startScreenShare({ preset: 'standard' })
    await waitFor(() => C.screenState().peers[B.peerId] && A.screenState().peers[B.peerId], 2000, 'A and C know the share of B')
    // Wait longer than the conflict time of the old rule (3 s).
    await sleep(SCREEN_DEFAULTS.conflictMs + 500)
    assert.equal(A.screenState().own?.shareId, a.shareId)
    assert.equal(B.screenState().own?.shareId, b.shareId)
    assert.deepEqual(ended, [])
    const peers = C.screenState().peers
    assert.equal(peers[A.peerId]?.shareId, a.shareId)
    assert.equal(peers[B.peerId]?.shareId, b.shareId)
    assert.equal(A.screenState().peers[B.peerId]?.shareId, b.shareId)
    assert.equal(B.screenState().peers[A.peerId]?.shareId, a.shareId)
})

test('two shares at the same moment: both continue (no conflict stop below the limit)', { timeout: 30000 }, async t => {
    const { nodes: [A, B] } = await directRoom(t, 2)
    const ended = ownEnds([A, B])
    A.startScreenShare({ preset: 'standard' })
    B.startScreenShare({ preset: 'standard' })
    await sleep(2000)
    assert.ok(A.screenState().own && B.screenState().own)
    assert.deepEqual(ended, [])
})

test('the limit: a fourth Share gets "Share limit reached (3)."; a stop of one share frees a place', { timeout: 40000 }, async t => {
    const { nodes: [A, B, C, D] } = await directRoom(t, 4)
    for (const n of [A, B, C]) {
        n.startScreenShare({ preset: 'standard' })
        await waitFor(() => [A, B, C, D].every(m => m === n || m.screenState().peers[n.peerId]), 2000, 'the share reaches all')
    }
    assert.throws(() => D.startScreenShare({ preset: 'standard' }), /^Error: Share limit reached \(3\)\.$/)
    assert.equal(D.screenState().own, null)
    assert.equal(D.screenState().maxShares, 3)
    B.stopScreenShare()
    await waitFor(() => !D.screenState().peers[B.peerId], 2000, 'D gets the stop of B')
    const d = D.startScreenShare({ preset: 'standard' })
    await waitFor(() => A.screenState().peers[D.peerId]?.shareId === d.shareId, 2000, 'A knows the share of D')
})

test('the limit race: two starts at the same moment with two live shares: the higher peer ID stops, 3 shares stay', { timeout: 40000 }, async t => {
    const { nodes: [A, B, C, D] } = await directRoom(t, 4)
    for (const n of [A, B]) {
        n.startScreenShare({ preset: 'standard' })
        await waitFor(() => [A, B, C, D].every(m => m === n || m.screenState().peers[n.peerId]), 2000, 'the share reaches all')
    }
    await sleep(SCREEN_DEFAULTS.conflictMs + 200)
    const ended = ownEnds([A, B, C, D])
    C.startScreenShare({ preset: 'standard' })
    D.startScreenShare({ preset: 'standard' })
    await sleep(2000)
    const [low, high] = C.peerId < D.peerId ? [C, D] : [D, C]
    assert.ok(A.screenState().own && B.screenState().own, 'the older shares continue')
    assert.ok(low.screenState().own, 'the lower peer ID of the two new shares continues')
    assert.equal(high.screenState().own, null, 'the higher peer ID stopped')
    assert.equal(ended.length, 1)
    assert.equal(ended[0].node, high.peerId)
    assert.equal(ended[0].reason, 'limit')
    await waitFor(() => Object.keys(A.screenState().peers).length === 2, 2000, 'A knows two other shares')
})

test('the limit: a share that starts before its sessions open stops when the room then has 4 shares', { timeout: 60000 }, async t => {
    const room = roomName()
    const roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    for (let i = 0; i < 4; i++) nodes.push(await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast }))
    // D has the lowest peer ID: a rule of the highest peer ID alone does not stop it.
    nodes.sort((x, y) => (x.peerId < y.peerId ? -1 : 1))
    const [D, A, B, C] = nodes
    await B.connect(localAddr(A))
    await C.connect(localAddr(A))
    await C.connect(localAddr(B))
    await waitFor(() => [A, B, C].every(n => n.peers().length === 2), 20000, 'the sessions of A, B and C')
    for (const n of [A, B, C]) n.startScreenShare({ preset: 'standard' })
    await waitFor(() => [A, B, C].every(n => Object.keys(n.screenState().peers).length === 2), 3000, 'three shares')
    await sleep(SCREEN_DEFAULTS.conflictMs + 200)
    const ended = ownEnds([A, B, C, D])
    // D has no session yet: its Start sees no share.
    D.startScreenShare({ preset: 'standard' })
    for (const n of [A, B, C]) await D.connect(localAddr(n))
    await waitFor(() => D.peers().length === 3, 20000, 'the sessions of D')
    await waitFor(() => ended.length > 0, 5000, 'a share stops')
    await sleep(500)
    assert.deepEqual(ended.map(e => [e.node, e.reason]), [[D.peerId, 'limit']])
    assert.equal(D.screenState().own, null)
    assert.ok(A.screenState().own && B.screenState().own && C.screenState().own, 'the three older shares continue')
})

test('old client: the share line of a 1.0.5 sharer with a lower peer ID, in the conflict time, does not stop a new share', { timeout: 30000 }, async t => {
    const { nodes } = await directRoom(t, 2)
    const [low, high] = nodes[0].peerId < nodes[1].peerId ? nodes : [nodes[1], nodes[0]]
    const ended = ownEnds([high])
    high.startScreenShare({ preset: 'standard' })
    // The line of a 1.0.1 to 1.0.5 client that starts a share (the same fields as in 1.0.5).
    assert.equal(low.sendTo(high.peerId, { type: 'screen', v: 1, sharing: true, shareId: randomUUID(), preset: 'auto' }), true)
    await waitFor(() => high.screenState().peers[low.peerId], 2000, 'high has the line of low')
    await sleep(300)
    assert.ok(high.screenState().own, 'the new share continues')
    assert.deepEqual(ended, [])
})

test('watch one share at a time: frames only from the watched share; a switch ends the old watch at its sharer', { timeout: 60000 }, async t => {
    const { nodes: [A, B, C] } = await directRoom(t, 3)
    const encA = fakeEncoder(A)
    const encB = fakeEncoder(B)
    t.after(() => { encA.stop(); encB.stop() })
    const a = A.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    const b = B.startScreenShare({ preset: 'standard', width: 1280, height: 720 })
    await waitFor(() => C.screenState().peers[A.peerId] && C.screenState().peers[B.peerId], 2000, 'C knows both shares')
    const got = collect(C)

    const watchFor = async (sharer, share, other) => {
        const from = got.frames.length
        const config = await C.watchScreen(sharer.peerId)
        assert.equal(config.shareId, share.shareId)
        await waitFor(() => sharer.screenState().own.viewers.includes(C.peerId), 2000, 'the sharer has C as a viewer')
        // The old watch ends at the other sharer in 1 s.
        await waitFor(() => !other.screenState().own.viewers.includes(C.peerId), 1000, 'the other sharer has no viewer C')
        assert.equal(C.screenState().watching, sharer.peerId)
        await sleep(2000)
        const frames = got.frames.slice(from)
        assert.ok(frames.length >= 20, `frames of the watched share: ${frames.length}`)
        assert.ok(frames.every(f => f.peerId === sharer.peerId && f.shareId === share.shareId), 'each frame comes from the watched share')
        assert.equal(frames[0].key, true, 'the first frame is a keyframe')
        frames.forEach((f, i) => assert.equal(f.seq, i, 'the sequence starts at 0 for each watch'))
        return frames.length
    }
    await watchFor(A, a, B)
    await watchFor(B, b, A)
    await watchFor(A, a, B)
    // Each viewer event of a watch carries the share ID.
    assert.ok(got.configs.every(c => c.shareId === a.shareId || c.shareId === b.shareId))
    // A switch is not an end: no screen-ended event for the user switch.
    assert.deepEqual(got.ended, [])
    C.unwatchScreen()
    await waitFor(() => A.screenState().own.viewers.length === 0 && B.screenState().own.viewers.length === 0, 1000, 'no viewer at A and B')
})

test('old client: a viewer with the 1.0.5 records watches each of two live shares', { timeout: 30000 }, async t => {
    const { nodes: [A, B, C] } = await directRoom(t, 3)
    const encA = fakeEncoder(A)
    const encB = fakeEncoder(B)
    t.after(() => { encA.stop(); encB.stop() })
    const shares = new Map([[A, A.startScreenShare({ preset: 'standard', width: 1280, height: 720 }).shareId],
        [B, B.startScreenShare({ preset: 'standard', width: 1280, height: 720 }).shareId]])
    await waitFor(() => C.screenState().peers[A.peerId] && C.screenState().peers[B.peerId], 2000, 'C knows both shares')
    for (const [sharer, shareId] of shares) {
        // The records of the 1.0.1 to 1.0.5 viewer: WATCH { v: 1, shareId }, then ACK for each FRAME.
        const connection = C.libp2p.getConnections().find(c => c.remotePeer.toString() === sharer.peerId)
        const stream = await connection.newStream(SCREEN_PROTOCOL, { runOnTransientConnection: true })
        const types = []
        const done = readRecords(stream.source, (type, body) => {
            types.push(type)
            if (type === SCREEN_TYPE.CONFIG) assert.equal(JSON.parse(body.toString()).shareId, shareId)
            if (type === SCREEN_TYPE.FRAME) {
                const ack = Buffer.alloc(4)
                ack.writeUInt32BE(body.readUInt32BE(1))
                stream.send(record(SCREEN_TYPE.ACK, ack))
            }
        }, 2 * 1024 * 1024).catch(() => {})
        stream.send(record(SCREEN_TYPE.WATCH, Buffer.from(JSON.stringify({ v: 1, shareId }))))
        await waitFor(() => types.filter(x => x === SCREEN_TYPE.FRAME).length >= 10, 5000, 'frames for the old viewer')
        assert.equal(types[0], SCREEN_TYPE.CONFIG)
        stream.abort(new Error('done'))
        await done
    }
})

test('journal: the screen events carry the share ID and the peer ID, no name', { timeout: 40000 }, async t => {
    const { nodes: [A, B, C] } = await directRoom(t, 3, { 0: { name: 'Sharer Ann' }, 1: { name: 'Sharer Bo' }, 2: { name: 'Viewer Cy' } })
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-multi-share-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const journals = new Map()
    for (const n of [A, C]) {
        const journal = createJournal({ dir: path.join(dir, n.peerId), budgets: { default: [1e6, 0] } })
        journalNodeEvents((type, fn) => n.events.on(type, fn), (type, fields) => journal.write(type, fields), n.peerId)
        journals.set(n, journal)
    }
    const encA = fakeEncoder(A)
    const encB = fakeEncoder(B)
    t.after(() => { encA.stop(); encB.stop() })
    const a = A.startScreenShare({ preset: 'standard' })
    const b = B.startScreenShare({ preset: 'standard' })
    await waitFor(() => C.screenState().peers[A.peerId] && C.screenState().peers[B.peerId], 2000, 'C knows both shares')
    await C.watchScreen(A.peerId)
    await C.watchScreen(B.peerId)
    await sleep(300)
    C.unwatchScreen()
    B.stopScreenShare()
    await waitFor(() => !C.screenState().peers[B.peerId], 2000, 'C gets the stop of B')
    A.stopScreenShare()
    await waitFor(() => !C.screenState().peers[A.peerId], 2000, 'C gets the stop of A')
    const read = n => {
        journals.get(n).flushSync()
        const folder = path.join(dir, n.peerId)
        return readdirSync(folder).filter(name => name.endsWith('.jsonl'))
            .flatMap(name => readFileSync(path.join(folder, name), 'utf8').split('\n').filter(Boolean)).map(line => JSON.parse(line))
            .filter(line => line.type === 'screen')
    }
    const pick = (lines, event) => lines.filter(line => line.event === event).map(({ share, peer, reason }) => ({ share, peer, reason }))
    const sharer = read(A)
    assert.deepEqual(pick(sharer, 'start'), [{ share: a.shareId, peer: undefined, reason: undefined }])
    assert.deepEqual(pick(sharer, 'stop'), [{ share: a.shareId, peer: undefined, reason: 'stopped' }])
    assert.deepEqual(pick(sharer, 'live'), [{ share: b.shareId, peer: B.peerId, reason: undefined }])
    const viewer = read(C)
    assert.deepEqual(pick(viewer, 'live').sort((x, y) => x.peer.localeCompare(y.peer)),
        [{ share: a.shareId, peer: A.peerId, reason: undefined }, { share: b.shareId, peer: B.peerId, reason: undefined }]
            .sort((x, y) => x.peer.localeCompare(y.peer)))
    assert.deepEqual(pick(viewer, 'watch'), [{ share: a.shareId, peer: A.peerId, reason: undefined },
        { share: b.shareId, peer: B.peerId, reason: undefined }])
    assert.deepEqual(pick(viewer, 'watch-end'), [{ share: a.shareId, peer: A.peerId, reason: 'switched' },
        { share: b.shareId, peer: B.peerId, reason: 'unwatched' }])
    assert.deepEqual(pick(viewer, 'gone'), [{ share: b.shareId, peer: B.peerId, reason: undefined },
        { share: a.shareId, peer: A.peerId, reason: undefined }])
    const text = JSON.stringify([...sharer, ...viewer])
    for (const name of ['Sharer', 'Viewer', 'Ann', 'Bo', 'Cy']) assert.ok(!text.includes(name), `no name in the journal (${name})`)
})
