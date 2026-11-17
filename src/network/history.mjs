// Chat history buffer: the last `limit` messages, sorted by time, then by id.
// A message with an id that is already in the buffer is a duplicate.
export function createHistory(limit = 200) {
    let items = []
    const ids = new Set()

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
        has: id => ids.has(id),
        list: () => items.map(m => ({ ...m }))
    }
}
