// Voice over libp2p streams, star topology.
// A member in voice opens one duplex stream to the host. The host forwards each frame to the other voice streams.
// Wire: 4-byte big-endian length, then the body.
// Body: version (1), origin length N, N bytes origin (UTF-8), 4-byte big-endian sequence number, Opus bytes.

export const VOICE_PROTOCOL = '/asscrack/voice/1.0.0'
export const MAX_BODY = 4000
export const MAX_QUEUE = 50
const VERSION = 1
const RETRY_MS = 1000
const MAX_RETRIES = 5

export function encodeFrame({ origin, seq, data }) {
    const o = Buffer.from(origin, 'utf8')
    if (o.length > 255) return null
    const bodyLen = 2 + o.length + 4 + data.length
    if (bodyLen > MAX_BODY) return null
    const out = Buffer.alloc(4 + bodyLen)
    out.writeUInt32BE(bodyLen, 0)
    out[4] = VERSION
    out[5] = o.length
    o.copy(out, 6)
    out.writeUInt32BE(seq >>> 0, 6 + o.length)
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 10 + o.length)
    return out
}

export function decodeBody(body) {
    if (body.length < 6 || body[0] !== VERSION) return null
    const n = body[1]
    if (body.length < 6 + n) return null
    const origin = body.subarray(2, 2 + n).toString('utf8')
    const seq = body.readUInt32BE(2 + n)
    const data = new Uint8Array(body.subarray(6 + n))
    return { origin, seq, data }
}

// A write queue with a fixed size. When full, the oldest frame is dropped.
function createQueue() {
    const items = []
    let wake = null
    let ended = false
    const q = {
        drops: 0,
        push(buf) {
            if (ended) return
            items.push(buf)
            while (items.length > MAX_QUEUE) {
                items.shift()
                q.drops++
            }
            if (wake) { wake(); wake = null }
        },
        end() {
            ended = true
            if (wake) { wake(); wake = null }
        },
        async * source() {
            while (true) {
                if (items.length > 0) {
                    yield items.shift()
                    continue
                }
                if (ended) return
                await new Promise(resolve => { wake = resolve })
            }
        }
    }
    return q
}

// Reads length-prefixed bodies from a libp2p stream source.
async function readFrames(source, onBody, onOversize) {
    let buf = Buffer.alloc(0)
    // Bytes of an oversize body that are still to be skipped.
    let skip = 0
    for await (const chunk of source) {
        const part = typeof chunk.subarray === 'function' ? chunk.subarray() : chunk
        buf = buf.length === 0 ? Buffer.from(part) : Buffer.concat([buf, part])
        while (true) {
            if (skip > 0) {
                const n = Math.min(skip, buf.length)
                skip -= n
                buf = buf.subarray(n)
                if (skip > 0) break
            }
            if (buf.length < 4) break
            const len = buf.readUInt32BE(0)
            if (len > MAX_BODY) {
                onOversize(len)
                skip = len
                buf = buf.subarray(4)
                continue
            }
            if (buf.length < 4 + len) break
            onBody(buf.subarray(4, 4 + len))
            buf = buf.subarray(4 + len)
        }
    }
}

export function createVoiceRelay({ libp2p, selfId, hostId, voicePeers, connectionFor, onFrame }) {
    // Host side: peerId -> { stream, queue }. Member side: one entry to the host.
    const members = new Map()
    let upstream = null
    let upstreamHost = null
    let retries = 0
    let retryTimer = null
    let stopped = false
    let seq = 0
    let oversizeWarned = false
    let droppedOversize = 0
    let closedDrops = 0
    let droppedOrigin = 0

    function warnOversize(len) {
        droppedOversize++
        if (!oversizeWarned) {
            oversizeWarned = true
            console.warn(`Voice frame dropped: body of ${len} bytes is above ${MAX_BODY}`)
        }
    }

    function isHost() {
        return hostId() === selfId
    }

    function selfInVoice() {
        return voicePeers().includes(selfId)
    }

    function deliver(frame) {
        if (frame.origin === selfId) return
        try {
            onFrame(frame)
        } catch (err) {
            console.warn('Voice onFrame failed:', err?.message ?? err)
        }
    }

    function attach(stream, queue, onBody, onClose) {
        stream.sink(queue.source()).catch(() => {})
        readFrames(stream.source, onBody, warnOversize)
            .catch(() => {})
            .finally(() => {
                queue.end()
                onClose()
            })
    }

    // Host: a member opened a voice stream.
    function handle({ stream, connection }) {
        if (stopped) { stream.abort?.(new Error('stopped')); return }
        const peerId = connection.remotePeer.toString()
        const old = members.get(peerId)
        if (old) closeEntry(old)
        const entry = { stream, queue: createQueue(), originWarned: false }
        members.set(peerId, entry)
        attach(stream, entry.queue, body => {
            const frame = decodeBody(body)
            if (!frame) return
            // A member must not send frames with the origin of another peer.
            if (frame.origin !== peerId) {
                droppedOrigin++
                if (!entry.originWarned) {
                    entry.originWarned = true
                    console.warn(`Voice frame dropped: origin ${frame.origin} is not the sender ${peerId}`)
                }
                return
            }
            const wire = Buffer.alloc(4 + body.length)
            wire.writeUInt32BE(body.length, 0)
            body.copy(wire, 4)
            for (const [other, e] of members) if (other !== peerId) e.queue.push(wire)
            deliver(frame)
        }, () => {
            if (members.get(peerId) === entry) {
                closedDrops += entry.queue.drops
                members.delete(peerId)
            }
        })
    }

    function closeEntry(entry) {
        entry.queue.end()
        entry.stream.close?.().catch?.(() => entry.stream.abort?.(new Error('closed')))
    }

    function closeUpstream() {
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
        if (upstream) {
            const e = upstream
            upstream = null
            closedDrops += e.queue.drops
            closeEntry(e)
        }
    }

    async function openUpstream() {
        const host = hostId()
        if (stopped || host === null || isHost() || !selfInVoice()) return
        if (upstream && upstreamHost === host) return
        const conn = connectionFor(host)
        if (!conn) { scheduleRetry(host); return }
        let stream
        try {
            stream = await conn.newStream(VOICE_PROTOCOL, { runOnTransientConnection: true })
        } catch (err) {
            console.warn('Voice stream open failed:', err?.message ?? err)
            scheduleRetry(host)
            return
        }
        if (stopped || hostId() !== host || upstream) {
            stream.abort?.(new Error('not needed'))
            return
        }
        const entry = { stream, queue: createQueue() }
        upstream = entry
        upstreamHost = host
        attach(stream, entry.queue, body => {
            const frame = decodeBody(body)
            if (frame) deliver(frame)
        }, () => {
            if (upstream !== entry) return
            upstream = null
            closedDrops += entry.queue.drops
            scheduleRetry(host)
        })
    }

    function scheduleRetry(host) {
        if (stopped || retryTimer || hostId() !== host || retries >= MAX_RETRIES) return
        retries++
        retryTimer = setTimeout(() => {
            retryTimer = null
            if (hostId() === host) openUpstream()
        }, RETRY_MS)
        retryTimer.unref?.()
    }

    // Opens or closes the stream to the host, after a change of host or of the own voice state.
    function hostChanged() {
        const host = hostId()
        if (upstream && (upstreamHost !== host || isHost() || !selfInVoice())) closeUpstream()
        if (upstreamHost !== host) retries = 0
        if (host !== upstreamHost) upstreamHost = null
        if (isHost()) return
        if (!selfInVoice()) {
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
            return
        }
        openUpstream()
    }

    function sendFrame(bytes) {
        if (stopped) return false
        const wire = encodeFrame({ origin: selfId, seq: seq, data: bytes })
        if (!wire) {
            warnOversize(2 + Buffer.byteLength(selfId) + 4 + bytes.length)
            return false
        }
        seq = (seq + 1) >>> 0
        if (isHost()) {
            for (const e of members.values()) e.queue.push(wire)
            return true
        }
        if (!upstream) { openUpstream(); return false }
        upstream.queue.push(wire)
        return true
    }

    function peerLeft(peerId) {
        const entry = members.get(peerId)
        if (entry) {
            members.delete(peerId)
            closedDrops += entry.queue.drops
            closeEntry(entry)
        }
        if (peerId === hostId()) closeUpstream()
    }

    function stop() {
        stopped = true
        closeUpstream()
        for (const [peerId] of [...members]) peerLeft(peerId)
    }

    function stats() {
        let drops = closedDrops
        for (const e of members.values()) drops += e.queue.drops
        if (upstream) drops += upstream.queue.drops
        return { drops, droppedOversize, droppedOrigin, streams: members.size + (upstream ? 1 : 0) }
    }

    return { handle, sendFrame, hostChanged, peerLeft, stop, stats }
}
