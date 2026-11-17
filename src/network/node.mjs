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
import { createChatSession } from './chat-session.mjs'
import { createElection } from './election.mjs'
import { createHistory } from './history.mjs'
import { createFileTransfer, FILE_PROTOCOL } from './file-transfer.mjs'
import { createVoiceRelay, VOICE_PROTOCOL } from './voice-relay.mjs'
import { makeInvite, validAddr, validPeerId } from './invite.mjs'
import { DIALBACK_PROTOCOL, handleDialback, requestDialback, isPrivateIp, observedIp, tcpTarget } from './fullnode.mjs'

export { FILE_PROTOCOL, safeFileName } from './file-transfer.mjs'
export { VOICE_PROTOCOL } from './voice-relay.mjs'

export const CHAT_PROTOCOL = '/asscrack/chat/receive'
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
    fullNode = 'auto', allowPrivateFullNode = false, relayOnly = false, roomKey = null, announce = [], storePath = null } = {}) {
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
    if (name !== undefined && typeof name !== 'string') throw new TypeError('name must be a string')
    const senderName = name ?? node.peerId.toString().slice(-8)
    const events = new EventEmitter()
    const sessions = new Map()
    // The name that each open session sent in its hello line.
    const names = new Map()
    const history = createHistory(200)
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
    const voiceLine = () => JSON.stringify({ type: 'voice', inVoice: voiceState.inVoice, streamId: voiceState.streamId, muted: voiceState.muted })

    const election = createElection({
        selfId: node.peerId.toString(),
        sendTo: (peerId, line) => { sessions.get(peerId)?.send(line) },
        broadcast: line => { for (const session of sessions.values()) session.send(line) },
        openPeers: () => [...sessions.keys()],
        isFullNode: peerId => peerId === selfId ? selfFull : peerFull.get(peerId) === true,
        onChange: info => {
            events.emit('host-changed', info)
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
        onFrame: frame => events.emit('voice-frame', frame)
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

    function attachChat(stream, peerId, connection) {
        connection ??= node.getConnections().find(c => c.streams.includes(stream))
        if (sessions.has(peerId) || pendingChats.has(peerId)) {
            stream.abort(new Error('Chat session already exists for this peer'))
            return
        }
        // A LAN room (no key) opens the session at once. A keyed room waits for a valid proof.
        let open = key === null
        const nonce = randomBytes(16).toString('base64url')
        let peerName = ''
        let proofSent = false
        let timer = null
        function reject(cause) {
            if (open) return
            clearTimeout(timer)
            if (pendingChats.get(peerId) === session) pendingChats.delete(peerId)
            console.warn(`Room proof from ${peerId} failed: ${cause}`)
            stream.abort(new Error(`Room proof failed: ${cause}`))
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
                pendingChats.delete(peerId)
                if (sessions.has(peerId)) {
                    stream.abort(new Error('Chat session already exists for this peer'))
                    return
                }
                open = true
                openSession(session, peerId, connection, false)
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
                        voiceRelay.hostChanged()
                        events.emit('voice-state', {
                            peerId,
                            inVoice: control.inVoice === true,
                            streamId: typeof control.streamId === 'string' ? control.streamId : null,
                            muted: control.muted === true
                        })
                    }
                    return
                }
                const message = parseMessage(line, peerId)
                if (message) {
                    if (history.add(message)) events.emit('message', { peerId, ...message })
                } else console.warn(`Ignored a message that is not valid from peer ${peerId}`)
            }
        })
        if (open) {
            openSession(session, peerId, connection, true)
            return
        }
        pendingChats.set(peerId, session)
        session.send(JSON.stringify({ type: 'hello', name: senderName, nonce }))
        timer = setTimeout(() => reject(`no valid proof in ${PROOF_TIMEOUT_MS} ms`), PROOF_TIMEOUT_MS)
        session.done.catch(() => {}).finally(() => {
            clearTimeout(timer)
            if (pendingChats.get(peerId) === session) pendingChats.delete(peerId)
        })
    }

    function openSession(session, peerId, connection, sendHello) {
        sessions.set(peerId, session)
        if (connection) sessionConns.set(peerId, connection)
        if (sendHello) session.send(JSON.stringify({ type: 'hello', name: senderName }))
        session.send(nodeLine())
        events.emit('peer-joined', { peerId })
        election.sessionOpened(peerId)
        if (election.isHost()) {
            const messages = history.list()
            session.send(JSON.stringify({ type: 'history', messages }))
            console.info(`History sent to ${peerId}: ${messages.length} messages`)
        }
        if (voiceState.inVoice) session.send(voiceLine())
        broadcastLinks()
        emitTopology()
        checkFullNode(peerId)
        session.done.catch(() => {}).finally(() => {
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
                voiceRelay.peerLeft(peerId)
                election.sessionClosed(peerId)
                files.peerLeft(peerId)
                links.delete(peerId)
                broadcastLinks()
                emitTopology()
            }
        })
    }

    // Both ends read and write the same stream; receiving never opens another one.
    await node.handle(CHAT_PROTOCOL, ({ stream, connection }) => {
        attachChat(stream, connection.remotePeer.toString(), connection)
    }, { maxInboundStreams: 1, maxOutboundStreams: 1, runOnTransientConnection: true })

    // Voice only from a peer with an open session. In a keyed room, a wrong key gets no session.
    await node.handle(VOICE_PROTOCOL, data => {
        if (!sessions.has(data.connection.remotePeer.toString())) {
            data.stream.abort?.(new Error('no session'))
            return
        }
        voiceRelay.handle(data)
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
                    if (!sessions.has(peerId) && !pendingChats.has(peerId)) {
                        const stream = await conn.newStream(CHAT_PROTOCOL, { runOnTransientConnection: true })
                        attachChat(stream, peerId, conn)
                    }
                    return
                } catch (err) {
                    console.warn(`Direct dial to full node ${peerId} at ${a} failed:`, err?.message ?? err)
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
        requestDialback(conn, port)
            .then(({ ok, ip }) => {
                const publicIp = observedIp(node) ?? ip
                const full = ok && publicIp !== null && (allowPrivateFullNode || !isPrivateIp(publicIp))
                if (full) dialbackIp = publicIp
                console.info(`Dial-back from ${peerId}: ${ok ? 'ok' : 'failed'}, IP ${publicIp}, full node ${full}`)
                if (full && !stopped) setSelfFull(true)
            })
            .catch(err => console.warn(`Dial-back request to ${peerId} failed:`, err?.message ?? err))
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
                console.warn(`Relay reservation on ${peerId} failed (try ${attempt}):`, err?.message ?? err)
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
            for (const p of list) if (p !== selfId && !sessions.has(p) && selfId < p) wanted.add(p)
        }
        for (const target of wanted) {
            if (dialing.has(target)) continue
            const tries = relayDialTries.get(target) ?? 0
            if (tries >= RELAY_DIAL_TRIES) continue
            relayDialTries.set(target, tries + 1)
            const relay = relays[tries % relays.length]
            dialing.add(target)
            const addr = `${addrOf(relay)}/p2p-circuit/p2p/${target}`
            node.dial(multiaddr(addr))
                .then(conn => conn.newStream(CHAT_PROTOCOL, { runOnTransientConnection: true })
                    .then(stream => { attachChat(stream, target, conn); relayDialTries.delete(target) }))
                .catch(err => {
                    console.warn(`Relay dial to ${target} through ${relay} failed:`, err?.message ?? err)
                    scheduleRelayDials(RELAY_DIAL_RETRY_MS)
                })
                .finally(() => dialing.delete(target))
        }
    }

    const discovered = new Set()
    const dialing = new Set()
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
        if (stopped || sessions.has(remoteId) || dialing.has(remoteId)) return
        if (attempt === 0 && waitingDial.has(remoteId)) return
        const streams = node.getConnections(id).flatMap(c => c.streams)
        // Do not dial when a chat stream to that peer is already open.
        if (streams.some(st => st.protocol === CHAT_PROTOCOL)) return
        if (streams.some(st => !st.protocol) && attempt < NEGOTIATION_CHECKS) {
            waitingDial.set(remoteId, setTimeout(() => {
                waitingDial.delete(remoteId)
                dialDiscovered(id, attempt + 1)
            }, NEGOTIATION_CHECK_MS))
            return
        }
        dialing.add(remoteId)
        node.dial(id)
            .then(conn => conn.newStream(CHAT_PROTOCOL, { runOnTransientConnection: true })
                .then(stream => attachChat(stream, remoteId, conn)))
            .catch(err => console.warn(`Dial to discovered peer ${remoteId} failed:`, err?.message ?? err))
            .finally(() => dialing.delete(remoteId))
    }

    await node.start()
    election.start()
    loadStore()
    for (const peerId of knownFullNodes.keys()) dialFullNode(peerId)

    return {
        peerId: node.peerId.toString(),
        events,
        libp2p: node,
        getMultiaddrs: () => node.getMultiaddrs().map(a => a.toString()),
        async connect(address) {
            const connection = await node.dial(multiaddr(address))
            const remoteId = connection.remotePeer.toString()
            // Block discovery dials to this peer while this stream opens.
            dialing.add(remoteId)
            try {
                const stream = await connection.newStream(CHAT_PROTOCOL, { runOnTransientConnection: true })
                attachChat(stream, remoteId, connection)
            } finally {
                dialing.delete(remoteId)
            }
        },
        name: senderName,
        send(text) {
            const message = { id: randomUUID(), from: senderName, text, time: Date.now() }
            history.add(message)
            const line = JSON.stringify(message)
            let count = 0
            for (const session of sessions.values()) if (session.send(line)) count++
            return count
        },
        peers: () => [...sessions.keys()],
        peerNames: () => Object.fromEntries([...names].filter(([peerId]) => sessions.has(peerId))),
        topology,
        fullNode: () => selfFull,
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
        // Send one Opus frame of this node on the voice path (star through the host).
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
            for (const timer of waitingDial.values()) clearTimeout(timer)
            waitingDial.clear()
            if (relayDialTimer) clearTimeout(relayDialTimer)
            await files.stop()
            election.stop()
            voiceRelay.stop()
            const pending = [...sessions.values()].map(s => { s.close(); return s.done })
            await Promise.allSettled(pending)
            await node.stop()
        }
    }
}
