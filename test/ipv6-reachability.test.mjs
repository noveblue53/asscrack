// Dual-stack IPv4 + IPv6 reachability unit and integration tests (127.0.0.1 / ::1).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { multiaddr } from '@multiformats/multiaddr'
import {
    isGlobalUnicastIpv6,
    isPrivateIp,
    observedIp,
    peerAddrAllowed,
    tcpTarget,
    tryTcp
} from '../src/network/fullnode.mjs'
import { createAsscrackNode } from '../src/network/node.mjs'
import {
    INVITE_PREFIX,
    makeInvite,
    makeMemberInvite,
    newRoomKey,
    readInvite,
    readRoomCode
} from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'

const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500, discovery: false }

async function waitFor(fn, what, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`timeout: ${what}`)
}

async function stopAll(nodes) {
    await Promise.allSettled(nodes.filter(Boolean).map(n => n.stop()))
}

async function freeDualPort() {
    const s = createServer().listen(0, '0.0.0.0')
    await once(s, 'listening')
    const { port } = s.address()
    await new Promise(r => s.close(r))
    return port
}

describe('IPv6 fullnode helpers', () => {
    test('tcpTarget parses IPv4 and IPv6 TCP multiaddrs and rejects invalid/relayed ones', () => {
        assert.deepEqual(tcpTarget(multiaddr('/ip4/203.0.113.5/tcp/4001')), { family: 'ip4', ip: '203.0.113.5', port: 4001 })
        assert.deepEqual(tcpTarget(multiaddr('/ip6/::1/tcp/4001')), { family: 'ip6', ip: '::1', port: 4001 })
        assert.deepEqual(
            tcpTarget('/ip6/2001:db8::1/tcp/47000/p2p/12D3KooWDESEF99R85j6RjTNo9RTboTu35bUNHKEY8NtQ5BY4hhF'),
            { family: 'ip6', ip: '2001:db8::1', port: 47000 }
        )
        assert.equal(tcpTarget('/ip6/2001:db8::1/tcp/4001/p2p/12D3KooWDESEF99R85j6RjTNo9RTboTu35bUNHKEY8NtQ5BY4hhF/p2p-circuit'), null)
        assert.equal(tcpTarget('/ip6/::1/tcp/0'), null)
        assert.equal(tcpTarget('/ip6/::1/tcp/65536'), null)
        assert.equal(tcpTarget(null), null)
    })

    test('isGlobalUnicastIpv6 and isPrivateIp classify IPv6 ranges accurately', () => {
        for (const ip of ['2001:db8::1', '2606:4700::1', '3fff::1', '2001:0db8:0000:0000:0000:0000:0000:0001']) {
            assert.equal(isGlobalUnicastIpv6(ip), true, `${ip} is global unicast`)
            assert.equal(isPrivateIp(ip), false, `${ip} is not private`)
        }
        for (const ip of ['::1', '0:0:0:0:0:0:0:1', '::', '0:0:0:0:0:0:0:0', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'fec0::1', 'ff02::1', '100::1', '64:ff9b::1']) {
            assert.equal(isGlobalUnicastIpv6(ip), false, `${ip} is not global unicast`)
            assert.equal(isPrivateIp(ip), true, `${ip} is private/non-global`)
        }
        for (const ip of ['::ffff:127.0.0.1', '0:0:0:0:0:ffff:192.168.1.1']) {
            assert.equal(isGlobalUnicastIpv6(ip), false, `${ip} is IPv4-mapped`)
            assert.equal(isPrivateIp(ip), true, `${ip} is private IPv4-mapped`)
        }
        assert.equal(isGlobalUnicastIpv6('::ffff:203.0.113.5'), false)
        assert.equal(isPrivateIp('::ffff:203.0.113.5'), false)
    })

    test('peerAddrAllowed enforces global unicast IPv6 by default and allows LAN/private when requested', () => {
        assert.equal(peerAddrAllowed('/ip6/2001:db8::1/tcp/4001'), true)
        assert.equal(peerAddrAllowed('/ip6/2606:4700::1/tcp/443/p2p/12D3KooWDESEF99R85j6RjTNo9RTboTu35bUNHKEY8NtQ5BY4hhF'), true)

        for (const blocked of [
            '/ip6/::1/tcp/4001',
            '/ip6/::/tcp/4001',
            '/ip6/fe80::1/tcp/4001',
            '/ip6/fc00::1/tcp/4001',
            '/ip6/fd12:3456::1/tcp/4001',
            '/ip6/ff02::1/tcp/4001',
            '/ip6/::ffff:203.0.113.5/tcp/4001'
        ]) {
            assert.equal(peerAddrAllowed(blocked), false, `${blocked} rejected by default`)
        }

        assert.equal(peerAddrAllowed('/ip6/fe80::1/tcp/4001', { allowLan: true }), true)
        assert.equal(peerAddrAllowed('/ip6/fd12:3456::1/tcp/4001', { allowLan: true }), true)
        assert.equal(peerAddrAllowed('/ip6/::1/tcp/4001', { allowLan: true }), false)
        assert.equal(peerAddrAllowed('/ip6/::1/tcp/4001', { allowPrivate: true }), true)
    })

    test('observedIp filters by family and prefers global unicast over private/loopback', () => {
        const fakeNode = addrs => ({
            components: { addressManager: { getObservedAddrs: () => addrs.map(a => multiaddr(a)) } }
        })
        const mixed = fakeNode([
            '/ip4/127.0.0.1/tcp/4001',
            '/ip6/::1/tcp/4001',
            '/ip6/2001:db8::5/tcp/4001',
            '/ip4/203.0.113.5/tcp/4001'
        ])
        assert.equal(observedIp(mixed, 'ip4'), '203.0.113.5')
        assert.equal(observedIp(mixed, 'ip6'), '2001:db8::5')
        assert.equal(observedIp(fakeNode(['/ip6/::1/tcp/4001']), 'ip6'), '::1')
        assert.equal(observedIp(fakeNode(['/ip6/::1/tcp/4001']), 'ip4'), null)
    })

    test('tryTcp connects over ::1 and 127.0.0.1 and returns false on closed ports', async t => {
        const v6 = createServer().listen(0, '::1')
        await once(v6, 'listening')
        const v6Port = v6.address().port
        t.after(() => new Promise(r => v6.close(r)))

        const v4 = createServer().listen(0, '127.0.0.1')
        await once(v4, 'listening')
        const v4Port = v4.address().port
        t.after(() => new Promise(r => v4.close(r)))

        assert.equal(await tryTcp('::1', v6Port, 1000), true)
        assert.equal(await tryTcp('127.0.0.1', v4Port, 1000), true)

        const closedV6 = createServer().listen(0, '::1')
        await once(closedV6, 'listening')
        const closedPort = closedV6.address().port
        await new Promise(r => closedV6.close(r))
        assert.equal(await tryTcp('::1', closedPort, 500), false)
    })
})

describe('IPv6 dual-stack integration (127.0.0.1 / ::1)', { concurrency: false }, () => {
    test('internet room node listens on both IPv4 and IPv6 and gracefully skips IPv6 when occupied', { timeout: 30000 }, async t => {
        const nodes = []
        t.after(() => stopAll(nodes))

        const roomKey = newRoomKey()
        const dual = await createAsscrackNode({ room: 'dual-listen', roomKey, ...fast, fullNode: false })
        nodes.push(dual)
        const addrs = dual.getMultiaddrs()
        assert.ok(addrs.some(a => a.startsWith('/ip4/')), `has IPv4 listener: ${addrs.join(' ')}`)
        assert.ok(addrs.some(a => a.startsWith('/ip6/')), `has IPv6 listener: ${addrs.join(' ')}`)

        // Occupy only the IPv6 wildcard port so IPv6 fails to bind while IPv4 succeeds.
        const port = await freeDualPort()
        const blocker = createServer().listen({ port, host: '::', ipv6Only: true })
        await once(blocker, 'listening')
        t.after(() => new Promise(r => blocker.close(r)))

        const v4Only = await createAsscrackNode({ room: 'v4-fallback', roomKey, port, ...fast, fullNode: false })
        nodes.push(v4Only)
        const v4Addrs = v4Only.getMultiaddrs()
        assert.ok(v4Addrs.some(a => a === `/ip4/127.0.0.1/tcp/${port}` || a.startsWith('/ip4/')), 'IPv4 listener bound')
        assert.ok(!v4Addrs.some(a => a.startsWith('/ip6/')), 'IPv6 gracefully skipped when unavailable')
    })

    test('IPv6 dial-back over ::1 promotes fullNode, emits full-node-addrs, and populates invites', { timeout: 30000 }, async t => {
        const nodes = []
        t.after(() => stopAll(nodes))

        const room = 'v6-full'
        const roomKey = newRoomKey()
        const ownerId = createDeviceIdentity()
        const ownerMembership = createRoomMembership({ identity: ownerId, room, roomKey, lan: false })
        const memberId = createDeviceIdentity()
        const memberGrant = ownerMembership.issue(memberId.id, false)

        const owner = await createAsscrackNode({
            room, roomKey, membership: ownerMembership,
            listen: ['/ip6/::1/tcp/0'], allowPrivateFullNode: true, ...fast
        })
        nodes.push(owner)
        const ownerV6 = owner.getMultiaddrs().find(a => a.startsWith('/ip6/::1/tcp/'))
        assert.ok(ownerV6, 'owner has ::1 listener')

        const peer = await createAsscrackNode({
            room, roomKey,
            membership: restoreRoomMembership({ identity: memberId, room, roomKey, descriptor: memberGrant }),
            listen: ['/ip6/::1/tcp/0'], fullNode: false, allowPrivateFullNode: true, ...fast
        })
        nodes.push(peer)

        const seenFullAddrs = []
        peer.events.on('full-node-addrs', e => seenFullAddrs.push(e))

        await peer.connect(ownerV6)
        await waitFor(() => owner.fullNode() === true, 'owner promotes to full node via ::1 dial-back')
        await waitFor(() => seenFullAddrs.some(e => e.peerId === owner.peerId && e.addrs.some(a => a.startsWith('/ip6/::1/tcp/'))), 'peer receives full-node-addrs with ::1')

        assert.ok(owner.publicAddrs().some(a => a.startsWith('/ip6/::1/tcp/')), 'owner publicAddrs includes ::1')

        const memberInvite = readInvite(owner.createMemberInvite(createDeviceIdentity().id))
        assert.ok(memberInvite.nodes[0].addrs.some(a => a.startsWith('/ip6/::1/tcp/')), 'member invite includes ::1')

        const code = readRoomCode(owner.roomCode().code)
        assert.ok(code.nodes[0].addrs.some(a => a.startsWith('/ip6/::1/tcp/')), 'roomCode includes ::1')
    })

    test('non-fullNode proves IPv6 dial-back in directAddrs and upgrades relayed peer over ::1', { timeout: 35000 }, async t => {
        const nodes = []
        t.after(() => stopAll(nodes))

        const room = `v6-direct-${Date.now()}`
        const roomKey = newRoomKey()
        const relay = await createAsscrackNode({
            room, roomKey, listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: true, allowPrivateFullNode: true, ...fast
        })
        const peerA = await createAsscrackNode({
            room, roomKey, listen: ['/ip4/127.0.0.1/tcp/0', '/ip6/::1/tcp/0'], fullNode: false, allowPrivateFullNode: true, ...fast
        })
        const peerB = await createAsscrackNode({
            room, roomKey, listen: ['/ip4/127.0.0.1/tcp/0', '/ip6/::1/tcp/0'], fullNode: false, allowPrivateFullNode: true, ...fast
        })
        nodes.push(relay, peerA, peerB)

        const relayAddr = relay.getMultiaddrs().find(a => a.startsWith('/ip4/127.0.0.1/'))
        await peerA.connect(relayAddr)
        await peerB.connect(relayAddr)
        await waitFor(() => peerA.peers().includes(peerB.peerId) && peerB.peers().includes(peerA.peerId), 'relayed A-B session')

        // Connect peerA to a temporary ::1 helper so peerA proves ::1 reachability via directAddrs.
        const v6Helper = await createAsscrackNode({
            room, roomKey, listen: ['/ip6/::1/tcp/0'], fullNode: false, ...fast
        })
        nodes.push(v6Helper)
        await v6Helper.connect(peerA.getMultiaddrs().find(a => a.startsWith('/ip6/::1/tcp/')))
        await waitFor(() => peerA.publicAddrs().some(a => a.startsWith('/ip6/::1/tcp/')), 'peerA proves ::1 directAddr')
        assert.equal(peerA.fullNode(), false)

        // Relay path between peerA and peerB upgrades to direct mesh over ::1.
        await waitFor(() => peerB.topology().kinds[peerB.peerId]?.[peerA.peerId] === 'mesh', 'peerB upgrades A to direct mesh')
    })

    test('dual-stack node proves both 127.0.0.1 and ::1 dial-back and publicAddrs includes both', { timeout: 30000 }, async t => {
        const nodes = []
        t.after(() => stopAll(nodes))

        const room = `dual-dialback-${Date.now()}`
        const roomKey = newRoomKey()
        const dual = await createAsscrackNode({
            room, roomKey, listen: ['/ip4/127.0.0.1/tcp/0', '/ip6/::1/tcp/0'], allowPrivateFullNode: true, ...fast
        })
        const v4Peer = await createAsscrackNode({
            room, roomKey, listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: false, ...fast
        })
        const v6Peer = await createAsscrackNode({
            room, roomKey, listen: ['/ip6/::1/tcp/0'], fullNode: false, ...fast
        })
        nodes.push(dual, v4Peer, v6Peer)

        await v4Peer.connect(dual.getMultiaddrs().find(a => a.startsWith('/ip4/127.0.0.1/')))
        await v6Peer.connect(dual.getMultiaddrs().find(a => a.startsWith('/ip6/::1/')))

        await waitFor(() => {
            const pub = dual.publicAddrs()
            return pub.some(a => a.startsWith('/ip4/127.0.0.1/tcp/')) && pub.some(a => a.startsWith('/ip6/::1/tcp/'))
        }, 'dual node proves both 127.0.0.1 and ::1')

        const pub = dual.publicAddrs()
        assert.ok(pub[0].startsWith('/ip4/'), 'IPv4 precedes IPv6')
        assert.ok(pub[1].startsWith('/ip6/'), 'IPv6 follows IPv4')
        const inv = readInvite(dual.invite())
        assert.equal(inv.nodes[0].addrs.length, 2)
    })

    test('::1 without allowPrivateFullNode does not promote to fullNode or advertise ::1', { timeout: 20000 }, async t => {
        const nodes = []
        t.after(() => stopAll(nodes))

        const room = `v6-no-priv-${Date.now()}`
        const roomKey = newRoomKey()
        const target = await createAsscrackNode({
            room, roomKey, listen: ['/ip6/::1/tcp/0'], allowPrivateFullNode: false, ...fast
        })
        const peer = await createAsscrackNode({
            room, roomKey, listen: ['/ip6/::1/tcp/0'], fullNode: false, ...fast
        })
        nodes.push(target, peer)

        await peer.connect(target.getMultiaddrs().find(a => a.startsWith('/ip6/::1/')))
        await waitFor(() => target.peers().includes(peer.peerId), 'session open')
        await new Promise(r => setTimeout(r, 800))
        assert.equal(target.fullNode(), false)
        assert.deepEqual(target.publicAddrs(), [])
    })

    test('backwards-compatible invite ipv6 field is parsed and ignored cleanly by 1.0.x-style readers', () => {
        const key = newRoomKey()
        const id = '12D3KooWDESEF99R85j6RjTNo9RTboTu35bUNHKEY8NtQ5BY4hhF'
        const v4Addr = '/ip4/203.0.113.5/tcp/4001'
        const v6Addr = '/ip6/2001:db8::1/tcp/4001'

        const code = makeInvite({
            room: 'dual-room',
            key,
            nodes: [{ id, addrs: [v4Addr] }],
            ipv6: [{ id, addrs: [v6Addr] }]
        })
        const parsed = readInvite(code)
        assert.deepEqual(parsed.nodes, [{ id, addrs: [v4Addr, v6Addr] }])

        // Simulate a 1.0.x client that only reads { v, room, key, nodes } from the JSON payload.
        const raw = JSON.parse(Buffer.from(code.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'))
        assert.equal(raw.v, 1)
        assert.deepEqual(raw.nodes, [{ id, addrs: [v4Addr] }])
        assert.deepEqual(raw.ipv6, [{ id, addrs: [v6Addr] }])

        // Protected compact asscrack3: round-trips both IPv4 and IPv6 addresses.
        const owner = createRoomMembership({ identity: createDeviceIdentity(), room: 'dual-room', roomKey: key, lan: false })
        const compact = makeMemberInvite({
            room: 'dual-room',
            key,
            nodes: [{ id, addrs: [v4Addr, v6Addr] }],
            membership: owner.issue(createDeviceIdentity().id, false)
        })
        assert.deepEqual(readInvite(compact).nodes, [{ id, addrs: [v4Addr, v6Addr] }])
    })
})
