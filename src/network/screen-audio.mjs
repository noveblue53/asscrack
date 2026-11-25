// Companion audio stream for screen sharing: `/asscrack/screen-audio/1.0.0`.
// Kept on a separate libp2p stream from `/asscrack/screen/1.0.0` so large video keyframes never head-of-line block
// 20 ms Opus audio packets, muted viewers can close the stream to save bandwidth, and 1.0.1-1.0.6 peers stay untouched.
import { roomRateLimit } from './room-rate-limit.mjs'
import { readRecords, record, SCREEN_END } from './screen-share.mjs'

export const SCREEN_AUDIO_PROTOCOL = '/asscrack/screen-audio/1.0.0'
export const SCREEN_AUDIO_TYPE = Object.freeze({ LISTEN: 1, AUDIO: 2, END: 3 })
export const MAX_SCREEN_AUDIO_BYTES = 4000
export const MAX_LISTEN_RECORD = 256
export const MAX_AUDIO_RECORD = 1 + 4 + MAX_SCREEN_AUDIO_BYTES

const END_NAME = Object.fromEntries(Object.entries(SCREEN_END).map(([name, code]) => [code, name]))

export const SCREEN_AUDIO_DEFAULTS = Object.freeze({
    maxListeners: 6,
    listenRecordMs: 5000,
    opensPerPeer: 12,
    opensPerRoom: 48,
    closeWaitMs: 5000
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

export function createScreenAudio({ events, allowed, connectionFor, getOwnShare, getPeerShare, idle = () => false, options = {} }) {
    const O = { ...SCREEN_AUDIO_DEFAULTS, ...options }
    const allowOpen = roomRateLimit(O.opensPerPeer, O.opensPerRoom)
    const listeners = new Map() // peerId -> { stream, shareId, waiting, dropped }
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

    // ---- Sharer side ----

    function endListener(peerId, reason, stream = listeners.get(peerId)?.stream) {
        if (listeners.get(peerId)?.stream === stream) listeners.delete(peerId)
        try { stream?.send(endRecord(reason)) } catch { /* closed */ }
        closeStream(stream)
    }

    function handleStream({ stream, connection }) {
        const peerId = connection.remotePeer.toString()
        if (stopped || !allowed(peerId) || !allowOpen(peerId)) {
            abortStream(stream, 'Screen audio stream is not authorized')
            return
        }
        let state = 'open'
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
            if (!own || !own.audio || value?.v !== 1 || value.shareId !== own.shareId || idle() || !allowed(peerId)) {
                return refuse('refused')
            }
            const old = listeners.get(peerId)
            if (!old && listeners.size >= O.maxListeners) return refuse('full')
            if (old) endListener(peerId, 'replaced', old.stream)
            listeners.set(peerId, { stream, shareId: own.shareId, waiting: false, dropped: 0 })
            state = 'listening'
        }
        readRecords(stream.source ?? stream, onRecord, MAX_LISTEN_RECORD)
            .catch(() => abortStream(stream, 'screen audio record is not valid'))
            .finally(() => {
                clearTimeout(listenTimer)
                pending.delete(stream)
                state = 'closed'
                if (listeners.get(peerId)?.stream === stream) listeners.delete(peerId)
            })
    }

    function sendScreenAudioFrame(data) {
        const own = getOwnShare()
        if (stopped || !own || !own.audio) return false
        if (!(data instanceof Uint8Array) || data.length < 1 || data.length > MAX_SCREEN_AUDIO_BYTES) return false
        if (listeners.size === 0) return true
        const pkt = audioRecord(++seq, data)
        for (const [peerId, entry] of [...listeners]) {
            if (entry.shareId !== own.shareId || !allowed(peerId)) {
                endListener(peerId, 'refused', entry.stream)
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
                endListener(peerId, 'error', entry.stream)
            }
        }
        return true
    }

    function stopOwn(reason = 'stopped') {
        const wire = reason === 'isolated' || reason === 'limit' ? 'stopped' : reason
        for (const [peerId, entry] of [...listeners]) endListener(peerId, wire, entry.stream)
        for (const stream of [...pending]) {
            pending.delete(stream)
            try { stream.send(endRecord(wire)) } catch { /* closed */ }
            closeStream(stream)
        }
        seq = 0
    }

    // ---- Viewer side ----

    function finishWatch(w, reason) {
        if (w.done) return
        w.done = true
        if (watch === w) watch = null
        const user = reason === 'unwatched' || reason === 'switched'
        if (!user) events.emit('screen-audio-ended', { peerId: w.peerId, shareId: w.shareId, reason })
    }

    async function watchScreenAudio(peerId) {
        if (stopped) throw new Error('The node is stopped.')
        if (idle()) throw new Error('Watching is not available in Idle Peer.')
        const share = getPeerShare(peerId)
        if (!share || !share.audio) throw new Error('This share has no audio.')
        unwatchScreenAudio('switched')
        const connection = connectionFor(peerId)
        if (!connection) throw new Error('No session with this member.')
        const w = { peerId, shareId: share.shareId, stream: null, done: false, frames: 0, bytes: 0 }
        watch = w
        let stream
        try {
            stream = await connection.newStream(SCREEN_AUDIO_PROTOCOL, { runOnTransientConnection: true })
        } catch (err) {
            finishWatch(w, 'error')
            throw err
        }
        w.stream = stream
        if (w.done) {
            abortStream(stream, 'screen audio watch stopped')
            return { shareId: w.shareId }
        }
        try { stream.send(jsonRecord(SCREEN_AUDIO_TYPE.LISTEN, { v: 1, shareId: w.shareId })) } catch { /* read loop ends */ }
        const onRecord = (type, body) => {
            if (w.done) return
            if (type === SCREEN_AUDIO_TYPE.AUDIO) {
                if (body.length < 5) throw new Error('AUDIO record is too short')
                const frameSeq = body.readUInt32BE(0)
                w.frames++
                w.bytes += body.length - 4
                events.emit('screen-audio-frame', {
                    peerId, shareId: w.shareId, seq: frameSeq,
                    data: new Uint8Array(body.buffer, body.byteOffset + 4, body.length - 4)
                })
            } else if (type === SCREEN_AUDIO_TYPE.END) {
                finishWatch(w, END_NAME[body[0]] ?? 'stopped')
                closeStream(stream)
            }
        }
        readRecords(stream.source ?? stream, onRecord, MAX_AUDIO_RECORD)
            .then(() => finishWatch(w, 'lost'), () => { abortStream(stream, 'screen audio record is not valid'); finishWatch(w, 'error') })
        return { shareId: w.shareId }
    }

    function unwatchScreenAudio(reason = 'unwatched') {
        const w = watch
        if (!w) return false
        finishWatch(w, reason === 'switched' ? 'switched' : 'unwatched')
        abortStream(w.stream, 'unwatched')
        return true
    }

    function peerLeft(peerId) {
        const entry = listeners.get(peerId)
        if (entry) {
            listeners.delete(peerId)
            abortStream(entry.stream, 'peer left')
        }
        if (watch?.peerId === peerId) unwatchScreenAudio('unwatched')
    }

    function setIdle(value) {
        if (!value) return
        stopOwn('idle')
        unwatchScreenAudio('unwatched')
    }

    async function stop() {
        if (stopped) return
        const had = listeners.size > 0 || pending.size > 0
        stopOwn('stopped')
        stopped = true
        unwatchScreenAudio('unwatched')
        let timer
        if (had) await Promise.race([Promise.allSettled([...closing]), new Promise(resolve => { timer = setTimeout(resolve, 300) })])
        clearTimeout(timer)
    }

    function stats() {
        return {
            listeners: [...listeners.keys()],
            watching: watch ? { peerId: watch.peerId, shareId: watch.shareId, frames: watch.frames, bytes: watch.bytes } : null
        }
    }

    return {
        handleStream, stopOwn, peerLeft, setIdle, stop, stats,
        api: { sendScreenAudioFrame, watchScreenAudio, unwatchScreenAudio }
    }
}
