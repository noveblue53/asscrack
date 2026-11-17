import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { mdns } from '@libp2p/mdns'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { multiaddr } from '@multiformats/multiaddr'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createChatSession } from './chat-session.mjs'
import { createElection } from './election.mjs'
import { createHistory } from './history.mjs'

export const CHAT_PROTOCOL = '/asscrack/chat/receive'

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

export async function createAsscrackNode({ room, listen = ['/ip4/0.0.0.0/tcp/0'], discovery = true, discoveryInterval, name,
    heartbeatInterval = 1000, hostTimeout = 5000, electionDelay = 3000 } = {}) {
    if (typeof room !== 'string') throw new TypeError('room must be a string')
    const node = await createLibp2p({
        start: false,
        addresses: { listen },
        transports: [tcp()],
        peerDiscovery: discovery ? [mdns({ serviceTag: roomServiceTag(room), ...(discoveryInterval !== undefined ? { interval: discoveryInterval } : {}) })] : [],
        // The peer:discovery handler opens chat connections; no automatic dials.
        connectionManager: { minConnections: 0 },
        streamMuxers: [yamux()],
        connectionEncryption: [noise()]
    })
    if (name !== undefined && typeof name !== 'string') throw new TypeError('name must be a string')
    const senderName = name ?? node.peerId.toString().slice(-8)
    const events = new EventEmitter()
    const sessions = new Map()
    const history = createHistory(200)
    const HISTORY_KEEP_MS = 10000
    // The last history line from each peer that was not the host when it arrived.
    const pendingHistory = new Map()

    function applyHistory(messages) {
        if (!Array.isArray(messages)) return
        const added = []
        for (const m of messages) {
            if (!validHistoryItem(m)) continue
            if (history.add(m)) added.push({ id: m.id, from: m.from, text: m.text, time: m.time })
        }
        events.emit('history', { messages: added })
    }

    function handleHistory(peerId, control) {
        if (election.host()?.peerId === peerId) {
            applyHistory(control.messages)
            return
        }
        pendingHistory.set(peerId, { messages: control.messages, at: Date.now() })
    }
    let voiceState = { inVoice: false, streamId: null, muted: false }
    const voiceLine = () => JSON.stringify({ type: 'voice', inVoice: voiceState.inVoice, streamId: voiceState.streamId, muted: voiceState.muted })

    const election = createElection({
        selfId: node.peerId.toString(),
        sendTo: (peerId, line) => { sessions.get(peerId)?.send(line) },
        broadcast: line => { for (const session of sessions.values()) session.send(line) },
        openPeers: () => [...sessions.keys()],
        onChange: info => {
            events.emit('host-changed', info)
            // Use a history line that arrived before this host was accepted.
            const kept = pendingHistory.get(info.peerId)
            if (kept) {
                pendingHistory.delete(info.peerId)
                if (Date.now() - kept.at <= HISTORY_KEEP_MS) applyHistory(kept.messages)
            }
        },
        heartbeatInterval,
        hostTimeout,
        electionDelay
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

    function attachChat(stream, peerId) {
        if (sessions.has(peerId)) {
            stream.abort(new Error('Chat session already exists for this peer'))
            return
        }
        const session = createChatSession(stream, {
            onMessage: line => {
                const control = controlMessage(line)
                if (control) {
                    // Ignore an unknown type with no warning.
                    if (control.type === 'host') election.handleAnnouncement(peerId, control)
                    else if (control.type === 'history') handleHistory(peerId, control)
                    else if (control.type === 'signal') {
                        if (control.data !== null && typeof control.data === 'object') events.emit('signal', { peerId, data: control.data })
                    } else if (control.type === 'voice') {
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
        sessions.set(peerId, session)
        events.emit('peer-joined', { peerId })
        election.sessionOpened(peerId)
        if (election.isHost()) session.send(JSON.stringify({ type: 'history', messages: history.list() }))
        if (voiceState.inVoice) session.send(voiceLine())
        session.done.catch(() => {}).finally(() => {
            if (sessions.get(peerId) === session) {
                sessions.delete(peerId)
                pendingHistory.delete(peerId)
                events.emit('peer-left', { peerId })
                election.sessionClosed(peerId)
            }
        })
    }

    // Both ends read and write the same stream; receiving never opens another one.
    await node.handle(CHAT_PROTOCOL, ({ stream, connection }) => {
        attachChat(stream, connection.remotePeer.toString())
    }, { maxInboundStreams: 1, maxOutboundStreams: 1 })

    node.addEventListener('connection:close', ({ detail: connection }) => {
        sessions.get(connection.remotePeer.toString())?.close()
    })

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
        if (sessions.has(remoteId) || dialing.has(remoteId)) return
        // libp2p also emits peer:discovery for peers that connect() or an inbound dial added.
        // Do not dial when a chat stream to that peer is already open or in negotiation.
        const chatOpen = node.getConnections(detail.id)
            .some(c => c.streams.some(st => st.protocol === CHAT_PROTOCOL))
        if (chatOpen) return
        dialing.add(remoteId)
        node.dialProtocol(detail.id, CHAT_PROTOCOL)
            .then(stream => attachChat(stream, remoteId))
            .catch(err => console.warn(`Dial to discovered peer ${remoteId} failed:`, err?.message ?? err))
            .finally(() => dialing.delete(remoteId))
    })

    await node.start()
    election.start()

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
                const stream = await connection.newStream(CHAT_PROTOCOL)
                attachChat(stream, remoteId)
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
        },
        host: () => election.host(),
        isHost: () => election.isHost(),
        history: () => history.list(),
        pauseHeartbeats: paused => election.pauseHeartbeats(paused),
        async stop() {
            election.stop()
            const pending = [...sessions.values()].map(s => { s.close(); return s.done })
            await Promise.allSettled(pending)
            await node.stop()
        }
    }
}
