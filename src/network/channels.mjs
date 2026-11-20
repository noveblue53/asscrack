// Channel IDs belong to one room. Names are display labels and may coincide after a partition.
import { randomUUID } from 'node:crypto'

export const validChannelId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
export const validChannelName = name => typeof name === 'string' && name === name.trim() && name.length > 0 &&
    [...name].length <= 40 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
const general = { id: 'general', name: 'General' }
const PAGE = 64

export function createChannels({ self, host, send, changed, ready, seed = [] }) {
    const peers = new Set()
    const names = new Map()
    const list = () => [...names].sort(([a], [b]) => a < b ? -1 : 1).map(([id, name]) => ({ id, name }))
    const available = () => host() === self || peers.has(host())
    const view = () => ({ v: 1, available: available(), channels: [general, ...list()] })
    function project(rows) {
        const updates = []
        for (const row of rows) {
            if (!validChannelId(row?.id) || !validChannelName(row.name)) continue
            // A same-ID conflict resolves identically regardless of arrival order.
            const old = names.get(row.id)
            if (old !== undefined && Buffer.compare(Buffer.from(old), Buffer.from(row.name)) <= 0) continue
            names.set(row.id, row.name)
            updates.push({ id: row.id, name: row.name })
        }
        return updates
    }
    function share(id, rows) {
        for (let i = 0; i < rows.length; i += PAGE)
            send(id, { type: 'channels', v: 1, op: 'add', rows: rows.slice(i, i + PAGE) })
    }
    function merge(rows, source) {
        const delta = project(rows)
        if (!delta.length) return
        for (const id of peers) if (id !== source) share(id, delta)
        changed(view(), delta)
    }
    project(seed)
    return {
        view, capable: id => peers.has(id), known: id => names.has(id), changedHost: () => changed(view(), []),
        opened(id) {
            peers.delete(id)
            send(id, { type: 'channels', v: 1, op: 'hello' })
        },
        closed(id) { if (peers.delete(id)) changed(view(), []) },
        handle(id, msg) {
            if (msg.v !== 1) return
            if (msg.op === 'hello' && !peers.has(id)) {
                peers.add(id)
                share(id, list())
                changed(view(), [])
                ready(id)
            } else if (peers.has(id) && msg.op === 'add' && Array.isArray(msg.rows) && msg.rows.length <= PAGE) {
                merge(msg.rows, id)
            }
        },
        create(input) {
            const name = typeof input === 'string' ? input.trim().normalize('NFC') : ''
            if (!validChannelName(name)) throw new Error('Use a channel name of 1–40 characters.')
            if (!available()) throw new Error('Named channels need a host with channel support.')
            if ([general, ...list()].some(c => c.name.toLowerCase() === name.toLowerCase())) throw new Error('That channel name already exists.')
            const id = randomUUID()
            merge([{ id, name }], null)
            return id
        }
    }
}
