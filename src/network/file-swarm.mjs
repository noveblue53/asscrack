import { createHash } from 'node:crypto'

const SHA_RE = /^[0-9a-f]{64}$/

export const SWARM_DEFAULTS = Object.freeze({
    pieceSize: 262144,
    maxPieces: 65536,
    maxInFlightPerPeer: 4,
    requestTimeoutMs: 15000,
    defaultSeedCap: 4,
    maxSeedCap: 16,
    badPieceBanLimit: 2
})

function assertSafeNonNegInt(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`)
    }
}

function assertSafePosInt(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`)
    }
}

function assertPieceCount(count) {
    assertSafeNonNegInt(count, 'count')
    if (count > SWARM_DEFAULTS.maxPieces) {
        throw new RangeError(`count exceeds maxPieces (${SWARM_DEFAULTS.maxPieces})`)
    }
}

function toBytes(data) {
    if (data instanceof Uint8Array) return data
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    throw new TypeError('data must be a Uint8Array or ArrayBuffer')
}

function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex')
}

export function pieceCount(size, pieceSize = SWARM_DEFAULTS.pieceSize) {
    assertSafeNonNegInt(size, 'size')
    assertSafePosInt(pieceSize, 'pieceSize')
    return size === 0 ? 0 : Math.floor((size - 1) / pieceSize) + 1
}

export function pieceRange(index, size, pieceSize = SWARM_DEFAULTS.pieceSize) {
    const count = pieceCount(size, pieceSize)
    assertSafeNonNegInt(index, 'index')
    if (index >= count) {
        throw new RangeError(`piece index ${index} out of bounds (count=${count})`)
    }
    const start = index * pieceSize
    const end = Math.min(size, start + pieceSize)
    return { start, end, length: end - start }
}

export async function hashPieces(bufferOrStream, pieceSize = SWARM_DEFAULTS.pieceSize) {
    assertSafePosInt(pieceSize, 'pieceSize')
    if (bufferOrStream instanceof Uint8Array || bufferOrStream instanceof ArrayBuffer) {
        const bytes = toBytes(bufferOrStream)
        const hashes = []
        for (let offset = 0; offset < bytes.byteLength; offset += pieceSize) {
            hashes.push(sha256Hex(bytes.subarray(offset, offset + pieceSize)))
        }
        return hashes
    }
    if (!bufferOrStream || typeof bufferOrStream[Symbol.asyncIterator] !== 'function') {
        throw new TypeError('bufferOrStream must be a Uint8Array, ArrayBuffer, or AsyncIterable')
    }
    const hashes = []
    let pending = []
    let pendingBytes = 0
    for await (const rawChunk of bufferOrStream) {
        const chunk = toBytes(rawChunk)
        if (chunk.byteLength === 0) continue
        pending.push(chunk)
        pendingBytes += chunk.byteLength
        if (pendingBytes >= pieceSize) {
            const combined = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)
            let offset = 0
            while (combined.byteLength - offset >= pieceSize) {
                hashes.push(sha256Hex(combined.subarray(offset, offset + pieceSize)))
                offset += pieceSize
            }
            const rest = combined.subarray(offset)
            pending = rest.byteLength > 0 ? [rest] : []
            pendingBytes = rest.byteLength
        }
    }
    if (pendingBytes > 0) {
        const tail = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)
        hashes.push(sha256Hex(tail))
    }
    return hashes
}

export function verifyPiece(data, expectedSha256) {
    if (typeof expectedSha256 !== 'string' || !SHA_RE.test(expectedSha256)) return false
    const bytes = toBytes(data)
    return sha256Hex(bytes) === expectedSha256
}

function validateBitfieldBytes(bitfield, count) {
    assertPieceCount(count)
    if (!(bitfield instanceof Uint8Array)) {
        throw new TypeError('bitfield must be a Uint8Array')
    }
    const expectedLen = Math.ceil(count / 8)
    if (bitfield.length !== expectedLen) {
        throw new RangeError(`bitfield length ${bitfield.length} does not match expected ${expectedLen}`)
    }
    const rem = count % 8
    if (rem !== 0 && expectedLen > 0) {
        const spareMask = (0xff >> rem) & 0xff
        if ((bitfield[expectedLen - 1] & spareMask) !== 0) {
            throw new RangeError('bitfield has non-zero spare bits')
        }
    }
}

export function hasPiece(bitfield, index) {
    if (!(bitfield instanceof Uint8Array)) {
        throw new TypeError('bitfield must be a Uint8Array')
    }
    assertSafeNonNegInt(index, 'index')
    const byteIndex = index >> 3
    if (byteIndex >= bitfield.length) {
        throw new RangeError(`piece index ${index} out of bounds for bitfield of ${bitfield.length} bytes`)
    }
    return (bitfield[byteIndex] & (0x80 >> (index & 7))) !== 0
}

export function setPiece(bitfield, index) {
    if (!(bitfield instanceof Uint8Array)) {
        throw new TypeError('bitfield must be a Uint8Array')
    }
    assertSafeNonNegInt(index, 'index')
    const byteIndex = index >> 3
    if (byteIndex >= bitfield.length) {
        throw new RangeError(`piece index ${index} out of bounds for bitfield of ${bitfield.length} bytes`)
    }
    bitfield[byteIndex] |= 0x80 >> (index & 7)
    return bitfield
}

export function encodeBitfield(haveSet, count) {
    assertPieceCount(count)
    const bytes = new Uint8Array(Math.ceil(count / 8))
    if (!haveSet || typeof haveSet[Symbol.iterator] !== 'function') {
        throw new TypeError('haveSet must be an iterable of piece indices')
    }
    for (const index of haveSet) {
        assertSafeNonNegInt(index, 'index')
        if (index >= count) {
            throw new RangeError(`piece index ${index} out of bounds (count=${count})`)
        }
        bytes[index >> 3] |= 0x80 >> (index & 7)
    }
    return bytes
}

export function decodeBitfield(bytes, count) {
    validateBitfieldBytes(bytes, count)
    const have = new Set()
    for (let i = 0; i < count; i++) {
        if ((bytes[i >> 3] & (0x80 >> (i & 7))) !== 0) {
            have.add(i)
        }
    }
    return have
}

export function countPieces(bitfield, count) {
    validateBitfieldBytes(bitfield, count)
    let total = 0
    for (let i = 0; i < count; i++) {
        if ((bitfield[i >> 3] & (0x80 >> (i & 7))) !== 0) {
            total++
        }
    }
    return total
}

export function createFileSwarm({
    sha256,
    size,
    pieceSize = SWARM_DEFAULTS.pieceSize,
    pieceHashes,
    selfPeerId = null,
    now = Date.now,
    seedCap = SWARM_DEFAULTS.defaultSeedCap,
    seedingEnabled = true,
    have = null
} = {}) {
    if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) {
        throw new TypeError('sha256 must be a 64-character lowercase hex string')
    }
    if (typeof now !== 'function') {
        throw new TypeError('now must be a function')
    }
    const totalPieces = pieceCount(size, pieceSize)
    if (totalPieces > SWARM_DEFAULTS.maxPieces) {
        throw new RangeError(`totalPieces ${totalPieces} exceeds maxPieces (${SWARM_DEFAULTS.maxPieces})`)
    }
    if (!Array.isArray(pieceHashes) || pieceHashes.length !== totalPieces) {
        throw new RangeError(`pieceHashes must be an array of length ${totalPieces}`)
    }
    for (let i = 0; i < totalPieces; i++) {
        if (typeof pieceHashes[i] !== 'string' || !SHA_RE.test(pieceHashes[i])) {
            throw new TypeError(`pieceHashes[${i}] must be a 64-character lowercase hex string`)
        }
    }
    assertSafeNonNegInt(seedCap, 'seedCap')

    const bitfieldBytes = Math.ceil(totalPieces / 8)
    let localBitfield = new Uint8Array(bitfieldBytes)
    if (have instanceof Uint8Array) {
        validateBitfieldBytes(have, totalPieces)
        localBitfield = new Uint8Array(have)
    } else if (have !== null) {
        localBitfield = encodeBitfield(have, totalPieces)
    }
    let haveCount = countPieces(localBitfield, totalPieces)

    let currentSeedCap = Math.min(seedCap, SWARM_DEFAULTS.maxSeedCap)
    let currentSeedingEnabled = Boolean(seedingEnabled)

    // peerId -> { bitfield: Uint8Array, inFlight: Map<number, number>, badPieces: number, banned: boolean }
    const peers = new Map()
    // pieceIndex -> { peerId: string, requestedAt: number }
    const inFlightPieces = new Map()
    // peerId -> active upload slot
    const activeSeeds = new Set()

    function validRemotePeerId(peerId) {
        return typeof peerId === 'string' && peerId.length > 0 && peerId !== selfPeerId
    }

    function ensurePeer(peerId) {
        let peer = peers.get(peerId)
        if (!peer) {
            peer = {
                bitfield: new Uint8Array(bitfieldBytes),
                inFlight: new Map(),
                badPieces: 0,
                banned: false
            }
            peers.set(peerId, peer)
        }
        return peer
    }

    function clearPeerInFlight(peerId, peer) {
        for (const index of peer.inFlight.keys()) {
            const entry = inFlightPieces.get(index)
            if (entry && entry.peerId === peerId) {
                inFlightPieces.delete(index)
            }
        }
        peer.inFlight.clear()
    }

    function computeAvailability() {
        const availability = new Array(totalPieces).fill(0)
        for (const peer of peers.values()) {
            if (peer.banned) continue
            for (let i = 0; i < totalPieces; i++) {
                if ((peer.bitfield[i >> 3] & (0x80 >> (i & 7))) !== 0) {
                    availability[i]++
                }
            }
        }
        return availability
    }

    function setPeerHave(peerId, bitfieldOrSet) {
        if (!validRemotePeerId(peerId)) return false
        const peer = ensurePeer(peerId)
        if (peer.banned) return false
        if (bitfieldOrSet instanceof Uint8Array) {
            validateBitfieldBytes(bitfieldOrSet, totalPieces)
            peer.bitfield = new Uint8Array(bitfieldOrSet)
        } else {
            peer.bitfield = encodeBitfield(bitfieldOrSet, totalPieces)
        }
        return true
    }

    function addPeerPiece(peerId, index) {
        if (!validRemotePeerId(peerId)) return false
        assertSafeNonNegInt(index, 'index')
        if (index >= totalPieces) {
            throw new RangeError(`piece index ${index} out of bounds (totalPieces=${totalPieces})`)
        }
        const peer = ensurePeer(peerId)
        if (peer.banned) return false
        setPiece(peer.bitfield, index)
        return true
    }

    function removePeer(peerId) {
        const peer = peers.get(peerId)
        if (!peer) return false
        clearPeerInFlight(peerId, peer)
        activeSeeds.delete(peerId)
        peers.delete(peerId)
        return true
    }

    function nextRequests(peerId, maxCount = SWARM_DEFAULTS.maxInFlightPerPeer) {
        if (haveCount === totalPieces) return []
        const peer = peers.get(peerId)
        if (!peer || peer.banned) return []
        assertSafeNonNegInt(maxCount, 'maxCount')
        const room = Math.min(maxCount, SWARM_DEFAULTS.maxInFlightPerPeer - peer.inFlight.size)
        if (room <= 0) return []

        const availability = computeAvailability()
        const candidates = []
        for (let i = 0; i < totalPieces; i++) {
            if ((localBitfield[i >> 3] & (0x80 >> (i & 7))) !== 0) continue
            if (inFlightPieces.has(i)) continue
            if ((peer.bitfield[i >> 3] & (0x80 >> (i & 7))) === 0) continue
            candidates.push(i)
        }
        candidates.sort((a, b) => (availability[a] - availability[b]) || (a - b))

        const picked = candidates.slice(0, room)
        const timestamp = now()
        for (const index of picked) {
            peer.inFlight.set(index, timestamp)
            inFlightPieces.set(index, { peerId, requestedAt: timestamp })
        }
        return picked
    }

    function markReceived(peerId, index, data) {
        assertSafeNonNegInt(index, 'index')
        if (index >= totalPieces) {
            throw new RangeError(`piece index ${index} out of bounds (totalPieces=${totalPieces})`)
        }
        const peer = peers.get(peerId)
        if (peer) {
            peer.inFlight.delete(index)
        }
        const inFlight = inFlightPieces.get(index)
        if (inFlight && inFlight.peerId === peerId) {
            inFlightPieces.delete(index)
        }

        if (peer && peer.banned) {
            return { ok: false, index, reason: 'banned', banned: true }
        }
        if ((localBitfield[index >> 3] & (0x80 >> (index & 7))) !== 0) {
            return { ok: true, index, duplicate: true, complete: haveCount === totalPieces }
        }

        const expected = pieceRange(index, size, pieceSize)
        const bytes = toBytes(data)
        const valid = bytes.byteLength === expected.length && verifyPiece(bytes, pieceHashes[index])
        if (!valid) {
            const target = validRemotePeerId(peerId) ? ensurePeer(peerId) : null
            if (target) {
                target.badPieces++
                if (target.badPieces >= SWARM_DEFAULTS.badPieceBanLimit) {
                    target.banned = true
                    clearPeerInFlight(peerId, target)
                    activeSeeds.delete(peerId)
                }
                return {
                    ok: false,
                    index,
                    reason: 'hash-mismatch',
                    badPieces: target.badPieces,
                    banned: target.banned
                }
            }
            return { ok: false, index, reason: 'hash-mismatch', badPieces: 0, banned: false }
        }

        setPiece(localBitfield, index)
        haveCount++
        inFlightPieces.delete(index)
        for (const other of peers.values()) {
            other.inFlight.delete(index)
        }
        return { ok: true, index, complete: haveCount === totalPieces }
    }

    function expireTimeouts() {
        const currentTime = now()
        const expired = []
        for (const [index, entry] of [...inFlightPieces.entries()]) {
            if (currentTime - entry.requestedAt >= SWARM_DEFAULTS.requestTimeoutMs) {
                inFlightPieces.delete(index)
                const peer = peers.get(entry.peerId)
                if (peer) peer.inFlight.delete(index)
                expired.push({ index, peerId: entry.peerId })
            }
        }
        return expired
    }

    function canServe(peerId) {
        if (!currentSeedingEnabled) return false
        if (!validRemotePeerId(peerId)) return false
        const peer = peers.get(peerId)
        if (peer && peer.banned) return false
        if (activeSeeds.has(peerId)) return true
        return activeSeeds.size < currentSeedCap
    }

    function reserveSeed(peerId) {
        if (!canServe(peerId)) return false
        activeSeeds.add(peerId)
        return true
    }

    function releaseSeed(peerId) {
        return activeSeeds.delete(peerId)
    }

    function setSeedingEnabled(enabled) {
        currentSeedingEnabled = Boolean(enabled)
        if (!currentSeedingEnabled) {
            activeSeeds.clear()
        }
    }

    function setSeedCap(cap) {
        assertSafeNonNegInt(cap, 'cap')
        currentSeedCap = Math.min(cap, SWARM_DEFAULTS.maxSeedCap)
    }

    function complete() {
        return haveCount === totalPieces
    }

    function haveBitfield() {
        return new Uint8Array(localBitfield)
    }

    function has(index) {
        assertSafeNonNegInt(index, 'index')
        if (index >= totalPieces) return false
        return hasPiece(localBitfield, index)
    }

    function progress() {
        const peerList = []
        for (const [peerId, peer] of peers) {
            peerList.push({
                peerId,
                haveCount: countPieces(peer.bitfield, totalPieces),
                inFlight: peer.inFlight.size,
                badPieces: peer.badPieces,
                banned: peer.banned,
                seeding: activeSeeds.has(peerId)
            })
        }
        return {
            haveCount,
            totalPieces,
            complete: haveCount === totalPieces,
            peers: peerList,
            availability: computeAvailability(),
            seedingEnabled: currentSeedingEnabled,
            seedCap: currentSeedCap,
            activeSeeds: activeSeeds.size
        }
    }

    return {
        sha256,
        size,
        pieceSize,
        totalPieces,
        setPeerHave,
        addPeerPiece,
        removePeer,
        nextRequests,
        markReceived,
        expireTimeouts,
        canServe,
        reserveSeed,
        releaseSeed,
        setSeedingEnabled,
        setSeedCap,
        complete,
        haveBitfield,
        has,
        progress
    }
}
