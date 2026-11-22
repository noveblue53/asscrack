// G7a: private messages between two friends, on the session of their friend room (design F8).
//   { type: 'pm', v: 1, op: 'msg', id, text, time, away }   a message; id is '<device ID>.<uuid>'
//   { type: 'pm', v: 1, op: 'ack', id }                     the receiver got the message (always, also for a repeat)
//   { type: 'pm', v: 1, op: 'unfriend' }                    the sender removed the friend
//   { type: 'pm', v: 1, op: 'invite', id, code, time, away } easy-join: a device invite of a room (friend-invite.mjs);
//                                                            the same id form and ack as a message
// The receiver accepts a line only from the device of the friend and shows each id one time.
// send() resolves 'delivered', 'unconfirmed' (no ack in 15 s, or closed()) or 'unavailable' (no session); 'invalid' for
// bad text; 'busy' while the same id waits for its ack.
import { randomUUID } from 'node:crypto'

export const PM_ACK_MS = 15000
export const PM_MAX_TEXT = 4096
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
export const validPmText = text => typeof text === 'string' && text.length >= 1 && text.length <= PM_MAX_TEXT && text.trim().length > 0
// easy-join: the form of the code of an 'invite' line (friend-invite.mjs makes the full check).
export const validPmInvite = code => typeof code === 'string' && code.length <= PM_MAX_TEXT && /^asscrack3:[A-Za-z0-9_-]+$/.test(code)

// selfDevice, friendDevice: the device IDs of the two sides. sessionPeer() -> the peer ID of the open session to the
// friend, or null. sendTo(peerId, line) -> boolean. receive({ id, text | invite, time, away }) for a new message.
// seen(id) -> boolean: the id is in the archive. acked(id, result): a receipt ('delivered' also after 'unconfirmed').
// unfriended(): the friend removed this device.
export function createPrivateMessages({ selfDevice, friendDevice, sessionPeer, sendTo, receive, seen = () => false,
    acked = () => {}, unfriended = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    timeoutMs = PM_ACK_MS } = {}) {
    const idPattern = new RegExp(`^${friendDevice.replace(/[^A-Za-z0-9_-]/g, '')}\\.${uuid}$`, 'i')
    const pending = new Map() // id -> { resolve, timer }
    const late = new Set() // ids that resolved 'unconfirmed': a later ack still gives a receipt
    const recent = new Set()
    let lastTime = 0 // G7b: the last time of a received message
    let stopped = false

    const line = (peerId, fields) => sendTo(peerId, { type: 'pm', v: 1, ...fields })

    function finish(id, result) {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        clearTimer(entry.timer)
        if (result === 'unconfirmed') {
            late.add(id)
            if (late.size > 256) late.delete(late.values().next().value)
        }
        entry.resolve(result)
        acked(id, result)
    }

    function deliver(id, fields, time, away) {
        if (stopped) return Promise.resolve('unavailable')
        if (typeof id !== 'string' || !id.startsWith(`${selfDevice}.`)) return Promise.resolve('invalid')
        const peerId = sessionPeer()
        if (!peerId) return Promise.resolve('unavailable')
        if (pending.has(id)) return Promise.resolve('busy')
        return new Promise(resolve => {
            const timer = setTimer(() => finish(id, 'unconfirmed'), timeoutMs)
            timer?.unref?.()
            pending.set(id, { resolve, timer, peerId })
            if (!line(peerId, { ...fields, id, time, away: away === true })) {
                pending.delete(id)
                clearTimer(timer)
                resolve('unavailable')
            }
        })
    }

    return {
        newId: () => `${selfDevice}.${randomUUID()}`,
        // Send one message. The caller makes the id (newId) and keeps it for a resend.
        send(id, text, { time = now(), away = false } = {}) {
            if (!validPmText(text)) return Promise.resolve(stopped ? 'unavailable' : 'invalid')
            return deliver(id, { op: 'msg', text }, time, away)
        },
        // easy-join: send one device invite (the code of a room). The same id, ack and receipt as a message.
        sendInvite(id, code, { time = now(), away = false } = {}) {
            if (!validPmInvite(code)) return Promise.resolve(stopped ? 'unavailable' : 'invalid')
            return deliver(id, { op: 'invite', code }, time, away)
        },
        // G7b: the session to peerId closed. Each message on it with no ack ends now as 'unconfirmed', thus the next
        // session can send it again (the receiver shows each id one time).
        closed(peerId) {
            for (const [id, entry] of [...pending]) if (entry.peerId === peerId) finish(id, 'unconfirmed')
        },
        // Tell the friend that this device removed it. Returns true when a session took the line.
        unfriend() {
            const peerId = sessionPeer()
            return Boolean(peerId && line(peerId, { op: 'unfriend' }))
        },
        // A 'pm' event of the friend node: { peerId, deviceId, message }.
        handle({ peerId, deviceId, message: msg } = {}) {
            if (stopped || deviceId !== friendDevice || !msg || msg.v !== 1) return
            if (msg.op === 'unfriend') { unfriended(); return }
            if (typeof msg.id !== 'string' || msg.id.length > 256) return
            if (msg.op === 'ack') {
                if (pending.has(msg.id)) finish(msg.id, 'delivered')
                else if (late.delete(msg.id)) acked(msg.id, 'delivered')
                return
            }
            const invite = msg.op === 'invite'
            if (!idPattern.test(msg.id)) return
            if (invite ? !validPmInvite(msg.code) : msg.op !== 'msg' || !validPmText(msg.text)) return
            if (!recent.has(msg.id) && !seen(msg.id)) {
                // The time of the sender, but never in the future of this computer. G7b: a time that is cut to now()
                // (a sender clock in the future, or no time) is after the last received time, thus a burst of queued
                // lines keeps its order in the archive (the order is time, then id).
                const sent = Number.isFinite(msg.time) && msg.time > 0 ? msg.time : null
                const time = sent !== null && sent <= now() ? sent : Math.max(now(), lastTime + 1)
                lastTime = Math.max(lastTime, time)
                const content = invite ? { invite: msg.code } : { text: msg.text }
                if (receive({ id: msg.id, ...content, time, away: msg.away === true }) === false) return
            }
            recent.add(msg.id)
            if (recent.size > 1024) recent.delete(recent.values().next().value)
            line(peerId, { op: 'ack', id: msg.id })
        },
        stop() {
            stopped = true
            for (const id of [...pending.keys()]) finish(id, 'unconfirmed')
            late.clear()
            recent.clear()
        }
    }
}
