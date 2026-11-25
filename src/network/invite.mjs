// Invite codes of an internet room.
// "asscrack1:" + base64url(JSON { v: 1, room, key, nodes }): legacy shared-code rooms.
// "asscrack2:" + base64url(JSON { v: 2, room, key, nodes, membership }): protected rooms (read only).
// "asscrack3:" + base64url(binary): protected rooms, the same contents as "asscrack2:" (see packCompact).
import { createHash, randomBytes } from 'node:crypto'
import { multiaddr } from '@multiformats/multiaddr'
import { fromString } from 'uint8arrays/from-string'
import { toString } from 'uint8arrays/to-string'
import { INVITE_EXPIRED, inspectMembershipDescriptor, roomCodeAccess } from './room-membership.mjs'

export const INVITE_PREFIX = 'asscrack1:'
export const PROTECTED_INVITE_PREFIX = 'asscrack2:'
export const COMPACT_INVITE_PREFIX = 'asscrack3:'
const MAX_NODES = 16
const MAX_REVOCATIONS = 128
// L4 (P10a): version 4 adds the expiry time of the grant. A version 3 code (no expiry) gives "unknown version".
const COMPACT_VERSION = 4
// The member refuses an invite that expired more than this time ago (the clocks of two PCs can differ). The owner
// checks the expiry time exactly at the first admission.
const EXPIRY_GRACE_MS = 60 * 60 * 1000
const MEMBERSHIP_VERSION = 2
const FLAG_LAN = 1
const FLAG_CAN_HOST = 2
const ADDR_IP4_TCP = 4
const ADDR_BINARY = 0
const CHECKSUM_BYTES = 4

export function newRoomKey() {
    return randomBytes(32).toString('base64url')
}

export function makeInvite({ room, key, nodes, ipv6 }) {
    const k = typeof key === 'string' ? key : Buffer.from(key).toString('base64url')
    const list = nodes.map(n => ({ id: n.id, addrs: [...n.addrs] }))
    const payload = { v: 1, room, key: k, nodes: list }
    if (Array.isArray(ipv6) && ipv6.length > 0) payload.ipv6 = ipv6.map(n => ({ id: n.id, addrs: [...n.addrs] }))
    return INVITE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

// A protected room invite in the compact binary form "asscrack3:".
export function makeMemberInvite({ room, key, nodes, membership }) {
    const k = typeof key === 'string' ? key : Buffer.from(key).toString('base64url')
    return COMPACT_INVITE_PREFIX + packCompact({ room, key: k, nodes, membership }).toString('base64url')
}

function checksum(body) {
    return createHash('sha256').update(body).digest().subarray(0, CHECKSUM_BYTES)
}

// base64url text to bytes. The text must be canonical, because each signature covers the exact text.
function rawBytes(value, size, what) {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'base64url') : null
    if (!bytes || bytes.length !== size || bytes.toString('base64url') !== value) throw new Error(`The invite has a bad ${what}`)
    return bytes
}

const IP4_TCP = /^\/ip4\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/tcp\/(\d{1,5})$/

function packAddr(addr) {
    const m = IP4_TCP.exec(addr)
    if (m) {
        const parts = m.slice(1, 5).map(Number)
        const port = Number(m[5])
        // Use the 6-byte form only if the decode gives the same text.
        if (parts.every(p => p <= 255) && port <= 65535 && `/ip4/${parts.join('.')}/tcp/${port}` === addr) {
            const out = Buffer.alloc(7)
            out[0] = ADDR_IP4_TCP
            parts.forEach((p, i) => { out[1 + i] = p })
            out.writeUInt16BE(port, 5)
            return out
        }
    }
    if (!validAddr(addr)) throw new Error('The invite has a bad address')
    const bytes = Buffer.from(multiaddr(addr).bytes)
    if (bytes.length > 0xffff) throw new Error('The invite has a bad address')
    const head = Buffer.alloc(3)
    head[0] = ADDR_BINARY
    head.writeUInt16BE(bytes.length, 1)
    return Buffer.concat([head, bytes])
}

// Layout (all numbers are unsigned, big-endian):
//   version (1) = 3, flags (1): bit 0 lan, bit 1 canHost, room length (1), room (UTF-8),
//   room key (32), owner (32), grant device ID (32), grant expiry time (6, ms since 1970), grant signature (64),
//   revocation count (1), revoked device IDs (32 each), revocation signature (64),
//   node count (1), for each node: peer ID length (1), peer ID (multihash),
//     address count (1), for each address: type (1) then 4 + 2 bytes (ip4/tcp) or length (2) + multiaddr bytes,
//   checksum (4): the first 4 bytes of SHA-256 of all bytes before it.
// The descriptor fields v (2) and admission (null) are fixed for an invite. The revocation sequence is the count.
function packCompact({ room, key, nodes, membership }) {
    if (typeof room !== 'string' || room.length < 1 || room.length > 64) throw new Error('The invite has a bad room name')
    const roomBytes = Buffer.from(room, 'utf8')
    if (roomBytes.toString('utf8') !== room || roomBytes.length > 255) throw new Error('The invite has a bad room name')
    const d = membership
    if (!d || d.v !== MEMBERSHIP_VERSION || d.admission !== null || typeof d.lan !== 'boolean' ||
        !d.grant || typeof d.grant.canHost !== 'boolean' || !d.revocations ||
        !Number.isSafeInteger(d.grant.expires) || d.grant.expires < 1 || d.grant.expires >= 2 ** 48) throw new Error('The invite has a bad membership')
    const expires = Buffer.alloc(6)
    expires.writeUIntBE(d.grant.expires, 0, 6)
    const devices = d.revocations.devices
    if (!Array.isArray(devices) || devices.length > MAX_REVOCATIONS || d.revocations.sequence !== devices.length) {
        throw new Error('The invite has a bad membership')
    }
    const parts = [
        Buffer.from([COMPACT_VERSION, (d.lan ? FLAG_LAN : 0) | (d.grant.canHost ? FLAG_CAN_HOST : 0), roomBytes.length]),
        roomBytes,
        rawBytes(key, 32, 'room key'),
        rawBytes(d.owner, 32, 'owner'),
        rawBytes(d.grant.deviceId, 32, 'device ID'),
        expires,
        rawBytes(d.grant.signature, 64, 'signature'),
        Buffer.from([devices.length]),
        ...devices.map(id => rawBytes(id, 32, 'device ID')),
        rawBytes(d.revocations.signature, 64, 'signature'),
        ...packNodes(nodes)
    ]
    const body = Buffer.concat(parts)
    return Buffer.concat([body, checksum(body)])
}

function packPeerId(value) {
    if (!validPeerId(value)) throw new Error('The invite has a bad peer ID')
    const id = Buffer.from(fromString(value, 'base58btc'))
    if (toString(id, 'base58btc') !== value || id.length > 255) throw new Error('The invite has a bad peer ID')
    return [Buffer.from([id.length]), id]
}

// node count (1), for each node: peer ID length (1), peer ID, address count (1), the addresses (packAddr).
function packNodes(nodes) {
    if (!Array.isArray(nodes) || nodes.length > MAX_NODES) throw new Error('The invite has a bad node list')
    const parts = [Buffer.from([nodes.length])]
    for (const n of nodes) {
        if (!n) throw new Error('The invite has a bad peer ID')
        const id = packPeerId(n.id)
        if (!Array.isArray(n.addrs) || n.addrs.length < 1 || n.addrs.length > MAX_NODES) throw new Error('The invite has a bad address')
        parts.push(...id, Buffer.from([n.addrs.length]), ...n.addrs.map(packAddr))
    }
    return parts
}

function compactError(cause) {
    return new Error(`The invite code is damaged (${cause})`)
}

// Bytes to the same { room, key, nodes, membership } value as an "asscrack2:" code. readInvite checks the value.
function unpackCompact(data) {
    if (data.length < 1 + CHECKSUM_BYTES) throw compactError('too short')
    const body = data.subarray(0, data.length - CHECKSUM_BYTES)
    if (!checksum(body).equals(data.subarray(body.length))) throw compactError('wrong checksum')
    let at = 0
    const take = size => {
        if (at + size > body.length) throw compactError('too short')
        const out = body.subarray(at, at + size)
        at += size
        return out
    }
    const byte = () => take(1)[0]
    const b64 = size => take(size).toString('base64url')
    if (byte() !== COMPACT_VERSION) throw new Error('The invite code has an unknown version')
    const flags = byte()
    if (flags & ~(FLAG_LAN | FLAG_CAN_HOST)) throw compactError('unknown flags')
    let room
    try {
        room = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(take(byte()))
    } catch (err) {
        if (err.message?.startsWith('The invite code')) throw err
        throw new Error('The invite code has a bad room name')
    }
    const key = b64(32)
    const owner = b64(32)
    const deviceId = b64(32)
    const expires = take(6).readUIntBE(0, 6)
    const grant = { deviceId, canHost: (flags & FLAG_CAN_HOST) !== 0, expires, signature: b64(64) }
    const count = byte()
    const devices = []
    for (let i = 0; i < count; i++) devices.push(b64(32))
    const revocations = { sequence: count, devices, signature: b64(64) }
    const nodes = unpackNodes(take, byte)
    if (at !== body.length) throw compactError('data after the last field')
    const membership = { v: MEMBERSHIP_VERSION, owner, lan: (flags & FLAG_LAN) !== 0, grant, admission: null, revocations }
    return { room, key, nodes, membership }
}

function unpackNodes(take, byte) {
    const nodes = []
    const nodeCount = byte()
    for (let i = 0; i < nodeCount; i++) {
        const id = toString(take(byte()), 'base58btc')
        const addrs = []
        const addrCount = byte()
        for (let j = 0; j < addrCount; j++) {
            const type = byte()
            if (type === ADDR_IP4_TCP) {
                const b = take(6)
                addrs.push(`/ip4/${b[0]}.${b[1]}.${b[2]}.${b[3]}/tcp/${b.readUInt16BE(4)}`)
            } else if (type === ADDR_BINARY) {
                const bytes = take(take(2).readUInt16BE(0))
                try {
                    addrs.push(multiaddr(new Uint8Array(bytes)).toString())
                } catch {
                    throw new Error('The invite code has a bad address')
                }
            } else throw compactError('unknown address type')
        }
        nodes.push({ id, addrs })
    }
    return nodes
}

// easy-join part 2: the room code. The prefix and the checksum are the same as a device invite ("asscrack3:"), but the
// first byte is ROOM_CODE_VERSION. Thus a 1.0.0 app gives its normal error for an unknown version. Layout (unsigned,
// big-endian): version (1), flags (1): bit 0 lan, room length (1), room (UTF-8), room key (32), owner device ID (32),
// code ID (16), expiry time (6, ms since 1970), owner peer ID length (1), owner peer ID (multihash), the nodes
// (packNodes), signature (64): the owner device signs the SHA-256 of all bytes before it, checksum (4).
// The code is not for one device. The owner gives the device grant after a knock (knock.mjs).
export const ROOM_CODE_VERSION = 0x81
export const ROOM_CODE_EXPIRED = 'This room code has expired. Ask the room owner for a new room code.'
const roomCodeHash = bytes => createHash('sha256').update(bytes).digest('base64url')

// sign(bodyHash): the signature of the owner device (membership.signRoomCode).
export function makeRoomCode({ room, key, owner, lan, codeId, expires, ownerPeer, nodes }, sign) {
    const k = typeof key === 'string' ? key : Buffer.from(key).toString('base64url')
    if (typeof room !== 'string' || room.length < 1 || room.length > 64) throw new Error('The invite has a bad room name')
    const roomBytes = Buffer.from(room, 'utf8')
    if (roomBytes.toString('utf8') !== room || roomBytes.length > 255) throw new Error('The invite has a bad room name')
    if (typeof lan !== 'boolean' || !Number.isSafeInteger(expires) || expires < 1 || expires >= 2 ** 48) throw new Error('The invite has a bad membership')
    const time = Buffer.alloc(6)
    time.writeUIntBE(expires, 0, 6)
    const body = Buffer.concat([
        Buffer.from([ROOM_CODE_VERSION, lan ? FLAG_LAN : 0, roomBytes.length]),
        roomBytes,
        rawBytes(k, 32, 'room key'),
        rawBytes(owner, 32, 'owner'),
        rawBytes(codeId, 16, 'code ID'),
        time,
        ...packPeerId(ownerPeer),
        ...packNodes(nodes)
    ])
    const signed = Buffer.concat([body, rawBytes(sign(roomCodeHash(body)), 64, 'signature')])
    return COMPACT_INVITE_PREFIX + Buffer.concat([signed, checksum(signed)]).toString('base64url')
}

// True when the text is a room code (a parse of the first byte only, no other check).
export function isRoomCode(code) {
    if (typeof code !== 'string') return false
    const text = code.replace(/\s+/g, '')
    if (!text.startsWith(COMPACT_INVITE_PREFIX)) return false
    const head = Buffer.from(text.slice(COMPACT_INVITE_PREFIX.length, COMPACT_INVITE_PREFIX.length + 4), 'base64url')
    return head.length > 0 && head[0] === ROOM_CODE_VERSION
}

// Returns { room, key, lan, owner, codeId, expires, ownerPeer, nodes, roomId }. Throws the texts of readInvite.
export function readRoomCode(code) {
    if (typeof code !== 'string') throw new Error('The invite code is not text')
    const text = code.replace(/\s+/g, '')
    if (!text.startsWith(COMPACT_INVITE_PREFIX)) throw new Error('The invite code has a wrong prefix')
    const body64 = text.slice(COMPACT_INVITE_PREFIX.length)
    if (body64.length > 16 * 1024) throw new Error('The invite code is too large')
    if (!/^[A-Za-z0-9_-]+$/.test(body64)) throw new Error('The invite code has characters that are not valid')
    const data = Buffer.from(body64, 'base64url')
    if (data.toString('base64url') !== body64) throw compactError('bad length')
    if (data.length < 1 + 64 + CHECKSUM_BYTES) throw compactError('too short')
    const signed = data.subarray(0, data.length - CHECKSUM_BYTES)
    if (!checksum(signed).equals(data.subarray(signed.length))) throw compactError('wrong checksum')
    const body = signed.subarray(0, signed.length - 64)
    const signature = signed.subarray(body.length).toString('base64url')
    let at = 0
    const take = size => {
        if (at + size > body.length) throw compactError('too short')
        const out = body.subarray(at, at + size)
        at += size
        return out
    }
    const byte = () => take(1)[0]
    if (byte() !== ROOM_CODE_VERSION) throw new Error('The invite code has an unknown version')
    const flags = byte()
    if (flags & ~FLAG_LAN) throw compactError('unknown flags')
    let room
    try {
        room = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(take(byte()))
    } catch (err) {
        if (err.message?.startsWith('The invite code')) throw err
        throw new Error('The invite code has a bad room name')
    }
    const key = take(32).toString('base64url')
    const owner = take(32).toString('base64url')
    const codeId = take(16).toString('base64url')
    const expires = take(6).readUIntBE(0, 6)
    const ownerPeer = toString(take(byte()), 'base58btc')
    const nodes = unpackNodes(take, byte)
    if (at !== body.length) throw compactError('data after the last field')
    if (room.length < 1 || room.length > 64) throw new Error('The invite code has a bad room name')
    if (!validPeerId(ownerPeer)) throw new Error('The invite code has a bad peer ID')
    const lan = (flags & FLAG_LAN) !== 0
    let access
    try { access = roomCodeAccess(room, key, owner, lan) } catch { throw new Error('The invite code has a bad owner') }
    if (!access.verifyCode(roomCodeHash(body), signature)) throw new Error('The invite code has a bad signature')
    if (Date.now() > expires + EXPIRY_GRACE_MS) throw new Error(ROOM_CODE_EXPIRED)
    if (nodes.length > MAX_NODES || (!lan && !nodes.length)) throw new Error('The invite code has no valid node list')
    for (const n of nodes) {
        if (!validPeerId(n.id)) throw new Error('The invite code has a bad peer ID')
        if (n.addrs.length < 1 || n.addrs.length > MAX_NODES || !n.addrs.every(validAddr)) throw new Error('The invite code has a bad address')
    }
    return { room, key, lan, owner, codeId, expires, ownerPeer, nodes, roomId: access.roomId }
}

export function validPeerId(id) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 128) return false
    try {
        if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(id)) return false
        const b = fromString(id, 'base58btc')
        // A multihash: identity (0x00) or sha2-256 (0x12) with a correct length.
        if (!((b[0] === 0x00 || b[0] === 0x12) && b[1] === b.length - 2 && (b[0] === 0x00 || b[1] === 32))) return false
        return true
    } catch {
        return false
    }
}

export function validAddr(addr) {
    if (typeof addr !== 'string' || addr.length < 1 || addr.length > 256) return false
    try {
        multiaddr(addr)
        return true
    } catch {
        return false
    }
}

export function readInvite(code) {
    if (typeof code !== 'string') throw new Error('The invite code is not text')
    const text = code.replace(/\s+/g, '')
    const prefix = [INVITE_PREFIX, PROTECTED_INVITE_PREFIX, COMPACT_INVITE_PREFIX].find(p => text.startsWith(p))
    if (!prefix) throw new Error('The invite code has a wrong prefix')
    const protectedRoom = prefix !== INVITE_PREFIX
    const body = text.slice(prefix.length)
    if (body.length > 128 * 1024) throw new Error('The invite code is too large')
    if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('The invite code has characters that are not valid')
    let value
    if (prefix === COMPACT_INVITE_PREFIX) {
        const data = Buffer.from(body, 'base64url')
        if (data.toString('base64url') !== body) throw compactError('bad length')
        value = unpackCompact(data)
    } else {
        try {
            value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
        } catch {
            throw new Error('The invite code is not valid JSON')
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('The invite code is not valid JSON')
        if (value.v !== (protectedRoom ? 2 : 1)) throw new Error('The invite code has an unknown version')
    }
    const { room, key, nodes } = value
    if (typeof room !== 'string' || room.length < 1 || room.length > 64) throw new Error('The invite code has a bad room name')
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key) || Buffer.from(key, 'base64url').length !== 32) {
        throw new Error('The invite code has a bad room key')
    }
    const membership = protectedRoom ? inspectMembershipDescriptor(room, key, value.membership, { invite: true }) : null
    // L4 (P10a): an invite with an expiry time that is past (with a grace time for the clocks).
    if (membership?.grant?.expires !== undefined && Date.now() > membership.grant.expires + EXPIRY_GRACE_MS) {
        throw new Error(INVITE_EXPIRED)
    }
    if (!Array.isArray(nodes) || (!nodes.length && !membership?.lan) || nodes.length > MAX_NODES) {
        throw new Error('The invite code has no valid node list')
    }
    const extraIpv6 = new Map()
    if (!prefix || prefix !== COMPACT_INVITE_PREFIX) {
        if (Array.isArray(value?.ipv6)) {
            for (const entry of value.ipv6) {
                if (!entry || typeof entry !== 'object' || !validPeerId(entry.id) || !Array.isArray(entry.addrs)) continue
                const v6 = entry.addrs.filter(a => typeof a === 'string' && a.startsWith('/ip6/') && validAddr(a))
                if (v6.length) extraIpv6.set(entry.id, [...(extraIpv6.get(entry.id) ?? []), ...v6])
            }
        }
    }
    const out = []
    for (const n of nodes) {
        if (n === null || typeof n !== 'object' || !validPeerId(n.id)) throw new Error('The invite code has a bad peer ID')
        if (!Array.isArray(n.addrs) || n.addrs.length < 1 || n.addrs.length > MAX_NODES || !n.addrs.every(validAddr)) {
            throw new Error('The invite code has a bad address')
        }
        const nodeIpv6 = Array.isArray(n.ipv6) ? n.ipv6.filter(a => typeof a === 'string' && a.startsWith('/ip6/') && validAddr(a)) : []
        const merged = [...new Set([...n.addrs, ...nodeIpv6, ...(extraIpv6.get(n.id) ?? [])])].slice(0, MAX_NODES)
        out.push({ id: n.id, addrs: merged })
    }
    return membership ? { room, key, nodes: out, membership, lan: membership.lan } : { room, key, nodes: out }
}
