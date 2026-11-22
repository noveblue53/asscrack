// Diagnostics metric of rank 6 (work-orders/diagnostics-20261122/REVIEW.md): the failover time. From the loss of the
// host to the new host, then to the first voice frame and to the first chat line. Real libp2p nodes on 127.0.0.1
// (127.0.0.1 results, not LAN results).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { createElection } from '../src/network/election.mjs'
import { createJournal } from '../src/application/journal.mjs'
import { journalNodeEvents } from '../src/application/diag-events.mjs'

const timing = { room: 'Failover room', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false, heartbeatInterval: 100,
    hostTimeout: 700, electionDelay: 350 }

async function waitUntil(check, limit, what) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        if (check()) return
        await delay(20)
    }
    assert.ok(check(), `${what}: not true within ${limit} ms`)
}

const agree = nodes => nodes.every(n => n.host() !== null && n.host().peerId === nodes[0].host()?.peerId && n.host().term === nodes[0].host().term)

test('127.0.0.1: a stopped host gives one failover line with the time to the new host, to voice and to chat', { timeout: 60000 }, async t => {
    const nodes = []
    for (let i = 0; i < 3; i++) nodes.push(await createAsscrackNode({ ...timing, name: `N${i}` }))
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        await nodes[i].connect(nodes[j].getMultiaddrs()[0])
        await waitUntil(() => nodes[i].peers().includes(nodes[j].peerId) && nodes[j].peers().includes(nodes[i].peerId), 5000, 'session')
    }
    await waitUntil(() => agree(nodes), 5000, 'one host')
    for (const n of nodes) n.setVoice({ inVoice: true })
    const old = nodes.find(n => n.isHost())
    const others = nodes.filter(n => n !== old)
    const journals = []
    const events = new Map(others.map(n => [n, []]))
    for (const n of others) {
        const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-diag-failover-'))
        t.after(() => rmSync(dir, { recursive: true, force: true }))
        const journal = createJournal({ dir, budgets: { default: [1e6, 0] } })
        journalNodeEvents((type, fn) => n.events.on(type, fn), (type, fields) => journal.write(type, fields), n.peerId)
        journals.push({ dir, journal })
        n.events.on('failover', data => events.get(n).push(data))
    }
    // Each member sends a voice frame each 40 ms, as a speaking person does.
    const sender = setInterval(() => { for (const n of others) n.sendVoiceFrame(new Uint8Array([1, 2, 3])) }, 40)
    t.after(() => clearInterval(sender))
    await delay(300)
    const stoppedAt = Date.now()
    await old.stop()
    await waitUntil(() => agree(others) && others[0].host().peerId !== old.peerId, 10000, 'new host')
    await delay(300)
    others[0].send('back again')
    await waitUntil(() => others.every(n => events.get(n).length === 1), 10000, 'one failover event on each member')
    clearInterval(sender)

    for (const n of others) {
        const [f] = events.get(n)
        assert.equal(f.lost, old.peerId)
        assert.equal(f.host, others[0].host().peerId)
        assert.equal(f.term, others[0].host().term)
        assert.equal(f.self, f.host === n.peerId)
        assert.equal(f.end, 'done')
        assert.equal(f.inVoice, true)
        assert.ok(['timeout', 'closed'].includes(f.reason), `reason ${f.reason}`)
        assert.ok(Number.isInteger(f.hostMs) && f.hostMs >= 0 && f.hostMs <= Date.now() - stoppedAt, `hostMs ${f.hostMs}`)
        assert.ok(Number.isInteger(f.voiceMs) && f.voiceMs >= f.hostMs, `voiceMs ${f.voiceMs} hostMs ${f.hostMs}`)
        assert.ok(Number.isInteger(f.chatMs) && f.chatMs >= 0, `chatMs ${f.chatMs}`)
    }
    for (const { dir, journal } of journals) {
        journal.flushSync()
        const lines = readdirSync(dir).filter(name => name.endsWith('.jsonl'))
            .flatMap(name => readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)).map(line => JSON.parse(line))
        const failover = lines.filter(line => line.type === 'failover')
        assert.equal(failover.length, 1)
        assert.equal(failover[0].lost, old.peerId)
        assert.ok(Number.isInteger(failover[0].hostMs) && Number.isInteger(failover[0].voiceMs) && Number.isInteger(failover[0].chatMs))
    }
})

test('127.0.0.1: with no chat line and no voice, the failover line comes at the wait limit with the host time only', { timeout: 30000 }, async t => {
    const nodes = []
    for (let i = 0; i < 3; i++) nodes.push(await createAsscrackNode({ ...timing, name: `M${i}`, failoverWaitMs: 2500 }))
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        await nodes[i].connect(nodes[j].getMultiaddrs()[0])
        await waitUntil(() => nodes[i].peers().includes(nodes[j].peerId) && nodes[j].peers().includes(nodes[i].peerId), 5000, 'session')
    }
    await waitUntil(() => agree(nodes), 5000, 'one host')
    const old = nodes.find(n => n.isHost())
    const others = nodes.filter(n => n !== old)
    const events = []
    others[0].events.on('failover', data => events.push(data))
    await old.stop()
    await waitUntil(() => events.length === 1, 10000, 'failover event at the wait limit')
    assert.equal(events[0].end, 'timeout')
    assert.equal(events[0].inVoice, false)
    assert.ok(Number.isInteger(events[0].hostMs))
    assert.equal(events[0].voiceMs, undefined)
    assert.equal(events[0].chatMs, undefined)
})

test('the election reports the loss of the host with its reason (a closed session of the host)', () => {
    const lost = []
    const peers = new Set(['b', 'c'])
    const e = createElection({ selfId: 'a', sendTo: () => {}, broadcast: () => {}, openPeers: () => [...peers],
        onLost: info => lost.push(info), hostTimeout: 1000 })
    e.handleAnnouncement('b', { host: 'b', term: 3 })
    e.sessionClosed('b')
    assert.deepEqual(lost, [{ peerId: 'b', term: 3, reason: 'closed' }])
    e.stop()
})
