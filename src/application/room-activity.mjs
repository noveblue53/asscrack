// Diagnostic copies use a new pseudonym key for each room session. Store only projected text.
import { createHmac, randomBytes } from 'node:crypto'

const dialPaths = new Set(['full-node', 'address', 'dial-back', 'reserve', 'relay', 'discovery', 'connect'])
const dialReasons = new Set(['wrong-peer', 'no-reservation', 'refused', 'unreachable', 'timeout'])

export function observeRoomActivity(node, now = Date.now) {
    const key = randomBytes(32)
    const entries = []
    function alias(kind, id) {
        return kind + ' ' + createHmac('sha256', key).update(kind + ':' + id).digest('hex').slice(0, 8)
    }
    function peer(id) {
        if (id === node.peerId) return 'this device'
        if (typeof id !== 'string' || !id || id === '?' || id.length > 128) return 'unknown peer'
        return alias('peer', id)
    }
    function record(text, peers, { transfer = false, coalesce = false } = {}) {
        const time = now()
        if (coalesce) {
            const previous = entries.findLast(entry => entry.text === text && time - entry.time < 60000)
            if (previous) {
                previous.count++
                return
            }
        }
        entries.push({ time, text, count: 1, peers, transfer })
        if (entries.length > 100) entries.shift()
    }
    node.events.on('connection', ev => {
        if (ev?.state !== 'session' && ev?.state !== 'closed') return
        const route = ev.type === 'relay' ? 'relayed' : ev.type === 'direct' ? 'direct' : 'unknown route'
        const state = ev.state === 'session' ? 'opened' : 'closed'
        const remote = peer(ev.peer)
        const relay = ev.state === 'session' && ev.type === 'relay' ? peer(ev.relay) : null
        record('Chat ' + state + ' (' + route + ') with ' + remote + (relay ? ' via ' + relay : ''),
            relay ? [remote, relay] : [remote])
    })
    node.events.on('dial-failed', ev => {
        if (!ev) return
        const path = dialPaths.has(ev.via) ? ev.via : 'unknown route'
        const reason = dialReasons.has(ev.reason) ? ev.reason : 'other'
        const remote = peer(ev.peer)
        record('Dial failed (' + path + ', ' + reason + ') to ' + remote, [remote], { coalesce: true })
    })
    node.events.on('host-changed', ev => {
        if (!ev) return
        const host = ev.peerId ? peer(ev.peerId) : null
        record(host ? 'Host observed: ' + host : 'Waiting for a host', host ? [host] : [])
    })
    node.events.on('upnp', ev => {
        if (ev?.state === 'mapped') record('Local UPnP mapping created', ['this device'])
        if (ev?.state === 'unmapped') record('Local UPnP mapping removed', ['this device'])
        if (ev?.state === 'none') record('Local UPnP mapping unavailable', ['this device'])
    })
    // Only file-transfer events from this node identify a local outcome. Topology reports
    // about other peers' transfers never enter the feed. Reasons, paths and names stay out.
    for (const event of ['file-done', 'file-failed', 'file-refused', 'file-cancelled']) {
        node.events.on(event, ev => {
            if (typeof ev?.offerId !== 'string' || !ev.offerId || ev.offerId.length > 128) return
            const direction = event === 'file-refused' ? 'send' : ev.direction
            if (direction !== 'send' && direction !== 'receive') return
            const remote = peer(ev.peerId)
            const offer = alias('offer', ev.offerId)
            let outcome
            if (event === 'file-done') {
                if (direction === 'receive') outcome = 'saved'
                else outcome = ev.confirmed === true ? 'delivered' : 'sent (unconfirmed)'
            } else if (event === 'file-refused') outcome = 'refused'
            else if (event === 'file-cancelled') outcome = 'cancelled'
            else outcome = 'failed'
            const action = direction === 'send' ? 'Send to ' : 'Receive from '
            record(action + remote + ' · ' + offer + ' · ' + outcome, [remote, 'this device'], { transfer: true })
        })
    }
    const read = ({ peerId = null, transfersOnly = false } = {}) => {
        const target = peerId === null ? null : peer(peerId)
        return entries.filter(entry => (!target || entry.peers.includes(target)) && (!transfersOnly || entry.transfer))
            .map(({ time, text, count }) => new Date(time).toISOString() + '  ' + text +
                (count > 1 ? ' ×' + (count > 99999 ? '99999+' : count) : ''))
    }
    // Gap B5: the pseudonym of each peer ID in the lines (up to 64 IDs). The peer inspector puts the buddy name in
    // place of each known pseudonym. The lines and the diagnostics copy do not change.
    read.aliases = ids => Array.isArray(ids) ? ids.slice(0, 64).map(peer) : []
    return read
}
