// L5 (P10a): each keyed room listened on 0.0.0.0, also a LAN room. A LAN room then accepted TCP connections on each
// network of the PC, for example a public network. The fix: a LAN room listens only on the private IPv4 addresses and
// on 127.0.0.1. All results of this file are 127.0.0.1 results or results of this PC, not LAN results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeModule from '../src/network/node.mjs'

const { createAsscrackNode } = nodeModule
import { newRoomKey } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership } from '../src/network/room-membership.mjs'

const listenConfig = node => node.libp2p.components.addressManager.getListenAddrs().map(String)

test('L5: a LAN room node with no listen option does not listen on 0.0.0.0', { timeout: 20000 }, async t => {
    const room = 'L5 LAN room', roomKey = newRoomKey()
    const membership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: true })
    const node = await createAsscrackNode({ room, roomKey, membership, discovery: false, fullNode: false })
    t.after(() => node.stop())
    const config = listenConfig(node)
    assert.ok(!config.some(a => a.startsWith('/ip4/0.0.0.0/')), config.join(' '))
    assert.ok(config.includes('/ip4/127.0.0.1/tcp/0'), config.join(' '))
    // Each bound address is loopback or private.
    for (const a of node.getMultiaddrs()) assert.match(a, /^\/ip4\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/)
})

test('L5: an internet room keeps 0.0.0.0', { timeout: 20000 }, async t => {
    const room = 'L5 internet room', roomKey = newRoomKey()
    const membership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: false })
    const node = await createAsscrackNode({ room, roomKey, membership, discovery: false, fullNode: false })
    t.after(() => node.stop())
    assert.ok(listenConfig(node).includes('/ip4/0.0.0.0/tcp/0'))
})

test('L5: lanListenAddrs keeps only the private IPv4 addresses and 127.0.0.1', () => {
    const { lanListenAddrs } = nodeModule
    assert.equal(typeof lanListenAddrs, 'function')
    const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal })
    const interfaces = {
        lo: [v4('127.0.0.1', true)],
        wifi: [v4('192.168.1.20'), { address: 'fe80::1', family: 'IPv6', internal: false }],
        vpn: [v4('10.8.0.2'), v4('172.20.1.1'), v4('172.32.0.1')],
        cable: [v4('169.254.10.10')],
        public: [v4('203.0.113.7'), v4('100.64.0.1')]
    }
    assert.deepEqual(lanListenAddrs(47000, interfaces), ['/ip4/127.0.0.1/tcp/47000', '/ip4/192.168.1.20/tcp/47000',
        '/ip4/10.8.0.2/tcp/47000', '/ip4/172.20.1.1/tcp/47000', '/ip4/169.254.10.10/tcp/47000'])
    assert.deepEqual(lanListenAddrs(0, { public: [v4('203.0.113.7')] }), ['/ip4/127.0.0.1/tcp/0'])
})
