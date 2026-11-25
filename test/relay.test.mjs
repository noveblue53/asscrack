import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey, readInvite } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'

const LOCAL = ['/ip4/127.0.0.1/tcp/0']

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await new Promise(r => setTimeout(r, 20))
    }
    throw new Error(`timeout: ${what}`)
}

function localAddr(n) {
    const a = n.getMultiaddrs().find(m => m.startsWith('/ip4/127.0.0.1/') && !m.includes('p2p-circuit'))
    assert.ok(a, 'node has a 127.0.0.1 address')
    return a
}

async function stopAll(nodes) {
    await Promise.allSettled(nodes.filter(Boolean).map(n => n.stop()))
}

const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }

describe('relay', { concurrency: true }, () => {

test('two relay-only nodes chat through a full node, beyond the default relay data limit', { timeout: 60000 }, async () => {
    const room = `relay-${Date.now()}`
    const nodes = []
    try {
        // R must not have the lowest peer ID. Make new nodes until that is true.
        let R, A, B
        for (let i = 0; i < 20; i++) {
            ;[R, A, B] = await Promise.all([
                createAsscrackNode({ room, listen: LOCAL, discovery: false, fullNode: true, ...fast }),
                createAsscrackNode({ room, relayOnly: true, fullNode: false, ...fast }),
                createAsscrackNode({ room, relayOnly: true, fullNode: false, ...fast })
            ])
            if (R.peerId > A.peerId || R.peerId > B.peerId) break
            await stopAll([R, A, B])
        }
        nodes.push(R, A, B)
        assert.ok(R.peerId > A.peerId || R.peerId > B.peerId, 'R is not the lowest peer ID')
        assert.equal(A.getMultiaddrs().length, 0, 'relay-only node has no listen address')

        const rAddr = localAddr(R)
        await A.connect(rAddr)
        await B.connect(rAddr)

        await waitFor(() => A.peers().includes(B.peerId) && B.peers().includes(A.peerId), 20000, 'A-B session through R')
        assert.deepEqual(A.fullNodes(), [R.peerId])
        assert.equal(R.fullNode(), true)
        assert.equal(A.fullNode(), false)

        for (const c of A.libp2p.getConnections()) {
            if (c.remotePeer.toString() === B.peerId) assert.ok(c.remoteAddr.toString().includes('/p2p-circuit'), `A-B connection ${c.remoteAddr} is relayed`)
        }

        await waitFor(() => {
            const k = A.topology().kinds[A.peerId]
            return k[B.peerId] === 'relay' && k[R.peerId] === 'mesh'
        }, 5000, 'link kinds on A')
        assert.ok(Array.isArray(A.topology().links[A.peerId]))

        // More than 128 KiB of chat lines from A to B.
        // A host replay on R's direct link can beat the original on A's relayed link.
        // 'live' counts the bytes from A. 'message' and 'history' together count the rows presented to B.
        const got = []
        const shownIds = []
        B.events.on('live', m => { if (m.peerId === A.peerId) got.push({ id: m.id, text: m.text }) })
        B.events.on('message', m => shownIds.push(m.id))
        B.events.on('history', ({ messages }) => shownIds.push(...messages.map(m => m.id)))
        const sent = []
        for (let i = 0; i < 200; i++) {
            const text = `${String(i).padStart(4, '0')}:${'x'.repeat(995)}`
            const record = A.sendRecord(text)
            assert.ok(record.accepted >= 1)
            sent.push({ id: record.id, text })
        }
        await waitFor(() => got.length >= 200, 20000, 'B gets 200 lines')
        assert.deepEqual(got, sent)
        assert.deepEqual(shownIds.sort(), sent.map(m => m.id).sort())
        assert.ok(A.peers().includes(B.peerId), 'session stays open')

        // R is the host after the first election (rule 7).
        await waitFor(() => A.host()?.peerId === R.peerId && B.host()?.peerId === R.peerId && R.isHost(), 15000, 'R is host')
    } finally {
        await stopAll(nodes)
    }
})

test("'auto' with allowPrivateFullNode makes a full node on 127.0.0.1; relayOnly does not", { timeout: 30000 }, async () => {
    const room = `auto-${Date.now()}`
    const nodes = []
    try {
        const N = await createAsscrackNode({ room, listen: LOCAL, discovery: false, allowPrivateFullNode: true, ...fast })
        nodes.push(N)
        const P = await createAsscrackNode({ room, relayOnly: true, allowPrivateFullNode: true, ...fast })
        nodes.push(P)
        assert.equal(N.fullNode(), false)
        const changes = []
        N.events.on('full-node', e => changes.push(e))
        await P.connect(localAddr(N))
        await waitFor(() => N.fullNode() === true, 10000, 'N becomes a full node')
        assert.deepEqual(changes.filter(e => e.peerId === N.peerId), [{ peerId: N.peerId, fullNode: true }])
        await waitFor(() => P.fullNodes().includes(N.peerId), 5000, 'P sees N as full node')
        await new Promise(r => setTimeout(r, 500))
        assert.equal(P.fullNode(), false)
    } finally {
        await stopAll(nodes)
    }
})

test("'auto' without allowPrivateFullNode gives no full node on 127.0.0.1", { timeout: 30000 }, async () => {
    const room = `auto-priv-${Date.now()}`
    const nodes = []
    try {
        const [N, P] = await Promise.all([
            createAsscrackNode({ room, listen: LOCAL, discovery: false, ...fast }),
            createAsscrackNode({ room, listen: LOCAL, discovery: false, ...fast })
        ])
        nodes.push(N, P)
        await P.connect(localAddr(N))
        await waitFor(() => N.peers().includes(P.peerId) && P.peers().includes(N.peerId), 5000, 'session')
        await new Promise(r => setTimeout(r, 1500))
        assert.equal(N.fullNode(), false)
        assert.equal(P.fullNode(), false)
        assert.deepEqual(N.fullNodes(), [])
    } finally {
        await stopAll(nodes)
    }
})

test('protected non-host admitted member becomes a circuit-relay Full Node without host or voice-host eligibility', { timeout: 35000 }, async () => {
    const room = `any-relay-${Date.now()}`
    const roomKey = newRoomKey()
    const socket = createServer().listen(0, '127.0.0.1')
    await once(socket, 'listening')
    const ownerAddr = `/ip4/127.0.0.1/tcp/${socket.address().port}`
    await new Promise(resolve => socket.close(resolve))

    const nodes = []
    try {
        const owner = await createAsscrackNode({
            room, roomKey,
            membership: createRoomMembership({ identity: createDeviceIdentity(), room, roomKey }),
            listen: [ownerAddr], announce: [ownerAddr], discovery: false,
            fullNode: true, allowPrivateFullNode: true, ...fast
        })
        nodes.push(owner)

        async function joinMember(canHost, extra) {
            const identity = createDeviceIdentity()
            const invite = readInvite(owner.createMemberInvite(identity.id, { canHost }))
            const member = restoreRoomMembership({ identity, room, roomKey, descriptor: invite.membership })
            const node = await createAsscrackNode({ room, roomKey, membership: member, discovery: false, ...fast, ...extra })
            nodes.push(node)
            await node.connect(ownerAddr)
            await waitFor(() => node.peers().includes(owner.peerId) && owner.peers().includes(node.peerId), 10000, 'admitted')
            return node
        }

        const relayMember = await joinMember(false, { listen: LOCAL, fullNode: 'auto', allowPrivateFullNode: true })
        await waitFor(() => relayMember.fullNode() === true && owner.fullNodes().includes(relayMember.peerId), 10000, 'relayMember becomes Full Node')
        assert.equal(relayMember.canRelay(), true)
        assert.equal(relayMember.memberState().canHost, false)

        const a = await joinMember(false, { relayOnly: true, fullNode: false, allowPrivateFullNode: true })
        const b = await joinMember(false, { relayOnly: true, fullNode: false, allowPrivateFullNode: true })
        await waitFor(() => a.fullNodes().includes(relayMember.peerId) && b.fullNodes().includes(relayMember.peerId), 10000, 'A and B see relayMember as Full Node')
        await waitFor(() => a.topology().kinds[a.peerId]?.[relayMember.peerId] === 'mesh' &&
            b.topology().kinds[b.peerId]?.[relayMember.peerId] === 'mesh', 10000, 'A and B upgraded to direct TCP with relayMember')

        // Stop the owner so relayMember is the only Full Node in the room.
        await owner.stop()
        await waitFor(() => !a.peers().includes(owner.peerId) && !b.peers().includes(owner.peerId), 10000, 'owner left')

        // A and B still chat through relayMember's circuit relay, and relayMember is NOT elected host.
        await waitFor(() => a.peers().includes(b.peerId) && b.peers().includes(a.peerId), 15000, 'A-B session through relayMember')
        const gotB = []
        b.events.on('message', m => gotB.push(m))
        a.send('via non-host relay')
        await waitFor(() => gotB.some(m => m.text === 'via non-host relay'), 10000, 'B receives message via relayMember')

        await new Promise(r => setTimeout(r, 800))
        assert.equal(relayMember.isHost(), false)
        assert.notEqual(a.host()?.peerId, relayMember.peerId)
        assert.notEqual(b.host()?.peerId, relayMember.peerId)
    } finally {
        await stopAll(nodes)
    }
})

})
