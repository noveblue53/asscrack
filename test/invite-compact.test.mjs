import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { makeMemberInvite, readInvite, newRoomKey, COMPACT_INVITE_PREFIX, PROTECTED_INVITE_PREFIX } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership } from '../src/network/room-membership.mjs'

const IDS = [
    '12D3KooWDESEF99R85j6RjTNo9RTboTu35bUNHKEY8NtQ5BY4hhF',
    'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N',
    '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo'
]

function setup({ room = 'Protected game room', lan = false, canHost = false, revoke = 0 } = {}) {
    const key = newRoomKey()
    const owner = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey: key, lan })
    for (let i = 0; i < revoke; i++) {
        const id = createDeviceIdentity().id
        owner.issue(id, false)
        owner.revoke(id)
    }
    return { room, key, membership: owner.issue(createDeviceIdentity().id, canHost) }
}

function v2(value) {
    return PROTECTED_INVITE_PREFIX + Buffer.from(JSON.stringify({ v: 2, ...value }), 'utf8').toString('base64url')
}

function body(code) {
    return Buffer.from(code.slice(COMPACT_INVITE_PREFIX.length), 'base64url')
}

// A code from changed body bytes with a new, correct checksum. Thus the parser checks run, not the checksum check.
function reseal(bytes) {
    const sum = createHash('sha256').update(bytes).digest().subarray(0, 4)
    return COMPACT_INVITE_PREFIX + Buffer.concat([bytes, sum]).toString('base64url')
}

function expected(value) {
    return { ...value, membership: { ...value.membership, issued: [] }, lan: value.membership.lan }
}

test('asscrack3 round trip for 1 and 3 host nodes with IPv4, IPv6 and DNS addresses', () => {
    const one = { ...setup(), nodes: [{ id: IDS[0], addrs: ['/ip4/203.0.113.5/tcp/4001'] }] }
    const three = {
        ...setup({ canHost: true, revoke: 2 }),
        nodes: [
            { id: IDS[0], addrs: ['/ip4/203.0.113.5/tcp/4001', '/ip6/2001:db8::1/tcp/4001'] },
            { id: IDS[1], addrs: ['/dns4/host.example.com/tcp/443/wss', '/dns6/host.example.com/tcp/4001'] },
            { id: IDS[2], addrs: ['/ip6/2001:db8::2/tcp/4002', '/ip4/198.51.100.7/tcp/65535', '/ip4/192.0.2.1/udp/4001/quic-v1'] }
        ]
    }
    for (const value of [one, three]) {
        const code = makeMemberInvite(value)
        assert.ok(code.startsWith(COMPACT_INVITE_PREFIX))
        const wrapped = ` ${code.slice(0, 40)}\n${code.slice(40)} \r\n`
        const read = readInvite(wrapped)
        assert.deepEqual(read, expected(value))
        // The same object as the asscrack2 code of the same data.
        assert.deepEqual(read, readInvite(v2(value)))
    }
    assert.equal(readInvite(makeMemberInvite(three)).membership.revocations.sequence, 2)
    assert.equal(readInvite(makeMemberInvite(three)).membership.grant.canHost, true)
})

test('asscrack3 round trip of a LAN protected invite with 0 nodes', () => {
    const value = { ...setup({ lan: true }), nodes: [] }
    const read = readInvite(makeMemberInvite(value))
    assert.equal(read.lan, true)
    assert.deepEqual(read.nodes, [])
    assert.deepEqual(read, expected(value))
    // An internet room with 0 nodes is refused.
    assert.throws(() => readInvite(makeMemberInvite({ ...setup(), nodes: [] })), /no valid node list/)
})

test('a room name with characters outside ASCII makes a round trip', () => {
    const value = { ...setup({ room: 'Spielraum Ü 🎮 ' + 'x'.repeat(40) }), nodes: [{ id: IDS[0], addrs: ['/ip4/203.0.113.5/tcp/4001'] }] }
    assert.deepEqual(readInvite(makeMemberInvite(value)), expected(value))
    // A byte order mark at the start of the room name stays in the name.
    const bom = { ...setup({ room: '\uFEFFx' }), nodes: value.nodes }
    assert.deepEqual(readInvite(makeMemberInvite(bom)), expected(bom))
})

test('asscrack3 length for one host node with one IPv4 address is 425 characters or fewer', () => {
    // The setup of the 850 figure: room name of 20 characters, issue(deviceId, false).
    const value = { ...setup({ room: 'r'.repeat(20) }), nodes: [{ id: IDS[0], addrs: ['/ip4/203.0.113.5/tcp/4001'] }] }
    // L4 (P10a): the grant has an expiry time now (32 more characters in the JSON form).
    assert.equal(v2(value).length, 850 + 32)
    assert.ok(makeMemberInvite(value).length <= 425, `length ${makeMemberInvite(value).length}`)
})

test('a damaged asscrack3 code is refused', () => {
    const value = { ...setup(), nodes: [{ id: IDS[0], addrs: ['/ip4/203.0.113.5/tcp/4001'] }] }
    const code = makeMemberInvite(value)
    const bytes = body(code)
    // Each changed byte (also in the peer ID and the address, which have no signature) gives an error.
    for (let i = 0; i < bytes.length; i++) {
        const bad = Buffer.from(bytes)
        bad[i] ^= 0x01
        assert.throws(() => readInvite(COMPACT_INVITE_PREFIX + bad.toString('base64url')), /wrong checksum/, `byte ${i}`)
    }
    // Short data, data after the checksum, and a non-canonical base64url end.
    assert.throws(() => readInvite(code.slice(0, -4)), /damaged/)
    assert.throws(() => readInvite(COMPACT_INVITE_PREFIX + 'AAAA'), /damaged/)
    assert.throws(() => readInvite(COMPACT_INVITE_PREFIX + Buffer.concat([bytes, Buffer.from([0])]).toString('base64url')), /damaged/)
    assert.throws(() => readInvite(code + 'A'), /damaged/)
    assert.throws(() => readInvite(COMPACT_INVITE_PREFIX), /characters that are not valid/)
    assert.throws(() => readInvite(COMPACT_INVITE_PREFIX + 'abc$'), /characters that are not valid/)

    // Bodies with a correct checksum: the parser refuses them.
    const plain = bytes.subarray(0, bytes.length - 4)
    assert.throws(() => readInvite(reseal(Buffer.concat([plain, Buffer.from([7])]))), /data after the last field/)
    assert.throws(() => readInvite(reseal(plain.subarray(0, plain.length - 1))), /too short/)
    assert.throws(() => readInvite(reseal(plain.subarray(0, 40))), /too short/)
    // L4 (P10a): the compact version is 4 now (the grant has an expiry time). Version 3 and 5 are unknown.
    assert.throws(() => readInvite(reseal(Buffer.from([4]))), /too short/)
    assert.throws(() => readInvite(reseal(Buffer.from([3, 0]))), /unknown version/)
    const version = Buffer.from(plain); version[0] = 5
    assert.throws(() => readInvite(reseal(version)), /unknown version/)
    const flags = Buffer.from(plain); flags[1] |= 0x80
    assert.throws(() => readInvite(reseal(flags)), /unknown flags/)
    // The last address: type byte at plain.length - 7.
    const type = Buffer.from(plain); type[plain.length - 7] = 9
    assert.throws(() => readInvite(reseal(type)), /unknown address type/)
    // The peer ID: a damaged multihash header.
    const peerAt = plain.length - 7 - 1 - 38
    const peer = Buffer.from(plain); peer[peerAt + 1] = 0x99
    assert.throws(() => readInvite(reseal(peer)), /bad peer ID/)
    const roomUtf8 = Buffer.from(plain); roomUtf8[3] = 0xff
    assert.throws(() => readInvite(reseal(roomUtf8)), /bad room name/)
    const binaryAddr = makeMemberInvite({ ...value, nodes: [{ id: IDS[0], addrs: ['/ip6/2001:db8::1/tcp/4001'] }] })
    const b = body(binaryAddr).subarray(0, -4)
    const addr = Buffer.from(b); addr[b.length - 20] = 0xee
    assert.throws(() => readInvite(reseal(addr)), /bad address/)
})

test('an asscrack3 code with a wrong signature or another room name is refused', () => {
    const base = { ...setup({ revoke: 1 }), nodes: [{ id: IDS[0], addrs: ['/ip4/203.0.113.5/tcp/4001'] }] }
    const flip = signature => {
        const b = Buffer.from(signature, 'base64url'); b[10] ^= 0x01
        return b.toString('base64url')
    }
    const m = base.membership
    const cases = {
        grant: { ...base, membership: { ...m, grant: { ...m.grant, signature: flip(m.grant.signature) } } },
        canHost: { ...base, membership: { ...m, grant: { ...m.grant, canHost: true } } },
        lan: { ...base, membership: { ...m, lan: true } },
        revocations: { ...base, membership: { ...m, revocations: { ...m.revocations, signature: flip(m.revocations.signature) } } },
        room: { ...base, room: 'Another room' },
        key: { ...base, key: newRoomKey() },
        owner: { ...base, membership: { ...m, owner: createDeviceIdentity().id } }
    }
    for (const [cause, value] of Object.entries(cases)) {
        assert.throws(() => readInvite(makeMemberInvite(value)), /authorization/, cause)
    }
})

test('makeMemberInvite refuses data that it cannot pack without a change', () => {
    const base = { ...setup(), nodes: [{ id: IDS[0], addrs: ['/ip4/203.0.113.5/tcp/4001'] }] }
    const m = base.membership
    assert.throws(() => makeMemberInvite({ ...base, room: 'a\ud800b' }), /room name/)
    assert.throws(() => makeMemberInvite({ ...base, room: 'x'.repeat(65) }), /room name/)
    assert.throws(() => makeMemberInvite({ ...base, key: 'A'.repeat(42) + 'B' }), /room key/)
    assert.throws(() => makeMemberInvite({ ...base, membership: { ...m, admission: 'x' } }), /membership/)
    assert.throws(() => makeMemberInvite({ ...base, membership: { ...m, v: 1 } }), /membership/)
    assert.throws(() => makeMemberInvite({ ...base, nodes: [{ id: '12D3KooWbad', addrs: ['/ip4/1.2.3.4/tcp/1'] }] }), /peer ID/)
    assert.throws(() => makeMemberInvite({ ...base, nodes: [{ id: IDS[0], addrs: ['not an address'] }] }), /address/)
    assert.throws(() => makeMemberInvite({ ...base, nodes: [{ id: IDS[0], addrs: [] }] }), /address/)
})
