// G7a: friend requests on the session of a protected room (DECISIONS.md G7a, design F3).
// Each line goes only on the session of the addressee: { type: 'friend', v: 1, op, id, ... }.
//   request (name)                                   A -> B
//   accept | decline                                 B -> A
//   grant (room, key, descriptor, port, nodes)       A -> B
//   done (port, nodes) | failed                      B -> A (failed also A -> B)
// This module has no network and no archive. The caller gives send(), the proved device ID of each line, and the
// two steps that make and keep the friend room (makeGrant on A, acceptGrant on B). The timers can be injected.
import { randomUUID } from 'node:crypto'
import { validAddr, validPeerId } from './invite.mjs'

export const FRIEND_REQUEST_MS = 120000
export const FRIEND_RATE_MS = 60000
const MAX_NODES = 16
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// The name of a friend room: 'friend-' and 22 base64url characters (16 random bytes).
export const validFriendRoom = room => typeof room === 'string' && /^friend-[A-Za-z0-9_-]{22}$/.test(room)
export const validName = name => typeof name === 'string' && name.trim().length > 0 && name.length <= 64
export const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535

// The node list of a grant or done line: the rules of readInvite (at most 16 nodes, a valid peer ID, 1 to 16 valid
// addresses each). Returns a copy, or null. An empty list is valid (no candidate address).
export function validNodes(nodes) {
    if (!Array.isArray(nodes) || nodes.length > MAX_NODES) return null
    const out = []
    for (const n of nodes) {
        if (n === null || typeof n !== 'object' || !validPeerId(n.id)) return null
        if (!Array.isArray(n.addrs) || n.addrs.length < 1 || n.addrs.length > MAX_NODES || !n.addrs.every(validAddr)) return null
        out.push({ id: n.id, addrs: [...n.addrs] })
    }
    return out
}

// send(peerId, line) -> boolean. isBlocked(deviceId) -> boolean.
// makeGrant({ peerId, deviceId, name }) -> Promise<{ room, key, descriptor, port, nodes }> (A: the room is saved and
//   its node runs). acceptGrant({ peerId, deviceId, name, grant }) -> Promise<{ port, nodes }> (B: all checks, save,
//   start). Each throws for a refusal.
// done({ peerId, deviceId, port, nodes }) (A: the done line, for the candidates of B). undo({ deviceId }) (A: B sent
//   failed after the grant: forget the friend room).
// changed(event): { kind: 'incoming', id, peerId, name } | { kind: 'outgoing', id, peerId, name } |
//   { kind: 'ended', id, peerId, name, side: 'out'|'in', result: 'friend'|'declined'|'no-answer'|'failed'|'closed' }
export function createFriendRequests({ send, isBlocked = () => false, makeGrant, acceptGrant, done = () => {},
    undo = () => {}, changed = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    requestMs = FRIEND_REQUEST_MS, rateMs = FRIEND_RATE_MS } = {}) {
    // peerId -> { id, deviceId, name, state: 'sent'|'granted', timer } (requests of this device)
    const outgoing = new Map()
    // id -> { peerId, deviceId, name, state: 'open'|'accepted'|'saving', timer } (requests to this device)
    const incoming = new Map()
    const lastRequest = new Map() // deviceId -> time of the last request line that was accepted
    let stopped = false

    const line = (peerId, op, id, fields = {}) => send(peerId, { type: 'friend', v: 1, op, id, ...fields })

    function endOut(peerId, result) {
        const entry = outgoing.get(peerId)
        if (!entry) return
        outgoing.delete(peerId)
        clearTimer(entry.timer)
        changed({ kind: 'ended', side: 'out', id: entry.id, peerId, name: entry.name, deviceId: entry.deviceId, result })
    }
    function endIn(id, result) {
        const entry = incoming.get(id)
        if (!entry) return
        incoming.delete(id)
        clearTimer(entry.timer)
        changed({ kind: 'ended', side: 'in', id, peerId: entry.peerId, name: entry.name, deviceId: entry.deviceId, result })
    }
    const incomingFrom = peerId => [...incoming].find(([, entry]) => entry.peerId === peerId)

    async function onAccept(peerId, entry) {
        entry.state = 'granted'
        let grant
        try {
            grant = await makeGrant({ peerId, deviceId: entry.deviceId, name: entry.name })
        } catch {
            if (outgoing.get(peerId) === entry) {
                line(peerId, 'failed', entry.id)
                endOut(peerId, 'failed')
            }
            return
        }
        if (stopped || outgoing.get(peerId) !== entry) return
        if (!line(peerId, 'grant', entry.id, grant)) endOut(peerId, 'closed')
    }

    async function onGrant(peerId, deviceId, id, entry, msg) {
        entry.state = 'saving'
        const nodes = validNodes(msg.nodes)
        const grant = { room: msg.room, key: msg.key, descriptor: msg.descriptor, port: msg.port, nodes }
        let result
        try {
            if (!validFriendRoom(msg.room) || typeof msg.key !== 'string' || !msg.descriptor || typeof msg.descriptor !== 'object' ||
                !validPort(msg.port) || nodes === null) throw new Error('bad grant')
            result = await acceptGrant({ peerId, deviceId, name: entry.name, grant })
        } catch {
            line(peerId, 'failed', id)
            endIn(id, 'failed')
            return
        }
        line(peerId, 'done', id, { port: result.port, nodes: result.nodes })
        endIn(id, 'friend')
    }

    return {
        // A: send a request to a peer. ownName goes on the line; peerName is the name of the peer in the room (for the
        // texts and the nickname). Returns 'sent', 'busy' (a request to or from this peer is open), 'invalid' or
        // 'unavailable' (no session).
        request(peerId, deviceId, ownName, peerName = '') {
            if (stopped || !deviceId) return 'unavailable'
            if (!validName(ownName)) return 'invalid'
            if (outgoing.has(peerId) || incomingFrom(peerId)) return 'busy'
            const id = randomUUID()
            const entry = { id, deviceId, name: String(peerName).trim().slice(0, 64), state: 'sent', timer: null }
            if (!line(peerId, 'request', id, { name: ownName.trim() })) return 'unavailable'
            entry.timer = setTimer(() => endOut(peerId, 'no-answer'), requestMs)
            entry.timer?.unref?.()
            outgoing.set(peerId, entry)
            changed({ kind: 'outgoing', id, peerId, deviceId, name: entry.name })
            return 'sent'
        },
        // B: the answer of the user. Returns false for an unknown or ended request.
        respond(id, accept) {
            const entry = incoming.get(id)
            if (stopped || !entry || entry.state !== 'open') return false
            if (accept !== true) {
                line(entry.peerId, 'decline', id)
                endIn(id, 'declined')
                return true
            }
            if (!line(entry.peerId, 'accept', id)) {
                endIn(id, 'closed')
                return false
            }
            entry.state = 'accepted'
            return true
        },
        // A line of type 'friend' from the room node: { peerId, deviceId, message }.
        handle({ peerId, deviceId, message: msg } = {}) {
            if (stopped || !msg || msg.v !== 1 || typeof msg.id !== 'string' || !uuid.test(msg.id) || typeof deviceId !== 'string') return
            const id = msg.id
            const out = outgoing.get(peerId)
            switch (msg.op) {
                case 'request': {
                    if (!validName(msg.name)) return
                    if (isBlocked(deviceId)) { line(peerId, 'decline', id); return }
                    const last = lastRequest.get(deviceId)
                    if (last !== undefined && now() - last < rateMs) return
                    if (incomingFrom(peerId) || outgoing.has(peerId) || incoming.has(id)) return
                    lastRequest.set(deviceId, now())
                    const name = msg.name.trim()
                    const timer = setTimer(() => endIn(id, 'no-answer'), requestMs)
                    timer?.unref?.()
                    incoming.set(id, { peerId, deviceId, name, state: 'open', timer })
                    changed({ kind: 'incoming', id, peerId, deviceId, name })
                    return
                }
                case 'accept':
                    if (out?.id === id && out.deviceId === deviceId && out.state === 'sent') onAccept(peerId, out)
                    return
                case 'decline':
                    if (out?.id === id && out.deviceId === deviceId && out.state === 'sent') endOut(peerId, 'declined')
                    return
                case 'grant': {
                    const entry = incoming.get(id)
                    if (entry?.peerId === peerId && entry.deviceId === deviceId && entry.state === 'accepted') onGrant(peerId, deviceId, id, entry, msg)
                    return
                }
                case 'done': {
                    if (out?.id !== id || out.deviceId !== deviceId || out.state !== 'granted') return
                    const nodes = validNodes(msg.nodes)
                    if (validPort(msg.port) && nodes !== null) done({ peerId, deviceId, port: msg.port, nodes })
                    endOut(peerId, 'friend')
                    return
                }
                case 'failed': {
                    if (out?.id === id && out.deviceId === deviceId) {
                        if (out.state === 'granted') undo({ deviceId })
                        endOut(peerId, 'failed')
                        return
                    }
                    const entry = incoming.get(id)
                    if (entry?.peerId === peerId && entry.deviceId === deviceId) endIn(id, 'failed')
                    return
                }
                default:
            }
        },
        // The session to the peer closed. A grant that was sent stays: B saves before done (DECISIONS.md G7a).
        closed(peerId) {
            if (outgoing.has(peerId)) endOut(peerId, 'closed')
            for (const [id, entry] of [...incoming]) if (entry.peerId === peerId && entry.state !== 'saving') endIn(id, 'closed')
        },
        outgoing: () => [...outgoing].map(([peerId, e]) => ({ id: e.id, peerId, deviceId: e.deviceId, state: e.state })),
        incoming: () => [...incoming].map(([id, e]) => ({ id, peerId: e.peerId, deviceId: e.deviceId, name: e.name, state: e.state })),
        pendingTo: peerId => outgoing.has(peerId) || Boolean(incomingFrom(peerId)),
        stop() {
            stopped = true
            for (const peerId of [...outgoing.keys()]) endOut(peerId, 'closed')
            for (const id of [...incoming.keys()]) endIn(id, 'closed')
        }
    }
}
