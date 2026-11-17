import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { mdns } from '@libp2p/mdns'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { multiaddr } from '@multiformats/multiaddr'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createChatSession } from './chat-session.mjs'

export const CHAT_PROTOCOL = '/asscrack/chat/receive'

export function roomServiceTag(room) {
    const h = createHash('sha256').update(room).digest('hex').slice(0, 8)
    return `_asscrack-${h}._udp.local`
}

// One chat line is one JSON object: { from: string, text: string, time: number }.
function parseMessage(line) {
    let value
    try {
        value = JSON.parse(line)
    } catch {
        return null
    }
    if (value === null || typeof value !== 'object') return null
    const { from, text, time } = value
    if (typeof from !== 'string' || typeof text !== 'string' || typeof time !== 'number') return null
    return { from, text, time }
}

export async function createAsscrackNode({ room, listen = ['/ip4/0.0.0.0/tcp/0'], discovery = true, discoveryInterval, name } = {}) {
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

    function attachChat(stream, peerId) {
        if (sessions.has(peerId)) {
            stream.abort(new Error('Chat session already exists for this peer'))
            return
        }
        const session = createChatSession(stream, {
            onMessage: line => {
                const message = parseMessage(line)
                if (message) events.emit('message', { peerId, ...message })
                else console.warn(`Ignored a message that is not valid from peer ${peerId}`)
            }
        })
        sessions.set(peerId, session)
        events.emit('peer-joined', { peerId })
        session.done.catch(() => {}).finally(() => {
            if (sessions.get(peerId) === session) {
                sessions.delete(peerId)
                events.emit('peer-left', { peerId })
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
            const line = JSON.stringify({ from: senderName, text, time: Date.now() })
            let count = 0
            for (const session of sessions.values()) if (session.send(line)) count++
            return count
        },
        peers: () => [...sessions.keys()],
        async stop() {
            const pending = [...sessions.values()].map(s => { s.close(); return s.done })
            await Promise.allSettled(pending)
            await node.stop()
        }
    }
}
