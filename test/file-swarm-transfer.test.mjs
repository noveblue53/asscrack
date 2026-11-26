import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode, FILE_SWARM_PROTOCOL } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

const PIECE_SIZE = 32768
const FILE_SIZE = PIECE_SIZE * 6 // 196608 bytes = 6 pieces

function makePayload(size, seed = 1) {
    const buf = Buffer.allocUnsafe(size)
    for (let i = 0; i < size; i++) buf[i] = (i * 37 + seed * 13) & 0xff
    const sha256 = createHash('sha256').update(buf).digest('hex')
    return { buf, sha256 }
}

async function waitFor(check, label, limit = 15000) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        const res = check()
        if (res) return res
        await delay(20)
    }
    assert.fail(label)
}

async function shaFile(filePath) {
    const data = await fsp.readFile(filePath)
    return createHash('sha256').update(data).digest('hex')
}

async function setupNodes(count, opts = {}) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asscrack-swarm-xfer-'))
    const roomKey = newRoomKey()
    const nodes = []
    for (let i = 0; i < count; i++) {
        const dl = path.join(dir, `dl-${i}`)
        await fsp.mkdir(dl, { recursive: true })
        const perNode = typeof opts === 'function' ? opts(i) : opts
        const node = await createAsscrackNode({
            room: 'swarm-test',
            roomKey,
            name: `Peer-${i}`,
            discovery: false,
            fullNode: false,
            listen: ['/ip4/127.0.0.1/tcp/0'],
            downloadDir: dl,
            fileSwarmOptions: { pieceSize: PIECE_SIZE, tickMs: 100, noPeerTimeoutMs: 4000 },
            ...perNode
        })
        node.dlDir = dl
        nodes.push(node)
    }
    for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
            await nodes[i].connect(nodes[j].getMultiaddrs()[0])
            await waitFor(() => nodes[i].peers().includes(nodes[j].peerId) && nodes[j].peers().includes(nodes[i].peerId), 'peers connected')
        }
    }
    return { dir, nodes }
}

async function cleanup({ dir, nodes }) {
    await Promise.allSettled(nodes.map(n => n.stop()))
    await fsp.rm(dir, { recursive: true, force: true })
}

function toBuf(chunk) {
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (typeof chunk?.subarray === 'function') return Buffer.from(chunk.subarray())
    return Buffer.concat([...chunk].map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength)))
}

// Intercepts outgoing FILE_SWARM_PROTOCOL piece requests from `receiver` to `sender`.
// `filter(index)` returns: 'pass' | 'hang' | 'corrupt'
function gateSwarmPieces(receiver, senderPeerId, filter) {
    const gate = Promise.withResolvers()
    for (const conn of receiver.libp2p.getConnections()) {
        if (conn.remotePeer.toString() !== senderPeerId) continue
        const origNewStream = conn.newStream.bind(conn)
        conn.newStream = async (protocol, options) => {
            const stream = await origNewStream(protocol, options)
            if (protocol !== FILE_SWARM_PROTOCOL) return stream
            options?.signal?.addEventListener('abort', () => gate.resolve(), { once: true })
            let mode = 'pass'
            const origSink = stream.sink.bind(stream)
            stream.sink = async iterable => {
                const chunks = []
                for await (const c of iterable) chunks.push(toBuf(c))
                const raw = Buffer.concat(chunks)
                try {
                    const req = JSON.parse(raw.toString('utf8').trim())
                    if (req.op === 'piece') mode = filter(req.index)
                } catch {}
                return origSink([raw])
            }
            const origSource = stream.source
            stream.source = (async function* () {
                if (mode === 'hang') {
                    await gate.promise
                    return
                }
                if (mode === 'corrupt') {
                    const all = []
                    for await (const c of origSource) all.push(toBuf(c))
                    const buf = Buffer.concat(all)
                    const lf = buf.indexOf(10)
                    if (lf >= 0 && lf + 1 < buf.length) {
                        buf[lf + 1] ^= 0xff
                    }
                    yield buf
                    return
                }
                yield* origSource
            })()
            return stream
        }
    }
    return { release: () => gate.resolve() }
}

test('127.0.0.1: multi-peer Shared Shelf swarm completes after publisher leaves via leecher piece exchange', { timeout: 30000 }, async t => {
    const ctx = await setupNodes(3)
    t.after(() => cleanup(ctx))
    const [a, b, c] = ctx.nodes
    const { buf, sha256 } = makePayload(FILE_SIZE, 5)
    const srcFile = path.join(ctx.dir, 'bundle.bin')
    await fsp.writeFile(srcFile, buf)

    const fileId = await a.publishShelfFile(srcFile)
    const row = (node, peerId) => node.shelf().items.find(i => i.peerId === peerId && i.id === fileId)
    await waitFor(() => row(b, a.peerId)?.available && row(c, a.peerId)?.available, 'shelf listing reached B and C')

    // Give B only even pieces from A, and C only odd pieces from A; hang the other parity until A stops.
    const gateB = gateSwarmPieces(b, a.peerId, idx => (idx % 2 === 0 ? 'pass' : 'hang'))
    const gateC = gateSwarmPieces(c, a.peerId, idx => (idx % 2 === 1 ? 'pass' : 'hang'))

    const doneB = []
    const doneC = []
    b.events.on('file-done', e => { if (e.direction === 'receive') doneB.push(e) })
    c.events.on('file-done', e => { if (e.direction === 'receive') doneC.push(e) })

    assert.equal(b.downloadShelfFile(a.peerId, fileId), true)
    assert.equal(c.downloadShelfFile(a.peerId, fileId), true)

    await waitFor(() => {
        const sb = b.swarmStatus().find(s => s.sha256 === sha256)
        const sc = c.swarmStatus().find(s => s.sha256 === sha256)
        return sb && sb.haveCount >= 3 && sc && sc.haveCount >= 3
    }, 'B and C each received initial pieces from A')

    // Publisher A leaves mid-transfer!
    gateB.release()
    gateC.release()
    await a.stop()

    await waitFor(() => doneB.length === 1 && doneC.length === 1, 'B and C both completed from each other')
    assert.equal(doneB[0].swarmed, true)
    assert.equal(doneC[0].swarmed, true)
    assert.equal(await shaFile(doneB[0].path), sha256)
    assert.equal(await shaFile(doneC[0].path), sha256)
})

test('127.0.0.1: completed downloader B seeds Shared Shelf file to C after publisher A leaves', { timeout: 30000 }, async t => {
    const ctx = await setupNodes(3)
    t.after(() => cleanup(ctx))
    const [a, b, c] = ctx.nodes
    const { buf, sha256 } = makePayload(FILE_SIZE, 9)
    const srcFile = path.join(ctx.dir, 'patch.bin')
    await fsp.writeFile(srcFile, buf)

    const fileId = await a.publishShelfFile(srcFile)
    const row = (node, peerId) => node.shelf().items.find(i => i.peerId === peerId && i.id === fileId)
    await waitFor(() => row(b, a.peerId)?.available && row(c, a.peerId)?.available, 'shelf listing reached B and C')

    const doneB = []
    const doneC = []
    b.events.on('file-done', e => { if (e.direction === 'receive') doneB.push(e) })
    c.events.on('file-done', e => { if (e.direction === 'receive') doneC.push(e) })

    // B downloads and completes, becoming a full seeder.
    assert.equal(b.downloadShelfFile(a.peerId, fileId), true)
    await waitFor(() => doneB.length === 1, 'B completed download')
    assert.equal(b.swarmStatus().find(s => s.sha256 === sha256)?.role, 'seed')

    // Gate C's piece requests to A so C only gets the manifest from A, then A stops.
    const gateC = gateSwarmPieces(c, a.peerId, () => 'hang')
    assert.equal(c.downloadShelfFile(a.peerId, fileId), true)
    await waitFor(() => c.swarmStatus().some(s => s.sha256 === sha256), 'C started swarm download')

    gateC.release()
    await a.stop()

    await waitFor(() => doneC.length === 1, 'C completed download from B')
    assert.equal(doneC[0].swarmed, true)
    assert.equal(await shaFile(doneC[0].path), sha256)
})

test('127.0.0.1: bad-piece hash mismatch bans corrupt peer after 2 bad pieces and completes from honest peer', { timeout: 30000 }, async t => {
    const ctx = await setupNodes(3)
    t.after(() => cleanup(ctx))
    const [a, b, c] = ctx.nodes
    const { buf, sha256 } = makePayload(FILE_SIZE, 15)
    const srcFile = path.join(ctx.dir, 'verified.bin')
    await fsp.writeFile(srcFile, buf)

    const fileId = await a.publishShelfFile(srcFile)
    const row = (node, peerId) => node.shelf().items.find(i => i.peerId === peerId && i.id === fileId)
    await waitFor(() => row(b, a.peerId)?.available && row(c, a.peerId)?.available, 'shelf listing reached B and C')

    // B downloads honestly first so B can serve good pieces.
    const doneB = []
    b.events.on('file-done', e => { if (e.direction === 'receive') doneB.push(e) })
    assert.equal(b.downloadShelfFile(a.peerId, fileId), true)
    await waitFor(() => doneB.length === 1, 'B completed')

    // Corrupt all piece responses from A to C.
    gateSwarmPieces(c, a.peerId, () => 'corrupt')
    const badEvents = []
    const doneC = []
    c.events.on('file-swarm-bad-piece', e => badEvents.push(e))
    c.events.on('file-done', e => { if (e.direction === 'receive') doneC.push(e) })

    assert.equal(c.downloadShelfFile(a.peerId, fileId), true)
    await waitFor(() => doneC.length === 1, 'C completed from honest peer B')

    const bans = badEvents.filter(e => e.peerId === a.peerId && e.banned)
    assert.ok(badEvents.filter(e => e.peerId === a.peerId).length >= 2)
    assert.ok(bans.length >= 1)
    assert.equal(await shaFile(doneC[0].path), sha256)
})

test('127.0.0.1: setSwarmSeeding(false) blocks serving pieces', { timeout: 30000 }, async t => {
    const ctx = await setupNodes(2)
    t.after(() => cleanup(ctx))
    const [a, b] = ctx.nodes
    const { buf, sha256 } = makePayload(FILE_SIZE, 21)
    const srcFile = path.join(ctx.dir, 'optout.bin')
    await fsp.writeFile(srcFile, buf)

    await a.publishShelfFile(srcFile)
    a.setSwarmSeeding(false)
    assert.equal(a.swarmStatus().find(s => s.sha256 === sha256)?.seedingEnabled, false)

    // Direct FILE_SWARM_PROTOCOL piece request from B to A must be refused as busy.
    const [conn] = b.libp2p.getConnections().filter(c => c.remotePeer.toString() === a.peerId)
    const stream = await conn.newStream(FILE_SWARM_PROTOCOL)
    await stream.sink([Buffer.from(JSON.stringify({ op: 'piece', sha256, index: 0 }) + '\n')])
    const chunks = []
    for await (const chunk of stream.source) chunks.push(toBuf(chunk))
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8').trim())
    assert.deepEqual(reply, { ok: false, reason: 'busy' })
})

test('127.0.0.1: backward compatibility falls back to FILE_PROTOCOL when either peer disables fileSwarm', { timeout: 30000 }, async t => {
    const ctx = await setupNodes(2, i => ({ fileSwarm: i === 0 }))
    t.after(() => cleanup(ctx))
    const [a, b] = ctx.nodes // A has fileSwarm: true, B has fileSwarm: false
    const { buf, sha256 } = makePayload(FILE_SIZE, 27)
    const srcFile = path.join(ctx.dir, 'compat.bin')
    await fsp.writeFile(srcFile, buf)

    const fileId = await a.publishShelfFile(srcFile)
    const row = (node, peerId) => node.shelf().items.find(i => i.peerId === peerId && i.id === fileId)
    await waitFor(() => row(b, a.peerId)?.available, 'shelf listing reached B')

    const doneB = []
    b.events.on('file-done', e => { if (e.direction === 'receive') doneB.push(e) })
    assert.equal(b.downloadShelfFile(a.peerId, fileId), true)
    await waitFor(() => doneB.length === 1, 'B completed over legacy FILE_PROTOCOL')
    assert.equal(doneB[0].swarmed, undefined)
    assert.equal(await shaFile(doneB[0].path), sha256)
})

test('127.0.0.1: targeted 1:1 file offer cannot be fetched over FILE_SWARM_PROTOCOL by third peer', { timeout: 30000 }, async t => {
    const ctx = await setupNodes(3)
    t.after(() => cleanup(ctx))
    const [a, b, c] = ctx.nodes
    const { buf, sha256 } = makePayload(FILE_SIZE, 33)
    const srcFile = path.join(ctx.dir, 'private.bin')
    await fsp.writeFile(srcFile, buf)

    // Even if swarm were requested on a 1:1 offer, C is not authorized.
    const offer = await a.offerFile(srcFile, b.peerId, { swarm: true })
    assert.equal(offer.peers, 1)

    const [conn] = c.libp2p.getConnections().filter(cn => cn.remotePeer.toString() === a.peerId)
    const stream = await conn.newStream(FILE_SWARM_PROTOCOL)
    await stream.sink([Buffer.from(JSON.stringify({ op: 'manifest', sha256 }) + '\n')])
    const chunks = []
    for await (const chunk of stream.source) chunks.push(toBuf(chunk))
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8').trim())
    assert.deepEqual(reply, { ok: false, reason: 'not-found' })
})

test('127.0.0.1: swarm progress emits seeders/seederBytes, swarmStatus tracks uploadedTo/downloadedFrom, and setSwarmSeeding updates shelf view', { timeout: 30000 }, async t => {
    const ctx = await setupNodes(3)
    t.after(() => cleanup(ctx))
    const [a, b, c] = ctx.nodes
    const { buf, sha256 } = makePayload(FILE_SIZE, 41)
    const srcFile = path.join(ctx.dir, 'swarm-ui-meta.bin')
    await fsp.writeFile(srcFile, buf)

    const fileId = await a.publishShelfFile(srcFile)
    const row = (node, peerId) => node.shelf().items.find(i => i.peerId === peerId && i.id === fileId)
    await waitFor(() => row(b, a.peerId)?.available && row(c, a.peerId)?.available, 'shelf listings reached B and C')

    // B downloads from A first and becomes a seeder.
    const doneB = []
    b.events.on('file-done', e => { if (e.direction === 'receive') doneB.push(e) })
    assert.equal(b.downloadShelfFile(a.peerId, fileId), true)
    await waitFor(() => doneB.length === 1, 'B completed download')

    // Check own shelf item on A reflects seeding: true, then seeding: false after setSwarmSeeding(false).
    assert.equal(row(a, a.peerId)?.seeding, true)
    a.setSwarmSeeding(false)
    assert.equal(row(a, a.peerId)?.seeding, false)
    a.setSwarmSeeding(true)
    assert.equal(row(a, a.peerId)?.seeding, true)

    // C downloads from A and B; capture file-progress events.
    const progressC = []
    const doneC = []
    c.events.on('file-progress', e => { if (e.direction === 'receive') progressC.push(e) })
    c.events.on('file-done', e => { if (e.direction === 'receive') doneC.push(e) })
    assert.equal(c.downloadShelfFile(a.peerId, fileId), true)
    await waitFor(() => doneC.length === 1, 'C completed download')

    const swarmedProg = progressC.find(e => e.swarmed === true)
    assert.ok(swarmedProg, 'file-progress has swarmed: true')
    assert.ok(Array.isArray(swarmedProg.seeders) && swarmedProg.seeders.length >= 1, 'file-progress has seeders array')
    assert.ok(swarmedProg.seederBytes && typeof swarmedProg.seederBytes === 'object', 'file-progress has seederBytes')

    const statusC = c.swarmStatus().find(s => s.sha256 === sha256)
    assert.ok(statusC, 'C has swarmStatus entry')
    assert.ok(Array.isArray(statusC.activeSeedPeers), 'swarmStatus has activeSeedPeers')
    const dlTotal = Object.values(statusC.downloadedFrom).reduce((sum, n) => sum + n, 0)
    assert.equal(dlTotal, FILE_SIZE)

    const statusA = a.swarmStatus().find(s => s.sha256 === sha256)
    const statusB = b.swarmStatus().find(s => s.sha256 === sha256)
    const totalUploaded = Object.values(statusA.uploadedTo).reduce((sum, n) => sum + n, 0) +
        Object.values(statusB.uploadedTo).reduce((sum, n) => sum + n, 0)
    assert.ok(totalUploaded >= FILE_SIZE, 'A and B uploadedTo accounts for transferred bytes')
})
