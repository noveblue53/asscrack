import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeInvite, readInvite, newRoomKey, INVITE_PREFIX, PROTECTED_INVITE_PREFIX } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership } from '../src/network/room-membership.mjs'

const ID = '12D3KooWDESEF99R85j6RjTNo9RTboTu35bUNHKEY8NtQ5BY4hhF'
const nodes = [{ id: ID, addrs: ['/ip4/203.0.113.5/tcp/4001'] }]

function encode(value) {
    return INVITE_PREFIX + Buffer.from(JSON.stringify(value)).toString('base64url')
}

test('makeInvite then readInvite gives the same room, key and nodes', () => {
    const key = newRoomKey()
    assert.equal(Buffer.from(key, 'base64url').length, 32)
    const code = makeInvite({ room: 'team room', key, nodes })
    // Spaces and line breaks are removed.
    const wrapped = ` ${code.slice(0, 20)}\n${code.slice(20)} \r\n`
    assert.deepEqual(readInvite(wrapped), { room: 'team room', key, nodes })
})

test('a bad invite code throws', () => {
    const key = newRoomKey()
    const bad = {
        prefix: 'asscrack2:' + makeInvite({ room: 'r', key, nodes }).slice(INVITE_PREFIX.length),
        json: INVITE_PREFIX + Buffer.from('{not json').toString('base64url'),
        version: encode({ v: 2, room: 'r', key, nodes }),
        shortKey: encode({ v: 1, room: 'r', key: Buffer.alloc(16).toString('base64url'), nodes }),
        noNodes: encode({ v: 1, room: 'r', key, nodes: [] }),
        badPeerId: encode({ v: 1, room: 'r', key, nodes: [{ id: '12D3KooWbad', addrs: nodes[0].addrs }] }),
        badAddr: encode({ v: 1, room: 'r', key, nodes: [{ id: ID, addrs: ['not an address'] }] }),
        longRoom: encode({ v: 1, room: 'x'.repeat(65), key, nodes })
    }
    for (const [cause, code] of Object.entries(bad)) {
        assert.throws(() => readInvite(code), Error, cause)
    }
})

// The RC2 form of a protected room code. The app makes only asscrack3 codes now, but it still reads asscrack2 codes.
function encodeV2(value) {
    return PROTECTED_INVITE_PREFIX + Buffer.from(JSON.stringify({ v: 2, ...value })).toString('base64url')
}

test('an asscrack2 code of a protected room is still read', () => {
    for (const lan of [false, true]) {
        const room = 'team room'
        const key = newRoomKey()
        const owner = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey: key, lan })
        const membership = owner.issue(createDeviceIdentity().id, false)
        const list = lan ? [] : nodes
        const read = readInvite(encodeV2({ room, key, nodes: list, membership }))
        assert.deepEqual(read, { room, key, nodes: list, membership: { ...membership, issued: [] }, lan })
        const b = Buffer.from(membership.grant.signature, 'base64url'); b[0] ^= 1
        const forged = { ...membership, grant: { ...membership.grant, signature: b.toString('base64url') } }
        assert.throws(() => readInvite(encodeV2({ room, key, nodes: list, membership: forged })), /authorization/)
        assert.throws(() => readInvite(encodeV2({ room: 'other room', key, nodes: list, membership })), /authorization/)
    }
})
