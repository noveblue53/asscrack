// L1 (P10a, P10b): a node line with fullNode true and up to 16 addresses went to learnFullNode. The node saved the
// addresses in the room hint file and dialed them after each restart. A friend line ('done', 'addrs') went to the
// friend row in the same way. validAddr accepted each multiaddr: /dns4, /unix, private and loopback addresses.
// The fix: only TCP addresses with an IP (a public IP for a full node, also a LAN IP for a friend), and a node saves an
// address only after a connection to that peer ID reached it. All results of this file are 127.0.0.1 results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey, readInvite } from '../src/network/invite.mjs'
import { addrsLine } from '../src/network/friend-requests.mjs'
import { befriend, makeProfile, protectedRoomPair, randomBasePort, startLinks, waitFor } from './helpers/friends.mjs'

const fast = { listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false, fullNode: false, heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }

// V (the victim) and M (a member that sends lines with sendTo) in a legacy keyed room. In a legacy room each member
// can send a node line with fullNode true.
async function pair(t) {
    const dir = mkdtempSync(path.join(tmpdir(), 'l1-'))
    const storePath = path.join(dir, 'room.json')
    const room = `l1-${Date.now()}`, roomKey = newRoomKey()
    const V = await createAsscrackNode({ room, roomKey, storePath, ...fast })
    const M = await createAsscrackNode({ room, roomKey, ...fast })
    t.after(async () => { await Promise.allSettled([V.stop(), M.stop()]); rmSync(dir, { recursive: true, force: true }) })
    await V.connect(M.getMultiaddrs()[0])
    await waitFor(() => V.peers().includes(M.peerId) && M.peers().includes(V.peerId), 'session')
    return { V, M, storePath }
}

// A presence line after the test lines: V read the lines before it.
async function flush(M, V, note) {
    M.sendTo(V.peerId, { type: 'presence', v: 1, state: 'away', note })
    await waitFor(() => V.peerPresence()[M.peerId]?.note === note, 'V read the lines')
    await delay(100)
}
const saved = storePath => existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')).fullNodes : {}

test('L1: 127.0.0.1: a node line with DNS, unix, private and loopback addresses gives no hint and no saved address', { timeout: 20000 }, async t => {
    const { V, M, storePath } = await pair(t)
    const seen = []
    V.events.on('full-node-addrs', e => seen.push(e))
    const addrs = ['/dns4/attacker.example/tcp/443', '/unix/tmp%2Fx.sock', '/ip4/192.168.1.1/tcp/80', '/ip4/127.0.0.1/tcp/9']
    assert.equal(M.sendTo(V.peerId, { type: 'node', fullNode: true, addrs }), true)
    await flush(M, V, 'after the node line')
    assert.equal(V.knownFullNodes()[M.peerId], undefined)
    assert.deepEqual(saved(storePath)[M.peerId], undefined)
    assert.deepEqual(seen, [])
})

test('L1: 127.0.0.1: a public address of a node line is not saved and not in the invite before a connection reaches it', { timeout: 20000 }, async t => {
    const { V, M, storePath } = await pair(t)
    const seen = []
    V.events.on('full-node-addrs', e => seen.push(e))
    const target = '/ip4/203.0.113.9/tcp/4001'
    assert.equal(M.sendTo(V.peerId, { type: 'node', fullNode: true, addrs: [target] }), true)
    await flush(M, V, 'after the node line')
    assert.deepEqual(V.knownFullNodes()[M.peerId], [target], 'the node keeps the address in memory')
    assert.deepEqual(saved(storePath)[M.peerId], undefined, 'not in the hint file')
    assert.deepEqual(seen, [], 'no full-node-addrs event')
    const code = V.invite()
    const listed = code ? readInvite(code).nodes.flatMap(n => n.addrs) : []
    assert.ok(!listed.includes(target), 'not in the invite code')
})

test('L1: 127.0.0.1: an addrs line of a friend with DNS and loopback addresses does not go into the friend row', { timeout: 60000 }, async t => {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b')
    t.after(() => { A.rooms.close(); B.rooms.close() })
    const { roomA, roomB } = await protectedRoomPair(t, A, B)
    const port = randomBasePort()
    const linksA = await startLinks(t, A, { basePort: port, discovery: false })
    const linksB = await startLinks(t, B, { basePort: port + 50, discovery: false })
    linksA.attachRoom(roomA)
    linksB.attachRoom(roomB)
    const { friendB } = await befriend(linksA, linksB, roomA, roomB)
    const id = linksB.nodeOf(friendB).peerId
    const evil = ['/dns4/attacker.example/tcp/47250', '/ip4/127.0.0.1/tcp/9', '/ip4/127.0.0.1/tcp/47251']
    assert.equal(roomB.sendTo(roomA.peerId, addrsLine(47250, [{ id, addrs: evil }])), true)
    roomB.sendTo(roomA.peerId, { type: 'presence', v: 1, state: 'away', note: 'after the addrs line' })
    await waitFor(() => roomA.peerPresence()[roomB.peerId]?.note === 'after the addrs line', 'A read the lines')
    await delay(1500)
    const row = A.rooms.friendArchive().listFriends()[0]
    const stored = row.addrs.flatMap(n => n.addrs)
    for (const addr of evil) assert.ok(!stored.includes(addr), `${addr} is not in the friend row: ${stored.join(' ')}`)
})
