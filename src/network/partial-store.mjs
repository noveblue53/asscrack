import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

// The store of the partial downloads that the user paused. The key of a partial is the SHA-256 and the size of the
// offer, thus a later offer of the same content can continue it. The store keeps two files for each partial in its
// folder: the bytes (.part) and a small description (.json). The names have no offer ID, thus the cleanup of the
// interrupted downloads (.asscrack-<uuid>.part) never removes them.

export const PARTIAL_BUDGET = 8 * 1024 * 1024 * 1024
export const PARTIAL_TTL_MS = 72 * 60 * 60 * 1000
export const PARTIAL_NAME = /^\.asscrack-resume-([0-9a-f]{64})-(0|[1-9]\d{0,15})\.(part|json)$/
const META_LIMIT = 4096
const NAME_LIMIT = 255
const ID_LIMIT = 128
const FROM_LIMIT = 64

// The retry state of a partial (P7c): the sender of the last attempt. `device` is the room device ID of the sender,
// thus a Resume after a restart (a new libp2p peer ID on each end) can find the sender again. Each field is bounded.
// A bad retry state gives null: the partial stays, and only a new offer of the same content continues it.
export function partialSource(value) {
    if (!value || typeof value !== 'object') return null
    const { peerId, device, from } = value
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > ID_LIMIT) return null
    if (typeof device !== 'string' || device.length === 0 || device.length > ID_LIMIT) return null
    return { peerId, device, from: typeof from === 'string' ? from.slice(0, FROM_LIMIT) : '', flow: value.flow === true }
}

export const partialKey = (sha256, size) => `${sha256}-${size}`

export function createPartialStore({ dir, budget = PARTIAL_BUDGET, ttl = PARTIAL_TTL_MS, now = Date.now, onChange = () => {} } = {}) {
    if (typeof dir !== 'string' || dir === '') throw new TypeError('A partial store needs a folder')
    if (!Number.isSafeInteger(budget) || budget < 0) throw new TypeError('The partial budget must be a byte count')
    if (!Number.isSafeInteger(ttl) || ttl < 0) throw new TypeError('The partial expiry must be a time in milliseconds')
    // key -> { key, sha256, size, name, offerId, source, bytes, lastByteAt, busy }
    const entries = new Map()
    let loading = null
    const file = (key, ext) => path.join(dir, `.asscrack-resume-${key}.${ext}`)

    function view(entry) {
        const { key, sha256, size, name, offerId, source, bytes, lastByteAt, busy } = entry
        // The window gets the name and the peer ID of the sender, not its device ID.
        // A partial with no retry state has the fields of P7a only.
        return { key, sha256, size, name, offerId, bytes, lastByteAt, expiresAt: lastByteAt + ttl, active: busy,
            ...(source && offerId ? { resumable: true, from: source.from, peerId: source.peerId } : {}) }
    }

    function others(key) {
        let total = 0
        for (const entry of entries.values()) if (entry.key !== key) total += entry.bytes
        return total
    }

    async function removeFiles(key) {
        await fsp.unlink(file(key, 'part')).catch(() => {})
        await fsp.unlink(file(key, 'json')).catch(() => {})
    }

    async function writeMeta(entry) {
        const { sha256, size, name, offerId, source, lastByteAt } = entry
        await fsp.writeFile(file(entry.key, 'json'), JSON.stringify({ v: 1, sha256, size, name, offerId, lastByteAt,
            ...(source ? { source } : {}) }), { mode: 0o600 })
    }

    async function readMeta(key, sha256, size) {
        const metaPath = file(key, 'json')
        const stat = await fsp.lstat(metaPath)
        if (!stat.isFile() || stat.size > META_LIMIT) return null
        let meta
        try { meta = JSON.parse(await fsp.readFile(metaPath, 'utf8')) } catch { return null }
        if (!meta || meta.v !== 1 || meta.sha256 !== sha256 || meta.size !== size) return null
        if (typeof meta.name !== 'string' || meta.name.length === 0 || meta.name.length > NAME_LIMIT) return null
        if (!Number.isFinite(meta.lastByteAt)) return null
        const offerId = typeof meta.offerId === 'string' && meta.offerId.length <= 64 ? meta.offerId : null
        // A description of P7a or P7b has no retry state. It stays valid (version 1).
        return { name: meta.name, offerId, lastByteAt: meta.lastByteAt, source: partialSource(meta.source) }
    }

    // Reads the partials of an earlier run. Each damaged pair of files is removed. Other names stay.
    async function load() {
        let names
        try { names = await fsp.readdir(dir) } catch { return }
        const found = new Map()
        for (const name of names) {
            const match = PARTIAL_NAME.exec(name)
            if (!match || !Number.isSafeInteger(Number(match[2]))) continue
            const key = partialKey(match[1], match[2])
            const item = found.get(key) ?? { sha256: match[1], size: Number(match[2]) }
            item[match[3]] = true
            found.set(key, item)
        }
        for (const [key, item] of found) {
            if (entries.has(key)) continue
            let meta = null, bytes = -1
            try {
                if (item.part && item.json) {
                    meta = await readMeta(key, item.sha256, item.size)
                    const stat = await fsp.lstat(file(key, 'part'))
                    if (stat.isFile() && stat.size <= item.size) bytes = stat.size
                }
            } catch {}
            if (!meta || bytes < 0) {
                await removeFiles(key)
                continue
            }
            entries.set(key, { key, sha256: item.sha256, size: item.size, ...meta, bytes, busy: false })
        }
    }

    const ready = () => (loading ??= load())

    async function remove(entry, type, reason) {
        entries.delete(entry.key)
        await removeFiles(entry.key)
        onChange(type, { ...view(entry), active: false, ...(reason ? { reason } : {}) })
    }

    async function sweepNow() {
        const time = now()
        for (const entry of [...entries.values()]) {
            if (!entry.busy && entry.lastByteAt + ttl <= time) await remove(entry, 'expired')
        }
    }

    return {
        // The current partials, with no disk access. The list is complete after the first list() or sweep().
        snapshot: () => [...entries.values()].map(view),

        async list() {
            await ready()
            await sweepNow()
            return [...entries.values()].map(view)
        },

        async sweep() {
            await ready()
            await sweepNow()
        },

        // Gives the partial of this content to one receive. Other receives of the same content start fresh.
        async claim(sha256, size) {
            await ready()
            await sweepNow()
            const entry = entries.get(partialKey(sha256, size))
            if (!entry || entry.busy) return null
            entry.busy = true
            onChange('claimed', view(entry))
            return { key: entry.key, path: file(entry.key, 'part'), bytes: entry.bytes }
        },

        // Keeps the partial file `temp` of a paused fresh receive. Returns false when the store cannot keep it:
        // the partial is over the budget, or another receive uses the same content.
        async adopt(temp, { sha256, size, name, offerId, bytes, source = null }) {
            await ready()
            const key = partialKey(sha256, size)
            const existing = entries.get(key)
            if (existing?.busy || others(key) + bytes > budget) return false
            if (existing) await remove(existing, 'discarded', 'replaced')
            const entry = { key, sha256, size, name: String(name).slice(0, NAME_LIMIT) || 'file', offerId, bytes,
                source: partialSource(source), lastByteAt: now(), busy: false }
            await fsp.rename(temp, file(key, 'part'))
            try { await writeMeta(entry) } catch (error) {
                await removeFiles(key)
                throw error
            }
            entries.set(key, entry)
            onChange('retained', view(entry))
            return true
        },

        // Gives back a claimed partial with its new length. Returns false when it is over the budget: the
        // partial is then deleted.
        // `source` undefined keeps the retry state, null removes it.
        async release(key, { bytes, offerId, source }) {
            const entry = entries.get(key)
            if (!entry) return false
            if (others(key) + bytes > budget) {
                await remove(entry, 'discarded', 'budget')
                return false
            }
            Object.assign(entry, { bytes, lastByteAt: now(), busy: false, offerId: offerId ?? entry.offerId,
                ...(source !== undefined ? { source: partialSource(source) } : {}) })
            try { await writeMeta(entry) } catch {
                await remove(entry, 'discarded', 'write')
                return false
            }
            onChange('retained', view(entry))
            return true
        },

        // The claimed partial became the final file. Its bytes moved, thus only the description stays to remove.
        async finish(key) {
            const entry = entries.get(key)
            if (!entry) return
            entries.delete(key)
            await fsp.unlink(file(key, 'json')).catch(() => {})
            onChange('completed', { ...view(entry), active: false })
        },

        // Deletes a claimed partial. Its receive calls this for a cancel or for bad bytes.
        async drop(key, reason) {
            const entry = entries.get(key)
            if (entry) await remove(entry, 'discarded', reason)
        },

        // Deletes a partial that no receive uses (the Discard action of the user).
        async discard(key, reason = 'user') {
            await ready()
            const entry = entries.get(key)
            if (!entry || entry.busy) return false
            await remove(entry, 'discarded', reason)
            return true
        },

        // Removes the retry state of a partial and keeps its bytes: the sender refused the retry, or its grant
        // expired. A new offer of the same content still continues the partial.
        async forgetSource(key) {
            const entry = entries.get(key)
            if (!entry?.source) return
            entry.source = null
            await writeMeta(entry).catch(() => {})
            onChange('retained', view(entry))
        },

        // The retry state of a partial with its device ID, for the node only (not for the window).
        source: key => {
            const entry = entries.get(key)
            return entry?.source && entry.offerId ? { ...entry.source, offerId: entry.offerId } : null
        },

        has: (sha256, size) => entries.has(partialKey(sha256, size))
    }
}
