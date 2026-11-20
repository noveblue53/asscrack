import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { FILE_PROTOCOL } from '../src/network/file-transfer.mjs'

test('a slow receiver bounds file payload ahead of its writes (127.0.0.1)', { timeout: 90000 }, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ac-credit-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const options = { room: 'credit', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false, upnp: false, fullNode: false }
    const sender = await createAsscrackNode(options)
    const receiver = await createAsscrackNode({ ...options, downloadDir: dir })
    t.after(() => Promise.all([sender.stop(), receiver.stop()]))
    await receiver.connect(sender.getMultiaddrs()[0])
    while (!sender.peers().includes(receiver.peerId) || !receiver.peers().includes(sender.peerId)) await delay(20)
    const conn = receiver.libp2p.getConnections().find(c => c.remotePeer.toString() === sender.peerId)
    const newStream = conn.newStream.bind(conn)
    conn.newStream = async (protocol, opts) => {
        const stream = await newStream(protocol, opts)
        if (protocol === FILE_PROTOCOL) {
            const source = stream.source
            stream.source = (async function* () {
                for await (const chunk of source) {
                    await delay(4)
                    yield chunk
                }
            })()
        }
        return stream
    }
    const file = path.join(dir, 'original.bin')
    const size = 48 * 1024 * 1024
    const handle = await open(file, 'wx')
    try { await handle.truncate(size) } finally { await handle.close() }
    let maxAhead = 0, receivedAll = false
    receiver.events.on('file-offer', ({ offerId }) => receiver.acceptFile(offerId))
    receiver.events.on('file-done', () => { receivedAll = true })
    sender.events.on('file-progress', ({ bytes, offerId }) => {
        if (!receivedAll) {
            const saved = statSync(path.join(dir, '.asscrack-' + offerId + '.part'), { throwIfNoEntry: false })?.size
            if (saved !== undefined) maxAhead = Math.max(maxAhead, bytes - saved)
        }
    })
    const done = Promise.withResolvers()
    sender.events.once('file-done', done.resolve)
    sender.events.once('file-failed', e => done.reject(new Error(e.reason)))
    await sender.offerFile(file, receiver.peerId)
    assert.equal((await done.promise).confirmed, true)
    t.diagnostic('127.0.0.1 maximum sampled sender lead over receiver file: ' + maxAhead + ' bytes')
    assert.ok(maxAhead <= 8 * 1024 * 1024, 'sender read ahead by ' + maxAhead + ' bytes')
})

test('a stalled transfer ignores invalid write counts and another buddy’s credit', { timeout: 10000 }, async t => {
    const { createFileTransfer } = await import('../src/network/file-transfer.mjs')
    const { EventEmitter, once } = await import('node:events')
    const dir = await mkdtemp(path.join(tmpdir(), 'ac-grant-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const file = path.join(dir, 'payload.bin')
    const handle = await open(file, 'wx')
    try { await handle.truncate(12 * 1024 * 1024) } finally { await handle.close() }
    const events = new EventEmitter()
    const transfer = createFileTransfer({ events, openPeers: () => ['reader', 'other'], sendTo: () => true,
        peerNames: () => ({}), fileAckTimeout: 300 })
    t.after(() => transfer.stop())
    const { offerId } = await transfer.offerFile(file, 'reader')
    let sent = 0
    const input = Buffer.from(JSON.stringify({ offerId, ack: 1, flow: 1 }) + '\n')
    const stream = {
        source: (async function* () { yield input })(),
        async sink(chunks) {
            for await (const chunk of chunks) {
                sent += chunk.length
                transfer.handleControl('other', { type: 'file-written', offerId, bytes: sent })
                for (const bytes of [-1, '123', sent + 1]) transfer.handleControl('reader', { type: 'file-written', offerId, bytes })
            }
        },
        abort() {}
    }
    const failure = once(events, 'file-failed')
    transfer.handleStream({ stream, connection: { remotePeer: 'reader' } })
    const [failed] = await failure
    assert.equal(sent, 8 * 1024 * 1024)
    assert.match(failed.reason, /write progress timed out/)
})
