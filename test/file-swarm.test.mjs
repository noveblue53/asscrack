import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import {
    SWARM_DEFAULTS,
    countPieces,
    createFileSwarm,
    decodeBitfield,
    encodeBitfield,
    hasPiece,
    hashPieces,
    pieceCount,
    pieceRange,
    setPiece,
    verifyPiece
} from '../src/network/file-swarm.mjs'

function makeFile(size, seed = 1) {
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) {
        data[i] = (i * 31 + seed * 17) & 0xff
    }
    const sha256 = createHash('sha256').update(data).digest('hex')
    return { data, sha256 }
}

function slicePiece(data, index, pieceSize) {
    const { start, end } = pieceRange(index, data.byteLength, pieceSize)
    return data.subarray(start, end)
}

test('SWARM_DEFAULTS exposes expected frozen limits', () => {
    assert.equal(Object.isFrozen(SWARM_DEFAULTS), true)
    assert.deepEqual(SWARM_DEFAULTS, {
        pieceSize: 262144,
        maxPieces: 65536,
        maxInFlightPerPeer: 4,
        requestTimeoutMs: 15000,
        defaultSeedCap: 4,
        maxSeedCap: 16,
        badPieceBanLimit: 2
    })
})

test('pieceCount, pieceRange, hashPieces, and verifyPiece', async () => {
    assert.equal(pieceCount(0, 64), 0)
    assert.equal(pieceCount(64, 64), 1)
    assert.equal(pieceCount(65, 64), 2)
    assert.throws(() => pieceCount(-1, 64), RangeError)
    assert.throws(() => pieceCount(64, 0), RangeError)

    assert.deepEqual(pieceRange(0, 150, 64), { start: 0, end: 64, length: 64 })
    assert.deepEqual(pieceRange(1, 150, 64), { start: 64, end: 128, length: 64 })
    assert.deepEqual(pieceRange(2, 150, 64), { start: 128, end: 150, length: 22 })
    assert.throws(() => pieceRange(3, 150, 64), RangeError)
    assert.throws(() => pieceRange(0, 0, 64), RangeError)

    const { data } = makeFile(150, 3)
    const bufferHashes = await hashPieces(data, 64)
    assert.equal(bufferHashes.length, 3)

    // Stream with uneven chunk boundaries must yield identical piece hashes
    const chunks = [data.subarray(0, 10), data.subarray(10, 70), data.subarray(70, 150)]
    const streamHashes = await hashPieces(Readable.from(chunks), 64)
    assert.deepEqual(streamHashes, bufferHashes)

    assert.deepEqual(await hashPieces(new Uint8Array(0), 64), [])

    assert.equal(verifyPiece(data.subarray(0, 64), bufferHashes[0]), true)
    assert.equal(verifyPiece(data.subarray(0, 63), bufferHashes[0]), false)
    assert.equal(verifyPiece(data.subarray(0, 64), 'not-a-sha256'), false)
})

test('bitfield helpers enforce strict bounds and spare-bit checks', () => {
    const bits = encodeBitfield([0, 2, 9], 10)
    assert.equal(bits.length, 2)
    assert.equal(hasPiece(bits, 0), true)
    assert.equal(hasPiece(bits, 1), false)
    assert.equal(hasPiece(bits, 2), true)
    assert.equal(hasPiece(bits, 9), true)
    assert.equal(countPieces(bits, 10), 3)
    assert.deepEqual(decodeBitfield(bits, 10), new Set([0, 2, 9]))

    setPiece(bits, 5)
    assert.equal(hasPiece(bits, 5), true)
    assert.equal(countPieces(bits, 10), 4)

    // Out-of-bounds indices
    assert.throws(() => encodeBitfield([10], 10), RangeError)
    assert.throws(() => encodeBitfield([-1], 10), RangeError)
    assert.throws(() => hasPiece(bits, 16), RangeError)
    assert.throws(() => setPiece(bits, 16), RangeError)

    // Wrong byte length
    assert.throws(() => decodeBitfield(new Uint8Array(1), 10), RangeError)
    assert.throws(() => countPieces(new Uint8Array(3), 10), RangeError)

    // Non-zero spare bits in trailing byte (bits 10..15 for count=10)
    const dirty = new Uint8Array([0x00, 0x01])
    assert.throws(() => decodeBitfield(dirty, 10), RangeError)
    assert.throws(() => countPieces(dirty, 10), RangeError)
})

test('rarest-first selection orders by peer availability and respects maxInFlightPerPeer', async () => {
    const pieceSize = 64
    const { data, sha256 } = makeFile(pieceSize * 6, 7)
    const pieceHashes = await hashPieces(data, pieceSize)
    const swarm = createFileSwarm({ sha256, size: data.byteLength, pieceSize, pieceHashes, selfPeerId: 'self' })

    // Piece availability:
    // 0: 3 peers (p1, p2, p3)
    // 1: 2 peers (p1, p2)
    // 2: 3 peers (p1, p2, p3)
    // 3: 1 peer  (p1)  <- rarest!
    // 4: 2 peers (p1, p3)
    // 5: 3 peers (p1, p2, p3)
    swarm.setPeerHave('p1', [0, 1, 2, 3, 4, 5])
    swarm.setPeerHave('p2', [0, 1, 2, 5])
    swarm.setPeerHave('p3', [0, 2, 4, 5])

    const reqs1 = swarm.nextRequests('p1')
    assert.equal(reqs1.length, SWARM_DEFAULTS.maxInFlightPerPeer)
    assert.equal(reqs1[0], 3) // availability 1
    assert.deepEqual(reqs1.slice(1, 3), [1, 4]) // availability 2, tie-broken by index
    assert.equal(reqs1[3], 0) // availability 3, lowest index

    // Already at maxInFlightPerPeer for p1
    assert.deepEqual(swarm.nextRequests('p1'), [])

    // p2 should only get pieces not already in-flight to p1 (pieces 2 and 5)
    const reqs2 = swarm.nextRequests('p2')
    assert.deepEqual(reqs2, [2, 5])
})

test('bad-piece ban after badPieceBanLimit hash mismatches', async () => {
    const pieceSize = 64
    const { data, sha256 } = makeFile(pieceSize * 3, 11)
    const pieceHashes = await hashPieces(data, pieceSize)
    const swarm = createFileSwarm({ sha256, size: data.byteLength, pieceSize, pieceHashes, selfPeerId: 'self' })

    swarm.setPeerHave('bad-peer', [0, 1, 2])
    swarm.setPeerHave('good-peer', [0, 1, 2])
    assert.equal(swarm.reserveSeed('bad-peer'), true)

    const reqs = swarm.nextRequests('bad-peer', 2)
    assert.deepEqual(reqs, [0, 1])

    const corrupt = new Uint8Array(64).fill(0xff)
    const first = swarm.markReceived('bad-peer', 0, corrupt)
    assert.deepEqual(first, { ok: false, index: 0, reason: 'hash-mismatch', badPieces: 1, banned: false })
    assert.equal(swarm.canServe('bad-peer'), true)

    const second = swarm.markReceived('bad-peer', 1, corrupt)
    assert.deepEqual(second, { ok: false, index: 1, reason: 'hash-mismatch', badPieces: 2, banned: true })

    // Banned peer is blocked from requests, seeding, and receiving, and its availability is excluded
    assert.deepEqual(swarm.nextRequests('bad-peer'), [])
    assert.equal(swarm.canServe('bad-peer'), false)
    assert.equal(swarm.markReceived('bad-peer', 2, slicePiece(data, 2, pieceSize)).banned, true)
    assert.deepEqual(swarm.progress().availability, [1, 1, 1])

    // Good peer can now request pieces 0 and 1
    assert.deepEqual(swarm.nextRequests('good-peer', 2), [0, 1])
})

test('multi-peer swarm completes after the first sender leaves', async () => {
    const pieceSize = 64
    const { data, sha256 } = makeFile(pieceSize * 4, 19)
    const pieceHashes = await hashPieces(data, pieceSize)

    const sender = createFileSwarm({
        sha256,
        size: data.byteLength,
        pieceSize,
        pieceHashes,
        selfPeerId: 'sender',
        have: [0, 1, 2, 3]
    })
    const peerB = createFileSwarm({ sha256, size: data.byteLength, pieceSize, pieceHashes, selfPeerId: 'peerB' })
    const peerC = createFileSwarm({ sha256, size: data.byteLength, pieceSize, pieceHashes, selfPeerId: 'peerC' })

    // Sender gives pieces [0, 1] to peerB and [2, 3] to peerC
    peerB.setPeerHave('sender', sender.haveBitfield())
    peerC.setPeerHave('sender', sender.haveBitfield())

    for (const idx of peerB.nextRequests('sender', 2)) {
        assert.equal(sender.reserveSeed('peerB'), true)
        const res = peerB.markReceived('sender', idx, slicePiece(data, idx, pieceSize))
        assert.equal(res.ok, true)
        sender.releaseSeed('peerB')
    }

    // PeerC requests from sender while pieces 0, 1 are not in-flight on peerC; give it 2 and 3
    peerC.markReceived('sender', 2, slicePiece(data, 2, pieceSize))
    peerC.markReceived('sender', 3, slicePiece(data, 3, pieceSize))

    // First sender leaves both leechers
    peerB.removePeer('sender')
    peerC.removePeer('sender')
    assert.equal(peerB.complete(), false)
    assert.equal(peerC.complete(), false)

    // PeerB and PeerC exchange their disjoint pieces to complete the file
    peerB.setPeerHave('peerC', peerC.haveBitfield())
    peerC.setPeerHave('peerB', peerB.haveBitfield())

    for (const idx of peerB.nextRequests('peerC')) {
        assert.equal(peerC.canServe('peerB'), true)
        assert.equal(peerB.markReceived('peerC', idx, slicePiece(data, idx, pieceSize)).ok, true)
    }
    for (const idx of peerC.nextRequests('peerB')) {
        assert.equal(peerB.canServe('peerC'), true)
        assert.equal(peerC.markReceived('peerB', idx, slicePiece(data, idx, pieceSize)).ok, true)
    }

    assert.equal(peerB.complete(), true)
    assert.equal(peerC.complete(), true)
    assert.equal(peerB.progress().haveCount, 4)
    assert.equal(peerC.progress().haveCount, 4)
})

test('seed caps, releaseSeed, and seeding opt-out', async () => {
    const pieceSize = 64
    const { data, sha256 } = makeFile(pieceSize, 23)
    const pieceHashes = await hashPieces(data, pieceSize)
    const swarm = createFileSwarm({
        sha256,
        size: data.byteLength,
        pieceSize,
        pieceHashes,
        selfPeerId: 'self',
        have: [0]
    })

    for (let i = 1; i <= SWARM_DEFAULTS.defaultSeedCap; i++) {
        assert.equal(swarm.canServe(`p${i}`), true)
        assert.equal(swarm.reserveSeed(`p${i}`), true)
    }
    assert.equal(swarm.canServe('p5'), false)
    assert.equal(swarm.reserveSeed('p5'), false)

    // Releasing one slot allows p5
    assert.equal(swarm.releaseSeed('p1'), true)
    assert.equal(swarm.canServe('p5'), true)
    assert.equal(swarm.reserveSeed('p5'), true)

    // Raising cap allows more, clamped at maxSeedCap
    swarm.setSeedCap(100)
    assert.equal(swarm.progress().seedCap, SWARM_DEFAULTS.maxSeedCap)
    assert.equal(swarm.canServe('p6'), true)

    // Opt-out disables seeding and clears active slots
    swarm.setSeedingEnabled(false)
    assert.equal(swarm.canServe('p2'), false)
    assert.equal(swarm.reserveSeed('p6'), false)
    assert.equal(swarm.progress().activeSeeds, 0)

    swarm.setSeedingEnabled(true)
    assert.equal(swarm.canServe('p6'), true)
})

test('timeout expiration reassigns stalled in-flight pieces', async () => {
    let clock = 1000
    const pieceSize = 64
    const { data, sha256 } = makeFile(pieceSize * 2, 29)
    const pieceHashes = await hashPieces(data, pieceSize)
    const swarm = createFileSwarm({
        sha256,
        size: data.byteLength,
        pieceSize,
        pieceHashes,
        selfPeerId: 'self',
        now: () => clock
    })

    swarm.setPeerHave('slow-peer', [0, 1])
    swarm.setPeerHave('fast-peer', [0, 1])

    assert.deepEqual(swarm.nextRequests('slow-peer', 2), [0, 1])
    assert.deepEqual(swarm.nextRequests('fast-peer', 2), [])

    // Just before timeout
    clock += SWARM_DEFAULTS.requestTimeoutMs - 1
    assert.deepEqual(swarm.expireTimeouts(), [])
    assert.deepEqual(swarm.nextRequests('fast-peer', 2), [])

    // At timeout boundary
    clock += 1
    const expired = swarm.expireTimeouts()
    assert.equal(expired.length, 2)
    assert.deepEqual(swarm.nextRequests('fast-peer', 2), [0, 1])

    // Fast peer delivers both
    assert.equal(swarm.markReceived('fast-peer', 0, slicePiece(data, 0, pieceSize)).ok, true)
    assert.equal(swarm.markReceived('fast-peer', 1, slicePiece(data, 1, pieceSize)).ok, true)
    assert.equal(swarm.complete(), true)
})

test('empty file swarm is immediately complete', () => {
    const emptySha = createHash('sha256').update(new Uint8Array(0)).digest('hex')
    const swarm = createFileSwarm({ sha256: emptySha, size: 0, pieceHashes: [] })
    assert.equal(swarm.complete(), true)
    assert.deepEqual(swarm.progress().availability, [])
    assert.equal(swarm.progress().totalPieces, 0)
})

test('releaseRequest frees in-flight piece immediately without penalizing peer', async () => {
    const pieceSize = 64
    const { data, sha256 } = makeFile(pieceSize * 2, 31)
    const pieceHashes = await hashPieces(data, pieceSize)
    const swarm = createFileSwarm({ sha256, size: data.byteLength, pieceSize, pieceHashes, selfPeerId: 'self' })

    swarm.setPeerHave('p1', [0, 1])
    swarm.setPeerHave('p2', [0, 1])

    assert.deepEqual(swarm.nextRequests('p1', 1), [0])
    assert.deepEqual(swarm.nextRequests('p2', 1), [1])
    assert.equal(swarm.releaseRequest('p1', 0), true)
    assert.equal(swarm.releaseRequest('p1', 0), false)
    assert.deepEqual(swarm.nextRequests('p2', 1), [0])
    assert.equal(swarm.progress().peers.find(p => p.peerId === 'p1').badPieces, 0)
})
