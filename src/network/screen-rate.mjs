// Rate control of a screen share (work-orders/astra/P8/DESIGN.md, revision 2, rules T1 to T5, R1 to R7 and A1 to A9).
// A pure module: no libp2p and no timer. The caller gives the clock (`now`), calls tick() for the pacer (each 10 ms)
// and evaluate() each 500 ms. Each viewer has a `send(bytes)` function (false: wait for `onDrain()`).
// The reference for the Auto rules is the prototype scratch/proto/auto-proto.mjs of the design.

export const SCREEN_TYPE = Object.freeze({ WATCH: 1, CONFIG: 2, FRAME: 3, ACK: 4, KEYREQ: 5, END: 6 })
export const FRAME_HEAD_BYTES = 9
export const MAX_SCREEN_FRAME_BYTES = 1024 * 1024

// Section 2.2. The sequence is the Auto ladder, from the lowest to the highest.
export const SCREEN_PRESETS = Object.freeze([
    Object.freeze({ id: 'standard', label: 'Standard (720p, 15 fps)', width: 1280, height: 720, fps: 15, bitrate: 1500000 }),
    Object.freeze({ id: 'smooth', label: 'Smooth (720p, 30 fps)', width: 1280, height: 720, fps: 30, bitrate: 3000000 }),
    Object.freeze({ id: 'balanced', label: 'Balanced (1080p, 30 fps)', width: 1920, height: 1080, fps: 30, bitrate: 6000000 }),
    Object.freeze({ id: 'high', label: 'High (1080p, 60 fps)', width: 1920, height: 1080, fps: 60, bitrate: 9000000 }),
    Object.freeze({ id: 'max', label: 'Max (1440p, 60 fps)', width: 2560, height: 1440, fps: 60, bitrate: 12000000 })
])
export const SCREEN_QUALITIES = Object.freeze(['auto', ...SCREEN_PRESETS.map(p => p.id)])

// Section 5. All times in ms, all rates in bit/s.
export const RATE_DEFAULTS = Object.freeze({
    paceFactor: 1.25, paceBurstS: 0.03, sliceBytes: 2048, queueSeconds: 1,
    lateMs: 300, lateCapMs: 1000, evalMs: 500, highMs: 70, lowMs: 35, decrease: 0.8, increase: 1.25, increaseNear: 1.03,
    nearFactor: 0.75, limitClearFactor: 1.2, usedBelow: 0.7, decreaseHoldMs: 1500, increaseHoldMs: 3000, calmEvals: 2,
    slowMs: 10000, keySpacingMs: 2000, refreshMs: 1000,
    startBitrate: 500000, minBitrate: 300000, relayLimit: 6000000,
    upFactor: 0.7, upHoldMs: 2000, lightUsage: 0.7, lightSkip: 0.05, lightHoldMs: 5000, lightNoDecreaseMs: 10000,
    downSkip: 0.4, downHoldMs: 2000, lateDownCount: 2, lateDownMs: 5000,
    // Revision 3 (DECISIONS.md P8a-19): rules U1 to U4 for the up steps. They replace the values of rule A6.
    usedNow: true, headroomMs: 20, headroomHoldMs: 10000, probeMs: 5000, upFailWindowMs: 10000,
    upBackoffMs: 30000, upBackoffMaxMs: 240000,
    // Revision 3b (DECISIONS.md P8a-21): the use of rule U2 over 2 s, no split in the first 5 s of a viewer, the
    // return to the fast tier as a probe, and one late keyframe each 10 s with no effect on U1 and A4.
    usedWindowMs: 2000, slowGraceMs: 5000, deliveredWindowMs: 10000,
    slowHoldMs: 3000, deepMs: 140, deepFactor: 0.7, mergeFactor: 0.9, maxEncoders: 2,
    overloadDrop: 0.02, overloadEncode: 0.8, overloadReports: 4, cpuRecoverMs: 60000, cpuRaisesMax: 2
})

const p95 = values => {
    if (!values.length) return null
    const s = [...values].sort((a, b) => a - b)
    return s[Math.floor((s.length - 1) * 0.95)]
}

// The size of a source that fits in a box. Chromium keeps the aspect ratio and does not make a small source larger.
export function fitSize(source, box) {
    const scale = Math.min(1, box.width / source.width, box.height / source.height)
    const even = x => Math.max(16, 2 * Math.round(x / 2))
    return { width: Math.min(box.width, even(source.width * scale)), height: Math.min(box.height, even(source.height * scale)) }
}

export function frameRecord({ key, seq, timestampMs, data }) {
    const out = new Uint8Array(5 + FRAME_HEAD_BYTES + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, 1 + FRAME_HEAD_BYTES + data.length)
    out[4] = SCREEN_TYPE.FRAME
    out[5] = key ? 1 : 0
    view.setUint32(6, seq >>> 0)
    view.setUint32(10, Math.max(0, Math.round(timestampMs)) >>> 0)
    out.set(data, 14)
    return out
}

// quality: 'auto' or the ID of a fixed preset. source: the size of the captured source (rule A1, equal presets).
// configRecord(tier): the CONFIG record (bytes) of a tier. Callbacks: onTiers() after a change of the tiers, their
// presets or the capture preset; onEnd(viewerId, reason) after rule T4 removed a viewer.
export function createScreenRate({ quality = 'auto', source = null, now, params = {}, configRecord,
    onTiers = () => {}, onEnd = () => {} }) {
    if (typeof now !== 'function') throw new TypeError('now must be a function')
    const P = { ...RATE_DEFAULTS, ...params }
    const ladder = SCREEN_PRESETS
    const fixed = quality === 'auto' ? null : ladder.findIndex(p => p.id === quality)
    if (fixed === -1) throw new TypeError(`unknown screen quality: ${quality}`)
    if (fixed !== null) P.maxEncoders = 1
    let src = source && source.width > 0 && source.height > 0 ? { width: source.width, height: source.height } : null
    let cap = fixed ?? ladder.length - 1
    const viewers = new Map()
    const tiers = [] // the fast tier first
    let tierIds = 0
    let tokens = 0
    let lastTick = now()
    let capture = cap
    const deliveredSums = []
    let uplinkEstimate = 0
    const cpu = { overloaded: 0, lastOverloadAt: now(), raises: 0, lowered: false, tooSlow: false }
    const history = []

    // Rule A1: two presets with the same coded size and frame rate for the source are one preset. Auto uses the lower one.
    const fitOf = p => src ? fitSize(src, ladder[p]) : { width: ladder[p].width, height: ladder[p].height }
    function canon(p) {
        const a = fitOf(p)
        for (let q = 0; q < p; q++) {
            const b = fitOf(q)
            if (b.width === a.width && b.height === a.height && ladder[q].fps === ladder[p].fps) return q
        }
        return p
    }
    const nextUp = p => { for (let q = p + 1; q < ladder.length; q++) if (canon(q) === q) return q; return null }
    const capIndex = () => canon(cap)
    const targetCap = () => ladder[fixed ?? capIndex()].bitrate
    // Rules R5 and A8: a viewer on a circuit gets at most its part of the relay limit.
    function targetOf(v) {
        if (!v.circuit || !Number.isFinite(P.relayLimit)) return targetCap()
        let n = 0
        for (const x of viewers.values()) if (x.circuit) n++
        return Math.min(targetCap(), Math.round(P.relayLimit / Math.max(1, n)))
    }
    // The highest preset that a bitrate permits (the test of rule A3 with no hold time), not above a ceiling.
    function presetFor(bitrate, ceiling = capIndex()) {
        let p = 0
        for (let q = nextUp(0); q !== null && q <= ceiling && bitrate >= P.upFactor * ladder[q].bitrate; q = nextUp(q)) p = q
        return p
    }

    function newTier(role, preset) {
        const t = { id: ++tierIds, role, preset, bitrate: P.startBitrate, keyWanted: true, lastKeyAt: -Infinity, windowBytes: 0,
            usage: 1, lightSince: null, reports: [], skipRatio: 0, createdAt: now(), upSince: null, downSince: null,
            lastUpAt: -Infinity, upBackoff: P.upBackoffMs, upBlockedUntil: 0, members: 0, size: null, ready: false,
            lastFrameAt: now(), lastRefreshAt: now(), frames: 0 }
        history.push({ t: now(), tier: t.id, role, to: ladder[preset].id, why: 'new' })
        return t
    }
    const tierById = id => tiers.find(t => t.id === id) ?? null
    const tierOf = v => tierById(v.tier)
    const membersOf = t => [...viewers.values()].filter(v => v.tier === t.id)

    function enqueueControl(v, wire) {
        v.queue.push({ wire, seq: null })
        v.queuedBytes += wire.length
    }
    // Remove each frame of the queue that has not started. Records with no number stay. Section 3.2: only rule T2
    // leaves a gap in the numbers. After a tier change, a new preset or a new size, the numbers continue with no gap.
    function dropQueuedFrames(v, gap = false) {
        const kept = []
        for (const item of v.queue) {
            if (item.seq === null) kept.push(item)
            else { v.drops++; v.queuedBytes -= item.wire.length }
        }
        v.queue = kept
        if (!gap) v.nextSeq = v.lastSeq === null ? 0 : (v.lastSeq + 1) >>> 0
    }

    function moveViewer(v, tier) {
        if (v.tier === tier.id) return
        const first = v.tier === null
        v.tier = tier.id
        dropQueuedFrames(v)
        v.needKey = true
        if (!first) v.switches++
        tier.keyWanted = true
        if (tier.ready) enqueueControl(v, configRecord(tier))
    }

    // Rule A7: the fast tier has the viewers that are not slow, the slow tier has the slow viewers. When all viewers are
    // slow, all are in one tier.
    function regroup() {
        const list = [...viewers.values()]
        if (!list.length) {
            tiers.length = 0
            onTiers()
            return
        }
        if (P.maxEncoders === 1 || list.every(v => v.slow)) for (const v of list) v.slow = false
        if (!tiers[0]) tiers.push(newTier('fast', fixed ?? 0))
        const fast = tiers[0]
        const slowList = list.filter(v => v.slow)
        let slow = tiers[1] ?? null
        if (slowList.length && !slow) {
            const rate = Math.min(...slowList.map(v => v.rate))
            slow = newTier('slow', Math.min(fast.preset, presetFor(rate)))
            slow.bitrate = rate
            tiers.push(slow)
        }
        if (!slowList.length && slow) {
            tiers.splice(1, 1)
            history.push({ t: now(), tier: slow.id, role: 'slow', why: 'end' })
            slow = null
        }
        for (const v of list) moveViewer(v, v.slow ? slow : fast)
        setBitrates()
        onTiers()
    }
    function setBitrates() {
        for (const t of tiers) {
            const members = membersOf(t)
            for (const v of members) v.rate = Math.min(v.rate, targetOf(v))
            if (members.length) t.bitrate = Math.max(P.minBitrate, Math.min(...members.map(v => v.rate)))
            t.members = members.length
        }
        // Revision 3b: while a viewer is in the probe of its return, the sum of the tier ceilings of all viewers stays
        // at or below the uplink estimate. The fast tier gets the lower ceiling.
        if (tiers[0] && uplinkEstimate > 0 && [...viewers.values()].some(v => v.mergeProbe)) {
            const others = tiers.slice(1).reduce((a, x) => a + x.bitrate * x.members, 0)
            const cap = (uplinkEstimate - others) / Math.max(1, tiers[0].members)
            tiers[0].bitrate = Math.max(P.minBitrate, Math.min(tiers[0].bitrate, Math.round(cap)))
        }
        if (tiers[1] && tiers[1].preset > tiers[0].preset) setPreset(tiers[1], tiers[0].preset, 'below fast')
    }
    // Rules A3, A5 and A9: a new preset needs a new configuration of the encoder, a new size and a keyframe (rule E7).
    function setPreset(t, preset, why) {
        if (t.preset === preset) return
        history.push({ t: now(), tier: t.id, role: t.role, from: ladder[t.preset].id, to: ladder[preset].id, why, bitrate: t.bitrate })
        t.preset = preset
        if (why !== 'rate' && why !== 'light') t.probe = null
        t.ready = false
        t.size = null
        t.keyWanted = true
        t.reports = []
        t.skipRatio = 0
        t.lightSince = null
        t.createdAt = now()
        for (const v of membersOf(t)) { dropQueuedFrames(v); v.needKey = true }
        onTiers()
    }

    // Rule A1: the capture preset is the highest preset that the target of a viewer permits, at most the cap.
    function updateCapture() {
        if (fixed !== null) { capture = fixed; return }
        if (!viewers.size) { capture = Math.min(capture, capIndex()); return }
        let best = 0
        for (const v of viewers.values()) best = Math.max(best, presetFor(targetOf(v)))
        capture = best
    }

    function addViewer(id, { send, onDrain, circuit = false } = {}) {
        if (typeof send !== 'function') throw new TypeError('send must be a function')
        removeViewer(id)
        const t = now()
        const v = { id, send, onDrain: onDrain ?? (() => Promise.resolve()), circuit: circuit === true, queue: [], queuedBytes: 0,
            maxQueuedBytes: 0, current: null, unacked: new Map(), needKey: true, blocked: false, base: Infinity, samples: [],
            drops: 0, congested: false, recovering: false, behindSince: null, sentFrames: 0, sentBytes: 0, keys: 0,
            congestions: 0, rate: P.startBitrate, limit: null, calm: 0, noIncreaseUntil: 0, noDecreaseUntil: 0, excess: 0,
            lates: [], calmSince: t, queueSince: null, tier: null, switches: 0, slow: false, decreased: false, acked: [],
            deep: 0, lastDecreaseAt: -Infinity, nextSeq: 0, lastSeq: null, addedAt: t, lastNewFrameAt: t,
            noHeadroomAt: t, mildSince: null, lateNow: false, keyLate: false, otherLate: false, keyExemptAt: -Infinity,
            keyExemptUntil: -Infinity, delivered: 0, mergeProbe: null, mergeBlockedUntil: 0, mergeBackoff: P.upBackoffMs }
        // Rule A2: a new viewer starts at max(start, bitrate of the fast tier), at most its target (R5).
        v.rate = Math.min(targetOf(v), tiers[0] ? Math.max(P.startBitrate, tiers[0].bitrate) : P.startBitrate)
        viewers.set(id, v)
        updateCapture()
        regroup()
        return v
    }
    function removeViewer(id) {
        if (!viewers.delete(id)) return false
        updateCapture()
        regroup()
        return true
    }

    function keyInFlight(v) {
        if (v.current?.item.key) return true
        for (const u of v.unacked.values()) if (u.key) return true
        return v.queue.some(item => item.key)
    }
    function oldestOutstanding(v) { for (const u of v.unacked.values()) return u.at; return Infinity }
    const paceRateOf = v => P.paceFactor * (tierOf(v)?.bitrate ?? P.minBitrate) / 8
    const lateLimit = v => Math.min((Number.isFinite(v.base) ? v.base : 100) + P.lateMs, P.lateCapMs)

    // Rule R2: the ack delay of a frame is the time from the write of its last byte to its ack.
    function onAck(id, seq) {
        const v = viewers.get(id)
        if (!v || !v.unacked.has(seq)) return false
        const t = now()
        for (const [s, u] of v.unacked) {
            v.acked.push({ t, bytes: u.bytes })
            if (s === seq && !v.needKey && !v.recovering) {
                const sample = t - u.at
                v.base = Math.min(v.base, sample)
                v.samples.push(sample)
            }
            v.unacked.delete(s)
            if (s === seq) break
        }
        recoverIfClear(v)
        return true
    }
    // Rule T3: when each written frame has an ack and the queue is empty, ask for a keyframe.
    function recoverIfClear(v) {
        if (v.recovering && !v.current && !v.queue.some(item => item.seq !== null) && v.unacked.size === 0) {
            v.recovering = false
            const tier = tierOf(v)
            if (tier) tier.keyWanted = true
        }
    }

    // Rule T5: at most one keyframe each 2000 ms for each tier. The encoder of the tier asks before it encodes.
    function takeKeyRequest(tierId) {
        const tier = tierById(tierId)
        if (!tier || !tier.ready || !tier.keyWanted || !tier.members || now() - tier.lastKeyAt < P.keySpacingMs) return false
        tier.keyWanted = false
        tier.lastKeyAt = now()
        return true
    }
    function requestKey(tierId) { const tier = tierById(tierId); if (tier) tier.keyWanted = true }
    // Rule E5: a refresh tick when the tier has a viewer and got no frame for 1000 ms.
    function takeRefresh(tierId) {
        const tier = tierById(tierId)
        if (!tier || !tier.ready || !tier.members) return false
        const t = now()
        if (t - Math.max(tier.lastFrameAt, tier.lastRefreshAt) < P.refreshMs) return false
        tier.lastRefreshAt = t
        return true
    }

    // Rule E7: the window tells the coded size of a tier. CONFIG goes to each viewer of the tier, then a keyframe.
    function setSize(tierId, width, height) {
        const tier = tierById(tierId)
        if (!tier) return false
        tier.size = { width, height }
        tier.ready = true
        tier.keyWanted = true
        for (const v of membersOf(tier)) { dropQueuedFrames(v); v.needKey = true; enqueueControl(v, configRecord(tier)) }
        return true
    }

    function pushFrame(tierId, { key, timestampMs, data }) {
        const tier = tierById(tierId)
        if (!tier || !tier.ready) return false
        const t = now()
        tier.lastFrameAt = t
        tier.frames++
        // Rules R4 and A4: "used" is the stream of the tier, thus each frame counts one time (not for each viewer).
        tier.windowBytes += 5 + FRAME_HEAD_BYTES + data.length
        for (const v of viewers.values()) {
            if (v.tier !== tier.id) continue
            if (v.needKey && !key) continue
            const record = 5 + FRAME_HEAD_BYTES + data.length
            // Rule T1: late (no ack after base + 300 ms) or a queue with more than 1 s of the pacer rate.
            const queueFull = v.queue.length > 0 && v.queuedBytes + record > paceRateOf(v) * P.queueSeconds
            if (t - oldestOutstanding(v) > lateLimit(v) || queueFull) {
                // Revision 3b: a late frame while a keyframe is on the way (a large keyframe on a slow link).
                if (keyInFlight(v)) v.keyLate = true
                else v.otherLate = true
                // Rule T2: drop the frames of the queue that did not start, and put no new frame in the queue.
                v.drops++
                dropQueuedFrames(v, true)
                v.needKey = true
                v.recovering = true
                v.congested = true
                v.congestions++
                v.lates.push(t)
                v.behindSince ??= t
                recoverIfClear(v)
                continue
            }
            if (key) { v.needKey = false; v.behindSince = null; v.keys++ }
            const seq = v.nextSeq
            v.nextSeq = (seq + 1) >>> 0
            const wire = frameRecord({ key, seq, timestampMs, data })
            v.queue.push({ wire, seq, key })
            v.queuedBytes += wire.length
            v.maxQueuedBytes = Math.max(v.maxQueuedBytes, v.queuedBytes)
            v.sentFrames++
            v.sentBytes += wire.length
            v.lastNewFrameAt = t
        }
        return true
    }

    // Writes at most `budget` bytes of the queue of one viewer, in slices of at most 2048 bytes.
    function drain(v, budget) {
        let wrote = 0
        while (!v.blocked && budget - wrote >= 1) {
            if (!v.current) {
                const item = v.queue.shift()
                if (!item) break
                v.queuedBytes -= item.wire.length
                if (item.seq !== null) v.lastSeq = item.seq
                v.current = { item, offset: 0 }
            }
            const { item } = v.current
            const n = Math.min(P.sliceBytes, item.wire.length - v.current.offset, Math.ceil(budget - wrote))
            let ok
            try { ok = v.send(item.wire.subarray(v.current.offset, v.current.offset + n)) } catch { v.blocked = true; return wrote }
            v.current.offset += n
            wrote += n
            if (v.current.offset === item.wire.length) {
                if (item.seq !== null) v.unacked.set(item.seq, { at: now(), bytes: item.wire.length, key: item.key === true })
                v.current = null
            }
            if (ok === false) {
                v.blocked = true
                Promise.resolve(v.onDrain()).then(() => { v.blocked = false }, () => {})
            }
        }
        return wrote
    }

    // Rule R1: one token bucket for all screen writes. The rate is the sum of 1.25 x the bitrate of the tier of each
    // viewer, the burst is 30 ms of that rate. The tokens come from the elapsed time.
    function tick() {
        const t = now()
        let rate = 0
        for (const v of viewers.values()) rate += paceRateOf(v)
        tokens = Math.min(rate * P.paceBurstS, tokens + Math.max(0, t - lastTick) / 1000 * rate)
        lastTick = t
        let total = 0
        let progress = true
        while (tokens >= 1 && progress) {
            progress = false
            for (const v of viewers.values()) {
                const wrote = drain(v, Math.min(tokens, P.sliceBytes))
                if (wrote > 0) { tokens -= wrote; total += wrote; progress = true }
                if (tokens < 1) break
            }
        }
        return total
    }

    // Stops a viewer at once: the rest of a started record goes out, then `last` (for example END), with no pacer.
    function flush(id, last) {
        const v = viewers.get(id)
        if (!v) return false
        try {
            if (v.current) v.send(v.current.item.wire.subarray(v.current.offset))
            v.current = null
            if (last) v.send(last)
        } catch { /* the stream closed */ }
        removeViewer(id)
        return true
    }

    // Rule E11: the window report. Rules A4, A5 and A9 use it.
    function report({ tiers: list } = {}) {
        if (!Array.isArray(list)) return
        const t = now()
        let overloaded = false
        for (const r of list) {
            const tier = tierById(r?.tier)
            if (!tier) continue
            const slots = Math.max(0, Number(r.slots) || 0)
            const skipped = Math.min(slots, Math.max(0, Number(r.skipped) || 0))
            const dropped = Math.min(slots, Math.max(0, Number(r.dropped) || 0))
            const encode = Number(r.encodeP95Ms)
            tier.reports.push({ t, slots, skipped })
            // Rule A9: E4 dropped more than 2 % of the slots, or the encode p95 is above 0.8 x the frame time.
            if ((slots > 0 && dropped / slots > P.overloadDrop) ||
                (Number.isFinite(encode) && encode > P.overloadEncode * 1000 / ladder[tier.preset].fps)) overloaded = true
        }
        if (overloaded) {
            cpu.overloaded++
            cpu.lastOverloadAt = t
        } else cpu.overloaded = 0
        if (cpu.overloaded >= P.overloadReports) {
            cpu.overloaded = 0
            if (fixed !== null) cpu.tooSlow = true
            else if (tiers[0]) lowerCap(Math.max(0, tiers[0].preset - 1), 'cpu')
        }
    }
    function lowerCap(index, why) {
        if (fixed !== null) return
        cap = Math.max(0, Math.min(ladder.length - 1, index))
        cpu.lowered = cap < ladder.length - 1
        for (const t of tiers) if (t.preset > capIndex()) setPreset(t, capIndex(), why)
        updateCapture()
        setBitrates()
        onTiers()
    }

    // Rule U4: after a failed up step, wait 30 s, then two times the last wait, at most 240 s.
    function failedUp(tier, t) {
        tier.upBlockedUntil = t + tier.upBackoff
        tier.upBackoff = Math.min(P.upBackoffMaxMs, tier.upBackoff * 2)
    }

    function evaluate() {
        const t = now()
        const changed = { tiers: false, ended: [] }
        // Rule A9: after 60 s with no overload, the cap goes up one index, at most 2 times in a share.
        if (fixed === null && cap < ladder.length - 1 && cpu.raises < P.cpuRaisesMax && t - cpu.lastOverloadAt >= P.cpuRecoverMs) {
            cpu.raises++
            cpu.lastOverloadAt = t
            cap++
            cpu.lowered = cap < ladder.length - 1
            updateCapture()
            changed.tiers = true
        }
        if (fixed !== null && cpu.tooSlow && t - cpu.lastOverloadAt >= P.cpuRecoverMs) cpu.tooSlow = false
        for (const tier of tiers) {
            // Rule U2 (revision 3b): the use of the last 2 s (7 or 8 frames in 500 ms give +-7 %).
            tier.usageBytes = [...(tier.usageBytes ?? []), tier.windowBytes].slice(-Math.max(1, Math.round(P.usedWindowMs / P.evalMs)))
            tier.usageNow = tier.usageBytes.reduce((a, x) => a + x, 0) * 8 / (tier.usageBytes.length * P.evalMs / 1000) / tier.bitrate
            tier.usage = 0.5 * tier.usage + 0.5 * tier.usageNow
            tier.windowBytes = 0
            tier.reports = tier.reports.filter(r => t - r.t < P.downHoldMs)
            const slots = tier.reports.reduce((a, r) => a + r.slots, 0)
            tier.skipRatio = slots ? tier.reports.reduce((a, r) => a + r.skipped, 0) / slots : 0
            if (tier.usage < P.lightUsage && tier.skipRatio < P.lightSkip) tier.lightSince ??= t
            else tier.lightSince = null
        }
        // Rule T4: a viewer that got no new frame for 10 s gets END slow.
        for (const v of [...viewers.values()]) {
            if (v.behindSince !== null && t - v.behindSince > P.slowMs) {
                changed.ended.push(v.id)
                history.push({ t, viewer: v.id, why: 'slow' })
            }
        }
        for (const id of changed.ended) onEnd(id, 'slow')
        // Rules R2 to R4 and A2b for each viewer (rule A2).
        for (const v of viewers.values()) {
            const tier = tierOf(v)
            const d = p95(v.samples)
            v.samples = []
            v.excess = d === null ? 0 : d - v.base
            const congested = v.congested
            v.congested = false
            v.decreased = false
            v.lateNow = congested
            // Revision 3b: one late keyframe each 10 s does not stop the headroom of U1 or the light content of A4.
            // The period of the late keyframe and the next period are exempt.
            if (congested && v.keyLate && !v.otherLate && t - v.keyExemptAt >= P.headroomHoldMs) {
                v.keyExemptAt = t
                v.keyExemptUntil = t + P.evalMs
            }
            const exempt = t <= v.keyExemptUntil
            v.keyLate = false
            v.otherLate = false
            // Rule U1: the last time that this viewer showed no headroom (an excess of 20 ms or more, or a late frame).
            if (!exempt && (congested || v.excess >= P.headroomMs)) v.noHeadroomAt = t
            const got = tier?.bitrate ?? P.minBitrate
            v.acked = v.acked.filter(x => t - x.t <= 1000)
            const delivered = v.acked.reduce((a, x) => a + x.bytes, 0) * 8
            v.delivered = delivered
            if (congested || (v.excess > P.highMs && t >= v.noDecreaseUntil)) {
                v.limit = Math.min(v.rate, got)
                let rate = Math.min(v.rate, got) * P.decrease
                if (P.deepFactor && (congested || v.excess > P.deepMs) && delivered > 0 && P.deepFactor * delivered < rate) {
                    rate = P.deepFactor * delivered
                    v.deep++
                }
                v.rate = Math.max(P.minBitrate, Math.round(rate))
                v.decreased = true
                if (!exempt) { v.lastDecreaseAt = t; v.calmSince = null }
                v.calm = 0
                v.noDecreaseUntil = t + P.decreaseHoldMs
                v.noIncreaseUntil = t + P.increaseHoldMs
            } else if (v.excess < P.lowMs) {
                v.calmSince ??= t
                if (t >= v.noIncreaseUntil && ++v.calm >= P.calmEvals) {
                    v.calm = 0
                    // Rule A2: the rate goes up only when the tier used its bitrate and this viewer sets it.
                    if (tier && (P.usedNow ? Math.min(tier.usage, tier.usageNow) : tier.usage) >= P.usedBelow && got >= 0.9 * v.rate) {
                        const near = v.limit !== null && v.rate >= P.nearFactor * v.limit
                        v.rate = Math.min(targetOf(v), Math.round(v.rate * (near ? P.increaseNear : P.increase)))
                        if (v.limit !== null && v.rate >= P.limitClearFactor * v.limit) v.limit = null
                    }
                }
            } else { v.calm = 0; v.calmSince = null }
            if (v.excess >= P.lowMs || v.decreased) v.queueSince ??= t
            else v.queueSince = null
            // Revision 3c: an excess at or above the threshold of U1 (20 ms).
            if (v.excess >= P.headroomMs || v.decreased) v.mildSince ??= t
            else v.mildSince = null
            v.lates = v.lates.filter(x => t - x <= P.lateDownMs)
        }
        // Rule A7: slow viewers and the return to the fast tier.
        let regroupNeeded = false
        // The uplink estimate (revision 3b): the pacer factor x the largest sum of the delivered rates in 10 s.
        deliveredSums.push({ t, sum: [...viewers.values()].reduce((a, v) => a + v.delivered, 0) })
        while (deliveredSums.length && t - deliveredSums[0].t > P.deliveredWindowMs) deliveredSums.shift()
        uplinkEstimate = P.paceFactor * Math.max(0, ...deliveredSums.map(x => x.sum))
        // Revision 3b: the return to the fast tier is a probe of 5 s, with the rules of U3 and U4.
        for (const v of viewers.values()) {
            if (!v.mergeProbe) continue
            if (v.lateNow || v.excess > P.highMs) {
                v.mergeProbe = null
                v.slow = true
                v.mergeBlockedUntil = t + v.mergeBackoff
                v.mergeBackoff = Math.min(P.upBackoffMaxMs, v.mergeBackoff * 2)
                regroupNeeded = true
                history.push({ t, viewer: v.id, why: 'join probe', rate: v.rate })
            } else if (t - v.mergeProbe.at >= P.probeMs) {
                v.mergeProbe = null
                v.mergeBackoff = P.upBackoffMs
            }
        }
        if (P.maxEncoders > 1) {
            for (const tier of tiers) {
                const members = membersOf(tier)
                const calmOthers = members.some(v => !v.decreased && v.excess < P.lowMs && v.queueSince === null)
                // Revision 3c: a viewer with an excess of 20 ms or more for 3 s stops the up steps of its tier (U1).
                // When another viewer of the tier has headroom, that viewer goes to the slow tier.
                const headroomOthers = members.some(v => !v.decreased && v.excess < P.headroomMs && v.mildSince === null)
                for (const v of members) {
                    // Revision 3b: no split in the first 5 s of a viewer (the first keyframes at the start rate).
                    if (!v.slow && t - v.addedAt >= P.slowGraceMs &&
                        ((calmOthers && (v.decreased || (v.queueSince !== null && t - v.queueSince >= P.slowHoldMs))) ||
                         (headroomOthers && v.mildSince !== null && t - v.mildSince >= P.slowHoldMs))) {
                        v.slow = true
                        regroupNeeded = true
                        history.push({ t, viewer: v.id, why: 'slow tier', rate: v.rate })
                    }
                }
            }
            const fast = tiers[0]
            for (const v of viewers.values()) {
                if (v.slow && fast && fast.members > 0 && v.tier !== fast.id && v.rate >= P.mergeFactor * fast.bitrate && v.excess < P.headroomMs &&
                    t >= v.mergeBlockedUntil) {
                    v.slow = false
                    v.mergeProbe = { at: t }
                    regroupNeeded = true
                    history.push({ t, viewer: v.id, why: 'fast tier', rate: v.rate })
                }
            }
        }
        if (regroupNeeded) { regroup(); changed.tiers = true }
        const before = tiers.map(x => `${x.id}:${x.preset}:${x.bitrate}`).join()
        setBitrates()
        // Rules A3 to A6 for each tier.
        if (fixed === null) for (const tier of tiers) {
            const members = membersOf(tier)
            if (!members.length) continue
            // Rule U3: an up step is a probe of 5 s. An excess above 70 ms or a late viewer sends the tier back at once.
            if (tier.probe) {
                if (members.some(v => v.lateNow || v.excess > P.highMs)) {
                    const from = tier.probe.from
                    tier.probe = null
                    failedUp(tier, t)
                    setPreset(tier, from, 'probe')
                    for (const v of members) v.lates = []
                    tier.upSince = null
                    tier.downSince = null
                    continue
                }
                // Rule U4: a probe that holds for 5 s resets the wait.
                if (t - tier.probe.at >= P.probeMs) { tier.probe = null; tier.upBackoff = P.upBackoffMs }
            }
            const up = nextUp(tier.preset)
            const next = up === null ? null : ladder[up]
            const allCalm = members.every(v => v.calmSince !== null)
            const light = tier.lightSince !== null && t - tier.lightSince >= P.lightHoldMs && members.every(v =>
                v.calmSince !== null && t - v.calmSince >= P.lightHoldMs && t - v.lastDecreaseAt >= P.lightNoDecreaseMs)
            const ceiling = tier.role === 'slow' && tiers[0] ? Math.min(capIndex(), tiers[0].preset) : capIndex()
            // Rule U1: each viewer of the tier had headroom for the last 10 s.
            const headroom = members.every(v => t - v.noHeadroomAt >= P.headroomHoldMs)
            const upOk = next !== null && up <= ceiling && t >= tier.upBlockedUntil && allCalm && headroom &&
                (tier.bitrate >= P.upFactor * next.bitrate || light)
            tier.upSince = upOk ? (tier.upSince ?? t) : null
            const late = members.some(v => v.lates.length >= P.lateDownCount)
            const skipping = t - tier.createdAt >= P.downHoldMs && tier.skipRatio > P.downSkip
            const downOk = tier.preset > 0 && (skipping || late)
            tier.downSince = downOk ? (tier.downSince ?? t) : null
            if (tier.downSince !== null && (t - tier.downSince >= P.downHoldMs || late)) {
                let p = canon(tier.preset - 1)
                // Rule A5: more steps when the bitrate is below 0.5 x the bitrate of the lower preset.
                while (p > 0 && tier.bitrate < 0.5 * ladder[p].bitrate) p = canon(p - 1)
                // Rules A6 and U4: a step down in 10 s after a step up is a failed up step.
                if (t - tier.lastUpAt <= P.upFailWindowMs) failedUp(tier, t)
                tier.probe = null
                setPreset(tier, p, late ? 'late' : 'skip')
                for (const v of members) v.lates = []
                tier.downSince = null
                tier.upSince = null
            } else if (tier.upSince !== null && t - tier.upSince >= P.upHoldMs) {
                const from = tier.preset
                setPreset(tier, up, tier.bitrate >= P.upFactor * next.bitrate ? 'rate' : 'light')
                tier.upSince = null
                tier.lastUpAt = t
                tier.probe = { from, at: t }
            }
        }
        if (before !== tiers.map(x => `${x.id}:${x.preset}:${x.bitrate}`).join()) changed.tiers = true
        if (changed.tiers) onTiers()
        return changed
    }

    const tierView = t => {
        const preset = ladder[t.preset]
        const fit = fitOf(t.preset)
        return { tier: t.id, role: t.role, preset: preset.id, width: t.size?.width ?? fit.width, height: t.size?.height ?? fit.height,
            fitWidth: fit.width, fitHeight: fit.height, fps: preset.fps, bitrate: t.bitrate, ready: t.ready,
            viewers: membersOf(t).map(v => v.id) }
    }
    return {
        quality, fixed: fixed !== null, ladder,
        addViewer, removeViewer, onAck, takeKeyRequest, requestKey, takeRefresh, setSize, pushFrame, tick, flush,
        report, evaluate,
        setBlocked(id, blocked) { const v = viewers.get(id); if (v) v.blocked = blocked },
        has: id => viewers.has(id),
        viewerCount: () => viewers.size,
        tierOfViewer: id => { const v = viewers.get(id); return v ? tierOf(v) && tierView(tierOf(v)) : null },
        tiers: () => tiers.map(tierView),
        cap: () => ladder[capIndex()].id,
        capture: () => { const c = canon(capture); return { preset: ladder[c].id, ...fitOf(c), fps: ladder[c].fps } },
        cpu: () => ({ lowered: cpu.lowered, tooSlow: cpu.tooSlow, raises: cpu.raises }),
        setSource(size) { if (size && size.width > 0 && size.height > 0) { src = { width: size.width, height: size.height }; updateCapture() } },
        // A test hook of rule A9 (W5 check 8a): set the cap to a preset ID.
        setCap(id) { const i = ladder.findIndex(p => p.id === id); if (i >= 0) lowerCap(i, 'cap') },
        // Test hook (W1 check 13a): make a viewer slow, so that it goes to the slow tier.
        forceSlow(id, slow = true) { const v = viewers.get(id); if (v && P.maxEncoders > 1) { v.slow = slow; regroup() } },
        viewer: id => viewers.get(id) ?? null,
        viewers: () => [...viewers.values()],
        history: () => history,
        stats() {
            return {
                cap: ladder[capIndex()].id, capture: ladder[canon(capture)].id,
                tiers: tiers.map(t => ({ ...tierView(t), usage: Math.round(t.usage * 100) / 100, skipRatio: t.skipRatio, frames: t.frames,
                    upBlockedUntil: t.upBlockedUntil, upBackoffMs: t.upBackoff })),
                viewers: [...viewers.values()].map(v => ({ peerId: v.id, tier: v.tier, slow: v.slow, circuit: v.circuit,
                    rate: v.rate, target: targetOf(v), framesSent: v.sentFrames, bytesSent: v.sentBytes, keyframes: v.keys,
                    dropped: v.drops, congestions: v.congestions, switches: v.switches, deep: v.deep,
                    ackBaseMs: Number.isFinite(v.base) ? v.base : null, excessMs: v.excess, queueBytes: v.queuedBytes,
                    maxQueueBytes: v.maxQueuedBytes, queueLimitBytes: paceRateOf(v) * P.queueSeconds, unacked: v.unacked.size }))
            }
        }
    }
}
