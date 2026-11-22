import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { roomRateLimit } from './room-rate-limit.mjs'
import { createPartialStore, partialKey, PARTIAL_TTL_MS } from './partial-store.mjs'
import { createGrantStore, GRANT_LIMIT } from './send-grants.mjs'

export const FILE_PROTOCOL = '/asscrack/file/1.0.0'
// Version 1.1.0 adds the offset negotiation for a paused partial. The receiver asks for 1.1.0 only when it has a
// partial to continue. A sender with only 1.0.0 then sends the full file from byte 0.
export const FILE_RESUME_PROTOCOL = '/asscrack/file/1.1.0'
export const FILE_PROTOCOLS = [FILE_PROTOCOL, FILE_RESUME_PROTOCOL]

const CHUNK_SIZE = 65536
// Flow version 1 bounds payload handed to the mux ahead of completed receiver writes. Its progress
// controls are cumulative, per offer and authenticated session. A final receipt still requires SHA-256.
const WRITE_WINDOW = 8 * 1024 * 1024
const WRITE_UPDATE = WRITE_WINDOW / 4
const WRITE_UPDATE_MS = 1000
const REQUEST_LIMIT = 1024
const REPLY_LIMIT = 256
const PROGRESS_INTERVAL_MS = 100
const CANCEL_WAIT_MS = 500
const RETRY_WAIT_MS = 10000
const OPEN_TIMEOUT_MS = 10000
const DATA_IDLE_MS = 60000
const OFFER_TTL_MS = 30 * 60 * 1000
const MAX_OPEN_REQUESTS = 12
const MAX_REQUESTS_PER_PEER = 2
const MAX_ACTIVE_TRANSFERS = 8
const MAX_ACTIVE_PER_PEER = 2
const MAX_INCOMING_OFFERS = 128
const MAX_INCOMING_PER_PEER = 16
const MAX_OUTGOING_OFFERS = 256
const MAX_PENDING_SENDS = 256
const MAX_RETRYABLE_OFFERS = 128
const STORAGE_RESERVE = 64n * 1024n * 1024n
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA_RE = /^[0-9a-f]{64}$/
const RESERVED_RE = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i

export function safeFileName(name) {
    if (typeof name !== 'string') name = 'file'
    let n = name.split(/[\\/]/).pop()
    n = n.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
    n = n.replace(/[ .]+$/, '').replace(/^ +/, '')
    if (RESERVED_RE.test(n.split('.')[0].trimEnd())) n = '_' + n
    if (n.length > 200) {
        const dot = n.lastIndexOf('.')
        const extLength = dot === -1 ? 0 : n.length - dot - 1
        const ext = extLength >= 1 && extLength <= 16 ? n.slice(dot) : ''
        const base = ext ? n.slice(0, dot) : n
        n = (base.slice(0, 200 - ext.length) + ext).replace(/[ .]+$/, '')
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

async function readRequest(stream) {
    const it = stream.source[Symbol.asyncIterator]()
    const header = Buffer.allocUnsafe(REQUEST_LIMIT)
    let used = 0
    for (;;) {
        const { value, done } = await it.next()
        if (done) return null
        for (const part of value instanceof Uint8Array ? [value] : value) {
            const bytes = Buffer.from(part.buffer, part.byteOffset, Math.min(part.byteLength, REQUEST_LIMIT - used + 1))
            const lf = bytes.indexOf(10)
            const size = lf < 0 ? bytes.length : lf
            if (used + size > REQUEST_LIMIT) return null
            bytes.copy(header, used, 0, size)
            used += size
            if (lf >= 0) {
                try { return JSON.parse(header.toString('utf8', 0, used)) }
                catch { return null }
            }
        }
    }
}

// Reads the one-line reply of a 1.1.0 sender. The bytes after the line are file bytes.
async function readReply(it) {
    const header = Buffer.allocUnsafe(REPLY_LIMIT)
    let used = 0
    for (;;) {
        const { value, done } = await it.next()
        if (done) return null
        const parts = value instanceof Uint8Array ? [value] : [...value]
        for (let i = 0; i < parts.length; i++) {
            const bytes = Buffer.from(parts[i].buffer, parts[i].byteOffset, parts[i].byteLength)
            const lf = bytes.indexOf(10)
            const size = lf < 0 ? bytes.length : lf
            if (used + size > REPLY_LIMIT) return null
            bytes.copy(header, used, 0, size)
            used += size
            if (lf < 0) continue
            let reply
            try { reply = JSON.parse(header.toString('utf8', 0, used)) } catch { return null }
            if (!reply || typeof reply !== 'object') return null
            return { reply, rest: [bytes.subarray(lf + 1), ...parts.slice(i + 1)].filter(part => part.byteLength) }
        }
    }
}

function joinSource(rest, it) {
    return (async function* () {
        yield* rest
        for (;;) {
            const { value, done } = await it.next()
            if (done) return
            yield value
        }
    })()
}

async function writeAll(fh, data, position) {
    for (let done = 0; done < data.byteLength;) {
        const { bytesWritten } = await fh.write(data, done, data.byteLength - done, position + done)
        if (!bytesWritten) throw new Error('no bytes written')
        done += bytesWritten
    }
}

// SHA-256 of the first `bytes` bytes of an open file. Returns null when the file has fewer bytes.
async function hashPrefix(fh, bytes, hash = createHash('sha256')) {
    let read = 0
    if (bytes) {
        for await (const chunk of fh.createReadStream({ start: 0, end: bytes - 1, highWaterMark: CHUNK_SIZE, autoClose: false })) {
            hash.update(chunk)
            read += chunk.length
        }
    }
    return read === bytes ? hash : null
}

function splitName(name) {
    const dot = name.lastIndexOf('.')
    if (dot <= 0) return { base: name, ext: '' }
    return { base: name.slice(0, dot), ext: name.slice(dot) }
}

export async function moveToFreeName(temp, dir, name, fs = fsp) {
    const { base, ext } = splitName(name)
    for (let i = 0; i < 4096; i++) {
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
    throw new TransferFailure('Too many downloads use this name')
}

// The file transfer part of a node. The node sends the file control lines to handleControl().
export function createFileTransfer({ libp2p, events, sendTo, openPeers, isPeerOpen = peerId => openPeers().includes(peerId),
    peerNames, downloadDir, scratchDir = downloadDir, fileAckTimeout = 30000, fileOpenTimeout = OPEN_TIMEOUT_MS,
    fileIdleTimeout = DATA_IDLE_MS, partials = {}, peerDevice = () => null }) {
    // Offer and download state lives for the current room session.
    const ownOffers = new Map()
    const received = new Map()
    const retryable = new Map()
    const retryRequests = new Map()
    // Active transfers: key `${direction}|${offerId}|${peerId}` -> transfer
    const active = new Map()
    const requests = new Set()
    const allowOfferControl = roomRateLimit(32, 128)
    // Peer cancel signals for active transfers: key `${offerId}|${peerId}`
    const cancelSignals = new Map()
    let stopping = false
    let preparing = 0
    const preparation = new AbortController()

    const sendLine = (peerId, message) => sendTo(peerId, message)

    // Paused partials. `partials: false` turns Pause off. The store is in the scratch folder by default, thus
    // download-scratch.mjs can move it to the folder of the next run.
    const partialDir = partials ? partials.dir ?? scratchDir : null
    const store = typeof partialDir === 'string' && partialDir !== '' ? createPartialStore({ dir: partialDir,
        budget: partials.budget, ttl: partials.ttl, now: partials.now,
        onChange(type, partial) {
            if (type === 'expired' || type === 'discarded') events.emit(`file-${type}`, partial)
            events.emit('file-partials', { partials: store.snapshot() })
        } }) : null
    // P7c: one time on both ends. The sender keeps the grant of a paused leg, and the receiver keeps the part and its
    // retry state, for the same time after the pause.
    const resumeTtl = Number.isSafeInteger(partials?.ttl) && partials.ttl >= 0 ? partials.ttl : PARTIAL_TTL_MS
    const deviceOf = peerId => {
        try {
            const device = peerDevice(peerId)
            return typeof device === 'string' && device !== '' ? device : null
        } catch { return null }
    }

    // P7c: the saved grants of the sender (protected rooms only: a grant needs the device ID of the receiver).
    const grants = partials && typeof partials.grantsFile === 'string' && partials.grantsFile !== '' ?
        createGrantStore({ file: partials.grantsFile }) : null
    let grantsLoaded = !grants
    const grantsReady = grants ? grants.load().then(restoreGrants).catch(() => {}).finally(() => { grantsLoaded = true }) : Promise.resolve()

    // A restored grant has no peer ID yet. Its key in `failed` is `device:<id>` until the device asks again.
    function restoreGrants(list) {
        for (const g of list) {
            const key = `device:${g.device}`
            let offer = ownOffers.get(g.offerId)
            if (!offer) {
                if (ownOffers.size >= MAX_OUTGOING_OFFERS) break
                offer = { filePath: g.filePath, name: g.name, size: g.size, sha256: g.sha256, dev: g.dev, ino: g.ino,
                    mtimeMs: g.mtimeMs, ctimeMs: g.ctimeMs, offerId: g.offerId, attachmentId: null, retryOf: null,
                    targets: new Set(), started: new Set(), failed: new Set(), failedUntil: new Map(), paused: new Map(),
                    retries: new Map(), retryClaimed: false, expiresAt: g.expiresAt }
                ownOffers.set(g.offerId, offer)
            }
            offer.failed.add(key)
            offer.failedUntil.set(key, g.expiresAt)
            offer.paused.set(key, g.device)
            offer.expiresAt = Math.max(offer.expiresAt, g.expiresAt)
        }
    }

    function grantList() {
        const list = []
        const time = Date.now()
        for (const offer of ownOffers.values()) {
            if (offer.attachmentId || typeof offer.filePath !== 'string' || !offer.paused) continue
            for (const [peerId, device] of offer.paused) {
                const expiresAt = offer.failedUntil.get(peerId)
                if (!offer.failed.has(peerId) || !(expiresAt > time)) continue
                const { offerId, filePath, name, size, sha256, dev, ino, mtimeMs, ctimeMs } = offer
                list.push({ offerId, device, filePath, name, size, sha256, dev, ino, mtimeMs, ctimeMs, expiresAt })
            }
        }
        return list.slice(-GRANT_LIMIT)
    }

    function saveGrants() {
        if (grants) grantsReady.then(() => grants.save(grantList())).catch(() => {})
    }

    // P7c: the receiver restarted (or the sender restarted) and has a new peer ID. The paused leg of the same device
    // moves to the new peer ID. Only a paused leg with a device ID moves, and only from a peer that is not open.
    // Returns the old peer ID, or null.
    function moveGrant(prior, peerId) {
        const device = deviceOf(peerId)
        if (!device || !prior.paused) return null
        for (const [old, pausedDevice] of prior.paused) {
            if (pausedDevice !== device || old === peerId || !prior.failed.has(old) || isPeerOpen(old)) continue
            prior.failed.delete(old)
            prior.failed.add(peerId)
            prior.failedUntil.set(peerId, prior.failedUntil.get(old))
            prior.failedUntil.delete(old)
            prior.paused.delete(old)
            prior.paused.set(peerId, device)
            if (prior.targets.delete(old)) prior.targets.add(peerId)
            if (prior.started.delete(old)) prior.started.add(peerId)
            const pending = prior.retries.get(old)
            if (pending && !pending.checking) prior.retries.delete(old)
            saveGrants()
            return old
        }
        return null
    }

    // P7c: the retry state of the receiver for each kept part with a sender device (a protected room). Resume can
    // then ask the sender after a restart of the app.
    function restoreRetry(partial) {
        const source = partial ? store?.source(partial.key) : null
        if (!source || !UUID_RE.test(source.offerId)) return null
        const known = retryable.get(source.offerId)
        if (known) return known
        if (retryable.size >= MAX_RETRYABLE_OFFERS || partial.expiresAt <= Date.now()) return null
        const offer = { offerId: source.offerId, peerId: source.peerId, device: source.device, name: partial.name,
            size: partial.size, sha256: partial.sha256, flow: source.flow, retry: true, paused: true, restored: true,
            expiresAt: partial.expiresAt }
        retryable.set(offer.offerId, offer)
        return offer
    }
    store?.list().then(list => { for (const partial of list) restoreRetry(partial) }).catch(() => {})

    // The retry state for a kept part: only with the device ID of the sender. Null: no retry state. Undefined:
    // keep the state that the store has.
    function sourceOf(offer) {
        if (!offer.retry) return null
        const device = deviceOf(offer.peerId)
        if (!device) return undefined
        return { peerId: offer.peerId, device, from: peerNames()[offer.peerId] ?? '', flow: offer.flow === true }
    }

    function forgetSource(offer) {
        if (store && offer?.paused) store.forgetSource(partialKey(offer.sha256, offer.size)).catch(() => {})
    }

    function countForPeer(entries, peerId) {
        let count = 0
        for (const item of entries) if (item.peerId === peerId) count++
        return count
    }

    function canStart(peerId) {
        return active.size < MAX_ACTIVE_TRANSFERS && countForPeer(active.values(), peerId) < MAX_ACTIVE_PER_PEER
    }

    function pruneOffers() {
        const now = Date.now()
        const sending = new Set([...active.values()].filter(transfer => transfer.direction === 'send').map(transfer => transfer.offerId))
        let grantsChanged = false
        for (const [id, offer] of ownOffers) {
            if (offer.expiresAt > now || sending.has(id)) continue
            ownOffers.delete(id)
            for (const peerId of offer.targets) {
                if (offer.started.has(peerId)) continue
                sendLine(peerId, { type: 'file-cancel', offerId: id })
                events.emit('file-failed', { offerId: id, peerId, direction: 'send', reason: 'offer expired' })
            }
            // P7c: a paused leg ends here. The row of the sender gets an end, not "Paused by" for ever.
            for (const peerId of offer.paused?.keys() ?? []) {
                grantsChanged = true
                if (offer.failed.has(peerId) && !peerId.startsWith('device:')) {
                    events.emit('file-failed', { offerId: id, peerId, direction: 'send', reason: 'resume expired' })
                }
            }
        }
        if (grantsChanged) saveGrants()
        for (const [id, offer] of received) {
            if (offer.state !== 'offered' || offer.expiresAt > now) continue
            received.delete(id)
            sendLine(offer.peerId, { type: 'file-refuse', offerId: id })
            events.emit('file-failed', { offerId: id, peerId: offer.peerId, direction: 'receive', reason: 'offer expired' })
        }
        for (const [id, offer] of retryable) {
            if (offer.expiresAt > now) continue
            forgetSource(offer)
            forgetRetry(id)
        }
    }

    const expiryTimer = setInterval(() => {
        pruneOffers()
        store?.sweep().catch(() => {})
    }, 30000)
    expiryTimer.unref?.()

    function signal(key) {
        let s = cancelSignals.get(key)
        if (!s) {
            let resolve
            const promise = new Promise(r => { resolve = r })
            s = { seen: false, kind: null, promise, resolve }
            cancelSignals.set(key, s)
        }
        return s
    }

    function noteCancel(key, kind = 'cancel') {
        const s = signal(key)
        s.seen = true
        s.kind ??= kind
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
        return s.seen ? s.kind : null
    }

    // `bytes` counts the bytes of this stream. The events give the bytes of the file: offset() plus `bytes`.
    function progress(offerId, peerId, direction, size, onProgress, offset = () => 0) {
        let bytes = 0
        let last = 0
        return {
            add(n) {
                if (!n) return
                onProgress?.(n)
                bytes += n
                const now = Date.now()
                if (now - last >= PROGRESS_INTERVAL_MS) {
                    last = now
                    events.emit('file-progress', { offerId, peerId, direction, bytes: offset() + bytes, size })
                }
            },
            end() {
                events.emit('file-progress', { offerId, peerId, direction, bytes: offset() + bytes, size })
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

    function idleDeadline(t) {
        const timer = setTimeout(() => {
            t.idleExpired = true
            interruptTransfer(t, 'transfer stalled')
        }, fileIdleTimeout)
        timer.unref?.()
        return timer
    }

    // A failed leg stays open to a retry for OFFER_TTL_MS. P7c: a paused leg stays open for resumeTtl, and in a
    // protected room the grant is saved with the device ID of the receiver.
    // `device`: the device ID from the start of the stream (the peer can be gone at the failure).
    function markFailedOffer(offer, peerId, { pause = false, device: known = null } = {}) {
        if (offer.attachmentId) return
        offer.failed.add(peerId)
        const until = Date.now() + (pause ? resumeTtl : OFFER_TTL_MS)
        offer.failedUntil.set(peerId, until)
        offer.expiresAt = Math.max(offer.expiresAt, until)
        const device = pause ? known ?? deviceOf(peerId) : null
        if (device) offer.paused.set(peerId, device)
        else if (!offer.paused.delete(peerId)) return
        saveGrants()
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
        if (preparing >= 2) throw new Error('Too many files are being prepared')
        preparing++
        let original
        try {
            original = await fsp.open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
            const stat = await original.stat()
            if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('The path is not a supported regular file')
            const prepared = { filePath, name: safeFileName(displayName ?? path.basename(filePath)), size: stat.size,
                dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
            const hash = createHash('sha256')
            if (prepared.size) {
                const input = original.createReadStream({ highWaterMark: CHUNK_SIZE, end: prepared.size - 1,
                    autoClose: false, signal: preparation.signal })
                for await (const chunk of input) hash.update(chunk)
            }
            if (stopping || !matchesOriginal(await original.stat(), prepared) || !await unchanged(prepared)) {
                throw new Error('File changed during preparation')
            }
            return { ...prepared, sha256: hash.digest('hex') }
        } finally {
            await original?.close().catch(() => {})
            preparing--
        }
    }

    function publishOffer(prepared, recipients, offerId = randomUUID(), attachmentId = null, retryOf = null) {
        if (stopping) throw new Error('Node stopped')
        if (ownOffers.size >= MAX_OUTGOING_OFFERS) {
            pruneOffers()
            for (const [id, offer] of ownOffers) {
                if (offer.failed.size || offer.retries.size || [...offer.targets].some(peer =>
                    !offer.started.has(peer) || active.has(`send|${id}|${peer}`))) continue
                ownOffers.delete(id)
                break
            }
            if (ownOffers.size >= MAX_OUTGOING_OFFERS) throw new Error('Too many outstanding file offers')
        }
        let pending = recipients.length
        for (const offer of ownOffers.values()) {
            for (const peer of offer.targets) if (!offer.started.has(peer)) pending++
        }
        if (pending > MAX_PENDING_SENDS) throw new Error('Too many recipients have pending file offers')
        const { name, size, sha256 } = prepared
        const offer = { ...prepared, offerId, attachmentId, retryOf, targets: new Set(), started: new Set(),
            failed: new Set(), failedUntil: new Map(), paused: new Map(), retries: new Map(), retryClaimed: false,
            expiresAt: Date.now() + OFFER_TTL_MS }
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
        prior.failedUntil.delete(peerId)
        if (prior.paused.delete(peerId)) saveGrants()
        offer.retryClaimed = true
        return true
    }

    // Each retry gets a new wire ID so late progress, cancellation and receipts cannot
    // affect the new stream. The prior grant belongs only to the original recipient.
    async function offerRetry(peerId, offerId, attemptId) {
        if (!UUID_RE.test(offerId) || typeof attemptId !== 'string' || !UUID_RE.test(attemptId) || attemptId === offerId || ownOffers.has(attemptId) ||
            received.has(attemptId) || retryable.has(attemptId)) return
        if (!grantsLoaded) await grantsReady
        const prior = ownOffers.get(offerId)
        const deny = reason => sendLine(peerId, { type: 'file-retry-unavailable', offerId, attemptId, ...(reason ? { reason } : {}) })
        if (!prior || prior.attachmentId) return deny()
        // P7c: a paused leg of the same device with an older peer ID (a restart of one end).
        const moved = prior.failed.has(peerId) ? null : moveGrant(prior, peerId)
        if (!prior.failed.has(peerId) || prior.expiresAt <= Date.now() ||
            (prior.failedUntil.get(peerId) ?? Infinity) <= Date.now()) return deny()
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
            if (!authorized()) return deny()
            if (!await unchanged(prior)) {
                if (prior.paused.delete(peerId)) saveGrants()
                return deny('changed')
            }
            if (!authorized() || !isPeerOpen(peerId) ||
                ownOffers.has(attemptId) || received.has(attemptId) || retryable.has(attemptId)) return deny()
            // A retry may itself disconnect before its stream opens. The request for that
            // offer proves it arrived, so the same recipient can no longer reopen its parent.
            if (!prior.started.has(peerId) && !consumeRetryGrant(prior, peerId)) return deny()
            const next = publishOffer(prior, [peerId], attemptId, null, offerId)
            if (next.peers) {
                // P7c: `previousPeerId` is the peer ID of the paused row before the restart of the receiver.
                events.emit('file-retried', { offerId: attemptId, retryOf: offerId, peerId, direction: 'send',
                    name: next.name, size: next.size, ...(moved && !moved.startsWith('device:') ? { previousPeerId: moved } : {}) })
            }
        } catch {
            deny()
        } finally {
            retry.checking = false
            if (!ownOffers.has(attemptId) && prior.retries.get(peerId) === retry) prior.retries.delete(peerId)
        }
    }

    function failReceive(offer, reason) {
        if (offer.retry) {
            if (retryable.size >= MAX_RETRYABLE_OFFERS) forgetRetry(retryable.keys().next().value)
            retryable.set(offer.offerId, { ...offer, expiresAt: Date.now() + OFFER_TTL_MS })
        }
        events.emit('file-failed', { offerId: offer.offerId, peerId: offer.peerId, direction: 'receive', reason,
            ...(offer.retry ? { retryable: true } : {}), ...(offer.resumeOf ? { resumeOf: offer.resumeOf } : {}) })
    }

    function finishRetry(offerId, reason, canRetry) {
        const retry = retryRequests.get(offerId)
        if (!retry) return
        clearTimeout(retry.timer)
        retryRequests.delete(offerId)
        if (!canRetry) retryable.delete(offerId)
        if (reason) events.emit('file-failed', { offerId, peerId: retry.peerId, direction: 'receive', reason, retryable: canRetry })
    }

    function forgetRetry(offerId) {
        const offer = retryable.get(offerId)
        if (!offer) return
        finishRetry(offerId, null, false)
        retryable.delete(offerId)
        events.emit('file-failed', { offerId, peerId: offer.peerId, direction: 'receive', reason: 'retry expired', retryable: false })
    }

    function retryFile(offerId, resume = false) {
        const offer = retryable.get(offerId)
        if (!offer || offer.expiresAt <= Date.now() || retryRequests.has(offerId) || stopping || !isPeerOpen(offer.peerId)) return false
        const attemptId = randomUUID()
        const timer = setTimeout(() => finishRetry(offerId, 'retry request timed out', true), RETRY_WAIT_MS)
        timer.unref?.()
        retryRequests.set(offerId, { attemptId, timer, peerId: offer.peerId, resume })
        if (sendLine(offer.peerId, { type: 'file-retry', offerId, attemptId })) return true
        finishRetry(offerId, null, true)
        return false
    }

    // The sender side of one data stream.
    async function serve(t) {
        const { stream, peerId } = t
        const openTimer = setTimeout(() => abortStream(stream, 'File request timed out'), fileOpenTimeout)
        openTimer.unref?.()
        let request
        try { request = await readRequest(stream) }
        finally {
            clearTimeout(openTimer)
            requests.delete(t)
        }
        const offerId = request?.offerId
        const offer = ownOffers.get(offerId)
        // Only a 1.1.0 stream can ask for an offset. The partial hash is necessary with each offset above 0.
        const resumable = stream.protocol === FILE_RESUME_PROTOCOL
        const asked = resumable ? request?.offset ?? 0 : 0
        const validAsk = Number.isSafeInteger(asked) && asked >= 0 && asked <= (offer?.size ?? 0) &&
            (asked === 0 || (typeof request.prefix === 'string' && SHA_RE.test(request.prefix)))
        if (stopping || !isPeerOpen(peerId) || !offer || offer.expiresAt <= Date.now() || !offer.targets.has(peerId) ||
            offer.started.has(peerId) || !validAsk || !consumeRetryGrant(offer, peerId)) {
            abortStream(stream, 'File request refused')
            return
        }
        if (!canStart(peerId)) {
            offer.targets.delete(peerId)
            markFailedOffer(offer, peerId)
            abortStream(stream, 'Too many active file transfers')
            events.emit('file-failed', { offerId, peerId, direction: 'send', reason: 'too many active file transfers' })
            return
        }
        offer.started.add(peerId)
        const key = `send|${offerId}|${peerId}`
        t.offerId = offerId
        t.device = deviceOf(peerId)
        // Register before sending any bytes. A fast receiver can confirm before our close() returns.
        if (request.ack === 1) t.receipt = Promise.withResolvers()
        if (t.receipt && request.flow === 1) t.window = sendWindow(fileAckTimeout)
        active.set(key, t)
        const idle = idleDeadline(t)
        t.totalBytes = offer.size
        t.offeredBytes = 0
        t.offset = 0
        const p = progress(offerId, peerId, 'send', offer.size, n => {
            t.offeredBytes += n
            if (!t.idleExpired) idle.refresh()
        }, () => t.offset)
        let original
        try {
            // The peer can accept long after the offer was prepared. Bind reads to the checked handle
            // and the offered extent, even if the path is replaced or the file grows during the send.
            original = await fsp.open(offer.filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
            if (!matchesOriginal(await original.stat(), offer)) {
                if (resumable) await stream.sink([Buffer.from(JSON.stringify({ error: 'changed' }) + '\n')]).catch(() => {})
                throw new TransferFailure('original file changed')
            }
            if (t.selfCancel || stopping) throw new Error('cancelled')
            if (asked > 0 && (await hashPrefix(original, asked))?.digest('hex') === request.prefix) t.offset = asked
            t.totalBytes = offer.size - t.offset
            if (t.selfCancel || stopping) throw new Error('cancelled')
            if (t.offset) events.emit('file-resumed', { offerId, peerId, direction: 'send', offset: t.offset, size: offer.size })
            const readStream = t.offset < offer.size ? original.createReadStream({ highWaterMark: CHUNK_SIZE,
                start: t.offset, end: offer.size - 1 }) : null
            t.readStream = readStream
            const chunks = fileChunks(readStream, t.window, p)
            // A 1.1.0 sender puts the accepted offset in one line before the file bytes: the asked offset, or 0.
            await stream.sink(resumable ? (async function* () {
                yield Buffer.from(JSON.stringify({ offset: t.offset }) + '\n')
                yield* chunks
            })() : chunks)
            if (p.bytes !== t.totalBytes) throw new TransferFailure('original file changed')
            if (stream.status === 'reset' || stream.status === 'aborted') throw new TransferFailure('stream ended')
            await stream.close()
            clearTimeout(idle)
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
            events.emit('file-done', { offerId, peerId, direction: 'send', name: offer.name, size: offer.size, confirmed: !!t.receipt,
                ...(t.offset ? { offset: t.offset, sent: t.offeredBytes } : {}) })
        } catch (err) {
            t.readStream?.destroy()
            abortStream(stream, 'Transfer ended')
            // Keep the transfer in `active` during the wait. The stream abort of a receiver cancel can come before
            // its file-cancel line. handleControl must find the transfer to note the cancel.
            if (t.selfCancel || stopping) {
                active.delete(key)
                cancelSignals.delete(`${offerId}|${peerId}`)
                events.emit('file-cancelled', { offerId, peerId, direction: 'send', by: 'self' })
            } else if ((t.signal = await peerCancelled(`${offerId}|${peerId}`)) === 'cancel') {
                active.delete(key)
                events.emit('file-cancelled', { offerId, peerId, direction: 'send', by: 'peer' })
            } else if (t.signal === 'pause' && !t.selfCancel && !stopping) {
                // The receiver keeps its partial. The leg stays open to a retry, thus a Resume can continue it.
                active.delete(key)
                if (offer.targets.has(peerId)) markFailedOffer(offer, peerId, { pause: true, device: t.device })
                events.emit('file-paused', { offerId, peerId, direction: 'send', bytes: t.offset + t.offeredBytes, size: offer.size })
            } else if (t.selfCancel || stopping) {
                active.delete(key)
                events.emit('file-cancelled', { offerId, peerId, direction: 'send', by: 'self' })
            } else {
                active.delete(key)
                // P7c: the receiver keeps its part after a failed resume (P7a-6), thus the grant stays as for a pause.
                if (offer.targets.has(peerId)) markFailedOffer(offer, peerId, resumable ? { pause: true, device: t.device } : {})
                events.emit('file-failed', { offerId, peerId, direction: 'send', reason: t.idleExpired ? 'transfer stalled' : shortReason(err) })
            }
        } finally {
            clearTimeout(idle)
            await original?.close().catch(() => {})
        }
    }

    function shortReason(err) {
        if (err instanceof TransferFailure) return err.message
        if (err?.code === 'ENOSPC' || err?.code === 'EDQUOT') return 'not enough disk space'
        return 'stream ended'
    }

    async function checkDownloadSpace() {
        let available
        try {
            const fs = await fsp.statfs(downloadDir, { bigint: true })
            if (fs.bavail >= 0n && fs.bsize > 0n) available = fs.bavail * fs.bsize
        } catch { return } // Some network volumes do not report statfs information.
        if (available === undefined) return
        let reserved = STORAGE_RESERVE
        for (const transfer of active.values()) reserved += transfer.remaining ?? 0n
        if (available < reserved) throw new TransferFailure('not enough disk space')
    }

    // The receiver side of one accepted offer. With a paused partial of the same content, it asks the sender
    // for the remainder (1.1.0). A full SHA-256 check of the output comes before the file is final.
    async function receive(offer, t) {
        const { offerId, peerId } = offer
        let temp = path.join(scratchDir, `.asscrack-${offerId}.part`)
        let fh = null
        let tempCreated = false
        let idle
        // The claimed partial, its length before this stream, and the write position.
        let claimed = null
        let base = 0
        let position = 0
        let hash = createHash('sha256')
        const p = progress(offerId, peerId, 'receive', offer.size, n => {
            t.remaining -= BigInt(n)
            if (!t.idleExpired) idle.refresh()
        }, () => base)
        const halted = () => t.selfCancel || t.peerCancel || t.pause || stopping
        const linked = offer.resumeOf ? { resumeOf: offer.resumeOf } : {}
        async function restart(reason) {
            await fh.truncate(0)
            base = position = 0
            hash = createHash('sha256')
            t.remaining = BigInt(offer.size)
            events.emit('file-restarted', { offerId, peerId, direction: 'receive', reason, ...linked })
        }
        try {
            claimed = store && offer.size > 0 ? await store.claim(offer.sha256, offer.size) : null
            // P7c: a receive that uses a kept part keeps it at a node stop. stop() then tells the sender "pause".
            t.keepsPart = !!claimed
            if (claimed) {
                try {
                    fh = await fsp.open(claimed.path, 'r+')
                    const stat = await fh.stat()
                    if (!stat.isFile()) throw new Error('not a file')
                    base = stat.size <= offer.size ? stat.size : 0
                    if (base !== stat.size) await fh.truncate(0)
                    const prefix = await hashPrefix(fh, base)
                    if (prefix) hash = prefix
                    else {
                        await fh.truncate(0)
                        base = 0
                    }
                    temp = claimed.path
                    tempCreated = true
                } catch {
                    await fh?.close().catch(() => {})
                    fh = null
                    await store.drop(claimed.key, 'unreadable')
                    claimed = null
                    base = 0
                    hash = createHash('sha256')
                }
            }
            position = base
            t.remaining = BigInt(offer.size - base)
            await checkDownloadSpace()
            const connection = libp2p.getConnections().find(c => c.remotePeer.toString() === peerId && c.status === 'open')
            if (!connection) throw new TransferFailure('peer left')
            if (!fh) {
                fh = await fsp.open(temp, 'wx', 0o600)
                tempCreated = true
            }
            if (halted()) throw new Error('cancelled')
            if (t.disconnected) throw new TransferFailure('peer left')
            // Ask for 1.1.0 only to continue a partial. A fresh receive uses 1.0.0 as before.
            const stream = await connection.newStream(base > 0 ? [FILE_RESUME_PROTOCOL, FILE_PROTOCOL] : FILE_PROTOCOL, {
                runOnTransientConnection: true, signal: AbortSignal.timeout(fileOpenTimeout)
            })
            t.stream = stream
            if (halted()) {
                abortStream(stream, 'Transfer cancelled')
                throw new Error('cancelled')
            }
            if (t.disconnected) throw new TransferFailure('peer left')
            idle = idleDeadline(t)
            const resumable = base > 0 && stream.protocol === FILE_RESUME_PROTOCOL
            // 0.6.0 and 0.7.0 senders read only offerId in this header and ignore unknown chat control types.
            const header = { offerId, ack: 1 }
            if (offer.flow) header.flow = 1
            if (resumable) Object.assign(header, { offset: base, prefix: hash.copy().digest('hex') })
            stream.sink([Buffer.from(JSON.stringify(header) + '\n')]).catch(() => {})
            let source = stream.source
            if (resumable) {
                const it = stream.source[Symbol.asyncIterator]()
                const answer = await readReply(it)
                if (!answer) throw new TransferFailure('incomplete')
                if (answer.reply.error === 'changed') {
                    t.discard = 'changed'
                    throw new TransferFailure('the source file changed')
                }
                if (answer.reply.offset !== 0 && answer.reply.offset !== base) {
                    abortStream(stream, 'Bad resume reply')
                    throw new TransferFailure('bad resume reply')
                }
                if (answer.reply.offset === 0) await restart('the partial did not agree with the source')
                else events.emit('file-resumed', { offerId, peerId, direction: 'receive', offset: base, size: offer.size, ...linked })
                source = joinSource(answer.rest, it)
            } else if (base > 0) await restart('the sender cannot continue from an offset')
            else if (claimed || offer.resumeOf) {
                events.emit('file-restarted', { offerId, peerId, direction: 'receive', reason: 'no partial bytes', ...linked })
            }
            let lastWritten = 0, lastUpdate = Date.now()
            for await (const chunk of source) {
                // An aborted stream can still give its buffered chunks. Pause and Cancel stop the writes at once.
                if (halted()) throw new Error('cancelled')
                if (position + chunk.byteLength > offer.size) {
                    abortStream(stream, 'Too many bytes')
                    throw new TransferFailure('too many bytes')
                }
                for (const data of chunk instanceof Uint8Array ? [chunk] : chunk) {
                    hash.update(data)
                    await writeAll(fh, data, position)
                    position += data.byteLength
                    p.add(data.byteLength)
                }
                // The sender counts the bytes of this stream, thus the written count excludes the offset.
                if (offer.flow && (p.bytes - lastWritten >= WRITE_UPDATE || Date.now() - lastUpdate >= WRITE_UPDATE_MS)) {
                    sendLine(peerId, { type: 'file-written', offerId, bytes: p.bytes })
                    lastWritten = p.bytes
                    lastUpdate = Date.now()
                }
            }
            clearTimeout(idle)
            if (halted()) throw new Error('cancelled')
            if (t.disconnected) throw new TransferFailure('peer left')
            if (t.idleExpired) throw new TransferFailure('transfer stalled')
            if (position !== offer.size) throw new TransferFailure('incomplete')
            if (hash.digest('hex') !== offer.sha256) {
                t.discard = 'hash mismatch'
                throw new TransferFailure('hash mismatch')
            }
            await fh.close()
            fh = null
            if (halted()) throw new Error('cancelled')
            if (t.disconnected) throw new TransferFailure('peer left')
            // Once publishing starts, cancellation can no longer recall a verified saved file.
            t.finalizing = true
            const finalPath = await moveToFreeName(temp, downloadDir, offer.name)
            tempCreated = false
            if (claimed) await store.finish(claimed.key)
            claimed = null
            sendLine(peerId, { type: 'file-received', offerId })
            active.delete(t.key)
            received.delete(offerId)
            cancelSignals.delete(`${offerId}|${peerId}`)
            p.end()
            events.emit('file-done', { offerId, peerId, direction: 'receive', name: offer.name, size: offer.size, path: finalPath,
                ...(offer.attachmentId ? { attachmentId: offer.attachmentId, sha256: offer.sha256 } : {}),
                ...(base ? { offset: base } : {}), ...linked })
        } catch (err) {
            clearTimeout(idle)
            abortStream(t.stream, 'Transfer ended')
            if (fh) await fh.close().catch(() => {})
            const signalKey = `${offerId}|${peerId}`
            if (t.pause && !t.selfCancel && !stopping) return paused(offer, t, { claimed, temp, tempCreated, position })
            // Keep the transfer in `active` and the offer in `received` during the wait. The stream abort of a sender
            // cancel can come before its file-cancel line. handleControl must find them to note the cancel.
            let cancelled
            if (t.selfCancel || stopping) cancelled = 'self'
            else if ((!(err instanceof TransferFailure) || err.message === 'incomplete') && await peerCancelled(signalKey)) {
                cancelled = 'peer'
            } else if (t.selfCancel || stopping) cancelled = 'self'
            if (claimed) {
                // A partial that the user paused stays after a failure of its resume. Cancel and bad bytes delete it.
                if ((cancelled === 'self' && !stopping) || t.discard) await store.drop(claimed.key, t.discard ?? 'cancelled')
                else await store.release(claimed.key, { bytes: position, offerId, source: sourceOf(offer) }).catch(() => {})
            } else if (tempCreated) await fsp.unlink(temp).catch(() => {})
            cancelSignals.delete(signalKey)
            active.delete(t.key)
            received.delete(offerId)
            if (cancelled) events.emit('file-cancelled', { offerId, peerId, direction: 'receive', by: cancelled, ...linked })
            else {
                sendLine(peerId, { type: 'file-receive-failed', offerId })
                failReceive(offer, t.disconnected ? 'peer left' : t.idleExpired ? 'transfer stalled' : shortReason(err))
            }
        }
    }

    // The end of a receive that the user paused. The partial goes to the store. A partial over the budget is
    // deleted, and the receive then fails as before.
    async function paused(offer, t, { claimed, temp, tempCreated, position }) {
        const { offerId, peerId } = offer
        let kept = position === 0
        try {
            const source = sourceOf(offer)
            if (claimed) kept = await store.release(claimed.key, { bytes: position, offerId, source })
            else if (tempCreated && position > 0) {
                kept = await store.adopt(temp, { sha256: offer.sha256, size: offer.size, name: offer.name, offerId, bytes: position,
                    source: source ?? null })
            }
        } catch { kept = false }
        if (claimed && !kept) await store.drop(claimed.key, 'budget')
        if (!claimed && tempCreated && !(kept && position > 0)) await fsp.unlink(temp).catch(() => {})
        cancelSignals.delete(`${offerId}|${peerId}`)
        active.delete(t.key)
        received.delete(offerId)
        if (!kept) return failReceive(offer, 'the paused part is over the storage budget')
        const partial = store.snapshot().find(item => item.key === partialKey(offer.sha256, offer.size))
        if (offer.retry) {
            if (retryable.size >= MAX_RETRYABLE_OFFERS) forgetRetry(retryable.keys().next().value)
            // P7c: the retry of a paused offer lasts as long as its part (the sender keeps its grant as long).
            retryable.set(offerId, { ...offer, paused: true, device: deviceOf(peerId),
                expiresAt: partial?.expiresAt ?? Date.now() + OFFER_TTL_MS })
        }
        events.emit('file-paused', { offerId, peerId, direction: 'receive', bytes: position, size: offer.size,
            key: partialKey(offer.sha256, offer.size), expiresAt: partial?.expiresAt ?? null, resumable: offer.retry,
            ...(offer.resumeOf ? { resumeOf: offer.resumeOf } : {}) })
    }

    function acceptFile(offerId) {
        if (typeof downloadDir !== 'string' || downloadDir === '') throw new Error('No download folder is set')
        const offer = received.get(offerId)
        if (!offer || offer.state !== 'offered' || stopping || offer.expiresAt <= Date.now()) return false
        if (!canStart(offer.peerId)) {
            received.delete(offerId)
            queueMicrotask(() => {
                sendLine(offer.peerId, { type: 'file-receive-failed', offerId })
                failReceive(offer, 'too many active file transfers')
            })
            return true
        }
        offer.state = 'active'
        const t = { direction: 'receive', key: `receive|${offerId}|${offer.peerId}`, offerId, peerId: offer.peerId,
            stream: null, selfCancel: false, remaining: BigInt(offer.size) }
        active.set(t.key, t)
        t.promise = receive(offer, t).catch(() => {})
        return true
    }

    // Pause keeps the bytes of a running receive in the partial store. The sender sees the end of the stream as a
    // failed leg, thus a later Resume can ask it for the same file again.
    function pauseFile(offerId) {
        const offer = received.get(offerId)
        if (!store || !offer || offer.state !== 'active') return false
        const t = active.get(`receive|${offerId}|${offer.peerId}`)
        if (!t || t.finalizing || t.selfCancel || t.peerCancel || t.pause) return false
        t.pause = true
        sendLine(offer.peerId, { type: 'file-pause', offerId })
        abortStream(t.stream, 'Transfer paused')
        return true
    }

    // Resume asks the sender of a paused or failed offer for a new attempt and accepts it at once. The new attempt
    // continues the partial of the same content, if the store has one.
    // P7c: after a restart, the retry state comes from the kept part. When the sender has a new peer ID (a restart
    // of the sender), the node finds it by its device ID.
    function resumeFile(offerId) {
        const offer = retryable.get(offerId) ??
            restoreRetry(store?.snapshot().find(item => item.offerId === offerId && item.resumable && !item.active))
        if (!offer) return false
        if (offer.device && !isPeerOpen(offer.peerId)) {
            const next = openPeers().find(peerId => deviceOf(peerId) === offer.device)
            if (next) offer.peerId = next
        }
        return retryFile(offerId, true)
    }

    async function discardPartial(key) {
        return typeof key === 'string' && !!store && await store.discard(key)
    }

    async function listPartials() {
        return store ? await store.list() : []
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
        if (typeof offerId !== 'string' || stopping || !isPeerOpen(peerId)) return
        if (control.type === 'file-retry') {
            if (allowOfferControl(peerId)) offerRetry(peerId, offerId, control.attemptId).catch(() => {})
        } else if (control.type === 'file-retry-unavailable') {
            const retry = retryRequests.get(offerId)
            if (retry?.peerId === peerId && retry.attemptId === control.attemptId) {
                const offer = retryable.get(offerId)
                if (retry.resume && control.reason === 'changed' && offer) {
                    // The sender cannot give the remainder of this content. The partial is of no more use from it.
                    finishRetry(offerId, 'the source file changed', false)
                    store?.discard(partialKey(offer.sha256, offer.size), 'changed').catch(() => {})
                } else {
                    // P7c: the part stays. Only its retry state goes: a new offer of the same file continues it.
                    if (retry.resume) forgetSource(offer)
                    finishRetry(offerId, 'the sender can no longer offer this file', false)
                }
            }
        } else if (control.type === 'file-offer') {
            const { size, sha256 } = control
            if (!UUID_RE.test(offerId) || received.has(offerId) || ownOffers.has(offerId) || retryable.has(offerId)) return
            if (!Number.isSafeInteger(size) || size < 0 || typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return
            const name = safeFileName(control.name)
            const rich = typeof control.attachmentId === 'string' && UUID_RE.test(control.attachmentId) ? { attachmentId: control.attachmentId, sha256 } : {}
            if (!allowOfferControl(peerId)) return
            if (received.size >= MAX_INCOMING_OFFERS || countForPeer(received.values(), peerId) >= MAX_INCOMING_PER_PEER) {
                const signal = control.retry === 1 && !rich.attachmentId ? 'file-receive-failed' : 'file-refuse'
                sendLine(peerId, { type: signal, offerId, reason: 'capacity' })
                return
            }
            const retryOf = control.retryOf
            let resume = false
            if (retryOf !== undefined) {
                const previous = retryable.get(retryOf)
                if (!previous || previous.peerId !== peerId || previous.name !== name || previous.sha256 !== sha256 ||
                    previous.size !== size || retryRequests.get(retryOf)?.attemptId !== offerId || rich.attachmentId || control.retry !== 1) return
                resume = retryRequests.get(retryOf).resume
                finishRetry(retryOf, null, false)
            }
            received.set(offerId, { offerId, peerId, name, size, sha256, flow: control.flow === 1,
                retry: control.retry === 1 && !rich.attachmentId, ...rich, state: 'offered', expiresAt: Date.now() + OFFER_TTL_MS,
                ...(resume ? { resumeOf: retryOf } : {}) })
            // The user asked for this attempt with Resume. It needs no second accept.
            if (resume) {
                acceptFile(offerId)
                return true
            }
            events.emit('file-offer', { offerId, peerId, from: peerNames()[peerId] ?? '', name, size, ...rich,
                ...(retryOf ? { retryOf } : {}) })
            return true
        } else if (control.type === 'file-pause') {
            const sendT = active.get(`send|${offerId}|${peerId}`)
            if (sendT) {
                noteCancel(`${offerId}|${peerId}`, 'pause')
                interruptTransfer(sendT, 'Transfer paused by receiver')
                return
            }
            // A pause before the stream opened. As for a lost peer, the leg fails and stays open to a retry.
            const own = ownOffers.get(offerId)
            if (own && !own.started.has(peerId) && own.targets.delete(peerId)) {
                markFailedOffer(own, peerId, { pause: true })
                events.emit('file-paused', { offerId, peerId, direction: 'send', bytes: 0, size: own.size })
            }
        } else if (control.type === 'file-written') {
            active.get(`send|${offerId}|${peerId}`)?.window?.written(control.bytes)
        } else if (control.type === 'file-received' || control.type === 'file-receive-failed') {
            const t = active.get(`send|${offerId}|${peerId}`)
            const failed = control.type === 'file-receive-failed'
            const reason = control.reason === 'capacity' ? 'receiver has too many pending offers' : 'receiver could not verify or save file'
            if (t?.receipt) {
                if (failed) t.window?.stop(reason)
                if (failed || t.offeredBytes === t.totalBytes) t.receipt.resolve(failed ? reason : null)
            }
            else if (failed) {
                // A disk error can occur before the receiver opens the data stream.
                const offer = ownOffers.get(offerId)
                if (offer && !offer.started.has(peerId) && offer.targets.delete(peerId)) {
                    markFailedOffer(offer, peerId)
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
        for (const request of requests) if (request.peerId === peerId) abortStream(request.stream, 'peer left')
        for (const t of active.values()) {
            if (t.peerId !== peerId || t.finalizing) continue
            if (t.direction === 'receive') {
                t.disconnected = true
                interruptTransfer(t, 'peer left')
            } else interruptTransfer(t, 'peer left before confirming delivery')
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
                markFailedOffer(own, peerId)
                events.emit('file-failed', { offerId: own.offerId, peerId, direction: 'send', reason: 'peer left' })
            }
        }
    }

    function handleStream({ stream, connection }) {
        const peerId = connection.remotePeer.toString()
        if (stopping || !isPeerOpen(peerId) || requests.size >= MAX_OPEN_REQUESTS ||
            countForPeer(requests, peerId) >= MAX_REQUESTS_PER_PEER) {
            abortStream(stream, 'File request not admitted')
            return
        }
        const t = { direction: 'send', peerId, stream, selfCancel: false }
        requests.add(t)
        t.promise = serve(t).catch(() => abortStream(stream, 'Transfer ended'))
    }

    async function stop() {
        stopping = true
        clearInterval(expiryTimer)
        preparation.abort()
        for (const offerId of retryRequests.keys()) finishRetry(offerId)
        const waits = []
        for (const request of requests) {
            abortStream(request.stream, 'Node stopped')
            waits.push(request.promise)
        }
        for (const t of active.values()) {
            if (!t.finalizing) {
                // P7c: the part of a resumed receive stays (P7a). The sender keeps its grant as for a Pause.
                const type = t.direction === 'receive' && t.keepsPart ? 'file-pause' : 'file-cancel'
                sendLine(t.peerId, { type, offerId: t.offerId })
                interruptTransfer(t, 'Node stopped')
            }
            if (t.promise) waits.push(t.promise)
        }
        await Promise.allSettled(waits)
    }

    return { prepareFile, publishOffer, offerAttachmentTo, expireAttachment, forgetOffer: id => ownOffers.delete(id), unchanged, offerFile, acceptFile,
        retryFile: offerId => retryFile(offerId), pauseFile, resumeFile, discardPartial, listPartials,
        refuseFile, cancelFile, handleControl, peerLeft, handleStream, stop }
}
