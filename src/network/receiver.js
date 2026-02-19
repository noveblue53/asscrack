// imports
import process from 'node:process'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { multiaddr } from '@multiformats/multiaddr'
import { ping } from '@libp2p/ping'

//establish a node's setup
const main =  async () => {
    const node = await createLibp2p({
        addresses: {
         // add a listen address (localhost) to accept TCP connections on a random port
         listen: ['/ip4/127.0.0.1/tcp/0']
    },
        transports: [tcp()],
        connectionEncryption: [noise()],
        streamMuxers: [yamux()],
        services: {
            ping: ping({
                protocolPrefix: 'ipfs',
            }),
        },
    })

    // start libp2p
    await node.start()
    console.log('libp2p has started')

    // print listening addresses
    console.log('listening on addresses:')
    node.getMultiaddrs().forEach((addr) => {
        console.log(addr.toString())
    })

    // ping peer if received multi address
    if (process.argv.length >= 3) {
        const ma = multiaddr(process.argv[2])
        console.log(`pinging remote peer at ${process.argv[2]}`)
        const latency = await node.services.ping.ping(ma)
        console.log(`pinged ${process.argv[2]} in ${latency}ms`)
    } else {
        console.log('no remote peer address given, ping skipped')
    }

const stop = async () => {
    // stop libp2p
    await node.stop()
    console.log('libp2p has stopped')
    process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
}

main().catch(console.error)