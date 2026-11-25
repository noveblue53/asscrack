// Unit tests for src/network/screen-forwarder.mjs (pure module, deterministic clock, no network).
// These are 127.0.0.1 / this PC unit results, not LAN results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScreenForwarder, FORWARDER_DEFAULTS, SCREEN_END } from '../src/network/screen-forwarder.mjs'
import { FRAME_HEAD_BYTES, MAX_SCREEN_FRAME_BYTES, SCREEN_TYPE } from '../src/network/screen-rate.mjs'

function encodeConfig({ shareId = 'share-1', width = 1280, height = 720, fps = 30 } = {}) {
    return new TextEncoder().encode(JSON.stringify({ v: 1, shareId, codec: 'vp8', width, height, fps }))
}

function encodeFrameBody({ key = false, seq = 0, timestampMs = 0, size = 1000, fill = 0xab } = {}) {
    const body = new Uint8Array(FRAME_HEAD_BYTES + size)
    const view = new DataView(body.buffer)
    body[0] = key ? 1 : 0
    view.setUint32(1, seq >>> 0)
    view.setUint32(5, timestampMs >>> 0)
    body.fill(fill, FRAME_HEAD_BYTES)
    return body
}

function createHarness(opts = {}) {
    let t = 0
    const keyRequests = []
    const sheds = []
    const reports = []
    let voicePressured = false
    const allowedSet = new Set(['a', 'b', 'c', 'd'])
    const forwarder = createScreenForwarder({
        now: () => t,
        allowed: opts.allowed ?? (id => allowedSet.has(id)),
        voiceBackpressure: opts.voiceBackpressure ?? (() => voicePressured),
        onKeyRequest: () => keyRequests.push(t),
        onShed: (childId, reportReason, wireReason) => sheds.push({ childId, reportReason, wireReason, t }),
        onReport: r => reports.push({ ...r, t }),
        params: opts.params ?? {}
    })

    const children = new Map()
    const defaultDelayMs = opts.defaultDelayMs ?? 10

    function createParser(id) {
        let buf = Buffer.alloc(0)
        const records = []
        return bytes => {
            buf = Buffer.concat([buf, Buffer.from(bytes)])
            while (buf.length >= 4) {
                const len = buf.readUInt32BE(0)
                assert.ok(len >= 1 && len <= 1 + FRAME_HEAD_BYTES + MAX_SCREEN_FRAME_BYTES, `bad record length ${len} for ${id}`)
                if (buf.length < 4 + len) break
                const type = buf[4]
                const body = buf.subarray(5, 4 + len)
                if (type === SCREEN_TYPE.CONFIG) {
                    const cfg = JSON.parse(body.toString('utf8'))
                    records.push({ type, cfg, t })
                } else if (type === SCREEN_TYPE.FRAME) {
                    assert.ok(body.length >= FRAME_HEAD_BYTES + 1, `short FRAME body for ${id}`)
                    const key = (body[0] & 1) === 1
                    const seq = body.readUInt32BE(1)
                    const timestampMs = body.readUInt32BE(5)
                    records.push({ type, key, seq, timestampMs, bytes: body.length - FRAME_HEAD_BYTES, t })
                } else if (type === SCREEN_TYPE.END) {
                    assert.equal(body.length, 1, `END body length for ${id}`)
                    records.push({ type, code: body[0], t })
                } else {
                    records.push({ type, body, t })
                }
                buf = buf.subarray(4 + len)
            }
            return buf
        }
    }

    function add(id, { delayMs = defaultDelayMs, autoAck = true, send: customSend, onDrain } = {}) {
        const parse = createParser(id)
        const state = {
            id,
            delayMs,
            autoAck,
            records: [],
            leftoverBytes: () => 0,
            drainResolve: null
        }
        let lastBuf = Buffer.alloc(0)
        const send = bytes => {
            if (customSend) {
                const res = customSend(bytes, parse)
                lastBuf = parse(bytes)
                return res
            }
            lastBuf = parse(bytes)
            return true
        }
        // Re-wrap parse so records are exposed cleanly on state.records.
        let buf = Buffer.alloc(0)
        const parseIntoState = bytes => {
            buf = Buffer.concat([buf, Buffer.from(bytes)])
            while (buf.length >= 4) {
                const len = buf.readUInt32BE(0)
                assert.ok(len >= 1 && len <= 1 + FRAME_HEAD_BYTES + MAX_SCREEN_FRAME_BYTES, `bad record length ${len} for ${id}`)
                if (buf.length < 4 + len) break
                const type = buf[4]
                const body = buf.subarray(5, 4 + len)
                if (type === SCREEN_TYPE.CONFIG) {
                    state.records.push({ type, cfg: JSON.parse(body.toString('utf8')), t })
                } else if (type === SCREEN_TYPE.FRAME) {
                    assert.ok(body.length >= FRAME_HEAD_BYTES + 1, `short FRAME body for ${id}`)
                    state.records.push({
                        type,
                        key: (body[0] & 1) === 1,
                        seq: body.readUInt32BE(1),
                        timestampMs: body.readUInt32BE(5),
                        bytes: body.length - FRAME_HEAD_BYTES,
                        t
                    })
                } else if (type === SCREEN_TYPE.END) {
                    assert.equal(body.length, 1, `END body length for ${id}`)
                    state.records.push({ type, code: body[0], t })
                } else {
                    state.records.push({ type, body, t })
                }
                buf = buf.subarray(4 + len)
            }
            return buf.length
        }
        state.leftoverBytes = () => buf.length
        const wrappedSend = bytes => {
            if (customSend) {
                const ok = customSend(bytes)
                parseIntoState(bytes)
                return ok
            }
            parseIntoState(bytes)
            return true
        }
        const defaultOnDrain = () => new Promise(resolve => { state.drainResolve = resolve })
        const res = forwarder.addChild(id, { send: wrappedSend, onDrain: onDrain ?? defaultOnDrain })
        if (res.ok) children.set(id, state)
        return { ...res, state }
    }

    let nextFrameAt = 0
    let nextEvalAt = 500
    let seq = 0

    function step(ms, { fps = 30, tickStep = 5, frameBytes = 3000, keyEvery = 30, autoFrames = true } = {}) {
        const end = t + ms
        while (t < end) {
            t += tickStep
            if (autoFrames && t >= nextFrameAt) {
                nextFrameAt += 1000 / fps
                const key = seq % keyEvery === 0
                forwarder.onFrame(encodeFrameBody({ key, seq, timestampMs: t, size: frameBytes }))
                seq++
            }
            forwarder.tick()
            for (const c of forwarder.children()) {
                const st = children.get(c.id)
                if (!st || !st.autoAck) continue
                const d = typeof st.delayMs === 'function' ? st.delayMs(t) : st.delayMs
                for (const [s, u] of [...c.unacked]) {
                    if (t - u.at >= d) forwarder.onAck(c.id, s)
                    else break
                }
            }
            if (t >= nextEvalAt) {
                nextEvalAt += 500
                forwarder.evaluate()
            }
        }
    }

    return {
        forwarder,
        children,
        keyRequests,
        sheds,
        reports,
        allowedSet,
        add,
        step,
        now: () => t,
        advance: ms => { t += ms },
        setVoicePressure: v => { voicePressured = v },
        nextSeq: () => seq++
    }
}

test('CONFIG caching and needKey alignment for early, late, and reconfigured children', () => {
    const h = createHarness()

    // Child joins before CONFIG arrives: gets no frames until CONFIG + keyframe.
    const early = h.add('a')
    assert.equal(early.ok, true)
    assert.equal(h.forwarder.hasConfig(), false)
    h.forwarder.onFrame(encodeFrameBody({ key: true, seq: 0, size: 1200 }))
    h.step(50, { autoFrames: false })
    assert.equal(early.state.records.length, 0)

    // CONFIG arrives, followed by delta (ignored) and then keyframe (delivered).
    assert.equal(h.forwarder.onConfig(encodeConfig({ width: 1280, height: 720 })), true)
    assert.equal(h.forwarder.hasConfig(), true)
    h.forwarder.onFrame(encodeFrameBody({ key: false, seq: 1, size: 1200 }))
    h.forwarder.onFrame(encodeFrameBody({ key: true, seq: 2, size: 1200 }))
    h.forwarder.onFrame(encodeFrameBody({ key: false, seq: 3, size: 1200 }))
    h.step(100, { autoFrames: false })

    assert.equal(early.state.records.length, 3)
    assert.equal(early.state.records[0].type, SCREEN_TYPE.CONFIG)
    assert.equal(early.state.records[0].cfg.width, 1280)
    assert.equal(early.state.records[1].type, SCREEN_TYPE.FRAME)
    assert.equal(early.state.records[1].key, true)
    assert.equal(early.state.records[1].seq, 2)
    assert.equal(early.state.records[2].seq, 3)
    assert.equal(early.state.leftoverBytes(), 0)

    // Late child joins after CONFIG: receives cached CONFIG immediately, waits for next keyframe.
    const late = h.add('b')
    assert.equal(late.ok, true)
    h.forwarder.onFrame(encodeFrameBody({ key: false, seq: 4, size: 1200 }))
    h.step(50, { autoFrames: false })
    assert.equal(late.state.records.length, 1)
    assert.equal(late.state.records[0].type, SCREEN_TYPE.CONFIG)

    h.forwarder.onFrame(encodeFrameBody({ key: true, seq: 5, size: 1200 }))
    h.step(50, { autoFrames: false })
    assert.equal(late.state.records.length, 2)
    assert.equal(late.state.records[1].key, true)
    assert.equal(late.state.records[1].seq, 5)

    // Mid-stream CONFIG change resets needKey for all children until next keyframe.
    h.forwarder.onConfig(encodeConfig({ width: 1920, height: 1080 }))
    h.forwarder.onFrame(encodeFrameBody({ key: false, seq: 6, size: 1200 }))
    h.step(50, { autoFrames: false })
    assert.equal(early.state.records.at(-1).type, SCREEN_TYPE.CONFIG)
    assert.equal(early.state.records.at(-1).cfg.width, 1920)
    assert.equal(late.state.records.at(-1).type, SCREEN_TYPE.CONFIG)
    assert.equal(late.state.records.at(-1).cfg.width, 1920)

    h.forwarder.onFrame(encodeFrameBody({ key: true, seq: 7, size: 1200 }))
    h.step(50, { autoFrames: false })
    assert.equal(early.state.records.at(-1).seq, 7)
    assert.equal(late.state.records.at(-1).seq, 7)
})

test('per-child non-blocking queue and record-boundary-safe dropping', async () => {
    const h = createHarness({ params: { minQueueBytes: 12000, maxQueueBytes: 12000, queueSeconds: 1, startBitrate: 4000000 } })
    h.forwarder.onConfig(encodeConfig())

    let blockA = false
    let aSendCount = 0
    const a = h.add('a', {
        send: () => {
            aSendCount++
            // Block mid-record on the 3rd slice write (a 6000-byte frame takes multiple 2048-byte slices).
            if (aSendCount === 3) {
                blockA = true
                return false
            }
            return !blockA
        }
    })
    const b = h.add('b')
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)

    // Keyframe 0 (6000 bytes -> 3+ slices): child A blocks mid-record on slice 3; child B finishes cleanly.
    h.forwarder.onFrame(encodeFrameBody({ key: true, seq: 0, size: 6000 }))
    h.step(30, { autoFrames: false })
    assert.equal(h.forwarder.child('a').blocked, true)
    assert.ok(a.state.leftoverBytes() > 0, 'child A paused mid-record without blocking forwarder')
    assert.equal(b.state.records.filter(r => r.type === SCREEN_TYPE.FRAME).length, 1)
    assert.equal(b.state.leftoverBytes(), 0)

    // Push more frames so child A queue exceeds minQueueBytes and drops unstarted queued frames,
    // while child B receives every single frame unaffected.
    for (let s = 1; s <= 6; s++) {
        h.forwarder.onFrame(encodeFrameBody({ key: false, seq: s, size: 3000 }))
        h.step(20, { autoFrames: false })
    }
    const bFrames = b.state.records.filter(r => r.type === SCREEN_TYPE.FRAME)
    assert.equal(bFrames.length, 7)
    assert.equal(b.state.leftoverBytes(), 0)
    assert.ok(h.forwarder.child('a').drops > 0, 'child A dropped queued frames')
    assert.equal(h.forwarder.child('a').needKey, true)

    // Unblock child A via onDrain(): it finishes the in-flight record cleanly with zero corruption,
    // then resumes cleanly on the next keyframe.
    blockA = false
    a.state.drainResolve()
    await Promise.resolve()
    h.step(40, { autoFrames: false })
    assert.equal(h.forwarder.child('a').blocked, false)
    assert.equal(a.state.leftoverBytes(), 0, 'in-flight record completed cleanly on record boundary')

    // Next keyframe arrives: child A recovers and receives it cleanly.
    h.forwarder.onFrame(encodeFrameBody({ key: true, seq: 7, size: 2000 }))
    h.step(50, { autoFrames: false })
    const aFrames = a.state.records.filter(r => r.type === SCREEN_TYPE.FRAME)
    assert.equal(aFrames.at(-1).seq, 7)
    assert.equal(aFrames.at(-1).key, true)
    assert.equal(a.state.leftoverBytes(), 0)
})

test('slow-child isolation sheds only the slow child without marking forwarder congested', () => {
    const h = createHarness({
        params: {
            slowGraceMs: 1000,
            slowExcessMs: 1500,
            uplinkHoldMs: 1500
        }
    })
    h.forwarder.onConfig(encodeConfig())

    const fast = h.add('a', { delayMs: 10 })
    const slow = h.add('b', { delayMs: 10 })
    assert.equal(fast.ok, true)
    assert.equal(slow.ok, true)

    // Establish baseline RTT of 10 ms for both children.
    h.step(1000, { frameBytes: 1500, keyEvery: 15 })
    assert.equal(h.forwarder.isCongested(), false)

    // Child B's ACK delay spikes to 150 ms (> 70 ms excess) while child A stays at 10 ms.
    slow.state.delayMs = 150
    h.step(2500, { frameBytes: 1500, keyEvery: 15 })

    assert.equal(h.forwarder.hasChild('a'), true, 'fast sibling remains attached')
    assert.equal(h.forwarder.hasChild('b'), false, 'slow child was shed')
    assert.equal(h.forwarder.isCongested(), false, 'forwarder is not marked congested')
    assert.equal(h.forwarder.maxChildren(), FORWARDER_DEFAULTS.maxChildren, 'maxChildren unchanged')

    const bEnd = slow.state.records.at(-1)
    assert.equal(bEnd.type, SCREEN_TYPE.END)
    assert.equal(bEnd.code, SCREEN_END.slow)
    assert.ok(h.sheds.some(s => s.childId === 'b' && s.reportReason === 'slow' && s.wireReason === 'slow'))
    assert.ok(h.reports.some(r => r.event === 'child-shed' && r.childPeerId === 'b' && r.reason === 'slow'))
})

test('uplink saturation sheds newest child with END(full), lowers maxChildren, and recovers', () => {
    const h = createHarness({
        params: {
            uplinkHoldMs: 1000,
            congestedClearMs: 2000,
            congestedBackoffMs: 5000
        }
    })
    h.forwarder.onConfig(encodeConfig())

    const first = h.add('a', { delayMs: 10 })
    const second = h.add('b', { delayMs: 10 })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)

    // Baseline 10 ms RTT.
    h.step(1000, { frameBytes: 1500, keyEvery: 15 })

    // Both children simultaneously see high ACK delay -> forwarder uplink saturation.
    first.state.delayMs = 150
    second.state.delayMs = 150
    h.step(2000, { frameBytes: 1500, keyEvery: 15 })

    assert.equal(h.forwarder.isCongested(), true)
    assert.equal(h.forwarder.hasChild('a'), true)
    assert.equal(h.forwarder.hasChild('b'), false, 'newest child shed on uplink saturation')
    assert.equal(h.forwarder.maxChildren(), 1, 'maxChildren lowered')

    const bEnd = second.state.records.at(-1)
    assert.equal(bEnd.type, SCREEN_TYPE.END)
    assert.equal(bEnd.code, SCREEN_END.full)
    assert.ok(h.sheds.some(s => s.childId === 'b' && s.reportReason === 'congested' && s.wireReason === 'full'))

    // New child is refused with 'full' while congested.
    const rejected = h.add('c')
    assert.equal(rejected.ok, false)
    assert.equal(rejected.reason, 'full')

    // Remaining child returns to calm; congested clears after congestedClearMs,
    // and maxChildren restores after congestedBackoffMs.
    first.state.delayMs = 10
    h.step(3000, { frameBytes: 1500, keyEvery: 15 })
    assert.equal(h.forwarder.isCongested(), false)

    h.step(5500, { frameBytes: 1500, keyEvery: 15 })
    assert.equal(h.forwarder.maxChildren(), 2)
})

test('voice backpressure triggers uplink saturation even with a single child', () => {
    const h = createHarness({ params: { uplinkHoldMs: 1000 } })
    h.forwarder.onConfig(encodeConfig())

    const a = h.add('a', { delayMs: 10 })
    assert.equal(a.ok, true)
    h.step(500, { frameBytes: 1500, keyEvery: 15 })

    h.setVoicePressure(true)
    h.step(1500, { frameBytes: 1500, keyEvery: 15 })

    assert.equal(h.forwarder.isCongested(), true)
    assert.equal(h.forwarder.hasChild('a'), false)
    assert.equal(h.forwarder.maxChildren(), 0)
    assert.equal(a.state.records.at(-1).type, SCREEN_TYPE.END)
    assert.equal(a.state.records.at(-1).code, SCREEN_END.full)
})

test('coalesced and rate-limited KEYREQ propagation upward', () => {
    const h = createHarness({ params: { keyRequestMs: 2000 } })
    h.forwarder.onConfig(encodeConfig())

    // First child join triggers immediate KEYREQ at t=0.
    h.add('a')
    assert.equal(h.keyRequests.length, 1)

    // Burst: second child joins and both send KEYREQ within keyRequestMs -> coalesced.
    h.advance(500)
    h.add('b')
    assert.equal(h.forwarder.onChildKeyRequest('a'), true)
    assert.equal(h.forwarder.onChildKeyRequest('b'), true)
    assert.equal(h.forwarder.onChildKeyRequest('unknown'), false)
    assert.equal(h.keyRequests.length, 1)

    // Before 2000 ms, still rate-limited.
    h.advance(1000) // t=1500
    h.forwarder.tick()
    assert.equal(h.keyRequests.length, 1)

    // At t=2000, exactly one coalesced KEYREQ fires.
    h.advance(500) // t=2000
    h.forwarder.tick()
    assert.equal(h.keyRequests.length, 2)

    // If a keyframe arrives before the rate-limit window expires, pending KEYREQ is suppressed.
    h.advance(200) // t=2200
    assert.equal(h.forwarder.onChildKeyRequest('a'), true)
    h.forwarder.onFrame(encodeFrameBody({ key: true, seq: 0, size: 1200 }))
    h.advance(2500) // t=4700
    h.forwarder.tick()
    assert.equal(h.keyRequests.length, 2)
})

test('periodic allowed(childPeerId) check cuts off revoked child immediately', () => {
    const h = createHarness()
    h.forwarder.onConfig(encodeConfig())

    const a = h.add('a')
    const b = h.add('b')
    h.forwarder.onFrame(encodeFrameBody({ key: true, seq: 0, size: 1500 }))
    h.step(100, { autoFrames: false })

    // Revoke child A; evaluate() / checkAllowed() cuts it off with END(refused).
    h.allowedSet.delete('a')
    const revoked = h.forwarder.checkAllowed()
    assert.deepEqual(revoked, ['a'])
    assert.equal(h.forwarder.hasChild('a'), false)
    assert.equal(h.forwarder.hasChild('b'), true)
    assert.equal(a.state.records.at(-1).type, SCREEN_TYPE.END)
    assert.equal(a.state.records.at(-1).code, SCREEN_END.refused)
    assert.ok(h.sheds.some(s => s.childId === 'a' && s.reportReason === 'refused' && s.wireReason === 'refused'))

    // Subsequent frames reach B only, and A cannot re-join while disallowed.
    h.forwarder.onFrame(encodeFrameBody({ key: false, seq: 1, size: 1500 }))
    h.step(50, { autoFrames: false })
    assert.equal(b.state.records.filter(r => r.type === SCREEN_TYPE.FRAME).length, 2)
    const refused = h.add('a')
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'refused')
})

test('child replacement sends END(replaced) and send() exception sheds child with END(error)', () => {
    const h = createHarness()
    h.forwarder.onConfig(encodeConfig())

    const firstA = h.add('a')
    assert.equal(firstA.ok, true)
    const secondA = h.add('a')
    assert.equal(secondA.ok, true)
    assert.equal(firstA.state.records.at(-1).type, SCREEN_TYPE.END)
    assert.equal(firstA.state.records.at(-1).code, SCREEN_END.replaced)
    assert.equal(h.forwarder.childCount(), 1)

    let shouldThrow = false
    const failing = h.add('b', {
        send: () => {
            if (shouldThrow) throw new Error('stream reset')
            return true
        }
    })
    assert.equal(failing.ok, true)
    h.forwarder.onFrame(encodeFrameBody({ key: true, seq: 0, size: 1500 }))
    h.step(50, { autoFrames: false })

    shouldThrow = true
    h.forwarder.onFrame(encodeFrameBody({ key: false, seq: 1, size: 1500 }))
    h.step(500, { autoFrames: false })
    assert.equal(h.forwarder.hasChild('b'), false)
    assert.ok(h.sheds.some(s => s.childId === 'b' && s.reportReason === 'error' && s.wireReason === 'error'))
    assert.equal(h.forwarder.hasChild('a'), true)
})
