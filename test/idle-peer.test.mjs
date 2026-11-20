import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

async function waitFor(test, description) {
    const until = Date.now() + 10_000
    do {
        if (test()) return
        await delay(20)
    } while (Date.now() < until)
    assert.fail(description)
}

test('127.0.0.1 · Idle Peer leaves voice, retains host, forwards chat and voice, and restores the same session', { timeout: 45_000 }, async t => {
    const room = { room: 'idle', roomKey: newRoomKey(), discovery: false, heartbeatInterval: 200, hostTimeout: 1200, electionDelay: 400 }
    const peers = []
    t.after(() => Promise.allSettled(peers.map(p => p.stop())))
    async function add(options) {
        const p = await createAsscrackNode({ ...room, ...options })
        peers.push(p)
        return p
    }
    const host = await add({ listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: true })
    const addr = host.getMultiaddrs().find(a => a.startsWith('/ip4/127.0.0.1/tcp/'))
    const b = await add({ relayOnly: true, fullNode: false })
    const c = await add({ relayOnly: true, fullNode: false })
    const hostVoice = []
    b.events.on('voice-state', event => { if (event.peerId === host.peerId) hostVoice.push(event.inVoice) })
    await b.connect(addr)
    await waitFor(() => b.host()?.peerId === host.peerId, 'full node elected')
    host.setPresence({ state: 'away', note: 'back later' })
    host.setVoice({ inVoice: true })
    await waitFor(() => hostVoice.at(-1) === true, 'initial host voice announced')
    const connection = b.libp2p.getConnections().find(conn => String(conn.remotePeer) === host.peerId)
    host.setIdle(true)
    await waitFor(() => b.topology().idlePeers.includes(host.peerId) && hostVoice.at(-1) === false, 'host left voice and entered Idle Peer')
    assert.equal(host.topology().selfIdle, true)
    assert.deepEqual(b.peerPresence()[host.peerId], { state: 'away', note: 'back later' })

    // C joins the running idle host. Both restricted endpoints need its real circuit reservation for chat.
    await c.connect(addr)
    await waitFor(() => c.topology().idlePeers.includes(host.peerId), 'new session receives idle participation')
    await waitFor(() => c.peers().includes(b.peerId) && b.peers().includes(c.peerId), 'relayed chat established')
    assert.equal(c.topology().kinds[c.peerId][b.peerId], 'relay')
    const messages = []
    c.events.on('message', ({ text }) => messages.push(text))
    b.send('while the relay is idle')
    await waitFor(() => messages.includes('while the relay is idle'), 'chat passed over the circuit')

    const frames = []
    c.events.on('voice-frame', frame => frames.push(frame))
    b.setVoice({ inVoice: true })
    c.setVoice({ inVoice: true })
    await waitFor(() => host.voiceStats().streams === 2, 'two voice relay streams on idle host')
    b.sendVoiceFrame(Uint8Array.of(11, 42))
    await waitFor(() => frames.some(f => f.origin === b.peerId && f.data[1] === 42), 'synthetic voice frame reached C')
    assert.equal(host.sendVoiceFrame(Uint8Array.of(1)), false)
    for (const p of peers) assert.equal(p.host()?.peerId, host.peerId)

    host.setIdle(false)
    host.refreshRoutes()
    await waitFor(() => [b, c].every(p => !p.topology().idlePeers.includes(host.peerId)), 'Open restores active participation')
    assert.equal(hostVoice.at(-1), false, 'restoring the window must leave capture off')
    assert.equal(b.libp2p.getConnections().find(conn => String(conn.remotePeer) === host.peerId)?.id, connection.id)
    assert.equal(host.fullNode(), true)
})
