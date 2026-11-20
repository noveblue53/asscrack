// Diagnostic copies use a new pseudonym key for each room session. Store only projected text.
import { createHmac, randomBytes } from 'node:crypto'

const dialPaths = new Set(['full-node', 'address', 'dial-back', 'reserve', 'relay', 'discovery', 'connect'])
const dialReasons = new Set(['wrong-peer', 'no-reservation', 'refused', 'unreachable', 'timeout'])

export function observeRoomActivity(node, now = Date.now) {
    const key = randomBytes(32)
    const entries = []
    function peer(id) {
        if (id === node.peerId) return 'this device'
        if (typeof id !== 'string' || !id || id === '?' || id.length > 128) return 'unknown peer'
        return 'peer ' + createHmac('sha256', key).update(id).digest('hex').slice(0, 8)
    }
    function record(text, coalesce = false) {
        const time = now()
        if (coalesce) {
            const previous = entries.findLast(entry => entry.text === text && time - entry.time < 60000)
            if (previous) {
                previous.count++
                return
            }
        }
        entries.push({ time, text, count: 1 })
        if (entries.length > 100) entries.shift()
    }
    node.events.on('connection', ev => {
        if (ev?.state !== 'session' && ev?.state !== 'closed') return
        const route = ev.type === 'relay' ? 'relayed' : ev.type === 'direct' ? 'direct' : 'unknown route'
        const state = ev.state === 'session' ? 'opened' : 'closed'
        const relay = ev.state === 'session' && ev.type === 'relay' ? ' via ' + peer(ev.relay) : ''
        record('Chat ' + state + ' (' + route + ') with ' + peer(ev.peer) + relay)
    })
    node.events.on('dial-failed', ev => {
        if (!ev) return
        const path = dialPaths.has(ev.via) ? ev.via : 'unknown route'
        const reason = dialReasons.has(ev.reason) ? ev.reason : 'other'
        record('Dial failed (' + path + ', ' + reason + ') to ' + peer(ev.peer), true)
    })
    node.events.on('host-changed', ev => {
        if (!ev) return
        record(ev.peerId ? 'Host observed: ' + peer(ev.peerId) : 'Waiting for a host')
    })
    node.events.on('upnp', ev => {
        if (ev?.state === 'mapped') record('Local UPnP mapping created')
        if (ev?.state === 'unmapped') record('Local UPnP mapping removed')
        if (ev?.state === 'none') record('Local UPnP mapping unavailable')
    })
    return () => entries.map(({ time, text, count }) =>
        new Date(time).toISOString() + '  ' + text + (count > 1 ? ' ×' + (count > 99999 ? '99999+' : count) : ''))
}
