import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

export const FILE_PROTOCOL = '/asscrack/file/1.0.0'

const CHUNK_SIZE = 65536
const REQUEST_LIMIT = 1024
const PROGRESS_INTERVAL_MS = 100
const CANCEL_WAIT_MS = 500
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA_RE = /^[0-9a-f]{64}$/
const RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

export function safeFileName(name) {
    if (typeof name !== 'string') name = 'file'
    let n = name.split(/[\\/]/).pop()
    n = n.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
    n = n.replace(/[ .]+$/, '').replace(/^ +/, '')
    if (RESERVED_RE.test(n.split('.')[0])) n = '_' + n
    if (n.length > 200) {
        const dot = n.lastIndexOf('.')
        const extLength = dot === -1 ? 0 : n.length - dot - 1
        const ext = extLength >= 1 && extLength <= 16 ? n.slice(dot) : ''
        const base = ext ? n.slice(0, dot) : n
        n = base.slice(0, 200 - ext.length) + ext
    }
    if (n === '' || n === '.' || n === '..') n = 'file'
    return n
}

// A failure with a known short reason.
class TransferFailure extends Error {}

function splitName(name) {
    const dot = name.lastIndexOf('.')
    if (dot <= 0) return { base: name, ext: '' }
    return { base: name.slice(0, dot), ext: name.slice(dot) }
}

async function moveToFreeName(temp, dir, name) {
    const { base, ext } = splitName(name)
    for (let i = 0; ; i++) {
        const candidate = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`)
        try {
            await fsp.link(temp, candidate)
            await fsp.unlink(temp).catch(() => {})
            return candidate
        } catch (err) {
            if (err?.code === 'EEXIST') continue
            let exists = true
            try {
                await fsp.access(candidate)
            } catch {
                exists = false
            }
            if (exists) continue
            await fsp.rename(temp, candidate)
            return candidate
        }
    }
}

// The file transfer part of a node. The node sends the file control lines to handleControl().
export function createFileTransfer({ libp2p, events, sendTo, openPeers, peerNames, downloadDir, fileAckTimeout = 30000 }) {
    // Own offers: offerId -> { offerId, filePath, name, size, sha256, targets: Set, started: Set }
    const ownOffers = new Map()
    // Received offers: offerId -> { offerId, peerId, name, size, sha256, state }
    const received = new Map()
    // Active transfers: key `${direction}|${offerId}|${peerId}` -> transfer
    const active = new Map()
    // Peer cancel signals for active transfers: key `${offerId}|${peerId}`
    const cancelSignals = new Map()
    let stopping = false

    const sendLine = (peerId, message) => sendTo(peerId, message)

    function signal(key) {
        let s = cancelSignals.get(key)
        if (!s) {
            let resolve
            const promise = new Promise(r => { resolve = r })
            s = { seen: false, promise, resolve }
            cancelSignals.set(key, s)
        }
        return s
    }

    function noteCancel(key) {
        const s = signal(key)
        s.seen = true
        s.resolve()
    }

    async function peerCancelled(key) {
        const s = signal(key)
        if (!s.seen) {
            let timer
            await Promise.race([s.promise, new Promise(r => { timer = setTimeout(r, CANCEL_WAIT_MS) })])
            clearTimeout(timer)
        }
        cancelSignals.delete(key)
        return s.seen
    }

    function progress(offerId, peerId, direction, size) {
        let bytes = 0
        let last = 0
        return {
            add(n) {
                bytes += n
                const now = Date.now()
                if (now - last >= PROGRESS_INTERVAL_MS) {
                    last = now
                    events.emit('file-progress', { offerId, peerId, direction, bytes, size })
                }
            },
            end() {
                events.emit('file-progress', { offerId, peerId, direction, bytes, size })
            },
            get bytes() { return bytes }
        }
    }

    function abortStream(stream, reason) {
        try {
            stream?.abort(new Error(reason))
        } catch {}
    }

    function interruptTransfer(t, reason) {
        // The data stream can already be closed while the sender still waits for the receipt on chat.
        t.receipt?.resolve(reason)
        abortStream(t.stream, reason)
    }

    async function offerFile(filePath) {
        const stat = await fsp.stat(filePath)
        if (!stat.isFile()) throw new Error('The path is not a regular file')
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(filePath, { highWaterMark: CHUNK_SIZE })) hash.update(chunk)
        const sha256 = hash.digest('hex')
        const offerId = randomUUID()
        const name = path.basename(filePath)
        const size = stat.size
        const offer = { offerId, filePath, name, size, sha256, targets: new Set(), started: new Set() }
        ownOffers.set(offerId, offer)
        const line = { type: 'file-offer', offerId, name, size, sha256 }
        for (const peerId of openPeers()) if (sendLine(peerId, line)) offer.targets.add(peerId)
        return { offerId, name, size, sha256, peers: offer.targets.size }
    }

    // The sender side of one data stream.
    async function serve(t) {
        const { stream, peerId } = t
        const it = stream.source[Symbol.asyncIterator]()
        let buf = Buffer.alloc(0)
        let line = null
        while (line === null) {
            const { value, done } = await it.next()
            if (done) break
            buf = Buffer.concat([buf, Buffer.from(value.subarray())])
            const i = buf.indexOf(10)
            if (i !== -1 && i <= REQUEST_LIMIT) line = buf.subarray(0, i).toString('utf8')
            else if (buf.length > REQUEST_LIMIT) {
                abortStream(stream, 'Request line too long')
                return
            }
        }
        let request
        try {
            request = JSON.parse(line)
        } catch {}
        const offerId = request?.offerId
        const offer = ownOffers.get(offerId)
        if (stopping || !offer || !offer.targets.has(peerId) || offer.started.has(peerId)) {
            await stream.close().catch(() => abortStream(stream, 'Request refused'))
            return
        }
        offer.started.add(peerId)
        const key = `send|${offerId}|${peerId}`
        t.offerId = offerId
        // Register before sending any bytes. A fast receiver can confirm before our close() returns.
        if (request.ack === 1) t.receipt = Promise.withResolvers()
        active.set(key, t)
        const p = progress(offerId, peerId, 'send', offer.size)
        try {
            const readStream = createReadStream(offer.filePath, { highWaterMark: CHUNK_SIZE })
            t.readStream = readStream
            await stream.sink((async function* () {
                for await (const chunk of readStream) {
                    p.add(chunk.length)
                    yield chunk
                }
            })())
            if (stream.status === 'reset' || stream.status === 'aborted') throw new TransferFailure('stream ended')
            await stream.close()
            if (t.receipt) {
                // The receiver needs EOF to verify the file. The chat session carries its independent result.
                const timer = setTimeout(() => t.receipt.resolve('delivery confirmation timed out'), fileAckTimeout)
                try {
                    const failure = await t.receipt.promise
                    if (failure) throw new TransferFailure(failure)
                } finally {
                    clearTimeout(timer)
                }
            }
            active.delete(key)
            cancelSignals.delete(`${offerId}|${peerId}`)
            p.end()
            events.emit('file-done', { offerId, peerId, direction: 'send', name: offer.name, size: offer.size, confirmed: !!t.receipt })
        } catch (err) {
            t.readStream?.destroy()
            abortStream(stream, 'Transfer ended')
            // Keep the transfer in `active` during the wait. The stream abort of a receiver cancel can come before
            // its file-cancel line. handleControl must find the transfer to note the cancel.
            if (t.selfCancel || stopping) {
                active.delete(key)
                cancelSignals.delete(`${offerId}|${peerId}`)
                events.emit('file-cancelled', { offerId, peerId, direction: 'send', by: 'self' })
            } else if (await peerCancelled(`${offerId}|${peerId}`)) {
                active.delete(key)
                events.emit('file-cancelled', { offerId, peerId, direction: 'send', by: 'peer' })
            } else if (t.selfCancel || stopping) {
                active.delete(key)
                events.emit('file-cancelled', { offerId, peerId, direction: 'send', by: 'self' })
            } else {
                active.delete(key)
                events.emit('file-failed', { offerId, peerId, direction: 'send', reason: shortReason(err) })
            }
        }
    }

    function shortReason(err) {
        if (err instanceof TransferFailure) return err.message
        return 'stream ended'
    }

    // The receiver side of one accepted offer.
    async function receive(offer, t) {
        const { offerId, peerId } = offer
        const temp = path.join(downloadDir, `.asscrack-${offerId}.part`)
        let fh = null
        let tempCreated = false
        const p = progress(offerId, peerId, 'receive', offer.size)
        try {
            const connection = libp2p.getConnections().find(c => c.remotePeer.toString() === peerId && c.status === 'open')
            if (!connection) throw new TransferFailure('peer left')
            fh = await fsp.open(temp, 'wx')
            tempCreated = true
            if (t.selfCancel || stopping) throw new Error('cancelled')
            const stream = await connection.newStream(FILE_PROTOCOL, { runOnTransientConnection: true })
            t.stream = stream
            if (t.selfCancel || stopping) {
                abortStream(stream, 'Transfer cancelled')
                throw new Error('cancelled')
            }
            // 0.6.0 and 0.7.0 senders read only offerId in this header and ignore unknown chat control types.
            stream.sink([Buffer.from(JSON.stringify({ offerId, ack: 1 }) + '\n')]).catch(() => {})
            const hash = createHash('sha256')
            for await (const chunk of stream.source) {
                const data = chunk.subarray()
                if (p.bytes + data.length > offer.size) {
                    abortStream(stream, 'Too many bytes')
                    throw new TransferFailure('too many bytes')
                }
                hash.update(data)
                await fh.writeFile(data)
                p.add(data.length)
            }
            if (t.selfCancel || stopping) throw new Error('cancelled')
            if (p.bytes !== offer.size) throw new TransferFailure('incomplete')
            if (hash.digest('hex') !== offer.sha256) throw new TransferFailure('hash mismatch')
            await fh.close()
            fh = null
            const finalPath = await moveToFreeName(temp, downloadDir, offer.name)
            tempCreated = false
            sendLine(peerId, { type: 'file-received', offerId })
            active.delete(t.key)
            received.delete(offerId)
            cancelSignals.delete(`${offerId}|${peerId}`)
            p.end()
            events.emit('file-done', { offerId, peerId, direction: 'receive', name: offer.name, size: offer.size, path: finalPath })
        } catch (err) {
            abortStream(t.stream, 'Transfer ended')
            if (fh) await fh.close().catch(() => {})
            if (tempCreated) await fsp.unlink(temp).catch(() => {})
            const signalKey = `${offerId}|${peerId}`
            // Keep the transfer in `active` and the offer in `received` during the wait. The stream abort of a sender
            // cancel can come before its file-cancel line. handleControl must find them to note the cancel.
            let ended
            if (t.selfCancel || stopping) {
                cancelSignals.delete(signalKey)
                ended = ['file-cancelled', { offerId, peerId, direction: 'receive', by: 'self' }]
            } else if ((!(err instanceof TransferFailure) || err.message === 'incomplete') && await peerCancelled(signalKey)) {
                ended = ['file-cancelled', { offerId, peerId, direction: 'receive', by: 'peer' }]
            } else if (t.selfCancel || stopping) {
                cancelSignals.delete(signalKey)
                ended = ['file-cancelled', { offerId, peerId, direction: 'receive', by: 'self' }]
            } else {
                cancelSignals.delete(signalKey)
                ended = ['file-failed', { offerId, peerId, direction: 'receive', reason: shortReason(err) }]
            }
            active.delete(t.key)
            received.delete(offerId)
            if (ended[0] === 'file-failed') sendLine(peerId, { type: 'file-receive-failed', offerId })
            events.emit(...ended)
        }
    }

    function acceptFile(offerId) {
        if (typeof downloadDir !== 'string' || downloadDir === '') throw new Error('No download folder is set')
        const offer = received.get(offerId)
        if (!offer || offer.state !== 'offered' || stopping) return false
        offer.state = 'active'
        const t = { direction: 'receive', key: `receive|${offerId}|${offer.peerId}`, offerId, peerId: offer.peerId, stream: null, selfCancel: false }
        active.set(t.key, t)
        t.promise = receive(offer, t).catch(() => {})
        return true
    }

    function refuseFile(offerId) {
        const offer = received.get(offerId)
        if (!offer || offer.state !== 'offered') return false
        received.delete(offerId)
        sendLine(offer.peerId, { type: 'file-refuse', offerId })
        return true
    }

    function cancelFile(offerId, peerId) {
        const own = ownOffers.get(offerId)
        if (own && typeof peerId === 'string') {
            // Cancel the transfer to one receiver only. The transfers to the other receivers continue.
            if (!own.targets.has(peerId)) return false
            const t = active.get(`send|${offerId}|${peerId}`)
            if (own.started.has(peerId) && !t) return false
            own.targets.delete(peerId)
            sendLine(peerId, { type: 'file-cancel', offerId })
            if (t) {
                t.selfCancel = true
                interruptTransfer(t, 'Transfer cancelled')
            } else {
                events.emit('file-cancelled', { offerId, peerId, direction: 'send', by: 'self' })
            }
            return true
        }
        if (own) {
            ownOffers.delete(offerId)
            for (const peerId of own.targets) {
                sendLine(peerId, { type: 'file-cancel', offerId })
            }
            for (const t of active.values()) {
                if (t.offerId === offerId && t.direction === 'send') {
                    t.selfCancel = true
                    interruptTransfer(t, 'Transfer cancelled')
                }
            }
            return true
        }
        const offer = received.get(offerId)
        if (!offer) return false
        if (offer.state === 'offered') return refuseFile(offerId)
        const t = active.get(`receive|${offerId}|${offer.peerId}`)
        if (!t) return false
        t.selfCancel = true
        sendLine(offer.peerId, { type: 'file-cancel', offerId })
        abortStream(t.stream, 'Transfer cancelled')
        return true
    }

    function handleControl(peerId, control) {
        const offerId = control.offerId
        if (typeof offerId !== 'string') return
        if (control.type === 'file-offer') {
            const { size, sha256 } = control
            if (!UUID_RE.test(offerId) || received.has(offerId) || ownOffers.has(offerId)) return
            if (!Number.isSafeInteger(size) || size < 0 || typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return
            const name = safeFileName(control.name)
            received.set(offerId, { offerId, peerId, name, size, sha256, state: 'offered' })
            events.emit('file-offer', { offerId, peerId, from: peerNames()[peerId] ?? '', name, size })
        } else if (control.type === 'file-received' || control.type === 'file-receive-failed') {
            const t = active.get(`send|${offerId}|${peerId}`)
            t?.receipt?.resolve(control.type === 'file-received' ? null : 'receiver could not verify or save file')
        } else if (control.type === 'file-refuse') {
            const own = ownOffers.get(offerId)
            if (!own || !own.targets.has(peerId) || own.started.has(peerId)) return
            own.targets.delete(peerId)
            events.emit('file-refused', { offerId, peerId })
        } else if (control.type === 'file-cancel') {
            const sendKey = `send|${offerId}|${peerId}`
            const sendT = active.get(sendKey)
            if (sendT) {
                noteCancel(`${offerId}|${peerId}`)
                interruptTransfer(sendT, 'Transfer cancelled by peer')
                return
            }
            const own = ownOffers.get(offerId)
            if (own && own.targets.has(peerId) && !own.started.has(peerId)) {
                own.targets.delete(peerId)
                return
            }
            const offer = received.get(offerId)
            if (!offer || offer.peerId !== peerId) return
            if (offer.state === 'offered') {
                received.delete(offerId)
                events.emit('file-cancelled', { offerId, peerId, direction: 'receive', by: 'peer' })
                return
            }
            const t = active.get(`receive|${offerId}|${peerId}`)
            if (t) {
                noteCancel(`${offerId}|${peerId}`)
                abortStream(t.stream, 'Transfer cancelled by peer')
            }
        }
    }

    function peerLeft(peerId) {
        for (const t of active.values()) {
            if (t.peerId === peerId && t.receipt) interruptTransfer(t, 'peer left before confirming delivery')
        }
        for (const offer of [...received.values()]) {
            if (offer.peerId === peerId && offer.state === 'offered') {
                received.delete(offer.offerId)
                events.emit('file-failed', { offerId: offer.offerId, peerId, direction: 'receive', reason: 'peer left' })
            }
        }
        for (const own of ownOffers.values()) if (!own.started.has(peerId)) own.targets.delete(peerId)
    }

    function handleStream({ stream, connection }) {
        const t = { direction: 'send', peerId: connection.remotePeer.toString(), stream, selfCancel: false }
        t.promise = serve(t).catch(() => abortStream(stream, 'Transfer ended'))
    }

    async function stop() {
        stopping = true
        const waits = []
        for (const t of active.values()) {
            sendLine(t.peerId, { type: 'file-cancel', offerId: t.offerId })
            interruptTransfer(t, 'Node stopped')
            if (t.promise) waits.push(t.promise)
        }
        await Promise.allSettled(waits)
    }

    return { offerFile, acceptFile, refuseFile, cancelFile, handleControl, peerLeft, handleStream, stop }
}
