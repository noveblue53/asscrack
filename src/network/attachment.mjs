import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { validPeerId } from './invite.mjs'
import { safeFileName } from './file-transfer.mjs'
import { roomRateLimit } from './room-rate-limit.mjs'

export const PREVIEW_PROTOCOL = '/asscrack/preview/1.0.0'
export const MAX_PREVIEW_BYTES = 512 * 1024
export const ATTACHMENT_LIFETIME = 30 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{64}$/
const MAX_SOURCES = 200
const MAX_PUBLISHER_CACHE_BYTES = 8 * 1024 * 1024

export function mediaKind(name) {
    const ext = path.extname(name).toLowerCase()
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'image'
    if (ext === '.gif') return 'gif'
    if (['.mp4', '.webm', '.m4v', '.mov', '.ogv'].includes(ext)) return 'video'
    return null
}

// Only these fields may cross the network, be archived or go to the renderer.
export function normalizeAttachment(value) {
    if (!value || typeof value !== 'object') return null
    const { id, source, sha256, size, kind, name, expires } = value
    if (typeof id !== 'string' || !UUID.test(id) || !validPeerId(source) || typeof sha256 !== 'string' || !SHA.test(sha256) ||
        !Number.isSafeInteger(size) || size < 0 || typeof name !== 'string' || name !== safeFileName(name) ||
        !['image', 'gif', 'video'].includes(kind) || kind !== mediaKind(name) || !Number.isSafeInteger(expires) || expires <= 0) return null
    return { id, source, sha256, size, kind, name, expires }
}

// Resolve an action against the descriptor originally displayed, even after cache eviction or replay.
export function sameAttachment(a, b) {
    return Boolean(a && b && a.id === b.id && a.source === b.source && a.sha256 === b.sha256 &&
        a.name === b.name && a.size === b.size && a.kind === b.kind && a.expires === b.expires)
}

// Bind every new stream to the exact descriptor in the displayed chat post, including after a host replay.
function descriptorHash(d) {
    return createHash('sha256').update(JSON.stringify([d.id, d.source, d.sha256, d.size, d.kind, d.name, d.expires])).digest()
}

async function readBounded(stream, max) {
    let length = 0
    const chunks = []
    for await (const data of stream.source) {
        length += data.byteLength
        if (length > max) throw new Error('Preview exceeds its byte budget')
        chunks.push(Buffer.from(data.subarray()))
    }
    return Buffer.concat(chunks, length)
}

export function createAttachments({ self, sessions, connections, files, events, previewProvider, sendRecord, canPost }) {
    const sources = new Map()
    const known = new Map()
    const capable = new Set()
    const previewStreams = new Set()
    const publisherPreviews = new Map()
    const allowAttachmentControl = roomRateLimit(300, 1200)
    const allowPreview = roomRateLimit(24, 96)
    let publisherCacheBytes = 0
    const activeReads = new Set()
    const availability = new Map()
    let serving = 0
    let stopped = false
    const send = (peer, op, data = {}) => sessions.get(peer)?.send(JSON.stringify({ type: 'attachment', v: 1, op, ...data })) === true

    function watch(id, entry) {
        if (known.has(id)) return
        if (known.size >= MAX_SOURCES) {
            const first = known.keys().next().value
            known.delete(first)
            availability.delete(first)
        }
        known.set(id, entry)
        if (entry.source !== self && capable.has(entry.source) && entry.expires > Date.now()) send(entry.source, 'query', { id, stamp: descriptorHash(entry).toString('hex') })
    }
    function resolve(ref) {
        if (typeof ref === 'string') return known.get(ref)
        const d = known.get(ref?.id)
        return sameAttachment(d, ref) ? d : undefined
    }
    function remember(record, publisher = null) {
        const descriptor = normalizeAttachment(record.attachment)
        const prior = descriptor && known.get(descriptor.id)
        if (descriptor && (!publisher || publisher === descriptor.source) && (!prior || sameAttachment(prior, descriptor))) {
            record.attachment = descriptor
            watch(descriptor.id, descriptor)
        } else delete record.attachment
        return record
    }
    function discard(id) {
        const source = sources.get(id)
        if (!source) return
        sources.delete(id)
        clearTimeout(source.timer)
        dropPublisherPreview(id)
        files.expireAttachment(id)
        events.emit('attachment-expired', { id })
    }
    function opened(peer) {
        capable.delete(peer)
        send(peer, 'hello')
    }
    function status(id, available) {
        const descriptor = known.get(id)
        if (!descriptor) return
        availability.set(id, available)
        events.emit('attachment-status', { id, available, descriptor })
    }
    async function handle(peer, control) {
        if (control.v !== 1) return
        if (control.op === 'hello') {
            if (capable.has(peer)) return
            capable.add(peer)
            for (const d of known.values()) if (d.source === peer && d.expires > Date.now()) send(peer, 'query', { id: d.id, stamp: descriptorHash(d).toString('hex') })
            return
        }
        const { op, id } = control
        if (!capable.has(peer) || typeof id !== 'string' || !UUID.test(id) || !allowAttachmentControl(peer)) return
        if (op === 'status') {
            const descriptor = known.get(id)
            if (descriptor?.source === peer) {
                status(id, control.available === true && descriptor.expires > Date.now() &&
                    control.stamp === descriptorHash(descriptor).toString('hex'))
            }
        } else if (op === 'query' || op === 'request') {
            const session = sessions.get(peer)
            const source = sources.get(id)
            const stamp = source && descriptorHash(source.descriptor).toString('hex')
            let available = false
            if (source && stamp === control.stamp && source.descriptor.expires > Date.now()) {
                // Concurrent status/offer requests for this same original share a single file identity check.
                source.checking ??= files.unchanged(source.prepared).finally(() => { source.checking = null })
                available = await source.checking && !stopped && sources.get(id) === source && source.descriptor.expires > Date.now()
            }
            if (!session || sessions.get(peer) !== session) return
            if (op === 'request' && available) files.offerAttachmentTo(source.prepared, source.descriptor, peer)
            send(peer, 'status', { id, available, stamp })
        }
    }
    async function post(filePath, caption, channelId = 'general', displayName) {
        const kind = mediaKind(displayName ?? filePath)
        if (!kind || typeof caption !== 'string') throw new Error('Unsupported media or invalid caption')
        if (sources.size >= MAX_SOURCES) throw new Error('Too many current attachment offers')
        canPost(channelId)
        const prepared = await files.prepareFile(filePath, displayName)
        if (stopped) throw new Error('Room closed')
        if (sources.size >= MAX_SOURCES) throw new Error('Too many current attachment offers')
        const descriptor = normalizeAttachment({ ...prepared, id: randomUUID(), source: self, expires: Date.now() + ATTACHMENT_LIFETIME, kind })
        if (!descriptor) throw new Error('Invalid attachment')
        const fallback = [caption.trim(), descriptor.name + ' (' + descriptor.size + ' bytes)'].filter(Boolean).join('\n')
        const message = sendRecord(fallback, channelId, descriptor)
        const recipients = [...sessions.keys()].filter(peer => canPost(channelId, peer))
        const offer = files.publishOffer(prepared, recipients, descriptor.id, descriptor.id)
        if (offer.peers || message.accepted) {
            const timer = setTimeout(() => discard(descriptor.id), ATTACHMENT_LIFETIME)
            timer.unref?.()
            sources.set(descriptor.id, { prepared, descriptor, timer })
            watch(descriptor.id, descriptor)
        }
        return { message, offer }
    }
    function closed(peer) {
        capable.delete(peer)
        for (const d of known.values()) if (d.source === peer) status(d.id, false)
    }
    function begin(stream) {
        const timer = setTimeout(() => stream.abort(new Error('Preview timed out')), 15000)
        timer.unref?.()
        previewStreams.add(stream)
        return () => { clearTimeout(timer); previewStreams.delete(stream) }
    }

    function dropPublisherPreview(id) {
        const bytes = publisherPreviews.get(id)
        if (bytes) publisherCacheBytes -= bytes.length
        publisherPreviews.delete(id)
    }

    async function publisherPreview(source) {
        const id = source.descriptor.id
        const cached = publisherPreviews.get(id)
        if (cached) {
            publisherPreviews.delete(id)
            publisherPreviews.set(id, cached)
            return cached
        }
        source.preview ??= Promise.resolve(previewProvider(source.descriptor, source.prepared.filePath)).then(bytes => {
            if (!bytes?.length || bytes.length > MAX_PREVIEW_BYTES || stopped || sources.get(id) !== source) return null
            while (publisherCacheBytes + bytes.length > MAX_PUBLISHER_CACHE_BYTES) {
                dropPublisherPreview(publisherPreviews.keys().next().value)
            }
            publisherPreviews.set(id, bytes)
            publisherCacheBytes += bytes.length
            return bytes
        }).finally(() => { source.preview = null })
        return source.preview
    }

    async function handlePreview({ stream, connection }) {
        const peer = connection.remotePeer.toString()
        if (stopped || serving >= 2 || !sessions.has(peer) || !capable.has(peer) || !previewProvider || !allowPreview(peer)) {
            stream.abort(new Error('Preview unavailable')); return
        }
        serving++
        const done = begin(stream)
        try {
            const id = (await readBounded(stream, 36)).toString('ascii')
            const source = sources.get(id)
            if (!source || source.descriptor.expires <= Date.now() || !await files.unchanged(source.prepared)) throw new Error('Original unavailable')
            const bytes = await publisherPreview(source)
            if (!bytes?.length || bytes.length > MAX_PREVIEW_BYTES || !sessions.has(peer) || stopped) throw new Error('Preview unavailable')
            if (sources.get(id) !== source || !await files.unchanged(source.prepared)) throw new Error('Original changed')
            await stream.sink([descriptorHash(source.descriptor), createHash('sha256').update(bytes).digest(), bytes])
            await stream.close()
        } catch (err) { stream.abort(err) }
        finally { done(); serving-- }
    }
    async function requestPreviewById(ref) {
        const descriptor = resolve(ref)
        const id = descriptor?.id
        if (!descriptor || !capable.has(descriptor.source) || descriptor.expires <= Date.now() ||
            activeReads.size >= 2 || activeReads.has(id) || stopped) return null
        const connection = connections().find(c => c.status === 'open' && c.remotePeer.toString() === descriptor.source)
        if (!connection) return null
        activeReads.add(id)
        let stream, done
        try {
            stream = await connection.newStream(PREVIEW_PROTOCOL, { runOnTransientConnection: true, signal: AbortSignal.timeout(15000) })
            done = begin(stream)
            if (stopped) throw new Error('Room closed')
            await stream.sink([Buffer.from(id)])
            const response = await readBounded(stream, MAX_PREVIEW_BYTES + 64)
            if (!descriptorHash(descriptor).equals(response.subarray(0, 32))) throw new Error('Preview does not match this post')
            const bytes = response.subarray(64)
            if (!bytes.length || !createHash('sha256').update(bytes).digest().equals(response.subarray(32, 64))) throw new Error('Bad preview integrity')
            await stream.close()
            return { descriptor, bytes }
        } catch (err) { stream?.abort(err); return null }
        finally { done?.(); activeReads.delete(id) }
    }
    function requestOriginal(ref) {
        const d = resolve(ref)
        const id = d?.id
        return Boolean(d && d.expires > Date.now() && availability.get(id) && capable.has(d.source) && send(d.source, 'request', { id, stamp: descriptorHash(d).toString('hex') }))
    }
    return { post, opened, handle, remember, closed, handlePreview, requestPreviewById, requestOriginal,
        descriptor: ref => resolve(ref) ?? null,
        available(ref) { const d = resolve(ref); return Boolean(d && d.expires > Date.now() && availability.get(d.id)) },
        stop() {
            stopped = true
            for (const id of sources.keys()) discard(id)
            for (const stream of previewStreams) stream.abort(new Error('Room closed'))
            known.clear(); availability.clear(); capable.clear()
        }
    }
}
