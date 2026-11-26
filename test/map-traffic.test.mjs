import test from 'node:test'
import assert from 'node:assert/strict'
import { createMapTraffic } from '../src/application/map-traffic.mjs'

test('map-traffic aggregates voice, music, screen (including fanout), and file transfers', () => {
    const traffic = createMapTraffic()
    assert.equal(traffic.snapshot(null), null)

    traffic.recordVoiceFrame('peer-b')
    traffic.recordVoiceFrame('peer-b')
    traffic.recordMusicFrame('peer-c')
    traffic.recordFileProgress({ offerId: 'o1', peerId: 'peer-d', direction: 'send', bytes: 4096 }, 'peer-a')
    traffic.recordFileProgress({ offerId: 'o2', peerId: 'peer-e', direction: 'receive', bytes: 8192 }, 'peer-a')

    const node = {
        peerId: 'peer-a',
        host: () => 'peer-h',
        voiceStats: () => ({
            seq: 12,
            streams: 1,
            forwardedTo: {
                'peer-b': { 'peer-c': 5, 'peer-d': 3 }
            }
        }),
        musicStats: () => ({
            seq: 7,
            streams: 1,
            forwardedTo: {}
        }),
        screenStats: () => ({
            own: { viewers: [{ peerId: 'peer-b', framesSent: 24 }] },
            watching: { peerId: 'peer-c', parentPeerId: 'peer-relay', frames: 19 },
            forwarding: [{ peerId: 'peer-d', framesSent: 15 }],
            fanoutEdges: [{ from: 'peer-c', to: 'peer-relay', frames: 19 }]
        }),
        activeTransfers: () => 2
    }

    const snap = traffic.snapshot(node)
    assert.equal(snap.self, 'peer-a')
    assert.equal(snap.activeTransfers, 2)

    const byKey = new Map(snap.edges.map(e => [`${e.kind}|${e.from}|${e.to}`, e.count]))
    assert.equal(byKey.get('voice|peer-a|peer-c'), 5)
    assert.equal(byKey.get('voice|peer-a|peer-d'), 3)
    assert.equal(byKey.get('voice|peer-b|peer-a'), 5)
    assert.equal(byKey.get('voice|peer-a|peer-h'), 12)

    assert.equal(byKey.get('music|peer-c|peer-a'), 1)
    assert.equal(byKey.get('music|peer-a|peer-h'), 7)

    assert.equal(byKey.get('screen|peer-a|peer-b'), 24)
    assert.equal(byKey.get('screen|peer-relay|peer-a'), 19)
    assert.equal(byKey.get('screen|peer-a|peer-d'), 15)
    assert.equal(byKey.get('screen|peer-c|peer-relay'), 19)

    assert.equal(byKey.get('transfer|peer-a|peer-d'), 4096)
    assert.equal(byKey.get('transfer|peer-e|peer-a'), 8192)

    traffic.recordFileEnd({ offerId: 'o1', peerId: 'peer-d', direction: 'send' })
    const snap2 = traffic.snapshot({ ...node, activeTransfers: () => 1 })
    const byKey2 = new Map(snap2.edges.map(e => [`${e.kind}|${e.from}|${e.to}`, e.count]))
    assert.equal(byKey2.has('transfer|peer-a|peer-d'), false)
    assert.equal(byKey2.get('transfer|peer-e|peer-a'), 8192)

    traffic.reset()
    const snap3 = traffic.snapshot({
        peerId: 'peer-a',
        host: () => null,
        voiceStats: () => null,
        musicStats: () => null,
        screenStats: () => null,
        activeTransfers: () => 0
    })
    assert.deepEqual(snap3.edges, [])
})

test('map-traffic tracks per-seeder swarm progress and swarmStatus upload/download edges', () => {
    const traffic = createMapTraffic()
    traffic.recordFileProgress({
        offerId: 'o-swarm',
        peerId: 'peer-b',
        direction: 'receive',
        bytes: 49152,
        swarmed: true,
        seederBytes: { 'peer-b': 32768, 'peer-c': 16384 }
    }, 'peer-a')

    const node = {
        peerId: 'peer-a',
        host: () => null,
        voiceStats: () => null,
        musicStats: () => null,
        screenStats: () => null,
        activeTransfers: () => 1,
        swarmStatus: () => [{
            sha256: 'a'.repeat(64),
            uploadedTo: { 'peer-d': 8192 },
            downloadedFrom: { 'peer-b': 65536, 'peer-c': 16384 }
        }]
    }

    const snap = traffic.snapshot(node)
    const byKey = new Map(snap.edges.map(e => [`${e.kind}|${e.from}|${e.to}`, e.count]))
    assert.equal(byKey.get('transfer|peer-b|peer-a'), 65536)
    assert.equal(byKey.get('transfer|peer-c|peer-a'), 16384)
    assert.equal(byKey.get('transfer|peer-a|peer-d'), 8192)

    traffic.recordFileEnd({ offerId: 'o-swarm', peerId: 'peer-b', direction: 'receive' })
    const snapDone = traffic.snapshot({
        ...node,
        activeTransfers: () => 0,
        swarmStatus: () => [{
            sha256: 'a'.repeat(64),
            uploadedTo: { 'peer-d': 8192 },
            downloadedFrom: {}
        }]
    })
    const byKeyDone = new Map(snapDone.edges.map(e => [`${e.kind}|${e.from}|${e.to}`, e.count]))
    assert.equal(byKeyDone.has('transfer|peer-b|peer-a'), false)
    assert.equal(byKeyDone.has('transfer|peer-c|peer-a'), false)
    assert.equal(byKeyDone.get('transfer|peer-a|peer-d'), 8192)
})
