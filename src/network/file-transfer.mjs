import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { roomRateLimit } from './room-rate-limit.mjs'
import { createPartialStore, partialKey, PARTIAL_TTL_MS } from './partial-store.mjs'
import { createGrantStore, GRANT_LIMIT } from './send-grants.mjs'
import { SWARM_DEFAULTS, createFileSwarm, pieceCount, pieceRange } from './file-swarm.mjs'
import { markFromInternet } from './zone-mark.mjs'
import { noFormatCharacters } from './text-safety.mjs'

export const FILE_PROTOCOL = '/asscrack/file/1.0.0'
// Version 1.1.0 adds the offset negotiation for a paused partial. The receiver asks for 1.1.0 only when it has a
// partial to continue. A sender with only 1.0.0 then sends the full file from byte 0.
export const FILE_RESUME_PROTOCOL = '/asscrack/file/1.1.0'
export const FILE_PROTOCOLS = [FILE_PROTOCOL, FILE_RESUME_PROTOCOL]
export const FILE_SWARM_PROTOCOL = '/asscrack/file-swarm/1.0.0'

const CHUNK_SIZE = 65536
// Flow version 1 bounds payload handed to the mux ahead of completed receiver writes. Its progress
// controls are cumulative, per offer and authenticated session. A final receipt still requires SHA-256.
const WRITE_WINDOW = 8 * 1024 * 1024
const WRITE_UPDATE = WRITE_WINDOW / 4
const WRITE_UPDATE_MS = 1000
const REQUEST_LIMIT = 1024
const REPLY_LIMIT = 256
const SWARM_REPLY_LIMIT = 4096
const SWARM_MANIFEST_LIMIT = 5 * 1024 * 1024
const SWARM_TICK_MS = 1000
const SWARM_NO_PEER_TIMEOUT_MS = 5000
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
    // L2: no format characters (bidi controls, zero width characters) in a saved or a shown file name.
    let n = noFormatCharacters(name).split(/[\\/]/).pop()
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
async function readReply(it, limit = REPLY_LIMIT) {
    const header = Buffer.allocUnsafe(Math.min(limit, 65536))
    const chunks = []
    let used = 0
    for (;;) {
        const { value, done } = await it.next()
        if (done) return null
        const parts = value instanceof Uint8Array ? [value] : [...value]
        for (let i = 0; i < parts.length; i++) {
            const bytes = Buffer.from(parts[i].buffer, parts[i].byteOffset, parts[i].byteLength)
            const lf = bytes.indexOf(10)
            const size = lf < 0 ? bytes.length : lf
            if (used + size > limit) return null
            if (used + size <= header.length && chunks.length === 0) {
                bytes.copy(header, used, 0, size)
            } else {
                if (chunks.length === 0 && used > 0) chunks.push(header.subarray(0, used))
                chunks.push(bytes.subarray(0, size))
            }
            used += size
            if (lf < 0) continue
            let reply
            try {
                const text = chunks.length === 0
                    ? header.toString('utf8', 0, used)
                    : Buffer.concat(chunks, used).toString('utf8')
                reply = JSON.parse(text)
            } catch { return null }
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

async function readAt(fh, length, position) {
    const buf = Buffer.allocUnsafe(length)
    let done = 0
    while (done < length) {
        const { bytesRead } = await fh.read(buf, done, length - done, position + done)
        if (!bytesRead) throw new TransferFailure('incomplete')
        done += bytesRead
    }
    return buf
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
export function createFileTransfer({ libp2p, selfId = null, events, sendTo, openPeers, isPeerOpen = peerId => openPeers().includes(peerId),
    peerNames, downloadDir, scratchDir = downloadDir, fileAckTimeout = 30000, fileOpenTimeout = OPEN_TIMEOUT_MS,
    fileIdleTimeout = DATA_IDLE_MS, partials = {}, peerDevice = () => null,
    fileSwarm = true, fileSwarmOptions = {}, isSwarmCapable = () => false }) {
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
    const swarms = new Map()
    const swarmPieceSize = Number.isSafeInteger(fileSwarmOptions?.pieceSize) && fileSwarmOptions.pieceSize > 0
        ? fileSwarmOptions.pieceSize : SWARM_DEFAULTS.pieceSize
    let swarmSeedingEnabled = fileSwarmOptions?.seedingEnabled !== false
    let swarmSeedCap = Number.isSafeInteger(fileSwarmOptions?.seedCap) && fileSwarmOptions.seedCap >= 0
        ? Math.min(fileSwarmOptions.seedCap, SWARM_DEFAULTS.maxSeedCap) : SWARM_DEFAULTS.defaultSeedCap
    const swarmTickMs = Number.isSafeInteger(fileSwarmOptions?.tickMs) && fileSwarmOptions.tickMs > 0
        ? fileSwarmOptions.tickMs : SWARM_TICK_MS
    const swarmNoPeerTimeoutMs = Number.isSafeInteger(fileSwarmOptions?.noPeerTimeoutMs) && fileSwarmOptions.noPeerTimeoutMs > 0
        ? fileSwarmOptions.noPeerTimeoutMs : SWARM_NO_PEER_TIMEOUT_MS
    const swarmNow = typeof fileSwarmOptions?.now === 'function' ? fileSwarmOptions.now : Date.now
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
            const trackPieces = Boolean(fileSwarm && pieceCount(prepared.size, swarmPieceSize) <= SWARM_DEFAULTS.maxPieces)
            const pieceHashes = trackPieces ? [] : null
            let pieceHash = trackPieces && prepared.size > 0 ? createHash('sha256') : null
            let pieceRem = swarmPieceSize
            if (prepared.size) {
                const input = original.createReadStream({ highWaterMark: CHUNK_SIZE, end: prepared.size - 1,
                    autoClose: false, signal: preparation.signal })
                for await (const chunk of input) {
                    hash.update(chunk)
                    if (pieceHashes) {
                        let offset = 0
                        while (offset < chunk.length) {
                            const take = Math.min(pieceRem, chunk.length - offset)
                            pieceHash.update(chunk.subarray(offset, offset + take))
                            offset += take
                            pieceRem -= take
                            if (pieceRem === 0) {
                                pieceHashes.push(pieceHash.digest('hex'))
                                pieceHash = createHash('sha256')
                                pieceRem = swarmPieceSize
                            }
                        }
                    }
                }
                if (pieceHashes && pieceRem < swarmPieceSize) {
                    pieceHashes.push(pieceHash.digest('hex'))
                }
            }
            if (stopping || !matchesOriginal(await original.stat(), prepared) || !await unchanged(prepared)) {
                throw new Error('File changed during preparation')
            }
            return { ...prepared, sha256: hash.digest('hex'),
                ...(pieceHashes ? { pieceSize: swarmPieceSize, pieceHashes } : {}) }
        } finally {
            await original?.close().catch(() => {})
            preparing--
        }
    }

    function registerSwarmSeed(prepared, { roomWide = true, authorizedPeers = [] } = {}) {
        if (!fileSwarm || !prepared || !Array.isArray(prepared.pieceHashes) || prepared.pieceHashes.length <= 1) return null
        const pSize = prepared.pieceSize ?? swarmPieceSize
        const existing = swarms.get(prepared.sha256)
        if (existing) {
            if (roomWide) existing.roomWide = true
            for (const p of authorizedPeers) existing.authorizedPeers.add(p)
            if (existing.role === 'seed') {
                if (typeof prepared.filePath === 'string') existing.filePath = prepared.filePath
                if (prepared.dev !== undefined) existing.originalMeta = prepared
            }
            return existing
        }
        const haveAll = Array.from({ length: prepared.pieceHashes.length }, (_, i) => i)
        const swarm = createFileSwarm({
            sha256: prepared.sha256,
            size: prepared.size,
            pieceSize: pSize,
            pieceHashes: prepared.pieceHashes,
            selfPeerId: selfId,
            now: swarmNow,
            seedCap: swarmSeedCap,
            seedingEnabled: swarmSeedingEnabled,
            have: haveAll
        })
        const entry = {
            role: 'seed',
            sha256: prepared.sha256,
            size: prepared.size,
            pieceSize: pSize,
            pieceHashes: prepared.pieceHashes,
            filePath: prepared.filePath,
            originalMeta: prepared.dev !== undefined ? prepared : null,
            fh: null,
            roomWide: Boolean(roomWide),
            authorizedPeers: new Set(authorizedPeers),
            uploadedTo: new Map(),
            downloadedFrom: new Map(),
            swarm
        }
        swarms.set(prepared.sha256, entry)
        return entry
    }

    function unregisterSwarmSeed(sha256) {
        const entry = swarms.get(sha256)
        if (!entry || entry.role !== 'seed') return false
        swarms.delete(sha256)
        return true
    }

    function setSwarmSeeding(enabled) {
        swarmSeedingEnabled = Boolean(enabled)
        for (const entry of swarms.values()) entry.swarm.setSeedingEnabled(swarmSeedingEnabled)
    }

    function setSwarmSeedCap(cap) {
        const next = Number.isSafeInteger(cap) && cap >= 0 ? Math.min(cap, SWARM_DEFAULTS.maxSeedCap) : SWARM_DEFAULTS.defaultSeedCap
        swarmSeedCap = next
        for (const entry of swarms.values()) entry.swarm.setSeedCap(next)
    }

    function swarmStatus() {
        return [...swarms.values()].map(entry => ({
            sha256: entry.sha256,
            role: entry.role,
            size: entry.size,
            pieceSize: entry.pieceSize,
            uploadedTo: Object.fromEntries(entry.uploadedTo),
            downloadedFrom: Object.fromEntries(entry.downloadedFrom),
            ...entry.swarm.progress()
        }))
    }

    function publishOffer(prepared, recipients, offerId = randomUUID(), attachmentId = null, retryOf = null, options = {}) {
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
        const useSwarm = Boolean(options?.swarm === true && fileSwarm && Array.isArray(prepared.pieceHashes) && prepared.pieceHashes.length > 1)
        const offer = { ...prepared, offerId, attachmentId, retryOf, targets: new Set(), started: new Set(),
            failed: new Set(), failedUntil: new Map(), paused: new Map(), retries: new Map(), retryClaimed: false,
            swarm: useSwarm, pieceSize: useSwarm ? prepared.pieceSize : null,
            expiresAt: Date.now() + OFFER_TTL_MS }
        const line = { type: 'file-offer', offerId, name, size, sha256, flow: 1 }
        if (attachmentId) line.attachmentId = attachmentId
        else line.retry = 1
        if (retryOf) line.retryOf = retryOf
        if (useSwarm) {
            line.swarm = 1
            line.pieceSize = prepared.pieceSize
        }
        for (const peerId of recipients) if (sendLine(peerId, line)) offer.targets.add(peerId)
        if (offer.targets.size) {
            ownOffers.set(offerId, offer)
            if (useSwarm) {
                registerSwarmSeed(prepared, {
                    roomWide: Boolean(attachmentId) || recipients.length > 1,
                    authorizedPeers: [...offer.targets]
                })
            }
        }
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

    async function offerFile(filePath, recipientId, options = {}) {
        const targeted = recipientId !== undefined
        if (targeted && !openPeers().includes(recipientId)) throw new Error('The selected recipient is not connected')
        const prepared = await prepareFile(filePath)
        const offer = publishOffer(prepared, targeted ? [recipientId] : openPeers(), randomUUID(), null, null, options)
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
            // M3: mark the file as a file from the internet before it gets its final name.
            await markFromInternet(temp)
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

    function openPeerConnection(peerId) {
        return libp2p?.getConnections().find(c => c.remotePeer.toString() === peerId && c.status === 'open') ?? null
    }

    async function readSwarmManifest(peerId, sha256, size, pieceSize, signal) {
        const connection = openPeerConnection(peerId)
        if (!connection) throw new TransferFailure('peer left')
        const stream = await connection.newStream(FILE_SWARM_PROTOCOL, {
            runOnTransientConnection: true,
            signal: AbortSignal.any([signal, AbortSignal.timeout(fileOpenTimeout)])
        })
        try {
            await stream.sink([Buffer.from(JSON.stringify({ op: 'manifest', sha256 }) + '\n')])
            const it = stream.source[Symbol.asyncIterator]()
            const answer = await readReply(it, SWARM_MANIFEST_LIMIT)
            if (!answer) throw new TransferFailure('incomplete')
            const { reply } = answer
            if (!reply.ok) throw new TransferFailure(reply.reason === 'changed' ? 'the source file changed' : 'manifest refused')
            const count = pieceCount(size, pieceSize)
            if (reply.sha256 !== sha256 || reply.size !== size || reply.pieceSize !== pieceSize ||
                !Array.isArray(reply.pieceHashes) || reply.pieceHashes.length !== count ||
                typeof reply.bitfield !== 'string') {
                throw new TransferFailure('invalid swarm manifest')
            }
            return {
                pieceHashes: reply.pieceHashes,
                bitfield: new Uint8Array(Buffer.from(reply.bitfield, 'base64'))
            }
        } catch (err) {
            abortStream(stream, 'Swarm manifest ended')
            throw err
        }
    }

    async function fetchSwarmPiece(peerId, sha256, index, expectedLength, signal) {
        const connection = openPeerConnection(peerId)
        if (!connection) return { ok: false, reason: 'peer-left' }
        let stream
        try {
            stream = await connection.newStream(FILE_SWARM_PROTOCOL, {
                runOnTransientConnection: true,
                signal: AbortSignal.any([signal, AbortSignal.timeout(fileOpenTimeout)])
            })
            await stream.sink([Buffer.from(JSON.stringify({ op: 'piece', sha256, index }) + '\n')])
            const it = stream.source[Symbol.asyncIterator]()
            const answer = await readReply(it, SWARM_REPLY_LIMIT)
            if (!answer) return { ok: false, reason: 'incomplete' }
            const { reply, rest } = answer
            if (!reply.ok) return { ok: false, reason: reply.reason ?? 'refused' }
            if (reply.index !== index || reply.length !== expectedLength) {
                abortStream(stream, 'Bad piece header')
                return { ok: false, reason: 'bad-header' }
            }
            const chunks = []
            let total = 0
            for (const part of rest) {
                if (total + part.byteLength > expectedLength) {
                    abortStream(stream, 'Oversize piece')
                    return { ok: false, reason: 'oversize' }
                }
                chunks.push(part)
                total += part.byteLength
            }
            if (total < expectedLength) {
                for await (const chunk of joinSource([], it)) {
                    if (signal.aborted) throw new Error('cancelled')
                    for (const part of chunk instanceof Uint8Array ? [chunk] : chunk) {
                        if (total + part.byteLength > expectedLength) {
                            abortStream(stream, 'Oversize piece')
                            return { ok: false, reason: 'oversize' }
                        }
                        chunks.push(part)
                        total += part.byteLength
                    }
                    if (total === expectedLength) break
                }
            }
            if (total !== expectedLength) return { ok: false, reason: 'incomplete' }
            const data = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)
            return { ok: true, data }
        } catch {
            abortStream(stream, 'Swarm piece ended')
            return { ok: false, reason: 'stream-error' }
        }
    }

    async function receiveSwarm(offer, t) {
        const { offerId, peerId, sha256, size, pieceSize } = offer
        const temp = path.join(scratchDir, `.asscrack-${offerId}.part`)
        let fh = null
        let tempCreated = false
        let entry = null
        let tickTimer = null
        const abortCtrl = new AbortController()
        t.abort = () => abortCtrl.abort()
        const halted = () => t.selfCancel || t.peerCancel || t.pause || stopping
        const inFlightTasks = new Set()
        const seederBytes = new Map()
        let receivedBytes = 0
        let lastProgressAt = 0

        function emitSwarmProgress(force = false) {
            const now = Date.now()
            if (force || now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                lastProgressAt = now
                const seeders = entry
                    ? entry.swarm.progress().peers.filter(p => !p.banned && (p.haveCount > 0 || p.inFlight > 0)).map(p => p.peerId)
                    : []
                events.emit('file-progress', {
                    offerId,
                    peerId,
                    direction: 'receive',
                    bytes: receivedBytes,
                    size,
                    swarmed: true,
                    seeders,
                    seederBytes: Object.fromEntries(seederBytes)
                })
            }
        }

        try {
            await checkDownloadSpace()
            const manifest = await readSwarmManifest(peerId, sha256, size, pieceSize, abortCtrl.signal)
            if (halted()) throw new Error('cancelled')

            fh = await fsp.open(temp, 'wx+', 0o600)
            tempCreated = true

            const swarm = createFileSwarm({
                sha256,
                size,
                pieceSize,
                pieceHashes: manifest.pieceHashes,
                selfPeerId: selfId,
                now: swarmNow,
                seedCap: swarmSeedCap,
                seedingEnabled: swarmSeedingEnabled
            })
            swarm.setPeerHave(peerId, manifest.bitfield)

            const done = Promise.withResolvers()
            let pumping = false
            let pumpAgain = false
            let noPeerSince = null

            entry = {
                role: 'leech',
                sha256,
                size,
                pieceSize,
                pieceHashes: manifest.pieceHashes,
                filePath: temp,
                originalMeta: null,
                fh,
                roomWide: true,
                authorizedPeers: new Set(),
                uploadedTo: new Map(),
                downloadedFrom: seederBytes,
                swarm,
                pump: null
            }
            swarms.set(sha256, entry)

            const swarmPeers = () => openPeers().filter(p => p !== selfId && isSwarmCapable(p))
            for (const p of swarmPeers()) {
                if (p !== peerId) sendLine(p, { type: 'file-swarm-query', sha256 })
            }

            async function fetchOne(remotePeerId, index) {
                const range = pieceRange(index, size, pieceSize)
                try {
                    const result = await fetchSwarmPiece(remotePeerId, sha256, index, range.length, abortCtrl.signal)
                    if (halted()) return
                    if (!result.ok) {
                        swarm.releaseRequest(remotePeerId, index)
                        schedulePump()
                        return
                    }
                    const mark = swarm.markReceived(remotePeerId, index, result.data)
                    if (!mark.ok) {
                        events.emit('file-swarm-bad-piece', {
                            offerId,
                            peerId: remotePeerId,
                            sha256,
                            index,
                            badPieces: mark.badPieces ?? 0,
                            banned: mark.banned === true
                        })
                        schedulePump()
                        return
                    }
                    if (!mark.duplicate) {
                        await writeAll(fh, result.data, range.start)
                        receivedBytes += result.data.byteLength
                        t.remaining -= BigInt(result.data.byteLength)
                        seederBytes.set(remotePeerId, (seederBytes.get(remotePeerId) ?? 0) + result.data.byteLength)
                        emitSwarmProgress()
                        for (const p of swarmPeers()) {
                            sendLine(p, { type: 'file-swarm-have', sha256, index })
                        }
                    }
                    if (swarm.complete()) {
                        done.resolve()
                    } else {
                        schedulePump()
                    }
                } catch (err) {
                    swarm.releaseRequest(remotePeerId, index)
                    if (!halted()) schedulePump()
                    else done.reject(err)
                }
            }

            function schedulePump() {
                if (halted() || swarm.complete()) return
                if (pumping) {
                    pumpAgain = true
                    return
                }
                pumping = true
                queueMicrotask(() => {
                    pumping = false
                    if (halted() || swarm.complete()) return
                    pumpAgain = false
                    for (const remotePeerId of swarmPeers()) {
                        const indices = swarm.nextRequests(remotePeerId)
                        for (const index of indices) {
                            const task = fetchOne(remotePeerId, index)
                            inFlightTasks.add(task)
                            task.finally(() => inFlightTasks.delete(task))
                        }
                    }
                    if (pumpAgain) schedulePump()
                })
            }

            entry.pump = schedulePump
            schedulePump()

            tickTimer = setInterval(() => {
                if (halted()) return
                const expired = swarm.expireTimeouts()
                if (expired.length > 0) schedulePump()
                if (swarm.complete()) {
                    done.resolve()
                    return
                }
                const prog = swarm.progress()
                const hasAvailable = prog.availability.some((count, idx) => count > 0 && !swarm.has(idx))
                if (inFlightTasks.size === 0 && !hasAvailable) {
                    noPeerSince ??= Date.now()
                    if (Date.now() - noPeerSince >= swarmNoPeerTimeoutMs) {
                        done.reject(new TransferFailure('no swarm peers have remaining pieces'))
                    }
                } else {
                    noPeerSince = null
                    if (inFlightTasks.size === 0 && hasAvailable) schedulePump()
                }
            }, swarmTickMs)
            tickTimer.unref?.()

            await done.promise
            clearInterval(tickTimer)
            tickTimer = null

            if (halted()) throw new Error('cancelled')
            const fullHash = await hashPrefix(fh, size)
            if (!fullHash || fullHash.digest('hex') !== sha256) {
                throw new TransferFailure('hash mismatch')
            }
            await fh.close()
            fh = null
            if (halted()) throw new Error('cancelled')

            t.finalizing = true
            await markFromInternet(temp)
            const finalPath = await moveToFreeName(temp, downloadDir, offer.name)
            tempCreated = false

            entry.role = 'seed'
            entry.filePath = finalPath
            entry.fh = null
            entry.pump = null

            if (isPeerOpen(peerId)) sendLine(peerId, { type: 'file-received', offerId })
            active.delete(t.key)
            received.delete(offerId)
            cancelSignals.delete(`${offerId}|${peerId}`)
            emitSwarmProgress(true)
            events.emit('file-done', {
                offerId,
                peerId,
                direction: 'receive',
                name: offer.name,
                size,
                path: finalPath,
                ...(offer.attachmentId ? { attachmentId: offer.attachmentId, sha256 } : {}),
                swarmed: true
            })
        } catch (err) {
            clearInterval(tickTimer)
            abortCtrl.abort()
            await Promise.allSettled([...inFlightTasks])
            if (fh) await fh.close().catch(() => {})
            if (entry && swarms.get(sha256) === entry && entry.role === 'leech') {
                swarms.delete(sha256)
            }
            if (tempCreated) await fsp.unlink(temp).catch(() => {})
            const signalKey = `${offerId}|${peerId}`
            let cancelled
            if (t.selfCancel || stopping) cancelled = 'self'
            else if (t.peerCancel || await peerCancelled(signalKey)) cancelled = 'peer'
            cancelSignals.delete(signalKey)
            active.delete(t.key)
            received.delete(offerId)
            if (cancelled) {
                events.emit('file-cancelled', { offerId, peerId, direction: 'receive', by: cancelled })
            } else {
                if (isPeerOpen(peerId)) sendLine(peerId, { type: 'file-receive-failed', offerId })
                failReceive(offer, shortReason(err))
            }
        }
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
        const useSwarm = Boolean(
            fileSwarm &&
            offer.swarm === true &&
            offer.size > 0 &&
            Number.isSafeInteger(offer.pieceSize) &&
            offer.pieceSize > 0 &&
            offer.size > offer.pieceSize &&
            isSwarmCapable(offer.peerId) &&
            !(store && store.has(offer.sha256, offer.size))
        )
        const t = { direction: 'receive', key: `receive|${offerId}|${offer.peerId}`, offerId, peerId: offer.peerId,
            stream: null, selfCancel: false, remaining: BigInt(offer.size), swarm: useSwarm }
        active.set(t.key, t)
        t.promise = (useSwarm ? receiveSwarm(offer, t) : receive(offer, t)).catch(() => {})
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
        t.abort?.()
        abortStream(t.stream, 'Transfer cancelled')
        return true
    }

    function handleControl(peerId, control) {
        if (stopping || !isPeerOpen(peerId)) return
        if (control.type === 'file-swarm-query') {
            if (!fileSwarm || typeof control.sha256 !== 'string' || !SHA_RE.test(control.sha256)) return
            const entry = swarms.get(control.sha256)
            if (!entry || (!entry.roomWide && !entry.authorizedPeers.has(peerId))) return
            if (!entry.swarm.canServe(peerId) || entry.swarm.progress().haveCount === 0) return
            sendLine(peerId, {
                type: 'file-swarm-bitfield',
                sha256: control.sha256,
                bitfield: Buffer.from(entry.swarm.haveBitfield()).toString('base64')
            })
            return
        }
        if (control.type === 'file-swarm-bitfield') {
            if (!fileSwarm || typeof control.sha256 !== 'string' || !SHA_RE.test(control.sha256)) return
            if (typeof control.bitfield !== 'string') return
            const entry = swarms.get(control.sha256)
            if (!entry || entry.role !== 'leech') return
            try {
                const bytes = new Uint8Array(Buffer.from(control.bitfield, 'base64'))
                if (entry.swarm.setPeerHave(peerId, bytes)) entry.pump?.()
            } catch {}
            return
        }
        if (control.type === 'file-swarm-have') {
            if (!fileSwarm || typeof control.sha256 !== 'string' || !SHA_RE.test(control.sha256)) return
            if (!Number.isSafeInteger(control.index) || control.index < 0) return
            const entry = swarms.get(control.sha256)
            if (!entry || entry.role !== 'leech') return
            try {
                if (entry.swarm.addPeerPiece(peerId, control.index)) entry.pump?.()
            } catch {}
            return
        }
        const offerId = control.offerId
        if (typeof offerId !== 'string') return
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
                retry: control.retry === 1 && !rich.attachmentId, ...rich,
                swarm: control.swarm === 1,
                pieceSize: Number.isSafeInteger(control.pieceSize) && control.pieceSize > 0 ? control.pieceSize : null,
                state: 'offered', expiresAt: Date.now() + OFFER_TTL_MS,
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
            else if (!failed) {
                const own = ownOffers.get(offerId)
                if (own && own.swarm && own.targets.delete(peerId)) {
                    events.emit('file-done', { offerId, peerId, direction: 'send', name: own.name, size: own.size, confirmed: true, swarmed: true })
                }
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
                t.abort?.()
                abortStream(t.stream, 'Transfer cancelled by peer')
            }
        }
    }

    function peerLeft(peerId) {
        for (const entry of swarms.values()) {
            if (entry.swarm.removePeer(peerId) && entry.role === 'leech') entry.pump?.()
        }
        for (const request of requests) if (request.peerId === peerId) abortStream(request.stream, 'peer left')
        for (const t of active.values()) {
            if (t.peerId !== peerId || t.finalizing) continue
            if (t.direction === 'receive') {
                if (t.swarm) continue
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

    function noteSwarmSendProgress(sha256, peerId) {
        for (const own of ownOffers.values()) {
            if (own.swarm && own.sha256 === sha256 && own.targets.has(peerId)) {
                events.emit('file-progress', { offerId: own.offerId, peerId, direction: 'send', bytes: 0, size: own.size })
            }
        }
    }

    async function serveSwarm(stream, peerId) {
        const openTimer = setTimeout(() => abortStream(stream, 'Swarm request timed out'), fileOpenTimeout)
        openTimer.unref?.()
        let request
        try { request = await readRequest(stream) }
        finally { clearTimeout(openTimer) }

        const replyError = async reason => {
            try {
                await stream.sink([Buffer.from(JSON.stringify({ ok: false, reason }) + '\n')])
                await stream.close()
            } catch { abortStream(stream, reason) }
        }

        if (stopping || !fileSwarm || !isPeerOpen(peerId) || !request || typeof request !== 'object') {
            abortStream(stream, 'Swarm request refused')
            return
        }
        const { op, sha256 } = request
        if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) {
            await replyError('invalid')
            return
        }
        const entry = swarms.get(sha256)
        if (!entry || (!entry.roomWide && !entry.authorizedPeers.has(peerId))) {
            await replyError('not-found')
            return
        }

        if (op === 'manifest') {
            if (entry.originalMeta && !await unchanged(entry.originalMeta)) {
                await replyError('changed')
                return
            }
            const payload = {
                ok: true,
                sha256: entry.sha256,
                size: entry.size,
                pieceSize: entry.pieceSize,
                pieceHashes: entry.pieceHashes,
                bitfield: Buffer.from(entry.swarm.haveBitfield()).toString('base64')
            }
            await stream.sink([Buffer.from(JSON.stringify(payload) + '\n')])
            await stream.close()
            noteSwarmSendProgress(sha256, peerId)
            return
        }

        if (op === 'piece') {
            const index = request.index
            if (!Number.isSafeInteger(index) || index < 0 || index >= entry.swarm.totalPieces || !entry.swarm.has(index)) {
                await replyError('missing')
                return
            }
            if (!entry.swarm.reserveSeed(peerId)) {
                await replyError('busy')
                return
            }
            let fh = null
            try {
                const { start, length } = pieceRange(index, entry.size, entry.pieceSize)
                let buf
                if (entry.fh) {
                    buf = await readAt(entry.fh, length, start)
                } else {
                    fh = await fsp.open(entry.filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
                    if (entry.originalMeta && !matchesOriginal(await fh.stat(), entry.originalMeta)) {
                        await replyError('changed')
                        return
                    }
                    buf = await readAt(fh, length, start)
                }
                const header = Buffer.from(JSON.stringify({ ok: true, index, length }) + '\n')
                await stream.sink([header, buf])
                await stream.close()
                entry.uploadedTo.set(peerId, (entry.uploadedTo.get(peerId) ?? 0) + length)
                noteSwarmSendProgress(sha256, peerId)
            } finally {
                entry.swarm.releaseSeed(peerId)
                await fh?.close().catch(() => {})
            }
            return
        }

        await replyError('unsupported')
    }

    function handleSwarmStream({ stream, connection }) {
        const peerId = connection.remotePeer.toString()
        if (stopping || !fileSwarm || !isPeerOpen(peerId)) {
            abortStream(stream, 'Swarm request not admitted')
            return
        }
        serveSwarm(stream, peerId).catch(() => abortStream(stream, 'Swarm stream ended'))
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
                t.abort?.()
                interruptTransfer(t, 'Node stopped')
            }
            if (t.promise) waits.push(t.promise)
        }
        await Promise.allSettled(waits)
        swarms.clear()
    }

    return { prepareFile, publishOffer, offerAttachmentTo, expireAttachment, forgetOffer: id => ownOffers.delete(id), unchanged, offerFile, acceptFile,
        retryFile: offerId => retryFile(offerId), pauseFile, resumeFile, discardPartial, listPartials,
        refuseFile, cancelFile, handleControl, peerLeft, handleStream, handleSwarmStream, stop,
        registerSwarmSeed, unregisterSwarmSeed, setSwarmSeeding, setSwarmSeedCap, swarmStatus,
        swarmEnabled: () => Boolean(fileSwarm),
        // P9C: the number of transfers that move data now (an update restart asks first).
        activeCount: () => active.size }
}
