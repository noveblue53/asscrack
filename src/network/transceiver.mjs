import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { pipe } from 'it-pipe'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { multiaddr } from '@multiformats/multiaddr'
import * as readline from 'readline'

const node = await createLibp2p({
    addresses: {
        listen: ['/ip4/0.0.0.0/tcp/0']
    },
    transports: [tcp()],
    streamMuxers: [yamux()],
    connectionEncryption: [noise()]
})

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

await node.start()
console.log('Transceiver started with peer id:', node.peerId.toString())
console.log('Listening on:')
node.getMultiaddrs().forEach(addr => console.log(addr.toString()))

// handle incoming receive stream
node.handle('/asscrack/chat/receive', async ({ stream, connection }) => {
    // receive incoming messages
    pipe(
        stream,
        async function (source) {
            for await (const msg of source) {
                console.log('\n> ' + uint8ArrayToString(msg.subarray()))
            }
        }
    )

    // dial back to sender to open our own send stream
    const sendStream = await node.dialProtocol(connection.remotePeer, '/asscrack/chat/receive')

    pipe(
        rl[Symbol.asyncIterator](),
        async function* (source) {
            for await (const line of source) {
                yield uint8ArrayFromString(line)
            }
        },
        sendStream
    )
})

node.addEventListener('connection:open', (event) => {
    const connection = event.detail
    console.log('New connection established with peer:', connection.remotePeer.toString())
    console.log('Their address:', connection.remoteAddr.toString())
})

if (process.argv[2]) {
    const ma = multiaddr(process.argv[2])

    // open a stream for sending to them
    const sendStream = await node.dialProtocol(ma, '/asscrack/chat/receive')
    console.log('Connected to peer at', process.argv[2])
    console.log('Type messages below:')

    pipe(
        rl[Symbol.asyncIterator](),
        async function* (source) {
            for await (const line of source) {
                yield uint8ArrayFromString(line)
            }
        },
        sendStream
    )
} else {
    console.log('Waiting for incoming connection...')
}