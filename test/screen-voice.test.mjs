// W2 checks B 7 to 15 of work-orders/astra/P8/DESIGN.md (revision 2): the screen share and the voice priority on
// real nodes. A fixed preset (Standard), the frame sizes of the measured VP8 streams at 15 frames each second.
// All results are 127.0.0.1 results on one computer (a proxy limits a link). They are not LAN results.
// `npm test` skips this file (it takes about 8 minutes). Run: node --test test/screen-voice.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TIMED_SKIP, runScreenScenario, summary } from './helpers/screen-bench.mjs'

const standard = { quality: 'standard', source: { width: 1280, height: 720 }, sizes: 'frames', baselineSeconds: 10 }
const fullSeconds = v => v.perSecond.slice(1, -1)
const opts = seconds => ({ skip: TIMED_SKIP, timeout: (seconds + 60) * 1000 })

function sameRouteLimits(r) {
    const v = r.viewers[0]
    assert.ok(v.fps >= 14, `average ${v.fps} frames each second`)
    assert.ok(Math.min(...fullSeconds(v)) >= 10, `worst second ${Math.min(...fullSeconds(v))} frames`)
    assert.equal(r.sharerViewers[0].dropped, 0, 'no dropped frame')
    assert.ok(v.voice.share.p95 <= v.voice.baseline.p95 + 10, `voice p95 ${v.voice.share.p95} ms, baseline ${v.voice.baseline.p95} ms`)
    assert.ok(v.voice.gapMs.p95 < 40, `voice arrival gap p95 ${v.voice.gapMs.p95} ms`)
    assert.equal(v.voice.received, r.voiceSent, 'each voice frame arrives')
}

test('checks 7 and 8: circuit, no limit, motion, 60 s', opts(70), async () => {
    const r = await runScreenScenario({ ...standard, name: 'B7-8 circuit no limit motion', scene: 'motion', seconds: 60, viewers: [{ route: 'circuit' }] })
    console.log(summary(r))
    sameRouteLimits(r)
})

test('check 9: direct, no limit, motion, 60 s', opts(70), async () => {
    const r = await runScreenScenario({ ...standard, name: 'B9 direct no limit motion', scene: 'motion', seconds: 60, viewers: [{ route: 'direct' }] })
    console.log(summary(r))
    sameRouteLimits(r)
})

for (const [n, scene, maxMs] of [[10, 'motion', 400], [11, 'scroll', 400], [12, 'sheet', 1000]]) {
    test(`check ${n}: circuit, uplink 1 Mbit/s, ${scene}, 60 s`, opts(70), async () => {
        const r = await runScreenScenario({ ...standard, name: `B${n} circuit uplink 1 Mbit/s ${scene}`, scene, seconds: 60,
            sharerUp: [[0, 1]], viewers: [{ route: 'circuit' }] })
        console.log(summary(r))
        const v = r.viewers[0]
        assert.ok(v.voice.share.p95 <= 150, `voice p95 ${v.voice.share.p95} ms`)
        assert.ok(v.voice.share.max <= maxMs, `voice max ${v.voice.share.max} ms`)
        if (n === 10) {
            assert.equal(v.voice.received, r.voiceSent, 'each voice frame arrives')
            assert.ok(v.kbit >= 500, `screen ${v.kbit} kbit/s`)
        }
    })
}

test('check 13: circuit, uplink 3 Mbit/s, scroll, 40 s', opts(50), async () => {
    const r = await runScreenScenario({ ...standard, name: 'B13 circuit uplink 3 Mbit/s scroll', scene: 'scroll', seconds: 40,
        sharerUp: [[0, 3]], viewers: [{ route: 'circuit' }] })
    console.log(summary(r))
    const v = r.viewers[0]
    assert.ok(v.voice.share.p95 <= v.voice.baseline.p95 + 10, `voice p95 ${v.voice.share.p95} ms, baseline ${v.voice.baseline.p95} ms`)
    assert.ok(v.voice.share.max <= v.voice.baseline.max + 50, `voice max ${v.voice.share.max} ms, baseline ${v.voice.baseline.max} ms`)
})

test('check 14: two circuit viewers, viewer 2 does not read for 5 s', opts(40), async () => {
    const r = await runScreenScenario({ ...standard, name: 'B14 two circuit viewers, stall 5 s', scene: 'motion', seconds: 30,
        viewers: [{ route: 'circuit' }, { route: 'circuit', stall: { atMs: 8000, ms: 5000 } }] })
    console.log(summary(r))
    const [v1, v2] = r.viewers
    assert.ok(Math.min(...fullSeconds(v1)) >= 13, `viewer 1 worst second ${Math.min(...fullSeconds(v1))} frames`)
    const readAgain = v2.stallAtMs + 5000
    const key = v2.keyTimes.find(t => t >= readAgain)
    console.log(`viewer 2: keyframe ${key === undefined ? 'none' : key - readAgain} ms after it read again`)
    assert.ok(key !== undefined && key - readAgain <= 3000, 'viewer 2 gets a keyframe in 3 s')
})

test('check 15: two circuit viewers, viewer 2 does not read for 15 s', opts(40), async () => {
    const r = await runScreenScenario({ ...standard, name: 'B15 two circuit viewers, stall 15 s', scene: 'motion', seconds: 30,
        viewers: [{ route: 'circuit' }, { route: 'circuit', stall: { atMs: 8000, ms: 15000 } }] })
    console.log(summary(r))
    const [v1, v2] = r.viewers
    const end = r.ended.find(e => e.peerId === v2.peerId)
    assert.ok(end, 'the sharer ended viewer 2')
    assert.equal(end.reason, 'slow')
    const after = end.at - v2.stallAtMs
    console.log(`viewer 2: END slow ${after} ms after it stopped to read; at the viewer: ${JSON.stringify(v2.ended)}`)
    assert.ok(after >= 9000 && after <= 13000, `END slow ${after} ms after the stop`)
    assert.equal(v2.ended?.reason, 'slow', 'viewer 2 reads END slow')
    assert.ok(Math.min(...fullSeconds(v1)) >= 13, `viewer 1 worst second ${Math.min(...fullSeconds(v1))} frames`)
    const over = r.samples.flatMap(s => s.viewers.filter(v => v.peerId === v2.peerId && v.queueBytes > v.queueLimitBytes))
    assert.equal(over.length, 0, 'the queue of viewer 2 is never above the limit of rule T1')
})
