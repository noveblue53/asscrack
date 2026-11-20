import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { mdns } from '@libp2p/mdns'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { multiaddr } from '@multiformats/multiaddr'
import { identify } from '@libp2p/identify'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { networkInterfaces } from 'node:os'
import { createChatSession } from './chat-session.mjs'
import { createElection } from './election.mjs'
import { createHistory } from './history.mjs'
import { createFileTransfer, FILE_PROTOCOL } from './file-transfer.mjs'
import { createVoiceRelay, VOICE_PROTOCOL, VOICE_DIRECT_PROTOCOL } from './voice-relay.mjs'
import { makeInvite, validAddr, validPeerId } from './invite.mjs'
import { DIALBACK_PROTOCOL, handleDialback, requestDialback, isPrivateIp, observedIp, tcpTarget } from './fullnode.mjs'
import { onUpnpRouterError } from './upnp-guard.mjs'

export { FILE_PROTOCOL, safeFileName } from './file-transfer.mjs'
export { VOICE_PROTOCOL, VOICE_DIRECT_PROTOCOL } from './voice-relay.mjs'

export const CHAT_PROTOCOL = '/asscrack/chat/receive'

// The reason class of a failed dial. Looks into err.errors (AggregateError) and err.cause.
export function dialReason(err) {
    const found = new Set()
    const seen = new Set()
    const walk = e => {
        if (!e || typeof e !== 'object' || seen.has(e) || seen.size > 50) {
            if (typeof e === 'string') found.add(e)
            return
        }
        seen.add(e)
        if (typeof e.code === 'string') found.add(e.code)
        if (typeof e.name === 'string') found.add(e.name)
        if (typeof e.message === 'string') found.add(e.message)
        if (Array.isArray(e.errors)) for (const x of e.errors) walk(x)
        if (e.cause) walk(e.cause)
    }
    walk(err)
    const all = [...found]
    const has = list => all.some(v => list.includes(v))
    const text = all.join(' | ')
    if (has(['UnexpectedPeerError', 'ERR_UNEXPECTED_PEER', 'ERR_INVALID_PEER']) || /unexpected peer|peer id .*(mismatch|did not match|does not match)/i.test(text)) return 'wrong-peer'
    if (/NO_RESERVATION|no reservation/i.test(text)) return 'no-reservation'
    if (has(['ECONNREFUSED'])) return 'refused'
    if (has(['EHOSTUNREACH', 'ENETUNREACH'])) return 'unreachable'
    if (has(['AbortError', 'TimeoutError', 'ETIMEDOUT'])) return 'timeout'
    return 'other'
}

// One log line: a fixed tag, then key=value fields. A value with a space or a quote is in JSON quotes.
function connText(tag, fields) {
    const parts = [tag]
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue
        const t = String(v)
        parts.push(`${k}=${/^[^\s"=]+$/.test(t) ? t : JSON.stringify(t)}`)
    }
    return parts.join(' ')
}

function circuitRelay(addr) {
    const m = /\/p2p\/([^/]+)\/p2p-circuit/.exec(addr)
    return m ? m[1] : null
}
const PROOF_TIMEOUT_MS = 10000
const MAX_ADDRS = 16

// A room key is 32 bytes: a Uint8Array or a base64url string. Returns a Buffer, or null for a LAN room.
export function parseRoomKey(roomKey) {
    if (roomKey === null || roomKey === undefined) return null
    let b = null
    if (typeof roomKey === 'string' && /^[A-Za-z0-9_-]+$/.test(roomKey)) b = Buffer.from(roomKey, 'base64url')
    else if (roomKey instanceof Uint8Array) b = Buffer.from(roomKey)
    if (!b || b.length !== 32) throw new TypeError('roomKey must be 32 bytes (a Uint8Array or a base64url string)')
    return b
}

// The mDNS tag of a room. A keyed room adds the first 16 hex characters of SHA-256(roomKey).
export function keyedServiceTag(room, roomKey) {
    const key = parseRoomKey(roomKey)
    if (!key) return roomServiceTag(room)
    return roomServiceTag(room + '\n' + createHash('sha256').update(key).digest('hex').slice(0, 16))
}

export function roomServiceTag(room) {
    const h = createHash('sha256').update(room).digest('hex').slice(0, 8)
    return `_asscrack-${h}._udp.local`
}

// One chat line is one JSON object: { id?: string, from: string, text: string, time: number }.
// A line with no id (goal 1 format) gets an id from the sender peer ID, the time and the text.
function parseMessage(line, peerId) {
    let value
    try {
        value = JSON.parse(line)
    } catch {
        return null
    }
    if (value === null || typeof value !== 'object') return null
    const { from, text, time } = value
    if (typeof from !== 'string' || typeof text !== 'string' || typeof time !== 'number') return null
    const id = typeof value.id === 'string' && value.id !== ''
        ? value.id
        : createHash('sha256').update(`${peerId}
${time}
${text}`).digest('hex')
    return { id, from, text, time }
}

function validHistoryItem(m) {
    return m !== null && typeof m === 'object' && typeof m.id === 'string' && typeof m.from === 'string' &&
        typeof m.text === 'string' && typeof m.time === 'number'
}

export async function createAsscrackNode({ room, listen, port = 0, discovery = true, discoveryInterval, name,
    heartbeatInterval = 1000, hostTimeout = 5000, electionDelay = 3000, downloadDir,
    fullNode = 'auto', allowPrivateFullNode = false, relayOnly = false, roomKey = null, announce = [], storePath = null,
    redialInterval = 5000, inviteNodes = [], upnp = false, upnpTimeout = 70000, upnpClient = null, seedHistory = [] } = {}) {
    if (typeof room !== 'string') throw new TypeError('room must be a string')
    const key = parseRoomKey(roomKey)
    if (!Array.isArray(announce) || !announce.every(validAddr)) throw new TypeError('announce must be an array of multiaddr strings')
    if (fullNode !== 'auto' && fullNode !== true && fullNode !== false) throw new TypeError("fullNode must be 'auto', true or false")
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer from 0 to 65535')
    // Rule 5: a relay-only node has no TCP listen address and no mDNS.
    const listenAddrs = relayOnly ? [] : (listen ?? [`/ip4/0.0.0.0/tcp/${port}`])
    if (relayOnly) discovery = false
    // Rule 1: the current full-node state of this node.
    let selfFull = fullNode === true
    // Rule 3: a node that can become a full node runs the relay server. The gater refuses each reservation
    // when this node is not a full node, or when the peer is not allowed (allowReservation).
    const canBeFull = fullNode === true || (fullNode === 'auto' && !relayOnly)
    const services = { identify: identify() }
    if (canBeFull) services.relay = circuitRelayServer({ reservations: { applyDefaultLimit: false } })
    // UPnP (opt-in): only for a node that can become a full node by the dial-back. With upnp false, the module is
    // not loaded: no UPnP service, no SSDP and no timer.
    const useUpnp = upnp === true && fullNode === 'auto' && !relayOnly
    if (useUpnp) {
        const { uPnPNAT } = await import('@libp2p/upnp-nat')
        services.upnp = uPnPNAT({ description: 'asscrack' })
    }
    // Set after the sessions map exists.
    let allowReservation = () => false
    const node = await createLibp2p({
        start: false,
        addresses: { listen: listenAddrs, announce: [...announce] },
        transports: [tcp(), circuitRelayTransport()],
        services,
        connectionGater: { denyInboundRelayReservation: peerId => !allowReservation(peerId.toString()) },
        peerDiscovery: discovery ? [mdns({ serviceTag: keyedServiceTag(room, key), ...(discoveryInterval !== undefined ? { interval: discoveryInterval } : {}) })] : [],
        // The peer:discovery handler opens chat connections; no automatic dials.
        connectionManager: { minConnections: 0 },
        streamMuxers: [yamux()],
        connectionEncryption: [noise()]
    })
    if (useUpnp) {
        const service = node.services.upnp
        // Block the library default path. Its afterStart() calls mapIpAddresses(), which maps a RANDOM public port
        // (and, because of a start race, usually sees no listen address). An own no-op afterStart() on the instance
        // hides the method of the class, so libp2p calls the no-op and the library sends no AddPortMapping.
        // The node maps the port by hand after start (runUpnp). The stop() of the service still closes the client.
        service.afterStart = () => {}
        // Test option: a client on a fake router. The gateway option of uPnPNAT cannot point at a fake router
        // (it gives a device with an empty service list, thus "Service not found").
        if (upnpClient) service.client = upnpClient
    }
    if (name !== undefined && typeof name !== 'string') throw new TypeError('name must be a string')
    const senderName = name ?? node.peerId.toString().slice(-8)
    const events = new EventEmitter()
    const sessions = new Map()
    // The name that each open session sent in its hello line.
    const names = new Map()
    const history = createHistory(200)
    // seedHistory: records that this device keeps (for example saved lines). They go in the history before the
    // first session, thus a host replay can send them. Records that are not valid are ignored.
    if (Array.isArray(seedHistory)) {
        for (const m of seedHistory) if (validHistoryItem(m)) history.add(m)
    }
    const HISTORY_KEEP_MS = 10000
    // The last history line from each peer that was not the host when it arrived.
    const pendingHistory = new Map()
    const selfId = node.peerId.toString()
    // The last valid links list from each peer with an open session.
    const links = new Map()
    const MAX_LINKS = 256
    // The libp2p connection that carries the chat stream of each session (rule 9).
    const sessionConns = new Map()
    // The kinds of the last valid links line from each peer (rule 8).
    const linkKinds = new Map()
    // The full-node state that each peer sent in its node line (rule 6).
    const peerFull = new Map()

    // Rule 3. P2 adds the room key proof to this check.
    allowReservation = peerId => selfFull && sessions.has(peerId)

    function kindOf(peerId) {
        const conn = sessionConns.get(peerId)
        return conn && conn.remoteAddr.toString().includes('/p2p-circuit') ? 'relay' : 'mesh'
    }

    function selfKinds() {
        return Object.fromEntries([...sessions.keys()].map(p => [p, kindOf(p)]))
    }

    function topology() {
        const all = { [selfId]: [...sessions.keys()] }
        const kinds = { [selfId]: selfKinds() }
        for (const [peerId, list] of links) {
            if (!sessions.has(peerId)) continue
            all[peerId] = [...list]
            kinds[peerId] = { ...(linkKinds.get(peerId) ?? {}) }
        }
        return { self: selfId, links: all, kinds }
    }

    function emitTopology() {
        events.emit('topology', topology())
    }

    // Tell all open sessions which sessions this node has.
    function broadcastLinks() {
        const line = JSON.stringify({ type: 'links', peers: [...sessions.keys()], kinds: selfKinds() })
        for (const session of sessions.values()) session.send(line)
    }

    // The links line is untrusted data. Returns the list without duplicates, or null if it is not valid.
    function validLinks(peers) {
        if (!Array.isArray(peers) || peers.length > MAX_LINKS) return null
        for (const p of peers) if (typeof p !== 'string' || p.length < 1 || p.length > 128) return null
        return [...new Set(peers)]
    }

    // Keep only the kinds of listed peers with a known value.
    function validKinds(kinds, list) {
        const out = {}
        if (kinds === null || typeof kinds !== 'object' || Array.isArray(kinds)) return out
        for (const p of list) if (kinds[p] === 'relay' || kinds[p] === 'mesh') out[p] = kinds[p]
        return out
    }

    function applyHistory(messages) {
        if (!Array.isArray(messages)) return
        const added = []
        for (const m of messages) {
            if (!validHistoryItem(m)) continue
            if (history.add(m)) added.push({ id: m.id, from: m.from, text: m.text, time: m.time })
        }
        console.info(`History applied: ${added.length} of ${messages.length} messages are new`)
        events.emit('history', { messages: added })
    }

    // The host of the last onChange of the election.
    let lastHostId = null
    function sendHistoryTo(peerId, session) {
        const messages = history.list()
        session.send(JSON.stringify({ type: 'history', messages }))
        console.info(`History sent to ${peerId}: ${messages.length} messages`)
    }
    function sendHistoryToAll() {
        if (!election.isHost()) return
        for (const [peerId, session] of sessions) sendHistoryTo(peerId, session)
    }

    function handleHistory(peerId, control) {
        if (election.host()?.peerId === peerId) {
            applyHistory(control.messages)
            return
        }
        console.info(`History from ${peerId} kept until it is the host`)
        pendingHistory.set(peerId, { messages: control.messages, at: Date.now() })
    }
    let voiceState = { inVoice: false, streamId: null, muted: false }
    // peerId -> true for the peers in voice (from their voice lines).
    const peerVoice = new Map()
    let voiceRelay = null
    // peerId -> the last valid 'direct' list of that peer: the peers that get its frames on a direct stream.
    const peerDirect = new Map()
    const MAX_DIRECT = 64
    // A 0.5.2 peer ignores the field 'direct'.
    const voiceLine = () => JSON.stringify({
        type: 'voice', inVoice: voiceState.inVoice, streamId: voiceState.streamId, muted: voiceState.muted,
        direct: voiceRelay ? voiceRelay.directList() : []
    })
    // Manual status (presence) of this node. It lives for the life of the node.
    const PRESENCE_STATES = new Set(['available', 'away', 'dnd'])
    const MAX_PRESENCE_NOTE = 80
    let ownPresence = { state: 'available', note: '' }
    // peerId -> { state, note } from the presence lines of that peer.
    const peerPresence = new Map()
    // Trim the note, then cut it to 80 Unicode code points.
    const presenceNote = note => [...note.trim()].slice(0, MAX_PRESENCE_NOTE).join('')
    const presenceLine = () => JSON.stringify({ type: 'presence', v: 1, state: ownPresence.state, note: ownPresence.note })
    // Returns the list when it is valid: an array of at most 64 strings, each one a peer ID with a session.
    // Returns null when it is not valid.
    function validDirect(list) {
        if (!Array.isArray(list) || list.length > MAX_DIRECT) return null
        if (!list.every(p => typeof p === 'string' && sessions.has(p))) return null
        return list
    }

    const election = createElection({
        selfId: node.peerId.toString(),
        sendTo: (peerId, line) => { sessions.get(peerId)?.send(line) },
        broadcast: line => { for (const session of sessions.values()) session.send(line) },
        openPeers: () => [...sessions.keys()],
        isFullNode: peerId => peerId === selfId ? selfFull : peerFull.get(peerId) === true,
        onChange: info => {
            const wasHost = lastHostId === selfId
            lastHostId = info.peerId
            events.emit('host-changed', info)
            // A new host sends the history to each member with a session. A member whose session opened before
            // this election got no history from openSession(). Send after the host announcement.
            if (info.peerId === selfId && !wasHost) queueMicrotask(sendHistoryToAll)
            voiceRelay?.hostChanged()
            // Use a history line that arrived before this host was accepted.
            const kept = pendingHistory.get(info.peerId)
            if (kept) {
                pendingHistory.delete(info.peerId)
                if (Date.now() - kept.at <= HISTORY_KEEP_MS) applyHistory(kept.messages)
                else console.info(`History from ${info.peerId} dropped: older than ${HISTORY_KEEP_MS} ms`)
            }
        },
        heartbeatInterval,
        hostTimeout,
        electionDelay
    })

    voiceRelay = createVoiceRelay({
        libp2p: node,
        selfId: node.peerId.toString(),
        hostId: () => election.host()?.peerId ?? null,
        voicePeers: () => {
            const list = [...peerVoice.keys()].filter(p => sessions.has(p))
            if (voiceState.inVoice) list.push(node.peerId.toString())
            return list
        },
        connectionFor: peerId => sessionConns.get(peerId) ?? node.getConnections().find(c => c.remotePeer.toString() === peerId),
        onFrame: frame => events.emit('voice-frame', frame),
        // Voice peers whose session connection is not relayed.
        directCandidates: () => [...peerVoice.keys()].filter(p => {
            const conn = sessionConns.get(p)
            return sessions.has(p) && conn && !conn.remoteAddr.toString().includes('/p2p-circuit')
        }),
        directListOf: peerId => peerDirect.get(peerId) ?? null,
        // Send the voice line again, so that the host knows which peers to forward to.
        onDirectChanged: () => {
            const line = voiceLine()
            for (const session of sessions.values()) session.send(line)
        }
    })

    const files = createFileTransfer({
        libp2p: node,
        events,
        sendTo: (peerId, message) => sessions.get(peerId)?.send(JSON.stringify(message)) ?? false,
        openPeers: () => [...sessions.keys()],
        peerNames: () => Object.fromEntries([...names].filter(([peerId]) => sessions.has(peerId))),
        downloadDir
    })

    // A line with a "type" field is a control line. Other lines are chat lines.
    function controlMessage(line) {
        let value
        try {
            value = JSON.parse(line)
        } catch {
            return null
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'type')) return null
        return value
    }

    // The proof of a keyed room: HMAC-SHA256 over the nonce of the receiver and both peer IDs.
    function proofMac(peerNonce, senderId, receiverId) {
        return createHmac('sha256', key)
            .update(`asscrack-proof/1\n${room}\n${peerNonce}\n${senderId}\n${receiverId}`)
            .digest()
    }

    // Streams of a keyed room that have no valid proof yet.
    const pendingChats = new Map()
    // The initiator of the chat stream of each session and pending session: selfId for an outbound stream, the
    // peer ID for an inbound stream.
    const chatInitiator = new WeakMap()
    // Open sessions whose chat stream ended. A new chat stream always replaces such a session.
    const endedSessions = new WeakSet()
    // Open sessions that a new chat stream replaced.
    const replacedSessions = new WeakSet()
    // For each pending session: a promise that settles when the session opens or fails.
    const pendingSettled = new WeakMap()

    // Cross race rule: two chat streams to one peer can exist when both peers open one at the same time. Both ends
    // keep the stream that the lower peer ID opened. Returns true when the new stream replaces the old session.
    function newStreamWins(old, initiator, peerId) {
        if (endedSessions.has(old)) return true
        const oldInitiator = chatInitiator.get(old)
        const lower = selfId < peerId ? selfId : peerId
        return oldInitiator !== undefined && initiator !== oldInitiator && initiator === lower
    }

    // A chat stream in negotiation or a pending session can still replace the ended session of a peer. Wait for it,
    // so that a cross race does not close the session of the peer.
    async function replacementSettled(peerId, session) {
        let last = null
        while (!stopped && sessions.get(peerId) === session) {
            const wait = opening.get(peerId) ?? pendingSettled.get(pendingChats.get(peerId))
            if (!wait || wait === last) return
            last = wait
            await wait.catch(() => {})
        }
    }

    // initiator: selfId for an outbound stream, peerId for an inbound stream.
    function attachChat(stream, peerId, connection, initiator) {
        connection ??= node.getConnections().find(c => c.streams.includes(stream))
        const oldSession = sessions.get(peerId)
        const oldPending = pendingChats.get(peerId)
        if ((oldSession && !newStreamWins(oldSession, initiator, peerId)) ||
            (oldPending && !newStreamWins(oldPending, initiator, peerId))) {
            stream.abort(new Error('Chat session already exists for this peer'))
            return
        }
        // The new stream wins. Remove a pending old stream from the map first, then close it.
        if (oldPending) {
            pendingChats.delete(peerId)
            oldPending.close()
        }
        // A LAN room (no key) opens the session at once. A keyed room waits for a valid proof.
        let open = key === null
        const nonce = randomBytes(16).toString('base64url')
        let peerName = ''
        let proofSent = false
        let timer = null
        let settle = () => {}
        function reject(cause) {
            if (open) return
            clearTimeout(timer)
            if (pendingChats.get(peerId) === session) pendingChats.delete(peerId)
            console.warn(`Room proof from ${peerId} failed: ${cause}`)
            stream.abort(new Error(`Room proof failed: ${cause}`))
            settle()
        }
        function pendingLine(line) {
            const control = controlMessage(line)
            if (!control) return
            if (control.type === 'hello') {
                if (proofSent) return
                if (typeof control.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(control.nonce)) {
                    reject('hello with no nonce')
                    return
                }
                peerName = typeof control.name === 'string' ? control.name.trim().slice(0, 64) : ''
                proofSent = true
                session.send(JSON.stringify({ type: 'proof', mac: proofMac(control.nonce, selfId, peerId).toString('base64url') }))
            } else if (control.type === 'proof') {
                const expected = proofMac(nonce, peerId, selfId)
                const mac = typeof control.mac === 'string' && /^[A-Za-z0-9_-]+$/.test(control.mac) ? Buffer.from(control.mac, 'base64url') : null
                if (!mac || mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
                    reject('wrong proof')
                    return
                }
                if (!proofSent) {
                    reject('proof before hello')
                    return
                }
                clearTimeout(timer)
                if (pendingChats.get(peerId) === session) pendingChats.delete(peerId)
                // An open session to the peer stays until this proof. Replace it if this stream still wins.
                const old = sessions.get(peerId)
                if (old && !newStreamWins(old, initiator, peerId)) {
                    stream.abort(new Error('Chat session already exists for this peer'))
                    settle()
                    return
                }
                open = true
                openSession(session, peerId, connection, false, old)
                settle()
                if (peerName) {
                    names.set(peerId, peerName)
                    events.emit('peer-name', { peerId, name: peerName })
                }
            }
            // Ignore all other lines before the session is open.
        }
        const session = createChatSession(stream, {
            onMessage: line => {
                if (!open) {
                    pendingLine(line)
                    return
                }
                const control = controlMessage(line)
                if (control) {
                    // Ignore an unknown type with no warning.
                    if (control.type === 'host') election.handleAnnouncement(peerId, control)
                    else if (control.type === 'history') handleHistory(peerId, control)
                    else if (control.type === 'hello') {
                        const peerName = typeof control.name === 'string' ? control.name.trim().slice(0, 64) : ''
                        if (peerName && sessions.get(peerId) === session) {
                            names.set(peerId, peerName)
                            events.emit('peer-name', { peerId, name: peerName })
                        }
                    }
                    else if (control.type === 'links') {
                        const list = validLinks(control.peers)
                        if (list && sessions.get(peerId) === session) {
                            const old = links.get(peerId)
                            const kinds = validKinds(control.kinds, list)
                            const oldKinds = linkKinds.get(peerId) ?? {}
                            linkKinds.set(peerId, kinds)
                            if (!old || old.length !== list.length || old.some((p, i) => p !== list[i]) ||
                                JSON.stringify(oldKinds) !== JSON.stringify(kinds)) {
                                links.set(peerId, list)
                                emitTopology()
                            }
                            scheduleRelayDials()
                        }
                    }
                    else if (control.type === 'node') {
                        if (sessions.get(peerId) === session && typeof control.fullNode === 'boolean') setPeerFull(peerId, control.fullNode, control.fullNode ? validAddrList(control.addrs) : null)
                    }
                    else if (control.type === 'signal') {
                        if (control.data !== null && typeof control.data === 'object') events.emit('signal', { peerId, data: control.data })
                    } else if (control.type === 'file-offer' || control.type === 'file-refuse' || control.type === 'file-cancel') {
                        files.handleControl(peerId, control)
                    } else if (control.type === 'voice') {
                        if (control.inVoice === true) peerVoice.set(peerId, true)
                        else peerVoice.delete(peerId)
                        const direct = control.inVoice === true ? validDirect(control.direct) : null
                        if (direct) peerDirect.set(peerId, direct)
                        else peerDirect.delete(peerId)
                        voiceRelay.hostChanged()
                        events.emit('voice-state', {
                            peerId,
                            inVoice: control.inVoice === true,
                            streamId: typeof control.streamId === 'string' ? control.streamId : null,
                            muted: control.muted === true
                        })
                    } else if (control.type === 'presence') {
                        // Ignore an unknown state or a note that is not a string, with no warning.
                        if (sessions.get(peerId) === session && PRESENCE_STATES.has(control.state) && typeof control.note === 'string') {
                            const state = control.state
                            const note = presenceNote(control.note)
                            const old = peerPresence.get(peerId)
                            if (!old || old.state !== state || old.note !== note) {
                                peerPresence.set(peerId, { state, note })
                                events.emit('presence', { peerId, state, note })
                            }
                        }
                    }
                    return
                }
                const message = parseMessage(line, peerId)
                if (message) {
                    if (history.add(message)) events.emit('message', { peerId, ...message })
                    // Saved rooms (milestone 6): each valid live line, also a line that a host replay gave first.
                    // The archive keeps one row for each ID. The window and the terminal demo use 'message'.
                    events.emit('live', { peerId, ...message })
                } else console.warn(`Ignored a message that is not valid from peer ${peerId}`)
            }
        })
        chatInitiator.set(session, initiator)
        if (open) {
            openSession(session, peerId, connection, true, oldSession)
            return
        }
        pendingSettled.set(session, new Promise(resolve => { settle = resolve }))
        pendingChats.set(peerId, session)
        session.send(JSON.stringify({ type: 'hello', name: senderName, nonce }))
        timer = setTimeout(() => reject(`no valid proof in ${PROOF_TIMEOUT_MS} ms`), PROOF_TIMEOUT_MS)
        session.done.catch(() => {}).finally(() => {
            clearTimeout(timer)
            if (pendingChats.get(peerId) === session) pendingChats.delete(peerId)
            settle()
        })
    }

    // replaced: the old open session that this session replaces (cross race), or undefined.
    function openSession(session, peerId, connection, sendHello, replaced) {
        // Set the new session before the old one ends: the end of the old session then does no cleanup.
        sessions.set(peerId, session)
        // Rule 9: the connection of the new chat stream.
        if (connection) sessionConns.set(peerId, connection)
        else if (replaced) sessionConns.delete(peerId)
        if (replaced) {
            replacedSessions.add(replaced)
            replaced.close()
        }
        if (sendHello) session.send(JSON.stringify({ type: 'hello', name: senderName }))
        session.send(nodeLine())
        // Always send the own presence, also when it is 'available'.
        session.send(presenceLine())
        // A replacement session gets no second peer-joined: the peer did not leave.
        if (!replaced) events.emit('peer-joined', { peerId })
        const sessionConn = sessionConns.get(peerId) ?? connection
        const sessionStart = Date.now()
        const connAddr = sessionConn?.remoteAddr?.toString() ?? '?'
        const connType = connAddr.includes('/p2p-circuit') ? 'relay' : 'direct'
        const opened = {
            state: 'session', peer: peerId, type: connType,
            dir: sessionConn?.direction === 'inbound' ? 'in' : sessionConn?.direction === 'outbound' ? 'out' : '?',
            relay: connType === 'relay' ? (circuitRelay(connAddr) ?? '?') : undefined, addr: connAddr
        }
        if (opened.relay === undefined) delete opened.relay
        console.info(connText('conn session', { peer: opened.peer, type: opened.type, dir: opened.dir, relay: opened.relay, addr: opened.addr }))
        events.emit('connection', opened)
        election.sessionOpened(peerId)
        if (election.isHost()) sendHistoryTo(peerId, session)
        if (voiceState.inVoice) session.send(voiceLine())
        broadcastLinks()
        emitTopology()
        checkFullNode(peerId)
        session.done.catch(() => {}).finally(async () => {
            const secs = Math.round((Date.now() - sessionStart) / 100) / 10
            endedSessions.add(session)
            await replacementSettled(peerId, session)
            // A replaced session: the peer did not leave. No 'closed' event and no cleanup.
            if (replacedSessions.has(session)) {
                console.info(connText('conn replaced', { peer: peerId, type: connType, secs }))
                return
            }
            console.info(connText('conn closed', { peer: peerId, type: connType, secs }))
            events.emit('connection', { state: 'closed', peer: peerId, type: connType, secs })
            if (sessions.get(peerId) === session) {
                sessions.delete(peerId)
                sessionConns.delete(peerId)
                linkKinds.delete(peerId)
                reserved.delete(peerId)
                if (peerFull.get(peerId) === true) events.emit('full-node', { peerId, fullNode: false })
                peerFull.delete(peerId)
                names.delete(peerId)
                pendingHistory.delete(peerId)
                events.emit('peer-left', { peerId })
                peerVoice.delete(peerId)
                peerPresence.delete(peerId)
                peerDirect.delete(peerId)
                voiceRelay.peerLeft(peerId)
                election.sessionClosed(peerId)
                files.peerLeft(peerId)
                links.delete(peerId)
                broadcastLinks()
                emitTopology()
                // A closed session must open again, for example through another relay when its relay stopped.
                // Reset the try count so that the cap does not stop the redial.
                relayDialTries.delete(peerId)
                scheduleRelayDials(RELAY_DIAL_RETRY_MS)
            }
        })
    }

    // Both ends read and write the same stream; receiving never opens another one.
    await node.handle(CHAT_PROTOCOL, ({ stream, connection }) => {
        const peerId = connection.remotePeer.toString()
        attachChat(stream, peerId, connection, peerId)
    }, { maxInboundStreams: 1, maxOutboundStreams: 1, runOnTransientConnection: true })

    // Voice only from a peer with an open session. In a keyed room, a wrong key gets no session.
    await node.handle(VOICE_PROTOCOL, data => {
        if (!sessions.has(data.connection.remotePeer.toString())) {
            data.stream.abort?.(new Error('no session'))
            return
        }
        voiceRelay.handle(data)
    }, { runOnTransientConnection: true })

    // Direct voice frames only from a peer with an open session. The receiver never forwards them.
    await node.handle(VOICE_DIRECT_PROTOCOL, data => {
        if (!sessions.has(data.connection.remotePeer.toString())) {
            data.stream.abort?.(new Error('no session'))
            return
        }
        voiceRelay.handleDirect(data)
    }, { runOnTransientConnection: true })

    await node.handle(FILE_PROTOCOL, data => files.handleStream(data), { runOnTransientConnection: true })

    // In a keyed room, answer a dial-back only for a peer with an open session. The proof of the peer can
    // arrive a short time after the request, so wait for the session for a short time.
    await node.handle(DIALBACK_PROTOCOL, async data => {
        const peerId = data.connection.remotePeer.toString()
        for (let i = 0; key !== null && !sessions.has(peerId) && i < 40; i++) await new Promise(r => setTimeout(r, 50))
        if (key !== null && !sessions.has(peerId)) {
            console.warn(`Dial-back request from ${peerId} refused: no session`)
            data.stream.abort(new Error('no session'))
            return
        }
        handleDialback(data)
    }, { runOnTransientConnection: true })

    // Rule 9: close a session only when its chat stream is on the closed connection.
    node.addEventListener('connection:close', ({ detail: connection }) => {
        const peerId = connection.remotePeer.toString()
        const conn = sessionConns.get(peerId)
        if (conn === undefined || conn === connection || conn.id === connection.id) sessions.get(peerId)?.close()
    })

    // Rule 6: the full-node state on the wire.
    function nodeLine() {
        return JSON.stringify(selfFull ? { type: 'node', fullNode: true, addrs: publicAddrs() } : { type: 'node', fullNode: false })
    }

    // The public addresses of this node: the announce addresses, else the dial-back address of a full node.
    let dialbackIp = null
    function publicAddrs() {
        if (announce.length > 0) return [...announce]
        const port = listenPort()
        if (selfFull && dialbackIp && port !== null) return [`/${dialbackIp.includes(':') ? 'ip6' : 'ip4'}/${dialbackIp}/tcp/${port}`]
        // A UPnP address is not proven. It is a candidate, the same as an unproven typed announce address.
        if (upnpState) return [`/ip4/${upnpState.ip}/tcp/${upnpState.port}`]
        return []
    }

    // The addresses of each full node that sent addrs (self not included).
    const knownFullNodes = new Map()
    function validAddrList(addrs) {
        if (!Array.isArray(addrs) || addrs.length < 1 || addrs.length > MAX_ADDRS || !addrs.every(validAddr)) return null
        return [...new Set(addrs)]
    }
    function learnFullNode(peerId, addrs, save = true) {
        if (peerId === selfId || !validPeerId(peerId)) return
        const old = knownFullNodes.get(peerId)
        if (!old || old.length !== addrs.length || old.some((a, i) => a !== addrs[i])) {
            knownFullNodes.set(peerId, addrs)
            // A different peer ID with the same address list: the old entry is stale (the full node started again).
            const same = new Set(addrs)
            for (const [otherId, otherAddrs] of [...knownFullNodes]) {
                if (otherId !== peerId && otherAddrs.length === same.size && otherAddrs.every(a => same.has(a))) knownFullNodes.delete(otherId)
            }
            events.emit('full-node-addrs', { peerId, addrs: [...addrs] })
            if (save) saveStore()
        }
        dialFullNode(peerId)
    }
    function saveStore() {
        if (!storePath) return
        try {
            const tmp = `${storePath}.tmp`
            writeFileSync(tmp, JSON.stringify({ fullNodes: Object.fromEntries(knownFullNodes) }, null, 2))
            renameSync(tmp, storePath)
        } catch (err) {
            console.warn(`Store write to ${storePath} failed:`, err?.message ?? err)
        }
    }
    function loadStore() {
        if (!storePath) return
        let value
        try {
            value = JSON.parse(readFileSync(storePath, 'utf8'))
        } catch (err) {
            console.warn(`Store ${storePath} not read, the store is empty:`, err?.code ?? err?.message ?? err)
            return
        }
        const list = value?.fullNodes
        if (list === null || typeof list !== 'object' || Array.isArray(list)) {
            console.warn(`Store ${storePath} is not valid, the store is empty`)
            return
        }
        for (const [peerId, addrs] of Object.entries(list)) {
            const valid = validAddrList(addrs)
            if (valid && peerId !== selfId && validPeerId(peerId)) knownFullNodes.set(peerId, valid)
        }
    }
    // One line and one event for each failed dial. Repeated failures (same site, target, address and reason) are
    // logged only one time in DIAL_FAIL_QUIET_MS. The first failure of each target and address is always logged.
    const DIAL_FAIL_QUIET_MS = 60000
    const dialFailSeen = new Map()
    function dialFailed({ peer, addr, via, err }) {
        const data = {
            peer: peer ? String(peer) : '?', via, reason: dialReason(err), addr: addr ? String(addr) : '?',
            error: String(err?.message ?? err).slice(0, 200)
        }
        const k = `${data.via} ${data.peer} ${data.addr} ${data.reason}`
        const now = Date.now()
        const last = dialFailSeen.get(k)
        if (last !== undefined && now - last < DIAL_FAIL_QUIET_MS) return
        if (dialFailSeen.size > 1000) dialFailSeen.clear()
        dialFailSeen.set(k, now)
        console.warn(connText('conn dial-failed', data))
        events.emit('dial-failed', data)
    }

    // Dial a known full node directly when this node has no direct connection to it.
    function dialFullNode(peerId) {
        const addrs = knownFullNodes.get(peerId)
        if (stopped || !addrs || dialing.has(peerId)) return
        const direct = node.getConnections().some(c => c.remotePeer.toString() === peerId && !c.remoteAddr.toString().includes('/p2p-circuit'))
        if (direct) return
        // Two full nodes: only the lower peer ID dials (as in dialDiscovered).
        if (!sessions.has(peerId) && selfFull && !(selfId < peerId)) return
        dialing.add(peerId)
        ;(async () => {
            for (const a of addrs) {
                if (stopped) return
                const target = a.includes('/p2p/') ? a : `${a}/p2p/${peerId}`
                try {
                    const conn = await node.dial(multiaddr(target))
                    await openChat(conn, peerId)
                    return
                } catch (err) {
                    dialFailed({ peer: peerId, addr: target, via: 'full-node', err })
                }
            }
            // The peer ID can be old (the full node started again with a new ID). Dial each address with no peer ID.
            for (const a of addrs) {
                if (stopped) return
                const bare = a.split('/p2p/')[0]
                if (!bare) continue
                try {
                    const conn = await node.dial(multiaddr(bare))
                    const remoteId = conn.remotePeer.toString()
                    if (remoteId === selfId) {
                        await conn.close().catch(() => {})
                        continue
                    }
                    await openChat(conn, remoteId)
                    return
                } catch (err) {
                    dialFailed({ peer: '?', addr: bare, via: 'address', err })
                }
            }
        })().finally(() => dialing.delete(peerId))
    }

    function setSelfFull(value) {
        if (selfFull === value) return
        selfFull = value
        console.info(`Full node: ${value}`)
        events.emit('full-node', { peerId: selfId, fullNode: value })
        const line = nodeLine()
        for (const session of sessions.values()) session.send(line)
    }

    function setPeerFull(peerId, value, addrs = null) {
        const old = peerFull.get(peerId) === true
        peerFull.set(peerId, value)
        if (old !== value) events.emit('full-node', { peerId, fullNode: value })
        if (value && addrs) learnFullNode(peerId, addrs)
        if (value) reserveOn(peerId)
        scheduleRelayDials()
    }

    // Rule 1, 'auto': ask a peer with a direct session to dial back to the listen port.
    let checking = false
    function listenPort() {
        for (const ma of node.getMultiaddrs()) {
            const t = tcpTarget(ma)
            if (t) return t.port
        }
        return null
    }
    function checkFullNode(peerId) {
        if (fullNode !== 'auto' || relayOnly || selfFull || checking || stopped) return
        const conn = sessionConns.get(peerId)
        const port = listenPort()
        if (!conn || port === null || conn.remoteAddr.toString().includes('/p2p-circuit')) return
        checking = true
        // With a UPnP mapping, the peer must dial the mapped public port.
        requestDialback(conn, upnpState?.port ?? port)
            .then(({ ok, ip }) => {
                const publicIp = observedIp(node) ?? ip
                const full = ok && publicIp !== null && (allowPrivateFullNode || !isPrivateIp(publicIp))
                if (full) dialbackIp = publicIp
                console.info(`Dial-back from ${peerId}: ${ok ? 'ok' : 'failed'}, IP ${publicIp}, full node ${full}`)
                if (full && !stopped) setSelfFull(true)
            })
            .catch(err => dialFailed({ peer: peerId, addr: conn.remoteAddr.toString(), via: 'dial-back', err }))
            .finally(() => { checking = false })
    }

    // Rule 4: reserve a slot on each full node with a session.
    const reserved = new Set()
    const RESERVE_TRIES = 5
    const RESERVE_RETRY_MS = 1000
    function addrOf(peerId) {
        const conn = sessionConns.get(peerId)
        if (!conn) return null
        const text = conn.remoteAddr.toString()
        if (text.includes('/p2p-circuit')) return null
        return text.includes('/p2p/') ? text : `${text}/p2p/${peerId}`
    }
    function reserveOn(peerId, attempt = 1) {
        if (stopped || selfFull || reserved.has(peerId) || peerFull.get(peerId) !== true || !sessions.has(peerId)) return
        const addr = addrOf(peerId)
        if (!addr) return
        reserved.add(peerId)
        node.components.transportManager.listen([multiaddr(`${addr}/p2p-circuit`)])
            .then(() => console.info(`Relay reservation on ${peerId}: ok`))
            .catch(err => {
                reserved.delete(peerId)
                dialFailed({ peer: peerId, addr: `${addr}/p2p-circuit`, via: 'reserve', err })
                if (attempt < RESERVE_TRIES) setTimeout(() => reserveOn(peerId, attempt + 1), RESERVE_RETRY_MS)
            })
    }

    // Rule 4: dial each listed peer with no session through a full node. The lower peer ID dials.
    const RELAY_DIAL_TRIES = 10
    const RELAY_DIAL_RETRY_MS = 1000
    const relayDialTries = new Map()
    let relayDialTimer = null
    function scheduleRelayDials(delay = 0) {
        if (stopped || relayDialTimer) return
        relayDialTimer = setTimeout(() => { relayDialTimer = null; relayDials() }, delay)
    }
    function relayDials() {
        if (stopped) return
        const relays = [...sessions.keys()].filter(p => peerFull.get(p) === true && addrOf(p))
        if (relays.length === 0) return
        const wanted = new Set()
        for (const [from, list] of links) {
            if (!sessions.has(from)) continue
            for (const p of list) if (p !== selfId && !sessions.has(p) && !pendingChats.has(p) && selfId < p) wanted.add(p)
        }
        // Clear the hold time of each target that is not wanted now (for example, its session is open).
        for (const target of wantedSince.keys()) if (!wanted.has(target)) wantedSince.delete(target)
        for (const k of noReservationTries.keys()) if (!wanted.has(k.split(' ')[0])) noReservationTries.delete(k)
        for (const target of retrySameRelay) if (!wanted.has(target)) retrySameRelay.delete(target)
        const now = Date.now()
        const holdNodes = [...new Set([...relays, ...knownFullNodes.keys()])].filter(p => p !== selfId)
        for (const target of wanted) {
            if (chatBusy(target)) continue
            const tries = relayDialTries.get(target) ?? 0
            if (tries >= RELAY_DIAL_TRIES) continue
            if (!wantedSince.has(target)) wantedSince.set(target, now)
            // Hold the first try until each full node with a direct session and each known full node lists the
            // target, or until the hold time is more than RELAY_SETTLE_MS. A known full node with no session yet
            // has no links list, thus the hold also waits for its session.
            if (tries === 0 && !holdNodes.every(r => links.get(r)?.includes(target))) {
                const left = wantedSince.get(target) + RELAY_SETTLE_MS - now
                if (left > 0) { scheduleSettle(left); continue }
            }
            relayDialTries.set(target, tries + 1)
            const relay = pickRelay(target, relays, tries)
            dialing.add(target)
            relayDialVia.set(target, relay)
            const addr = `${addrOf(relay)}/p2p-circuit/p2p/${target}`
            node.dial(multiaddr(addr))
                .then(conn => openChat(conn, target)
                    .then(() => {
                        relayDialTries.delete(target)
                        lastRelay.delete(target)
                        wantedSince.delete(target)
                        clearNoReservation(target)
                    }))
                .catch(err => {
                    dialFailed({ peer: target, addr, via: 'relay', err })
                    // The target has a session with the relay, but its reservation can come later.
                    // Thus try the same relay again, at most RELAY_NO_RESERVATION_RETRIES times.
                    const k = `${target} ${relay}`
                    const n = noReservationTries.get(k) ?? 0
                    if (dialReason(err) === 'no-reservation' && n < RELAY_NO_RESERVATION_RETRIES) {
                        noReservationTries.set(k, n + 1)
                        retrySameRelay.add(target)
                    }
                    scheduleRelayDials(RELAY_DIAL_RETRY_MS)
                })
                .finally(() => { dialing.delete(target); relayDialVia.delete(target) })
        }
    }
    // The relay of each relay dial in flight.
    const relayDialVia = new Map()
    // The last relay that this node used for each target.
    const lastRelay = new Map()
    // The time when each target became wanted first.
    const wantedSince = new Map()
    const RELAY_SETTLE_MS = 2000
    // The same-relay retries after a 'no-reservation' failure, for each target and relay.
    const RELAY_NO_RESERVATION_RETRIES = 3
    const noReservationTries = new Map()
    // The targets whose next try uses the last relay again.
    const retrySameRelay = new Set()
    function clearNoReservation(target) {
        retrySameRelay.delete(target)
        for (const k of noReservationTries.keys()) if (k.split(' ')[0] === target) noReservationTries.delete(k)
    }
    let settleTimer = null
    // One timer wakes relayDials() at the end of the first hold.
    function scheduleSettle(delay) {
        if (stopped || settleTimer) return
        settleTimer = setTimeout(() => { settleTimer = null; relayDials() }, delay)
    }
    // The number of relayed sessions and relay dials in flight of this node through the relay.
    function relayLoad(relay) {
        let n = 0
        for (const conn of sessionConns.values()) if (circuitRelay(conn.remoteAddr.toString()) === relay) n++
        for (const r of relayDialVia.values()) if (r === relay) n++
        return n
    }
    // Spread the relayed sessions across the full nodes.
    // The candidates are the relays whose last links list contains the target. If there is no candidate, use all relays.
    // Sort the candidates by load, then by a stable hash of the target ID and the relay ID.
    // After a failed dial (tries > 0), the next try uses the next candidate after the last relay.
    function pickRelay(target, relays, tries) {
        let list = relays.filter(r => links.get(r)?.includes(target))
        if (list.length === 0) list = relays
        const hash = r => createHash('sha256').update(`${target} ${r}`).digest('hex')
        const keyed = list.map(r => ({ r, load: relayLoad(r), h: hash(r) }))
        keyed.sort((a, b) => a.load - b.load || (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
        const last = tries > 0 ? keyed.findIndex(k => k.r === lastRelay.get(target)) : -1
        const same = retrySameRelay.delete(target) && last >= 0
        const relay = keyed[same ? last : (last + 1) % keyed.length].r
        lastRelay.set(target, relay)
        return relay
    }

    const discovered = new Set()
    const dialing = new Set()
    // The number of connect() calls in flight for each peer ID. A count, because two calls can overlap.
    const connecting = new Map()
    function markConnecting(peerId, step) {
        const n = (connecting.get(peerId) ?? 0) + step
        if (n > 0) connecting.set(peerId, n)
        else connecting.delete(peerId)
    }
    // True when the peer has a session, a session that waits for the room proof, or a dial in flight.
    function chatBusy(peerId) {
        return sessions.has(peerId) || pendingChats.has(peerId) || dialing.has(peerId) || connecting.has(peerId)
    }
    // The outbound chat stream in negotiation for each peer ID.
    const opening = new Map()
    // Each outbound chat stream opens here. node.dial() can give a connection that exists already, and the session
    // can open on another path while the dial is in flight. A second chat stream on one connection gets the limit
    // error (maxOutboundStreams 1). Thus open at most one outbound chat stream for each peer at a time.
    function openChat(conn, peerId) {
        if (sessions.has(peerId) || pendingChats.has(peerId)) return Promise.resolve()
        const busy = opening.get(peerId)
        if (busy) return busy
        const task = (async () => {
            let stream
            try {
                stream = await conn.newStream(CHAT_PROTOCOL, { runOnTransientConnection: true })
            } catch (err) {
                // The session opened on another path: that is not a failure.
                if (sessions.has(peerId) || pendingChats.has(peerId)) return
                throw err
            }
            attachChat(stream, peerId, conn, selfId)
        })().finally(() => {
            if (opening.get(peerId) === task) opening.delete(peerId)
        })
        opening.set(peerId, task)
        return task
    }
    node.addEventListener('peer:discovery', ({ detail }) => {
        const remoteId = detail.id.toString()
        const self = node.peerId.toString()
        if (remoteId === self) return
        if (!discovered.has(remoteId)) {
            discovered.add(remoteId)
            events.emit('peer-discovered', {
                peerId: remoteId,
                addresses: (detail.multiaddrs ?? []).map(a => a.toString())
            })
        }
        // Only the node with the lower peer ID opens the chat stream.
        if (!(self < remoteId)) return
        dialDiscovered(detail.id, 0)
    })

    // libp2p also emits peer:discovery after identify on a connection that connect() or a remote dial opened.
    // At that time the chat stream on that connection can still be in protocol negotiation. libp2p sets
    // stream.protocol only after the negotiation, so a check of the protocol alone does not see that stream.
    // Thus wait while a stream with no protocol is on a connection to the peer, then check again.
    const waitingDial = new Map()
    const NEGOTIATION_CHECKS = 20
    const NEGOTIATION_CHECK_MS = 100
    let stopped = false
    function dialDiscovered(id, attempt) {
        const remoteId = id.toString()
        if (stopped || chatBusy(remoteId)) return
        if (attempt === 0 && waitingDial.has(remoteId)) return
        const conns = node.getConnections(id)
        const streams = conns.flatMap(c => c.streams)
        // Do not dial when a chat stream to that peer is already open.
        if (streams.some(st => st.protocol === CHAT_PROTOCOL)) return
        // A connection that exists already can get its chat stream from the other path (connect(), a relay dial, a
        // full-node dial or the remote peer). That path can open the stream after identify. Thus also wait while a
        // connection exists, so that the two paths do not both open a chat stream.
        if ((conns.length > 0 || streams.some(st => !st.protocol)) && attempt < NEGOTIATION_CHECKS) {
            waitingDial.set(remoteId, setTimeout(() => {
                waitingDial.delete(remoteId)
                dialDiscovered(id, attempt + 1)
            }, NEGOTIATION_CHECK_MS))
            return
        }
        dialing.add(remoteId)
        node.dial(id)
            .then(conn => openChat(conn, remoteId))
            .catch(err => dialFailed({ peer: remoteId, addr: node.getConnections(id)[0]?.remoteAddr?.toString() ?? '?', via: 'discovery', err }))
            .finally(() => dialing.delete(remoteId))
    }

    // UPnP by hand, TCP only: externalIp(), then map(publicPort = localPort). One guarded task after start.
    let upnpState = null // { ip, port, local, opts } after a successful map
    let upnpTask = null
    let upnpPhase = 'idle' // 'idle', 'discovery', 'map', 'done'
    function upnpLog(fields) {
        const { state, ...rest } = fields
        console.info(connText(`upnp ${state}`, rest))
        events.emit('upnp', fields)
    }
    function localIpv4() {
        // The same rule as the library default (the first non-internal IPv4), here so that the log can show it.
        // The gateway URL is not in the public API of @libp2p/upnp-nat, so a subnet match is not possible.
        for (const infos of Object.values(networkInterfaces())) {
            for (const info of infos ?? []) if (!info.internal && (info.family === 'IPv4' || info.family === 4)) return info.address
        }
        return undefined
    }
    function withTimeout(promise, ms) {
        let timer
        const limit = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms)
            timer.unref?.()
        })
        return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
    }
    // A router error can give a promise that never settles: max. 1.5 s (the app quit limit is 3 s for all of stop).
    async function upnpUnmap(state) {
        try {
            await withTimeout(node.services.upnp.client.unmap(state.opts), 1500)
            upnpLog({ state: 'unmapped', port: state.port })
        } catch (err) {
            console.warn(connText('upnp unmap-failed', { port: state.port, error: err?.message ?? String(err) }))
        }
    }
    function runUpnp() {
        const client = node.services.upnp.client
        let timedOut = false
        // A router error that the guard swallows (installed by the entry point) rejects the step in flight at once.
        // Without this signal the step promise never settles (the library throws outside of its promise).
        let rejectStep
        const routerError = new Promise((_resolve, reject) => { rejectStep = reject })
        routerError.catch(() => {})
        let unsubscribe = null
        const guarded = async step => {
            unsubscribe = onUpnpRouterError(err => rejectStep(Object.assign(new Error(err?.message ?? String(err)), { upnpReason: 'router-error' })))
            try {
                return await Promise.race([step(), routerError])
            } finally {
                unsubscribe()
                unsubscribe = null
            }
        }
        const work = (async () => {
            const port = listenPort()
            if (port === null) throw Object.assign(new Error('no TCP listen port'), { upnpReason: 'router-error' })
            upnpPhase = 'discovery'
            let ip
            try {
                ip = await guarded(() => client.externalIp())
            } catch (err) {
                if (err?.upnpReason) throw err
                const noGateway = /discover gateway/i.test(err?.message ?? '') || err?.name === 'TimeoutError'
                throw Object.assign(err, { upnpReason: noGateway ? 'no-gateway' : 'router-error' })
            }
            // After stop or timeout, do not call map().
            if (stopped || timedOut) return
            if (isPrivateIp(ip)) {
                upnpLog({ state: 'none', reason: 'private-ip', error: `external IP ${ip} is private` })
                return
            }
            const local = localIpv4()
            const opts = { publicPort: port, localPort: port, protocol: 'TCP', localAddress: local }
            upnpPhase = 'map'
            await guarded(() => client.map(opts))
            const state = { ip, port, local: local ?? 'auto', opts }
            // A map that completes after stop or after the timeout must not stay on the router.
            if (stopped || timedOut) {
                await upnpUnmap(state)
                return
            }
            upnpState = state
            upnpLog({ state: 'mapped', ip, port, local: state.local })
            // Sessions that exist already: ask again for a dial-back on the mapped port.
            for (const peerId of [...sessions.keys()]) checkFullNode(peerId)
        })()
        // A late rejection of the work after the timeout must not be unhandled.
        work.catch(() => {})
        let timer
        const limit = new Promise(resolve => {
            timer = setTimeout(() => { timedOut = true; resolve('timeout') }, upnpTimeout)
            timer.unref?.()
        })
        upnpTask = Promise.race([work.then(() => 'done'), limit])
            .then(result => {
                if (result === 'timeout' && !stopped) upnpLog({ state: 'none', reason: 'timeout', error: `no result after ${upnpTimeout} ms` })
            }, err => {
                if (!stopped) upnpLog({ state: 'none', reason: err?.upnpReason ?? 'router-error', error: err?.message ?? String(err) })
            })
            .finally(() => { clearTimeout(timer); upnpPhase = 'done' })
    }

    await node.start()
    // Not awaited: the UPnP task must not slow down or stop the start. The TCP listener is bound now.
    // setImmediate: the caller attaches its event listeners before the first 'upnp' event can come.
    if (useUpnp) setImmediate(() => { if (!stopped) runUpnp() })
    election.start()
    loadStore()
    if (Array.isArray(inviteNodes)) {
        for (const entry of inviteNodes) {
            const valid = validAddrList(entry?.addrs)
            if (valid && entry.id !== selfId && validPeerId(entry.id)) knownFullNodes.set(entry.id, valid)
        }
    }
    for (const peerId of knownFullNodes.keys()) dialFullNode(peerId)
    // Redial: a member with no session to a full node dials the known full nodes again.
    const redialTimer = setInterval(() => {
        if (stopped || selfFull) return
        if ([...sessions.keys()].some(id => peerFull.get(id) === true)) return
        for (const peerId of [...knownFullNodes.keys()]) dialFullNode(peerId)
    }, redialInterval)
    redialTimer.unref?.()

    // Send one line. Returns the canonical record: { id, from, text, time, accepted }.
    // accepted is the number of sessions that accepted the line. The wire line has no accepted field.
    // A line that no session accepted stays local: it does not go in the history, thus no host replay sends it
    // (milestone 6, plan section 6 part 2).
    function sendRecord(text) {
        const message = { id: randomUUID(), from: senderName, text, time: Date.now() }
        const line = JSON.stringify(message)
        let count = 0
        for (const session of sessions.values()) if (session.send(line)) count++
        if (count > 0) history.add(message)
        return { ...message, accepted: count }
    }

    return {
        peerId: node.peerId.toString(),
        events,
        libp2p: node,
        getMultiaddrs: () => node.getMultiaddrs().map(a => a.toString()),
        // Resolves when the chat stream is open, or when a session (or a pending session) to the peer exists or
        // opens on another path.
        async connect(address) {
            const m = /\/p2p\/([^/]+)$/.exec(String(address))
            const target = m ? m[1] : null
            // Block discovery dials to this peer before the dial starts, until the chat stream is open.
            const marked = []
            const mark = peerId => { markConnecting(peerId, 1); marked.push(peerId) }
            if (target) mark(target)
            try {
                let connection
                try {
                    connection = await node.dial(multiaddr(address))
                } catch (err) {
                    dialFailed({ peer: target ?? '?', addr: address, via: 'connect', err })
                    if (target && (sessions.has(target) || pendingChats.has(target))) return
                    throw err
                }
                const remoteId = connection.remotePeer.toString()
                if (remoteId !== target) mark(remoteId)
                await openChat(connection, remoteId)
            } finally {
                for (const peerId of marked) markConnecting(peerId, -1)
            }
        },
        name: senderName,
        sendRecord,
        // Returns the number of sessions that accepted the line.
        send: text => sendRecord(text).accepted,
        peers: () => [...sessions.keys()],
        peerNames: () => Object.fromEntries([...names].filter(([peerId]) => sessions.has(peerId))),
        topology,
        fullNode: () => selfFull,
        // True while the UPnP task can still give a mapped address (from the start until the result or the timeout).
        upnpPending: () => useUpnp && upnpPhase !== 'done' && !stopped,
        roomKey: () => key ? key.toString('base64url') : null,
        publicAddrs,
        knownFullNodes: () => Object.fromEntries([...knownFullNodes].map(([p, a]) => [p, [...a]])),
        // The invite code: the self node (with public addresses) and the known full nodes.
        // null in a LAN room, or with no full node with addresses.
        invite() {
            if (!key) return null
            const nodes = []
            const own = publicAddrs()
            if (own.length > 0) nodes.push({ id: selfId, addrs: own })
            for (const [id, addrs] of knownFullNodes) if (nodes.length < MAX_ADDRS) nodes.push({ id, addrs })
            if (nodes.length === 0) return null
            return makeInvite({ room, key: key.toString('base64url'), nodes })
        },
        fullNodes: () => [...peerFull].filter(([p, v]) => v && sessions.has(p)).map(([p]) => p),
        // Send one control line to one peer. Returns true if the session is open.
        sendTo(peerId, message) {
            const session = sessions.get(peerId)
            if (!session) return false
            return session.send(JSON.stringify(message))
        },
        setVoice({ inVoice, streamId = null, muted = false } = {}) {
            voiceState = { inVoice: inVoice === true, streamId: typeof streamId === 'string' ? streamId : null, muted: muted === true }
            const line = voiceLine()
            for (const session of sessions.values()) session.send(line)
            voiceRelay.hostChanged()
        },
        // Set the own presence and send it to all open sessions. Returns the stored value.
        setPresence({ state, note = '' } = {}) {
            if (!PRESENCE_STATES.has(state)) throw new TypeError('state must be available, away or dnd')
            if (typeof note !== 'string') throw new TypeError('note must be a string')
            ownPresence = { state, note: presenceNote(note) }
            const line = presenceLine()
            for (const session of sessions.values()) session.send(line)
            return { ...ownPresence }
        },
        presence: () => ({ ...ownPresence }),
        // The presence of each peer with an open session and a known state.
        peerPresence: () => Object.fromEntries([...peerPresence]
            .filter(([peerId]) => sessions.has(peerId))
            .map(([peerId, value]) => [peerId, { ...value }])),
        // Send one Opus frame of this node on the voice path (direct streams, and the star through the host).
        sendVoiceFrame: bytes => voiceRelay.sendFrame(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
        voiceStats: () => voiceRelay.stats(),
        host: () => election.host(),
        isHost: () => election.isHost(),
        history: () => history.list(),
        pauseHeartbeats: paused => election.pauseHeartbeats(paused),
        offerFile: filePath => files.offerFile(filePath),
        acceptFile: offerId => files.acceptFile(offerId),
        refuseFile: offerId => files.refuseFile(offerId),
        cancelFile: (offerId, peerId) => files.cancelFile(offerId, peerId),
        async stop() {
            stopped = true
            clearInterval(redialTimer)
            for (const timer of waitingDial.values()) clearTimeout(timer)
            waitingDial.clear()
            if (relayDialTimer) clearTimeout(relayDialTimer)
            if (settleTimer) clearTimeout(settleTimer)
            await files.stop()
            election.stop()
            voiceRelay.stop()
            const pending = [...sessions.values()].map(s => { s.close(); return s.done })
            await Promise.allSettled(pending)
            // UPnP: remove the mapping before node.stop() closes the client (the library close() does not unmap).
            // A map request in flight can still complete: wait for the task (max. 1.5 s). The task then unmaps it.
            if (upnpTask && upnpPhase === 'map') await withTimeout(upnpTask, 1500).catch(() => {})
            if (upnpState) {
                const state = upnpState
                upnpState = null
                await upnpUnmap(state)
            }
            await node.stop()
        }
    }
}
