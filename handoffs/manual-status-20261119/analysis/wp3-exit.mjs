// WP3 exit checks of milestone 3 (127.0.0.1, not LAN). Network level. The UI part is in test/presence-ui.test.mjs.
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { createAsscrackNode as createCurrent } from '/home/user/asscrack/src/network/node.mjs'
import { createAsscrackNode as createOld } from './old060/src/network/node.mjs'

const listen = ['/ip4/127.0.0.1/tcp/0']
async function waitFor(check, what) {
    for (let i = 0; i < 200; i++) { if (check()) return; await delay(50) }
    throw new Error(`timeout: ${what}`)
}
const results = {}
async function run(name, fn) {
    const nodes = []
    const make = async (factory, opts) => { const n = await factory({ listen, discovery: false, ...opts }); nodes.push(n); return n }
    try { results[name] = { pass: true, ...(await fn(make)) } }
    catch (err) { results[name] = { pass: false, error: String(err?.stack ?? err) } }
    finally { for (const n of nodes) await n.stop().catch(() => {}) }
}

await run('1 away note, late joiner', async make => {
    const room = 'wp3-1'
    const a = await make(createCurrent, { room, name: 'A' })
    const b = await make(createCurrent, { room, name: 'B' })
    await b.connect(a.getMultiaddrs()[0])
    await waitFor(() => b.peerPresence()[a.peerId]?.state === 'available', 'B sees A available')
    a.setPresence({ state: 'away', note: 'back at 9' })
    await waitFor(() => b.peerPresence()[a.peerId]?.state === 'away', 'B sees away')
    assert.equal(b.peerPresence()[a.peerId].note, 'back at 9')
    const c = await make(createCurrent, { room, name: 'C' })
    const t0 = Date.now()
    await c.connect(a.getMultiaddrs()[0])
    await waitFor(() => c.peerPresence()[a.peerId]?.state === 'away', 'C sees away')
    assert.equal(c.peerPresence()[a.peerId].note, 'back at 9')
    return { bSees: b.peerPresence()[a.peerId], cSees: c.peerPresence()[a.peerId], cWaitMs: Date.now() - t0 }
})

await run('2 drop and reopen, restart with new peer ID', async make => {
    const room = 'wp3-2'
    const a = await make(createCurrent, { room, name: 'A' })
    const b = await make(createCurrent, { room, name: 'B' })
    await b.connect(a.getMultiaddrs()[0])
    a.setPresence({ state: 'dnd', note: 'racing' })
    await waitFor(() => b.peerPresence()[a.peerId]?.state === 'dnd', 'B sees dnd')
    await b.libp2p.hangUp(a.libp2p.peerId)
    await waitFor(() => !b.peerPresence()[a.peerId] && b.peers().length === 0, 'state gone on drop')
    await b.connect(a.getMultiaddrs()[0])
    await waitFor(() => b.peerPresence()[a.peerId]?.state === 'dnd', 'state restored on reopen')
    const reopened = b.peerPresence()[a.peerId]
    const oldId = a.peerId
    await a.stop()
    await waitFor(() => b.peers().length === 0, 'B sees A leave')
    const a2 = await make(createCurrent, { room, name: 'A' })
    await b.connect(a2.getMultiaddrs()[0])
    await waitFor(() => b.peerPresence()[a2.peerId]?.state === 'available', 'B sees new A available')
    assert.notEqual(a2.peerId, oldId)
    assert.equal(b.peerPresence()[oldId], undefined)
    assert.deepEqual(Object.keys(b.peerPresence()), [a2.peerId])
    return { reopened, afterRestart: b.peerPresence(), oldRowGone: true }
})

await run('3 dnd leaves voice state alone', async make => {
    const room = 'wp3-3'
    const a = await make(createCurrent, { room, name: 'A' })
    const b = await make(createCurrent, { room, name: 'B' })
    await b.connect(a.getMultiaddrs()[0])
    const voice = []
    b.events.on('voice-state', e => voice.push(e))
    a.setVoice({ inVoice: true, streamId: 's1', muted: false })
    await waitFor(() => voice.length === 1, 'voice on')
    a.setPresence({ state: 'dnd', note: '' })
    await waitFor(() => b.peerPresence()[a.peerId]?.state === 'dnd', 'dnd seen')
    await delay(300)
    assert.equal(voice.length, 1)
    assert.equal(voice[0].muted, false)
    assert.equal(voice[0].inVoice, true)
    return { voiceEventsAfterDnd: voice.length - 1 }
})

for (const dir of ['current dials old', 'old dials current']) {
    await run(`4 mixed version, ${dir}`, async make => {
        const room = 'wp3-4' + dir.length
        const n = await make(createCurrent, { room, name: 'new' })
        const o = await make(createOld, { room, name: 'old' })
        const oMsg = []
        const nMsg = []
        o.events.on('message', e => oMsg.push(e.text))
        n.events.on('message', e => nMsg.push(e.text))
        if (dir === 'current dials old') await n.connect(o.getMultiaddrs()[0])
        else await o.connect(n.getMultiaddrs()[0])
        await waitFor(() => n.peers().length === 1 && o.peers().length === 1, 'session')
        n.setPresence({ state: 'away', note: 'x' })
        n.send('hello old')
        o.send('hello new')
        await waitFor(() => oMsg.length === 1 && nMsg.length === 1, 'chat both ways')
        await delay(300)
        assert.equal(n.peerPresence()[o.peerId], undefined) // UI shows "status unknown"
        assert.deepEqual(oMsg, ['hello old'])
        assert.ok(!o.history().some(m => JSON.stringify(m).includes('presence')))
        return { oldPeerPresenceAtNew: n.peerPresence()[o.peerId] ?? 'none (status unknown)', oMsg, nMsg }
    })
}

await run('5 two buddies with the same name', async make => {
    const room = 'wp3-5'
    const b = await make(createCurrent, { room, name: 'B' })
    const s1 = await make(createCurrent, { room, name: 'Sam' })
    const s2 = await make(createCurrent, { room, name: 'Sam' })
    await s1.connect(b.getMultiaddrs()[0])
    await s2.connect(b.getMultiaddrs()[0])
    s1.setPresence({ state: 'away', note: 'one' })
    s2.setPresence({ state: 'dnd', note: 'two' })
    await waitFor(() => b.peerPresence()[s1.peerId]?.state === 'away' && b.peerPresence()[s2.peerId]?.state === 'dnd', 'both states')
    assert.equal(b.peerPresence()[s1.peerId].note, 'one')
    assert.equal(b.peerPresence()[s2.peerId].note, 'two')
    return { b: b.peerPresence() }
})

console.log('RESULT ' + JSON.stringify(results, null, 2))
process.exit(Object.values(results).every(r => r.pass) ? 0 : 1)
