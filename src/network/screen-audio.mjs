// Companion audio stream for screen sharing: `/asscrack/screen-audio/1.0.0`.
// Kept on a separate libp2p stream from `/asscrack/screen/1.0.0` so large video keyframes never head-of-line block
// 20 ms Opus audio packets, muted viewers can close the stream to save bandwidth, and 1.0.1-1.0.6 peers stay untouched.
// Session 5: routes through the video fanout parent when available, and keeps upstream audio open on forwarders with
// active audio children while suppressing local playback when muted/deafened/volume-0.
import { roomRateLimit } from './room-rate-limit.mjs'
import { readRecords, record, SCREEN_END } from './screen-share.mjs'

export const SCREEN_AUDIO_PROTOCOL = '/asscrack/screen-audio/1.0.0'
export const SCREEN_AUDIO_TYPE = Object.freeze({ LISTEN: 1, AUDIO: 2, END: 3 })
export const MAX_SCREEN_AUDIO_BYTES = 4000
export const MAX_LISTEN_RECORD = 256
export const MAX_AUDIO_RECORD = 1 + 4 + MAX_SCREEN_AUDIO_BYTES

const END_NAME = Object.fromEntries(Object.entries(SCREEN_END).map(([name, code]) => [code, name]))

export const SCREEN_AUDIO_DEFAULTS = Object.freeze({
    maxListeners: 24,
    listenRecordMs: 5000,
    opensPerPeer: 12,
    opensPerRoom: 192,
    closeWaitMs: 5000,
    failoverFallbackMs: 1500,
    failoverMaxAttempts: 5,
    failoverWindowMs: 10000
})

const jsonRecord = (type, value) => record(type, new TextEncoder().encode(JSON.stringify(value)))
const endRecord = reason => record(SCREEN_AUDIO_TYPE.END, Uint8Array.of(SCREEN_END[reason] ?? SCREEN_END.stopped))

function audioRecord(seq, data) {
    const out = new Uint8Array(5 + 4 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, 1 + 4 + data.length)
    out[4] = SCREEN_AUDIO_TYPE.AUDIO
    view.setUint32(5, seq >>> 0)
    out.set(data, 9)
    return out
}

function parseJson(body, max) {
    if (body.length > max) return null
    try {
        const value = JSON.parse(body.toString('utf8'))
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch { return null }
}

function abortStream(stream, reason) {
    try { stream?.abort?.(new Error(reason)) } catch { /* closed */ }
}

export function createScreenAudio({
    events, allowed, connectionFor, getOwnShare, getPeerShare,
    getVideoWatch = () => null, isForwarderChild = () => false,
    idle = () => false, options = {}
}) {
    const O = { ...SCREEN_AUDIO_DEFAULTS, ...options }
    const allowOpen = roomRateLimit(O.opensPerPeer, O.opensPerRoom)
    const ownListeners = new Map() // peerId -> { stream, shareId, waiting, dropped }
    const forwardListeners = new Map() // peerId -> { stream, shareId, waiting, dropped }
    const pending = new Set()
    const closing = new Set()
    let seq = 0
    let watch = null
    let stopped = false

    function closeStream(stream) {
        if (!stream) return
        const done = closeWithTimeout(stream).finally(() => closing.delete(done))
        closing.add(done)
    }
    async function closeWithTimeout(stream) {
        let timer
        try {
            await Promise.race([
                Promise.resolve(stream.close()),
                new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('close timeout')), O.closeWaitMs) })
            ])
        } catch { abortStream(stream, 'screen audio stream closed') } finally { clearTimeout(timer) }
    }

    function sendPacketToMap(map, pkt, isValidEntry, endFn) {
        for (const [peerId, entry] of [...map]) {
            if (!isValidEntry(peerId, entry)) {
                endFn(peerId, 'refused', entry.stream)
                continue
            }
            if (entry.waiting) {
                entry.dropped++
                continue
            }
            try {
                const ok = entry.stream.send(pkt)
                if (ok === false) {
                    entry.waiting = true
                    Promise.resolve(entry.stream.onDrain?.()).then(() => { entry.waiting = false }, () => { entry.waiting = false })
                }
            } catch {
                endFn(peerId, 'error', entry.stream)
            }
        }
    }

    // ---- Sharer & forwarder listener management ----

    function endOwnListener(peerId, reason, stream = ownListeners.get(peerId)?.stream) {
        if (ownListeners.get(peerId)?.stream === stream) ownListeners.delete(peerId)
        try { stream?.send(endRecord(reason)) } catch { /* closed */ }
        closeStream(stream)
    }

    function endForwardListener(peerId, reason, stream = forwardListeners.get(peerId)?.stream) {
        if (forwardListeners.get(peerId)?.stream === stream) forwardListeners.delete(peerId)
        try { stream?.send(endRecord(reason)) } catch { /* closed */ }
        closeStream(stream)
    }

    function stopForwardListeners(reason = 'stopped') {
        const wire = reason === 'isolated' || reason === 'limit' ? 'stopped' : reason
        for (const [peerId, entry] of [...forwardListeners]) endForwardListener(peerId, wire, entry.stream)
    }

    function maybeCloseIdleUpstream() {
        if (forwardListeners.size > 0 || !watch || watch.done || watch.localListening) return
        const w = watch
        const stream = w.stream
        finishWatch(w, 'unwatched')
        abortStream(stream, 'unwatched')
    }

    function handleStream({ stream, connection }) {
        const peerId = connection.remotePeer.toString()
        if (stopped || !allowed(peerId) || !allowOpen(peerId)) {
            abortStream(stream, 'Screen audio stream is not authorized')
            return
        }
        let state = 'open'
        let role = null
        pending.add(stream)
        const refuse = reason => {
            state = 'closed'
            pending.delete(stream)
            try { stream.send(endRecord(reason)) } catch { /* closed */ }
            closeStream(stream)
        }
        const listenTimer = setTimeout(() => {
            if (state === 'open') {
                state = 'closed'
                pending.delete(stream)
                abortStream(stream, 'no LISTEN record')
            }
        }, O.listenRecordMs)
        const onRecord = (type, body) => {
            if (state !== 'open') return
            if (type !== SCREEN_AUDIO_TYPE.LISTEN) return
            clearTimeout(listenTimer)
            pending.delete(stream)
            const value = parseJson(body, MAX_LISTEN_RECORD)
            const own = getOwnShare()
            if (own && own.audio && value?.v === 1 && value.shareId === own.shareId && !idle() && allowed(peerId)) {
                const old = ownListeners.get(peerId)
                if (!old && ownListeners.size >= O.maxListeners) return refuse('full')
                if (old) endOwnListener(peerId, 'replaced', old.stream)
                ownListeners.set(peerId, { stream, shareId: own.shareId, waiting: false, dropped: 0 })
                role = 'own'
                state = 'listening'
                return
            }
            const vWatch = getVideoWatch()
            const peerShare = vWatch ? getPeerShare(vWatch.peerId) : null
            if (!vWatch || !peerShare || !peerShare.audio || value?.v !== 1 || value.shareId !== vWatch.shareId ||
                peerShare.shareId !== vWatch.shareId || !isForwarderChild(peerId, vWatch.shareId) || idle() || !allowed(peerId)) {
                return refuse('refused')
            }
            const old = forwardListeners.get(peerId)
            if (!old && forwardListeners.size >= O.maxListeners) return refuse('full')
            if (old) endForwardListener(peerId, 'replaced', old.stream)
            forwardListeners.set(peerId, { stream, shareId: vWatch.shareId, waiting: false, dropped: 0 })
            role = 'forward'
            state = 'listening'
            if (!watch || watch.done || watch.peerId !== vWatch.peerId || watch.shareId !== vWatch.shareId) {
                openUpstreamAudio({ peerId: vWatch.peerId, shareId: vWatch.shareId, localListening: false, onDemand: true })
                    .catch(() => { stopForwardListeners('error') })
            }
        }
        readRecords(stream.source ?? stream, onRecord, MAX_LISTEN_RECORD)
            .catch(() => abortStream(stream, 'screen audio record is not valid'))
            .finally(() => {
                clearTimeout(listenTimer)
                pending.delete(stream)
                state = 'closed'
                if (role === 'own' && ownListeners.get(peerId)?.stream === stream) ownListeners.delete(peerId)
                if (role === 'forward' && forwardListeners.get(peerId)?.stream === stream) {
                    forwardListeners.delete(peerId)
                    maybeCloseIdleUpstream()
                }
            })
    }

    function sendScreenAudioFrame(data) {
        const own = getOwnShare()
        if (stopped || !own || !own.audio) return false
        if (!(data instanceof Uint8Array) || data.length < 1 || data.length > MAX_SCREEN_AUDIO_BYTES) return false
        if (ownListeners.size === 0) return true
        const pkt = audioRecord(++seq, data)
        sendPacketToMap(ownListeners, pkt, (peerId, entry) => entry.shareId === own.shareId && allowed(peerId), endOwnListener)
        return true
    }

    function forwardAudioRecord(w, body) {
        if (stopped || forwardListeners.size === 0 || w.done || watch !== w) return
        const pkt = record(SCREEN_AUDIO_TYPE.AUDIO, body)
        sendPacketToMap(
            forwardListeners,
            pkt,
            (peerId, entry) => entry.shareId === w.shareId && allowed(peerId) && isForwarderChild(peerId, w.shareId),
            endForwardListener
        )
        maybeCloseIdleUpstream()
    }

    function stopOwn(reason = 'stopped') {
        const wire = reason === 'isolated' || reason === 'limit' ? 'stopped' : reason
        for (const [peerId, entry] of [...ownListeners]) endOwnListener(peerId, wire, entry.stream)
        for (const stream of [...pending]) {
            pending.delete(stream)
            try { stream.send(endRecord(wire)) } catch { /* closed */ }
            closeStream(stream)
        }
        seq = 0
    }

    // ---- Viewer & upstream fanout side ----

    function finishWatch(w, reason) {
        if (w.done) return
        w.done = true
        clearTimeout(w.failoverTimer)
        w.failoverTimer = null
        if (watch === w) watch = null
        const user = reason === 'unwatched' || reason === 'switched'
        const hadLocal = w.localListening
        w.localListening = false
        const childWire = user ? 'stopped' : (reason === 'refused' || reason === 'full' ? 'error' : reason)
        stopForwardListeners(childWire)
        if (!user && hadLocal) events.emit('screen-audio-ended', { peerId: w.peerId, shareId: w.shareId, reason })
    }

    function resolveTargetPeer(peerId, shareId) {
        const vWatch = getVideoWatch()
        if (vWatch && vWatch.peerId === peerId && vWatch.shareId === shareId && vWatch.parentPeerId) {
            return vWatch.parentPeerId
        }
        return peerId
    }

    function triggerAudioFailover(w, reason) {
        if (w.done || watch !== w || stopped || idle()) return
        if (!w.localListening && forwardListeners.size === 0) {
            finishWatch(w, 'unwatched')
            return
        }
        const share = getPeerShare(w.peerId)
        if (!share || !share.audio || share.shareId !== w.shareId || !connectionFor(w.peerId) || !allowed(w.peerId)) {
            finishWatch(w, reason)
            return
        }
        const now = Date.now()
        if (w.failoverStartedAt === null || (now - w.failoverStartedAt) > O.failoverWindowMs) {
            w.failoverStartedAt = now
            w.failoverAttempts = 0
        }
        w.failoverAttempts++
        if (w.failoverAttempts > O.failoverMaxAttempts) {
            finishWatch(w, reason)
            return
        }
        const vWatch = getVideoWatch()
        if (vWatch && vWatch.peerId === w.peerId && vWatch.shareId === w.shareId &&
            vWatch.parentPeerId && vWatch.parentPeerId !== w.failedParent) {
            connectAudio(w, vWatch.parentPeerId).catch(() => {})
            return
        }
        if (reason === 'error' || reason === 'refused' || reason === 'full') {
            connectAudio(w, w.peerId).catch(() => {})
            return
        }
        w.reparenting = true
        clearTimeout(w.failoverTimer)
        w.failoverTimer = setTimeout(() => {
            w.failoverTimer = null
            if (w.done || watch !== w || stopped || idle()) return
            connectAudio(w, w.peerId).catch(() => {})
        }, O.failoverFallbackMs)
        w.failoverTimer.unref?.()
    }

    async function connectAudio(w, targetPeerId, { timeoutMs } = {}) {
        if (w.done || watch !== w || stopped || idle()) return
        const gen = ++w.streamGen
        w.targetPeerId = targetPeerId
        const connection = connectionFor(targetPeerId)
        if (!connection) {
            if (targetPeerId !== w.peerId) {
                w.failedParent = targetPeerId
                return connectAudio(w, w.peerId, { timeoutMs })
            }
            finishWatch(w, 'lost')
            throw new Error('No session with this member.')
        }
        let stream
        let openTimer
        try {
            const openPromise = connection.newStream(SCREEN_AUDIO_PROTOCOL, { runOnTransientConnection: true })
            stream = timeoutMs
                ? await Promise.race([
                    openPromise,
                    new Promise((_, reject) => {
                        openTimer = setTimeout(() => reject(new Error('Screen audio stream open timeout.')), timeoutMs)
                    })
                ])
                : await openPromise
        } catch (err) {
            if (w.done || gen !== w.streamGen) return
            if (targetPeerId !== w.peerId) {
                w.failedParent = targetPeerId
                return connectAudio(w, w.peerId, { timeoutMs })
            }
            finishWatch(w, 'error')
            throw err
        } finally {
            clearTimeout(openTimer)
        }
        if (w.done || gen !== w.streamGen) {
            abortStream(stream, 'screen audio watch stopped')
            return
        }
        w.stream = stream
        try { stream.send(jsonRecord(SCREEN_AUDIO_TYPE.LISTEN, { v: 1, shareId: w.shareId })) } catch { /* read loop ends */ }
        const onRecord = (type, body) => {
            if (w.done || gen !== w.streamGen) return
            if (type === SCREEN_AUDIO_TYPE.AUDIO) {
                if (body.length < 5) throw new Error('AUDIO record is too short')
                const frameSeq = body.readUInt32BE(0)
                w.frames++
                w.bytes += body.length - 4
                w.reparenting = false
                w.failedParent = null
                w.failoverAttempts = 0
                w.failoverStartedAt = null
                if (w.localListening) {
                    events.emit('screen-audio-frame', {
                        peerId: w.peerId, shareId: w.shareId, seq: frameSeq,
                        data: new Uint8Array(body.buffer, body.byteOffset + 4, body.length - 4)
                    })
                }
                if (forwardListeners.size > 0) forwardAudioRecord(w, body)
            } else if (type === SCREEN_AUDIO_TYPE.END) {
                const reason = END_NAME[body[0]] ?? 'stopped'
                w.streamGen++
                w.stream = null
                closeStream(stream)
                if (targetPeerId !== w.peerId) {
                    w.failedParent = targetPeerId
                    triggerAudioFailover(w, reason)
                } else {
                    finishWatch(w, reason)
                }
            }
        }
        readRecords(stream.source ?? stream, onRecord, MAX_AUDIO_RECORD)
            .then(
                () => {
                    if (gen !== w.streamGen || w.done) return
                    w.stream = null
                    if (targetPeerId !== w.peerId) {
                        w.failedParent = targetPeerId
                        triggerAudioFailover(w, 'lost')
                    } else {
                        finishWatch(w, 'lost')
                    }
                },
                () => {
                    if (gen !== w.streamGen || w.done) return
                    abortStream(stream, 'screen audio record is not valid')
                    w.stream = null
                    if (targetPeerId !== w.peerId) {
                        w.failedParent = targetPeerId
                        triggerAudioFailover(w, 'error')
                    } else {
                        finishWatch(w, 'error')
                    }
                }
            )
    }

    async function openUpstreamAudio({ peerId, shareId, localListening, onDemand = false }) {
        if (watch) {
            const old = watch
            finishWatch(old, 'switched')
            abortStream(old.stream, 'switched')
        }
        const w = {
            peerId, shareId, targetPeerId: null, localListening, stream: null, streamGen: 0, done: false,
            reparenting: false, failedParent: null, failoverAttempts: 0, failoverStartedAt: null, failoverTimer: null,
            frames: 0, bytes: 0
        }
        watch = w
        const target = resolveTargetPeer(peerId, shareId)
        await connectAudio(w, target, { timeoutMs: onDemand ? O.listenRecordMs : undefined })
        return { shareId: w.shareId }
    }

    async function watchScreenAudio(peerId) {
        if (stopped) throw new Error('The node is stopped.')
        if (idle()) throw new Error('Watching is not available in Idle Peer.')
        const share = getPeerShare(peerId)
        if (!share || !share.audio) throw new Error('This share has no audio.')
        if (watch && !watch.done && watch.peerId === peerId && watch.shareId === share.shareId) {
            watch.localListening = true
            return { shareId: watch.shareId }
        }
        const connection = connectionFor(peerId)
        if (!connection) throw new Error('No session with this member.')
        return openUpstreamAudio({ peerId, shareId: share.shareId, localListening: true, onDemand: false })
    }

    function unwatchScreenAudio(reason = 'unwatched') {
        const w = watch
        if (!w || !w.localListening) return false
        w.localListening = false
        if (forwardListeners.size === 0) {
            finishWatch(w, reason === 'switched' ? 'switched' : 'unwatched')
            abortStream(w.stream, 'unwatched')
        }
        return true
    }

    function onVideoParentChanged({ peerId, shareId, parentPeerId }) {
        const w = watch
        if (!w || w.done || stopped || idle()) return
        if (w.peerId !== peerId || w.shareId !== shareId) return
        if (!w.reparenting && w.targetPeerId === parentPeerId) return
        clearTimeout(w.failoverTimer)
        w.failoverTimer = null
        w.reparenting = false
        const prev = w.stream
        w.stream = null
        if (prev) abortStream(prev, 'audio parent changed')
        connectAudio(w, parentPeerId).catch(() => {})
    }

    function onForwarderChildLeft(childId, shareId) {
        const entry = forwardListeners.get(childId)
        if (!entry || (shareId && entry.shareId !== shareId)) return
        forwardListeners.delete(childId)
        abortStream(entry.stream, 'forwarder child left')
        maybeCloseIdleUpstream()
    }

    function onVideoUnwatch(reason = 'unwatched') {
        stopForwardListeners(reason === 'switched' ? 'stopped' : reason)
        if (!watch) return
        const w = watch
        const stream = w.stream
        finishWatch(w, reason === 'switched' ? 'switched' : 'unwatched')
        abortStream(stream, 'unwatched')
    }

    function peerLeft(peerId) {
        const ownEntry = ownListeners.get(peerId)
        if (ownEntry) {
            ownListeners.delete(peerId)
            abortStream(ownEntry.stream, 'peer left')
        }
        const fwdEntry = forwardListeners.get(peerId)
        if (fwdEntry) {
            forwardListeners.delete(peerId)
            abortStream(fwdEntry.stream, 'peer left')
            maybeCloseIdleUpstream()
        }
        if (watch?.peerId === peerId) {
            onVideoUnwatch('unwatched')
        } else if (watch && !watch.done && watch.targetPeerId === peerId) {
            const w = watch
            const prev = w.stream
            w.streamGen++
            w.stream = null
            if (prev) abortStream(prev, 'audio parent left')
            w.failedParent = peerId
            triggerAudioFailover(w, 'lost')
        }
    }

    function setIdle(value) {
        if (!value) return
        stopOwn('idle')
        onVideoUnwatch('unwatched')
    }

    async function stop() {
        if (stopped) return
        const had = ownListeners.size > 0 || forwardListeners.size > 0 || pending.size > 0
        stopOwn('stopped')
        onVideoUnwatch('stopped')
        stopped = true
        let timer
        if (had) await Promise.race([Promise.allSettled([...closing]), new Promise(resolve => { timer = setTimeout(resolve, 300) })])
        clearTimeout(timer)
    }

    function stats() {
        return {
            listeners: [...ownListeners.keys()],
            forwardedListeners: [...forwardListeners.keys()],
            watching: watch ? {
                peerId: watch.peerId,
                shareId: watch.shareId,
                parentPeerId: watch.targetPeerId,
                localListening: watch.localListening,
                reparenting: watch.reparenting,
                frames: watch.frames,
                bytes: watch.bytes
            } : null
        }
    }

    return {
        handleStream, stopOwn, peerLeft, setIdle, stop, stats,
        onVideoParentChanged, onForwarderChildLeft, onVideoUnwatch,
        api: { sendScreenAudioFrame, watchScreenAudio, unwatchScreenAudio }
    }
}
