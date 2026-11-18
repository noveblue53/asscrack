import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAsscrackNode, dialReason } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

// All results of this file are 127.0.0.1 results, not LAN results.
const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const sleep = ms => new Promise(r => setTimeout(r, ms))
// One regular expression for each connection log line (the parser of a field analysis script).
const LINE_RE = /^conn (session|closed|dial-failed)((?: [a-z]+=(?:"(?:[^"\\]|\\.)*"|[^\s"=]+))+)$/

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

function captureConsole() {
    const lines = []
    const old = { info: console.info, warn: console.warn }
    console.info = (...a) => { lines.push(a.join(' ')); }
    console.warn = (...a) => { lines.push(a.join(' ')); }
    return { lines, restore() { console.info = old.info; console.warn = old.warn } }
}

function record(node, name) {
    const list = []
    node.events.on(name, d => list.push(d))
    return list
}

test('connection log: a direct session', { timeout: 30000 }, async () => {
    const cap = captureConsole()
    const nodes = []
    try {
        const room = `cl-${Date.now()}`
        const A = await createAsscrackNode({ room, listen: LOCAL, discovery: false, ...fast })
        nodes.push(A)
        const B = await createAsscrackNode({ room, listen: LOCAL, discovery: false, ...fast })
        nodes.push(B)
        const ea = record(A, 'connection')
        const eb = record(B, 'connection')
        await A.connect(localAddr(B))
        await waitFor(() => ea.length > 0 && eb.length > 0, 10000, 'connection events')
        assert.deepEqual([ea[0].type, ea[0].dir, ea[0].peer, ea[0].state], ['direct', 'out', B.peerId, 'session'])
        assert.deepEqual([eb[0].type, eb[0].dir, eb[0].peer], ['direct', 'in', A.peerId])
        const sess = cap.lines.filter(l => l.startsWith('conn session'))
        assert.equal(sess.length, 2)
        for (const l of sess) {
            assert.match(l, / type=direct /)
            assert.match(l, LINE_RE)
        }
        await A.stop()
        await waitFor(() => eb.some(e => e.state === 'closed'), 10000, 'closed event')
        const closed = eb.find(e => e.state === 'closed')
        assert.equal(closed.type, 'direct')
        assert.ok(Number.isFinite(closed.secs))
        const cl = cap.lines.find(l => l.startsWith('conn closed'))
        assert.match(cl, LINE_RE)
        assert.match(cl, / secs=\d+(\.\d)?$/)
        cap.restore()
        console.log('example:', sess[0])
        console.log('example:', cl)
    } finally {
        cap.restore()
        await Promise.allSettled(nodes.map(n => n.stop()))
    }
})

test('connection log: a relay session', { timeout: 60000 }, async () => {
    const cap = captureConsole()
    const nodes = []
    try {
        const room = `cl-${Date.now()}-${Math.random().toString(16).slice(2)}`
        const roomKey = newRoomKey()
        const R = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: true, ...fast })
        nodes.push(R)
        const A = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast })
        nodes.push(A)
        const B = await createAsscrackNode({ room, roomKey, relayOnly: true, fullNode: false, ...fast })
        nodes.push(B)
        const ea = record(A, 'connection')
        const eb = record(B, 'connection')
        await A.connect(localAddr(R))
        await B.connect(localAddr(R))
        await waitFor(() => ea.some(e => e.peer === B.peerId) && eb.some(e => e.peer === A.peerId), 20000, 'A-B session through R')
        for (const [list, other] of [[ea, B], [eb, A]]) {
            const e = list.find(x => x.peer === other.peerId && x.state === 'session')
            assert.equal(e.type, 'relay')
            assert.equal(e.relay, R.peerId)
            assert.ok(e.addr.includes('/p2p-circuit'))
        }
        const toR = ea.find(x => x.peer === R.peerId)
        assert.equal(toR.type, 'direct')
        assert.equal(toR.relay, undefined)
        const rl = cap.lines.filter(l => l.startsWith('conn session') && l.includes('type=relay'))
        assert.equal(rl.length, 2)
        for (const l of rl) {
            assert.match(l, LINE_RE)
            assert.ok(l.includes(` relay=${R.peerId} `))
        }
        cap.restore()
        console.log('example:', rl[0])
    } finally {
        cap.restore()
        await Promise.allSettled(nodes.map(n => n.stop()))
    }
})

test('connection log: a failed dial to a port with no listener', { timeout: 30000 }, async () => {
    const cap = captureConsole()
    const nodes = []
    try {
        const room = `cl-${Date.now()}`
        const probe = await createAsscrackNode({ room, listen: LOCAL, discovery: false, ...fast })
        const addr = localAddr(probe).replace(/\/p2p\/.*$/, '')
        await probe.stop()
        const A = await createAsscrackNode({ room, listen: LOCAL, discovery: false, ...fast })
        nodes.push(A)
        const ef = record(A, 'dial-failed')
        await assert.rejects(A.connect(addr))
        assert.equal(ef.length, 1)
        assert.equal(ef[0].via, 'connect')
        assert.equal(ef[0].reason, 'refused')
        assert.equal(ef[0].peer, '?')
        assert.equal(ef[0].addr, addr)
        assert.ok(ef[0].error.length <= 200)
        const l = cap.lines.find(x => x.startsWith('conn dial-failed'))
        assert.ok(l, 'a dial-failed line')
        assert.match(l, / reason=refused /)
        assert.match(l, LINE_RE)
        cap.restore()
        console.log('example:', l)
    } finally {
        cap.restore()
        await Promise.allSettled(nodes.map(n => n.stop()))
    }
})

test('connection log: the reason class of a failed dial', () => {
    const err = (props, message = 'x') => Object.assign(new Error(message), props)
    assert.equal(dialReason(err({ code: 'ECONNREFUSED' })), 'refused')
    assert.equal(dialReason(err({ name: 'AbortError' })), 'timeout')
    assert.equal(dialReason(err({ name: 'TimeoutError' })), 'timeout')
    assert.equal(dialReason(err({ code: 'ETIMEDOUT' })), 'timeout')
    assert.equal(dialReason(err({ code: 'EHOSTUNREACH' })), 'unreachable')
    assert.equal(dialReason(err({ code: 'ENETUNREACH' })), 'unreachable')
    assert.equal(dialReason(err({ name: 'UnexpectedPeerError' })), 'wrong-peer')
    assert.equal(dialReason(err({}, 'failed to connect via relay with status NO_RESERVATION')), 'no-reservation')
    assert.equal(dialReason(err({}, 'something else')), 'other')
    assert.equal(dialReason(null), 'other')
    assert.equal(dialReason('a string'), 'other')
    // Nested: an AggregateError and a cause.
    assert.equal(dialReason(new AggregateError([err({}, 'a'), err({ code: 'ECONNREFUSED' })], 'All promises were rejected')), 'refused')
    assert.equal(dialReason(err({ cause: err({ code: 'EHOSTUNREACH' }) })), 'unreachable')
})
