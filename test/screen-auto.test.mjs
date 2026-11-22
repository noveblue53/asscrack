// W2 checks C 16 to 24 of work-orders/astra/P8/DESIGN.md (revision 2): the Auto mode on real nodes. The synthetic
// encoder replays the frame sizes of each preset (screen-auto-traces.json) with rule E3 and a full bucket. A proxy
// gives each circuit viewer a link with a rate that changes during the run. The method of scratch/proto/auto-bench.mjs.
// All results are 127.0.0.1 results on one computer. They are not LAN results.
// `npm test` skips this file (it takes about 8 minutes). Run: node --test test/screen-auto.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TIMED_SKIP, presetIndex, runScreenScenario, summary, tierTrack, voiceIn } from './helpers/screen-bench.mjs'
import { SCREEN_PRESETS } from '../src/network/screen-rate.mjs'

const auto = { quality: 'auto', source: { width: 2560, height: 1440 }, sizes: 'traces', scene: 'motion', baselineSeconds: 5, relayLimit: 6000000 }
const opts = seconds => ({ skip: TIMED_SKIP, timeout: (seconds + 60) * 1000 })
const avg = list => list.length ? list.reduce((a, x) => a + x, 0) / list.length : 0
const secondsFrom = (v, fromS, toS = v.perSecond.length - 1) => v.perSecond.slice(fromS, toS)
const allVoice = r => r.viewers.forEach(v => assert.equal(v.voice.received, r.voiceSent, `each voice frame arrives at viewer ${v.index}`))
const firstAt = (track, test) => track.find(test)?.atMs ?? null
const steps = r => r.history.filter(h => h.from).map(h => `${(h.t / 1000).toFixed(1)}s ${h.role} ${h.from}>${h.to} (${h.why})`).join(', ')

test('check 16 (X2): two circuit viewers with no relay part, viewer 2 at 2 Mbit/s', opts(45), async () => {
    const r = await runScreenScenario({ ...auto, name: 'C16 X2', relayLimit: null, seconds: 45,
        viewers: [{ route: 'circuit' }, { route: 'circuit', down: [[0, 2]] }] })
    console.log(summary(r))
    console.log(`steps: ${steps(r)}`)
    const [v1, v2] = r.viewers
    const t1 = tierTrack(r, v1.peerId)
    const t2 = tierTrack(r, v2.peerId)
    console.log(`viewer 1: max at ${firstAt(t1, x => x.preset === 'max')} ms; viewer 2: slow at ${firstAt(t2, x => x.role === 'slow')} ms`)
    assert.ok(t1.some(x => x.preset === 'max'), 'viewer 1 reaches max')
    const last15 = secondsFrom(v1, 30, 45)
    assert.ok(avg(last15) >= 55, `viewer 1: ${avg(last15).toFixed(1)} frames each second in the last 15 s`)
    const after = t2.filter(x => x.atMs >= 15000)
    assert.ok(after.length > 0 && after.every(x => x.role === 'slow'), 'viewer 2 is in the slow tier after 15 s')
    allVoice(r)
    globalThis.check16 = { v1kbit: avg(v1.kbitPerSecond.slice(30, 45)), v1fps: avg(last15) }
})

test('check 17 (X3): the same with a fixed preset (one encoder)', opts(45), async () => {
    const r = await runScreenScenario({ ...auto, quality: 'max', name: 'C17 X3 fixed max', relayLimit: null, seconds: 45,
        viewers: [{ route: 'circuit' }, { route: 'circuit', down: [[0, 2]] }] })
    console.log(summary(r))
    const [v1, v2] = r.viewers
    const t1 = tierTrack(r, v1.peerId)
    const t2 = tierTrack(r, v2.peerId)
    // Rule R6: one tier, thus one bitrate for both viewers.
    assert.ok(t1.every((x, i) => x.tier === t2[i].tier), 'one tier for both viewers')
    const k1 = avg(v1.kbitPerSecond.slice(30, 45))
    const k2 = avg(v2.kbitPerSecond.slice(30, 45))
    console.log(`last 15 s: viewer 1 ${k1.toFixed(0)} kbit/s, viewer 2 ${k2.toFixed(0)} kbit/s; check 16 viewer 1: ${JSON.stringify(globalThis.check16 ?? null)}`)
    assert.ok(Math.abs(k1 - k2) <= 0.25 * k2, 'viewer 1 gets the bitrate of viewer 2')
    if (globalThis.check16) assert.ok(globalThis.check16.v1kbit > k1, 'with Auto, viewer 1 gets more than with one encoder')
})

test('check 18 (X1): one circuit viewer, link 20, 3, 20 Mbit/s', opts(75), async () => {
    const r = await runScreenScenario({ ...auto, name: 'C18 X1', seconds: 75, viewers: [{ route: 'circuit', down: [[0, 20], [25, 3], [50, 20]] }] })
    console.log(summary(r))
    console.log(`steps: ${steps(r)}`)
    const [v] = r.viewers
    const track = tierTrack(r, v.peerId)
    const mid = track.filter(x => x.atMs >= 33000 && x.atMs < 50000)
    assert.ok(mid.every(x => presetIndex(x.preset) <= presetIndex('smooth')), 'smooth or lower 8 s after the drop to 3 Mbit/s')
    const worst = []
    for (let s = 30; s < 50; s++) worst.push(Math.max(0, ...voiceIn(v, s * 1000, (s + 1) * 1000)))
    console.log(`voice max of each second 30 s to 50 s: ${worst.map(Math.round).join(',')}`)
    assert.ok(worst.every(x => x <= 150), 'voice delay at most 150 ms in each second after the first 5 s of the 3 Mbit/s part')
    const last = track.filter(x => x.atMs >= 65000)
    assert.ok(last.length > 0 && last.every(x => x.preset === 'balanced'), 'balanced (the relay part) 15 s after the link came back')
})

test('check 19 (X4): viewer 2 link 6 and 2 Mbit/s in turn each 10 s', opts(90), async () => {
    const r = await runScreenScenario({ ...auto, name: 'C19 X4', seconds: 90,
        viewers: [{ route: 'circuit' }, { route: 'circuit', down: [[0, 6], [20, 2], [30, 6], [40, 2], [50, 6], [60, 2], [70, 6], [80, 2]] }] })
    console.log(summary(r))
    console.log(`steps: ${steps(r)}`)
    const [v1, v2] = r.viewers
    const seconds = secondsFrom(v1, 15, 89)
    assert.ok(Math.min(...seconds) >= 28, `viewer 1 worst second after 15 s: ${Math.min(...seconds)} frames`)
    const t1 = tierTrack(r, v1.peerId).filter(x => x.tier !== null)
    assert.ok(t1.every(x => x.tier === t1[0].tier), 'viewer 1 never changes its tier')
    const changes = []
    const t2 = tierTrack(r, v2.peerId).filter(x => x.tier !== null)
    for (let i = 1; i < t2.length; i++) if (t2[i].tier !== t2[i - 1].tier) changes.push(t2[i].atMs)
    console.log(`viewer 2 tier changes at: ${changes.join(', ')} ms`)
    for (let from = 0; from < 90000; from += 20000) {
        const n = changes.filter(t => t >= from && t < from + 20000).length
        assert.ok(n <= 2, `viewer 2: ${n} tier changes from ${from / 1000} s to ${from / 1000 + 20} s`)
    }
})

test('check 20 (X6): two circuit viewers, sharer uplink 5 Mbit/s', opts(45), async () => {
    const r = await runScreenScenario({ ...auto, name: 'C20 X6', seconds: 45, sharerUp: [[0, 5]], viewers: [{ route: 'circuit' }, { route: 'circuit' }] })
    console.log(summary(r))
    console.log(`steps: ${steps(r)}`)
    for (const v of r.viewers) {
        const d = voiceIn(v, 10000).sort((a, b) => a - b)
        const p95 = d[Math.floor((d.length - 1) * 0.95)]
        assert.ok(p95 <= 150, `viewer ${v.index}: voice p95 ${p95} ms after the first 10 s`)
    }
    allVoice(r)
    const sums = r.samples.filter(s => s.atMs >= 15000).map(s => s.viewers.reduce((a, v) => a + (s.tiers.find(t => t.tier === v.tier)?.bitrate ?? 0), 0))
    console.log(`largest sum of the tier bitrates after 15 s: ${Math.max(...sums)} bit/s`)
    assert.ok(sums.every(x => x <= 5000000), 'the sum of the tier bitrates is at most 5 Mbit/s after 15 s')
})

test('check 21 (X7): light content goes up by rule A4', opts(45), async () => {
    const r = await runScreenScenario({ ...auto, name: 'C21 X7 ide', scene: 'ide', seconds: 45, viewers: [{ route: 'circuit', down: [[0, 1.5]] }] })
    console.log(summary(r))
    console.log(`steps: ${steps(r)}`)
    const light = r.history.find(h => h.why === 'light')
    assert.ok(light, 'a step by rule A4')
    // The preset that the rate permits (the test of rule A3) at the time of the step.
    const byRate = SCREEN_PRESETS.reduce((p, preset, i) => i > 0 && light.bitrate >= 0.7 * preset.bitrate ? i : p, 0)
    assert.ok(presetIndex(light.to) > byRate, `the step to ${light.to} at ${light.bitrate} bit/s is above ${SCREEN_PRESETS[byRate].id}`)
})

test('check 22 (X10): a direct viewer and a circuit viewer, sharer uplink 8 Mbit/s', opts(45), async () => {
    const r = await runScreenScenario({ ...auto, name: 'C22 X10', seconds: 45, sharerUp: [[0, 8]], viewers: [{ route: 'direct' }, { route: 'circuit' }] })
    console.log(summary(r))
    console.log(`steps: ${steps(r)}`)
    for (const v of r.viewers) assert.ok(v.voice.share.p95 <= 200, `viewer ${v.index}: voice p95 ${v.voice.share.p95} ms`)
    allVoice(r)
})

test('check 23 (X9): one circuit viewer, link 20, then 1 Mbit/s at 25 s', opts(45), async () => {
    const r = await runScreenScenario({ ...auto, name: 'C23 X9', seconds: 45, viewers: [{ route: 'circuit', down: [[0, 20], [25, 1]] }] })
    console.log(summary(r))
    console.log(`steps: ${steps(r)}`)
    const [v] = r.viewers
    const track = tierTrack(r, v.peerId).filter(x => x.atMs >= 33000)
    assert.ok(track.length > 0 && track.every(x => x.preset === 'standard'), 'standard 8 s after the drop')
    const worst = []
    for (let s = 31; s < 45; s++) worst.push(Math.max(0, ...voiceIn(v, s * 1000, (s + 1) * 1000)))
    console.log(`voice max of each second from 31 s: ${worst.map(Math.round).join(',')}`)
    assert.ok(worst.every(x => x <= 200), 'the largest voice delay of each second from 6 s after the drop is at most 200 ms')
    allVoice(r)
})

test('check 24 (X8): one direct viewer with no limit', opts(40), async () => {
    const r = await runScreenScenario({ ...auto, name: 'C24 X8', seconds: 40, viewers: [{ route: 'direct' }] })
    console.log(summary(r))
    console.log(`steps: ${steps(r)}`)
    const [v] = r.viewers
    const at = firstAt(tierTrack(r, v.peerId), x => x.preset === 'max')
    console.log(`max at ${at} ms`)
    assert.ok(at !== null && at <= 30000, 'max in 30 s')
    const after = secondsFrom(v, Math.ceil(at / 1000) + 2, 40)
    assert.ok(after.length > 0 && avg(after) >= 57, `${avg(after).toFixed(1)} frames each second after max`)
})
