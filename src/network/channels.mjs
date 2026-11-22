// Channel IDs belong to one room. Names are display labels and may coincide after a partition.
import { randomUUID } from 'node:crypto'
import { roomRateLimit } from './room-rate-limit.mjs'

export const validChannelId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
export const validChannelName = name => typeof name === 'string' && name.length > 0 && name.length <= 80 &&
    name.isWellFormed() && name === name.trim() && name === name.normalize('NFC') && name.toLowerCase() !== 'general' &&
    [...name].length <= 40 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
const general = { id: 'general', name: 'General' }
const PAGE = 64
// M2 (P10a): at most 64 named channels in a room. A node keeps the first 64 that it gets and refuses the rows above
// the limit. A refused row cannot push out a known channel.
export const MAX_CHANNELS = 64
export const CHANNEL_ERRORS = Object.freeze({ limit: `A room can have at most ${MAX_CHANNELS} channels.` })

// M2 (P10a): a member keeps new channels only from the host. The host keeps the channels of each member and sends them
// on, with a rate limit of the add lines of each member (allowAdd).
export function createChannels({ self, host, send, changed, ready, seed = [], allowAdd = roomRateLimit(30, 240) }) {
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
            if (old === undefined && names.size >= MAX_CHANNELS) continue
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
        // M2: only the host sends received rows on. The own new channel goes to each peer (only the host keeps it).
        if (source === null || host() === self) for (const id of peers) if (id !== source) share(id, delta)
        changed(view(), delta)
    }
    project(seed)
    return {
        view, available, capable: id => peers.has(id), known: id => names.has(id),
        changedHost() {
            changed(view(), [])
            // M2: a member takes rows only from the host. A new host sends its list to each member, and a member sends
            // its list to the new host. A microtask: the host line of the election goes out first.
            queueMicrotask(() => {
                const now = host()
                if (now === self) for (const id of peers) share(id, list())
                else if (peers.has(now)) share(now, list())
            })
        },
        opened(id) {
            if (peers.delete(id)) changed(view(), [])
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
                const current = host()
                if (current === self ? !allowAdd(id) : id !== current) return
                merge(msg.rows, id)
            }
        },
        create(input) {
            const name = typeof input === 'string' ? input.trim().normalize('NFC') : ''
            if (name.toLowerCase() === 'general') throw new Error('That channel name already exists.')
            if (!validChannelName(name)) throw new Error('Use a channel name of 1–40 characters.')
            if (!available()) throw new Error('Named channels need a host with channel support.')
            if ([...names.values()].some(label => label.toLowerCase() === name.toLowerCase())) throw new Error('That channel name already exists.')
            if (names.size >= MAX_CHANNELS) throw new Error(CHANNEL_ERRORS.limit)
            const id = randomUUID()
            merge([{ id, name }], null)
            return id
        }
    }
}
