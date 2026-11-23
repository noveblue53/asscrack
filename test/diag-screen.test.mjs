// Diagnostics metric of rank 9 (work-orders/diagnostics-20261122/REVIEW.md): the tier changes of the screen rate control
// with the reason, and the stats of each viewer each 10 s (the test uses a shorter interval). No line for each frame.
// Real libp2p nodes on 127.0.0.1 (127.0.0.1 results, not LAN results).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { SCREEN_DEFAULTS } from '../src/network/screen-share.mjs'
import { createJournal } from '../src/application/journal.mjs'
import { journalNodeEvents } from '../src/application/diag-events.mjs'

const LOCAL = ['/ip4/127.0.0.1/tcp/0']
const fast = { heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await sleep(20)
    }
    throw new Error(`timeout: ${what}`)
}

test('the stats interval of the screen journal is 10 s', () => {
    assert.equal(SCREEN_DEFAULTS.diagMs, 10000)
})

test('127.0.0.1: the journal of the sharer has each tier change with its reason and the viewer stats, and no frame lines', { timeout: 30000 }, async t => {
    const room = `diag-screen-${Date.now()}`
    const roomKey = newRoomKey()
    const A = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast, screen: { diagMs: 400 } })
    const B = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast })
    const C = await createAsscrackNode({ room, roomKey, listen: LOCAL, discovery: false, fullNode: false, ...fast })
    t.after(() => Promise.allSettled([A, B, C].map(n => n.stop())))
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-diag-screen-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const journal = createJournal({ dir, budgets: { default: [1e6, 0] } })
    t.after(() => journal.close())
    journalNodeEvents((type, fn) => A.events.on(type, fn), (type, fields) => journal.write(type, fields), A.peerId)
    for (const X of [B, C]) {
        await X.connect(A.getMultiaddrs().find(m => m.startsWith('/ip4/127.0.0.1/')))
        await waitFor(() => A.peers().includes(X.peerId) && X.peers().includes(A.peerId), 10000, 'session')
    }

    // The window side of the sharer: the size of each new preset, then frames at 15 fps.
    const tiers = new Map()
    A.events.on('screen-encoder', e => {
        for (const tier of e.tiers) {
            if (tiers.get(tier.tier) !== tier.preset) {
                tiers.set(tier.tier, tier.preset)
                A.setScreenSize({ tier: tier.tier, width: tier.width, height: tier.height })
            }
        }
    })
    let n = 0
    const frames = setInterval(() => {
        for (const tier of tiers.keys()) A.sendScreenFrame({ tier, key: n === 0, timestampMs: n * 66, data: randomBytes(800) })
        n++
    }, 66)
    t.after(() => clearInterval(frames))
    const { shareId } = A.startScreenShare({ preset: 'auto', width: 1920, height: 1080 })
    await waitFor(() => B.screenState().peers[A.peerId] && C.screenState().peers[A.peerId], 3000, 'B and C know the share')
    await B.watchScreen(A.peerId)
    await C.watchScreen(A.peerId)
    await sleep(900)
    // A slow viewer (test hook of check 13a) gives a second tier, and its return ends that tier: two tier changes with
    // their reasons.
    A.screenTestRate().forceSlow(C.peerId)
    await sleep(500)
    A.screenTestRate().forceSlow(C.peerId, false)
    await sleep(500)
    A.stopScreenShare()
    clearInterval(frames)
    await journal.flush()
    journal.flushSync()

    const lines = readdirSync(dir).filter(name => name.endsWith('.jsonl'))
        .flatMap(name => readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)).map(line => JSON.parse(line))
        .filter(line => line.type === 'screen')
    const tierLines = lines.filter(line => line.event === 'tier')
    const stats = lines.filter(line => line.event === 'stats')
    const summary = JSON.stringify(tierLines.map(({ why, role, tierId }) => ({ why, role, tierId })))
    const fastTier = tierLines.find(line => line.why === 'new' && line.role === 'fast')
    assert.ok(fastTier && Number.isInteger(fastTier.tierId) && fastTier.to === 'standard', `the first tier: ${summary}`)
    const slow = tierLines.find(line => line.why === 'new' && line.role === 'slow')
    assert.ok(slow && slow.tierId !== fastTier.tierId, `the slow tier: ${summary}`)
    assert.ok(tierLines.some(line => line.why === 'end' && line.role === 'slow' && line.tierId === slow.tierId), `the end of the slow tier: ${summary}`)
    assert.ok(tierLines.every(line => Number.isInteger(line.agoMs) && line.agoMs >= 0), 'the age of each change at the drain')
    assert.ok(tierLines.every(line => line.share === shareId))
    assert.ok(stats.length >= 4 && stats.length <= 16, `stats lines ${stats.length}: one each interval for each viewer`)
    assert.deepEqual([...new Set(stats.map(line => line.peer))].sort(), [B.peerId, C.peerId].sort())
    for (const line of stats) {
        assert.equal(line.share, shareId)
        for (const field of ['rate', 'target', 'drops', 'kframes', 'congestions', 'queueBytes']) assert.ok(Number.isInteger(line[field]), `${field} ${line[field]}`)
        assert.equal(typeof line.circuit, 'boolean')
    }
    assert.ok(n > 20, `frames sent ${n}`)
    assert.ok(lines.length < 30, `no line for each frame (${lines.length} screen lines for ${n} frames)`)
})
