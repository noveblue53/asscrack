import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { mdns } from '@libp2p/mdns'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { multiaddr } from '@multiformats/multiaddr'
import * as readline from 'readline'
import { createChatSession } from './chat-session.mjs'

const node = await createLibp2p({
    start: false,
    addresses: {
        listen: ['/ip4/0.0.0.0/tcp/0']
    },
    transports: [tcp()],
    peerDiscovery: [mdns({ serviceTag: '_asscrack._udp.local' })],
    // Discovery only for now; keep chat connections explicitly initiated.
    connectionManager: { minConnections: 0 },
    streamMuxers: [yamux()],
    connectionEncryption: [noise()]
})

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

const discoveredPeers = new Set()
node.addEventListener('peer:discovery', ({ detail: peer }) => {
    const peerId = peer.id.toString()
    if (peerId === node.peerId.toString() || discoveredPeers.has(peerId)) return
    discoveredPeers.add(peerId)
    console.log('Discovered peer:', peerId)
    peer.multiaddrs.forEach(addr => console.log('Peer address:', addr.toString()))
})

const sessions = new Map()

function attachChat(stream, peerId) {
    if (sessions.has(peerId)) {
        stream.abort(new Error('Chat session already exists for this peer'))
        return
    }
    const session = createChatSession(stream, {
        onMessage: message => console.log('\n> ' + message)
    })
    sessions.set(peerId, session)
    console.log('Chat ready with peer:', peerId)
    session.done.catch(error => {
        console.error('Chat stream error:', error.message)
    }).finally(() => {
        if (sessions.get(peerId) === session) sessions.delete(peerId)
        console.log('Chat closed with peer:', peerId)
    })
}

// One terminal reader, shared by all active peer sessions.
rl.on('line', line => {
    if (sessions.size === 0) {
        console.log('No active chat peers. Connect to a peer to send messages.')
        return
    }
    for (const session of sessions.values()) session.send(line)
})

// Both ends read and write the same stream; receiving never opens another one.
await node.handle('/asscrack/chat/receive', ({ stream, connection }) => {
    attachChat(stream, connection.remotePeer.toString())
}, { maxInboundStreams: 1, maxOutboundStreams: 1 })

await node.start()
console.log('Transceiver started with peer id:', node.peerId.toString())
console.log('Listening on:')
node.getMultiaddrs().forEach(addr => console.log(addr.toString()))

node.addEventListener('connection:open', (event) => {
    const connection = event.detail
    console.log('New connection established with peer:', connection.remotePeer.toString())
    console.log('Their address:', connection.remoteAddr.toString())
})

node.addEventListener('connection:close', ({ detail: connection }) => {
    sessions.get(connection.remotePeer.toString())?.close()
})

if (process.argv[2]) {
    const ma = multiaddr(process.argv[2])

    // open a stream for sending to them
    const sendStream = await node.dialProtocol(ma, '/asscrack/chat/receive')
    console.log('Connected to peer at', process.argv[2])
    console.log('Type messages below:')

    attachChat(sendStream, ma.getPeerId())
} else {
    console.log('Waiting for incoming connection...')
}
