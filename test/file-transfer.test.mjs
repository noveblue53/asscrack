import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, writeSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { multiaddr } from '@multiformats/multiaddr'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { FILE_PROTOCOL, safeFileName, createFileTransfer, moveToFreeName } from '../src/network/file-transfer.mjs'
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
    const stream = await receiver.libp2p.dialProtocol(multiaddr(sender.getMultiaddrs()[0]), FILE_PROTOCOL, { runOnTransientConnection: true })
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

test('a room offer reports each pending recipient on departure and whole-offer cancel (127.0.0.1)', { timeout: 30000 }, async () => {
    const ctx = await setup(3)
    const [a, b, c] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'group.txt')
        await fsp.writeFile(file, 'for the room')
        const { offerId, recipients } = await a.offerFile(file)
        assert.deepEqual(new Set(recipients), new Set([b.peerId, c.peerId]))
        await waitUntil(() => b.log.offer.length === 1 && c.log.offer.length === 1, 5000)
        await c.stop()
        await waitUntil(() => a.log.failed.length === 1, 5000)
        assert.deepEqual(a.log.failed, [{ offerId, peerId: c.peerId, direction: 'send', reason: 'peer left' }])
        assert.equal(a.cancelFile(offerId), true)
        await waitUntil(() => b.log.cancelled.length === 1, 5000)
        assert.deepEqual(a.log.cancelled, [{ offerId, peerId: b.peerId, direction: 'send', by: 'self' }])
        assert.equal(b.acceptFile(offerId), false)
    } finally {
        await cleanup(ctx)
    }
})

for (const relayed of [false, true]) {
    test(`the receiver retries an interrupted ${relayed ? 'circuit-relayed' : 'direct'} download after reconnect (127.0.0.1)`, { timeout: 60000 }, async () => {
        const ctx = { nodes: [], dirs: [] }
        const release = Promise.withResolvers()
        const localAddr = node => node.getMultiaddrs().find(addr => addr.startsWith('/ip4/127.0.0.1/') && !addr.includes('/p2p-circuit'))
        const options = { ...base, roomKey: newRoomKey(), upnp: false, fullNode: false }
        async function member(extra) {
            const dir = await tempDir('retry')
            ctx.dirs.push(dir)
            const node = await createAsscrackNode({ ...options, ...extra, downloadDir: dir })
            Object.assign(node, { dir, log: record(node) })
            ctx.nodes.push(node)
            return node
        }
        try {
            const recipient = await member({ fullNode: relayed })
            const a = await member(relayed ? { relayOnly: true, listen: [] } : {})
            const laptop = await member(relayed ? { relayOnly: true, listen: [] } : {})
            if (relayed) {
                await a.connect(localAddr(recipient))
                await laptop.connect(localAddr(recipient))
            } else {
                await recipient.connect(localAddr(a))
                await laptop.connect(localAddr(a))
            }
            const connected = () => a.peers().includes(laptop.peerId) && laptop.peers().includes(a.peerId)
            const laptopLinks = () => laptop.libp2p.getConnections().filter(c => c.status === 'open' && c.remotePeer.toString() === a.peerId)
            const assertRoute = () => {
                const links = laptopLinks()
                assert.ok(links.length > 0)
                assert.ok(links.every(c => c.remoteAddr.toString().includes('/p2p-circuit') === relayed))
            }
            await waitUntil(() => connected() && a.peers().includes(recipient.peerId) && recipient.peers().includes(a.peerId), 20000)
            assertRoute()

            // Keep the second real file stream in progress across Laptop's failed attempt and retry.
            const otherConnection = recipient.libp2p.getConnections().find(c => c.remotePeer.toString() === a.peerId)
            const openStream = otherConnection.newStream.bind(otherConnection)
            otherConnection.newStream = async (protocol, opts) => {
                const stream = await openStream(protocol, opts)
                if (protocol === FILE_PROTOCOL) {
                    const chunks = stream.source
                    stream.source = (async function* () {
                        for await (const chunk of chunks) {
                            yield chunk
                            await release.promise
                        }
                    })()
                }
                return stream
            }
            const file = path.join(a.dir, 'party-assets.bin')
            const size = 16 * 1024 * 1024
            await writeRandom(file, size)
            const offer = await a.offerFile(file)
            assert.deepEqual(new Set(offer.recipients), new Set([laptop.peerId, recipient.peerId]))
            await waitUntil(() => laptop.log.offer.length === 1 && recipient.log.offer.length === 1, 5000)
            assert.equal(recipient.acceptFile(offer.offerId), true)
            await waitUntil(() => recipient.log.progress.length > 0, 5000)
            const offline = Promise.withResolvers()
            laptop.events.on('peer-left', ({ peerId }) => {
                if (peerId === a.peerId) offline.resolve(laptop.retryFile(offer.offerId))
            })
            const interrupted = Promise.withResolvers()
            laptop.events.once('file-progress', ({ bytes }) => {
                interrupted.resolve(bytes)
                for (const connection of laptopLinks()) connection.abort(new Error('Laptop disconnected'))
            })
            assert.equal(laptop.acceptFile(offer.offerId), true)
            assert.ok(await interrupted.promise > 0)
            assert.equal(await offline.promise, false)
            await waitUntil(() => laptop.log.failed.length === 1 && a.log.failed.some(e => e.peerId === laptop.peerId), 10000)
            assert.equal(laptop.log.failed[0].retryable, true)
            assert.deepEqual(laptop.log.done, [])
            assert.deepEqual(await entries(laptop.dir), [], 'the interrupted attempt removed its own partial')
            assert.deepEqual(recipient.log.done, [], 'the other download is still running')
            if (!relayed) {
                assert.equal(laptop.retryFile(offer.offerId), false)
                await laptop.connect(localAddr(a))
            }
            await waitUntil(connected, 20000)
            assertRoute()

            const oldPartial = path.join(laptop.dir, `.asscrack-${offer.offerId}.part`)
            await fsp.writeFile(oldPartial, 'stale partial from a prior process')
            assert.equal(laptop.retryFile(offer.offerId), true)
            assert.equal(laptop.retryFile(offer.offerId), false, 'repeated clicks cannot start overlapping retries')
            await waitUntil(() => laptop.log.offer.length === 2, 5000)
            const next = laptop.log.offer[1]
            assert.equal(next.retryOf, offer.offerId)
            assert.notEqual(next.offerId, offer.offerId)
            assert.equal(await fetchWithoutOffer(recipient, a, next.offerId), 0, 'a retry grants only Laptop access')
            assert.equal(laptop.acceptFile(next.offerId), true)
            assert.equal(laptop.acceptFile(next.offerId), false)
            release.resolve()
            await waitUntil(() => laptop.log.done.length === 1 && recipient.log.done.length === 1 && a.log.done.length === 2, 15000)
            assert.deepEqual(recipient.log.failed, [])
            assert.equal(recipient.log.offer.length, 1)
            assert.ok(a.log.done.every(e => e.confirmed))
            for (const receiver of [laptop, recipient]) {
                assert.equal((await fsp.stat(receiver.log.done[0].path)).size, size)
                assert.equal(await sha(receiver.log.done[0].path), offer.sha256)
            }
            assert.deepEqual((await entries(laptop.dir)).sort(), [path.basename(oldPartial), path.basename(file)].sort())
            assert.equal(await fsp.readFile(oldPartial, 'utf8'), 'stale partial from a prior process')
            assert.equal(laptop.retryFile(offer.offerId), false)
            assert.equal(laptop.retryFile(next.offerId), false)

            const unexpected = randomUUID()
            laptop.sendTo(a.peerId, { type: 'file-retry', offerId: next.offerId, attemptId: unexpected })
            assert.equal(await fetchWithoutOffer(laptop, a, unexpected), 0, 'a delivered grant cannot be reopened')
        } finally {
            release.resolve()
            await cleanup(ctx)
        }
    })
}

test('a second reconnect can retry an offer interrupted before its stream and rejects a changed original', async t => {
    const dir = await tempDir('repeated-retry')
    t.after(() => fsp.rm(dir, { recursive: true, force: true }))
    const pathToSource = path.join(dir, 'original.txt')
    await fsp.writeFile(pathToSource, 'original')
    const endpoints = new Map()
    let online = true
    function peer(id, remote) {
        const events = new EventEmitter()
        const log = { offers: [], failures: [] }
        events.on('file-offer', offer => log.offers.push(offer))
        events.on('file-failed', failure => log.failures.push(failure))
        const node = createFileTransfer({ events, downloadDir: dir, peerNames: () => ({}), openPeers: () => online ? [remote] : [],
            sendTo(peerId, control) {
                if (!online || peerId !== remote) return false
                endpoints.get(remote).handleControl(id, control)
                return true
            }
        })
        endpoints.set(id, node)
        return { node, log }
    }
    const sender = peer('publisher', 'laptop')
    const receiver = peer('laptop', 'publisher')
    t.after(() => Promise.all([sender.node.stop(), receiver.node.stop()]))
    const loseRoute = () => {
        online = false
        sender.node.peerLeft('laptop')
        receiver.node.peerLeft('publisher')
    }
    const { offerId } = await sender.node.offerFile(pathToSource, 'laptop')
    loseRoute()
    online = true
    assert.equal(receiver.node.retryFile(offerId), true)
    await waitUntil(() => receiver.log.offers.length === 2, 5000)
    const firstRetry = receiver.log.offers[1]
    assert.equal(firstRetry.retryOf, offerId)
    loseRoute()
    online = true
    assert.equal(receiver.node.retryFile(firstRetry.offerId), true)
    await waitUntil(() => receiver.log.offers.length === 3, 5000)
    const secondRetry = receiver.log.offers[2]
    assert.equal(secondRetry.retryOf, firstRetry.offerId)
    loseRoute()
    await fsp.writeFile(pathToSource, 'replacement is longer')
    online = true
    assert.equal(receiver.node.retryFile(secondRetry.offerId), true)
    await waitUntil(() => receiver.log.failures.length === 4, 5000)
    assert.deepEqual(receiver.log.failures.at(-1), { offerId: secondRetry.offerId, peerId: 'publisher', direction: 'receive',
        reason: 'the sender can no longer offer this file', retryable: false })
    assert.equal(receiver.node.retryFile(secondRetry.offerId), false)
    assert.equal(receiver.log.offers.length, 3)
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
        try {
            const offset = 199999
            await fh.read(one, 0, 1, offset)
            one[0] ^= 0xff
            // The sender checks the original before reading. Change an unread byte in the already-open
            // file to keep this regression exercising verification on the receiver.
            a.events.once('file-progress', () => writeSync(fh.fd, one, 0, 1, offset))
            await waitUntil(() => b.log.offer.length === 1, 5000)
            b.acceptFile(offer.offerId)
            await waitUntil(() => b.log.failed.length === 1, 10000)
        } finally { await fh.close() }
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

test('127.0.0.1: a receiver unable to create its partial file fails only its own send leg', async t => {
    const ctx = await setup(3)
    t.after(() => cleanup(ctx))
    const [a, b, c] = ctx.nodes
    // A regular file at a directory path fails open on Windows and Linux, even when running as root.
    await fsp.rmdir(b.dir)
    await fsp.writeFile(b.dir, 'occupied')
    const file = path.join(ctx.src, 'map.png')
    await fsp.writeFile(file, 'fixture')
    acceptOnOffer(b)
    acceptOnOffer(c)
    const { offerId } = await a.offerFile(file)
    await waitUntil(() => b.log.failed.length && a.log.failed.length && a.log.done.length, 5000)
    assert.deepEqual(a.log.failed, [{ offerId, peerId: b.peerId, direction: 'send', reason: 'receiver could not verify or save file' }])
    assert.deepEqual(a.log.done.map(event => [event.peerId, event.confirmed]), [[c.peerId, true]])
    assert.deepEqual(b.log.done, [])
    assert.equal(await fsp.readFile(b.dir, 'utf8'), 'occupied')
});

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
        await waitUntil(() => stream.remoteWriteStatus === 'closed' && stream.readBufferLength === 96 * 1024, 5000)
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

test('127.0.0.1: a preview, original and fresh targeted offer have independent verified bytes and one descriptor', { timeout: 20000 }, async () => {
    // The network transports the bounded derivative; validating the PNG and producing the thumbnail belong to the media provider.
    const derivative = Buffer.from('separate thumbnail')
    const ctx = await setup(2, { previewProvider: async () => derivative })
    const [source, receiver] = ctx.nodes
    try {
        const original = path.join(ctx.src, 'race.png')
        const contents = Buffer.from('byte-identical original fixture')
        await fsp.writeFile(original, contents)
        const { message, offer } = await source.postAttachment(original, 'race day')
        await waitUntil(() => receiver.log.offer.length === 1 && receiver.attachmentAvailable(message.attachment.id), 5000)
        assert.equal(offer.offerId, message.attachment.id)
        assert.equal(message.text, `race day\nrace.png (${contents.length} bytes)`)
        assert.equal(receiver.log.offer[0].attachmentId, message.attachment.id)
        assert.deepEqual(receiver.history().find(row => row.id === message.id).attachment, message.attachment)
        assert.deepEqual(await receiver.requestPreviewById(message.attachment.id), { descriptor: message.attachment, bytes: derivative })
        assert.deepEqual(await entries(receiver.dir), [])
        assert.ok(receiver.acceptFile(offer.offerId))
        await waitUntil(() => receiver.log.done.length === 1 && source.log.done.length === 1, 4000)
        assert.equal(source.log.done[0].confirmed, true)
        assert.deepEqual(await fsp.readFile(receiver.log.done[0].path), contents)
        assert.equal(receiver.log.done[0].sha256, message.attachment.sha256)
        assert.ok(receiver.requestOriginal(message.attachment.id))
        await waitUntil(() => receiver.log.offer.length === 2, 3000)
        assert.notEqual(receiver.log.offer[1].offerId, offer.offerId)
        assert.equal(receiver.log.offer[1].attachmentId, offer.offerId)
        const another = await source.postAttachment(original, 'same file, different post')
        assert.notEqual(another.message.attachment.id, message.attachment.id)
        assert.equal(another.message.attachment.sha256, message.attachment.sha256)
    } finally { await cleanup(ctx) }
})

test('127.0.0.1: replacing an original before acceptance transmits zero bytes on ordinary and reissued attachment offers', async t => {
    const ctx = await setup(2, { previewProvider: async () => null })
    t.after(() => cleanup(ctx))
    const [source, receiver] = ctx.nodes
    for (const rich of [false, true]) {
        const original = path.join(ctx.src, rich ? 'post.png' : 'offered.txt')
        await fsp.writeFile(original, 'first file')
        let id
        if (rich) {
            const { message, offer } = await source.postAttachment(original, 'before replacement')
            await waitUntil(() => receiver.log.offer.some(ev => ev.offerId === offer.offerId) && receiver.attachmentAvailable(message.attachment.id), 5000)
            assert.ok(receiver.refuseFile(offer.offerId))
            await waitUntil(() => source.log.refused.some(ev => ev.offerId === offer.offerId), 5000)
            assert.ok(receiver.requestOriginal(message.attachment.id))
            await waitUntil(() => receiver.log.offer.some(ev => ev.attachmentId === message.attachment.id && ev.offerId !== offer.offerId), 5000)
            id = receiver.log.offer.at(-1).offerId
        } else {
            const offer = await source.offerFile(original, receiver.peerId)
            id = offer.offerId
            await waitUntil(() => receiver.log.offer.some(ev => ev.offerId === id), 5000)
        }
        await fsp.rename(original, original + '.original')
        await fsp.writeFile(original, 'other file')
        assert.ok(receiver.acceptFile(id))
        await waitUntil(() => receiver.log.failed.some(ev => ev.offerId === id), 5000)
        await waitUntil(() => source.log.failed.some(ev => ev.offerId === id), 5000)
        assert.equal(source.log.progress.some(ev => ev.offerId === id && ev.bytes > 0), false)
        assert.deepEqual(await entries(receiver.dir), [])
    }
})

test('127.0.0.1: excessive or unsupported preview leaves the streamed original available', { timeout: 15000 }, async () => {
    let large = true
    const ctx = await setup(2, { previewProvider: async () => large ? Buffer.alloc(512 * 1024 + 1) : null })
    const [source, receiver] = ctx.nodes
    try {
        const original = path.join(ctx.src, 'unsupported.webp')
        await fsp.writeFile(original, 'unchanged, opaque original')
        const { message, offer } = await source.postAttachment(original, '')
        await waitUntil(() => receiver.attachmentAvailable(message.attachment.id), 5000)
        assert.equal(await receiver.requestPreviewById(message.attachment.id), null)
        large = false
        assert.equal(await receiver.requestPreviewById(message.attachment.id), null)
        assert.deepEqual(await entries(receiver.dir), [])
        assert.ok(receiver.acceptFile(offer.offerId))
        await waitUntil(() => receiver.log.done.length === 1, 3000)
        assert.equal(await sha(receiver.log.done[0].path), message.attachment.sha256)
    } finally { await cleanup(ctx) }
})

test('127.0.0.1: an altered replay descriptor cannot fetch previews or enable a fresh offer for a different original', { timeout: 15000 }, async () => {
    const ctx = await setup(2, { previewProvider: async () => Buffer.from('original preview') })
    const [source] = ctx.nodes
    try {
        const file = path.join(ctx.src, 'race.png')
        await fsp.writeFile(file, 'original')
        const { message } = await source.postAttachment(file, 'real content')
        const swapped = { ...message, attachment: { ...message.attachment, sha256: '0'.repeat(64) } }
        const reader = await createAsscrackNode({ ...base, seedHistory: [swapped] })
        ctx.nodes.push(reader)
        const states = []
        reader.events.on('attachment-status', state => states.push(state))
        await reader.connect(source.getMultiaddrs()[0])
        await waitUntil(() => states.some(s => s.id === message.attachment.id), 4000)
        assert.ok(states.every(s => !s.available))
        assert.equal(reader.requestOriginal(swapped.attachment), false)
        assert.equal(await reader.requestPreviewById(swapped.attachment), null)
        assert.equal(reader.history().find(row => row.id === message.id).text, message.text)
    } finally { await cleanup(ctx) }
})

test('127.0.0.1 fixture: remote cancel before the receiver opens its empty file stream leaves no saved file', async t => {
    const dir = await tempDir('pending')
    t.after(() => fsp.rm(dir, { recursive: true, force: true }))
    const offerId = '09723240-6513-4691-89f9-c40edc7ff755'
    const peerId = 'sender'
    const stream = { sink: async () => {}, source: [], close: async () => {}, abort() {} }
    const connection = { remotePeer: peerId, status: 'open', newStream: async () => stream }
    const events = new EventEmitter()
    const ft = createFileTransfer({ events, libp2p: { getConnections: () => [connection] },
        sendTo: () => true, openPeers: () => [peerId], peerNames: () => ({}), downloadDir: dir })
    const ended = record({ events })
    ft.handleControl(peerId, { type: 'file-offer', offerId, size: 0, name: 'empty.txt', sha256: createHash('sha256').digest('hex') })
    assert.ok(ft.acceptFile(offerId))
    ft.handleControl(peerId, { type: 'file-cancel', offerId })
    await waitUntil(() => ended.done.length + ended.failed.length + ended.cancelled.length, 1000)
    assert.deepEqual(ended.cancelled, [{ offerId, peerId, direction: 'receive', by: 'peer' }])
    assert.deepEqual(await entries(dir), [])
})

test('127.0.0.1 filesystem fixture: simultaneous verified saves retain both originals without hard links', async t => {
    const dir = await tempDir('nolinks')
    t.after(() => fsp.rm(dir, { recursive: true, force: true }))
    const target = path.join(dir, 'same.txt')
    const ready = Promise.withResolvers()
    let waiting = 0
    const fs = { ...fsp, link: async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }) },
        async access(file) {
            try { await fsp.access(file) } catch (err) {
                // A check-then-rename implementation lets both publishers observe the same free name.
                if (file === target) {
                    if (++waiting === 2) ready.resolve()
                    await ready.promise
                }
                throw err
            }
        }
    }
    const temps = ['.incoming-a', '.incoming-b'].map(name => path.join(dir, name))
    await Promise.all(temps.map((file, i) => fsp.writeFile(file, String(i))))
    const published = await Promise.all(temps.map(file => moveToFreeName(file, dir, 'same.txt', fs)))
    assert.equal(new Set(published).size, 2)
    assert.deepEqual(await Promise.all(published.map(file => fsp.readFile(file, 'utf8'))), ['0', '1'])
    const neverPublished = path.join(dir, '.incoming-c')
    await fsp.writeFile(neverPublished, 'kept until cleanup')
    await assert.rejects(moveToFreeName(neverPublished, dir, 'failed.txt', { ...fs,
        rename: async () => { throw new Error('publish failed') }
    }), /publish failed/)
    assert.deepEqual((await entries(dir)).sort(), ['.incoming-c','same (1).txt','same.txt'])
})
