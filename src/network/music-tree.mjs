// Tree-forwarded room music stream controller (music-fanout.mjs + libp2p streams).
// Keeps 1.0.9 compatibility by tracking legacy listeners that lack musicFanout capability.
import { decodeBody, encodeFrame, MAX_BODY, MAX_QUEUE } from './voice-relay.mjs'
import { createMusicFanout, createMusicForwarder, MUSIC_FANOUT_DEFAULTS } from './music-fanout.mjs'

export const MUSIC_FANOUT_PROTOCOL = '/asscrack/music-fanout/1.0.0'
const ATTACH_TIMEOUT_MS = 8000

function createByteQueue() {
    const items = []
    let wake = null
    let ended = false
    return {
        push(buf) {
            if (ended) return
            items.push(buf)
            while (items.length > MAX_QUEUE) items.shift()
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
}

async function readFrames(source, onBody, onOversize) {
    let buf = Buffer.alloc(0)
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

export function createMusicTree({
    libp2p,
    selfId,
    sendLine,
    broadcastLine,
    connectionFor,
    voicePeers,
    channelOf,
    selfChannel,
    inVoice = () => false,
    deafened = () => false,
    memberAllowed = () => true,
    isCapable = () => false,
    getTopology = () => null,
    onFrame = () => {},
    onEdgesChanged = () => {},
    musicFanoutOptions = {},
    forwardingCap: initialCap = MUSIC_FANOUT_DEFAULTS.defaultMaxChildren
}) {
    let activeDj = null
    let activeChannel = null
    let assignedParent = null
    let inboundStream = null
    let attachTimer = null
    let fanout = null
    let forwarder = null
    let latestEdges = []
    let seq = 0
    let received = 0
    let failovers = 0
    let stopped = false
    let forwardingCap = initialCap

    // childPeerId -> { queue, stream, channel, closed }
    const childStreams = new Map()

    function clearAttachTimer() {
        if (attachTimer) {
            clearTimeout(attachTimer)
            attachTimer = null
        }
    }

    function sendCtrl(peerId, op, data = {}) {
        if (stopped || !peerId) return false
        return sendLine(peerId, { type: 'music-fanout', v: 1, op, channel: activeChannel, ...data })
    }

    function broadcastTree() {
        if (stopped || activeDj !== selfId || !fanout) return
        const nextEdges = fanout.edges().map(e => ({
            from: e.parentPeerId,
            to: e.childPeerId,
            dj: selfId
        }))
        latestEdges = nextEdges
        broadcastLine({ type: 'music-fanout', v: 1, op: 'tree', channel: activeChannel, dj: selfId, edges: nextEdges })
        onEdgesChanged()
    }

    function closeChild(childId) {
        const entry = childStreams.get(childId)
        if (!entry) return
        entry.closed = true
        childStreams.delete(childId)
        entry.queue.end()
        try { entry.stream?.close?.() } catch {}
        forwarder?.removeChild(childId)
    }

    function closeAllChildren() {
        for (const childId of [...childStreams.keys()]) closeChild(childId)
    }

    function closeInbound() {
        clearAttachTimer()
        const s = inboundStream
        inboundStream = null
        if (s) {
            try { s.close?.() } catch {}
        }
    }

    function resetForwarder() {
        closeAllChildren()
        forwarder = createMusicForwarder({
            maxQueueFrames: musicFanoutOptions?.maxChildQueueFrames ?? MUSIC_FANOUT_DEFAULTS.maxChildQueueFrames,
            dedupWindow: musicFanoutOptions?.dedupWindow ?? MUSIC_FANOUT_DEFAULTS.dedupWindow,
            allowed: childId => !stopped && activeChannel !== null &&
                memberAllowed(childId) && !deafened(childId) && channelOf(childId) === activeChannel,
            onRevoked: childId => closeChild(childId)
        })
    }

    function sendJoin() {
        if (stopped || !activeDj || activeDj === selfId || !activeChannel) return
        if (!inVoice() || selfChannel() !== activeChannel) return
        sendCtrl(activeDj, 'join', { maxChildren: forwardingCap })
    }

    function triggerFailover(failedParent) {
        if (stopped || !activeDj || activeDj === selfId || !activeChannel) return
        if (assignedParent !== failedParent) return
        assignedParent = null
        closeInbound()
        failovers++
        sendCtrl(activeDj, 'fail', { parent: failedParent })
        sendJoin()
    }

    function scheduleAttachTimeout(parentId) {
        clearAttachTimer()
        attachTimer = setTimeout(() => {
            attachTimer = null
            if (!stopped && assignedParent === parentId && !inboundStream) {
                triggerFailover(parentId)
            }
        }, ATTACH_TIMEOUT_MS)
        attachTimer.unref?.()
    }

    async function attachChild(childId, channel) {
        if (stopped || !activeDj || !activeChannel || channel !== activeChannel) return
        if (!memberAllowed(childId) || deafened(childId) || channelOf(childId) !== activeChannel) return
        if (!forwarder) resetForwarder()
        closeChild(childId)

        const conn = connectionFor(childId)
        if (!conn) {
            if (activeDj === selfId && fanout) {
                fanout.reportFailure(childId, selfId)
                broadcastTree()
            }
            return
        }

        const queue = createByteQueue()
        const entry = { queue, stream: null, channel, closed: false }
        childStreams.set(childId, entry)

        const added = forwarder.addChild(childId, {
            send: frame => {
                if (entry.closed) return false
                queue.push(frame.buf)
                return true
            }
        })
        if (!added.ok) {
            closeChild(childId)
            return
        }

        try {
            const stream = await conn.newStream(MUSIC_FANOUT_PROTOCOL, { runOnTransientConnection: true })
            if (entry.closed || stopped || activeChannel !== channel) {
                try { stream.close?.() } catch {}
                return
            }
            entry.stream = stream
            ;(async () => {
                try {
                    await stream.sink(queue.source())
                } catch {}
                if (!entry.closed) closeChild(childId)
            })()
            if (activeDj !== selfId) {
                sendCtrl(activeDj, 'confirm', { child: childId })
            }
        } catch {
            closeChild(childId)
            if (activeDj === selfId && fanout) {
                fanout.reportFailure(childId, selfId)
                broadcastTree()
            }
        }
    }

    function sendAssign(peerId, dec) {
        if (!dec || dec.action === 'reject') return
        sendCtrl(peerId, 'assign', { parent: dec.parentPeerId, hop: dec.hop })
        if (dec.action === 'direct') {
            attachChild(peerId, activeChannel)
            broadcastTree()
        }
    }

    function djChanged(djPeerId, channelId) {
        const nextDj = typeof djPeerId === 'string' && djPeerId ? djPeerId : null
        const nextChan = nextDj && typeof channelId === 'string' && channelId ? channelId : null
        if (nextDj === activeDj && nextChan === activeChannel) return

        closeInbound()
        assignedParent = null
        fanout = null
        activeDj = nextDj
        activeChannel = nextChan
        if (latestEdges.length > 0) {
            latestEdges = []
            onEdgesChanged()
        }

        if (!activeDj || !activeChannel) {
            closeAllChildren()
            forwarder = null
            return
        }

        resetForwarder()

        if (activeDj === selfId) {
            fanout = createMusicFanout({
                djPeerId: selfId,
                channelId: activeChannel,
                getTopology,
                ...musicFanoutOptions
            })
        } else {
            sendJoin()
        }
    }

    function sendFrame(bytes) {
        if (stopped || activeDj !== selfId || !activeChannel || !forwarder) return false
        const s = seq++
        const encoded = encodeFrame({ origin: selfId, seq: s, data: bytes })
        if (!encoded) return false
        forwarder.pushFrame({ origin: selfId, seq: s, buf: encoded })
        return true
    }

    function handleLine(peerId, msg) {
        if (stopped || !msg || msg.type !== 'music-fanout' || msg.v !== 1) return
        if (!memberAllowed(peerId)) return

        if (msg.op === 'tree') {
            if (peerId !== activeDj || msg.channel !== activeChannel || !Array.isArray(msg.edges)) return
            const clean = []
            for (const e of msg.edges) {
                if (e && typeof e.from === 'string' && typeof e.to === 'string' && e.from && e.to && e.from !== e.to) {
                    clean.push({ from: e.from, to: e.to, dj: activeDj })
                }
            }
            latestEdges = clean
            onEdgesChanged()
            return
        }

        if (msg.channel !== activeChannel) return

        if (msg.op === 'join' && activeDj === selfId && fanout) {
            if (deafened(peerId) || channelOf(peerId) !== activeChannel) return
            const maxChildren = Number.isInteger(msg.maxChildren) ? msg.maxChildren : undefined
            const dec = fanout.requestJoin(peerId, { capable: true, maxChildren })
            sendAssign(peerId, dec)
            return
        }

        if (msg.op === 'confirm' && activeDj === selfId && fanout) {
            if (typeof msg.child !== 'string' || !msg.child) return
            const res = fanout.confirmChild(peerId, msg.child)
            if (res.ok) broadcastTree()
            return
        }

        if (msg.op === 'fail' && activeDj === selfId && fanout) {
            if (typeof msg.parent !== 'string' || !msg.parent) return
            fanout.reportFailure(peerId, msg.parent)
            broadcastTree()
            return
        }

        if (msg.op === 'assign' && peerId === activeDj && activeDj !== selfId) {
            if (typeof msg.parent !== 'string' || !msg.parent) return
            closeInbound()
            assignedParent = msg.parent
            if (assignedParent !== activeDj) {
                sendCtrl(assignedParent, 'attach', { dj: activeDj })
            }
            scheduleAttachTimeout(assignedParent)
            return
        }

        if (msg.op === 'attach') {
            if (!activeDj && typeof msg.dj === 'string' && msg.dj && msg.channel === selfChannel() && inVoice()) {
                djChanged(msg.dj, msg.channel)
            }
            if (!activeDj || channelOf(peerId) !== activeChannel || deafened(peerId)) return
            if (forwardingCap <= 0 && activeDj !== selfId) return
            attachChild(peerId, msg.channel)
        }
    }

    async function handleStream({ stream, connection }) {
        const fromPeer = connection.remotePeer.toString()
        if (stopped || !activeDj || activeDj === selfId || !activeChannel) {
            stream.abort?.(new Error('Music fanout is not active'))
            return
        }
        if (assignedParent !== null && fromPeer !== assignedParent) {
            stream.abort?.(new Error('Unexpected music fanout parent'))
            return
        }
        if (assignedParent === null && fromPeer !== activeDj) {
            stream.abort?.(new Error('Unexpected music fanout parent'))
            return
        }

        clearAttachTimer()
        if (inboundStream && inboundStream !== stream) {
            try { inboundStream.close?.() } catch {}
        }
        assignedParent = fromPeer
        inboundStream = stream

        try {
            await readFrames(
                stream.source,
                body => {
                    if (stopped || inboundStream !== stream) return
                    const decoded = decodeBody(body)
                    if (!decoded || decoded.origin !== activeDj) return
                    received++
                    if (!deafened(selfId) && inVoice() && selfChannel() === activeChannel) {
                        onFrame({ peerId: decoded.origin, channel: activeChannel, data: decoded.data })
                    }
                    if (forwarder) {
                        const encoded = encodeFrame({ origin: decoded.origin, seq: decoded.seq, data: decoded.data })
                        if (encoded) {
                            forwarder.pushFrame({ origin: decoded.origin, seq: decoded.seq, buf: encoded })
                        }
                    }
                },
                () => {
                    try { stream.abort?.(new Error('Oversize music frame')) } catch {}
                }
            )
        } catch {}

        if (inboundStream === stream) {
            inboundStream = null
            if (!stopped && activeDj && activeDj !== selfId && assignedParent === fromPeer &&
                inVoice() && selfChannel() === activeChannel) {
                triggerFailover(fromPeer)
            }
        }
    }

    function peerLeft(peerId) {
        closeChild(peerId)
        if (activeDj === selfId && fanout) {
            const { removed, orphaned } = fanout.removePeer(peerId)
            if (removed) {
                if (orphaned.length > 0) {
                    const decisions = fanout.reparent(orphaned, id => ({
                        capable: isCapable(id)
                    }))
                    for (const { peerId: childId, decision } of decisions) {
                        sendAssign(childId, decision)
                    }
                }
                broadcastTree()
            }
            return
        }
        if (assignedParent === peerId && activeDj && activeDj !== selfId && inVoice() && selfChannel() === activeChannel) {
            triggerFailover(peerId)
        }
    }

    function channelChanged() {
        if (activeDj && activeDj !== selfId) {
            closeInbound()
            closeAllChildren()
            assignedParent = null
            if (inVoice() && selfChannel() === activeChannel) {
                sendJoin()
            }
        }
    }

    function setForwardingCap(cap) {
        const next = Number.isInteger(cap) ? Math.max(0, cap) : 0
        forwardingCap = next
        if (next === 0) closeAllChildren()
        if (activeDj === selfId && fanout) {
            for (const id of [...childStreams.keys()]) {
                fanout.setForwardingCap(id, next)
            }
        }
    }

    function hasLegacyListeners() {
        if (!activeChannel) return false
        for (const peerId of voicePeers()) {
            if (peerId === selfId) continue
            if (!memberAllowed(peerId) || deafened(peerId)) continue
            if (channelOf(peerId) !== activeChannel) continue
            if (!isCapable(peerId)) return true
        }
        return false
    }

    function stop() {
        stopped = true
        closeInbound()
        closeAllChildren()
        fanout = null
        forwarder = null
        latestEdges = []
        activeDj = null
        activeChannel = null
        assignedParent = null
    }

    return {
        handleLine,
        handleStream,
        sendFrame,
        djChanged,
        peerLeft,
        channelChanged,
        setForwardingCap,
        hasLegacyListeners,
        musicEdges: () => [...latestEdges],
        parentPeer: () => assignedParent,
        stats: () => ({
            activeDj,
            activeChannel,
            parent: assignedParent,
            children: forwarder ? forwarder.childIds() : [],
            received,
            failovers,
            edges: latestEdges.length,
            forwarder: forwarder ? forwarder.stats() : null,
            tree: fanout ? fanout.stats() : null
        }),
        stop
    }
}
