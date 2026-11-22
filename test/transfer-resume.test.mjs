import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { FILE_PROTOCOLS, FILE_RESUME_PROTOCOL } from '../src/network/file-transfer.mjs'
import { PARTIAL_TTL_MS } from '../src/network/partial-store.mjs'

// All results of this file are 127.0.0.1 results on this PC, not LAN results.
const base = { room: 'resume', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false,
    heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 300 }
const MiB = 1024 * 1024
const EVENTS = ['offer', 'progress', 'done', 'failed', 'cancelled', 'paused', 'resumed', 'restarted', 'discarded',
    'expired', 'partials']

async function waitUntil(check, limit, what = 'condition') {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        if (await check()) return
        await delay(20)
    }
    assert.ok(await check(), `${what} not true within ${limit} ms`)
}

async function tempDir(ctx, prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `asscrack-${prefix}-`))
    ctx.dirs.push(dir)
    return dir
}

function record(node) {
    const log = Object.fromEntries(EVENTS.map(k => [k, []]))
    for (const k of EVENTS) node.events.on(`file-${k}`, e => log[k].push(e))
    return log
}

async function member(ctx, options) {
    const dir = await tempDir(ctx, 'dl')
    const node = await createAsscrackNode({ ...base, ...options, downloadDir: dir })
    Object.assign(node, { dir, log: record(node) })
    ctx.nodes.push(node)
    return node
}

async function cleanup(ctx) {
    for (const server of ctx.servers ?? []) server.close()
    await Promise.allSettled(ctx.nodes.map(n => n.stop()))
    await Promise.allSettled(ctx.dirs.map(d => fsp.rm(d, { recursive: true, force: true })))
}

const localAddr = node => node.getMultiaddrs().find(addr => addr.startsWith('/ip4/127.0.0.1/') && !addr.includes('/p2p-circuit'))
const links = (x, y) => x.libp2p.getConnections().filter(c => c.status === 'open' && c.remotePeer.toString() === y.peerId)
const relayed = c => c.remoteAddr.toString().includes('/p2p-circuit')
const linked = (x, y) => x.peers().includes(y.peerId) && y.peers().includes(x.peerId)

async function pair(ctx, receiverOptions = {}) {
    const a = await member(ctx, {})
    const b = await member(ctx, receiverOptions)
    await b.connect(localAddr(a))
    await waitUntil(() => linked(a, b), 5000, 'session A-B')
    return { a, b }
}

async function sha(file) {
    const h = createHash('sha256')
    for await (const c of createReadStream(file)) h.update(c)
    return h.digest('hex')
}

async function writeRandom(file, size) {
    const fh = await fsp.open(file, 'w')
    try {
        for (let done = 0; done < size; done += MiB) await fh.write(randomBytes(Math.min(MiB, size - done)))
    } finally {
        await fh.close()
    }
}

// Counts the bytes that each file stream of the receiver gets: the reply line of the sender and the file bytes.
// `onBytes(total, stream)` runs before the receiver writes each chunk.
function tapFileStreams(node, onBytes = () => {}) {
    if (node.fileTaps) {
        node.fileTaps.push(onBytes)
        return node.fileStreams
    }
    const streams = node.fileStreams = []
    const taps = node.fileTaps = [onBytes]
    const wrap = connection => {
        if (connection.tapped) return
        connection.tapped = true
        const open = connection.newStream.bind(connection)
        connection.newStream = async (protocol, options) => {
            const stream = await open(protocol, options)
            if (![protocol].flat().some(p => FILE_PROTOCOLS.includes(p))) return stream
            const entry = { protocol: stream.protocol, relayed: relayed(connection), bytes: 0 }
            streams.push(entry)
            const source = stream.source
            stream.source = (async function* () {
                for await (const chunk of source) {
                    entry.bytes += chunk.byteLength
                    for (const tap of taps) tap(entry.bytes, entry)
                    yield chunk
                }
            })()
            return stream
        }
    }
    for (const connection of node.libp2p.getConnections()) wrap(connection)
    node.libp2p.addEventListener('connection:open', ({ detail }) => wrap(detail))
    return streams
}

// Pauses the first receive of `node` when its stream has `fraction` of `size`.
function pauseAt(node, size, fraction) {
    let paused = false
    return tapFileStreams(node, total => {
        if (paused || total < size * fraction) return
        const offer = node.log.offer.at(-1)
        paused = node.pauseFile(offer.offerId)
        assert.equal(paused, true)
    })
}

const resumeFiles = dir => fsp.readdir(dir).then(names => names.filter(n => n.startsWith('.asscrack-resume-')))

// Sends `size` bytes, pauses the receive near 40 % and waits for the paused state on both ends.
async function sendAndPause(a, b, size, name = 'large.bin') {
    const file = path.join(a.dir, name)
    await writeRandom(file, size)
    const streams = pauseAt(b, size, 0.4)
    const offer = await a.offerFile(file, b.peerId)
    await waitUntil(() => b.log.offer.length === 1, 5000, 'offer')
    assert.equal(b.acceptFile(offer.offerId), true)
    await waitUntil(() => b.log.paused.length === 1 && a.log.paused.length === 1, 15000, 'paused on both ends')
    return { file, offer, streams, partial: b.log.paused[0] }
}

test('Pause keeps the partial and Resume sends only the remainder on the same route (127.0.0.1)', { timeout: 60000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { a, b } = await pair(ctx)
        const size = 24 * MiB
        const { offer, streams, partial } = await sendAndPause(a, b, size)
        assert.ok(partial.bytes > size * 0.35 && partial.bytes < size * 0.45, `paused at ${partial.bytes}`)
        assert.equal(partial.resumable, true)
        assert.equal(partial.key, `${offer.sha256}-${size}`)
        assert.ok(partial.expiresAt > Date.now() + PARTIAL_TTL_MS - 60000)
        assert.deepEqual(b.log.failed, [])
        assert.deepEqual(b.log.cancelled, [])
        assert.equal(a.log.failed.length, 0)
        assert.deepEqual(await resumeFiles(b.dir), [`.asscrack-resume-${partial.key}.json`, `.asscrack-resume-${partial.key}.part`])
        const [listed] = await b.partials()
        assert.equal(listed.bytes, partial.bytes)
        assert.equal(listed.name, 'large.bin')

        assert.equal(b.resumeFile(offer.offerId), true)
        await waitUntil(() => b.log.done.length === 1 && a.log.done.length === 1, 20000, 'resumed transfer done')
        const resumed = b.log.resumed.find(e => e.direction === 'receive')
        assert.equal(resumed.offset, partial.bytes)
        assert.equal(resumed.resumeOf, offer.offerId)
        assert.equal(b.log.done[0].offset, partial.bytes)
        assert.equal(a.log.done[0].offset, partial.bytes)
        assert.equal(a.log.done[0].sent, size - partial.bytes)
        assert.equal(a.log.done[0].confirmed, true)
        const second = streams.at(-1)
        assert.equal(second.protocol, FILE_RESUME_PROTOCOL)
        assert.equal(second.bytes - (size - partial.bytes), Buffer.byteLength(JSON.stringify({ offset: partial.bytes }) + '\n'))
        assert.equal(await sha(b.log.done[0].path), offer.sha256)
        assert.deepEqual(await resumeFiles(b.dir), [], 'the partial became the final file')
        assert.deepEqual(await b.partials(), [])
        assert.deepEqual(b.log.restarted, [])
    } finally {
        await cleanup(ctx)
    }
})

test('a corrupted partial restarts from byte 0 and the output is verified (127.0.0.1)', { timeout: 60000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { a, b } = await pair(ctx)
        const size = 16 * MiB
        const { offer, streams, partial } = await sendAndPause(a, b, size)
        const part = path.join(b.dir, `.asscrack-resume-${partial.key}.part`)
        const fh = await fsp.open(part, 'r+')
        await fh.write(Buffer.from([0x55, 0xaa, 0x55]), 0, 3, 1000)
        await fh.close()
        assert.equal(b.resumeFile(offer.offerId), true)
        await waitUntil(() => b.log.done.length === 1 && a.log.done.length === 1, 20000, 'restarted transfer done')
        assert.equal(b.log.restarted.length, 1)
        assert.equal(b.log.restarted[0].reason, 'the partial did not agree with the source')
        assert.equal(b.log.restarted[0].resumeOf, offer.offerId)
        assert.equal(b.log.done[0].offset, undefined)
        assert.equal(a.log.done[0].offset, undefined, 'the sender sent the full file')
        assert.equal(streams.at(-1).bytes, size + Buffer.byteLength('{"offset":0}\n'))
        assert.equal(await sha(b.log.done[0].path), offer.sha256)
        assert.deepEqual(await resumeFiles(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('a sender with no offset negotiation gives a fresh full transfer and a restart indication (127.0.0.1)', { timeout: 60000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { a, b } = await pair(ctx)
        const size = 16 * MiB
        const { offer, streams } = await sendAndPause(a, b, size)
        await a.libp2p.unhandle(FILE_RESUME_PROTOCOL)
        assert.equal(b.resumeFile(offer.offerId), true)
        await waitUntil(() => b.log.done.length === 1 && a.log.done.length === 1, 20000, 'fresh transfer done')
        assert.equal(b.log.restarted.length, 1)
        assert.equal(b.log.restarted[0].reason, 'the sender cannot continue from an offset')
        assert.equal(streams.at(-1).protocol, FILE_PROTOCOLS[0])
        assert.equal(streams.at(-1).bytes, size)
        assert.equal(await sha(b.log.done[0].path), offer.sha256)
        assert.deepEqual(await resumeFiles(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('a changed source fails with a clear reason and discards the partial (127.0.0.1)', { timeout: 60000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { a, b } = await pair(ctx)
        const size = 16 * MiB
        // Resume: the sender checks the source before it gives a new attempt.
        const first = await sendAndPause(a, b, size, 'first.bin')
        await fsp.appendFile(first.file, 'changed')
        assert.equal(b.resumeFile(first.offer.offerId), true)
        await waitUntil(() => b.log.failed.length === 1, 10000, 'resume refused')
        assert.deepEqual(b.log.failed[0], { offerId: first.offer.offerId, peerId: a.peerId, direction: 'receive',
            reason: 'the source file changed', retryable: false })
        await waitUntil(async () => (await resumeFiles(b.dir)).length === 0, 5000, 'partial discarded')
        assert.equal(b.log.discarded.at(-1).reason, 'changed')

        // A new offer of the same content: the source changes after the offer, before the stream asks for the offset.
        const again = path.join(a.dir, 'second.bin')
        await writeRandom(again, size)
        let pausedOnce = false
        tapFileStreams(b, total => {
            if (pausedOnce || total < size * 0.4) return
            pausedOnce = b.pauseFile(b.log.offer.at(-1).offerId)
        })
        const second = await a.offerFile(again, b.peerId)
        await waitUntil(() => b.log.offer.length === 2, 5000, 'second offer')
        b.acceptFile(second.offerId)
        await waitUntil(() => b.log.paused.length === 2, 15000, 'second pause')
        const content = await fsp.readFile(again)
        const third = await a.offerFile(again, b.peerId)
        await waitUntil(() => b.log.offer.length === 3, 5000, 'third offer')
        await fsp.writeFile(again, content.reverse())
        assert.equal(b.acceptFile(third.offerId), true)
        await waitUntil(() => b.log.failed.length === 2, 10000, 'stream refused')
        assert.equal(b.log.failed[1].reason, 'the source file changed')
        assert.equal(b.log.discarded.at(-1).reason, 'changed')
        assert.deepEqual(await resumeFiles(b.dir), [])
        assert.deepEqual(b.log.done, [])
    } finally {
        await cleanup(ctx)
    }
})

test('a partial over the budget is not kept and the transfer fails as before (127.0.0.1)', { timeout: 60000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { a, b } = await pair(ctx, { partials: { budget: 4 * MiB } })
        const size = 16 * MiB
        const file = path.join(a.dir, 'big.bin')
        await writeRandom(file, size)
        pauseAt(b, size, 0.4)
        const offer = await a.offerFile(file, b.peerId)
        await waitUntil(() => b.log.offer.length === 1, 5000, 'offer')
        b.acceptFile(offer.offerId)
        await waitUntil(() => b.log.failed.length === 1, 15000, 'failure')
        assert.equal(b.log.failed[0].reason, 'the paused part is over the storage budget')
        assert.equal(b.log.failed[0].retryable, true)
        assert.deepEqual(b.log.paused, [])
        assert.deepEqual(await fsp.readdir(b.dir), [], 'no partial stays on disk')
        assert.deepEqual(await b.partials(), [])
    } finally {
        await cleanup(ctx)
    }
})

test('expiry and Discard delete the partial and free the disk space (127.0.0.1)', { timeout: 60000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    let clock = Date.now()
    try {
        const { a, b } = await pair(ctx, { partials: { now: () => clock } })
        const size = 16 * MiB
        const first = await sendAndPause(a, b, size, 'expires.bin')
        assert.equal(first.partial.expiresAt, (await b.partials())[0].expiresAt)
        const used = (await fsp.stat(path.join(b.dir, `.asscrack-resume-${first.partial.key}.part`))).size
        assert.equal(used, first.partial.bytes)
        clock = first.partial.expiresAt - 1
        assert.equal((await b.partials()).length, 1)
        clock = first.partial.expiresAt
        assert.deepEqual(await b.partials(), [])
        assert.equal(b.log.expired.length, 1)
        assert.equal(b.log.expired[0].key, first.partial.key)
        assert.deepEqual(await fsp.readdir(b.dir), [], 'the expiry freed the disk space')
        assert.deepEqual(b.log.partials.at(-1).partials, [])

        // Resume after the expiry is a fresh full transfer.
        assert.equal(b.resumeFile(first.offer.offerId), true)
        await waitUntil(() => b.log.done.length === 1, 20000, 'fresh transfer after expiry')
        assert.equal(b.log.restarted.at(-1).reason, 'no partial bytes')
        assert.equal(await sha(b.log.done[0].path), first.offer.sha256)

        const file = path.join(a.dir, 'discard.bin')
        await writeRandom(file, size)
        let done = false
        tapFileStreams(b, total => {
            if (done || total < size * 0.4) return
            done = b.pauseFile(b.log.offer.at(-1).offerId)
        })
        const offer = await a.offerFile(file, b.peerId)
        await waitUntil(() => b.log.offer.length === 2, 5000, 'second offer')
        b.acceptFile(offer.offerId)
        await waitUntil(() => b.log.paused.length === 2, 15000, 'second pause')
        const key = b.log.paused[1].key
        assert.equal(await b.discardPartial('no-such-key'), false)
        assert.equal(await b.discardPartial(key), true)
        assert.equal(b.log.discarded.at(-1).reason, 'user')
        assert.deepEqual(await resumeFiles(b.dir), [], 'Discard freed the disk space')
        assert.equal(await b.discardPartial(key), false)
    } finally {
        await cleanup(ctx)
    }
})

test('Cancel of a resumed transfer deletes its partial (127.0.0.1)', { timeout: 60000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { a, b } = await pair(ctx)
        const size = 24 * MiB
        const { offer, partial } = await sendAndPause(a, b, size)
        let cancelled = false
        b.events.on('file-progress', ({ offerId, direction }) => {
            if (cancelled || direction !== 'receive' || offerId === offer.offerId) return
            cancelled = b.cancelFile(offerId)
        })
        assert.equal(b.resumeFile(offer.offerId), true)
        await waitUntil(() => b.log.cancelled.length === 1, 20000, 'cancel')
        assert.equal(b.log.cancelled[0].resumeOf, offer.offerId)
        assert.equal(b.log.discarded.at(-1).key, partial.key)
        assert.equal(b.log.discarded.at(-1).reason, 'cancelled')
        await waitUntil(async () => (await fsp.readdir(b.dir)).length === 0, 5000, 'empty download folder')
        assert.deepEqual(b.log.done, [])
    } finally {
        await cleanup(ctx)
    }
})

// A TCP proxy on 127.0.0.1 that counts the bytes in each direction. The sender dials the relay through it, thus
// `up` is the sender upload to the relay on the wire: noise, yamux, circuit and chat bytes included.
async function countingProxy(ctx, targetPort) {
    const counts = { up: 0, down: 0 }
    const sockets = new Set()
    const server = net.createServer(client => {
        const target = net.connect(targetPort, '127.0.0.1')
        for (const socket of [client, target]) {
            sockets.add(socket)
            socket.on('close', () => sockets.delete(socket))
            socket.on('error', () => {})
        }
        client.on('data', data => { counts.up += data.length })
        target.on('data', data => { counts.down += data.length })
        client.pipe(target)
        target.pipe(client)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    ctx.servers = [...(ctx.servers ?? []), server]
    return { counts, port: server.address().port, close: () => { for (const s of sockets) s.destroy(); server.close() } }
}

test('the exit: pause near 40 % on direct TCP, resume over a relay circuit, and the sender sends only the remainder (127.0.0.1)',
    { timeout: 120000 }, async t => {
    const ctx = { nodes: [], dirs: [] }
    let rss = process.memoryUsage().rss
    const sampler = setInterval(() => { rss = Math.max(rss, process.memoryUsage().rss) }, 50)
    try {
        const options = { roomKey: newRoomKey(), upnp: false, fullNode: false }
        const r = await member(ctx, { ...options, fullNode: true })
        const a = await member(ctx, { ...options, relayOnly: true, listen: [] })
        const b = await member(ctx, options)
        const relayPort = Number(localAddr(r).split('/')[4])
        const proxy = await countingProxy(ctx, relayPort)
        // The direct link first: a later room dial to a connected peer uses the open connection.
        await a.connect(localAddr(b))
        await waitUntil(() => linked(a, b), 10000, 'direct session')
        await a.connect(`/ip4/127.0.0.1/tcp/${proxy.port}/p2p/${r.peerId}`)
        await b.connect(localAddr(r))
        await waitUntil(() => linked(a, b) && linked(a, r) && linked(b, r), 20000, 'sessions')
        const route = () => links(b, a).map(c => c.remoteAddr.toString())
        await waitUntil(() => links(b, a).length > 0 && links(b, a).every(c => !relayed(c)), 10000, `direct route only: ${route()}`)

        const size = 64 * MiB
        const { offer, streams, partial } = await sendAndPause(a, b, size)
        assert.equal(streams[0].relayed, false, 'the first part used direct TCP')
        assert.ok(partial.bytes > size * 0.35 && partial.bytes < size * 0.45, `paused at ${partial.bytes}`)
        const sentBeforePause = a.log.paused[0].bytes

        // Remove the direct route. The sender has no listener, thus the only way back is the circuit through R.
        for (const c of [...links(b, a), ...links(a, b)]) c.abort(new Error('direct route removed'))
        await waitUntil(() => !b.peers().includes(a.peerId), 10000, 'session down')
        const circuit = `${localAddr(r)}/p2p-circuit/p2p/${a.peerId}`
        await waitUntil(async () => {
            if (linked(a, b)) return true
            await b.connect(circuit).catch(() => {})
            return linked(a, b)
        }, 30000, 'session over the circuit')
        assert.ok(links(b, a).length > 0 && links(b, a).every(relayed), 'the second part uses only the relay circuit')

        const wireBefore = proxy.counts.up
        assert.equal(b.resumeFile(offer.offerId), true)
        await waitUntil(() => b.log.done.length === 1 && a.log.done.length === 1, 60000, 'resumed transfer done')
        const wire = proxy.counts.up - wireBefore
        const resumedStream = streams.at(-1)
        const remainder = size - partial.bytes
        assert.equal(resumedStream.relayed, true)
        assert.equal(resumedStream.protocol, FILE_RESUME_PROTOCOL)
        assert.equal(a.log.done[0].offset, partial.bytes)
        assert.equal(a.log.done[0].sent, remainder, 'the sender read and sent only the remainder of the file')
        const reply = resumedStream.bytes - remainder
        assert.equal(reply, Buffer.byteLength(JSON.stringify({ offset: partial.bytes }) + '\n'))
        assert.ok(wire >= remainder, 'the wire count includes the remainder')
        assert.ok(wire < remainder * 1.05 + MiB, `the wire overhead is small: ${wire - remainder} bytes`)
        assert.equal(await sha(b.log.done[0].path), offer.sha256)
        assert.equal((await fsp.stat(b.log.done[0].path)).size, size)
        assert.deepEqual(await resumeFiles(b.dir), [])
        const numbers = { route: 'direct TCP, then relay circuit (127.0.0.1)', size, pausedAt: partial.bytes,
            pausedPercent: +(100 * partial.bytes / size).toFixed(1), senderBytesBeforePause: sentBeforePause,
            remainder, senderFileBytesAfterResume: a.log.done[0].sent, streamBytesAfterResume: resumedStream.bytes,
            replyLineBytes: reply, senderWireUploadAfterResume: wire, wireOverhead: wire - remainder,
            wireOverheadPercent: +(100 * (wire - remainder) / remainder).toFixed(2), rssHighWaterMiB: Math.round(rss / MiB),
            os: `${os.type()} ${os.release()}`, ramMiB: Math.round(os.totalmem() / MiB) }
        t.diagnostic(`P7A-EXIT ${JSON.stringify(numbers)}`)
    } finally {
        clearInterval(sampler)
        await cleanup(ctx)
    }
})

test('a paused partial survives a restart of the receiver and a new offer of the same content continues it (127.0.0.1)',
    { timeout: 60000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { a, b } = await pair(ctx)
        const size = 16 * MiB
        const { file, partial } = await sendAndPause(a, b, size)
        await b.stop()
        const again = await createAsscrackNode({ ...base, downloadDir: b.dir })
        Object.assign(again, { dir: b.dir, log: record(again) })
        ctx.nodes.push(again)
        const [kept] = await again.partials()
        assert.equal(kept.key, partial.key)
        assert.equal(kept.bytes, partial.bytes)
        await again.connect(localAddr(a))
        await waitUntil(() => linked(a, again), 5000, 'session after the restart')
        const streams = tapFileStreams(again)
        const offer = await a.offerFile(file, again.peerId)
        await waitUntil(() => again.log.offer.length === 1, 5000, 'new offer')
        assert.equal(again.acceptFile(offer.offerId), true)
        await waitUntil(() => again.log.done.length === 1, 20000, 'continued transfer done')
        assert.equal(again.log.resumed[0].offset, partial.bytes)
        assert.equal(again.log.resumed[0].resumeOf, undefined)
        assert.equal(streams.at(-1).bytes, size - partial.bytes + Buffer.byteLength(JSON.stringify({ offset: partial.bytes }) + '\n'))
        assert.equal(await sha(again.log.done[0].path), offer.sha256)
        assert.deepEqual(await resumeFiles(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})
