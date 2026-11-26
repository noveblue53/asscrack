// Multi-hop room music fanout, parent failover, and 1.0.9 backward-compatibility tests (127.0.0.1).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const FRAME_BYTES = 160

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await sleep(25)
    }
    throw new Error(`timeout: ${what}`)
}

function localAddr(n) {
    const a = n.getMultiaddrs().find(m => m.startsWith('/ip4/127.0.0.1/') && !m.includes('p2p-circuit'))
    assert.ok(a, 'node has a 127.0.0.1 address')
    return a
}

async function makeRoom(nodes, specs) {
    const room = `mf-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roomKey = newRoomKey()
    const created = []
    for (const extra of specs) {
        const n = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, ...fast, ...extra })
        nodes.push(n)
        created.push(n)
    }
    // Connect non-host members directly first so their sessions are mesh, not relayed through H.
    for (let i = 1; i < created.length; i++) {
        for (let j = i + 1; j < created.length; j++) {
            await created[i].connect(localAddr(created[j]))
        }
    }
    for (let i = 1; i < created.length; i++) {
        await created[i].connect(localAddr(created[0]))
    }
    await waitFor(
        () => created.every(n => created.every(m => m === n || n.peers().includes(m.peerId))),
        20000,
        'full mesh of sessions'
    )
    const host = created[0]
    await waitFor(() => created.every(n => n.host()?.peerId === host.peerId), 20000, 'host elected')
    return created
}

function recordMusic(node) {
    const frames = []
    node.events.on('music-frame', f => frames.push(f))
    return frames
}

async function sendFrames(dj, count, startSeq = 0) {
    for (let i = 0; i < count; i++) {
        const seq = startSeq + i
        assert.equal(dj.sendMusicFrame(new Uint8Array(FRAME_BYTES).fill(seq & 0xff)), true, `frame ${seq} sent`)
        await sleep(15)
    }
}

describe('music fanout streams (127.0.0.1)', { concurrency: true }, () => {

    test('multi-hop forwarding tree: DJ -> hop-1 -> hop-2 delivers frames with zero host relay cost and reports musicEdges',
        { timeout: 60000 }, async () => {
            const nodes = []
            try {
                const [H, D, A, B] = await makeRoom(nodes, [
                    { fullNode: true },
                    { fullNode: false, musicFanoutOptions: { maxDirectListeners: 1, defaultMaxChildren: 2 } },
                    { fullNode: false, musicFanoutOptions: { maxDirectListeners: 1, defaultMaxChildren: 2 } },
                    { fullNode: false, musicFanoutOptions: { maxDirectListeners: 1, defaultMaxChildren: 2 } }
                ])
                const gotA = recordMusic(A)
                const gotB = recordMusic(B)

                for (const n of [D, A, B]) n.setVoice({ inVoice: true })
                await waitFor(() => [D, A, B].every(n => n.peers().length === 3), 10000, 'peers ready')

                D.music.addLocal([{ title: 'tree-track.ogg', local: 'k1' }])
                await waitFor(
                    () => A.music.state().dj === D.peerId && B.music.state().dj === D.peerId,
                    5000,
                    'A and B see DJ'
                )

                // Wait for 2-hop tree: D -> hop1 -> hop2
                await waitFor(() => {
                    const edges = D.topology().musicEdges
                    if (edges.length !== 2) return false
                    const hop1 = edges.find(e => e.from === D.peerId)
                    const hop2 = edges.find(e => hop1 && e.from === hop1.to)
                    return Boolean(hop1 && hop2)
                }, 10000, '2-hop music fanout tree formed')

                const edges = D.topology().musicEdges
                const hop1Edge = edges.find(e => e.from === D.peerId)
                const hop2Edge = edges.find(e => e.from === hop1Edge.to)
                assert.equal(hop1Edge.dj, D.peerId)
                assert.equal(hop2Edge.dj, D.peerId)
                assert.equal(D.musicTreeStats().children.length, 1, 'DJ only uploads to 1 direct child')

                await sendFrames(D, 30)
                await waitFor(() => gotA.length === 30 && gotB.length === 30, 5000, 'all 30 frames received at both hops')
                assert.equal(H.musicStats().forwarded, 0, 'voice host forwards 0 music frames')
                assert.equal(gotA[0].data[0], 0)
                assert.equal(gotB[29].data[0], 29)
            } finally {
                await Promise.allSettled(nodes.map(n => n.stop()))
            }
        })

    test('automatic parent failover: when hop-1 forwarder disconnects, hop-2 reparents and resumes receiving frames',
        { timeout: 60000 }, async () => {
            const nodes = []
            try {
                const [H, D, A, B] = await makeRoom(nodes, [
                    { fullNode: true },
                    { fullNode: false, musicFanoutOptions: { maxDirectListeners: 1, defaultMaxChildren: 2 } },
                    { fullNode: false, musicFanoutOptions: { maxDirectListeners: 1, defaultMaxChildren: 2 } },
                    { fullNode: false, musicFanoutOptions: { maxDirectListeners: 1, defaultMaxChildren: 2 } }
                ])
                const gotA = recordMusic(A)
                const gotB = recordMusic(B)

                for (const n of [D, A, B]) n.setVoice({ inVoice: true })
                D.music.addLocal([{ title: 'failover.ogg', local: 'k1' }])

                await waitFor(() => D.topology().musicEdges.length === 2, 10000, 'initial 2-hop tree')
                const hop1Id = D.topology().musicEdges.find(e => e.from === D.peerId).to
                const hop1Node = hop1Id === A.peerId ? A : B
                const hop2Node = hop1Id === A.peerId ? B : A
                const hop2Frames = hop1Id === A.peerId ? gotB : gotA

                await sendFrames(D, 15, 0)
                await waitFor(() => hop2Frames.length === 15, 5000, 'initial 15 frames received at hop 2')

                // Disconnect hop-1 forwarder
                await hop1Node.stop()

                // Wait for hop-2 to automatically reparent directly to DJ
                await waitFor(
                    () => hop2Node.musicParent() === D.peerId &&
                        D.topology().musicEdges.some(e => e.from === D.peerId && e.to === hop2Node.peerId),
                    10000,
                    'hop-2 reparented to DJ'
                )

                const beforeCount = hop2Frames.length
                await sendFrames(D, 20, 100)
                await waitFor(() => hop2Frames.length >= beforeCount + 20, 5000, 'post-failover frames received')
                assert.equal(hop2Frames[hop2Frames.length - 1].data[0], 119)
            } finally {
                await Promise.allSettled(nodes.map(n => n.stop()))
            }
        })

    test('backward compatibility with 1.0.9 listeners: capable listener uses tree while legacy listener receives via relay',
        { timeout: 60000 }, async () => {
            const nodes = []
            try {
                const [H, D, A, L] = await makeRoom(nodes, [
                    { fullNode: true },
                    { fullNode: false },
                    { fullNode: false },
                    { fullNode: false, musicFanout: false }
                ])
                const gotA = recordMusic(A)
                const gotL = recordMusic(L)

                for (const n of [D, A, L]) n.setVoice({ inVoice: true })
                D.music.addLocal([{ title: 'compat.ogg', local: 'k1' }])

                await waitFor(
                    () => A.music.state().dj === D.peerId && L.music.state().dj === D.peerId,
                    5000,
                    'capable and legacy listeners see DJ'
                )
                await waitFor(
                    () => A.musicParent() === D.peerId && D.topology().musicEdges.some(e => e.to === A.peerId),
                    10000,
                    'capable listener attached to music tree'
                )
                await waitFor(
                    () => H.musicStats().streams >= 3,
                    10000,
                    'legacy listener music stream ready'
                )

                await sendFrames(D, 25, 0)
                await waitFor(() => gotA.length === 25 && gotL.length === 25, 5000, 'both capable and legacy receive all 25 frames')
                assert.equal(gotA[24].data[0], 24)
                assert.equal(gotL[24].data[0], 24)
                assert.equal(L.musicParent(), null, 'legacy listener does not join music tree')
            } finally {
                await Promise.allSettled(nodes.map(n => n.stop()))
            }
        })
})
