import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode, pickVoiceRelay } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

// All results of this file are 127.0.0.1 results, not LAN results.

const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

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

async function stopAll(nodes) {
    await Promise.allSettled(nodes.filter(Boolean).map(n => n.stop()))
}

function record(node) {
    const got = []
    node.events.on('voice-frame', f => got.push({ ...f, at: performance.now() }))
    return got
}

describe('pickVoiceRelay (pure)', () => {
    test('handles empty, single, and deterministic selection', () => {
        assert.equal(pickVoiceRelay('peerA', []), null)
        assert.equal(pickVoiceRelay('peerA', null), null)
        assert.equal(pickVoiceRelay('peerA', ['R1']), 'R1')
        const pool = ['12D3KooWR1', '12D3KooWR2', '12D3KooWR3']
        const first = pickVoiceRelay('12D3KooWSender', pool)
        assert.ok(pool.includes(first))
        for (let i = 0; i < 10; i++) {
            assert.equal(pickVoiceRelay('12D3KooWSender', pool), first)
        }
    })

    test('distributes senders across 2 and 3 relays', () => {
        const two = ['12D3KooWRelayA', '12D3KooWRelayB']
        const counts2 = new Map(two.map(r => [r, 0]))
        for (let i = 0; i < 60; i++) {
            const picked = pickVoiceRelay(`12D3KooWSender${i}`, two)
            counts2.set(picked, counts2.get(picked) + 1)
        }
        for (const r of two) assert.ok(counts2.get(r) >= 15, `relay ${r} got ${counts2.get(r)} of 60`)

        const three = ['12D3KooWRelayA', '12D3KooWRelayB', '12D3KooWRelayC']
        const counts3 = new Map(three.map(r => [r, 0]))
        for (let i = 0; i < 60; i++) {
            const picked = pickVoiceRelay(`12D3KooWSender${i}`, three)
            counts3.set(picked, counts3.get(picked) + 1)
        }
        for (const r of three) assert.ok(counts3.get(r) >= 8, `relay ${r} got ${counts3.get(r)} of 60`)
    })

    test('Rendezvous minimal disruption: dropping 1 of 3 relays only moves peers on that relay', () => {
        const three = ['12D3KooWRelayA', '12D3KooWRelayB', '12D3KooWRelayC']
        const two = ['12D3KooWRelayA', '12D3KooWRelayC']
        for (let i = 0; i < 60; i++) {
            const sender = `12D3KooWSender${i}`
            const before = pickVoiceRelay(sender, three)
            const after = pickVoiceRelay(sender, two)
            if (before !== '12D3KooWRelayB') {
                assert.equal(after, before, `sender ${sender} stayed on ${before}`)
            } else {
                assert.ok(two.includes(after))
            }
        }
    })
})

describe('sharded 1-hop voice relays (127.0.0.1)', { concurrency: false }, () => {

    test('distributes relayed voice frames across 2 Full Nodes with 1-hop cap (127.0.0.1)', { timeout: 90000 }, async () => {
        const room = `vshard-dist-${Date.now()}`
        const roomKey = newRoomKey()
        const nodes = []
        try {
            const F1 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, allowPrivateFullNode: true, ...fast })
            const F2 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, allowPrivateFullNode: true, ...fast })
            nodes.push(F1, F2)
            await F2.connect(localAddr(F1))
            await waitFor(() => F1.peers().includes(F2.peerId) && F2.peers().includes(F1.peerId), 15000, 'F1-F2 session')

            const peers = []
            for (let i = 0; i < 6; i++) {
                const p = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, allowPrivateFullNode: true, ...fast })
                peers.push(p)
                nodes.push(p)
                await p.connect(localAddr(F1))
                await p.connect(localAddr(F2))
                await sleep(220)
            }

            await waitFor(() => peers.every(p => p.peers().includes(F1.peerId) && p.peers().includes(F2.peerId)), 20000, 'all relayOnly peers connected to both Full Nodes')
            await waitFor(() => peers.every(p => peers.every(q => p === q || p.peers().includes(q.peerId))), 20000, 'all relayOnly peers have sessions with each other')
            await waitFor(() => {
                const h = F1.host()?.peerId
                return h && nodes.every(n => n.host()?.peerId === h)
            }, 20000, 'common host')

            const got = peers.map(p => record(p))
            for (const p of peers) p.setVoice({ inVoice: true })

            await waitFor(() => peers.every(p => p.voiceStats().upstreamRelays.length === 2), 15000, 'all peers have 2 upstream relays')
            await waitFor(() => F1.voiceStats().streams === 6 && F2.voiceStats().streams === 6, 15000, 'both Full Nodes have 6 voice streams')
            // Confirm no direct streams among relayOnly peers.
            for (const p of peers) assert.equal(p.voiceStats().directStreams, 0, 'relayOnly peer has 0 direct streams')

            const framesPerPeer = 20
            for (let seq = 0; seq < framesPerPeer; seq++) {
                for (const p of peers) p.sendVoiceFrame(new Uint8Array(60).fill(seq & 0xff))
                await sleep(20)
            }

            await waitFor(() => {
                for (let i = 0; i < peers.length; i++) {
                    for (let j = 0; j < peers.length; j++) {
                        if (i === j) continue
                        if (got[i].filter(f => f.origin === peers[j].peerId).length < framesPerPeer - 1) return false
                    }
                }
                return true
            }, 8000, 'all relayOnly peers receive frames from all other peers')

            // Verify sequence numbers increase for each sender->receiver pair.
            for (let i = 0; i < peers.length; i++) {
                for (let j = 0; j < peers.length; j++) {
                    if (i === j) continue
                    const fromJ = got[i].filter(f => f.origin === peers[j].peerId)
                    assert.ok(fromJ.length >= framesPerPeer - 1, `peer ${i} got ${fromJ.length} of ${framesPerPeer} from ${j}`)
                    for (let k = 1; k < fromJ.length; k++) assert.ok(fromJ[k].seq > fromJ[k - 1].seq, 'seq increases')
                }
            }

            const s1 = F1.voiceStats()
            const s2 = F2.voiceStats()
            assert.ok(s1.forwarded > 0, `F1 forwarded ${s1.forwarded} frames`)
            assert.ok(s2.forwarded > 0, `F2 forwarded ${s2.forwarded} frames`)

            // 1-hop invariant: each speaker's frames are forwarded by at most ONE Full Node.
            for (const p of peers) {
                const f1Count = Object.values(s1.forwardedTo[p.peerId] ?? {}).reduce((a, b) => a + b, 0)
                const f2Count = Object.values(s2.forwardedTo[p.peerId] ?? {}).reduce((a, b) => a + b, 0)
                assert.ok((f1Count > 0) !== (f2Count > 0),
                    `speaker ${p.peerId.slice(-6)} must be forwarded by exactly 1 Full Node (F1=${f1Count}, F2=${f2Count})`)
            }
        } finally {
            await stopAll(nodes)
        }
    })

    test('seamless failover when a relay Full Node drops mid-stream (127.0.0.1)', { timeout: 90000 }, async () => {
        const room = `vshard-fail-${Date.now()}`
        const roomKey = newRoomKey()
        const nodes = []
        try {
            const F1 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, allowPrivateFullNode: true, ...fast })
            const F2 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, allowPrivateFullNode: true, ...fast })
            nodes.push(F1, F2)
            await F2.connect(localAddr(F1))
            await waitFor(() => F1.peers().includes(F2.peerId), 15000, 'F1-F2 session')

            const peers = []
            for (let i = 0; i < 6; i++) {
                const p = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, allowPrivateFullNode: true, ...fast })
                peers.push(p)
                nodes.push(p)
                await p.connect(localAddr(F1))
                await p.connect(localAddr(F2))
                await sleep(220)
            }
            await waitFor(() => peers.every(p => p.peers().includes(F1.peerId) && p.peers().includes(F2.peerId)), 20000, 'sessions')
            await waitFor(() => {
                const h = F1.host()?.peerId
                return h && nodes.every(n => n.host()?.peerId === h)
            }, 20000, 'common host')

            for (const p of peers) p.setVoice({ inVoice: true })
            await waitFor(() => peers.every(p => p.voiceStats().upstreamRelays.length === 2), 15000, '2 upstreams')

            // Pick a speaker whose assigned relay is F2 (or fallback to F1 if all hashed to F1, though 6 peers has ~97% chance).
            let speaker = peers.find(p => p.voiceStats().publishRelay === F2.peerId)
            let dropped = F2
            let survivor = F1
            if (!speaker) {
                speaker = peers[0]
                const pub = speaker.voiceStats().publishRelay
                dropped = pub === F1.peerId ? F1 : F2
                survivor = dropped === F1 ? F2 : F1
            }
            const listener = peers.find(p => p !== speaker)
            const gotL = record(listener)

            // Phase 1: stream 20 frames via `dropped`.
            for (let i = 0; i < 20; i++) {
                speaker.sendVoiceFrame(new Uint8Array(60).fill(1))
                await sleep(20)
            }
            await waitFor(() => gotL.filter(f => f.origin === speaker.peerId).length >= 18, 5000, 'pre-drop frames')
            const preDropCount = gotL.filter(f => f.origin === speaker.peerId).length
            const preSurvivorFwd = survivor.voiceStats().forwardedTo[speaker.peerId]?.[listener.peerId] ?? 0

            // Drop the relay Full Node mid-stream.
            await dropped.stop()
            await waitFor(() => speaker.voiceStats().publishRelay === survivor.peerId && listener.peers().includes(speaker.peerId),
                15000, 'speaker switched to survivor and session recovered')

            // Phase 2: stream 30 more frames via `survivor`.
            for (let i = 0; i < 30; i++) {
                speaker.sendVoiceFrame(new Uint8Array(60).fill(2))
                await sleep(20)
            }
            await waitFor(() => gotL.filter(f => f.origin === speaker.peerId).length >= preDropCount + 25, 8000, 'post-drop frames')

            const allFromSpeaker = gotL.filter(f => f.origin === speaker.peerId)
            for (let k = 1; k < allFromSpeaker.length; k++) {
                assert.ok(allFromSpeaker[k].seq > allFromSpeaker[k - 1].seq, 'seq increases across failover')
            }
            const postSurvivorFwd = survivor.voiceStats().forwardedTo[speaker.peerId]?.[listener.peerId] ?? 0
            assert.ok(postSurvivorFwd - preSurvivorFwd >= 25, `survivor forwarded ${postSurvivorFwd - preSurvivorFwd} post-drop frames`)
        } finally {
            await stopAll(nodes)
        }
    })

    test('direct pairs stay on VOICE_DIRECT_PROTOCOL while relayOnly peers use sharded Full Nodes (127.0.0.1)', { timeout: 90000 }, async () => {
        const room = `vshard-dir-${Date.now()}`
        const roomKey = newRoomKey()
        const nodes = []
        try {
            const F1 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, allowPrivateFullNode: true, ...fast })
            const F2 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, allowPrivateFullNode: true, ...fast })
            const D1 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, allowPrivateFullNode: true, ...fast })
            const D2 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, allowPrivateFullNode: true, ...fast })
            const R1 = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, allowPrivateFullNode: true, ...fast })
            const R2 = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, allowPrivateFullNode: true, ...fast })
            nodes.push(F1, F2, D1, D2, R1, R2)

            await F2.connect(localAddr(F1))
            await D1.connect(localAddr(D2))
            for (const n of [D1, D2, R1, R2]) {
                await n.connect(localAddr(F1))
                await n.connect(localAddr(F2))
                await sleep(220)
            }
            await waitFor(() => D1.peers().includes(D2.peerId) && [D1, D2, R1, R2].every(n => n.peers().includes(F1.peerId) && n.peers().includes(F2.peerId)),
                20000, 'all sessions')
            await waitFor(() => {
                const h = F1.host()?.peerId
                return h && nodes.every(n => n.host()?.peerId === h)
            }, 20000, 'common host')

            const gotD2 = record(D2)
            const gotR1 = record(R1)
            const gotR2 = record(R2)
            for (const n of [D1, D2, R1, R2]) n.setVoice({ inVoice: true })

            await waitFor(() => D1.voiceStats().directStreams >= 1 && D2.voiceStats().directStreams >= 1, 15000, 'direct streams D1-D2')
            await waitFor(() => [D1, D2, R1, R2].every(n => n.voiceStats().upstreamRelays.length === 2), 15000, '2 upstream relays')
            await sleep(400)

            const setupF1 = F1.voiceStats().forwardedTo[D1.peerId]?.[D2.peerId] ?? 0
            const setupF2 = F2.voiceStats().forwardedTo[D1.peerId]?.[D2.peerId] ?? 0

            for (let i = 0; i < 50; i++) {
                D1.sendVoiceFrame(new Uint8Array(80).fill(i & 0xff))
                await sleep(20)
            }

            await waitFor(() =>
                gotD2.filter(f => f.origin === D1.peerId).length >= 48 &&
                gotR1.filter(f => f.origin === D1.peerId).length >= 48 &&
                gotR2.filter(f => f.origin === D1.peerId).length >= 48, 8000, 'D2, R1, R2 receive D1 frames')

            assert.ok(D2.voiceStats().directReceived >= 48, `D2 received ${D2.voiceStats().directReceived} direct frames`)
            assert.equal((F1.voiceStats().forwardedTo[D1.peerId]?.[D2.peerId] ?? 0) - setupF1, 0, 'F1 does not forward D1->D2')
            assert.equal((F2.voiceStats().forwardedTo[D1.peerId]?.[D2.peerId] ?? 0) - setupF2, 0, 'F2 does not forward D1->D2')
        } finally {
            await stopAll(nodes)
        }
    })

    test('1.0.9 backward compatibility: legacy relayOnly listener and legacy non-host Full Node (127.0.0.1)', { timeout: 90000 }, async () => {
        const room = `vshard-compat-${Date.now()}`
        const roomKey = newRoomKey()
        const nodes = []
        try {
            const F1 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, allowPrivateFullNode: true, ...fast })
            const F2 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, allowPrivateFullNode: true, ...fast })
            // Legacy 1.0.9 Full Node (voiceSharding: false) and legacy 1.0.9 relayOnly listener (voiceSharding: false).
            const F_old = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, allowPrivateFullNode: true, voiceSharding: false, ...fast })
            const S = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, allowPrivateFullNode: true, ...fast })
            const L_old = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, allowPrivateFullNode: true, voiceSharding: false, ...fast })
            nodes.push(F1, F2, F_old, S, L_old)

            await F2.connect(localAddr(F1))
            await F_old.connect(localAddr(F1))
            await F_old.connect(localAddr(F2))
            for (const p of [S, L_old]) {
                await p.connect(localAddr(F1))
                await p.connect(localAddr(F2))
                await p.connect(localAddr(F_old))
            }
            await waitFor(() => [S, L_old].every(p => p.peers().includes(F1.peerId) && p.peers().includes(F2.peerId) && p.peers().includes(F_old.peerId)),
                20000, 'sessions')
            await waitFor(() => {
                const h = F1.host()?.peerId
                return h && nodes.every(n => n.host()?.peerId === h)
            }, 20000, 'common host')

            const hostId = F1.host().peerId
            const gotOld = record(L_old)
            S.setVoice({ inVoice: true })
            L_old.setVoice({ inVoice: true })

            await waitFor(() => S.voiceStats().upstreamRelays.length >= 1 && L_old.voiceStats().upstreamRelays.length === 1, 15000, 'upstreams')
            // New node S excludes F_old (unless F_old happened to be elected host) from its relay pool.
            if (F_old.peerId !== hostId) {
                assert.equal(S.voiceStats().relayPool.includes(F_old.peerId), false, '1.0.9 non-host Full Node is excluded from relayPool')
            }
            // Because L_old is a 1.0.9 voice listener without a direct stream, S routes to hostId().
            await waitFor(() => S.voiceStats().publishRelay === hostId, 10000, 'S falls back to hostId for 1.0.9 listener')

            for (let i = 0; i < 30; i++) {
                S.sendVoiceFrame(new Uint8Array(60).fill(i & 0xff))
                await sleep(20)
            }
            await waitFor(() => gotOld.filter(f => f.origin === S.peerId).length >= 28, 8000, '1.0.9 listener receives frames from S')
        } finally {
            await stopAll(nodes)
        }
    })
})
