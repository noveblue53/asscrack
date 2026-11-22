// easy-join part 2: a knock channel (knock.mjs) on a libp2p stream. One JSON object on each line. The reader closes the
// stream when a line is longer than maxLineBytes, when all lines together are more than maxStreamBytes, or when a line
// is not a JSON object (the knock size cap).
import { pushable } from 'it-pushable'

const END_WAIT_MS = 5000

export function knockChannel(stream, { onLine, onClose = () => {}, maxLineBytes, maxStreamBytes }) {
    const outgoing = pushable()
    let ended = false
    let total = 0
    function abort(cause) {
        ended = true
        outgoing.end()
        try { stream.abort(new Error(cause)) } catch { /* closed */ }
    }
    const channel = {
        send(value) {
            if (ended) return false
            outgoing.push(Buffer.from(JSON.stringify(value) + '\n'))
            return true
        },
        // Send the lines in the queue, then close the stream. A peer that does not close its half gets an abort.
        end() {
            if (ended) return
            ended = true
            outgoing.end()
            setTimeout(() => { try { stream.abort(new Error('Knock ended')) } catch { /* closed */ } }, END_WAIT_MS).unref?.()
        },
        close: () => abort('Knock closed')
    }
    async function receive() {
        let buffer = Buffer.alloc(0)
        for await (const chunk of stream.source) {
            for (const part of chunk instanceof Uint8Array ? [chunk] : chunk) {
                total += part.byteLength
                if (total > maxStreamBytes) return abort('Knock size cap')
                buffer = Buffer.concat([buffer, Buffer.from(part.buffer, part.byteOffset, part.byteLength)])
                let lf
                while ((lf = buffer.indexOf(10)) !== -1) {
                    const line = buffer.subarray(0, lf)
                    buffer = buffer.subarray(lf + 1)
                    if (line.length > maxLineBytes) return abort('Knock line cap')
                    let value
                    try { value = JSON.parse(line.toString('utf8')) } catch { value = null }
                    if (value === null || typeof value !== 'object' || Array.isArray(value)) return abort('Knock line is not valid')
                    onLine(value)
                }
                if (buffer.length > maxLineBytes) return abort('Knock line cap')
            }
        }
    }
    const done = Promise.allSettled([stream.sink(outgoing), receive()]).then(() => { ended = true; onClose() })
    return Object.assign(channel, { done })
}
