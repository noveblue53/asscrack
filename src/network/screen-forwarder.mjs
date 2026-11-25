// Per-child raw-frame forwarder, pacer, and congestion detector for screen share fanout.
// A pure module: no libp2p and no timers. The caller provides `now()`, pushes upstream CONFIG and FRAME bodies,
// calls tick() for per-child pacing, forwards ACKs and KEYREQs, and calls evaluate() periodically.
import { FRAME_HEAD_BYTES, SCREEN_TYPE } from './screen-rate.mjs'

export const SCREEN_END = Object.freeze({
    stopped: 1, source: 2, idle: 3, slow: 4, full: 5, refused: 6, replaced: 7, error: 8
})

export const FORWARDER_DEFAULTS = Object.freeze({
    sliceBytes: 2048,
    queueSeconds: 1,
    minQueueBytes: 256 * 1024,
    maxQueueBytes: 2 * 1024 * 1024,
    paceFactor: 1.25,
    paceBurstS: 0.03,
    startBitrate: 1500000,
    rateWindowMs: 1000,
    evalMs: 500,
    lateMs: 300,
    lateCapMs: 1000,
    highMs: 70,
    lowMs: 35,
    slowMs: 10000,
    slowExcessMs: 3000,
    slowGraceMs: 3000,
    uplinkHoldMs: 1500,
    congestedClearMs: 5000,
    congestedBackoffMs: 30000,
    keyRequestMs: 2000,
    maxChildren: 2
})

/** Frame a screen protocol record as `[uint32be length][uint8 type][body]`. */
export function wireRecord(type, body = new Uint8Array(0)) {
    const out = new Uint8Array(5 + body.length)
    new DataView(out.buffer).setUint32(0, 1 + body.length)
    out[4] = type
    out.set(body, 5)
    return out
}

/** Build an END wire record for a named reason. */
export function endRecord(reason) {
    return wireRecord(SCREEN_TYPE.END, Uint8Array.of(SCREEN_END[reason] ?? SCREEN_END.stopped))
}

const p95 = values => {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor((sorted.length - 1) * 0.95)]
}

const clampMaxChildren = n => {
    const v = Number(n)
    return Number.isInteger(v) ? Math.max(0, Math.min(8, v)) : FORWARDER_DEFAULTS.maxChildren
}

/**
 * Create a deterministic raw-frame forwarder with per-child pacing, record-boundary-safe queue
 * dropping, slow-child vs. uplink-saturation detection, coalesced KEYREQ, and revocation cutoff.
 */
export function createScreenForwarder({
    now,
    allowed = () => true,
    voiceBackpressure = () => false,
    onKeyRequest = () => {},
    onShed = () => {},
    onReport = () => {},
    params = {}
} = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function')
    const P = { ...FORWARDER_DEFAULTS, ...params }

    let latestConfig = null
    const children = new Map()
    let joinSeq = 0
    let configuredMaxChildren = clampMaxChildren(P.maxChildren)
    let effectiveMaxChildren = configuredMaxChildren
    let congested = false
    let congestedAt = -Infinity
    let uplinkHighSince = null
    let calmSince = null
    let manualUplinkPressure = false
    const incomingWindow = []
    let keyWanted = false
    let lastKeyRequestAt = -Infinity
    let keyRequests = 0

    const oldestOutstanding = c => {
        for (const u of c.unacked.values()) return u.at
        return Infinity
    }
    const lateLimit = c => Math.min((Number.isFinite(c.base) ? c.base : 100) + P.lateMs, P.lateCapMs)

    function pruneIncoming(t) {
        while (incomingWindow.length && t - incomingWindow[0].t > P.rateWindowMs) incomingWindow.shift()
    }

    function measuredBitrate(t = now()) {
        pruneIncoming(t)
        if (!incomingWindow.length) return P.startBitrate
        let bytes = 0
        for (const item of incomingWindow) bytes += item.bytes
        return Math.max(P.startBitrate, Math.round(bytes * 8 * 1000 / P.rateWindowMs))
    }

    // Remove only unstarted frame records (`seq !== null`), preserving any in-flight `c.current` or CONFIG.
    function dropQueuedFrames(c) {
        const kept = []
        for (const item of c.queue) {
            if (item.seq === null) kept.push(item)
            else c.queuedBytes -= item.wire.length
        }
        c.queue = kept
    }

    function maybeEmitKeyRequest() {
        const t = now()
        if (!keyWanted || children.size === 0 || t - lastKeyRequestAt < P.keyRequestMs) return false
        keyWanted = false
        lastKeyRequestAt = t
        keyRequests++
        onKeyRequest()
        return true
    }

    function wantKey() {
        keyWanted = true
        maybeEmitKeyRequest()
    }

    function recoverIfClear(c) {
        if (c.recovering && !c.current && !c.queue.some(item => item.seq !== null) && c.unacked.size === 0) {
            c.recovering = false
            wantKey()
        }
    }

    // Finish any started record cleanly, then send END(reason) and remove the child.
    function flushChild(c, wireReason) {
        try {
            if (c.current) c.send(c.current.item.wire.subarray(c.current.offset))
            c.current = null
            if (wireReason) c.send(endRecord(wireReason))
        } catch {
            // Stream closed.
        }
        children.delete(c.id)
    }

    function enqueueConfig(c, wire) {
        c.queue.push({ wire, seq: null, isConfig: true })
        c.queuedBytes += wire.length
        c.configSent = true
    }

    function onConfig(body) {
        if (!(body instanceof Uint8Array) || body.length < 1) return false
        const wire = wireRecord(SCREEN_TYPE.CONFIG, body)
        latestConfig = { wire, body: new Uint8Array(body) }
        for (const c of children.values()) {
            dropQueuedFrames(c)
            c.needKey = true
            c.recovering = false
            enqueueConfig(c, wire)
        }
        return true
    }

    function addChild(childId, { send, onDrain } = {}) {
        if (typeof send !== 'function') throw new TypeError('send must be a function')
        if (!allowed(childId)) return { ok: false, reason: 'refused' }
        const existing = children.get(childId)
        if (!existing && (congested || children.size >= effectiveMaxChildren)) {
            return { ok: false, reason: 'full' }
        }
        if (existing) flushChild(existing, 'replaced')
        const t = now()
        const c = {
            id: childId,
            send,
            onDrain: onDrain ?? (() => Promise.resolve()),
            tokens: 0,
            lastTick: t,
            queue: [],
            queuedBytes: 0,
            current: null,
            blocked: false,
            needKey: true,
            recovering: false,
            configSent: false,
            unacked: new Map(),
            base: Infinity,
            samples: [],
            excess: 0,
            lateNow: false,
            congestedNow: false,
            behindSince: null,
            highSince: null,
            addedAt: t,
            joinedOrder: ++joinSeq,
            sendFailed: false,
            drops: 0,
            sentFrames: 0,
            sentBytes: 0,
            keys: 0,
            ackedFrames: 0
        }
        children.set(childId, c)
        if (latestConfig) enqueueConfig(c, latestConfig.wire)
        wantKey()
        onReport({
            event: 'child-joined',
            childPeerId: childId,
            children: children.size,
            maxChildren: effectiveMaxChildren,
            congested
        })
        return { ok: true }
    }

    function removeChild(childId, reason = 'stopped') {
        const c = children.get(childId)
        if (!c) return false
        flushChild(c, reason)
        onReport({
            event: 'child-left',
            childPeerId: childId,
            reason,
            children: children.size,
            maxChildren: effectiveMaxChildren,
            congested
        })
        return true
    }

    function onFrame(body) {
        if (!(body instanceof Uint8Array) || body.length < FRAME_HEAD_BYTES + 1) return false
        const t = now()
        const key = (body[0] & 1) === 1
        const seq = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1)
        const wire = wireRecord(SCREEN_TYPE.FRAME, body)
        incomingWindow.push({ t, bytes: wire.length })
        const queueBudget = Math.max(
            P.minQueueBytes,
            Math.min(P.maxQueueBytes, Math.round(measuredBitrate(t) / 8 * P.queueSeconds))
        )
        for (const c of children.values()) {
            if (!c.configSent || (c.needKey && !key)) continue
            const late = (t - oldestOutstanding(c)) > lateLimit(c)
            const queueFull = c.queue.length > 0 && (c.queuedBytes + wire.length > queueBudget)
            if (late || queueFull) {
                dropQueuedFrames(c)
                c.drops++
                c.needKey = true
                c.recovering = true
                c.congestedNow = true
                c.behindSince ??= t
                recoverIfClear(c)
                continue
            }
            if (key) {
                c.needKey = false
                c.behindSince = null
                c.keys++
            }
            c.queue.push({ wire, seq, key })
            c.queuedBytes += wire.length
            c.sentFrames++
            c.sentBytes += wire.length
        }
        if (key && keyWanted && [...children.values()].every(c => !c.needKey)) keyWanted = false
        return true
    }

    function drainChild(c, budget, t) {
        let wrote = 0
        while (!c.blocked && budget - wrote >= 1) {
            if (!c.current) {
                const item = c.queue.shift()
                if (!item) break
                c.queuedBytes -= item.wire.length
                c.current = { item, offset: 0 }
            }
            const { item } = c.current
            const n = Math.min(P.sliceBytes, item.wire.length - c.current.offset, Math.ceil(budget - wrote))
            let ok
            try {
                ok = c.send(item.wire.subarray(c.current.offset, c.current.offset + n))
            } catch {
                c.sendFailed = true
                c.blocked = true
                return wrote
            }
            c.current.offset += n
            wrote += n
            if (c.current.offset === item.wire.length) {
                if (item.seq !== null) {
                    c.unacked.set(item.seq, { at: t, bytes: item.wire.length, key: item.key === true })
                }
                c.current = null
            }
            if (ok === false) {
                c.blocked = true
                Promise.resolve(c.onDrain()).then(() => { c.blocked = false }, () => {})
            }
        }
        return wrote
    }

    function tick() {
        const t = now()
        const paceRate = P.paceFactor * measuredBitrate(t) / 8
        const maxBurst = paceRate * P.paceBurstS
        for (const c of children.values()) {
            c.tokens = Math.min(maxBurst, c.tokens + Math.max(0, t - c.lastTick) / 1000 * paceRate)
            c.lastTick = t
        }
        let total = 0
        let progress = true
        while (progress) {
            progress = false
            for (const c of children.values()) {
                if (c.blocked || c.tokens < 1) continue
                const wrote = drainChild(c, Math.min(c.tokens, P.sliceBytes), t)
                if (wrote > 0) {
                    c.tokens -= wrote
                    total += wrote
                    progress = true
                }
            }
        }
        maybeEmitKeyRequest()
        return total
    }

    function onAck(childId, seq) {
        const c = children.get(childId)
        if (!c || !c.unacked.has(seq)) return false
        const t = now()
        for (const [s, u] of c.unacked) {
            if (s === seq && !c.needKey && !c.recovering) {
                const sample = t - u.at
                c.base = Math.min(c.base, sample)
                c.samples.push(sample)
            }
            c.unacked.delete(s)
            c.ackedFrames++
            if (s === seq) break
        }
        recoverIfClear(c)
        return true
    }

    function onChildKeyRequest(childId) {
        if (!children.has(childId)) return false
        wantKey()
        return true
    }

    function checkAllowed() {
        const revoked = []
        for (const c of [...children.values()]) {
            if (allowed(c.id)) continue
            flushChild(c, 'refused')
            revoked.push(c.id)
            onShed(c.id, 'refused', 'refused')
            onReport({
                event: 'child-left',
                childPeerId: c.id,
                reason: 'stopped',
                children: children.size,
                maxChildren: effectiveMaxChildren,
                congested
            })
        }
        return revoked
    }

    function shedChild(c, reportReason, wireReason) {
        flushChild(c, wireReason)
        onShed(c.id, reportReason, wireReason)
        onReport({
            event: 'child-shed',
            childPeerId: c.id,
            reason: reportReason,
            children: children.size,
            maxChildren: effectiveMaxChildren,
            congested
        })
    }

    function evaluate() {
        const t = now()
        checkAllowed()
        for (const c of [...children.values()]) {
            if (c.sendFailed) shedChild(c, 'error', 'error')
        }

        for (const c of children.values()) {
            const d = p95(c.samples)
            c.samples = []
            c.excess = d === null || !Number.isFinite(c.base) ? 0 : Math.max(0, d - c.base)
            const staleLate = (t - oldestOutstanding(c)) > lateLimit(c)
            c.lateNow = c.congestedNow || staleLate || c.excess > P.highMs
            c.congestedNow = false
            if (c.lateNow) c.highSince ??= t
            else if (c.excess < P.lowMs) c.highSince = null
        }

        const voicePressured = manualUplinkPressure || voiceBackpressure() === true
        const list = [...children.values()]
        const allChildrenCongested = list.length >= 2 && list.every(c => c.lateNow)
        const saturatedNow = (voicePressured && list.length >= 1) || allChildrenCongested
        if (saturatedNow) uplinkHighSince ??= t
        else uplinkHighSince = null

        if (uplinkHighSince !== null && t - uplinkHighSince >= P.uplinkHoldMs) {
            let newest = list[0]
            for (const c of list) if (c.joinedOrder > newest.joinedOrder) newest = c
            congested = true
            congestedAt = t
            calmSince = null
            uplinkHighSince = null
            effectiveMaxChildren = Math.max(0, Math.min(effectiveMaxChildren - 1, list.length - 1))
            shedChild(newest, 'congested', 'full')
        } else if (!saturatedNow) {
            const hasCalmSibling = list.some(c => !c.lateNow && c.excess < P.lowMs && c.behindSince === null)
            for (const c of list) {
                const behindTimedOut = c.behindSince !== null && t - c.behindSince >= P.slowMs
                const excessTimedOut = (t - c.addedAt >= P.slowGraceMs) &&
                    c.highSince !== null && (t - c.highSince >= P.slowExcessMs) &&
                    (hasCalmSibling || list.length === 1)
                if (behindTimedOut || excessTimedOut) shedChild(c, 'slow', 'slow')
            }
        }

        if (congested) {
            const allCalm = !voicePressured &&
                [...children.values()].every(c => !c.lateNow && c.excess < P.lowMs && c.behindSince === null)
            if (allCalm) {
                calmSince ??= t
                if (t - calmSince >= P.congestedClearMs) {
                    congested = false
                    calmSince = null
                    onReport({
                        event: 'capacity',
                        children: children.size,
                        maxChildren: effectiveMaxChildren,
                        congested: false
                    })
                }
            } else {
                calmSince = null
            }
        } else if (effectiveMaxChildren < configuredMaxChildren && t - congestedAt >= P.congestedBackoffMs) {
            effectiveMaxChildren = Math.min(configuredMaxChildren, effectiveMaxChildren + 1)
            congestedAt = t
            onReport({
                event: 'capacity',
                children: children.size,
                maxChildren: effectiveMaxChildren,
                congested: false
            })
        }

        maybeEmitKeyRequest()
    }

    function setMaxChildren(n) {
        configuredMaxChildren = clampMaxChildren(n)
        if (!congested) effectiveMaxChildren = configuredMaxChildren
        else effectiveMaxChildren = Math.min(effectiveMaxChildren, configuredMaxChildren)
    }

    function setUplinkPressure(active) {
        manualUplinkPressure = active === true
    }

    function stop(reason = 'stopped') {
        for (const c of [...children.values()]) flushChild(c, reason)
        keyWanted = false
        uplinkHighSince = null
        calmSince = null
    }

    return {
        onConfig,
        onFrame,
        addChild,
        removeChild,
        tick,
        onAck,
        onChildKeyRequest,
        checkAllowed,
        evaluate,
        setMaxChildren,
        setUplinkPressure,
        stop,
        hasConfig: () => latestConfig !== null,
        hasChild: id => children.has(id),
        childCount: () => children.size,
        maxChildren: () => effectiveMaxChildren,
        isCongested: () => congested,
        child: id => children.get(id) ?? null,
        children: () => [...children.values()],
        stats: () => ({
            children: children.size,
            maxChildren: effectiveMaxChildren,
            configuredMaxChildren,
            congested,
            keyRequests,
            measuredBitrate: measuredBitrate()
        })
    }
}
