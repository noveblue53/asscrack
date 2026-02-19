import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { pipe } from 'it-pipe'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { multiaddr } from '@multiformats/multiaddr'
import * as readline from 'readline'

const node = await createLibp2p({
  addresses: {
    listen: ['/ip4/127.0.0.1/tcp/0']
  },
  transports: [tcp()],
  streamMuxers: [yamux()],
  connectionEncryption: [noise()]
})

await node.start()
console.log('Transmitter started with id:', node.peerId.toString())

// get receiver address from command line argument
const receiverAddr = process.argv[2]
if (!receiverAddr) {
  console.error('Usage: node transmitter.mjs <receiver-multiaddr>')
  process.exit(1)
}

const ma = multiaddr(receiverAddr)
const stream = await node.dialProtocol(ma, '/asscrack/chat/1.0.0')
console.log('Connected to receiver at', receiverAddr)

// read from terminal and send
const rl = readline.createInterface({ input: process.stdin })

pipe(
    rl[Symbol.asyncIterator](),
    async function* (source) {
      for await (const line of source) {
        yield uint8ArrayFromString(line)
      }
    },
    stream
)