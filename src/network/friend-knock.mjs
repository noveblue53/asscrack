// easy-join part 3: the friend knock ("Join" on a friend row) and the room announce line, on the friend link. This module
// has no transport: friend-links.mjs gives the lines of the friend node and a send function.
// Lines ('pm' lines of the friend node; a 1.0.0 app ignores an unknown op with no line, no ack and no error):
//   { type: 'pm', v: 1, op: 'room', room: { id, owner, name, route } | null }
//       The current protected room of the sender. id: the room ID (a SHA-256 value, not the room key). owner: the owner
//       device ID. name: the room name. route: 'owner' (the sender owns the room), 'forward' (the sender is an admitted
//       member and forwards a knock to the owner), 'none' (the sender cannot forward: the joiner sees "Ask <friend> for
//       an invite"). null: no protected room now. No key, no code and no address.
//   { type: 'pm', v: 1, op: 'knock', kid, line }   one knock line of knock.mjs, in each direction. kid: the knock ID
//       that the joiner makes.
//   { type: 'pm', v: 1, op: 'knock-end', kid, offline? }   the end of a knock. offline: true when the friend could not
//       reach the owner (the joiner shows "The owner is not online. Try again later.").
// The friend that gets a knock does not change a line. The owner checks the device proof of the joiner (knock.mjs).
import { randomBytes } from 'node:crypto'
import { createKnocker, FRIEND_KNOCK_CODE, KNOCK_LIMITS } from './knock.mjs'
import { knockAccess, validDeviceId, validRoomId } from './room-membership.mjs'
import { displayText } from './text-safety.mjs'

// maxLineBytes, maxKnockBytes: the size caps of the lines of the joiner (the same as the knock stream of the owner).
// maxAnswerBytes: a line to the joiner (the device invite of Allow). maxOpen: the knocks that one friend link carries at
// one time. lifeMs: a knock on the friend side ends after this time (the prompt time and a margin).
export const FRIEND_KNOCK_LIMITS = Object.freeze({
    maxLineBytes: KNOCK_LIMITS.maxLineBytes, maxKnockBytes: KNOCK_LIMITS.maxStreamBytes, maxAnswerBytes: 64 * 1024,
    maxOpen: 1, lifeMs: KNOCK_LIMITS.promptMs + 60000
})
const KID = /^[A-Za-z0-9_-]{22}$/
const ROUTES = new Set(['owner', 'forward', 'none'])
const OPS = new Set(['room', 'knock', 'knock-end'])
const byteSize = value => {
    try { return Buffer.byteLength(JSON.stringify(value)) } catch { return Infinity }
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// True for a line of this module (the friend links give it here, not to private-messages.mjs).
export const isFriendKnockLine = message => message?.type === 'pm' && message.v === 1 && OPS.has(message.op)

// The room announce line. room: { id, owner, name, route } or null.
export function roomLine(room) {
    return { type: 'pm', v: 1, op: 'room', room: room ? { id: room.id, owner: room.owner, name: room.name, route: room.route } : null }
}

// The checked value of a room announce line, or null.
export function readRoomLine(message) {
    const room = message?.room
    if (!isObject(room) || !validRoomId(room.id) || !validDeviceId(room.owner) || !ROUTES.has(room.route) ||
        typeof room.name !== 'string') return null
    // eslint-disable-next-line no-control-regex
    const name = displayText(room.name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64)
    return name ? { id: room.id, owner: room.owner, name, route: room.route } : null
}

// The side of the friend that gets a knock: the owner of the room, or an admitted member that forwards it to the owner.
// send(line): a line to the joiner on the friend link. connect({ toJoiner(line), ended() }): the route to the owner for
// one knock. It returns (or resolves) { send(line), end() }, or null when there is no route now (the joiner gets
// 'offline'). ended(): the owner side ended the knock.
export function createKnockRelay({ send, connect, limits = {}, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
    const L = { ...FRIEND_KNOCK_LIMITS, ...limits }
    const open = new Map() // kid -> { route, queue, bytes, timer, done }

    function finish(kid, { notify = true, offline = false } = {}) {
        const entry = open.get(kid)
        if (!entry) return
        open.delete(kid)
        entry.done = true
        clearTimer(entry.timer)
        try { entry.route?.end() } catch { /* closed */ }
        if (notify) send({ type: 'pm', v: 1, op: 'knock-end', kid, ...(offline ? { offline: true } : {}) })
    }

    async function start(kid, entry) {
        let route = null
        try {
            route = await connect({
                toJoiner: line => { if (!entry.done) send({ type: 'pm', v: 1, op: 'knock', kid, line }) },
                ended: () => finish(kid)
            })
        } catch (err) {
            log(`Friend knock route failed: ${err?.message ?? err}`)
            route = null
        }
        if (entry.done) {
            try { route?.end() } catch { /* closed */ }
            return
        }
        if (!route) return finish(kid, { offline: true })
        entry.route = route
        for (const line of entry.queue.splice(0)) if (!entry.done) route.send(line)
    }

    return {
        // A line of the joiner: { op: 'knock' | 'knock-end', kid, line }.
        handle(message) {
            const kid = message?.kid
            if (typeof kid !== 'string' || !KID.test(kid)) return
            if (message.op === 'knock-end') return finish(kid, { notify: false })
            if (message.op !== 'knock') return
            const line = message.line
            const size = byteSize(line)
            let entry = open.get(kid)
            if (!isObject(line) || size > L.maxLineBytes) {
                if (entry) finish(kid)
                return
            }
            if (!entry) {
                if (line.type !== 'knock-hello') return
                if (open.size >= L.maxOpen) {
                    send({ type: 'pm', v: 1, op: 'knock', kid, line: { type: 'knock-result', result: 'refused', reason: 'pending' } })
                    send({ type: 'pm', v: 1, op: 'knock-end', kid })
                    return
                }
                entry = { route: null, queue: [], bytes: 0, timer: null, done: false }
                entry.timer = setTimer(() => finish(kid), L.lifeMs)
                entry.timer?.unref?.()
                open.set(kid, entry)
                entry.bytes = size
                entry.queue.push(line)
                void start(kid, entry)
                return
            }
            entry.bytes += size
            if (entry.bytes > L.maxKnockBytes) return finish(kid)
            if (entry.route) entry.route.send(line)
            else entry.queue.push(line)
        },
        // The friend link session closed: each knock ends.
        closed() {
            for (const kid of [...open.keys()]) finish(kid, { notify: false })
        },
        count: () => open.size
    }
}

// The joiner side of one friend knock. room: the value of the announce line ({ id, owner, name, route }). send(line):
// a line to the friend; false when the friend link has no session. onState('waiting'): the owner shows the prompt.
// Returns { kid, result, handle(message), closed(), cancel() }. result resolves { result: 'allowed', invite } |
// { result: 'denied' | 'timeout' | 'offline' } | { result: 'refused', reason }.
export function startFriendKnock({ room, identity, name, send, onState = () => {}, stepMs = KNOCK_LIMITS.stepMs,
    waitMs = KNOCK_LIMITS.promptMs + 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const kid = randomBytes(16).toString('base64url')
    const knocker = createKnocker({ code: { codeId: FRIEND_KNOCK_CODE }, access: knockAccess(room.id, room.owner), identity, name })
    let settled = false
    let timer = null
    let resolveResult
    const result = new Promise(resolve => { resolveResult = resolve })
    const out = line => send({ type: 'pm', v: 1, op: 'knock', kid, line })
    const unproved = () => (knocker.provedOwner() ? { result: 'timeout' } : { result: 'offline' })
    function finish(value, { notify = true } = {}) {
        if (settled) return
        settled = true
        clearTimer(timer)
        if (notify) send({ type: 'pm', v: 1, op: 'knock-end', kid })
        resolveResult(value)
    }
    function arm(ms) {
        clearTimer(timer)
        timer = setTimer(() => finish(unproved()), ms)
        timer?.unref?.()
    }
    // The end result of knock.mjs for the joiner. A friend that could not reach the owner gives 'offline'.
    function outcome(done) {
        if (done.result === 'not-owner') return { result: 'offline' }
        if (done.result === 'refused' && done.reason === 'offline') return { result: 'offline' }
        return done
    }
    const api = {
        kid,
        result,
        handle(message) {
            if (settled || message?.kid !== kid) return
            if (message.op === 'knock-end') return finish(message.offline === true ? { result: 'offline' } : unproved(), { notify: false })
            if (message.op !== 'knock' || !isObject(message.line) || byteSize(message.line) > FRIEND_KNOCK_LIMITS.maxAnswerBytes) return
            const step = knocker.receive(message.line)
            if (step.send) {
                out(step.send)
                arm(waitMs)
            }
            if (step.waiting) onState('waiting')
            if (step.done) finish(outcome(step.done))
        },
        // The friend link session closed.
        closed() { finish(unproved(), { notify: false }) },
        cancel() { finish({ result: 'offline' }) }
    }
    arm(stepMs)
    if (!out(knocker.hello())) finish({ result: 'offline' }, { notify: false })
    return api
}
