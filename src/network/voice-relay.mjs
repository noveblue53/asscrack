// Voice over libp2p streams, star topology with direct streams.
// A member in voice opens one duplex stream to the host. The host forwards each frame to the other voice streams.
// A member also opens one direct stream to each voice peer with a direct connection (VOICE_DIRECT_PROTOCOL).
// The member reports these peers in the 'direct' field of its voice line. The host does not forward a frame of
// that member to a peer in that list.
// Wire: 4-byte big-endian length, then the body.
// Body: version (1), origin length N, N bytes origin (UTF-8), 4-byte big-endian sequence number, Opus bytes.

export const VOICE_PROTOCOL = '/asscrack/voice/1.0.0'
// Frames from one peer to one peer. The receiver delivers each frame and never forwards it.
export const VOICE_DIRECT_PROTOCOL = '/asscrack/voice-direct/1.0.0'
// The size of the window of sequence numbers for each origin, to drop duplicate frames.
const DEDUP_WINDOW = 64
export const MAX_BODY = 4000
export const MAX_QUEUE = 50
const VERSION = 1
const RETRY_MS = 1000
const MAX_RETRIES = 5
// A closed direct stream opens again after this delay, at most MAX_DIRECT_REOPENS times in a row for each peer.
const DIRECT_REOPEN_MS = 1000
const MAX_DIRECT_REOPENS = 5
// A direct stream that was open this long resets the count of reopens.
const DIRECT_STABLE_MS = 10000
// The host counts forwarded frames for at most this number of origins, and of targets for each origin.
export const MAX_FORWARD_PEERS = 64
// Maximum number of Full Node voice relays in the sharded relay pool.
export const MAX_VOICE_RELAYS = 8
// G6 (D6): after a change of its own voice channel, this node sends no frame for this time. The new voice line can
// arrive after the first frames; the receivers drop the frames that are already in flight.
export const MOVE_HOLD_MS = 250

function hashRelayPair(originId, relayId) {
    const key = `${originId}\0${relayId}`
    let h = 2166136261
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i)
        h = Math.imul(h, 16777619) >>> 0
    }
    h ^= h >>> 16
    h = Math.imul(h, 0x85ebca6b) >>> 0
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35) >>> 0
    h ^= h >>> 16
    return h >>> 0
}

// Deterministic Rendezvous Hashing (HRW) to shard a sender onto one relay in `relayIds`.
export function pickVoiceRelay(originId, relayIds) {
    if (!Array.isArray(relayIds) || relayIds.length === 0) return null
    if (relayIds.length === 1) return relayIds[0]
    let best = null
    let bestScore = -1
    for (const relayId of relayIds) {
        if (typeof relayId !== 'string' || !relayId) continue
        const score = hashRelayPair(originId, relayId)
        if (best === null || score > bestScore || (score === bestScore && relayId < best)) {
            best = relayId
            bestScore = score
        }
    }
    return best
}

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

// directCandidates(): the peer IDs to open a direct stream to (voice peers with a direct session connection).
// directListOf(peerId): the last valid 'direct' list of that peer, or null.
// onDirectChanged(): called when the list of working direct streams of this node changes.
// channelOf(peerId), selfChannel(): the voice channel of a peer and of this node (G6). The host forwards a frame only
// to the members in the channel of its origin. While this node is in voice, it delivers only the frames of its channel.
// M4 (P10b): onReceiversChanged(): called when the set of members with a voice stream to this host changes (the host
// sends its voice roster). deafened(peerId): true when that member said in its voice line that it is deafened. The
// host forwards no frame to it.
// MU-2 (room music): protocol, directProtocol and label give a second relay with the same rules on its own streams
// (the music stream of the DJ). Its queues, sequence numbers, counters and events are separate from the voice relay.
export function createVoiceRelay({ libp2p, selfId, hostId, voicePeers, connectionFor, onFrame,
    directCandidates = () => [], directListOf = () => null, onDirectChanged = () => {}, protectedRoom = false,
    channelOf = () => 'general', selfChannel = () => 'general', onReceiversChanged = () => {}, deafened = () => false,
    relayPool = null, canRelay = null, preferHostOnly = () => false,
    protocol = VOICE_PROTOCOL, directProtocol = VOICE_DIRECT_PROTOCOL, label = 'Voice' }) {
    // Relay side: peerId -> { stream, queue }.
    const members = new Map()
    // Member side: per-relay upstream streams, pending opens, retry counts, and retry timers.
    const upstreams = new Map()
    // Member side: relayId -> { queue } for stream opens in progress. Frames go into its queue until the
    // stream is ready, so that the frames of the first milliseconds are not lost.
    const upstreamPending = new Map()
    const upstreamRetries = new Map()
    const upstreamRetryTimers = new Map()
    let stopped = false
    let seq = 0
    let oversizeWarned = false
    let droppedOversize = 0
    let closedDrops = 0
    let droppedOrigin = 0
    let relayedSent = 0
    let lastPublishRelay = null
    // Member side: peerId -> { stream, queue } for the working outbound direct streams.
    const directOut = new Map()
    // Peers with a direct stream open in progress.
    const directPending = new Set()
    // Peers that refused the direct protocol (for example a 0.5.2 peer). Cleared when the peer leaves.
    const directRefused = new Set()
    // peerId -> number of reopens in a row, and peerId -> timer of the next reopen.
    const directReopens = new Map()
    const directReopenTimers = new Map()
    // Receiver side: the inbound direct streams.
    const directIn = new Set()
    // origin -> { set, order } of the last sequence numbers.
    const seen = new Map()
    let directSent = 0
    let directReceived = 0
    let duplicates = 0
    let forwarded = 0
    // origin -> target -> number of frames that the host forwarded.
    const forwardedTo = {}
    // G6: the end of the move hold (performance.now()), and the frames that the hold did not send.
    let holdUntil = 0
    let heldFrames = 0
    // The voice peers in the channel of this node at the last refreshDirect(): a peer that comes in gets a new try.
    let channelPeers = new Set()

    function warnOversize(len) {
        droppedOversize++
        if (!oversizeWarned) {
            oversizeWarned = true
            console.warn(`${label} frame dropped: body of ${len} bytes is above ${MAX_BODY}`)
        }
    }

    function isHost() {
        return hostId() === selfId
    }

    function isRelay() {
        return isHost() || Boolean(canRelay ? canRelay() : false)
    }

    function selfInVoice() {
        return voicePeers().includes(selfId)
    }

    function desiredRelays() {
        if (stopped || !selfInVoice()) return []
        const raw = relayPool ? relayPool() : (hostId() ? [hostId()] : [])
        const host = hostId()
        const set = new Set()
        if (Array.isArray(raw)) {
            for (const id of raw) {
                if (typeof id === 'string' && id && id !== selfId) set.add(id)
            }
        }
        const sorted = [...set].sort()
        if (sorted.length <= MAX_VOICE_RELAYS) return sorted
        const capped = sorted.slice(0, MAX_VOICE_RELAYS)
        if (host && host !== selfId && set.has(host) && !capped.includes(host)) {
            capped[MAX_VOICE_RELAYS - 1] = host
            capped.sort()
        }
        return capped
    }

    // Returns true when this frame (origin and sequence number) arrived before.
    function isDuplicate(frame) {
        let w = seen.get(frame.origin)
        if (!w) { w = { set: new Set(), order: [] }; seen.set(frame.origin, w) }
        if (w.set.has(frame.seq)) return true
        w.set.add(frame.seq)
        w.order.push(frame.seq)
        if (w.order.length > DEDUP_WINDOW) w.set.delete(w.order.shift())
        return false
    }

    function deliver(frame) {
        if (frame.origin === selfId) return
        // G6: in voice, only the frames of the own channel. Out of voice, as before (voice.js drops the frame).
        if (selfInVoice() && channelOf(frame.origin) !== selfChannel()) return
        if (isDuplicate(frame)) { duplicates++; return }
        try {
            onFrame(frame)
        } catch (err) {
            console.warn(`${label} onFrame failed:`, err?.message ?? err)
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
        onReceiversChanged()
        attach(stream, entry.queue, body => {
            const frame = decodeBody(body)
            if (!frame) return
            // A member must not send frames with the origin of another peer.
            if (frame.origin !== peerId) {
                droppedOrigin++
                if (!entry.originWarned) {
                    entry.originWarned = true
                    console.warn(`${label} frame dropped: origin ${frame.origin} is not the sender ${peerId}`)
                }
                return
            }
            const wire = Buffer.alloc(4 + body.length)
            wire.writeUInt32BE(body.length, 0)
            body.copy(wire, 4)
            // Do not forward to a peer that gets the frame on a direct stream from the origin, or to a peer in a
            // different voice channel.
            const direct = directListOf(peerId)
            const channel = channelOf(peerId)
            for (const [other, e] of members) {
                if (other === peerId || (Array.isArray(direct) && direct.includes(other)) || channelOf(other) !== channel ||
                    deafened(other)) continue
                e.queue.push(wire)
                forwarded++
                countForward(peerId, other)
            }
            deliver(frame)
        }, () => {
            if (members.get(peerId) === entry) {
                closedDrops += entry.queue.drops
                members.delete(peerId)
                onReceiversChanged()
            }
        })
    }

    // Counts one forwarded frame in forwardedTo. Keys above MAX_FORWARD_PEERS are not added.
    function countForward(origin, target) {
        let row = forwardedTo[origin]
        if (!row) {
            if (Object.keys(forwardedTo).length >= MAX_FORWARD_PEERS) return
            row = forwardedTo[origin] = {}
        }
        if (row[target] === undefined && Object.keys(row).length >= MAX_FORWARD_PEERS) return
        row[target] = (row[target] ?? 0) + 1
    }

    function forgetForward(peerId) {
        delete forwardedTo[peerId]
        for (const row of Object.values(forwardedTo)) delete row[peerId]
    }

    function closeEntry(entry) {
        entry.queue.end()
        entry.stream.close?.().catch?.(() => entry.stream.abort?.(new Error('closed')))
    }

    function clearRetry(relayId) {
        const timer = upstreamRetryTimers.get(relayId)
        if (timer) clearTimeout(timer)
        upstreamRetryTimers.delete(relayId)
        upstreamRetries.delete(relayId)
    }

    function closeUpstream(relayId) {
        clearRetry(relayId)
        const pending = upstreamPending.get(relayId)
        if (pending) {
            upstreamPending.delete(relayId)
            closedDrops += pending.queue.drops
            pending.queue.end()
        }
        const e = upstreams.get(relayId)
        if (e) {
            upstreams.delete(relayId)
            closedDrops += e.queue.drops
            closeEntry(e)
        }
        if (lastPublishRelay === relayId) lastPublishRelay = null
    }

    function closeAllUpstreams() {
        for (const relayId of [...upstreamRetryTimers.keys()]) clearRetry(relayId)
        for (const relayId of [...upstreamPending.keys()]) closeUpstream(relayId)
        for (const relayId of [...upstreams.keys()]) closeUpstream(relayId)
        upstreamRetries.clear()
        lastPublishRelay = null
    }

    async function openUpstream(relayId) {
        if (stopped || !relayId || relayId === selfId || !selfInVoice()) return
        if (!desiredRelays().includes(relayId)) return
        if (upstreams.has(relayId) || upstreamPending.has(relayId)) return
        const conn = connectionFor(relayId)
        if (!conn) { scheduleRetry(relayId); return }
        const pending = { queue: createQueue() }
        upstreamPending.set(relayId, pending)
        let stream
        try {
            stream = await conn.newStream(protocol, { runOnTransientConnection: true })
        } catch (err) {
            if (upstreamPending.get(relayId) === pending) {
                upstreamPending.delete(relayId)
                closedDrops += pending.queue.drops
                pending.queue.end()
            }
            console.warn(`${label} stream open failed:`, err?.message ?? err)
            scheduleRetry(relayId)
            return
        }
        if (upstreamPending.get(relayId) !== pending || stopped || !desiredRelays().includes(relayId) || upstreams.has(relayId) || !selfInVoice()) {
            if (upstreamPending.get(relayId) === pending) {
                upstreamPending.delete(relayId)
                closedDrops += pending.queue.drops
                pending.queue.end()
            }
            stream.abort?.(new Error('not needed'))
            return
        }
        upstreamPending.delete(relayId)
        upstreamRetries.delete(relayId)
        const entry = { stream, queue: pending.queue }
        upstreams.set(relayId, entry)
        refreshDirect()
        attach(stream, entry.queue, body => {
            const frame = decodeBody(body)
            if (!frame) return
            // M1 (P10a), item 3: the relay forwards the frames of the voice peers. A frame whose origin is not a voice
            // peer with a session (voicePeers) waits a short time (holdUnknown), then it is dropped.
            if (!voicePeers().includes(frame.origin)) {
                holdUnknown(frame)
                return
            }
            deliver(frame)
        }, () => {
            if (upstreams.get(relayId) !== entry) return
            upstreams.delete(relayId)
            closedDrops += entry.queue.drops
            if (lastPublishRelay === relayId) lastPublishRelay = null
            refreshDirect()
            scheduleRetry(relayId)
        })
    }

    function reconcileUpstreams() {
        const desired = desiredRelays()
        const desiredSet = new Set(desired)
        for (const relayId of [...upstreams.keys()]) {
            if (!desiredSet.has(relayId)) closeUpstream(relayId)
        }
        for (const relayId of [...upstreamPending.keys()]) {
            if (!desiredSet.has(relayId)) closeUpstream(relayId)
        }
        for (const relayId of [...upstreamRetryTimers.keys()]) {
            if (!desiredSet.has(relayId)) clearRetry(relayId)
        }
        for (const relayId of desired) {
            if (!upstreams.has(relayId) && !upstreamPending.has(relayId) && !upstreamRetryTimers.has(relayId)) {
                openUpstream(relayId)
            }
        }
    }

    function selectPublishRelay() {
        const desired = desiredRelays()
        if (desired.length === 0) return null
        if (preferHostOnly()) {
            const host = hostId()
            if (host && host !== selfId && (upstreams.has(host) || upstreamPending.has(host))) return host
        }
        const ready = desired.filter(id => upstreams.has(id))
        if (ready.length > 0) return pickVoiceRelay(selfId, ready)
        const pending = desired.filter(id => upstreamPending.has(id))
        if (pending.length > 0) return pickVoiceRelay(selfId, pending)
        return null
    }

    // M1 (P10a), item 3: the frames of an origin that is not a voice peer yet. The voice line of a peer goes on the chat
    // session with that peer, and the host can forward the first frames before it. Such frames wait at most
    // UNKNOWN_HOLD_MS (at most UNKNOWN_FRAMES for each origin, UNKNOWN_ORIGINS origins). releaseUnknown() delivers
    // the frames of an origin that is now a voice peer and drops the frames that waited too long.
    const UNKNOWN_HOLD_MS = 1000
    const UNKNOWN_FRAMES = 50
    const UNKNOWN_ORIGINS = 8
    const unknownOrigins = new Map()
    let unknownTimer = null
    function holdUnknown(frame) {
        let held = unknownOrigins.get(frame.origin)
        if (!held) {
            if (unknownOrigins.size >= UNKNOWN_ORIGINS) { droppedOrigin++; return }
            held = { since: performance.now(), frames: [] }
            unknownOrigins.set(frame.origin, held)
        }
        if (held.frames.length >= UNKNOWN_FRAMES) { droppedOrigin++; return }
        held.frames.push(frame)
        if (!unknownTimer) {
            unknownTimer = setTimeout(() => { unknownTimer = null; releaseUnknown() }, UNKNOWN_HOLD_MS / 4)
            unknownTimer.unref?.()
        }
    }
    function releaseUnknown() {
        if (unknownOrigins.size === 0) return
        const peers = voicePeers()
        const now = performance.now()
        for (const [origin, held] of [...unknownOrigins]) {
            if (peers.includes(origin)) {
                unknownOrigins.delete(origin)
                for (const frame of held.frames) deliver(frame)
            } else if (stopped || now - held.since >= UNKNOWN_HOLD_MS) {
                unknownOrigins.delete(origin)
                droppedOrigin += held.frames.length
            }
        }
        if (unknownOrigins.size > 0 && !unknownTimer && !stopped) {
            unknownTimer = setTimeout(() => { unknownTimer = null; releaseUnknown() }, UNKNOWN_HOLD_MS / 4)
            unknownTimer.unref?.()
        }
    }

    function scheduleRetry(relayId) {
        if (stopped || !relayId || upstreamRetryTimers.has(relayId) || !desiredRelays().includes(relayId)) return
        const count = upstreamRetries.get(relayId) ?? 0
        if (count >= MAX_RETRIES) return
        upstreamRetries.set(relayId, count + 1)
        const timer = setTimeout(() => {
            upstreamRetryTimers.delete(relayId)
            if (!stopped && desiredRelays().includes(relayId)) openUpstream(relayId)
        }, RETRY_MS)
        timer.unref?.()
        upstreamRetryTimers.set(relayId, timer)
    }

    // Receiver: a peer opened a direct voice stream. The caller makes sure that the peer has an open session.
    function handleDirect({ stream, connection }) {
        if (stopped) { stream.abort?.(new Error('stopped')); return }
        const peerId = connection.remotePeer.toString()
        const entry = { stream, peerId, originWarned: false }
        directIn.add(entry)
        // This side only reads. Do not close the write side: the sender reads the end of the stream as a close.
        readFrames(stream.source, body => {
            const frame = decodeBody(body)
            if (!frame) return
            if (frame.origin !== peerId) {
                droppedOrigin++
                if (!entry.originWarned) {
                    entry.originWarned = true
                    console.warn(`${label} frame dropped: origin ${frame.origin} is not the sender ${peerId} (direct)`)
                }
                return
            }
            directReceived++
            deliver(frame)
        }, warnOversize).catch(() => {}).finally(() => directIn.delete(entry))
    }

    // The peers with a working direct stream from this node.
    function directList() {
        return [...directOut.keys()]
    }

    function closeDirect(peerId) {
        const e = directOut.get(peerId)
        if (!e) return false
        directOut.delete(peerId)
        closedDrops += e.queue.drops
        closeEntry(e)
        return true
    }

    // Closes the inbound direct streams of one peer, or of all peers when peerId is undefined.
    function closeDirectIn(peerId) {
        for (const e of [...directIn]) {
            if (peerId !== undefined && e.peerId !== peerId) continue
            directIn.delete(e)
            e.stream.abort?.(new Error('closed'))
        }
    }

    function wantedDirect() {
        if (stopped || isHost() || !selfInVoice()) return []
        const pub = isRelay() ? hostId() : selectPublishRelay()
        // Do not open a direct stream to the selected publish relay (or a peer already sending to us as a relay).
        return directCandidates().filter(p => p !== selfId && p !== pub && !(isRelay() && members.has(p)))
    }

    async function openDirect(peerId) {
        const conn = connectionFor(peerId)
        if (!conn) return
        directPending.add(peerId)
        let stream
        try {
            stream = await conn.newStream(directProtocol, { runOnTransientConnection: true })
        } catch (err) {
            directPending.delete(peerId)
            // Do not try again for this session. The peer gets the frames through the host.
            directRefused.add(peerId)
            console.info(`${label} direct stream to ${peerId} not opened: ${err?.message ?? err}`)
            return
        }
        directPending.delete(peerId)
        if (stopped || directOut.has(peerId) || !wantedDirect().includes(peerId)) {
            stream.abort?.(new Error('not needed'))
            return
        }
        const entry = { stream, queue: createQueue(), openedAt: Date.now() }
        directOut.set(peerId, entry)
        attach(stream, entry.queue, () => {}, () => {
            // closeDirect() removes the entry first. Thus only a close that this node did not ask for comes here.
            if (directOut.get(peerId) !== entry) return
            directOut.delete(peerId)
            closedDrops += entry.queue.drops
            onDirectChanged()
            scheduleDirectReopen(peerId, Date.now() - entry.openedAt >= DIRECT_STABLE_MS)
        })
        onDirectChanged()
    }

    // Opens a closed direct stream again, with no host change (fault F4). A delay and a cap stop a fast loop.
    function scheduleDirectReopen(peerId, stable) {
        if (stopped || directReopenTimers.has(peerId)) return
        const count = stable ? 0 : (directReopens.get(peerId) ?? 0)
        if (count >= MAX_DIRECT_REOPENS) {
            console.info(`${label} direct stream to ${peerId} closed ${count} times: the peer gets the frames through the host`)
            return
        }
        directReopens.set(peerId, count + 1)
        const timer = setTimeout(() => {
            directReopenTimers.delete(peerId)
            if (!stopped) refreshDirect()
        }, DIRECT_REOPEN_MS)
        timer.unref?.()
        directReopenTimers.set(peerId, timer)
    }

    function clearDirectReopen(peerId) {
        const timer = directReopenTimers.get(peerId)
        if (timer) clearTimeout(timer)
        directReopenTimers.delete(peerId)
        directReopens.delete(peerId)
    }

    // Opens and closes the direct streams after a change of the voice peers, the host or the own voice state.
    function refreshDirect() {
        // G6: a peer that comes into the channel of this node gets a new try of the direct stream.
        const inChannel = new Set(selfInVoice() ? voicePeers().filter(p => p !== selfId && channelOf(p) === selfChannel()) : [])
        for (const peerId of inChannel) {
            if (channelPeers.has(peerId)) continue
            directRefused.delete(peerId)
            clearDirectReopen(peerId)
        }
        channelPeers = inChannel
        const wanted = wantedDirect()
        let changed = false
        for (const peerId of [...directOut.keys()]) if (!wanted.includes(peerId)) changed = closeDirect(peerId) || changed
        if (changed) onDirectChanged()
        for (const peerId of wanted) {
            if (directOut.has(peerId) || directPending.has(peerId) || directRefused.has(peerId)) continue
            openDirect(peerId)
        }
    }

    // Opens or closes the upstream streams and the direct streams, after a change of host, relay pool or voice state.
    function hostChanged() {
        // A voice line came (node.mjs calls hostChanged for each one): an origin can be a voice peer now.
        releaseUnknown()
        if (protectedRoom && !isRelay()) for (const peerId of [...members.keys()]) closeInboundVoice(peerId)
        if (protectedRoom && !selfInVoice()) closeDirectIn()
        // G6: no inbound direct stream from a peer in a different channel.
        for (const e of [...directIn]) if (channelOf(e.peerId) !== selfChannel()) closeDirectIn(e.peerId)
        reconcileUpstreams()
        refreshDirect()
    }

    // G6: the own channel changed. The move hold starts, and the direct streams follow the new channel.
    function channelChanged() {
        holdUntil = performance.now() + MOVE_HOLD_MS
        hostChanged()
    }

    function sendFrame(bytes) {
        if (stopped) return false
        // The move hold: the frame does not go out and does not use a sequence number.
        if (performance.now() < holdUntil) { heldFrames++; return false }
        const wire = encodeFrame({ origin: selfId, seq: seq, data: bytes })
        if (!wire) {
            warnOversize(2 + Buffer.byteLength(selfId) + 4 + bytes.length)
            return false
        }
        seq = (seq + 1) >>> 0
        // Returns true only when the frame went into at least one queue.
        if (isRelay()) {
            const channel = selfChannel()
            let pushed = 0
            for (const [peerId, e] of members) {
                if (channelOf(peerId) !== channel || deafened(peerId) || directOut.has(peerId)) continue
                e.queue.push(wire)
                pushed++
            }
            for (const e of directOut.values()) {
                e.queue.push(wire)
                directSent++
            }
            let pushedUpstream = false
            if (!isHost()) {
                const needHost = voicePeers().some(p => p !== selfId && channelOf(p) === channel &&
                    !deafened(p) && !members.has(p) && !directOut.has(p))
                if (needHost) {
                    reconcileUpstreams()
                    const host = hostId()
                    const q = host ? (upstreams.get(host)?.queue ?? upstreamPending.get(host)?.queue) : undefined
                    if (q) {
                        q.push(wire)
                        relayedSent++
                        pushedUpstream = true
                    }
                }
            }
            return pushed > 0 || directOut.size > 0 || pushedUpstream
        }
        for (const e of directOut.values()) {
            e.queue.push(wire)
            directSent++
        }
        reconcileUpstreams()
        const target = selectPublishRelay()
        const q = target ? (upstreams.get(target)?.queue ?? upstreamPending.get(target)?.queue) : undefined
        if (q) {
            q.push(wire)
            relayedSent++
            lastPublishRelay = target
        }
        return directOut.size > 0 || q !== undefined
    }

    function closeInboundVoice(peerId) {
        const entry = members.get(peerId)
        if (entry) {
            members.delete(peerId)
            closedDrops += entry.queue.drops
            closeEntry(entry)
            onReceiversChanged()
        }
        closeDirectIn(peerId)
    }

    function peerLeft(peerId) {
        closeInboundVoice(peerId)
        closeUpstream(peerId)
        directRefused.delete(peerId)
        clearDirectReopen(peerId)
        forgetForward(peerId)
        seen.delete(peerId)
        if (closeDirect(peerId)) onDirectChanged()
        refreshDirect()
    }

    function stop() {
        stopped = true
        clearTimeout(unknownTimer)
        unknownTimer = null
        releaseUnknown()
        for (const peerId of [...directReopenTimers.keys()]) clearDirectReopen(peerId)
        closeAllUpstreams()
        for (const [peerId] of [...members]) peerLeft(peerId)
        for (const peerId of [...directOut.keys()]) closeDirect(peerId)
        closeDirectIn()
    }

    function stats() {
        let drops = closedDrops
        for (const e of members.values()) drops += e.queue.drops
        for (const e of upstreams.values()) drops += e.queue.drops
        for (const e of upstreamPending.values()) drops += e.queue.drops
        for (const e of directOut.values()) drops += e.queue.drops
        return {
            drops, droppedOversize, droppedOrigin, streams: members.size + upstreams.size,
            directSent, directReceived, directStreams: directOut.size, directIn: directIn.size,
            forwarded, forwardedTo: JSON.parse(JSON.stringify(forwardedTo)), duplicates, heldFrames,
            relayPool: desiredRelays(), upstreamRelays: [...upstreams.keys()],
            publishRelay: isRelay() ? null : selectPublishRelay(), relayedSent,
            // The sequence number of the next own frame.
            seq
        }
    }

    // M4 (P10b): the members with a voice stream to this host (the receivers of the forwarded frames).
    const receivers = () => [...members.keys()]

    return { handle, handleDirect, directList, receivers, sendFrame, hostChanged, channelChanged, closeInboundVoice, peerLeft, stop, stats }
}
