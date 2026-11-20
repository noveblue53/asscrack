import { randomUUID } from 'node:crypto'
import { safeFileName } from './file-transfer.mjs'
import { roomRateLimit } from './room-rate-limit.mjs'

const MAX_FILES = 32
const MAX_PUBLISHERS = 32
const REQUEST_MS = 10000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{64}$/
const uuid = value => typeof value === 'string' && UUID.test(value)

function fileDescriptor(value) {
    if (!value || typeof value !== 'object') return null
    const { id, name, size, sha256 } = value
    if (!uuid(id) || !Number.isSafeInteger(size) || size < 0 || typeof sha256 !== 'string' || !SHA.test(sha256) ||
        typeof name !== 'string' || name.length > 200 || safeFileName(name) !== name) return null
    return { id, name, size, sha256 }
}

function sameFile(a, b) {
    return a.name === b.name && a.size === b.size && a.sha256 === b.sha256
}

export function createSharedShelf({ self, name, peerName, sessions, files, events, requestMs = REQUEST_MS }) {
    const own = new Map()
    const publishers = new Map()
    const capable = new Set()
    const downloads = new Map()
    const granted = new Map()
    const uploads = new Map()
    const allowShelfControl = roomRateLimit(32, 128)
    let preparing = false
    let stopped = false
    let revision = 0
    let emitQueued = false

    function send(peer, op, data = {}) {
        return sessions.get(peer)?.send(JSON.stringify({ type: 'shelf', v: 1, op, ...data })) === true
    }

    function view() {
        const items = [...own.values()].map(({ descriptor, available }) => ({
            id: descriptor.id, name: descriptor.name, size: descriptor.size,
            peerId: self, publisher: name, own: true, available
        }))
        for (const [peerId, publisher] of publishers) {
            for (const row of publisher.rows.values()) {
                items.push({ id: row.descriptor.id, name: row.descriptor.name, size: row.descriptor.size,
                    peerId, publisher: publisher.name, own: false, available: row.available && capable.has(peerId),
                    state: row.state, offerId: row.offerId, reason: row.reason })
            }
        }
        return { revision, items }
    }

    function changed() {
        revision++
        if (emitQueued) return
        emitQueued = true
        queueMicrotask(() => {
            emitQueued = false
            if (!stopped) events.emit('shelf', view())
        })
    }

    function sendList(peer) {
        send(peer, 'list', { items: [...own.values()].map(({ descriptor, available }) => ({ ...descriptor, available })) })
    }

    function broadcastList() {
        changed()
        for (const peer of capable) sendList(peer)
    }

    function checkFile(source) {
        if (!source.available) return false
        source.checking ??= files.unchanged(source.prepared).then(available => {
            if (!stopped && own.get(source.descriptor.id) === source && !available) {
                source.available = false
                broadcastList()
            }
            return available
        }).finally(() => { source.checking = null })
        return source.checking
    }

    async function refresh() {
        for (const peer of capable) send(peer, 'query')
        await Promise.all([...own.values()].map(checkFile))
        return view()
    }

    async function publish(filePath) {
        if (stopped) throw new Error('Room closed')
        if (preparing) throw new Error('A file is already being prepared')
        if (own.size >= MAX_FILES) throw new Error(`Shared holds up to ${MAX_FILES} files from each publisher`)
        preparing = true
        try {
            const prepared = await files.prepareFile(filePath)
            if (stopped) throw new Error('Room closed')
            const descriptor = fileDescriptor({ ...prepared, id: randomUUID() })
            if (!descriptor) throw new Error('Unable to share this file')
            own.set(descriptor.id, { descriptor, prepared, available: true })
            broadcastList()
            return descriptor.id
        } finally { preparing = false }
    }

    function remove(id) {
        if (!own.delete(id)) return false
        broadcastList()
        return true
    }

    function learnList(peer, items) {
        if (!Array.isArray(items) || items.length > MAX_FILES) return
        let publisher = publishers.get(peer)
        if (!publisher && !items.length) return
        if (!publisher) {
            if (publishers.size >= MAX_PUBLISHERS) {
                const stale = [...publishers].find(([id, p]) => !capable.has(id) &&
                    [...p.rows.values()].every(row => row.state !== 'receiving'))
                if (!stale) return
                publishers.delete(stale[0])
            }
            publisher = { name: peerName(peer) ?? peer.slice(-8), rows: new Map() }
            publishers.set(peer, publisher)
        }
        const next = new Map()
        let listChanged = false
        for (const item of items) {
            const descriptor = fileDescriptor(item)
            if (!descriptor || next.has(descriptor.id)) continue
            const prior = publisher.rows.get(descriptor.id)
            if (prior && !sameFile(prior.descriptor, descriptor)) continue
            const row = prior ?? { descriptor }
            if (!prior || row.available !== (item.available === true)) listChanged = true
            row.available = item.available === true
            next.set(descriptor.id, row)
        }
        for (const [id, row] of publisher.rows) {
            if (next.has(id)) continue
            listChanged = true
            row.available = false
            if (row.state === 'requesting') finishDownload(row.token, 'failed', 'The file was removed.')
            // Keep in-progress actions until they finish. Saved files remain available in Transfers.
            if (row.state === 'receiving') next.set(id, row)
        }
        publisher.rows = next
        if (listChanged) changed()
    }

    function finishDownload(token, state, reason) {
        const pending = downloads.get(token)
        if (!pending) return
        downloads.delete(token)
        granted.delete(pending.row.offerId)
        clearTimeout(pending.timer)
        pending.row.state = state
        pending.row.reason = reason
        changed()
    }

    function download(peer, id) {
        const row = publishers.get(peer)?.rows.get(id)
        if (!row?.available || !capable.has(peer) || ['requesting', 'receiving', 'saved'].includes(row.state)) return false
        const token = randomUUID()
        if (!send(peer, 'download', { id, token, sha256: row.descriptor.sha256 })) return false
        const timer = setTimeout(() => finishDownload(token, 'failed', 'The source did not respond.'), requestMs)
        timer.unref?.()
        downloads.set(token, { peer, row, timer })
        Object.assign(row, { token, offerId: undefined, state: 'requesting', reason: undefined })
        changed()
        return true
    }

    async function serve(peer, session, { id, token, sha256 }) {
        if (!uuid(id) || !uuid(token)) return
        const source = own.get(id)
        const key = peer + '|' + id
        if (!source || source.descriptor.sha256 !== sha256 || uploads.has(key) || uploads.size >= 8 ||
            [...uploads.values()].filter(transfer => transfer.peer === peer).length >= 2) {
            send(peer, 'unavailable', { token })
            return
        }
        const offerId = randomUUID()
        const upload = { offerId, peer }
        uploads.set(key, upload)
        try {
            const available = await checkFile(source)
            if (stopped || sessions.get(peer) !== session || uploads.get(key) !== upload) return
            if (available && own.get(id) === source && send(peer, 'grant', { token, id, offerId })) {
                const offer = files.publishOffer(source.prepared, [peer], offerId, id)
                if (offer.peers) {
                    // A peer that never opens the offered stream must release its reservation.
                    upload.timer = setTimeout(() => files.cancelFile(offerId, peer), requestMs * 2)
                    upload.timer.unref?.()
                    events.emit('shelf-offered', { ...offer, peerId: peer })
                    return
                }
            }
            send(peer, 'unavailable', { token })
        } catch {
            if (!stopped && sessions.get(peer) === session) send(peer, 'unavailable', { token })
        } finally {
            if (!upload.timer && uploads.get(key) === upload) uploads.delete(key)
        }
    }

    function opened(peer) {
        closed(peer)
        send(peer, 'hello')
    }

    function closed(peer) {
        const wasCapable = capable.delete(peer)
        const publisher = publishers.get(peer)
        if (publisher) for (const row of publisher.rows.values()) row.available = false
        for (const [token, pending] of downloads) {
            if (pending.peer === peer && pending.row.state === 'requesting') finishDownload(token, 'failed', 'The source disconnected.')
        }
        if (wasCapable && publisher) changed()
    }

    async function handle(peer, session, control) {
        if (stopped || control.v !== 1) return
        if (control.op === 'hello') {
            if (capable.has(peer)) return
            capable.add(peer)
            send(peer, 'query')
            return
        }
        if (!capable.has(peer)) return
        if (['query', 'list', 'download'].includes(control.op) && !allowShelfControl(peer)) return
        if (control.op === 'query') {
            await Promise.all([...own.values()].map(checkFile))
            if (!stopped && sessions.get(peer) === session) sendList(peer)
        } else if (control.op === 'list') learnList(peer, control.items)
        else if (control.op === 'download') await serve(peer, session, control)
        else if (control.op === 'grant') {
            const pending = downloads.get(control.token)
            if (pending?.peer !== peer || pending.row.descriptor.id !== control.id || pending.row.offerId ||
                !uuid(control.offerId) || granted.has(control.offerId)) return
            pending.row.offerId = control.offerId
            granted.set(control.offerId, pending)
        }
        else if (control.op === 'unavailable' && downloads.get(control.token)?.peer === peer) {
            const { row } = downloads.get(control.token)
            if (row.state === 'requesting') finishDownload(control.token, 'failed', 'The source could not offer this file.')
        }
    }

    // Pair the authenticated publisher's grant with the user's request before accepting the fresh file offer.
    function classifyOffer(peer, control) {
        const pending = granted.get(control.offerId)
        if (pending) {
            const descriptor = pending.row.descriptor
            return pending.peer === peer && pending.row.state === 'requesting' &&
                descriptor.id === control.attachmentId && sameFile(descriptor, control) ? 'requested' : 'reject'
        }
        return publishers.get(peer)?.rows.has(control.attachmentId) ? 'reject' : 'ordinary'
    }

    function startOffer(peer, offerId) {
        const pending = granted.get(offerId)
        try {
            if (files.acceptFile(offerId)) {
                clearTimeout(pending.timer)
                pending.row.state = 'receiving'
                changed()
                return
            }
        } catch { files.refuseFile(offerId) }
        events.emit('file-failed', { offerId, peerId: peer, direction: 'receive', reason: 'Could not start Shared download' })
    }

    function senderUpload(data) {
        return [...uploads].find(([, upload]) => upload.offerId === data.offerId && upload.peer === data.peerId)
    }

    function transferred(data, state) {
        if (data.direction === 'receive' && granted.get(data.offerId)?.peer === data.peerId) {
            finishDownload(granted.get(data.offerId).row.token, state, data.reason)
        } else if (data.direction === 'send') {
            const match = senderUpload(data)
            if (!match) return
            clearTimeout(match[1].timer)
            uploads.delete(match[0])
            files.forgetOffer(data.offerId)
        }
    }

    events.on('file-progress', data => {
        if (data.direction === 'send') clearTimeout(senderUpload(data)?.[1].timer)
    })
    events.on('file-done', data => transferred(data, 'saved'))
    events.on('file-failed', data => transferred(data, 'failed'))
    events.on('file-cancelled', data => transferred(data, 'cancelled'))
    events.on('file-refused', data => transferred({ ...data, direction: 'send' }, 'cancelled'))
    events.on('peer-name', ({ peerId, name: displayName }) => {
        const publisher = publishers.get(peerId)
        if (publisher && publisher.name !== displayName) {
            publisher.name = displayName
            changed()
        }
    })

    return { view, refresh, publish, remove, download, opened, closed, handle, classifyOffer, startOffer,
        transferId(peer, token) {
            const pending = granted.get(token)
            return pending?.peer === peer ? pending.row.descriptor.id : undefined
        },
        stop() {
            stopped = true
            for (const pending of downloads.values()) clearTimeout(pending.timer)
            for (const upload of uploads.values()) clearTimeout(upload.timer)
            downloads.clear(); granted.clear(); uploads.clear(); own.clear(); capable.clear(); publishers.clear()
        }
    }
}
