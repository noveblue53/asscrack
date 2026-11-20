import { MAX_CHAT_FRAME_BYTES } from './chat-session.mjs'

export const HISTORY_LIMIT = 200
export const MAX_MESSAGE_BYTES = 64 * 1024  // sender + body, matching the local archive's default row budget
const MAX_ID_BYTES = 128

export function validHistoryItem(m) {
    return m !== null && typeof m === 'object' && typeof m.id === 'string' && m.id.length > 0 &&
        Buffer.byteLength(m.id) <= MAX_ID_BYTES && typeof m.from === 'string' && typeof m.text === 'string' &&
        Buffer.byteLength(m.from) + Buffer.byteLength(m.text) <= MAX_MESSAGE_BYTES &&
        Number.isSafeInteger(m.time) && Math.abs(m.time) <= 8_640_000_000_000_000
}

// Keep the existing history wire type. Even 200 short records from an older host fit in one frame.
// Count actual JSON bytes: escaping a control character can take six bytes on the wire.
export function* historyLines(messages) {
    const prefix = '{"type":"history","messages":['
    const suffix = ']}'
    const emptyBytes = Buffer.byteLength(prefix + suffix)
    let parts = []
    let size = emptyBytes
    for (const message of messages) {
        const part = JSON.stringify(message)
        const bytes = Buffer.byteLength(part)
        if (parts.length && (parts.length === HISTORY_LIMIT || size + 1 + bytes > MAX_CHAT_FRAME_BYTES)) {
            yield prefix + parts.join(',') + suffix
            parts = []
            size = emptyBytes
        }
        size += bytes + (parts.length ? 1 : 0)
        parts.push(part)
    }
    yield prefix + parts.join(',') + suffix
}

// Chat history buffer: the last `limit` messages, sorted by time, then by id.
// A message with an id that is already in the buffer is a duplicate.
export function createHistory(limit = HISTORY_LIMIT) {
    let items = []
    const ids = new Set()
    let clearVersion = 0

    function compare(a, b) {
        if (a.time !== b.time) return a.time - b.time
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    }

    return {
        // Returns true when the message is new and was added.
        add(message) {
            if (ids.has(message.id)) return false
            const item = { id: message.id, from: message.from, text: message.text, time: message.time }
            let i = items.length
            while (i > 0 && compare(items[i - 1], item) > 0) i--
            items.splice(i, 0, item)
            ids.add(item.id)
            while (items.length > limit) ids.delete(items.shift().id)
            return true
        },
        removeIds(removed) {
            if (removed.size) clearVersion++
            items = items.filter(item => !removed.has(item.id))
            for (const id of removed) ids.delete(id)
        },
        // A slow session may still be waiting to write some of these frames when the user clears the
        // archive. Rebuild from the current window at its next pull; already-written frames are remote.
        *replayLines(isHost) {
            let version
            do {
                version = clearVersion
                const snapshot = items.slice()
                for (const line of historyLines(snapshot)) {
                    if (!isHost()) return
                    if (version !== clearVersion) break
                    yield line
                }
                if (version === clearVersion) return snapshot.length
            } while (true)
        },
        has: id => ids.has(id),
        list: () => items.map(m => ({ ...m }))
    }
}
