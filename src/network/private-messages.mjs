// G7a: private messages between two friends, on the session of their friend room (design F8).
//   { type: 'pm', v: 1, op: 'msg', id, text, time, away }   a message; id is '<device ID>.<uuid>'
//   { type: 'pm', v: 1, op: 'ack', id }                     the receiver got the message (always, also for a repeat)
//   { type: 'pm', v: 1, op: 'unfriend' }                    the sender removed the friend
// The receiver accepts a line only from the device of the friend and shows each id one time.
// send() resolves 'delivered', 'unconfirmed' (no ack in 15 s) or 'unavailable' (no session); 'invalid' for bad text.
import { randomUUID } from 'node:crypto'

export const PM_ACK_MS = 15000
export const PM_MAX_TEXT = 4096
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
export const validPmText = text => typeof text === 'string' && text.length >= 1 && text.length <= PM_MAX_TEXT && text.trim().length > 0

// selfDevice, friendDevice: the device IDs of the two sides. sessionPeer() -> the peer ID of the open session to the
// friend, or null. sendTo(peerId, line) -> boolean. receive({ id, text, time, away }) for a new message.
// seen(id) -> boolean: the id is in the archive. acked(id, result): a receipt ('delivered' also after 'unconfirmed').
// unfriended(): the friend removed this device.
export function createPrivateMessages({ selfDevice, friendDevice, sessionPeer, sendTo, receive, seen = () => false,
    acked = () => {}, unfriended = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    timeoutMs = PM_ACK_MS } = {}) {
    const idPattern = new RegExp(`^${friendDevice.replace(/[^A-Za-z0-9_-]/g, '')}\\.${uuid}$`, 'i')
    const pending = new Map() // id -> { resolve, timer }
    const late = new Set() // ids that resolved 'unconfirmed': a later ack still gives a receipt
    const recent = new Set()
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

    return {
        newId: () => `${selfDevice}.${randomUUID()}`,
        // Send one message. The caller makes the id (newId) and keeps it for a resend.
        send(id, text, { time = now(), away = false } = {}) {
            if (stopped) return Promise.resolve('unavailable')
            if (!validPmText(text) || typeof id !== 'string' || !id.startsWith(`${selfDevice}.`)) return Promise.resolve('invalid')
            const peerId = sessionPeer()
            if (!peerId) return Promise.resolve('unavailable')
            if (pending.has(id)) return Promise.resolve('busy')
            return new Promise(resolve => {
                const timer = setTimer(() => finish(id, 'unconfirmed'), timeoutMs)
                timer?.unref?.()
                pending.set(id, { resolve, timer })
                if (!line(peerId, { op: 'msg', id, text, time, away: away === true })) {
                    pending.delete(id)
                    clearTimer(timer)
                    resolve('unavailable')
                }
            })
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
            if (msg.op !== 'msg' || !idPattern.test(msg.id) || !validPmText(msg.text)) return
            if (!recent.has(msg.id) && !seen(msg.id)) {
                // The time of the sender, but never in the future of this computer.
                const time = Number.isFinite(msg.time) && msg.time > 0 ? Math.min(msg.time, now()) : now()
                if (receive({ id: msg.id, text: msg.text, time, away: msg.away === true }) === false) return
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
