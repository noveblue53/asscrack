// Diagnostics requests (1.0.1, docs/DIAGNOSTICS.md): "Ask for diagnostics" on a buddy line. One control line type
// 'diag' (v 1) on the room session. Nothing goes out without the "Send" click of the asked person:
//   asker -> { op: 'ask', id }                          the asked window shows a fixed local prompt (no text of the asker)
//   asked -> { op: 'declined', id }                     "Not now" (the asker gets no new prompt for COOLDOWN_MS)
//   asked -> { op: 'busy', id }                         a limit refused the request (no prompt)
//   asked -> { op: 'grant', id, offerId, size, sha256 } "Send": then the normal file offer of the bundle follows
// The asker accepts a file offer only when it carries the offer ID of a grant for an own pending request, from the
// same peer, with the same size and hash, below MAX_BUNDLE_BYTES. Then the normal transfer verifies and saves it.
// Only a proved member device of a protected room can ask (node.mjs gives allowed()). The peer must announce 'diag'
// in its hello line (capable()). A 1.0.0 peer has no 'diag' and gets no line.
import { randomUUID } from 'node:crypto'
import { roomRateLimit } from './room-rate-limit.mjs'

export const ASK_TTL_MS = 15 * 60 * 1000
export const COOLDOWN_MS = 60 * 60 * 1000
export const GLOBAL_LIMIT = 3
export const GLOBAL_WINDOW_MS = 60 * 60 * 1000
export const MAX_BUNDLE_BYTES = 12 * 1024 * 1024
export const BUNDLE_NAME = 'asscrack-diagnostics.zip'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{64}$/
const uuid = value => typeof value === 'string' && UUID.test(value)

// The limits of the asked side. A pure state with a clock: one pending request for each asker, a cool-down after
// "Not now", and a limit of prompts for all askers together.
export function createDiagConsent({ now = Date.now, askTtl = ASK_TTL_MS, cooldown = COOLDOWN_MS, globalLimit = GLOBAL_LIMIT,
    globalWindow = GLOBAL_WINDOW_MS } = {}) {
    const pending = new Map()
    const until = new Map()
    let prompts = []

    function expire() {
        const t = now()
        const gone = []
        for (const [id, entry] of pending) if (t - entry.at >= askTtl) { pending.delete(id); gone.push({ id, peer: entry.peer }) }
        for (const [peer, end] of until) if (end <= t) until.delete(peer)
        prompts = prompts.filter(at => t - at < globalWindow)
        return gone
    }

    return {
        // A new request: 'prompt' (show it), or the limit that refused it: 'pending', 'cooldown' or 'global'.
        receive(peer, id) {
            expire()
            if (!uuid(id) || pending.has(id)) return 'bad'
            if ([...pending.values()].some(entry => entry.peer === peer)) return 'pending'
            if (until.has(peer)) return 'cooldown'
            if (prompts.length >= globalLimit) return 'global'
            pending.set(id, { peer, at: now() })
            prompts.push(now())
            return 'prompt'
        },
        // The answer of the user. Gives the peer of the request, or null (no such request, or it expired).
        take(id) {
            expire()
            const entry = pending.get(id)
            if (!entry) return null
            pending.delete(id)
            return entry.peer
        },
        decline(id) {
            const peer = this.take(id)
            if (peer !== null) until.set(peer, now() + cooldown)
            return peer
        },
        peerGone(peer) {
            const gone = []
            for (const [id, entry] of pending) if (entry.peer === peer) { pending.delete(id); gone.push(id) }
            return gone
        },
        expire,
        pending: () => [...pending].map(([id, entry]) => ({ id, peer: entry.peer }))
    }
}

// The diagnostics requests of one room node.
// sessions: peer -> session. files: the file transfer of the node. events: the node events.
// allowed(peer): true for a proved member device. capable(peer): the peer announced 'diag'.
export function createDiagRequests({ sessions, files, events, allowed = () => false, capable = () => false, now = Date.now,
    askTtl = ASK_TTL_MS, maxBytes = MAX_BUNDLE_BYTES, consent = createDiagConsent({ now, askTtl }) }) {
    const asks = new Map()
    const grants = new Map()
    const sent = new Map()
    // Each offer ID of a bundle in this session (also after the end): main.js keeps these transfers out of Transfers.
    const seen = new Set()
    const remember = offerId => { seen.add(offerId); if (seen.size > 256) seen.delete(seen.values().next().value) }
    const allowLine = roomRateLimit(6, 24)
    let stopped = false

    const emit = data => events.emit('diag', data)
    function send(peer, op, data) {
        return sessions.get(peer)?.send(JSON.stringify({ type: 'diag', v: 1, op, ...data })) === true
    }

    const sweep = setInterval(() => {
        for (const { id, peer } of consent.expire()) emit({ event: 'expired', peerId: peer, id, side: 'asked' })
        const t = now()
        for (const [id, ask] of asks) {
            if (t - ask.at < askTtl || ask.offerId) continue
            asks.delete(id)
            emit({ event: 'expired', peerId: ask.peer, id, side: 'asker' })
        }
    }, 30000)
    sweep.unref?.()

    // The asker: one pending request for each peer. Gives { ok: true, id } or { ok: false, reason }.
    function ask(peer) {
        if (stopped || !sessions.has(peer)) return { ok: false, reason: 'offline' }
        if (!allowed(peer)) return { ok: false, reason: 'not-member' }
        if (!capable(peer)) return { ok: false, reason: 'old-version' }
        if ([...asks.values()].some(a => a.peer === peer && now() - a.at < askTtl)) return { ok: false, reason: 'pending' }
        const id = randomUUID()
        if (!send(peer, 'ask', { id })) return { ok: false, reason: 'offline' }
        asks.set(id, { peer, at: now(), offerId: null })
        emit({ event: 'asked', peerId: peer, id })
        return { ok: true, id }
    }

    // The asked side: the answer of the user. filePath: the bundle for Send, or null for "Not now".
    // Gives { ok: true } or { ok: false, reason }.
    async function answer(id, filePath) {
        if (stopped) return { ok: false, reason: 'stopped' }
        if (filePath === null || filePath === undefined) {
            const peer = consent.decline(id)
            if (peer === null) return { ok: false, reason: 'expired' }
            send(peer, 'declined', { id })
            emit({ event: 'declined', peerId: peer, id, by: 'self' })
            return { ok: true }
        }
        const peer = consent.take(id)
        if (peer === null) return { ok: false, reason: 'expired' }
        if (!sessions.has(peer)) {
            emit({ event: 'failed', peerId: peer, id, reason: 'offline' })
            return { ok: false, reason: 'offline' }
        }
        try {
            const prepared = await files.prepareFile(filePath, BUNDLE_NAME)
            if (prepared.size > maxBytes) throw Object.assign(new Error('too large'), { code: 'too-large' })
            const offerId = randomUUID()
            remember(offerId)
            if (stopped || !send(peer, 'grant', { id, offerId, size: prepared.size, sha256: prepared.sha256 })) {
                throw Object.assign(new Error('offline'), { code: 'offline' })
            }
            const offer = files.publishOffer(prepared, [peer], offerId)
            if (!offer.peers) throw Object.assign(new Error('offline'), { code: 'offline' })
            sent.set(offerId, { peer, id })
            emit({ event: 'sent', peerId: peer, id, offerId, size: prepared.size })
            return { ok: true, offerId }
        } catch (err) {
            const reason = typeof err?.code === 'string' && /^[a-z-]+$/.test(err.code) ? err.code : 'prepare-failed'
            emit({ event: 'failed', peerId: peer, id, reason })
            return { ok: false, reason }
        }
    }

    function handle(peer, session, control) {
        if (stopped || control.v !== 1 || sessions.get(peer) !== session || !uuid(control.id)) return
        if (!allowLine(peer)) return
        if (control.op === 'ask') {
            if (!allowed(peer)) {
                send(peer, 'busy', { id: control.id })
                emit({ event: 'refused', peerId: peer, id: control.id, reason: 'not-member' })
                return
            }
            const result = consent.receive(peer, control.id)
            if (result === 'prompt') emit({ event: 'prompt', peerId: peer, id: control.id })
            else {
                send(peer, 'busy', { id: control.id })
                emit({ event: 'refused', peerId: peer, id: control.id, reason: result })
            }
            return
        }
        const own = asks.get(control.id)
        if (!own || own.peer !== peer) return
        if (control.op === 'declined' || control.op === 'busy') {
            if (own.offerId) return
            asks.delete(control.id)
            emit({ event: control.op === 'busy' ? 'refused' : 'declined', peerId: peer, id: control.id, by: 'peer',
                reason: control.op === 'busy' ? 'busy' : undefined })
        } else if (control.op === 'grant') {
            if (own.offerId || !uuid(control.offerId) || grants.has(control.offerId) || !Number.isSafeInteger(control.size) ||
                control.size < 0 || control.size > maxBytes || typeof control.sha256 !== 'string' || !SHA.test(control.sha256)) return
            own.offerId = control.offerId
            remember(control.offerId)
            grants.set(control.offerId, { peer, id: control.id, size: control.size, sha256: control.sha256, state: 'granted' })
            emit({ event: 'granted', peerId: peer, id: control.id, size: control.size })
        }
    }

    // A file offer: null (not a diagnostics offer), 'requested' (accept it now) or 'reject'.
    function classifyOffer(peer, control) {
        const grant = grants.get(control.offerId)
        if (!grant) return null
        return grant.peer === peer && grant.state === 'granted' && control.size === grant.size && control.sha256 === grant.sha256 &&
            control.name === BUNDLE_NAME && !control.attachmentId && control.size <= maxBytes ? 'requested' : 'reject'
    }

    function startOffer(peer, offerId) {
        const grant = grants.get(offerId)
        try {
            if (grant && files.acceptFile(offerId)) { grant.state = 'receiving'; return }
        } catch { /* refuse below */ }
        try { files.refuseFile(offerId) } catch { /* gone */ }
        finish(offerId, 'failed', 'accept-failed')
    }

    function finish(offerId, event, reason, data = {}) {
        const grant = grants.get(offerId)
        if (!grant) return
        grants.delete(offerId)
        asks.delete(grant.id)
        emit({ event, peerId: grant.peer, id: grant.id, reason, size: grant.size, ...data })
    }

    function isDiagOffer(offerId) {
        return seen.has(offerId)
    }

    function transferred(data, ok) {
        if (data?.direction === 'receive' && grants.get(data.offerId)?.peer === data.peerId) {
            if (ok) finish(data.offerId, 'received', undefined, { path: data.path })
            else finish(data.offerId, 'failed', typeof data.reason === 'string' ? data.reason : 'transfer-failed')
        } else if (sent.has(data?.offerId) && data.direction === 'send') {
            sent.delete(data.offerId)
            files.forgetOffer(data.offerId)
        }
    }
    events.on('file-done', data => transferred(data, true))
    events.on('file-failed', data => transferred(data, false))
    events.on('file-cancelled', data => transferred(data, false))
    events.on('file-refused', data => transferred({ ...data, direction: 'send' }, false))

    function closed(peer) {
        for (const id of consent.peerGone(peer)) emit({ event: 'expired', peerId: peer, id, side: 'asked' })
        for (const [id, a] of asks) {
            if (a.peer !== peer || a.offerId) continue
            asks.delete(id)
            emit({ event: 'failed', peerId: peer, id, reason: 'offline' })
        }
    }

    return {
        ask, answer, handle, classifyOffer, startOffer, isDiagOffer, closed,
        pending: () => consent.pending(),
        stop() {
            stopped = true
            clearInterval(sweep)
            asks.clear(); grants.clear(); sent.clear(); seen.clear()
        }
    }
}
