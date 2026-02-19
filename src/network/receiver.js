import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { pipe } from 'it-pipe'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import * as readline from 'readline'

const node = await createLibp2p({
  addresses: {
    listen: ['/ip4/127.0.0.1/tcp/0']
  },
  transports: [
    tcp()
  ],
  streamMuxers: [
    yamux()
  ],
  connectionEncryption: [
    noise()
  ]
})

await node.start()

console.log('Receiver started with id:', node.peerId.toString())
console.log('Listening on addresses:', node.getMultiaddrs().forEach(addr => console.log(addr.toString())))

node.handle('/asscrack/chat/1.0.0', async ({ stream }) => {
  pipe(
    stream,
    async function (source) {
      for await (const msg of source) {
        console.log('> ', uint8ArrayToString(msg.subarray()))
      }
    }
  )
})