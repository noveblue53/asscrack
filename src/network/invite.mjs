// Invite code of an internet room: "asscrack1:" + base64url(JSON { v: 1, room, key, nodes }).
import { randomBytes } from 'node:crypto'
import { multiaddr } from '@multiformats/multiaddr'
import { fromString } from 'uint8arrays/from-string'
import { inspectMembershipDescriptor } from './room-membership.mjs'

export const INVITE_PREFIX = 'asscrack1:'
export const PROTECTED_INVITE_PREFIX = 'asscrack2:'
const MAX_NODES = 16

export function newRoomKey() {
    return randomBytes(32).toString('base64url')
}

export function makeInvite({ room, key, nodes }) {
    const k = typeof key === 'string' ? key : Buffer.from(key).toString('base64url')
    const list = nodes.map(n => ({ id: n.id, addrs: [...n.addrs] }))
    return INVITE_PREFIX + Buffer.from(JSON.stringify({ v: 1, room, key: k, nodes: list }), 'utf8').toString('base64url')
}

export function makeMemberInvite({ room, key, nodes, membership }) {
    const k = typeof key === 'string' ? key : Buffer.from(key).toString('base64url')
    const list = nodes.map(n => ({ id: n.id, addrs: [...n.addrs] }))
    return PROTECTED_INVITE_PREFIX + Buffer.from(JSON.stringify({ v: 2, room, key: k, nodes: list, membership }), 'utf8').toString('base64url')
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
    const protectedRoom = text.startsWith(PROTECTED_INVITE_PREFIX)
    if (!protectedRoom && !text.startsWith(INVITE_PREFIX)) throw new Error('The invite code has a wrong prefix')
    const body = text.slice((protectedRoom ? PROTECTED_INVITE_PREFIX : INVITE_PREFIX).length)
    if (body.length > 128 * 1024) throw new Error('The invite code is too large')
    if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('The invite code has characters that are not valid')
    let value
    try {
        value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    } catch {
        throw new Error('The invite code is not valid JSON')
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('The invite code is not valid JSON')
    if (value.v !== (protectedRoom ? 2 : 1)) throw new Error('The invite code has an unknown version')
    const { room, key, nodes } = value
    if (typeof room !== 'string' || room.length < 1 || room.length > 64) throw new Error('The invite code has a bad room name')
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key) || Buffer.from(key, 'base64url').length !== 32) {
        throw new Error('The invite code has a bad room key')
    }
    const membership = protectedRoom ? inspectMembershipDescriptor(room, key, value.membership, { invite: true }) : null
    if (!Array.isArray(nodes) || (!nodes.length && !membership?.lan) || nodes.length > MAX_NODES) {
        throw new Error('The invite code has no valid node list')
    }
    const out = []
    for (const n of nodes) {
        if (n === null || typeof n !== 'object' || !validPeerId(n.id)) throw new Error('The invite code has a bad peer ID')
        if (!Array.isArray(n.addrs) || n.addrs.length < 1 || n.addrs.length > MAX_NODES || !n.addrs.every(validAddr)) {
            throw new Error('The invite code has a bad address')
        }
        out.push({ id: n.id, addrs: [...n.addrs] })
    }
    return membership ? { room, key, nodes: out, membership, lan: membership.lan } : { room, key, nodes: out }
}
