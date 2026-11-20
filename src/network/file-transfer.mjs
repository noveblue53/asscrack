import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

export const FILE_PROTOCOL = '/asscrack/file/1.0.0'

const CHUNK_SIZE = 65536
// Flow version 1 bounds payload handed to the mux ahead of completed receiver writes. Its progress
// controls are cumulative, per offer and authenticated session. A final receipt still requires SHA-256.
const WRITE_WINDOW = 8 * 1024 * 1024
const WRITE_UPDATE = WRITE_WINDOW / 4
const WRITE_UPDATE_MS = 1000
const REQUEST_LIMIT = 1024
const PROGRESS_INTERVAL_MS = 100
const CANCEL_WAIT_MS = 500
const RETRY_WAIT_MS = 10000
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

function sendWindow(timeout) {
    let sent = 0, written = 0, wake = null, failure = null
    function stop(reason) {
        failure ??= reason
        wake?.()
    }
    return {
        async take(length) {
            while (!failure && sent + length - written > WRITE_WINDOW) {
                const changed = Promise.withResolvers()
                wake = changed.resolve
                const timer = setTimeout(() => stop('receiver write progress timed out'), timeout)
                try {
                    await changed.promise
                } finally {
                    clearTimeout(timer)
                    wake = null
                }
            }
            if (failure) throw new TransferFailure(failure)
            sent += length
        },
        written(bytes) {
            if (!Number.isSafeInteger(bytes) || bytes <= written || bytes > sent) return
            written = bytes
            wake?.()
        },
        stop
    }
}

// libp2p calls the iterator's return() when the data stream resets. Wake a blocked credit wait
// immediately even if the separate chat session remains open.
function fileChunks(readStream, window, progress) {
    if (!readStream) return []
    const chunks = readStream[Symbol.asyncIterator]()
    return {
        [Symbol.asyncIterator]() { return this },
        async next() {
            const chunk = await chunks.next()
            if (!chunk.done) {
                if (window) await window.take(chunk.value.length)
                progress.add(chunk.value.length)
            }
            return chunk
        },
        return() {
            window?.stop('stream ended')
            return chunks.return()
        }
    }
}

function splitName(name) {
    const dot = name.lastIndexOf('.')
    if (dot <= 0) return { base: name, ext: '' }
    return { base: name.slice(0, dot), ext: name.slice(dot) }
}

export async function moveToFreeName(temp, dir, name, fs = fsp) {
    const { base, ext } = splitName(name)
    for (let i = 0; ; i++) {
        const candidate = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`)
        try {
            await fs.link(temp, candidate)
            await fs.unlink(temp).catch(() => {})
            return candidate
        } catch (err) {
            if (err?.code === 'EEXIST') continue
            // FAT and some shares lack hard links. Reserve this name before the rename so a
            // concurrent save of the same filename cannot overwrite either verified download.
            let reservation
            try { reservation = await fs.open(candidate, 'wx', 0o600) } catch (reserveError) {
                if (reserveError.code === 'EEXIST') continue
                throw reserveError
            }
            try {
                await reservation.close()
                await fs.rename(temp, candidate)
                return candidate
            } catch (publishError) {
                await fs.unlink(candidate).catch(() => {})
                throw publishError
            }
        }
    }
}

// The file transfer part of a node. The node sends the file control lines to handleControl().
export function createFileTransfer({ libp2p, events, sendTo, openPeers, peerNames, downloadDir, fileAckTimeout = 30000 }) {
    // Offer and download state lives for the current room session.
    const ownOffers = new Map()
    const received = new Map()
    const retryable = new Map()
    const retryRequests = new Map()
    // Active transfers: key `${direction}|${offerId}|${peerId}` -> transfer
    const active = new Map()
    // Peer cancel signals for active transfers: key `${offerId}|${peerId}`
    const cancelSignals = new Map()
    let stopping = false
    const preparation = new AbortController()

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
        t.window?.stop(reason)
        abortStream(t.stream, reason)
    }

    function matchesOriginal(stat, prepared) {
        return stat.isFile() && stat.size === prepared.size && stat.dev === prepared.dev && stat.ino === prepared.ino &&
            stat.mtimeMs === prepared.mtimeMs && stat.ctimeMs === prepared.ctimeMs
    }

    async function unchanged(prepared) {
        try { return matchesOriginal(await fsp.stat(prepared.filePath), prepared) }
        catch { return false }
    }

    async function prepareFile(filePath, displayName) {
        if (stopping) throw new Error('Node stopped')
        const stat = await fsp.stat(filePath)
        if (!stat.isFile()) throw new Error('The path is not a regular file')
        const prepared = { filePath, name: safeFileName(displayName ?? path.basename(filePath)), size: stat.size,
            dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(filePath, { highWaterMark: CHUNK_SIZE, signal: preparation.signal })) hash.update(chunk)
        if (!await unchanged(prepared)) throw new Error('File changed during preparation')
        return { ...prepared, sha256: hash.digest('hex') }
    }

    function publishOffer(prepared, recipients, offerId = randomUUID(), attachmentId = null, retryOf = null) {
        if (stopping) throw new Error('Node stopped')
        const { name, size, sha256 } = prepared
        const offer = { ...prepared, offerId, attachmentId, retryOf, targets: new Set(), started: new Set(),
            failed: new Set(), retries: new Map() }
        const line = { type: 'file-offer', offerId, name, size, sha256, flow: 1 }
        if (attachmentId) line.attachmentId = attachmentId
        else line.retry = 1
        if (retryOf) line.retryOf = retryOf
        for (const peerId of recipients) if (sendLine(peerId, line)) offer.targets.add(peerId)
        if (offer.targets.size) ownOffers.set(offerId, offer)
        return { offerId, name, size, sha256, peers: offer.targets.size, recipients: [...offer.targets] }
    }

    function offerAttachmentTo(prepared, descriptor, peerId) {
        for (const offer of ownOffers.values()) {
            if (offer.attachmentId === descriptor.id && offer.targets.has(peerId) && !offer.started.has(peerId)) return
        }
        publishOffer(prepared, [peerId], randomUUID(), descriptor.id)
    }

    function expireAttachment(id) {
        for (const [offerId, offer] of ownOffers) {
            if (offer.attachmentId !== id) continue
            for (const peer of offer.targets) if (!offer.started.has(peer)) sendLine(peer, { type: 'file-cancel', offerId })
            ownOffers.delete(offerId)
        }
    }

    async function offerFile(filePath, recipientId) {
        const targeted = recipientId !== undefined
        if (targeted && !openPeers().includes(recipientId)) throw new Error('The selected recipient is not connected')
        const prepared = await prepareFile(filePath)
        const offer = publishOffer(prepared, targeted ? [recipientId] : openPeers())
        if (targeted && !offer.peers) throw new Error('The selected recipient disconnected before the file could be offered')
        return offer
    }

    function consumeRetryGrant(offer, peerId) {
        if (!offer.retryOf || offer.retryClaimed) return true
        const prior = ownOffers.get(offer.retryOf)
        if (prior?.retries.get(peerId)?.attemptId !== offer.offerId || !prior.failed.has(peerId)) return false
        prior.failed.delete(peerId)
        prior.retries.delete(peerId)
        offer.retryClaimed = true
        return true
    }

    // Each retry gets a new wire ID so late progress, cancellation and receipts cannot
    // affect the new stream. The prior grant belongs only to the original recipient.
    async function offerRetry(peerId, offerId, attemptId) {
        if (!UUID_RE.test(offerId) || typeof attemptId !== 'string' || !UUID_RE.test(attemptId) || attemptId === offerId || ownOffers.has(attemptId) ||
            received.has(attemptId) || retryable.has(attemptId)) return
        const prior = ownOffers.get(offerId)
        const deny = () => sendLine(peerId, { type: 'file-retry-unavailable', offerId, attemptId })
        if (!prior || prior.attachmentId) return deny()
        const pending = prior.retries.get(peerId)
        if (pending?.checking) return
        if (pending) {
            const old = ownOffers.get(pending.attemptId)
            if (old?.started.has(peerId)) return deny()
            ownOffers.delete(pending.attemptId)
            if (old?.targets.has(peerId)) events.emit('file-failed', { offerId: old.offerId, peerId,
                direction: 'send', reason: 'replaced by a newer retry' })
        }
        const retry = { attemptId, checking: true }
        prior.retries.set(peerId, retry)
        const authorized = () => !stopping && ownOffers.get(offerId) === prior && prior.failed.has(peerId)
        try {
            const previous = active.get(`send|${offerId}|${peerId}`)
            if (previous) await previous.promise
            if (!authorized() || !await unchanged(prior) || !authorized() || !openPeers().includes(peerId) ||
                ownOffers.has(attemptId) || received.has(attemptId) || retryable.has(attemptId)) return deny()
            // A retry may itself disconnect before its stream opens. The request for that
            // offer proves it arrived, so the same recipient can no longer reopen its parent.
            if (!prior.started.has(peerId) && !consumeRetryGrant(prior, peerId)) return deny()
            const next = publishOffer(prior, [peerId], attemptId, null, offerId)
            if (next.peers) {
                events.emit('file-retried', { offerId: attemptId, retryOf: offerId, peerId, direction: 'send',
                    name: next.name, size: next.size })
            }
        } finally {
            retry.checking = false
            if (!ownOffers.has(attemptId) && prior.retries.get(peerId) === retry) prior.retries.delete(peerId)
        }
    }

    function failReceive(offer, reason) {
        if (offer.retry) retryable.set(offer.offerId, offer)
        events.emit('file-failed', { offerId: offer.offerId, peerId: offer.peerId, direction: 'receive', reason,
            ...(offer.retry ? { retryable: true } : {}) })
    }

    function finishRetry(offerId, reason, canRetry) {
        const retry = retryRequests.get(offerId)
        if (!retry) return
        clearTimeout(retry.timer)
        retryRequests.delete(offerId)
        if (!canRetry) retryable.delete(offerId)
        if (reason) events.emit('file-failed', { offerId, peerId: retry.peerId, direction: 'receive', reason, retryable: canRetry })
    }

    function retryFile(offerId) {
        const offer = retryable.get(offerId)
        if (!offer || retryRequests.has(offerId) || stopping || !openPeers().includes(offer.peerId)) return false
        const attemptId = randomUUID()
        const timer = setTimeout(() => finishRetry(offerId, 'retry request timed out', true), RETRY_WAIT_MS)
        timer.unref?.()
        retryRequests.set(offerId, { attemptId, timer, peerId: offer.peerId })
        if (sendLine(offer.peerId, { type: 'file-retry', offerId, attemptId })) return true
        finishRetry(offerId, null, true)
        return false
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
        if (stopping || !offer || !offer.targets.has(peerId) || offer.started.has(peerId) || !consumeRetryGrant(offer, peerId)) {
            await stream.close().catch(() => abortStream(stream, 'Request refused'))
            return
        }
        offer.started.add(peerId)
        const key = `send|${offerId}|${peerId}`
        t.offerId = offerId
        // Register before sending any bytes. A fast receiver can confirm before our close() returns.
        if (request.ack === 1) t.receipt = Promise.withResolvers()
        if (t.receipt && request.flow === 1) t.window = sendWindow(fileAckTimeout)
        active.set(key, t)
        const p = progress(offerId, peerId, 'send', offer.size)
        let original
        try {
            // The peer can accept long after the offer was prepared. Bind reads to the checked handle
            // and the offered extent, even if the path is replaced or the file grows during the send.
            original = await fsp.open(offer.filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
            if (!matchesOriginal(await original.stat(), offer)) throw new TransferFailure('original file changed')
            if (t.selfCancel || stopping) throw new Error('cancelled')
            const readStream = offer.size ? original.createReadStream({ highWaterMark: CHUNK_SIZE, end: offer.size - 1 }) : null
            t.readStream = readStream
            await stream.sink(fileChunks(readStream, t.window, p))
            if (p.bytes !== offer.size) throw new TransferFailure('original file changed')
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
                if (!offer.attachmentId && offer.targets.has(peerId)) offer.failed.add(peerId)
                events.emit('file-failed', { offerId, peerId, direction: 'send', reason: shortReason(err) })
            }
        } finally {
            await original?.close().catch(() => {})
        }
    }

    function shortReason(err) {
        if (err instanceof TransferFailure) return err.message
        if (err?.code === 'ENOSPC' || err?.code === 'EDQUOT') return 'not enough disk space'
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
            if (t.selfCancel || t.peerCancel || stopping) throw new Error('cancelled')
            if (t.disconnected) throw new TransferFailure('peer left')
            const stream = await connection.newStream(FILE_PROTOCOL, { runOnTransientConnection: true })
            t.stream = stream
            if (t.selfCancel || t.peerCancel || stopping) {
                abortStream(stream, 'Transfer cancelled')
                throw new Error('cancelled')
            }
            if (t.disconnected) throw new TransferFailure('peer left')
            // 0.6.0 and 0.7.0 senders read only offerId in this header and ignore unknown chat control types.
            const header = { offerId, ack: 1 }
            if (offer.flow) header.flow = 1
            stream.sink([Buffer.from(JSON.stringify(header) + '\n')]).catch(() => {})
            let lastWritten = 0, lastUpdate = Date.now()
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
                if (offer.flow && (p.bytes - lastWritten >= WRITE_UPDATE || Date.now() - lastUpdate >= WRITE_UPDATE_MS)) {
                    sendLine(peerId, { type: 'file-written', offerId, bytes: p.bytes })
                    lastWritten = p.bytes
                    lastUpdate = Date.now()
                }
            }
            if (t.selfCancel || t.peerCancel || stopping) throw new Error('cancelled')
            if (t.disconnected) throw new TransferFailure('peer left')
            if (p.bytes !== offer.size) throw new TransferFailure('incomplete')
            if (hash.digest('hex') !== offer.sha256) throw new TransferFailure('hash mismatch')
            await fh.close()
            fh = null
            if (t.selfCancel || t.peerCancel || stopping) throw new Error('cancelled')
            if (t.disconnected) throw new TransferFailure('peer left')
            // Once publishing starts, cancellation can no longer recall a verified saved file.
            t.finalizing = true
            const finalPath = await moveToFreeName(temp, downloadDir, offer.name)
            tempCreated = false
            sendLine(peerId, { type: 'file-received', offerId })
            active.delete(t.key)
            received.delete(offerId)
            cancelSignals.delete(`${offerId}|${peerId}`)
            p.end()
            events.emit('file-done', { offerId, peerId, direction: 'receive', name: offer.name, size: offer.size, path: finalPath, ...(offer.attachmentId ? { attachmentId: offer.attachmentId, sha256: offer.sha256 } : {}) })
        } catch (err) {
            abortStream(t.stream, 'Transfer ended')
            if (fh) await fh.close().catch(() => {})
            if (tempCreated) await fsp.unlink(temp).catch(() => {})
            const signalKey = `${offerId}|${peerId}`
            // Keep the transfer in `active` and the offer in `received` during the wait. The stream abort of a sender
            // cancel can come before its file-cancel line. handleControl must find them to note the cancel.
            let cancelled
            if (t.selfCancel || stopping) cancelled = 'self'
            else if ((!(err instanceof TransferFailure) || err.message === 'incomplete') && await peerCancelled(signalKey)) {
                cancelled = 'peer'
            } else if (t.selfCancel || stopping) cancelled = 'self'
            cancelSignals.delete(signalKey)
            active.delete(t.key)
            received.delete(offerId)
            if (cancelled) events.emit('file-cancelled', { offerId, peerId, direction: 'receive', by: cancelled })
            else {
                sendLine(peerId, { type: 'file-receive-failed', offerId })
                failReceive(offer, t.disconnected ? 'peer left' : shortReason(err))
            }
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
            consumeRetryGrant(own, peerId)
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
                consumeRetryGrant(own, peerId)
                const t = active.get(`send|${offerId}|${peerId}`)
                if (own.started.has(peerId) && !t) continue
                sendLine(peerId, { type: 'file-cancel', offerId })
                if (t) {
                    t.selfCancel = true
                    interruptTransfer(t, 'Transfer cancelled')
                } else {
                    events.emit('file-cancelled', { offerId, peerId, direction: 'send', by: 'self' })
                }
            }
            return true
        }
        const offer = received.get(offerId)
        if (!offer) return false
        if (offer.state === 'offered') return refuseFile(offerId)
        const t = active.get(`receive|${offerId}|${offer.peerId}`)
        if (!t || t.finalizing) return false
        t.selfCancel = true
        sendLine(offer.peerId, { type: 'file-cancel', offerId })
        abortStream(t.stream, 'Transfer cancelled')
        return true
    }

    function handleControl(peerId, control) {
        const offerId = control.offerId
        if (typeof offerId !== 'string') return
        if (control.type === 'file-retry') {
            offerRetry(peerId, offerId, control.attemptId).catch(() => {})
        } else if (control.type === 'file-retry-unavailable') {
            const retry = retryRequests.get(offerId)
            if (retry?.peerId === peerId && retry.attemptId === control.attemptId) {
                finishRetry(offerId, 'the sender can no longer offer this file', false)
            }
        } else if (control.type === 'file-offer') {
            const { size, sha256 } = control
            if (!UUID_RE.test(offerId) || received.has(offerId) || ownOffers.has(offerId) || retryable.has(offerId)) return
            if (!Number.isSafeInteger(size) || size < 0 || typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return
            const name = safeFileName(control.name)
            const rich = typeof control.attachmentId === 'string' && UUID_RE.test(control.attachmentId) ? { attachmentId: control.attachmentId, sha256 } : {}
            const retryOf = control.retryOf
            if (retryOf !== undefined) {
                const previous = retryable.get(retryOf)
                if (!previous || previous.peerId !== peerId || previous.name !== name || previous.sha256 !== sha256 ||
                    previous.size !== size || retryRequests.get(retryOf)?.attemptId !== offerId || rich.attachmentId || control.retry !== 1) return
                finishRetry(retryOf, null, false)
            }
            received.set(offerId, { offerId, peerId, name, size, sha256, flow: control.flow === 1,
                retry: control.retry === 1 && !rich.attachmentId, ...rich, state: 'offered' })
            events.emit('file-offer', { offerId, peerId, from: peerNames()[peerId] ?? '', name, size, ...rich,
                ...(retryOf ? { retryOf } : {}) })
            return true
        } else if (control.type === 'file-written') {
            active.get(`send|${offerId}|${peerId}`)?.window?.written(control.bytes)
        } else if (control.type === 'file-received' || control.type === 'file-receive-failed') {
            const t = active.get(`send|${offerId}|${peerId}`)
            const failed = control.type === 'file-receive-failed'
            const reason = 'receiver could not verify or save file'
            if (t?.receipt) {
                if (failed) t.window?.stop(reason)
                t.receipt.resolve(failed ? reason : null)
            }
            else if (failed) {
                // A disk error can occur before the receiver opens the data stream.
                const offer = ownOffers.get(offerId)
                if (offer && !offer.started.has(peerId) && offer.targets.delete(peerId)) {
                    if (!offer.attachmentId) offer.failed.add(peerId)
                    events.emit('file-failed', { offerId, peerId, direction: 'send', reason })
                }
            }
        } else if (control.type === 'file-refuse') {
            const own = ownOffers.get(offerId)
            if (!own || !own.targets.has(peerId) || own.started.has(peerId)) return
            own.targets.delete(peerId)
            consumeRetryGrant(own, peerId)
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
                consumeRetryGrant(own, peerId)
                events.emit('file-cancelled', { offerId, peerId, direction: 'send', by: 'peer' })
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
            if (t && !t.finalizing) {
                t.peerCancel = true
                noteCancel(`${offerId}|${peerId}`)
                abortStream(t.stream, 'Transfer cancelled by peer')
            }
        }
    }

    function peerLeft(peerId) {
        for (const t of active.values()) {
            if (t.peerId !== peerId || t.finalizing) continue
            if (t.direction === 'receive') {
                t.disconnected = true
                interruptTransfer(t, 'peer left')
            } else if (t.receipt) interruptTransfer(t, 'peer left before confirming delivery')
        }
        for (const offer of [...received.values()]) {
            if (offer.peerId === peerId && offer.state === 'offered') {
                received.delete(offer.offerId)
                failReceive(offer, 'peer left')
            }
        }
        for (const [offerId, retry] of retryRequests) {
            if (retry.peerId === peerId) finishRetry(offerId, 'peer left', true)
        }
        for (const own of ownOffers.values()) {
            if (!own.started.has(peerId) && own.targets.delete(peerId)) {
                if (!own.attachmentId) own.failed.add(peerId)
                events.emit('file-failed', { offerId: own.offerId, peerId, direction: 'send', reason: 'peer left' })
            }
        }
    }

    function handleStream({ stream, connection }) {
        const t = { direction: 'send', peerId: connection.remotePeer.toString(), stream, selfCancel: false }
        t.promise = serve(t).catch(() => abortStream(stream, 'Transfer ended'))
    }

    async function stop() {
        stopping = true
        preparation.abort()
        for (const offerId of retryRequests.keys()) finishRetry(offerId)
        const waits = []
        for (const t of active.values()) {
            if (!t.finalizing) {
                sendLine(t.peerId, { type: 'file-cancel', offerId: t.offerId })
                interruptTransfer(t, 'Node stopped')
            }
            if (t.promise) waits.push(t.promise)
        }
        await Promise.allSettled(waits)
    }

    return { prepareFile, publishOffer, offerAttachmentTo, expireAttachment, forgetOffer: id => ownOffers.delete(id), unchanged, offerFile, acceptFile, retryFile,
        refuseFile, cancelFile, handleControl, peerLeft, handleStream, stop }
}
