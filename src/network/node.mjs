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

export async function createAsscrackNode({ room, listen = ['/ip4/0.0.0.0/tcp/0'], discovery = true } = {}) {
    if (typeof room !== 'string') throw new TypeError('room must be a string')
    const node = await createLibp2p({
        start: false,
        addresses: { listen },
        transports: [tcp()],
        peerDiscovery: discovery ? [mdns({ serviceTag: roomServiceTag(room) })] : [],
        // Discovery only; chat connections are explicitly initiated.
        connectionManager: { minConnections: 0 },
        streamMuxers: [yamux()],
        connectionEncryption: [noise()]
    })
    const events = new EventEmitter()
    const sessions = new Map()

    function attachChat(stream, peerId) {
        if (sessions.has(peerId)) {
            stream.abort(new Error('Chat session already exists for this peer'))
            return
        }
        const session = createChatSession(stream, {
            onMessage: text => events.emit('message', { peerId, text })
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

    await node.start()

    return {
        peerId: node.peerId.toString(),
        events,
        libp2p: node,
        getMultiaddrs: () => node.getMultiaddrs().map(a => a.toString()),
        async connect(address) {
            const connection = await node.dial(multiaddr(address))
            const stream = await connection.newStream(CHAT_PROTOCOL)
            attachChat(stream, connection.remotePeer.toString())
        },
        send(text) {
            let count = 0
            for (const session of sessions.values()) if (session.send(text)) count++
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
