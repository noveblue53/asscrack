// easy-join part 2: knock and approve. A person with a room code asks the owner to join. The owner sees a prompt
// ("<name> #<mark> wants to join") and selects Allow or Deny. Allow gives a device invite (a grant with no host rights)
// on the same channel, then the person joins with the normal admission path.
// This module has the messages, the proofs, the limits and the owner decision. It has no transport: a channel is
// { send(object) -> boolean, end() }. node.mjs gives a libp2p stream channel (knock-stream.mjs). Part 3 can give a
// channel over the friend link.
//
// Lines (one JSON object each):
//   knocker -> owner  { type: 'knock-hello', v: 1, room: <room ID>, code: <code ID>, nonce }
//   owner -> knocker  { type: 'knock-challenge', nonce, proof }   proof: the owner device signs (code ID, knocker nonce)
//   knocker -> owner  { type: 'knock', device: <device ID>, name, signature }   signature: the knocker device signs
//                     (room ID, code ID, owner nonce)
//   owner -> knocker  { type: 'knock-wait' } when the prompt shows, then again each keepAliveMs (the stream of a
//                     muxer closes after 120 s with no data)
//   owner -> knocker  { type: 'knock-result', result: 'allowed' | 'denied' | 'timeout' | 'refused', reason?, invite? }
// easy-join part 3: a friend knock has no room code. Its code field is FRIEND_KNOCK_CODE, and only a channel that the
// owner opens with { friend: true } accepts it (the friend link of the owner, or a forward of an admitted member).
import { randomBytes, randomUUID } from 'node:crypto'
import { deviceMark } from './device-mark.mjs'
import { readInvite } from './invite.mjs'
import { roomCodeAccess, validDeviceId } from './room-membership.mjs'
import { displayText } from './text-safety.mjs'

export const KNOCK_PROTOCOL = '/asscrack/knock/1.0.0'
// easy-join part 3: the code field of a friend knock. It is not a code ID (16 bytes, 22 characters), thus a room code
// knock can never use it, and the proofs of a friend knock are not valid for a room code knock.
export const FRIEND_KNOCK_CODE = 'friend'
// maxLineBytes and maxStreamBytes: the knock size cap of the owner. maxPending: the prompts at one time. promptMs: the
// time of a prompt with no answer. coolDownMs: after Deny, the same device gets "denied" with no prompt.
// perSource, perVia and perOwner: the knocks in each periodMs for one source peer, for one path (a relay or an IP
// address) and for all knocks of the owner. stepMs: the time for each step before the prompt.
export const KNOCK_LIMITS = Object.freeze({
    maxLineBytes: 2048, maxStreamBytes: 8192, maxPending: 5, promptMs: 120000, keepAliveMs: 20000, stepMs: 10000,
    coolDownMs: 10 * 60 * 1000, perSource: 3, perVia: 10, perOwner: 30, periodMs: 60000
})
const NONCE = /^[A-Za-z0-9_-]{22,64}$/
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/
const MAX_COOL_DOWN_ROWS = 1024
const newNonce = () => randomBytes(18).toString('base64url')
const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: id => clearInterval(id) }

// The name of a knock: text with no bidi controls and no control characters, up to 64 characters.
export function knockName(value) {
    // eslint-disable-next-line no-control-regex
    const text = typeof value === 'string' ? displayText(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : ''
    return text || 'Someone'
}

// The count limits of one period, with the clock of the desk.
function rateLimit(clock, limits) {
    let start = clock.now()
    let total = 0
    const sources = new Map()
    const vias = new Map()
    return (source, via) => {
        const now = clock.now()
        if (now < start || now - start >= limits.periodMs) {
            start = now
            total = 0
            sources.clear()
            vias.clear()
        }
        const s = sources.get(source) ?? 0
        const v = vias.get(via) ?? 0
        if (total >= limits.perOwner || s >= limits.perSource || v >= limits.perVia) return false
        total++
        sources.set(source, s + 1)
        vias.set(via, v + 1)
        return true
    }
}

// The owner side. membership: the owner membership (room-membership.mjs). makeInvite(deviceId): the device invite of
// Allow (a string). changed({ pending, added }): the prompt list changed; added is the new prompt or null.
export function createKnockDesk({ membership, makeInvite, limits = {}, clock = realClock, changed = () => {}, log = () => {} }) {
    if (!membership?.owner) throw new Error('Only the room owner can answer a knock.')
    const L = { ...KNOCK_LIMITS, ...limits }
    const pending = new Map()
    const coolDown = new Map()
    const allowRate = rateLimit(clock, L)
    let stopped = false
    const view = entry => ({ id: entry.id, name: entry.name, mark: entry.mark, deviceId: entry.deviceId, at: entry.at })
    const list = () => [...pending.values()].map(view)

    function settle(entry, result, extra = {}) {
        if (!pending.delete(entry.id)) return
        clock.clearTimeout(entry.timer)
        clock.clearInterval(entry.keep)
        entry.finish(result, extra)
        changed({ pending: list(), added: null })
    }

    function coolingDown(deviceId) {
        const until = coolDown.get(deviceId)
        if (until === undefined) return false
        if (clock.now() < until) return true
        coolDown.delete(deviceId)
        return false
    }

    // source: the peer (or friend) of the channel. via: the path (a relay peer ID, an IP address, 'friend').
    // friend: true for a friend knock (part 3); the hello must then have FRIEND_KNOCK_CODE, and no room code is checked.
    // Returns { receive(message), closed() }.
    function open(channel, { source = '?', via = '?', friend = false } = {}) {
        let state = 'hello'
        let done = false
        let codeId = null
        let ownerNonce = null
        let entry = null
        let stepTimer = null
        function finish(result, extra = {}) {
            if (done) return
            done = true
            clock.clearTimeout(stepTimer)
            channel.send({ type: 'knock-result', result, ...extra })
            channel.end()
        }
        // A wrong line or no line in time: close with no answer and no prompt.
        function drop(cause) {
            if (done) return
            done = true
            clock.clearTimeout(stepTimer)
            log(`Knock from ${source} closed: ${cause}`)
            channel.end()
        }
        const step = () => {
            clock.clearTimeout(stepTimer)
            stepTimer = clock.setTimeout(() => drop('no line in time'), L.stepMs)
        }
        const handler = {
            receive(message) {
                if (done || state === 'wait') return
                if (state === 'hello') {
                    if (message?.type !== 'knock-hello' || message.v !== 1 || typeof message.room !== 'string' ||
                        typeof message.code !== 'string' || typeof message.nonce !== 'string' || !NONCE.test(message.nonce)) return drop('bad hello')
                    if (message.room !== membership.roomId) return finish('refused', { reason: 'room' })
                    const check = friend === true ? (message.code === FRIEND_KNOCK_CODE ? 'ok' : 'old-code')
                        : membership.checkRoomCode(message.code)
                    if (check !== 'ok') return finish('refused', { reason: check })
                    codeId = message.code
                    ownerNonce = newNonce()
                    state = 'proof'
                    step()
                    channel.send({ type: 'knock-challenge', nonce: ownerNonce, proof: membership.knockOwnerProof(codeId, message.nonce) })
                    return
                }
                if (message?.type !== 'knock' || !validDeviceId(message.device) || typeof message.signature !== 'string' ||
                    !SIGNATURE.test(message.signature)) return drop('bad knock')
                // The proof of the device key before any other check: the owner shows no prompt for a device that
                // did not prove its key.
                if (!membership.verifyKnock(message.device, codeId, ownerNonce, message.signature)) return drop('wrong device proof')
                const deviceId = message.device
                if (deviceId === membership.ownerId) return finish('refused', { reason: 'owner' })
                if (membership.revoked(deviceId)) return finish('refused', { reason: 'removed' })
                // issue() refuses a device that has a different role (a grant that can host).
                if (membership.issued().some(grant => grant.deviceId === deviceId && grant.canHost)) return finish('refused', { reason: 'role' })
                if (coolingDown(deviceId)) return finish('denied')
                if ([...pending.values()].some(other => other.deviceId === deviceId)) return finish('refused', { reason: 'pending' })
                if (pending.size >= L.maxPending) return finish('refused', { reason: 'busy' })
                clock.clearTimeout(stepTimer)
                state = 'wait'
                entry = { id: randomUUID(), deviceId, name: knockName(message.name), mark: deviceMark(deviceId), at: clock.now(), finish }
                entry.timer = clock.setTimeout(() => settle(entry, 'timeout'), L.promptMs)
                entry.keep = clock.setInterval(() => channel.send({ type: 'knock-wait' }), L.keepAliveMs)
                pending.set(entry.id, entry)
                channel.send({ type: 'knock-wait' })
                changed({ pending: list(), added: view(entry) })
            },
            // The channel closed (the knocker left, or the connection ended): the prompt goes away.
            closed() {
                clock.clearTimeout(stepTimer)
                if (entry && pending.has(entry.id)) {
                    done = true
                    pending.delete(entry.id)
                    clock.clearTimeout(entry.timer)
                    clock.clearInterval(entry.keep)
                    changed({ pending: list(), added: null })
                }
                done = true
            }
        }
        if (stopped || !allowRate(source, via)) {
            finish('refused', { reason: stopped ? 'busy' : 'rate' })
            return handler
        }
        step()
        return handler
    }

    // Allow or Deny of a prompt. Returns false when the prompt is not there now (an answer came, or it timed out).
    function answer(id, allow) {
        const entry = pending.get(id)
        if (!entry) return false
        if (allow !== true) {
            if (coolDown.size >= MAX_COOL_DOWN_ROWS) for (const [deviceId, until] of coolDown) if (clock.now() >= until) coolDown.delete(deviceId)
            if (coolDown.size < MAX_COOL_DOWN_ROWS) coolDown.set(entry.deviceId, clock.now() + L.coolDownMs)
            settle(entry, 'denied')
            return true
        }
        let invite
        try {
            invite = makeInvite(entry.deviceId)
        } catch (err) {
            log(`Knock invite failed: ${err?.message ?? err}`)
            settle(entry, 'refused', { reason: 'error' })
            throw err
        }
        settle(entry, 'allowed', { invite })
        return true
    }

    function stop() {
        stopped = true
        for (const entry of [...pending.values()]) settle(entry, 'timeout')
    }

    return Object.freeze({ open, answer, list, stop, limits: Object.freeze({ ...L }) })
}

// The knocker side, for one channel. code: the value of readRoomCode. access: roomCodeAccess of the code. identity:
// the device identity. receive(message) returns { send } (a line to send), { waiting: true }, or { done } (the end:
// { result, reason?, invite? }). result 'not-owner': the peer did not prove the owner key (try the next peer).
export function createKnocker({ code, access, identity, name }) {
    const nonce = newNonce()
    let state = 'hello'
    return {
        hello: () => ({ type: 'knock-hello', v: 1, room: access.roomId, code: code.codeId, nonce }),
        provedOwner: () => state !== 'hello',
        receive(message) {
            if (state === 'done') return {}
            if (message?.type === 'knock-result') {
                const proved = state !== 'hello'
                state = 'done'
                const result = ['allowed', 'denied', 'timeout', 'refused'].includes(message.result) ? message.result : 'refused'
                // Only the owner (after its proof) can give an invite or a denial.
                if (!proved && result !== 'refused') return { done: { result: 'not-owner' } }
                if (result === 'allowed' && typeof message.invite !== 'string') return { done: { result: 'refused', reason: 'error' } }
                return { done: { result, ...(typeof message.reason === 'string' ? { reason: message.reason.slice(0, 32) } : {}),
                    ...(result === 'allowed' ? { invite: message.invite } : {}) } }
            }
            if (state === 'hello') {
                if (message?.type !== 'knock-challenge' || typeof message.nonce !== 'string' || !NONCE.test(message.nonce) ||
                    !access.verifyOwnerKnock(code.codeId, nonce, message.proof)) {
                    state = 'done'
                    return { done: { result: 'not-owner' } }
                }
                state = 'wait'
                return { send: { type: 'knock', device: identity.id, name: knockName(name), signature: access.knockProof(identity, code.codeId, message.nonce) } }
            }
            if (message?.type === 'knock-wait') return { waiting: true }
            return {}
        }
    }
}

// The device invite of Allow: the code must name the room of the room code, its owner, and this device.
// Returns the value of readInvite.
export function checkAllowedInvite(code, identity, invite) {
    const value = readInvite(invite)
    if (value.room !== code.room || value.key !== code.key || value.membership?.owner !== code.owner ||
        value.membership.lan !== code.lan || value.membership.grant?.deviceId !== identity.id || value.membership.grant.canHost !== false) {
        throw new Error('The answer of the owner is not valid.')
    }
    return value
}

// easy-join part 3: the device invite of Allow after a friend knock. The joiner knows the room ID and the owner device
// ID of the announce line of the friend, not the room key. The room ID of the invite (the room, the key, the owner and
// the LAN flag) must be that room ID. Returns the value of readInvite.
export function checkFriendAllowedInvite({ roomId, owner }, identity, invite) {
    const value = readInvite(invite)
    const m = value.membership
    let id = null
    try { id = roomCodeAccess(value.room, value.key, m?.owner, m?.lan).roomId } catch { id = null }
    if (id !== roomId || m?.owner !== owner || m.grant?.deviceId !== identity.id || m.grant.canHost !== false) {
        throw new Error('The answer of the owner is not valid.')
    }
    return value
}
