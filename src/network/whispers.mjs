// Every frame runs on the addressed peer's room-proven, Noise-authenticated chat stream.
// A relay has no chat stream in this exchange. Sessions are never substituted during a send.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const validText = text => typeof text === 'string' && text.length <= 4096 && text.trim().length > 0

export function createWhispers({ self, receive, changed, sessionFor, timeoutMs = 15000 }) {
    const capable = new Map()
    const pending = new Map() // One unconfirmed message per recipient.
    const recent = new Set() // A manual retry with the same ID gets another receipt without another display.
    let stopped = false

    function frame(session, to, op, fields) {
        return session.send(JSON.stringify({ type: 'whisper', v: 1, to, op, ...fields }))
    }

    function finish(peer, result) {
        const request = pending.get(peer)
        if (!request) return
        pending.delete(peer)
        clearTimeout(request.timer)
        request.resolve(result)
    }

    function closed(peer, session) {
        if (capable.get(peer) !== session) return
        capable.delete(peer)
        finish(peer, 'unconfirmed')
        changed(peer, false)
    }

    return {
        peers: () => [...capable.keys()],
        opened(peer, session) {
            if (receive && !stopped) frame(session, peer, 'cap')
        },
        closed,
        async send(peer, text, id) {
            const session = capable.get(peer)
            if (stopped || !session || sessionFor(peer) !== session) return 'unavailable'
            if (!validText(text) || typeof id !== 'string' || !uuid.test(id)) return 'invalid'
            if (pending.has(peer)) return 'busy'
            return new Promise(resolve => {
                const timer = setTimeout(() => finish(peer, 'unconfirmed'), timeoutMs)
                timer.unref?.()
                pending.set(peer, { id, timer, resolve })
                if (!frame(session, peer, 'send', { id, text })) finish(peer, 'unavailable')
            })
        },
        handle(peer, session, msg) {
            if (!receive || stopped || sessionFor(peer) !== session || msg.v !== 1 || msg.to !== self) return
            if (msg.op === 'cap') {
                if (capable.get(peer) !== session) {
                    capable.set(peer, session)
                    changed(peer, true)
                }
                return
            }
            if (capable.get(peer) !== session || typeof msg.id !== 'string' || !uuid.test(msg.id)) return
            if (msg.op === 'received') {
                if (pending.get(peer)?.id === msg.id) finish(peer, 'received')
            } else if (msg.op === 'send' && validText(msg.text)) {
                const token = peer + '/' + msg.id
                if (!recent.has(token)) {
                    if (receive({ peerId: peer, id: msg.id, text: msg.text, time: Date.now() }) === false) return
                    recent.add(token)
                    if (recent.size > 1024) recent.delete(recent.values().next().value)
                }
                frame(session, peer, 'received', { id: msg.id })
            }
        },
        stop() {
            stopped = true
            for (const [peer, session] of capable) closed(peer, session)
            recent.clear()
        }
    }
}
