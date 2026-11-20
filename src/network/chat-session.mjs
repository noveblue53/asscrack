import { pushable } from 'it-pushable'
// Maximum encoded UTF-8 bytes in one line, excluding the LF delimiter.
export const MAX_CHAT_FRAME_BYTES = 512 * 1024

// A libp2p stream is duplex. Newlines preserve terminal message boundaries even
// when transport chunks split a message or combine several messages.
export function createChatSession(stream, { onMessage }) {
    let closed = false
    const outgoing = pushable({ objectMode: true })
    function end() {
        closed = true
        outgoing.end()
    }

    async function receive() {
        let buffer = Buffer.alloc(0)
        let used = 0
        let discard = false
        let warned = false
        for await (const chunk of stream.source) {
            // libp2p supplies a Uint8ArrayList. Inspect its segments without flattening a whole chunk.
            for (const part of chunk instanceof Uint8Array ? [chunk] : chunk) {
                const bytes = Buffer.from(part.buffer, part.byteOffset, part.byteLength)
                let start = 0
                while (start < bytes.length) {
                    const lf = bytes.indexOf(10, start)
                    const end = lf === -1 ? bytes.length : lf
                    const size = used + end - start
                    if (size > MAX_CHAT_FRAME_BYTES) {
                        discard = true
                        used = 0
                        if (!warned) console.warn('Ignored an oversized chat frame')
                        warned = true
                    }
                    if (!discard) {
                        if (used === 0 && lf !== -1) {
                            onMessage(bytes.toString('utf8', start, end))
                        } else {
                            // Copy only an incomplete line; a one-byte fragment cannot retain a large transport buffer.
                            if (size > buffer.length) {
                                const capacity = Math.min(MAX_CHAT_FRAME_BYTES, Math.max(256, buffer.length * 2, size))
                                const next = Buffer.allocUnsafe(capacity)
                                buffer.copy(next, 0, 0, used)
                                buffer = next
                            }
                            bytes.copy(buffer, used, start, end)
                            used = size
                            if (lf !== -1) onMessage(buffer.toString('utf8', 0, used))
                        }
                    }
                    if (lf === -1) break
                    used = 0
                    discard = false
                    start = lf + 1
                }
            }
        }
        if (used && !discard) onMessage(buffer.toString('utf8', 0, used))
        end()
    }

    // Keep a replay iterable in the same ordered queue as chat/control lines. Pull one frame
    // only when the transport is ready so local archive invalidation can take effect.
    async function* frames() {
        for await (const item of outgoing) {
            if (typeof item === 'string') yield Buffer.from(item + '\n')
            else for (const line of item) yield Buffer.from(line + '\n')
        }
    }

    const done = (async () => {
        try {
            // A closed half ends this chat session. Do not wait for the remote
            // peer's other half after a disconnect.
            await Promise.race([stream.sink(frames()), receive()])
        } catch (error) {
            stream.abort(error)
            throw error
        } finally {
            end()
        }
    })()

    return {
        done,
        close() {
            end()
            stream.abort(new Error('Chat connection closed'))
        },
        send(message) {
            if (closed || Buffer.byteLength(message) > MAX_CHAT_FRAME_BYTES) return false
            outgoing.push(message)
            return true
        },
        sendReplay(lines) {
            if (!closed) outgoing.push(lines)
        }
    }
}
