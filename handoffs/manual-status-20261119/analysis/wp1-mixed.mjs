// WP1 mixed-version check (127.0.0.1): current node A and 0.6.0 node O (d5ad3af) in one LAN room.
// A sends chat, an unknown typed control, then chat. O must show no line and keep no history entry for the control.
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { createAsscrackNode as createCurrent } from '/home/user/asscrack/src/network/node.mjs'
import { createAsscrackNode as createOld } from './old060/src/network/node.mjs'

const consoleLines = []
for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console)
    console[level] = (...args) => { consoleLines.push(`${level}: ${args.join(' ')}`); orig(...args) }
}

async function waitFor(check, what) {
    for (let i = 0; i < 200; i++) { if (check()) return; await delay(50) }
    throw new Error(`timeout: ${what}`)
}

function record(node) {
    const log = { messages: [], other: [] }
    node.events.on('message', e => log.messages.push(e))
    for (const ev of ['history', 'peer-name', 'voice-state', 'signal']) node.events.on(ev, e => log.other.push({ ev, e }))
    return log
}

const opts = { room: 'wp1-mixed', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false }
const results = {}
for (const dir of ['current-dials-old', 'old-dials-current']) {
    const a = await createCurrent({ ...opts, name: 'current' })
    const o = await createOld({ ...opts, name: 'old060' })
    try {
        const logA = record(a)
        const logO = record(o)
        if (dir === 'current-dials-old') await a.connect(o.getMultiaddrs()[0])
        else await o.connect(a.getMultiaddrs()[0])
        await waitFor(() => a.peers().length === 1 && o.peers().length === 1, 'session')
        await delay(300)
        const mark = consoleLines.length
        const otherMark = logO.other.length
        a.send('chat 1 before control')
        await waitFor(() => logO.messages.length === 1, 'chat 1')
        const sent = a.sendTo(o.peerId, { type: 'presence', v: 1, state: 'away', note: 'test note', seq: 1 })
        a.send('chat 2 after control')
        await waitFor(() => logO.messages.length === 2, 'chat 2')
        o.send('reply from old')
        await waitFor(() => logA.messages.length === 1, 'reply')
        await delay(300)
        const newConsole = consoleLines.slice(mark).filter(l => !l.startsWith('info: conn'))
        const fromA = o.history().filter(m => m.from === 'current').map(m => m.text)
        assert.equal(sent, true)
        assert.deepEqual(logO.messages.map(m => m.text), ['chat 1 before control', 'chat 2 after control'])
        assert.deepEqual(fromA, ['chat 1 before control', 'chat 2 after control'])
        assert.ok(!o.history().some(m => /presence|test note/.test(JSON.stringify(m))))
        assert.deepEqual(logA.messages.map(m => m.text), ['reply from old'])
        results[dir] = {
            pass: true, sendToResult: sent, oldMessages: logO.messages.map(m => m.text),
            oldHistoryCount: o.history().length, oldOtherEvents: logO.other.slice(otherMark).map(x => x.ev),
            consoleLinesDuringControl: newConsole
        }
    } finally {
        await a.stop()
        await o.stop()
    }
}
console.log('RESULT ' + JSON.stringify(results, null, 2))
