import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

// The resume grants of a sender (P7c). When a receiver pauses a file of a protected room, the sender keeps the
// right of that receiver device to continue the same file. This file keeps the grants after a restart of the
// sender. A grant is valid only for the device ID of the receiver, only in the room of the file (the app gives one
// file for each room), and only while the source file is unchanged (the same stat identity as at the offer).
// The receiver keeps its part for the same time (PARTIAL_TTL_MS of partial-store.mjs).

export const GRANT_LIMIT = 64
const FILE_LIMIT = 256 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA_RE = /^[0-9a-f]{64}$/

function validGrant(g, time) {
    if (!g || typeof g !== 'object') return false
    if (typeof g.offerId !== 'string' || !UUID_RE.test(g.offerId)) return false
    if (typeof g.device !== 'string' || g.device.length === 0 || g.device.length > 128) return false
    if (typeof g.filePath !== 'string' || g.filePath.length === 0 || g.filePath.length > 32767 || !path.isAbsolute(g.filePath)) return false
    if (typeof g.name !== 'string' || g.name.length === 0 || g.name.length > 255) return false
    if (!Number.isSafeInteger(g.size) || g.size < 0 || typeof g.sha256 !== 'string' || !SHA_RE.test(g.sha256)) return false
    if (![g.dev, g.ino, g.mtimeMs, g.ctimeMs].every(Number.isFinite)) return false
    return Number.isFinite(g.expiresAt) && g.expiresAt > time
}

const pick = g => ({ offerId: g.offerId, device: g.device, filePath: g.filePath, name: g.name, size: g.size,
    sha256: g.sha256, dev: g.dev, ino: g.ino, mtimeMs: g.mtimeMs, ctimeMs: g.ctimeMs, expiresAt: g.expiresAt })

export function createGrantStore({ file, now = Date.now }) {
    if (typeof file !== 'string' || file === '') throw new TypeError('A grant store needs a file')
    let writes = Promise.resolve()

    async function write(grants) {
        if (grants.length === 0) {
            await fsp.unlink(file).catch(() => {})
            return
        }
        await fsp.mkdir(path.dirname(file), { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        await fsp.writeFile(temp, JSON.stringify({ v: 1, grants }), { mode: 0o600 })
        await fsp.rename(temp, file)
    }

    return {
        // The valid grants of the file. A damaged file or a bad grant gives no grant (the file stays until the
        // next save).
        async load() {
            try {
                const stat = await fsp.lstat(file)
                if (!stat.isFile() || stat.size > FILE_LIMIT) return []
                const data = JSON.parse(await fsp.readFile(file, 'utf8'))
                if (!data || data.v !== 1 || !Array.isArray(data.grants)) return []
                const time = now()
                return data.grants.filter(g => validGrant(g, time)).slice(-GRANT_LIMIT).map(pick)
            } catch { return [] }
        },

        // Replaces all grants of the file. The writes come in order.
        save(grants) {
            const time = now()
            const list = grants.filter(g => validGrant(g, time)).slice(-GRANT_LIMIT).map(pick)
            writes = writes.then(() => write(list)).catch(() => {})
            return writes
        },

        flush: () => writes
    }
}
