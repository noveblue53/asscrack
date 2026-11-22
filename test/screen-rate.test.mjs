// W2 checks A of work-orders/astra/P8/DESIGN.md (revision 2): the rate rules with a clock that the test controls.
// No network. These are results of the pure module on this PC, not LAN results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScreenRate, SCREEN_PRESETS, SCREEN_TYPE } from '../src/network/screen-rate.mjs'

// A small simulator: one synthetic encoder for each tier, the pacer each `step` ms, acks after a delay for each
// viewer, evaluate() each 500 ms, and an optional window report each 500 ms.
function sim({ quality = 'auto', source = null, params = {} } = {}) {
    let t = 0
    const ended = []
    const rate = createScreenRate({ quality, source, now: () => t, params, configRecord: () => Uint8Array.of(0, 0, 0, 1, SCREEN_TYPE.CONFIG),
        onEnd: (id, reason) => { ended.push({ id, reason, t }); rate.flush(id) } })
    const conf = new Map()
    const wire = new Map() // viewer -> records { type, key, seq, t }
    function parser(id) {
        let buf = Buffer.alloc(0)
        const list = []
        wire.set(id, list)
        return bytes => {
            buf = Buffer.concat([buf, Buffer.from(bytes)])
            while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
                const len = buf.readUInt32BE(0)
                const type = buf[4]
                list.push(type === SCREEN_TYPE.FRAME ? { type, key: (buf[5] & 1) === 1, seq: buf.readUInt32BE(6), t } : { type, t })
                buf = buf.subarray(4 + len)
            }
            return true
        }
    }
    function add(id, { circuit = false, delay = 5, send } = {}) {
        conf.set(id, { delay })
        const parse = parser(id)
        rate.addViewer(id, { circuit, send: bytes => { parse(bytes); return send ? send(bytes) : true } })
    }
    const readyAll = () => { for (const tr of rate.tiers()) if (!tr.ready) rate.setSize(tr.tier, tr.fitWidth, tr.fitHeight) }
    let nextFrameAt = 0
    let nextEvalAt = 500
    const defaults = { fps: 15, step: 2, frameBytes: tier => Math.round(tier.bitrate / 8 / 15), report: null }
    function run(ms, options = {}) {
        const o = { ...defaults, ...options }
        const end = t + ms
        while (t < end) {
            t += o.step
            readyAll()
            if (t >= nextFrameAt) {
                nextFrameAt += 1000 / o.fps
                for (const tier of rate.tiers()) {
                    const key = rate.takeKeyRequest(tier.tier)
                    const bytes = o.frameBytes(tier, key)
                    if (bytes > 0) rate.pushFrame(tier.tier, { key, timestampMs: t, data: new Uint8Array(bytes) })
                }
            }
            rate.tick()
            for (const v of rate.viewers()) {
                const c = conf.get(v.id)
                const delay = typeof c?.delay === 'function' ? c.delay(t) : c?.delay ?? 5
                for (const [seq, u] of [...v.unacked]) {
                    if (t - u.at >= delay) rate.onAck(v.id, seq)
                    else break
                }
            }
            if (t >= nextEvalAt) {
                nextEvalAt += 500
                if (o.report) rate.report(o.report(rate.tiers()))
                rate.evaluate()
            }
        }
    }
    return { rate, add, run, conf, wire, ended, now: () => t, set: ms => { t = ms }, v: id => rate.viewer(id), tier: () => rate.tiers()[0] }
}

test('check A1, rule R3: decrease, hold, a late viewer, and the smallest bitrate', () => {
    const s = sim({ quality: 'standard' })
    s.add('a')
    s.run(1000)
    const start = s.v('a').rate
    assert.ok(start >= 500000)
    // Excess above 70 ms: 0.8 x.
    s.conf.get('a').delay = 100
    const before = s.v('a').rate
    let first = null
    for (let i = 0; i < 300 && first === null; i++) {
        s.run(10)
        if (s.v('a').rate < before) first = s.now()
    }
    assert.ok(first !== null, 'a decrease came')
    assert.equal(s.v('a').rate, Math.max(300000, Math.round(0.8 * before)))
    // No second decrease from the excess in 1500 ms.
    const after = s.v('a').rate
    s.run(1400)
    assert.equal(s.v('a').rate, after)
    // A late viewer lowers it also in that time: no ack for base + 300 ms.
    s.conf.get('a').delay = 100
    s.run(1700)
    const held = s.v('a').rate
    s.conf.get('a').delay = Infinity
    s.run(1000)
    assert.ok(s.v('a').rate < held || s.v('a').rate === 300000, 'the late viewer lowered the bitrate')
    s.conf.get('a').delay = 100
    for (let i = 0; i < 30; i++) {
        s.run(500)
        assert.ok(s.v('a').rate >= 300000, 'never below 300 000')
    }
    assert.equal(s.v('a').rate, 300000)
    assert.ok(s.rate.history().length >= 0)
})

test('check A2, rule R4: hold after a decrease, the used rule, the factors and the limit', () => {
    const s = sim({ quality: 'max' })
    s.add('a')
    // No limit: 1.25 x after 2 calm periods with the stream at its bitrate.
    s.run(1000)
    assert.equal(s.v('a').rate, Math.round(500000 * 1.25))
    // Excess: a decrease, then no increase for 3000 ms.
    s.conf.get('a').delay = 100
    const top = s.v('a').rate
    while (s.v('a').rate >= top) s.run(10)
    const decreasedAt = s.now()
    const limit = s.v('a').limit
    assert.equal(limit, top)
    s.conf.get('a').delay = 5
    const low = s.v('a').rate
    while (s.v('a').rate === low && s.now() < decreasedAt + 6000) s.run(10)
    assert.ok(s.now() - decreasedAt >= 3000, `the first increase came ${s.now() - decreasedAt} ms after the decrease`)
    // Near the limit (0.8 x limit is at or above 0.75 x limit): 1.03.
    assert.equal(s.v('a').rate, Math.round(low * 1.03))
    // The limit goes away at 1.2 x limit.
    for (let i = 0; i < 80 && s.v('a').limit !== null; i++) s.run(500)
    assert.equal(s.v('a').limit, null)
    assert.ok(s.v('a').rate >= 1.2 * limit)
    // No increase when the stream uses less than 70 % of the bitrate.
    const u = sim({ quality: 'max' })
    u.add('a')
    u.run(5000, { frameBytes: tier => Math.round(0.3 * tier.bitrate / 8 / 15) })
    assert.equal(u.v('a').rate, 500000)
})

test('check A3, rule R5: the start bitrate and the targets for 1 to 6 circuit viewers', () => {
    for (let n = 1; n <= 6; n++) {
        const s = sim({ quality: 'max' })
        for (let i = 0; i < n; i++) s.add(`v${i}`, { circuit: true })
        const stats = s.rate.stats()
        for (const v of stats.viewers) {
            assert.equal(v.target, Math.min(12000000, Math.round(6000000 / n)))
            assert.equal(v.rate, 500000)
        }
    }
    const s = sim({ quality: 'standard' })
    s.add('d')
    assert.equal(s.rate.stats().viewers[0].target, 1500000)
    // A viewer that comes lowers the rate of the others to the new target.
    const r = sim({ quality: 'max' })
    r.add('a', { circuit: true })
    r.v('a').rate = 5000000
    r.add('b', { circuit: true })
    assert.equal(r.v('a').rate, 3000000)
})

test('check A4, rules T1 to T3: a late viewer gets no frame until no frame is open, then a keyframe', () => {
    const s = sim({ quality: 'standard' })
    s.add('a')
    s.run(3000)
    const v = s.v('a')
    const base = v.base
    assert.ok(base <= 10)
    s.conf.get('a').delay = Infinity
    const stallAt = s.now()
    s.run(400)
    assert.equal(v.recovering, true)
    assert.equal(v.needKey, true)
    const sent = v.sentFrames
    const lastSeq = s.wire.get('a').filter(r => r.type === SCREEN_TYPE.FRAME).at(-1).seq
    s.run(600)
    assert.equal(v.sentFrames, sent, 'no new frame while a frame is open')
    // Acks again: no ack delay sample in that time, then one keyframe request, then frames from the keyframe.
    s.conf.get('a').delay = 5
    s.run(20)
    assert.equal(v.unacked.size, 0)
    assert.equal(v.samples.length, 0, 'no ack delay sample from the late frames')
    assert.equal(v.base, base)
    s.run(3000)
    const frames = s.wire.get('a').filter(r => r.type === SCREEN_TYPE.FRAME && r.t > stallAt)
    const next = frames.find(f => f.seq > lastSeq)
    assert.ok(next, 'frames came again')
    assert.equal(next.key, true, 'the first frame after the drop is a keyframe')
    assert.ok(v.sentFrames > sent)
})

test('check A5: rule T4 (END slow after 10 s) and rule T5 (one keyframe each 2000 ms)', () => {
    const s = sim({ quality: 'standard' })
    s.add('a')
    s.add('b')
    s.run(2000)
    s.conf.get('b').delay = Infinity
    const stallAt = s.now()
    s.run(12000)
    assert.equal(s.ended.length, 1)
    assert.equal(s.ended[0].id, 'b')
    assert.equal(s.ended[0].reason, 'slow')
    const after = s.ended[0].t - stallAt
    assert.ok(after >= 10000 && after <= 11500, `END slow ${after} ms after the stall`)
    assert.ok(s.rate.has('a') && !s.rate.has('b'))
    // T5.
    const k = sim({ quality: 'standard' })
    k.add('a')
    const tier = k.tier().tier
    k.rate.setSize(tier, 1280, 720)
    assert.equal(k.rate.takeKeyRequest(tier), true)
    k.rate.requestKey(tier)
    k.rate.requestKey(tier)
    k.set(1999)
    assert.equal(k.rate.takeKeyRequest(tier), false)
    k.set(2000)
    assert.equal(k.rate.takeKeyRequest(tier), true)
    assert.equal(k.rate.takeKeyRequest(tier), false)
})

test('check A6, rule R1: the pacer bytes in each 100 ms with clock steps of 16 ms', () => {
    let t = 0
    const writes = []
    const rate = createScreenRate({ quality: 'standard', now: () => t, configRecord: () => Uint8Array.of(0, 0, 0, 1, 2) })
    for (const id of ['a', 'b', 'c']) rate.addViewer(id, { send: bytes => { writes.push({ t, n: bytes.length }); return true } })
    const tier = rate.tiers()[0]
    rate.setSize(tier.tier, 1280, 720)
    writes.length = 0
    for (let i = 0; i < 5; i++) rate.pushFrame(tier.tier, { key: i === 0, timestampMs: 0, data: new Uint8Array(i === 0 ? 60000 : 5000) })
    const bitrate = rate.tiers()[0].bitrate
    const limit = 1.25 * bitrate * 3 / 8 * 0.13
    let total = 0
    for (t = 16; t <= 3000; t += 16) total += rate.tick()
    assert.ok(total > 0)
    let worst = 0
    for (const w of writes) {
        const sum = writes.filter(x => x.t > w.t - 100 && x.t <= w.t).reduce((a, x) => a + x.n, 0)
        worst = Math.max(worst, sum)
    }
    assert.ok(worst <= limit + 1, `worst 100 ms: ${worst} bytes, limit ${limit}`)
    assert.ok(writes.every(w => w.n <= 2048), 'slices of at most 2048 bytes')
})

test('check A6a, rules A2 and A2b: only the viewer that sets the tier bitrate increases; the deep decrease', () => {
    const s = sim()
    s.add('a')
    s.add('b')
    s.v('b').rate = 800000
    s.run(1000)
    assert.equal(s.v('a').rate, 625000)
    assert.equal(s.v('b').rate, 800000)
    // A2b: a late viewer with a delivered rate of 2 Mbit/s and a rate of 6 Mbit/s goes to 1.4 Mbit/s.
    let t = 0
    const rate = createScreenRate({ quality: 'auto', now: () => t, configRecord: () => Uint8Array.of(0, 0, 0, 1, 2) })
    rate.addViewer('a', { send: () => true })
    const v = rate.viewer('a')
    v.rate = 6000000
    rate.evaluate()
    const tier = rate.tiers()[0].tier
    rate.setSize(tier, 1280, 720)
    assert.equal(rate.tiers()[0].bitrate, 6000000)
    const drain = until => { while (t < until) { t += 1; rate.tick(); for (const [seq, u] of [...v.unacked]) if (t - u.at >= 5 && t < 480) rate.onAck('a', seq) } }
    for (let k = 0; k < 10; k++) {
        t = Math.max(t, k * 50)
        rate.pushFrame(tier, { key: k === 0, timestampMs: t, data: new Uint8Array(25000 - 14) })
        drain(k * 50 + 45)
    }
    assert.equal(v.unacked.size, 0)
    t = 500
    rate.pushFrame(tier, { key: false, timestampMs: t, data: new Uint8Array(1000) })
    drain(520)
    t = 810
    rate.pushFrame(tier, { key: false, timestampMs: t, data: new Uint8Array(1000) })
    assert.equal(v.congested, true)
    rate.evaluate()
    assert.equal(v.rate, 1400000)
})

// A direct viewer that reaches a rate of `bitrate` at once (the test sets the rate), with calm acks.
function autoAt(bitrate, options = {}) {
    const s = sim(options)
    s.add('a')
    s.v('a').rate = bitrate
    return s
}

test('check A6a, rule A3: up after 2000 ms at 0.7 x the next bitrate, not above the cap, the slow tier not above the fast tier', () => {
    let t = 0
    const rate = createScreenRate({ quality: 'auto', now: () => t, configRecord: () => Uint8Array.of(0, 0, 0, 1, 2) })
    rate.addViewer('a', { send: () => true })
    rate.viewer('a').rate = 0.7 * 3000000
    // Rule U1 (revision 3): no step up in the first 10 s of a viewer (no measured headroom yet).
    for (t = 500; t <= 9500; t += 500) rate.evaluate()
    assert.equal(rate.tiers()[0].preset, 'standard', 'no step with less than 10 s of headroom')
    t = 10000
    rate.evaluate()
    const since = t
    assert.equal(rate.tiers()[0].preset, 'standard')
    t = since + 1999
    rate.evaluate()
    assert.equal(rate.tiers()[0].preset, 'standard', 'no step at 1999 ms')
    t = since + 2000
    rate.evaluate()
    assert.equal(rate.tiers()[0].preset, 'smooth', 'a step at 2000 ms')
    // Not above the cap.
    const c = autoAt(12000000)
    c.rate.setCap('balanced')
    c.run(20000)
    assert.equal(c.tier().preset, 'balanced')
    // The slow tier is not above the fast tier.
    const s = sim()
    s.add('a')
    s.add('b')
    s.run(1000)
    s.v('a').rate = 1400000
    s.v('b').rate = 1000000
    s.rate.forceSlow('b')
    assert.equal(s.rate.tiers().length, 2)
    // The fast tier: calm, half use and 10 % skipped slots, thus no step. The slow tier: calm, light content (rule A4),
    // and a rate below 0.9 x the fast bitrate (it stays slow).
    const report = tiers => ({ tiers: tiers.map(x => ({ tier: x.tier, slots: 100, skipped: x.role === 'fast' ? 10 : 0, dropped: 0, encodeP95Ms: 2 })) })
    s.run(12000, { report, frameBytes: tier => Math.round((tier.role === 'fast' ? 0.5 : 0.4) * tier.bitrate / 8 / 15) })
    assert.equal(s.rate.tiers().length, 2)
    const [fast, slow] = s.rate.tiers()
    assert.ok(!s.rate.history().some(h => h.role === 'slow' && h.from), 'the slow tier made no step up')
    assert.equal(fast.preset, 'standard')
    assert.equal(slow.preset, 'standard')
})

test('check A6a, rule A4: light content goes up below the bitrate of rule A3', () => {
    const s = sim()
    s.add('a')
    // 40 % use, no skipped slot, no excess.
    const light = tier => Math.round(0.4 * tier.bitrate / 8 / 15)
    s.run(4500, { frameBytes: light, report: tiers => ({ tiers: tiers.map(x => ({ tier: x.tier, slots: 30, skipped: 0, dropped: 0, encodeP95Ms: 2 })) }) })
    assert.equal(s.tier().preset, 'standard', 'no step before 5000 ms')
    // Revision 3: the first step comes after the 10 s of headroom (rule U1) and the hold of 2000 ms.
    s.run(8000, { frameBytes: light, report: tiers => ({ tiers: tiers.map(x => ({ tier: x.tier, slots: 30, skipped: 0, dropped: 0, encodeP95Ms: 2 })) }) })
    assert.equal(s.tier().preset, 'smooth')
    assert.ok(s.tier().bitrate < 0.7 * 3000000, 'below the bitrate of rule A3')
    assert.ok(s.rate.history().some(h => h.why === 'light'))
})

const skipReport = ratio => tiers => ({ tiers: tiers.map(x => ({ tier: x.tier, slots: 100, skipped: Math.round(ratio * 100), dropped: 0, encodeP95Ms: 2 })) })

test('check A6a, rule A5: skipped slots, two lates, and more steps for a low bitrate', () => {
    // 41 % skipped slots for 2000 ms: one step down.
    const s = autoAt(2400000)
    s.run(12500, { frameBytes: () => 2000 })
    assert.equal(s.tier().preset, 'smooth')
    s.run(5000, { frameBytes: () => 2000, report: skipReport(0.41) })
    assert.equal(s.tier().preset, 'standard')
    const down = s.rate.history().filter(h => h.why === 'skip')
    assert.equal(down.length, 1)
    // 39 % gives no step.
    const n = autoAt(2400000)
    n.run(12500, { frameBytes: () => 2000 })
    n.run(8000, { frameBytes: () => 2000, report: skipReport(0.39) })
    assert.equal(n.tier().preset, 'smooth')
    // Two lates in 5000 ms: a step at once.
    const l = autoAt(2400000)
    l.run(12500, { frameBytes: () => 2000 })
    assert.equal(l.tier().preset, 'smooth')
    // After the probe of 5 s (rule U3): a late frame in the probe goes back by rule U3, not by rule A5. The cap
    // keeps the light content (rule A4) at Smooth.
    l.rate.setCap('smooth')
    l.run(6000, { frameBytes: () => 2000 })
    let stalls = 0
    l.conf.get('a').delay = t => (t % 2500) < 800 ? Infinity : 5
    while (l.tier().preset === 'smooth' && stalls++ < 4000) l.run(5, { frameBytes: () => 2000 })
    assert.equal(l.tier().preset, 'standard')
    assert.ok(l.rate.history().some(h => h.why === 'late'))
    // More steps: balanced with a bitrate below 0.5 x the bitrate of smooth.
    const m = autoAt(4300000)
    m.run(15000, { frameBytes: () => 2000 })
    assert.equal(m.tier().preset, 'balanced')
    m.v('a').rate = 600000
    m.run(500, { frameBytes: () => 2000 })
    m.run(5000, { frameBytes: () => 2000, report: skipReport(0.5) })
    assert.equal(m.tier().preset, 'standard')
    assert.equal(m.rate.history().filter(h => h.why === 'skip').length, 1, 'one change of two steps')
})

test('check A6a, rules A6 and U4 (revision 3): the wait after a failed step up doubles from 30 s, at most 240 s', () => {
    const s = autoAt(2400000)
    let skipping = false
    const report = skipReport(0)
    const opts = { frameBytes: () => 2000, report: tiers => skipping ? skipReport(0.5)(tiers) : report(tiers) }
    const waits = []
    const ups = []
    for (let cycle = 0; cycle < 6; cycle++) {
        while (s.tier().preset !== 'smooth') s.run(100, opts)
        ups.push(s.now())
        skipping = true
        while (s.tier().preset === 'smooth') s.run(100, opts)
        skipping = false
        const downAt = s.now()
        assert.ok(downAt - ups.at(-1) <= 10000, 'the step down came in 10 s after the step up')
        waits.push(Math.round((s.rate.stats().tiers[0].upBlockedUntil - downAt) / 1000))
    }
    // Revision 3: the first failure gives 30 s, then 60 s, 120 s, 240 s and not more.
    assert.deepEqual(waits, [30, 60, 120, 240, 240, 240])
    assert.ok(ups[2] - ups[1] >= 60000 && ups[3] - ups[2] >= 120000)
})

test('check A6a, rule A7: the slow tier', () => {
    // A viewer that decreases while the other viewer is calm goes to a second tier at the preset of its rate.
    const s = sim()
    s.add('a')
    s.add('b')
    // Revision 3b: no split in the first 5 s of a viewer.
    s.run(5000)
    s.conf.get('b').delay = 120
    s.run(1500)
    const tiers = s.rate.tiers()
    assert.equal(tiers.length, 2)
    assert.deepEqual(tiers[1].viewers, ['b'])
    assert.equal(tiers[1].role, 'slow')
    assert.ok(SCREEN_PRESETS.findIndex(p => p.id === tiers[1].preset) <= SCREEN_PRESETS.findIndex(p => p.id === tiers[0].preset))
    // A slow viewer at 0.9 x the fast bitrate goes back.
    s.conf.get('b').delay = 5
    s.run(1000)
    s.v('b').rate = Math.ceil(0.9 * s.rate.tiers()[0].bitrate)
    s.v('a').rate = s.rate.tiers()[0].bitrate
    s.run(1000, { frameBytes: () => 500 })
    assert.equal(s.rate.tiers().length, 1)
    // Two viewers that decrease together stay in one tier.
    const t2 = sim()
    t2.add('a')
    t2.add('b')
    t2.run(5000)
    t2.conf.get('a').delay = 120
    t2.conf.get('b').delay = 120
    t2.run(3000)
    assert.equal(t2.rate.tiers().length, 1)
    // Never more than two tiers.
    const t3 = sim()
    t3.add('a')
    t3.add('b')
    t3.add('c')
    t3.run(5000)
    t3.conf.get('b').delay = 120
    t3.run(1000)
    t3.conf.get('c').delay = 150
    t3.run(3000)
    assert.equal(t3.rate.tiers().length, 2)
    assert.deepEqual([...t3.rate.tiers()[1].viewers].sort(), ['b', 'c'])
    // A fixed preset never makes a second tier.
    const f = sim({ quality: 'smooth' })
    f.add('a')
    f.add('b')
    f.run(2000)
    f.conf.get('b').delay = 120
    f.run(3000)
    f.rate.forceSlow('b')
    assert.equal(f.rate.tiers().length, 1)
})

test('check A6a, rule A8: the relay part of circuit viewers', () => {
    for (const [n, target] of [[1, 6000000], [2, 3000000], [6, 1000000]]) {
        const s = sim()
        for (let i = 0; i < n; i++) s.add(`c${i}`, { circuit: true })
        assert.ok(s.rate.stats().viewers.every(v => v.target === target), `${n} circuit viewers`)
    }
    const d = sim()
    d.add('d')
    d.add('c', { circuit: true })
    const stats = Object.fromEntries(d.rate.stats().viewers.map(v => [v.peerId, v.target]))
    assert.equal(stats.d, 12000000, 'a direct viewer has the bitrate of the cap')
    assert.equal(stats.c, 6000000)
    // Rule A1: the capture preset for one and two circuit viewers.
    const one = sim()
    one.add('c', { circuit: true })
    assert.equal(one.rate.capture().preset, 'balanced')
    one.add('e', { circuit: true })
    assert.equal(one.rate.capture().preset, 'smooth')
    one.add('f')
    assert.equal(one.rate.capture().preset, 'max')
    // Two presets with the same coded size and frame rate: Auto uses the lower one (a display of 1920 x 1080).
    const hd = sim({ source: { width: 1920, height: 1080 } })
    hd.add('f')
    assert.equal(hd.rate.capture().preset, 'high')
    assert.equal(hd.rate.cap(), 'high')
})

const loadReport = (dropped, encodeP95Ms = 2) => tiers => ({ tiers: tiers.map(x => ({ tier: x.tier, slots: 60, skipped: 0, dropped, encodeP95Ms })) })

test('check A6a, rule A9: CPU overload lowers the cap, 60 s with no overload raise it, at most 2 times', () => {
    let t = 0
    const rate = createScreenRate({ quality: 'auto', now: () => t, configRecord: () => Uint8Array.of(0, 0, 0, 1, 2) })
    rate.addViewer('a', { send: () => true })
    rate.viewer('a').rate = 12000000
    for (let i = 0; i < 40; i++) { t += 500; rate.evaluate() }
    assert.equal(rate.tiers()[0].preset, 'max')
    const tier = () => rate.tiers()[0].tier
    const over = () => rate.report(loadReport(2)([{ tier: tier() }]))
    const calm = () => rate.report(loadReport(0)([{ tier: tier() }]))
    for (let i = 0; i < 3; i++) { t += 500; over() }
    assert.equal(rate.cap(), 'max', '3 overloaded reports do not lower the cap')
    calm()
    for (let i = 0; i < 4; i++) { t += 500; over() }
    assert.equal(rate.cap(), 'high', '4 overloaded reports lower the cap by one')
    assert.equal(rate.tiers()[0].preset, 'high')
    assert.equal(rate.capture().preset, 'high')
    assert.equal(rate.cpu().lowered, true)
    // The encode time alone: p95 above 0.8 x the frame time.
    const lowered = t
    for (let raise = 1; raise <= 3; raise++) {
        for (let i = 0; i < 125; i++) { t += 500; calm(); rate.evaluate() }
        if (raise <= 2) {
            assert.equal(rate.cap(), 'max', `raise ${raise} after 60 s`)
            for (let i = 0; i < 4; i++) { t += 500; rate.report({ tiers: [{ tier: tier(), slots: 60, skipped: 0, dropped: 0, encodeP95Ms: 14 }] }) }
            assert.equal(rate.cap(), 'high')
        } else assert.equal(rate.cap(), 'high', 'no third raise in a share')
    }
    assert.ok(t - lowered > 180000)
    // A fixed preset keeps its preset and sets the notice flag.
    let u = 0
    const fixed = createScreenRate({ quality: 'max', now: () => u, configRecord: () => Uint8Array.of(0, 0, 0, 1, 2) })
    fixed.addViewer('a', { send: () => true })
    const ft = fixed.tiers()[0].tier
    for (let i = 0; i < 4; i++) { u += 500; fixed.report({ tiers: [{ tier: ft, slots: 60, skipped: 0, dropped: 3, encodeP95Ms: 2 }] }) }
    assert.equal(fixed.tiers()[0].preset, 'max')
    assert.equal(fixed.cpu().tooSlow, true)
})

test('rules R4 and A4: the use of a tier counts each frame one time, also with two viewers', () => {
    const usage = n => {
        let t = 0
        const rate = createScreenRate({ quality: 'auto', now: () => t, configRecord: () => Uint8Array.of(0, 0, 0, 1, 2) })
        for (let i = 0; i < n; i++) rate.addViewer(`v${i}`, { send: () => true })
        const tier = rate.tiers()[0].tier
        rate.setSize(tier, 1280, 720)
        for (let k = 0; k < 7; k++) { t += 66; rate.pushFrame(tier, { key: k === 0, timestampMs: t, data: new Uint8Array(2000) }) }
        t = 500
        rate.evaluate()
        return rate.stats().tiers[0].usage
    }
    assert.equal(usage(2), usage(1))
    assert.equal(usage(3), usage(1))
})

test('rule U3 (revision 3): an up step is a probe of 5 s; an excess goes back at once, a held probe resets the wait', () => {
    const s = autoAt(2400000)
    s.run(12500, { frameBytes: () => 2000 })
    assert.equal(s.tier().preset, 'smooth')
    const upAt = s.rate.history().find(h => h.to === 'smooth' && h.from).t
    // An ack delay excess above 70 ms in the probe: back at once, and a wait of 30 s.
    s.conf.get('a').delay = 120
    while (s.tier().preset === 'smooth' && s.now() < upAt + 5000) s.run(50, { frameBytes: () => 2000 })
    const back = s.rate.history().at(-1)
    assert.equal(back.why, 'probe')
    assert.equal(back.to, 'standard')
    assert.ok(back.t - upAt < 5000, 'back in the probe time')
    const wait = s.rate.stats().tiers[0].upBlockedUntil - back.t
    assert.equal(wait, 30000)
    // Calm again: the next step after the wait, and a probe that holds for 5 s resets the wait to 30 s.
    s.conf.get('a').delay = 5
    while (s.tier().preset === 'standard') s.run(100, { frameBytes: () => 2000 })
    assert.ok(s.now() - back.t >= 30000)
    assert.equal(s.rate.stats().tiers[0].upBackoffMs, 60000)
    s.run(6000, { frameBytes: () => 2000 })
    assert.equal(s.tier().preset, 'smooth')
    assert.equal(s.rate.stats().tiers[0].upBackoffMs, 30000)
})

test('rule U2 (revisions 3 and 3b): the rate stops near the use / 0.7, also with 7 or 8 frames in a period', () => {
    // A stream of at most 1.6 Mbit/s at 15 frames each second ("motion" at Standard). The rate ladder from
    // 500 kbit/s has 2384 kbit/s (use 0.67) and then 2980 kbit/s. Rule U2 over 2 s stops at 2384 kbit/s. The smoothed
    // use alone goes to 2980 kbit/s.
    const final = usedNow => {
        const s = sim({ quality: 'max', params: { usedNow } })
        s.add('a')
        s.run(30000, { frameBytes: tier => Math.round(Math.min(1600000, tier.bitrate) / 8 / 15) })
        return s.v('a').rate
    }
    assert.ok(final(true) <= 2400000, `rule U2: ${final(true)}`)
    assert.ok(final(false) > 2400000, `the smoothed use alone: ${final(false)}`)
})

test('revision 3b: no split in the first 5 s of a viewer', () => {
    const s = sim()
    s.add('a')
    s.add('b', { delay: t => t > 600 && t < 2500 ? 150 : 5 })
    s.run(4900)
    assert.equal(s.rate.tiers().length, 1, 'no split in the first 5 s')
    assert.ok(s.rate.history().every(h => h.why !== 'slow tier'))
})

test('revision 3b: the return to the fast tier is a probe of 5 s with the wait of rule U4', () => {
    const s = sim()
    s.add('a')
    s.add('b')
    s.run(6000)
    s.rate.forceSlow('b')
    assert.equal(s.rate.tiers().length, 2)
    // Viewer b is calm and its rate is the fast bitrate: it goes back. In the probe, an excess sends it back at once.
    s.v('b').rate = s.rate.tiers()[0].bitrate
    while (s.rate.tiers().length === 2 && s.now() < 20000) s.run(100)
    assert.equal(s.rate.tiers().length, 1, 'b is back in the fast tier')
    assert.ok(s.v('b').mergeProbe, 'the return is a probe')
    const back = s.now()
    s.conf.get('b').delay = 200
    while (s.rate.tiers().length === 1 && s.now() < back + 5000) s.run(50)
    assert.equal(s.rate.tiers().length, 2, 'back in the slow tier in the probe')
    const h = s.rate.history().filter(x => x.why === 'join probe')
    assert.equal(h.length, 1)
    assert.equal(s.v('b').mergeBlockedUntil - h[0].t, 30000, 'a wait of 30 s')
})

test('revision 3b: one late keyframe each 10 s does not stop the headroom of rule U1', () => {
    // A large keyframe on a slow link: rule T1 sees a late frame while the keyframe is on the way.
    const s = sim()
    s.add('a', { delay: 5 })
    let bigKey = false
    s.run(9000)
    const before = s.v('a').noHeadroomAt
    s.conf.get('a').delay = t => bigKey ? 400 : 5
    bigKey = true
    s.rate.requestKey(s.tier().tier)
    s.run(600, { frameBytes: (tier, key) => key ? 60000 : 500 })
    bigKey = false
    s.run(1400, { frameBytes: () => 500 })
    assert.ok(s.v('a').congestions >= 1, 'the keyframe made a late frame')
    assert.equal(s.v('a').noHeadroomAt, before, 'the headroom of U1 did not start again')
    // A second late keyframe in the same 10 s counts.
    s.conf.get('a').delay = t => bigKey ? 400 : 5
    bigKey = true
    s.rate.requestKey(s.tier().tier)
    s.run(2500, { frameBytes: (tier, key) => key ? 60000 : 500 })
    bigKey = false
    s.run(1000, { frameBytes: () => 500 })
    assert.ok(s.v('a').noHeadroomAt > before, 'the second late keyframe stops the headroom')
})

test('revision 3c: a viewer with an excess of 20 to 35 ms goes to the slow tier when the other viewer has headroom', () => {
    // Check 16 (X2) with revision 3b: such a viewer stopped the up steps of its tier (U1) and was never slow.
    const s = sim()
    s.add('a')
    s.add('b')
    s.run(6000)
    s.conf.get('b').delay = 30
    s.run(4500)
    assert.equal(s.rate.tiers().length, 2, 'b is in the slow tier')
    assert.deepEqual(s.rate.tiers()[1].viewers, ['b'])
    // It does not come back while its excess stays at 20 ms or more.
    s.v('b').rate = s.rate.tiers()[0].bitrate
    s.run(5000)
    assert.equal(s.rate.tiers().length, 2, 'b stays slow with an excess of 25 ms')
    // Two viewers with the same excess (a shared uplink, check 20): no split.
    const both = sim()
    both.add('a')
    both.add('b')
    both.run(6000)
    both.conf.get('a').delay = 30
    both.conf.get('b').delay = 30
    both.run(6000)
    assert.equal(both.rate.tiers().length, 1)
})
