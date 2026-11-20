import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { multiaddr } from '@multiformats/multiaddr'
import { createAsscrackNode } from '../src/network/node.mjs'
import { FILE_PROTOCOL, safeFileName, createFileTransfer } from '../src/network/file-transfer.mjs'
import { EventEmitter } from 'node:events'

const base = { room: 'files', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false,
    heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 300 }
const BIG = 50 * 1024 * 1024

async function waitUntil(check, limit) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        if (check()) return
        await delay(20)
    }
    assert.ok(check(), `Condition not true within ${limit} ms`)
}

async function tempDir(prefix) {
    return fsp.mkdtemp(path.join(os.tmpdir(), `asscrack-${prefix}-`))
}

// Makes count nodes, each with its own download folder, in a full mesh.
async function setup(count, options = {}) {
    const dirs = []
    const nodes = []
    const src = await tempDir('src')
    dirs.push(src)
    for (let i = 0; i < count; i++) {
        const d = await tempDir('dl')
        dirs.push(d)
        nodes.push(await createAsscrackNode({ ...base, ...options, downloadDir: d }))
        nodes[i].dir = d
        nodes[i].log = record(nodes[i])
    }
    for (let i = 0; i < count; i++)
        for (let j = i + 1; j < count; j++) {
            await nodes[i].connect(nodes[j].getMultiaddrs()[0])
            await waitUntil(() => nodes[i].peers().includes(nodes[j].peerId) && nodes[j].peers().includes(nodes[i].peerId), 5000)
        }
    return { nodes, dirs, src }
}

async function cleanup({ nodes, dirs }) {
    await Promise.allSettled(nodes.map(n => n.stop()))
    await Promise.allSettled(dirs.map(d => fsp.rm(d, { recursive: true, force: true })))
}

function record(node) {
    const log = { offer: [], progress: [], done: [], failed: [], refused: [], cancelled: [] }
    for (const k of Object.keys(log)) node.events.on(`file-${k}`, e => log[k].push(e))
    return log
}

async function sha(file) {
    const h = createHash('sha256')
    for await (const c of createReadStream(file)) h.update(c)
    return h.digest('hex')
}

async function writeRandom(file, size) {
    const fh = await fsp.open(file, 'w')
    try {
        for (let done = 0; done < size; done += 1 << 20) await fh.write(randomBytes(Math.min(1 << 20, size - done)))
    } finally {
        await fh.close()
    }
}

const entries = dir => fsp.readdir(dir)
const acceptOnOffer = node => node.events.on('file-offer', ({ offerId }) => node.acceptFile(offerId))

async function fetchWithoutOffer(receiver, sender, offerId) {
    const stream = await receiver.libp2p.dialProtocol(multiaddr(sender.getMultiaddrs()[0]), FILE_PROTOCOL)
    const sent = stream.sink([Buffer.from(JSON.stringify({ offerId }) + '\n')]).catch(() => {})
    let bytes = 0
    // A refusal may close the stream cleanly or reset it. Count any bytes that arrived before either outcome.
    try {
        for await (const chunk of stream.source) bytes += chunk.length
    } catch {}
    await sent
    return bytes
}

test('a file offered to one of two identically named peers stays with that peer (127.0.0.1)', { timeout: 30000 }, async () => {
    const ctx = await setup(3, { name: 'Sam' })
    const [a, b, c] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'private-note.txt')
        await fsp.writeFile(file, 'for B')
        const offer = await a.offerFile(file, b.peerId)
        assert.equal(offer.peers, 1)
        await waitUntil(() => b.log.offer.length === 1, 5000)
        assert.equal(c.acceptFile(offer.offerId), false)
        assert.equal(await fetchWithoutOffer(c, a, offer.offerId), 0)
        assert.equal(b.acceptFile(offer.offerId), true)
        await waitUntil(() => a.log.done.length === 1 && b.log.done.length === 1, 5000)
        assert.equal(await sha(b.log.done[0].path), offer.sha256)
        assert.equal(a.log.done[0].peerId, b.peerId)
        assert.equal(a.log.done[0].confirmed, true)

        const next = await a.offerFile(file, b.peerId)
        await waitUntil(() => b.log.offer.length === 2, 5000)
        assert.equal(a.cancelFile(next.offerId, c.peerId), false)
        assert.equal(a.cancelFile(next.offerId, b.peerId), true)
        await waitUntil(() => b.log.cancelled.some(e => e.offerId === next.offerId), 5000)
        assert.equal(b.acceptFile(next.offerId), false)

        await b.stop()
        await waitUntil(() => !a.peers().includes(b.peerId), 5000)
        for (const invalid of [b.peerId, 'Sam', '', null, {}]) {
            await assert.rejects(a.offerFile(file, invalid), /recipient/)
        }
        // This later message on the same chat stream also drains all earlier controls to C.
        a.send('finished')
        await waitUntil(() => c.history().some(m => m.text === 'finished'), 5000)
        assert.deepEqual(c.history().map(m => m.text), ['finished'])
        assert.deepEqual(c.log.offer, [])
        assert.deepEqual(c.log.cancelled, [])
        assert.deepEqual(await entries(c.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('a: a 50 MB file goes from A to B with the correct SHA-256', { timeout: 120000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'big.bin')
        await writeRandom(file, BIG)
        await waitUntil(() => a.host() !== null && b.host() !== null, 5000)
        const hostBefore = a.host()
        assert.deepEqual(b.host(), hostBefore)
        acceptOnOffer(b)
        const t0 = Date.now()
        const offer = await a.offerFile(file)
        assert.equal(offer.peers, 1)
        await waitUntil(() => b.log.done.length === 1 || b.log.failed.length > 0, 90000)
        console.log(`50 MB transfer time: ${Date.now() - t0} ms`)
        assert.deepEqual(b.log.failed, [])
        assert.equal(b.log.done[0].direction, 'receive')
        assert.equal(await sha(b.log.done[0].path), await sha(file))
        await waitUntil(() => a.log.done.length + a.log.failed.length > 0, 5000)
        assert.deepEqual(a.log.failed, [])
        assert.equal(a.log.done[0].confirmed, true)
        assert.equal(offer.sha256, await sha(file))
        assert.deepEqual(await entries(b.dir), ['big.bin'])
        assert.deepEqual(a.host(), hostBefore)
        assert.deepEqual(b.host(), hostBefore)
    } finally {
        await cleanup(ctx)
    }
})

test('b: B refuses, and C accepts', { timeout: 30000 }, async () => {
    const ctx = await setup(3)
    const [a, b, c] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'doc.txt')
        await writeRandom(file, 300000)
        b.events.on('file-offer', ({ offerId }) => b.refuseFile(offerId))
        acceptOnOffer(c)
        const offer = await a.offerFile(file)
        assert.equal(offer.peers, 2)
        await waitUntil(() => c.log.done.length === 1 && a.log.refused.length === 1, 10000)
        assert.deepEqual(a.log.refused, [{ offerId: offer.offerId, peerId: b.peerId }])
        assert.deepEqual(await entries(b.dir), [])
        assert.equal(await sha(c.log.done[0].path), offer.sha256)
    } finally {
        await cleanup(ctx)
    }
})

test('c: B cancels on its first progress event', { timeout: 60000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'big.bin')
        await writeRandom(file, BIG)
        acceptOnOffer(b)
        b.events.once('file-progress', ({ offerId }) => b.cancelFile(offerId))
        await a.offerFile(file)
        await waitUntil(() => b.log.cancelled.length === 1, 10000)
        assert.equal(b.log.cancelled[0].by, 'self')
        await delay(1000)
        assert.deepEqual(b.log.done, [])
        assert.deepEqual(a.log.done.filter(e => e.peerId === b.peerId), [])
        assert.deepEqual(await entries(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('d: A cancels on the first progress event of B', { timeout: 60000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'big.bin')
        await writeRandom(file, BIG)
        acceptOnOffer(b)
        b.events.once('file-progress', ({ offerId }) => a.cancelFile(offerId))
        await a.offerFile(file)
        await waitUntil(() => b.log.cancelled.length === 1 || b.log.failed.length > 0, 10000)
        assert.deepEqual(b.log.failed, [])
        assert.equal(b.log.cancelled[0].by, 'peer')
        await delay(1000)
        assert.deepEqual(b.log.done, [])
        assert.deepEqual(await entries(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('e: A stops during the transfer', { timeout: 60000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'big.bin')
        await writeRandom(file, BIG)
        acceptOnOffer(b)
        b.events.once('file-progress', () => { a.stop().catch(() => {}) })
        await a.offerFile(file)
        await waitUntil(() => b.log.cancelled.length + b.log.failed.length > 0, 10000)
        assert.deepEqual(b.log.done, [])
        assert.deepEqual(await entries(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('f: B stops during the transfer', { timeout: 60000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'big.bin')
        await writeRandom(file, BIG)
        acceptOnOffer(b)
        let stopped
        b.events.once('file-progress', () => { stopped = b.stop() })
        await a.offerFile(file)
        await waitUntil(() => stopped !== undefined, 10000)
        await stopped
        assert.deepEqual(await entries(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('g: a file with the same name gets a free name', { timeout: 30000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    try {
        await fsp.writeFile(path.join(b.dir, 'same.txt'), 'old')
        const file = path.join(ctx.src, 'same.txt')
        await fsp.writeFile(file, 'new content')
        acceptOnOffer(b)
        await a.offerFile(file)
        await waitUntil(() => b.log.done.length === 1, 10000)
        assert.equal(b.log.done[0].path, path.join(b.dir, 'same (1).txt'))
        assert.equal(await fsp.readFile(path.join(b.dir, 'same (1).txt'), 'utf8'), 'new content')
        assert.equal(await fsp.readFile(path.join(b.dir, 'same.txt'), 'utf8'), 'old')
    } finally {
        await cleanup(ctx)
    }
})

test('h: a file that grows after the offer fails', { timeout: 30000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'grow.bin')
        await writeRandom(file, 200000)
        const offer = await a.offerFile(file)
        await fsp.appendFile(file, randomBytes(10))
        await waitUntil(() => b.log.offer.length === 1, 5000)
        assert.equal(b.acceptFile(offer.offerId), true)
        await waitUntil(() => b.log.failed.length === 1, 10000)
        assert.deepEqual(b.log.done, [])
        assert.deepEqual(await entries(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('i: a changed byte gives a hash mismatch', { timeout: 30000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'change.bin')
        await writeRandom(file, 200000)
        const offer = await a.offerFile(file)
        const fh = await fsp.open(file, 'r+')
        const one = Buffer.alloc(1)
        await fh.read(one, 0, 1, 1000)
        one[0] ^= 0xff
        await fh.write(one, 0, 1, 1000)
        await fh.close()
        await waitUntil(() => b.log.offer.length === 1, 5000)
        b.acceptFile(offer.offerId)
        await waitUntil(() => b.log.failed.length === 1, 10000)
        assert.equal(b.log.failed[0].reason, 'hash mismatch')
        assert.deepEqual(b.log.done, [])
        assert.deepEqual(await entries(b.dir), [])
        await waitUntil(() => a.log.done.length + a.log.failed.length > 0, 5000)
        assert.deepEqual(a.log.done, [])
        assert.equal(a.log.failed[0].offerId, offer.offerId)
        assert.equal(a.log.failed[0].direction, 'send')
    } finally {
        await cleanup(ctx)
    }
})

test('j: a peer that did not get the offer receives no data', { timeout: 30000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    const d = await createAsscrackNode({ ...base })
    ctx.nodes.push(d)
    try {
        const file = path.join(ctx.src, 'secret.bin')
        await writeRandom(file, 200000)
        const offer = await a.offerFile(file)
        assert.equal(offer.peers, 1)
        const dOffers = []
        d.events.on('file-offer', e => dOffers.push(e))
        await d.connect(a.getMultiaddrs()[0])
        await waitUntil(() => a.peers().includes(d.peerId), 5000)
        const bytes = await fetchWithoutOffer(d, a, offer.offerId)
        await delay(200)
        assert.equal(bytes, 0)
        assert.deepEqual(dOffers, [])
        assert.deepEqual(a.log.progress.filter(e => e.peerId === d.peerId), [])
    } finally {
        await cleanup(ctx)
    }
})

test('k: safeFileName', () => {
    assert.equal(safeFileName('..\\..\\x.txt'), 'x.txt')
    assert.equal(safeFileName('../../etc/passwd'), 'passwd')
    assert.equal(safeFileName('CON.txt'), '_CON.txt')
    assert.equal(safeFileName('a<b>:c.txt'), 'a_b__c.txt')
    assert.equal(safeFileName('name. . '), 'name')
    assert.equal(safeFileName(''), 'file')
    assert.equal(safeFileName('..'), 'file')
    const long = safeFileName('a'.repeat(300) + '.txt')
    assert.ok(long.length <= 200)
    assert.ok(long.endsWith('.txt'))
    assert.equal(safeFileName('a\u0007b'), 'a_b')
    assert.equal(safeFileName(5), 'file')
})

test('l: A cancels only the transfer to B, and C gets the file', { timeout: 60000 }, async () => {
    const ctx = await setup(3)
    const [a, b, c] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'big.bin')
        await writeRandom(file, BIG)
        acceptOnOffer(b)
        acceptOnOffer(c)
        b.events.once('file-progress', ({ offerId }) => assert.equal(a.cancelFile(offerId, b.peerId), true))
        const offer = await a.offerFile(file)
        assert.equal(offer.peers, 2)
        await waitUntil(() => (b.log.cancelled.length === 1 || b.log.failed.length > 0) &&
            (c.log.done.length === 1 || c.log.failed.length > 0), 90000)
        assert.deepEqual(b.log.failed, [])
        assert.deepEqual(c.log.failed, [])
        assert.equal(b.log.cancelled[0].by, 'peer')
        assert.equal(await sha(c.log.done[0].path), offer.sha256)
        await waitUntil(() => a.log.done.length + a.log.cancelled.length + a.log.failed.length >= 2, 5000)
        await delay(700)
        assert.deepEqual(a.log.failed, [])
        assert.deepEqual(a.log.cancelled, [{ offerId: offer.offerId, peerId: b.peerId, direction: 'send', by: 'self' }])
        assert.deepEqual(a.log.done.map(e => e.peerId), [c.peerId])
        assert.deepEqual(b.log.done, [])
        assert.deepEqual(await entries(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

// The race: the stream abort of a receiver cancel comes to the sender before the file-cancel line.
// The test drives the sender side directly with a fake stream, so that the order is always the same.
test('m: a stream abort before the file-cancel line gives cancelled by peer on the sender', { timeout: 30000 }, async () => {
    const src = await tempDir('src')
    try {
        const file = path.join(src, 'doc.bin')
        await writeRandom(file, 1 << 20)
        const events = new EventEmitter()
        const log = { cancelled: [], failed: [], done: [] }
        for (const k of Object.keys(log)) events.on(`file-${k}`, e => log[k].push(e))
        const peer = 'peer-b'
        const ft = createFileTransfer({ libp2p: null, events, sendTo: () => true, openPeers: () => [peer],
            peerNames: () => ({}), downloadDir: src })
        const { offerId } = await ft.offerFile(file)
        let aborted = false
        const stream = {
            source: (async function* () { yield Buffer.from(JSON.stringify({ offerId }) + '\n') })(),
            async sink(source) {
                for await (const _ of source) throw new Error('stream reset')
            },
            async close() {},
            abort() { aborted = true }
        }
        ft.handleStream({ stream, connection: { remotePeer: { toString: () => peer } } })
        await waitUntil(() => aborted, 5000)
        await delay(100)
        ft.handleControl(peer, { type: 'file-cancel', offerId })
        await waitUntil(() => log.cancelled.length + log.failed.length > 0, 5000)
        assert.deepEqual(log.failed, [])
        assert.deepEqual(log.cancelled, [{ offerId, peerId: peer, direction: 'send', by: 'peer' }])
    } finally {
        await fsp.rm(src, { recursive: true, force: true })
    }
})

// A wire-level receiver can choose the 0.7.0 header or advertise receipts and withhold one.
async function requestFile(receiver, sender, header) {
    await waitUntil(() => receiver.log.offer.some(e => e.offerId === header.offerId), 5000)
    const [connection] = receiver.libp2p.getConnections(sender.libp2p.peerId)
    const stream = await connection.newStream(FILE_PROTOCOL)
    await stream.sink([Buffer.from(JSON.stringify(header) + '\n')])
    return { connection, stream }
}

test('n: losing the receiver while its file is still buffered fails the sender', { timeout: 30000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'buffered.bin')
        await writeRandom(file, 96 * 1024)
        const { offerId } = await a.offerFile(file)
        const { connection, stream } = await requestFile(b, a, { offerId, ack: 1 })

        // The sender's FIN has reached B, but B has yet to consume or save any data.
        // Cutting the real TCP connection here reproduces a clean local write and a lost receipt.
        await waitUntil(() => stream.readStatus === 'closing' || stream.readStatus === 'closed', 5000)
        connection.abort(new Error('Receiver disconnected before saving the file'))
        await waitUntil(() => a.log.done.length + a.log.failed.length > 0, 5000)
        assert.deepEqual(a.log.done, [])
        assert.equal(a.log.failed.length, 1)
        assert.equal(a.log.failed[0].offerId, offerId)
        assert.equal(a.log.failed[0].peerId, b.peerId)
        assert.equal(a.log.failed[0].direction, 'send')
        assert.deepEqual(await entries(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('o: a 0.7.0 receiver gets the file and the sender reports an unconfirmed send', { timeout: 30000 }, async () => {
    const ctx = await setup(2)
    const [a, b] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'legacy.txt')
        await fsp.writeFile(file, 'sent to an old receiver')
        const { offerId, sha256 } = await a.offerFile(file)
        const { stream } = await requestFile(b, a, { offerId })
        const hash = createHash('sha256')
        for await (const chunk of stream.source) hash.update(chunk.subarray())
        assert.equal(hash.digest('hex'), sha256)
        await waitUntil(() => a.log.done.length + a.log.failed.length > 0, 5000)
        assert.deepEqual(a.log.failed, [])
        assert.equal(a.log.done.length, 1)
        assert.equal(a.log.done[0].offerId, offerId)
        assert.equal(a.log.done[0].confirmed, false)
    } finally {
        await cleanup(ctx)
    }
})

test('p: an unanswered receipt times out even with the chat session open', { timeout: 30000 }, async () => {
    const ctx = await setup(2, { fileAckTimeout: 250 })
    const [a, b] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'empty.bin')
        await fsp.writeFile(file, '')
        const { offerId } = await a.offerFile(file)
        const { stream } = await requestFile(b, a, { offerId, ack: 1 })
        for await (const chunk of stream.source) assert.equal(chunk.length, 0)
        await waitUntil(() => a.log.done.length + a.log.failed.length > 0, 5000)
        assert.ok(a.peers().includes(b.peerId))
        assert.deepEqual(a.log.done, [])
        assert.equal(a.log.failed.length, 1)
        assert.equal(a.log.failed[0].offerId, offerId)
        assert.match(a.log.failed[0].reason, /receipt|confirm|ack/i)
    } finally {
        await cleanup(ctx)
    }
})
