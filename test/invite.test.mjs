import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeInvite, readInvite, newRoomKey, INVITE_PREFIX } from '../src/network/invite.mjs'

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
