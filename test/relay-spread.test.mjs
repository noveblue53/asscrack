import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { observeRoomActivity } from '../src/application/room-activity.mjs'

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

// Record the relay of each relayed session event of a member. Only members use a relay in this room.
function recordRelays(member, out) {
    member.events.on('connection', ev => {
        if (ev.state === 'session' && ev.type === 'relay') {
            out.push({ from: member.peerId, peer: ev.peer, relay: ev.relay, dir: ev.dir })
        }
    })
}

// Two full nodes R1 and R2, and relay-only members. Each member dials R1 and R2 from its invite nodes.
async function twoRelayRoom(nodes, memberCount, observeMember = () => {}) {
    const room = `rs-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const roomKey = newRoomKey()
    const R1 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, ...fast })
    nodes.push(R1)
    const R2 = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, ...fast })
    nodes.push(R2)
    await R1.connect(localAddr(R2))
    await waitFor(() => R1.peers().includes(R2.peerId), 10000, 'R1-R2 session')
    // The members know both full nodes, as from an invite code.
    const inviteNodes = [R1, R2].map(r => ({ id: r.peerId, addrs: [localAddr(r)] }))
    const members = []
    const events = []
    for (let i = 0; i < memberCount; i++) {
        const m = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, inviteNodes, ...fast })
        nodes.push(m)
        members.push(m)
        observeMember(m)
        recordRelays(m, events)
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
        // The lowest member dials the two other members. It must use a different relay for each dial.
        for (const m of members) {
            const outs = events.filter(e => e.from === m.peerId && e.dir === 'out').map(e => e.relay)
            assert.equal(new Set(outs).size, outs.length, `each outbound session of a member uses a different relay: ${JSON.stringify(events)}`)
        }
        assert.ok(events.some(e => e.dir === 'out' && events.filter(x => x.from === e.from && x.dir === 'out').length === 2),
            `one member dials two sessions: ${JSON.stringify(events)}`)
    } finally {
        await stopAll(nodes)
    }
})

test('spread: when the relay stops, the member session opens again through the other full node', { timeout: 60000 }, async () => {
    const nodes = []
    try {
        const feeds = []
        const { R1, R2, members, events } = await twoRelayRoom(nodes, 2, m => feeds.push(observeRoomActivity(m)))
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
        for (const read of feeds) {
            const via = read().filter(line => line.includes('Chat opened (relayed)')).map(line => line.split(' via ')[1])
            assert.equal(new Set(via).size, 2, 'the local feed distinguishes the two observed relay routes')
        }
    } finally {
        await stopAll(nodes)
    }
})

test('relay: a reservation that becomes usable after ten failed dials reconnects waiting members', { timeout: 40000 }, async t => {
    const opts = { room: 'late reservation', roomKey: newRoomKey(), discovery: false, ...fast, redialInterval: 500 }
    const nodes = []
    t.after(() => stopAll(nodes))
    const relay = await createAsscrackNode({ ...opts, fullNode: true, listen: LOCAL })
    nodes.push(relay)
    const members = []
    for (let i = 0; i < 2; i++) {
        const n = await createAsscrackNode({ ...opts, fullNode: false, relayOnly: true })
        nodes.push(n)
        members.push(n)
    }
    const [a, b] = members.sort((x, y) => x.peerId < y.peerId ? -1 : 1)
    const gate = Promise.withResolvers()
    const tm = b.libp2p.components.transportManager
    const listen = tm.listen.bind(tm)
    t.mock.method(tm, 'listen', async (...args) => { await gate.promise; return listen(...args) })
    let failed = 0
    const dial = a.libp2p.dial.bind(a.libp2p)
    t.mock.method(a.libp2p, 'dial', async (address, ...args) => {
        try { return await dial(address, ...args) } catch (err) {
            if (address.toString().includes(`/p2p-circuit/p2p/${b.peerId}`)) failed++
            throw err
        }
    })
    try {
        await a.connect(localAddr(relay))
        await b.connect(localAddr(relay))
        await waitFor(() => failed >= 10, 25000, 'ten failed circuit dials while B has no reservation')
        assert.ok(!a.peers().includes(b.peerId))
    } finally {
        gate.resolve()
    }
    await waitFor(() => allPairs(members), 5000, 'members reconnect without reopening the relay session')
    const fromA = new Set()
    const fromB = new Set()
    b.events.on('live', m => { if (m.peerId === a.peerId) fromA.add(m.id) })
    a.events.on('live', m => { if (m.peerId === b.peerId) fromB.add(m.id) })
    const sentA = a.sendRecord('A after recovery')
    const sentB = b.sendRecord('B after recovery')
    await waitFor(() => fromA.has(sentA.id) && fromB.has(sentB.id), 5000, 'bidirectional live messages after recovery')
})

test('127.0.0.1: two restricted members recover two-way voice and chat through the alternate full node', { timeout: 45000 }, async t => {
    const options = { room: 'alternate voice relay', roomKey: newRoomKey(), discovery: false }
    const nodes = []
    let timer
    t.after(async () => { clearInterval(timer); await stopAll(nodes) })
    async function make(opts) {
        const node = await createAsscrackNode({ ...options, ...opts })
        nodes.push(node)
        return node
    }
    // Start with one full node so the chat circuit and the voice host are both the node we later stop.
    const primary = await make({ fullNode: true, listen: LOCAL })
    const a = await make({ fullNode: false, relayOnly: true })
    const b = await make({ fullNode: false, relayOnly: true })
    const endpoints = [a, b]
    const routes = []
    for (const node of endpoints) {
        recordRelays(node, routes)
        await node.connect(localAddr(primary))
    }
    await waitFor(() => allPairs(endpoints) && endpoints.every(n => n.host()?.peerId === primary.peerId),
        10000, 'primary host and chat circuit')
    assert.ok(routes.some(e => e.relay === primary.peerId))
    const alternate = await make({ fullNode: true, listen: LOCAL })
    for (const n of [primary, a, b]) await n.connect(localAddr(alternate))
    await waitFor(() => endpoints.every(n => n.fullNodes().includes(alternate.peerId)) &&
        alternate.host()?.peerId === primary.peerId, 10000, 'alternate attached without taking over')
    for (const node of endpoints) node.setVoice({ inVoice: true })
    await waitFor(() => primary.voiceStats().streams === 2, 10000, 'two voice streams on the primary')

    let phase = 0
    let serial = 0
    const audio = [[], []]
    const chat = [[], []]
    for (const [i, node] of endpoints.entries()) {
        const other = endpoints[1 - i]
        node.events.on('voice-frame', ({ origin, data }) => {
            if (origin === other.peerId && data.length === 4 && data[1] === 1 - i) {
                audio[i].push({ phase: data[0], serial: data[2] * 256 + data[3], at: performance.now() })
            }
        })
        node.events.on('live', message => {
            if (message.peerId === other.peerId && message.text.startsWith('after host loss ')) chat[i].push(message)
        })
    }
    timer = setInterval(() => {
        for (const [i, node] of endpoints.entries()) {
            node.sendVoiceFrame(Uint8Array.of(phase, i, serial >> 8, serial & 255))
            if (phase === 1 && serial % 10 === 0) node.sendRecord(`after host loss ${i} ${serial}`)
        }
        serial++
    }, 20)

    await waitFor(() => audio.every(list => list.length >= 5), 5000, 'voice in both directions before loss')
    function checkForwarding(relay) {
        const { forwardedTo } = relay.voiceStats()
        assert.ok(forwardedTo[a.peerId]?.[b.peerId] >= 5 && forwardedTo[b.peerId]?.[a.peerId] >= 5)
        for (const endpoint of endpoints) assert.equal(endpoint.voiceStats().directStreams, 0)
    }
    checkForwarding(primary)
    const loss = performance.now()
    await primary.stop()
    phase = 1  // No post-loss frame was generated while the old host was still running.
    await waitFor(() => endpoints.every(n => n.host()?.peerId === alternate.peerId) &&
        routes.some(e => e.relay === alternate.peerId) && chat.every(list => list.length > 0),
        15000, 'new host, new chat circuit and fresh two-way chat')
    await waitFor(() => audio.every(list => {
        const fresh = list.filter(f => f.phase === 1)
        return fresh.length >= 50 && fresh.at(-1).at - fresh[0].at >= 1000
    }), 15000, 'sustained new voice in both directions')
    checkForwarding(alternate)
    for (const [i, list] of audio.entries()) {
        const fresh = list.filter(f => f.phase === 1)
        assert.ok(fresh.every((f, j) => j === 0 || f.serial > fresh[j - 1].serial))
        console.log(`127.0.0.1 ${1 - i}->${i}: first fresh frame ${Math.round(fresh[0].at - loss)} ms after stop began; ` +
            `${fresh.length} fresh frames over ${Math.round(fresh.at(-1).at - fresh[0].at)} ms, ${chat[i].length} fresh live chat lines`)
    }
})
