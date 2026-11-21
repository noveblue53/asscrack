import * as readline from 'readline'
import { createAsscrackNode } from './node.mjs'

const args = process.argv.slice(2)
let room = 'default'
let target
let name
let trustedLan = false
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--room') room = args[++i]
    else if (args[i] === '--name') name = args[++i]
    else if (args[i] === '--trusted-lan') trustedLan = true
    else target = args[i]
}
if (!room || name === '') {
    console.error('Usage: node src/network/transceiver.mjs [--room <name>] [--name <name>] [--trusted-lan] [<multiaddr>]')
    process.exit(1)
}

// The legacy terminal demo has no device admission. Keep its default listener local.
const node = await createAsscrackNode({
    room, name, discovery: trustedLan, listen: [trustedLan ? '/ip4/0.0.0.0/tcp/0' : '/ip4/127.0.0.1/tcp/0']
})
console.log('Transceiver started with peer id:', node.peerId, 'room:', room)
console.log('Listening on:')
node.getMultiaddrs().forEach(addr => console.log(addr))

node.events.on('peer-discovered', ({ peerId, addresses }) => {
    console.log('Discovered peer:', peerId)
    addresses.forEach(addr => console.log('Peer address:', addr))
})
node.events.on('peer-joined', ({ peerId }) => console.log('Chat ready with peer:', peerId))
node.events.on('peer-left', ({ peerId }) => console.log('Chat closed with peer:', peerId))
node.events.on('peer-name', ({ peerId, name }) => console.log(`Peer name: ${name} (${peerId})`))
node.events.on('host-changed', ({ peerId, term }) => console.log(`Host: ${peerId} (term ${term})`))
node.events.on('message', ({ from, text }) => console.log(`\n> ${from}: ${text}`))
node.events.on('file-offer', ({ from, name, size }) =>
    console.log(`File offer from ${from}: ${name} (${size} bytes). The terminal demo does not receive files.`))
node.events.on('history', ({ messages }) => {
    for (const { from, text } of messages) console.log(`[history] > ${from}: ${text}`)
})

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
// One terminal reader, shared by all active peer sessions.
rl.on('line', line => {
    try {
        if (node.send(line) === 0) console.log('No active chat peers. Connect to a peer to send messages.')
    } catch (err) {
        console.error('Message not sent:', err.message)
    }
})

if (target) {
    // A failed connect does not stop the process: discovery can still open the session.
    try {
        await node.connect(target)
        console.log('Connected to peer at', target)
        console.log('Type messages below:')
    } catch (err) {
        console.error('Connect to', target, 'failed:', err?.message ?? err)
    }
} else {
    console.log('Waiting for incoming connection...')
}
