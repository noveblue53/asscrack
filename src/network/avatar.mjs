// Profile pictures (1.0.6): the session lines of the picture of a person. The picture itself is a 128 x 128 WebP or
// PNG of at most AVATAR_MAX_BYTES. The app (src/application/avatars.mjs) makes it, checks it and keeps it. This module
// only moves the bytes and does not decode them.
//
// Lines (one session, only after the proof of the room and only to an allowed member: allowed(peerId)):
//   { type: 'avatar', v: 1, hash, size }      the SHA-256 (hex) of the own picture, or hash null (no picture).
//                                             Sent on each new session and after each change.
//   { type: 'avatar-get', v: 1, hash }        a peer that does not have this hash in its cache asks for it.
//   { type: 'avatar-data', v: 1, hash, data } the answer: the bytes in base64. Only for a hash that this node asked for.
// An older client (1.0.5 and before) ignores an unknown line type with no warning (node.mjs).
//
// Limits: AVATAR_LIMITS. Each limit counts per peer in one minute. A request over the limit waits for the next window.
import { createHash } from 'node:crypto'

export const AVATAR_MAX_BYTES = 32 * 1024
export const AVATAR_LIMITS = Object.freeze({
    // Announce lines that a peer can send in one minute. More lines are ignored.
    announcesPerMinute: 10,
    // Requests that this node sends to one peer in one minute.
    fetchesPerMinute: 4,
    // Answers with data that this node sends to one peer in one minute.
    repliesPerMinute: 4,
    // The time for an answer.
    fetchTimeoutMs: 15000
})
const HASH = /^[0-9a-f]{64}$/
const MAX_DATA_CHARS = Math.ceil(AVATAR_MAX_BYTES / 3) * 4
export const validAvatarHash = hash => typeof hash === 'string' && HASH.test(hash)
export const avatarHash = bytes => createHash('sha256').update(bytes).digest('hex')

// A count of events per key in a window of periodMs.
function windowLimit(max, now, periodMs = 60000) {
    const counts = new Map()
    return {
        take(key) {
            const t = now()
            const row = counts.get(key)
            if (!row || t < row.start || t - row.start >= periodMs) {
                if (counts.size >= 1024) for (const [k, r] of counts) if (t - r.start >= periodMs) counts.delete(k)
                counts.set(key, { start: t, count: 1 })
                return true
            }
            if (row.count >= max) return false
            row.count++
            return true
        },
        // The time in ms until take(key) can give true.
        wait(key) {
            const row = counts.get(key)
            if (!row || row.count < max) return 0
            return Math.max(0, row.start + periodMs - now())
        }
    }
}

// hub: { own() -> { hash, bytes } | null } of the app (avatars.mjs), or null: this node sends no picture line and
// ignores each picture line (the terminal demo).
// sessionFor(peerId): the open session or undefined. sessions(): [[peerId, session]]. allowed(peerId): the same trust
// as a name (a proved member in a protected room). emit(type, data): the node events 'avatar', 'avatar-data',
// 'avatar-failed'.
export function createAvatarLines({ hub = null, sessionFor, sessions, allowed = () => true, emit,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, limits = {} } = {}) {
    const L = { ...AVATAR_LIMITS, ...limits }
    const announces = windowLimit(L.announcesPerMinute, now)
    const fetches = windowLimit(L.fetchesPerMinute, now)
    const replies = windowLimit(L.repliesPerMinute, now)
    const peerHash = new Map() // peerId -> hash | null (the last announce)
    const pending = new Map() // peerId -> { hash, timer } (one request in flight for each peer)
    const later = new Map() // peerId -> { hash, timer } (a request that waits for the rate window)
    let stopped = false

    const ownLine = () => {
        const own = hub?.own() ?? null
        return JSON.stringify(own ? { type: 'avatar', v: 1, hash: own.hash, size: own.bytes.length }
            : { type: 'avatar', v: 1, hash: null })
    }
    const sendTo = (peerId, line) => Boolean(sessionFor(peerId)?.send(line))

    function clearPeer(peerId) {
        const p = pending.get(peerId)
        if (p) clearTimer(p.timer)
        pending.delete(peerId)
        const w = later.get(peerId)
        if (w) clearTimer(w.timer)
        later.delete(peerId)
    }

    function opened(peerId) {
        if (!hub || stopped || !allowed(peerId)) return
        sendTo(peerId, ownLine())
    }

    // The own picture changed: tell each allowed session.
    function share() {
        if (!hub || stopped) return 0
        const line = ownLine()
        let sent = 0
        for (const [peerId, session] of sessions()) if (allowed(peerId) && session.send(line)) sent++
        return sent
    }

    function send(peerId, hash) {
        if (!fetches.take(peerId)) return false
        const timer = setTimer(() => {
            if (pending.get(peerId)?.timer !== timer) return
            pending.delete(peerId)
            emit('avatar-failed', { peerId, hash, reason: 'timeout' })
        }, L.fetchTimeoutMs)
        timer?.unref?.()
        // Set the request before the send: an answer can come at once.
        pending.set(peerId, { hash, timer })
        if (sendTo(peerId, JSON.stringify({ type: 'avatar-get', v: 1, hash }))) return true
        if (pending.get(peerId)?.timer === timer) { clearTimer(timer); pending.delete(peerId) }
        return false
    }

    // Ask a peer for the picture of its last announce. Gives 'sent', 'pending' (a request for this hash is in flight
    // or waits for the rate window), 'later' (the rate window is full: the request goes when it opens) or 'no'.
    function request(peerId, hash) {
        if (!hub || stopped || !validAvatarHash(hash) || peerHash.get(peerId) !== hash || !allowed(peerId) ||
            !sessionFor(peerId)) return 'no'
        if (pending.get(peerId)?.hash === hash || later.get(peerId)?.hash === hash) return 'pending'
        if (pending.has(peerId)) return 'no'
        if (send(peerId, hash)) return 'sent'
        const wait = fetches.wait(peerId)
        if (wait <= 0) return 'no'
        const old = later.get(peerId)
        if (old) clearTimer(old.timer)
        const timer = setTimer(() => {
            if (later.get(peerId)?.timer !== timer) return
            later.delete(peerId)
            if (!stopped && peerHash.get(peerId) === hash) request(peerId, hash)
        }, wait + 10)
        timer?.unref?.()
        later.set(peerId, { hash, timer })
        return 'later'
    }

    // A picture line of an open session. The node calls it only for a session that is the current session of the peer.
    function handle(peerId, control) {
        if (!hub || stopped || control?.v !== 1 || !allowed(peerId)) return
        if (control.type === 'avatar') {
            const hash = control.hash === null ? null : validAvatarHash(control.hash) ? control.hash : undefined
            if (hash === undefined) return
            if (hash !== null && !(Number.isSafeInteger(control.size) && control.size > 0 && control.size <= AVATAR_MAX_BYTES)) return
            if (!announces.take(peerId)) return
            if (peerHash.has(peerId) && peerHash.get(peerId) === hash) return
            peerHash.set(peerId, hash)
            // A request in flight is for the old hash.
            clearPeer(peerId)
            emit('avatar', { peerId, hash })
        } else if (control.type === 'avatar-get') {
            const own = hub.own()
            if (!validAvatarHash(control.hash) || own?.hash !== control.hash || !replies.take(peerId)) return
            sendTo(peerId, JSON.stringify({ type: 'avatar-data', v: 1, hash: own.hash, data: Buffer.from(own.bytes).toString('base64') }))
        } else if (control.type === 'avatar-data') {
            const p = pending.get(peerId)
            if (!p || control.hash !== p.hash) return
            clearTimer(p.timer)
            pending.delete(peerId)
            const data = typeof control.data === 'string' && control.data.length <= MAX_DATA_CHARS ? control.data : null
            const bytes = data ? Buffer.from(data, 'base64') : null
            if (!bytes?.length || bytes.length > AVATAR_MAX_BYTES) {
                emit('avatar-failed', { peerId, hash: p.hash, reason: 'size' })
                return
            }
            if (avatarHash(bytes) !== p.hash) {
                emit('avatar-failed', { peerId, hash: p.hash, reason: 'hash' })
                return
            }
            emit('avatar-data', { peerId, hash: p.hash, bytes })
        }
    }

    function closed(peerId) {
        clearPeer(peerId)
        peerHash.delete(peerId)
        // The announce count stays: a new session does not give a new count.
    }

    return {
        enabled: () => Boolean(hub),
        opened, share, request, handle, closed,
        // peerId -> hash of each peer with a known announce (also null: no picture).
        peers: () => Object.fromEntries(peerHash),
        stop() {
            stopped = true
            for (const peerId of [...pending.keys(), ...later.keys()]) clearPeer(peerId)
        }
    }
}
