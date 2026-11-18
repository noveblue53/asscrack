import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

// All results of this file are 127.0.0.1 results, not LAN results.
const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await sleep(20)
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

// Record the relay of each relayed session event between two members.
function recordRelays(member, memberIds, out) {
    member.events.on('connection', ev => {
        if (ev.state === 'session' && ev.type === 'relay' && memberIds.has(ev.peer)) {
            out.push({ from: member.peerId, peer: ev.peer, relay: ev.relay })
        }
    })
}

// Two full nodes R1 and R2, and relay-only members. Each member connects to R1 and R2.
async function twoRelayRoom(nodes, memberCount) {
    const room = `rs-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roomKey = newRoomKey()
    const R1 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, ...fast })
    nodes.push(R1)
    const R2 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, ...fast })
    nodes.push(R2)
    await R1.connect(localAddr(R2))
    await waitFor(() => R1.peers().includes(R2.peerId), 10000, 'R1-R2 session')
    const members = []
    for (let i = 0; i < memberCount; i++) {
        const m = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast })
        nodes.push(m)
        members.push(m)
    }
    const ids = new Set(members.map(m => m.peerId))
    const events = []
    for (const m of members) recordRelays(m, ids, events)
    for (const m of members) {
        await m.connect(localAddr(R1))
        await m.connect(localAddr(R2))
    }
    return { R1, R2, members, events }
}

function allPairs(members) {
    return members.every(a => members.every(b => a === b || a.peers().includes(b.peerId)))
}

test('spread: the member sessions use both full nodes as relays', { timeout: 60000 }, async () => {
    const nodes = []
    try {
        const { R1, R2, members, events } = await twoRelayRoom(nodes, 3)
        await waitFor(() => allPairs(members), 30000, 'sessions between all members')
        const used = new Set(events.map(e => e.relay))
        assert.ok(used.has(R1.peerId), `R1 is a relay: ${JSON.stringify(events)}`)
        assert.ok(used.has(R2.peerId), `R2 is a relay: ${JSON.stringify(events)}`)
    } finally {
        await stopAll(nodes)
    }
})

test('spread: when the relay stops, the member session opens again through the other full node', { timeout: 60000 }, async () => {
    const nodes = []
    try {
        const { R1, R2, members, events } = await twoRelayRoom(nodes, 2)
        const [A, B] = members
        await waitFor(() => allPairs(members), 30000, 'A-B session')
        const first = events.find(e => e.relay === R1.peerId || e.relay === R2.peerId)
        assert.ok(first, `a relayed A-B session: ${JSON.stringify(events)}`)
        const stopped = first.relay === R1.peerId ? R1 : R2
        const other = stopped === R1 ? R2 : R1
        const before = events.length
        await stopped.stop()
        await waitFor(() => events.slice(before).some(e => e.relay === other.peerId) && allPairs([A, B]),
            30000, 'A-B session through the other full node')
    } finally {
        await stopAll(nodes)
    }
})
