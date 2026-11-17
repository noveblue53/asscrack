// One asscrack node in its own process, for history-net.mjs.
// Usage: node history-worker.mjs <repo-root> <room> <name>
// Stdout: one JSON line per event, with t = Date.now().
// Stdin: one JSON line per command: {"cmd":"send","text":...} | {"cmd":"voice"} | {"cmd":"state"}
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import readline from 'node:readline'

const [root, room, name] = process.argv.slice(2)
const { createAsscrackNode } = await import(pathToFileURL(path.join(root, 'src/network/node.mjs')).href)
const out = obj => process.stdout.write(JSON.stringify({ t: Date.now(), ...obj }) + '\n')
// The default listen address of the app (0.0.0.0). With 127.0.0.1 only, mDNS gives no session.
const node = await createAsscrackNode({ room, name })
out({ ev: 'ready', peerId: node.peerId })
for (const type of ['peer-joined', 'peer-left', 'host-changed', 'history', 'message', 'peer-name']) {
    node.events.on(type, data => out({ ev: type, data, isHost: node.isHost() }))
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
    const c = JSON.parse(line)
    if (c.cmd === 'send') out({ ev: 'sent', data: await node.send(c.text) })
    else if (c.cmd === 'voice') { node.setVoice({ inVoice: true, streamId: 's-' + name, muted: false }); out({ ev: 'voice' }) }
    else if (c.cmd === 'state') out({ ev: 'state', host: node.host(), isHost: node.isHost(), history: node.history().map(m => m.text) })
})
