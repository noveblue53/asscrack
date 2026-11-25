import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

// All results of this file are 127.0.0.1 results, not LAN results.
// Each case calls connect() while mDNS discovery runs. The race is timing-dependent, thus each case runs
// several rounds with different delays before connect().

const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const ROUNDS = 4
const DELAYS = [0, 50, 150, 300]
const SETTLE_MS = 1500
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

function record(node) {
    const log = { joined: [], left: [], messages: [], discovered: [] }
    node.events.on('peer-joined', e => log.joined.push(e.peerId))
    node.events.on('peer-left', e => log.left.push(e.peerId))
    node.events.on('message', e => log.messages.push(e.text))
    node.events.on('peer-discovered', e => log.discovered.push(e.peerId))
    return log
}

// Two nodes in one new room with discovery on. Returns them as lo (lower peer ID) and hi (higher peer ID).
async function pair(nodes, roomKey) {
    const room = `race-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
    const opts = { room, listen: LOCAL, discovery: true, discoveryInterval: 200, ...(roomKey ? { roomKey } : {}), ...fast }
    const a = await createAsscrackNode(opts)
    nodes.push(a)
    const logA = record(a)
    const b = await createAsscrackNode(opts)
    nodes.push(b)
    const logB = record(b)
    return a.peerId < b.peerId
        ? { lo: a, hi: b, logLo: logA, logHi: logB }
        : { lo: b, hi: a, logLo: logB, logHi: logA }
}

// callers: the nodes that call connect() to the other node, all at the same time.
async function race(who, { roomKey = null, round }) {
    const nodes = []
    try {
        const p = await pair(nodes, roomKey)
        const { lo, hi, logLo, logHi } = p
        const callers = who === 'both' ? [lo, hi] : who === 'lo' ? [lo] : [hi]
        await sleep(DELAYS[round % DELAYS.length])
        const results = await Promise.allSettled(callers.map(n => n.connect(localAddr(n === lo ? hi : lo))))
        for (const r of results) assert.equal(r.status, 'fulfilled', `connect() does not throw: ${r.reason?.stack ?? ''}`)
        await waitFor(() => lo.peers().includes(hi.peerId) && hi.peers().includes(lo.peerId), 15000, 'a session on both nodes')
        await sleep(SETTLE_MS)
        assert.ok(logLo.discovered.includes(hi.peerId) || logHi.discovered.includes(lo.peerId), 'discovery ran')
        assert.deepEqual(lo.peers(), [hi.peerId], 'lo has exactly one session')
        assert.deepEqual(hi.peers(), [lo.peerId], 'hi has exactly one session')
        assert.deepEqual(logLo.left, [], 'lo gets no peer-left')
        assert.deepEqual(logHi.left, [], 'hi gets no peer-left')
        assert.deepEqual(logLo.joined, [hi.peerId], 'lo gets one peer-joined')
        assert.deepEqual(logHi.joined, [lo.peerId], 'hi gets one peer-joined')
        assert.equal(lo.send(`from-lo-${round}`), 1)
        assert.equal(hi.send(`from-hi-${round}`), 1)
        await waitFor(() => logHi.messages.includes(`from-lo-${round}`) && logLo.messages.includes(`from-hi-${round}`),
            5000, 'a line from each side arrives at the other side')
        assert.deepEqual(logLo.left, [], 'lo gets no peer-left after the lines')
        assert.deepEqual(logHi.left, [], 'hi gets no peer-left after the lines')
    } finally {
        await Promise.allSettled(nodes.map(n => n.stop()))
    }
}

describe('connect race', { concurrency: true }, () => {
    test('connect race: the lower peer ID calls connect() while discovery runs', { timeout: 120000 }, async () => {
        for (let round = 0; round < ROUNDS; round++) await race('lo', { round })
    })

    test('connect race: the higher peer ID calls connect() while discovery runs', { timeout: 120000 }, async () => {
        for (let round = 0; round < ROUNDS; round++) await race('hi', { round })
    })

    test('connect race: both nodes call connect() to each other while discovery runs', { timeout: 120000 }, async () => {
        for (let round = 0; round < ROUNDS; round++) await race('both', { round })
    })

    test('connect race: keyed room, both nodes call connect() to each other while discovery runs', { timeout: 120000 }, async () => {
        for (let round = 0; round < ROUNDS; round++) await race('both', { roomKey: newRoomKey(), round })
    })
})
