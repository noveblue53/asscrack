// One laboratory peer process, two real libp2p routes. The byte stream is separate from chat and voice.
import assert from 'node:assert/strict'
import { setTimeout as wait } from 'node:timers/promises'
import { createAsscrackNode } from '../../src/network/node.mjs'
import { newRoomKey } from '../../src/network/invite.mjs'

const protocol = '/asscrack/bench/synthetic-video/1'
async function until(check, what) {
    const end = performance.now() + 10000
    while (!check() && performance.now() < end) await wait(15)
    assert.ok(check(), what)
}
function p95(values) {
    if (!values.length) return null
    const sorted = [...values].sort((a,b) => a - b)
    return Math.round(sorted[Math.floor((sorted.length - 1) * 0.95)] * 10) / 10
}

async function route(source, target, relay, frames) {
    const connection = source.libp2p.getConnections().find(c => String(c.remotePeer) === target.peerId)
    assert.ok(connection, 'authenticated peers connected')
    assert.equal(connection.remoteAddr.toString().includes('/p2p-circuit'), relay !== null)
    if (relay) assert.ok(connection.remoteAddr.toString().includes('/p2p/' + relay.peerId + '/p2p-circuit'))
    let received = 0
    let readError
    const sentAt = []
    const arrivals = []
    await target.libp2p.handle(protocol, async ({ stream, connection }) => {
        if (String(connection.remotePeer) !== source.peerId) return stream.abort(new Error('unknown sender'))
        // The receiver knows each original frame length for this byte-equivalence experiment.
        let parts = []
        let offset = 0
        try {
            for await (const part of stream.source) {
                const data = Buffer.from(part.subarray())
                for (let i = 0; i < data.length;) {
                    assert.ok(received < frames.length)
                    const size = frames[received].data.length
                    const take = Math.min(size - offset, data.length - i)
                    parts.push(data.subarray(i, i + take))
                    offset += take
                    i += take
                    if (offset === size) {
                        assert.ok(Buffer.concat(parts).equals(frames[received].data), 'frame bytes match')
                        arrivals.push(performance.now() - sentAt[received++])
                        parts = []
                        offset = 0
                    }
                }
            }
        } catch (err) { readError = err }
    }, { runOnTransientConnection: true })
    const voice = []
    const onVoice = event => { if (event.origin === source.peerId) voice.push(performance.now()) }
    target.events.on('voice-frame', onVoice)
    let timer
    try {
        const stream = await connection.newStream(protocol, { runOnTransientConnection: true })
        const start = performance.now()
        let sentVoice = 0
        timer = setInterval(() => { source.sendVoiceFrame(new Uint8Array(120)); sentVoice++ }, 20)
        await stream.sink((async function* () {
            for (const frame of frames) {
                const remaining = start + frame.at - performance.now()
                if (remaining > 0) await wait(remaining)
                sentAt.push(performance.now())
                yield frame.data
            }
        })())
        clearInterval(timer)
        await stream.close()
        await until(() => received === frames.length || readError, 'all synthetic video frames arrived')
        if (readError) throw readError
        await wait(200)
        const gaps = voice.slice(1).map((time, i) => time - voice[i])
        assert.ok(voice.length > 0, 'concurrent synthetic voice reached the recipient')
        return { route: relay ? '127.0.0.1 circuit' : '127.0.0.1 direct', frames: received,
            sentPayloadBytes: frames.reduce((sum, f) => sum + f.data.length, 0),
            videoSendToReadP95ms: p95(arrivals), sentVoice, receivedVoice: voice.length,
            voiceArrivalGapP95ms: p95(gaps), maxVoiceGapMs: Math.round(Math.max(...gaps)) }
    } finally {
        clearInterval(timer)
        target.events.off('voice-frame', onVoice)
        await target.libp2p.unhandle(protocol)
    }
}

export async function replay(sample) {
    const frames = sample.map(f => ({ at: f.at, data: Buffer.from(f.data, 'base64') }))
    const options = { room: 'screen-bench', roomKey: newRoomKey(), discovery: false }
    const nodes = []
    async function add(extra) {
        const node = await createAsscrackNode({ ...options, ...extra })
        nodes.push(node)
        return node
    }
    try {
        const host = await add({ listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: true })
        const source = await add({ relayOnly: true, fullNode: false })
        const viewer = await add({ relayOnly: true, fullNode: false })
        const addr = host.getMultiaddrs().find(a => a.startsWith('/ip4/127.0.0.1/'))
        await source.connect(addr)
        await viewer.connect(addr)
        await until(() => nodes.every(p => p.host()?.peerId === host.peerId && p.peers().length === 2), 'keyed three-peer room')
        for (const p of nodes) p.setVoice({ inVoice: true })
        await until(() => host.voiceStats().streams === 2, 'two active relay voice streams')
        return [await route(source, host, null, frames), await route(source, viewer, host, frames)]
    } finally {
        await Promise.allSettled(nodes.map(p => p.stop()))
    }
}
