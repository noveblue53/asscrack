import { createAsscrackNode } from '/home/user/asscrack/src/network/node.mjs'
const n = await createAsscrackNode({ room: 'demo-chk', name: 'peer', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false })
await n.connect(process.argv[2])
await new Promise(r => setTimeout(r, 500))
n.setPresence({ state: 'away', note: 'demo note' })
n.send('chat after presence')
await new Promise(r => setTimeout(r, 1000))
await n.stop()
