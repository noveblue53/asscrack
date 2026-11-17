import { pushable } from 'it-pushable'
import { StringDecoder } from 'node:string_decoder'

// A libp2p stream is duplex. Newlines preserve terminal message boundaries even
// when transport chunks split a message or combine several messages.
export function createChatSession(stream, { onMessage }) {
    let closed = false
    const outgoing = pushable()
    function end() {
        closed = true
        outgoing.end()
    }

    async function receive() {
        const decoder = new StringDecoder('utf8')
        let pending = ''
        for await (const chunk of stream.source) {
            pending += decoder.write(Buffer.from(chunk.subarray()))
            let boundary
            while ((boundary = pending.indexOf('\n')) !== -1) {
                onMessage(pending.slice(0, boundary))
                pending = pending.slice(boundary + 1)
            }
        }
        pending += decoder.end()
        if (pending) onMessage(pending)
        end()
    }

    const done = (async () => {
        try {
            // A closed half ends this chat session. Do not wait for the remote
            // peer's other half after a disconnect.
            await Promise.race([stream.sink(outgoing), receive()])
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
            if (closed) return false
            outgoing.push(Buffer.from(message + '\n'))
            return true
        }
    }
}
