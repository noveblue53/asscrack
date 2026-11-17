import * as readline from 'readline'
import { createAsscrackNode } from './node.mjs'

const args = process.argv.slice(2)
let room = 'default'
let target
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--room') room = args[++i]
    else target = args[i]
}
if (!room) {
    console.error('Usage: node src/network/transceiver.mjs [--room <name>] [<multiaddr>]')
    process.exit(1)
}

const node = await createAsscrackNode({ room })
console.log('Transceiver started with peer id:', node.peerId, 'room:', room)
console.log('Listening on:')
node.getMultiaddrs().forEach(addr => console.log(addr))

node.events.on('peer-joined', ({ peerId }) => console.log('Chat ready with peer:', peerId))
node.events.on('peer-left', ({ peerId }) => console.log('Chat closed with peer:', peerId))
node.events.on('message', ({ text }) => console.log('\n> ' + text))

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
// One terminal reader, shared by all active peer sessions.
rl.on('line', line => {
    if (node.send(line) === 0) console.log('No active chat peers. Connect to a peer to send messages.')
})

if (target) {
    await node.connect(target)
    console.log('Connected to peer at', target)
    console.log('Type messages below:')
} else {
    console.log('Waiting for incoming connection...')
}
