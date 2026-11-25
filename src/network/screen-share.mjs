// Screen share protocol of a room (work-orders/astra/P8/DESIGN.md, revision 2, sections 2.3, 2.6, 2.8, 2.9 and 3).
// The share state (the `screen` control line), the stream `/asscrack/screen/1.0.0`, the records, the viewers, the
// pacer timer, the refresh tick of rule E5 and the 10 s rule of section 2.8. The rate rules are in screen-rate.mjs.
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { roomRateLimit } from './room-rate-limit.mjs'
import { createScreenRate, FRAME_HEAD_BYTES, MAX_SCREEN_FRAME_BYTES, SCREEN_QUALITIES, SCREEN_TYPE as TYPE } from './screen-rate.mjs'
import { createGlobalSlotLedger, createScreenFanout, FANOUT_DEFAULTS } from './screen-fanout.mjs'
import { createScreenForwarder } from './screen-forwarder.mjs'

export { SCREEN_PRESETS, SCREEN_QUALITIES } from './screen-rate.mjs'
export const SCREEN_PROTOCOL = '/asscrack/screen/1.0.0'
export const SCREEN_FANOUT_PROTOCOL = '/asscrack/screen-fanout/1.0.0'
// Section 3.2: the END reasons on the wire.
export const SCREEN_END = Object.freeze({ stopped: 1, source: 2, idle: 3, slow: 4, full: 5, refused: 6, replaced: 7, error: 8 })
const END_NAME = Object.fromEntries(Object.entries(SCREEN_END).map(([name, code]) => [code, name]))
// Section 4: the reasons of stopScreenShare. `isolated` and `limit` are `stopped` on the wire.
const STOP_REASONS = new Set(['stopped', 'source', 'idle', 'error', 'isolated', 'limit'])
export const MAX_VIEWER_RECORD = 256
export const MAX_FANOUT_VIEWER_RECORD = 512
export const MAX_SHARER_RECORD = 1 + FRAME_HEAD_BYTES + MAX_SCREEN_FRAME_BYTES
const MAX_WATCH_JSON = 255
const MAX_FANOUT_WATCH_JSON = 511
const MAX_REDIRECT_JSON = 1024
const MAX_CONFIG_JSON = 1023
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FANOUT_EVENTS = new Set(['child-joined', 'child-left', 'child-shed', 'capacity'])
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export const SCREEN_DEFAULTS = Object.freeze({
    maxViewers: 24, watchRecordMs: 5000, isolatedMs: 10000, watchTimeoutMs: 10000, paceTickMs: 10, evalMs: 500,
    keyRequestMs: 2000, opensPerPeer: 24, opensPerRoom: 192, closeWaitMs: 10000,
    // Multi-share (1.0.6): at most maxShares shares in a room at the same time (the own share and one share of each
    // other member). The relay limit of screen-rate.mjs (6 Mbit/s) is for each sharer, thus 3 shares keep the screen
    // data through a host relay at 18 Mbit/s or less. A viewer watches one share: its download does not change.
    maxShares: 3,
    // L11 (P10b): a share line of a peer stops the own share only in this time after the own start, and (1.0.6) only
    // when the room has more than maxShares shares (two members started at the same moment at the limit).
    // At most linesPerPeer screen lines of each peer each minute (linesPerRoom for all peers). Each member sends its own
    // lines, thus the limits do not change with the number of shares.
    conflictMs: 3000, linesPerPeer: 30, linesPerRoom: 240,
    // Diagnostics (1.0.1, REVIEW.md rank 9): each diagMs the sharer gives the new tier changes of the rate control and
    // the stats of each viewer ('screen-diag' events). At most diagEntries tier changes for each interval.
    diagMs: 10000, diagEntries: 40,
    // Fanout (Session 4): tree-assisted forwarding via /asscrack/screen-fanout/1.0.0 with Ed25519 redirect tokens.
    fanout: true, maxChildren: 2, maxDirectViewers: 1, redirectTokenMs: 15000,
    reparentDelayMs: 150, reparentMaxAttempts: 5, reparentWindowMs: 10000,
    fanoutLinesPerPeer: 120, fanoutLinesPerRoom: 1200,
    fanoutOptions: {}, forwarderParams: {},
    rate: {}, // parameters of screen-rate.mjs (for the tests: for example relayLimit)
    beforeRecord: null // test hook at the viewer: a function that can return a promise; the viewer reads no record until it settles
})

export function record(type, body = new Uint8Array(0)) {
    const out = new Uint8Array(5 + body.length)
    new DataView(out.buffer).setUint32(0, 1 + body.length)
    out[4] = type
    out.set(body, 5)
    return out
}
const jsonRecord = (type, value) => record(type, new TextEncoder().encode(JSON.stringify(value)))
const endRecord = reason => record(TYPE.END, Uint8Array.of(SCREEN_END[reason] ?? SCREEN_END.stopped))
function ackRecord(seq) {
    const body = new Uint8Array(4)
    new DataView(body.buffer).setUint32(0, seq >>> 0)
    return record(TYPE.ACK, body)
}

// Reads length-prefixed records. A length out of 1..maxBody throws before the payload is buffered.
export async function readRecords(source, onRecord, maxBody) {
    let parts = []
    let have = 0
    let need = null
    for await (const chunk of source) {
        let data = Buffer.from(typeof chunk.subarray === 'function' ? chunk.subarray() : chunk)
        while (data.length) {
            if (need === null) {
                const take = Math.min(4 - have, data.length)
                parts.push(data.subarray(0, take)); have += take; data = data.subarray(take)
                if (have < 4) break
                need = Buffer.concat(parts, 4).readUInt32BE(0)
                parts = []; have = 0
                if (need < 1 || need > maxBody) throw new RangeError(`screen record of ${need} bytes is not in the limits`)
            }
            const take = Math.min(need - have, data.length)
            parts.push(data.subarray(0, take)); have += take; data = data.subarray(take)
            if (have < need) break
            const body = parts.length === 1 ? parts[0] : Buffer.concat(parts, need)
            parts = []; have = 0; need = null
            const wait = onRecord(body[0], body.subarray(1))
            if (wait && typeof wait.then === 'function') await wait
        }
    }
}

function parseJson(body, max) {
    if (body.length > max) return null
    try {
        const value = JSON.parse(body.toString('utf8'))
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch { return null }
}
// Section 2.9: the checks of a CONFIG record at the viewer.
export function validConfig(value, shareId) {
    return value !== null && value.v === 1 && value.shareId === shareId && value.codec === 'vp8' &&
        Number.isInteger(value.width) && value.width >= 16 && value.width <= 2560 &&
        Number.isInteger(value.height) && value.height >= 16 && value.height <= 1440 &&
        (value.fps === undefined || (Number.isInteger(value.fps) && value.fps >= 1 && value.fps <= 60))
}
// Section 3.1: the checks of a `screen` line.
export function validScreenLine(control) {
    if (control?.v !== 1 || typeof control.sharing !== 'boolean') return false
    return !control.sharing || (typeof control.shareId === 'string' && UUID.test(control.shareId))
}

function abortStream(stream, reason) {
    try { stream?.abort?.(new Error(reason)) } catch { /* closed */ }
}

function parseFanoutPub(b64) {
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(b64)) return null
    try {
        const raw = Buffer.from(b64, 'base64url')
        if (raw.length !== 32) return null
        return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
    } catch {
        return null
    }
}

function tokenMessage({ shareId, sharerPeerId, parentPeerId, childPeerId, hop, tokenSeq, exp }) {
    return Buffer.from(`screen-fanout-v1\n${shareId}\n${sharerPeerId}\n${parentPeerId}\n${childPeerId}\n${hop}\n${tokenSeq}\n${exp}`, 'utf8')
}

function signRedirectToken(privateKey, fields) {
    return sign(null, tokenMessage(fields), privateKey).toString('base64url')
}

function verifyRedirectToken(pubKey, fields) {
    if (!pubKey || !fields || typeof fields.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(fields.sig)) return false
    if (!Number.isInteger(fields.hop) || fields.hop < 2 || fields.hop > FANOUT_DEFAULTS.maxHop) return false
    if (!Number.isInteger(fields.tokenSeq) || fields.tokenSeq < 1) return false
    if (!Number.isSafeInteger(fields.exp) || Date.now() > fields.exp) return false
    try {
        const sigBuf = Buffer.from(fields.sig, 'base64url')
        if (sigBuf.length !== 64) return false
        return verify(null, tokenMessage(fields), pubKey, sigBuf)
    } catch {
        return false
    }
}

function allViewerIds(share) {
    if (!share) return []
    if (!share.fanout) return [...share.viewers.keys()]
    const set = new Set(share.viewers.keys())
    for (const id of Object.keys(share.fanout.snapshot().nodes)) set.add(id)
    return [...set]
}

// libp2p: the node. allowed(peerId): an open session that memberAllowed permits. connectionFor(peerId): the
// connection of the chat session. sendLine(peerId, line) and broadcast(line): control lines on the chat sessions.
// openPeers(): the peers with an open session. idle(): Idle Peer. canShare(): the device can share (protected room).
export function createScreenShare({ libp2p, selfId, events, allowed, connectionFor, sendLine, broadcast, openPeers,
    getTopology = () => null, onTopologyChanged = () => {}, voiceBackpressure = () => false,
    idle = () => false, canShare = () => true, onOwnStop = () => {}, onUnwatch = () => {},
    onWatchParentChanged = () => {}, onForwarderChildLeft = () => {}, options = {} }) {
    const O = { ...SCREEN_DEFAULTS, ...options }
    const clock = () => performance.now()
    const allowOpen = roomRateLimit(O.opensPerPeer, O.opensPerRoom)
    const allowLine = roomRateLimit(O.linesPerPeer, O.linesPerRoom)
    const allowFanoutLine = roomRateLimit(O.fanoutLinesPerPeer, O.fanoutLinesPerRoom)
    const clampMaxChildren = n => (Number.isInteger(n) ? Math.max(0, Math.min(FANOUT_DEFAULTS.maxChildrenPerNode, n)) : FANOUT_DEFAULTS.defaultGlobalMaxChildren)
    let configuredMaxChildren = clampMaxChildren(O.maxChildren)
    const effectiveMaxChildren = () => (idle() || own || (watch && watch.hop >= FANOUT_DEFAULTS.maxHop)) ? 0 : configuredMaxChildren
    const slotLedger = createGlobalSlotLedger({ maxShares: O.maxShares, defaultCap: O.maxChildren })
    // One entry for each member: a member has at most one share. at: the time of the first line of this share ID.
    const peers = new Map() // peerId -> { shareId, preset, audio, fanoutPub, at }
    const peerTrees = new Map() // sharerPeerId -> [{ from, to, sharer }]
    // The open time of the session of each peer (opened). A share line on a session that opened after the own start can
    // come from an old share: its age is not known.
    const sessionOpenedAt = new Map()
    let own = null
    let watch = null
    let stopped = false
    let isolatedTimer = null
    const ended = []
    const closing = new Set()

    const screenLine = () => JSON.stringify(own
        ? { type: 'screen', v: 1, sharing: true, shareId: own.shareId, preset: own.quality, ...(own.audio ? { audio: true } : {}), ...(own.fanoutPub ? { fanoutPub: own.fanoutPub } : {}) }
        : { type: 'screen', v: 1, sharing: false })

    function closeStream(stream) {
        if (!stream) return
        const done = closeWithTimeout(stream).finally(() => closing.delete(done))
        closing.add(done)
    }
    async function closeWithTimeout(stream) {
        let timer
        try {
            await Promise.race([
                Promise.resolve(stream.close()),
                new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('close timeout')), O.closeWaitMs) })
            ])
        } catch { abortStream(stream, 'screen stream closed') } finally { clearTimeout(timer) }
    }

    // ---- The sharer ----

    function configRecord(tier) {
        return jsonRecord(TYPE.CONFIG, { v: 1, shareId: own.shareId, codec: 'vp8', width: tier.size.width, height: tier.size.height,
            fps: own.rate.ladder[tier.preset].fps })
    }

    function encoderView(flags = new Map()) {
        if (!own) return { tiers: [] }
        return {
            tiers: own.rate.tiers().map(t => ({ tier: t.tier, preset: t.preset, width: t.fitWidth, height: t.fitHeight, fps: t.fps,
                bitrate: t.bitrate, keyFrame: flags.get(t.tier)?.key === true, refresh: flags.get(t.tier)?.refresh === true })),
            capture: own.rate.capture(), cap: own.rate.cap(), cpu: own.rate.cpu()
        }
    }
    function viewersView() {
        if (!own) return { viewers: [], tiers: [], cap: null, relayed: [], cpu: null }
        const stats = own.rate.stats()
        const capBitrate = own.rate.ladder.find(p => p.id === (own.rate.fixed ? own.quality : stats.cap)).bitrate
        return {
            viewers: allViewerIds(own),
            tiers: own.rate.tiers().map(t => ({ tier: t.tier, role: t.role, preset: t.preset, bitrate: t.bitrate, viewers: t.viewers })),
            cap: stats.cap,
            // Section 2.5, item 4: a viewer that the relay part keeps below the bitrate of the selected preset.
            relayed: stats.viewers.filter(v => v.circuit && v.target < capBitrate).map(v => ({ peerId: v.peerId, bitrate: v.rate })),
            cpu: own.rate.cpu()
        }
    }
    function emitEncoder(flags) {
        const view = encoderView(flags)
        const text = JSON.stringify(view)
        if (flags?.size || text !== own?.lastEncoder) {
            if (own) own.lastEncoder = text
            events.emit('screen-encoder', view)
        }
    }
    function ownTreeEdges() {
        if (!own) return []
        const seen = new Set()
        const edges = []
        const add = (from, to) => {
            if (!from || !to || from === to) return
            const key = `${from}|${to}`
            if (seen.has(key)) return
            seen.add(key)
            edges.push([from, to])
        }
        if (own.fanout) {
            for (const [id, node] of Object.entries(own.fanout.snapshot().nodes)) {
                add(node.parentPeerId, id)
            }
        }
        for (const peerId of own.viewers.keys()) add(selfId, peerId)
        edges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
        return edges.slice(0, O.maxViewers)
    }
    function broadcastTree() {
        if (!own) return
        const line = JSON.stringify({
            type: 'screen-fanout',
            v: 1,
            shareId: own.shareId,
            event: 'tree',
            edges: ownTreeEdges()
        })
        if (line === own.lastTree) return
        own.lastTree = line
        broadcast(line)
        onTopologyChanged()
    }
    function emitViewers() {
        const view = viewersView()
        const text = JSON.stringify(view)
        if (own && text === own.lastViewers) return
        if (own) own.lastViewers = text
        events.emit('screen-viewers', view)
    }

    function pacerTick() {
        if (!own) return
        own.rate.tick()
        const flags = new Map()
        for (const t of own.rate.tiers()) {
            const key = own.rate.takeKeyRequest(t.tier)
            const refresh = !key && own.rate.takeRefresh(t.tier)
            if (key || refresh) flags.set(t.tier, { key, refresh })
        }
        if (flags.size || own.dirty) {
            own.dirty = false
            emitEncoder(flags)
            emitViewers()
        }
    }
    function evaluateTick() {
        if (!own) return
        // Section 2.9: a viewer that is not permitted now (for example a revoked device) loses the stream.
        for (const [peerId, v] of [...own.viewers]) if (!allowed(peerId)) endViewer(peerId, 'refused', v.stream)
        if (own.fanout) {
            let pruned = false
            for (const peerId of Object.keys(own.fanout.snapshot().nodes)) {
                if (!allowed(peerId)) {
                    own.fanout.onPeerLeft(peerId)
                    own.dirty = true
                    pruned = true
                }
            }
            if (pruned) broadcastTree()
        }
        own.rate.evaluate()
        own.dirty = true
    }

    // Diagnostics (1.0.1, rank 9): the new entries of the history of the rate control (read only, the history does not
    // change), with agoMs (the age of the entry at this time), then one stats line for each viewer. No line for each
    // frame. The rate rules do not change.
    function diagTick(share) {
        if (!share?.rate) return
        const history = share.rate.history()
        const t = clock()
        const end = Math.min(history.length, share.diagAt + O.diagEntries)
        for (let i = share.diagAt; i < end; i++) {
            const h = history[i]
            events.emit('screen-diag', { kind: 'tier', shareId: share.shareId, agoMs: Math.round(t - h.t), tierId: h.tier,
                role: h.role, from: h.from, to: h.to, why: h.why, bitrate: h.bitrate, peerId: h.viewer, rate: h.rate })
        }
        if (history.length > end) events.emit('screen-diag', { kind: 'skipped', shareId: share.shareId, count: history.length - end })
        share.diagAt = history.length
        const stats = share.rate.stats()
        // B16: the stream of each tier since the last tick.
        const streams = new Map()
        for (const tier of stats.tiers) {
            const last = share.diagTiers?.get(tier.tier)
            const ms = last ? t - last.t : 0
            streams.set(tier.tier, { t, frames: tier.frames, bitrate: tier.bitrate, usePct: Math.round(tier.usage * 100),
                skipPct: Math.round(tier.skipRatio * 100), width: tier.width, height: tier.height,
                fps: ms > 0 ? Math.round((tier.frames - last.frames) * 1000 / ms) : undefined })
        }
        share.diagTiers = streams
        for (const v of stats.viewers) {
            const s = streams.get(v.tier)
            events.emit('screen-diag', { kind: 'stats', shareId: share.shareId, peerId: v.peerId, tierId: v.tier, slow: v.slow,
                circuit: v.circuit, rate: v.rate, target: v.target, excessMs: v.excessMs, drops: v.dropped, kframes: v.keyframes,
                congestions: v.congestions, queueBytes: v.queueBytes, cap: stats.cap,
                bitrate: s?.bitrate, usePct: s?.usePct, skipPct: s?.skipPct, fps: s?.fps, width: s?.width, height: s?.height })
        }
    }

    // Removes a viewer: the rest of a started record, then END, then the stream closes.
    function endViewer(peerId, reason, stream = own?.viewers.get(peerId)?.stream) {
        if (own?.viewers.get(peerId)?.stream === stream) {
            own.viewers.delete(peerId)
            own.rate.flush(peerId, endRecord(reason))
            if (reason !== 'replaced') own.fanout?.onPeerLeft(peerId)
            own.dirty = true
            broadcastTree()
        } else {
            try { stream?.send(endRecord(reason)) } catch { /* closed */ }
        }
        ended.push({ peerId, reason, at: clock() })
        closeStream(stream)
    }

    function checkIsolated() {
        if (!own || openPeers().length > 0) {
            clearTimeout(isolatedTimer)
            isolatedTimer = null
            return
        }
        if (isolatedTimer) return
        isolatedTimer = setTimeout(() => {
            isolatedTimer = null
            if (own && openPeers().length === 0) stopScreenShare('isolated')
        }, O.isolatedMs)
    }

    function startScreenShare({ preset = 'auto', width, height, audio = false } = {}) {
        if (stopped) throw new Error('The node is stopped.')
        if (idle()) throw new Error('Screen sharing is not available in Idle Peer.')
        if (!canShare()) throw new Error('This device is not admitted to the room.')
        if (own) throw new Error('A screen share is already on.')
        if (peers.size >= O.maxShares) {
            events.emit('screen-diag', { kind: 'limit', count: peers.size })
            throw new Error(`Share limit reached (${O.maxShares}).`)
        }
        if (!SCREEN_QUALITIES.includes(preset)) throw new TypeError(`Unknown screen quality: ${preset}`)
        const source = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : null
        const shareId = randomUUID()
        const withAudio = audio === true
        let fanoutKey = null
        let fanoutPub = null
        let fanout = null
        if (O.fanout !== false) {
            fanoutKey = generateKeyPairSync('ed25519')
            const spki = fanoutKey.publicKey.export({ format: 'der', type: 'spki' })
            fanoutPub = spki.subarray(ED25519_SPKI_PREFIX.length).toString('base64url')
            fanout = createScreenFanout({
                selfId,
                shareId,
                getTopology,
                now: clock,
                slotLedger,
                options: {
                    maxViewers: O.maxViewers,
                    maxDirectViewers: O.maxDirectViewers,
                    maxShares: O.maxShares,
                    defaultGlobalMaxChildren: configuredMaxChildren,
                    ...O.fanoutOptions
                }
            })
        }
        slotLedger.setOwnSharing(selfId, true)
        if (watch?.forwarder) {
            watch.forwarder.setMaxChildren(0)
            sendFanoutReport(watch, {
                event: 'capacity',
                children: watch.forwarder.childCount(),
                maxChildren: watch.forwarder.maxChildren(),
                congested: watch.forwarder.isCongested()
            })
        }
        own = { shareId, quality: preset, audio: withAudio, fanoutKey, fanoutPub, fanout, viewers: new Map(), pending: new Set(), dirty: true, lastEncoder: null, lastViewers: null, lastTree: null, rate: null,
            startedAt: clock() }
        const share = own
        own.rate = createScreenRate({ quality: preset, source, now: clock, params: O.rate, configRecord,
            onTiers: () => { share.dirty = true },
            onEnd: (peerId, reason) => { if (own === share) endViewer(peerId, reason) } })
        own.paceTimer = setInterval(pacerTick, O.paceTickMs)
        own.evalTimer = setInterval(evaluateTick, O.evalMs)
        own.diagAt = 0
        own.diagTimer = setInterval(() => diagTick(share), O.diagMs)
        own.diagTimer.unref?.()
        broadcast(screenLine())
        events.emit('screen-state', { peerId: selfId, own: true, sharing: true, shareId, preset, audio: withAudio })
        emitEncoder()
        emitViewers()
        checkIsolated()
        console.info(`EVENT screen share started preset=${preset}`)
        return { shareId }
    }

    function stopScreenShare(reason = 'stopped') {
        if (!own) return false
        const why = STOP_REASONS.has(reason) ? reason : 'stopped'
        const wire = why === 'isolated' || why === 'limit' ? 'stopped' : why
        const share = own
        clearInterval(share.paceTimer)
        clearInterval(share.evalTimer)
        clearInterval(share.diagTimer)
        // The last tier changes and stats of this share, before the viewers go.
        diagTick(share)
        clearTimeout(isolatedTimer)
        isolatedTimer = null
        for (const [peerId, v] of [...share.viewers]) endViewer(peerId, wire, v.stream)
        for (const stream of share.pending) { try { stream.send(endRecord(wire)) } catch { /* closed */ } closeStream(stream) }
        share.fanout?.destroy()
        slotLedger.setOwnSharing(selfId, false)
        own = null
        if (watch?.forwarder && watch.hop < FANOUT_DEFAULTS.maxHop) {
            watch.forwarder.setMaxChildren(effectiveMaxChildren())
            sendFanoutReport(watch, {
                event: 'capacity',
                children: watch.forwarder.childCount(),
                maxChildren: watch.forwarder.maxChildren(),
                congested: watch.forwarder.isCongested()
            })
        }
        onOwnStop(why)
        broadcast(screenLine())
        onTopologyChanged()
        console.info(`EVENT screen share stopped reason=${why}`)
        // 1.0.6: the events of a stop carry the ID of the share that stopped.
        events.emit('screen-state', { peerId: selfId, own: true, sharing: false, shareId: share.shareId, preset: null, audio: false })
        events.emit('screen-viewers', viewersView())
        events.emit('screen-encoder', { tiers: [] })
        events.emit('screen-ended', { peerId: selfId, shareId: share.shareId, reason: why, own: true, ...(share.limitBy ? { by: share.limitBy } : {}) })
        return true
    }

    // The stream handler at the sharer (section 2.9: who can watch).
    function handleStream({ stream, connection }) {
        const peerId = connection.remotePeer.toString()
        if (stopped || !allowed(peerId) || !allowOpen(peerId)) {
            abortStream(stream, 'Screen stream is not authorized')
            return
        }
        const share = own
        let state = 'open'
        share?.pending.add(stream)
        const refuse = reason => {
            state = 'closed'
            share?.pending.delete(stream)
            try { stream.send(endRecord(reason)) } catch { /* closed */ }
            closeStream(stream)
        }
        // Section 2.9: a WATCH record only in 5 s after the stream opened.
        const watchTimer = setTimeout(() => { if (state === 'open') { state = 'closed'; share?.pending.delete(stream); abortStream(stream, 'no WATCH record') } }, O.watchRecordMs)
        const onRecord = (type, body) => {
            if (state === 'closed') return
            if (state === 'open') {
                if (type !== TYPE.WATCH) return
                clearTimeout(watchTimer)
                share?.pending.delete(stream)
                const value = parseJson(body, MAX_WATCH_JSON)
                if (!share || own !== share || value?.v !== 1 || value.shareId !== share.shareId || idle() || !allowed(peerId)) return refuse('refused')
                const old = share.viewers.get(peerId)
                if (share.fanout) {
                    if (typeof value.failedParent === 'string' && value.failedParent) {
                        share.fanout.recordParentFailure(peerId, value.failedParent)
                    }
                    const decision = share.fanout.planWatch(peerId, {
                        fanout: value.fanout === 1 ? 1 : 0,
                        maxChildren: Number.isInteger(value.maxChildren) ? value.maxChildren : 0,
                        redirectCount: Number.isInteger(value.redirectCount) ? value.redirectCount : 0
                    })
                    if (decision.action === 'reject') return refuse(decision.reason)
                    if (decision.action === 'redirect') {
                        if (old) endViewer(peerId, 'replaced', old.stream)
                        const exp = Date.now() + O.redirectTokenMs
                        const sig = signRedirectToken(share.fanoutKey.privateKey, {
                            shareId: share.shareId,
                            sharerPeerId: selfId,
                            parentPeerId: decision.parentPeerId,
                            childPeerId: peerId,
                            hop: decision.hop,
                            tokenSeq: decision.tokenSeq,
                            exp
                        })
                        state = 'closed'
                        try {
                            stream.send(jsonRecord(TYPE.REDIRECT, {
                                v: 1,
                                shareId: share.shareId,
                                parentPeerId: decision.parentPeerId,
                                hop: decision.hop,
                                tokenSeq: decision.tokenSeq,
                                exp,
                                sig
                            }))
                        } catch { /* closed */ }
                        closeStream(stream)
                        return
                    }
                } else {
                    if (!old && share.viewers.size >= O.maxViewers) return refuse('full')
                }
                if (old) endViewer(peerId, 'replaced', old.stream)
                const circuit = connection.remoteAddr?.toString().includes('/p2p-circuit') === true
                share.viewers.set(peerId, { stream, circuit })
                share.rate.addViewer(peerId, { send: bytes => stream.send(bytes), onDrain: () => stream.onDrain(), circuit })
                share.dirty = true
                state = 'watching'
                emitViewers()
                broadcastTree()
                return
            }
            if (own !== share || share.viewers.get(peerId)?.stream !== stream) return
            if (type === TYPE.ACK && body.length === 4) share.rate.onAck(peerId, body.readUInt32BE(0))
            else if (type === TYPE.KEYREQ) {
                const tier = share.rate.tierOfViewer(peerId)
                if (tier) share.rate.requestKey(tier.tier)
            }
            // Ignore an unknown type with a permitted length.
        }
        readRecords(stream.source ?? stream, onRecord, MAX_VIEWER_RECORD)
            .catch(() => abortStream(stream, 'screen record is not valid'))
            .finally(() => {
                clearTimeout(watchTimer)
                share?.pending.delete(stream)
                state = 'closed'
                if (share && share.viewers.get(peerId)?.stream === stream) {
                    share.viewers.delete(peerId)
                    share.rate.removeViewer(peerId)
                    share.fanout?.onPeerLeft(peerId)
                    share.dirty = true
                    if (own === share) {
                        emitViewers()
                        broadcastTree()
                    }
                }
            })
    }

    function handleFanoutLine(peerId, control) {
        if (!allowFanoutLine(peerId) || !allowed(peerId) || control?.v !== 1) return
        if (control.event === 'tree') {
            if (peers.get(peerId)?.shareId !== control.shareId) return
            if (!Array.isArray(control.edges) || control.edges.length > O.maxViewers) return
            const seen = new Set()
            const next = []
            for (const item of control.edges) {
                if (!Array.isArray(item) || item.length !== 2) return
                const [from, to] = item
                if (typeof from !== 'string' || from.length < 1 || from.length > 128) return
                if (typeof to !== 'string' || to.length < 1 || to.length > 128 || from === to) return
                const key = `${from}|${to}`
                if (seen.has(key)) continue
                seen.add(key)
                next.push({ from, to, sharer: peerId })
            }
            const prev = peerTrees.get(peerId)
            if (JSON.stringify(prev ?? []) !== JSON.stringify(next)) {
                peerTrees.set(peerId, next)
                onTopologyChanged()
            }
            return
        }
        if (!own?.fanout || control.shareId !== own.shareId || !FANOUT_EVENTS.has(control.event)) return
        if (control.childPeerId !== undefined && (typeof control.childPeerId !== 'string' || control.childPeerId.length < 1 || control.childPeerId.length > 128)) return
        if (control.maxChildren !== undefined && (!Number.isInteger(control.maxChildren) || control.maxChildren < 0 || control.maxChildren > 8)) return
        if (control.congested !== undefined && typeof control.congested !== 'boolean') return
        if (control.reason !== undefined && (typeof control.reason !== 'string' || control.reason.length > 32)) return
        const res = own.fanout.handleReport(peerId, control)
        if (res.ok) {
            own.dirty = true
            emitViewers()
            broadcastTree()
        }
    }

    function sendScreenFrame({ tier, key, timestampMs, data } = {}) {
        if (!own || !(data instanceof Uint8Array) || data.length < 1 || data.length > MAX_SCREEN_FRAME_BYTES) return false
        return own.rate.pushFrame(tier, { key: key === true, timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0, data })
    }
    function reportScreenEncoder(report) {
        if (!own || !Array.isArray(report?.tiers) || report.tiers.length > 4) return false
        own.rate.report(report)
        return true
    }
    function setScreenSize({ tier, width, height } = {}) {
        if (!own || !Number.isInteger(width) || !Number.isInteger(height) || width < 16 || width > 2560 || height < 16 || height > 1440) return false
        const ok = own.rate.setSize(tier, width, height)
        if (ok) own.dirty = true
        return ok
    }

    // ---- The viewer ----

    function sendFanoutReport(w, report) {
        if (w.done || watch !== w || stopped) return
        sendLine(w.peerId, JSON.stringify({
            type: 'screen-fanout',
            v: 1,
            shareId: w.shareId,
            ...report
        }))
    }

    function sendUpstreamKeyReq(w) {
        if (w.done || watch !== w || !w.stream || !w.configured) return false
        const t = clock()
        if (t - w.lastKeyRequest < O.keyRequestMs) return false
        w.lastKeyRequest = t
        try { w.stream.send(record(TYPE.KEYREQ)); return true } catch { return false }
    }

    function closeForwarderChild(w, childId) {
        const entry = w.forwarderChildren.get(childId)
        if (!entry) return
        w.forwarderChildren.delete(childId)
        onForwarderChildLeft(childId, w.shareId)
        closeStream(entry.stream)
        onTopologyChanged()
    }

    function finishWatch(w, reason) {
        if (w.done) return
        w.done = true
        clearTimeout(w.timer)
        clearTimeout(w.reparentTimer)
        clearInterval(w.forwarderPaceTimer)
        clearInterval(w.forwarderEvalTimer)
        if (w.forwarder) {
            const wire = reason === 'unwatched' || reason === 'switched' ? 'stopped' : reason
            w.forwarder.stop(wire)
            for (const entry of w.forwarderChildren.values()) closeStream(entry.stream)
            w.forwarderChildren.clear()
            for (const stream of w.forwarderPending) {
                try { stream.send(endRecord(wire)) } catch { /* closed */ }
                closeStream(stream)
            }
            w.forwarderPending.clear()
        }
        if (watch === w) {
            watch = null
            onUnwatch(reason)
            onTopologyChanged()
        }
        // 1.0.6: each end of a watch, also a stop or a switch of the user (no screen-ended event for those two).
        events.emit('screen-watch', { event: 'end', peerId: w.peerId, shareId: w.shareId, reason, frames: w.frames })
        // L11 (P10b): a share that sends no CONFIG in watchTimeoutMs goes out of the list. A screen line with no stream
        // then cannot block Start for ever.
        if (reason === 'timeout' && !w.configured && peers.get(w.peerId)?.shareId === w.shareId) {
            peers.delete(w.peerId)
            events.emit('screen-state', { peerId: w.peerId, sharing: false, shareId: w.shareId, preset: null, audio: false })
        }
        const user = reason === 'unwatched' || reason === 'switched'
        if (!w.configured) w.reject(new Error(user ? 'Watch stopped.' : `The share is not available (${reason}).`))
        if (!user) events.emit('screen-ended', { peerId: w.peerId, shareId: w.shareId, reason, own: false })
    }

    function triggerReparent(w, reason) {
        if (w.done || watch !== w || stopped || idle()) return
        if (peers.get(w.peerId)?.shareId !== w.shareId) return finishWatch(w, reason)
        if (!connectionFor(w.peerId) || !allowed(w.peerId)) return finishWatch(w, reason)
        w.reparentStartedAt ??= clock()
        w.reparentAttempts++
        if (w.reparentAttempts > O.reparentMaxAttempts || (clock() - w.reparentStartedAt) > O.reparentWindowMs) {
            return finishWatch(w, reason)
        }
        w.reparenting = true
        clearTimeout(w.reparentTimer)
        const delay = w.configured ? O.reparentDelayMs : 0
        w.reparentTimer = setTimeout(() => {
            w.reparentTimer = null
            if (w.done || watch !== w || stopped || idle()) return
            connectWatch(w, { targetPeerId: w.peerId, protocol: SCREEN_PROTOCOL })
        }, delay)
    }

    async function connectWatch(w, { targetPeerId, protocol, watchPayload = null, hop = 1 }) {
        const gen = ++w.streamGen
        w.parentPeerId = targetPeerId
        w.hop = hop
        if (w.forwarder) {
            if (hop >= FANOUT_DEFAULTS.maxHop) {
                w.forwarder.setMaxChildren(0)
                for (const [childId, entry] of [...w.forwarderChildren]) {
                    w.forwarder.removeChild(childId, 'stopped')
                    w.forwarderChildren.delete(childId)
                    onForwarderChildLeft(childId, w.shareId)
                    closeStream(entry.stream)
                }
            } else {
                w.forwarder.setMaxChildren(effectiveMaxChildren())
            }
        }
        const connection = connectionFor(targetPeerId)
        if (!connection) {
            if (protocol === SCREEN_FANOUT_PROTOCOL) {
                w.failedParent = targetPeerId
                triggerReparent(w, 'lost')
                return
            }
            finishWatch(w, 'lost')
            return
        }
        let stream
        try {
            stream = await connection.newStream(protocol, { runOnTransientConnection: true })
        } catch (err) {
            if (w.done || gen !== w.streamGen) return
            if (protocol === SCREEN_FANOUT_PROTOCOL) {
                w.failedParent = targetPeerId
                triggerReparent(w, 'error')
                return
            }
            const hadReparent = w.reparenting
            finishWatch(w, 'error')
            if (!hadReparent) throw err
            return
        }
        if (w.done || gen !== w.streamGen) { abortStream(stream, 'watch superseded'); return }
        w.stream = stream
        const payload = watchPayload ?? {
            v: 1,
            shareId: w.shareId,
            ...(O.fanout !== false ? {
                fanout: 1,
                maxChildren: effectiveMaxChildren(),
                ...(w.redirectCount > 0 ? { redirectCount: w.redirectCount } : {}),
                ...(w.failedParent ? { failedParent: w.failedParent } : {})
            } : {})
        }
        try { stream.send(jsonRecord(TYPE.WATCH, payload)) } catch { /* the read loop ends */ }
        const onRecord = (type, body) => {
            if (w.done || gen !== w.streamGen) return
            if (type === TYPE.REDIRECT && protocol === SCREEN_PROTOCOL) {
                const value = parseJson(body, MAX_REDIRECT_JSON)
                if (!value || value.v !== 1 || value.shareId !== w.shareId ||
                    typeof value.parentPeerId !== 'string' || !value.parentPeerId || value.parentPeerId === selfId ||
                    !Number.isInteger(value.hop) || value.hop < 2 || value.hop > FANOUT_DEFAULTS.maxHop ||
                    !Number.isInteger(value.tokenSeq) || value.tokenSeq < 1 ||
                    !Number.isSafeInteger(value.exp) || typeof value.sig !== 'string') {
                    throw new Error('REDIRECT is not valid')
                }
                w.redirectCount++
                w.streamGen++
                w.stream = null
                closeStream(stream)
                connectWatch(w, {
                    targetPeerId: value.parentPeerId,
                    protocol: SCREEN_FANOUT_PROTOCOL,
                    hop: value.hop,
                    watchPayload: {
                        v: 1,
                        shareId: w.shareId,
                        sharerPeerId: w.peerId,
                        hop: value.hop,
                        tokenSeq: value.tokenSeq,
                        exp: value.exp,
                        sig: value.sig
                    }
                })
                return
            }
            if (type === TYPE.CONFIG) {
                const value = parseJson(body, MAX_CONFIG_JSON)
                if (!validConfig(value, w.shareId)) throw new Error('CONFIG is not valid')
                const first = !w.configured
                w.configured = true
                w.reparenting = false
                w.reparentStartedAt = null
                w.reparentAttempts = 0
                w.redirectCount = 0
                w.failedParent = null
                clearTimeout(w.timer)
                w.config = { width: value.width, height: value.height, fps: value.fps ?? null }
                events.emit('screen-config', { peerId: w.peerId, shareId: w.shareId, parentPeerId: w.parentPeerId, hop: w.hop, ...w.config })
                w.forwarder?.onConfig(body)
                if (w.confirmedParentPeerId !== targetPeerId) {
                    w.confirmedParentPeerId = targetPeerId
                    onWatchParentChanged({ peerId: w.peerId, shareId: w.shareId, parentPeerId: targetPeerId, hop })
                }
                onTopologyChanged()
                if (first) {
                    events.emit('screen-watch', { event: 'start', peerId: w.peerId, shareId: w.shareId })
                    w.resolve({ shareId: w.shareId, parentPeerId: w.parentPeerId, hop: w.hop, ...w.config })
                }
            } else if (type === TYPE.FRAME) {
                if (!w.configured) throw new Error('FRAME before CONFIG')
                if (body.length < FRAME_HEAD_BYTES + 1) throw new Error('FRAME is too short')
                const seq = body.readUInt32BE(1)
                // Section 2.3, item 6: the ack goes out from the main process, before the decoder.
                try { stream.send(ackRecord(seq)) } catch { /* closed */ }
                w.acks++
                w.frames++
                w.bytes += body.length - FRAME_HEAD_BYTES
                const key = (body[0] & 1) === 1
                if (key) w.keys++
                events.emit('screen-frame', { peerId: w.peerId, shareId: w.shareId, key, seq, timestampMs: body.readUInt32BE(5),
                    data: new Uint8Array(body.buffer, body.byteOffset + FRAME_HEAD_BYTES, body.length - FRAME_HEAD_BYTES) })
                w.forwarder?.onFrame(body)
            } else if (type === TYPE.END) {
                const reason = END_NAME[body[0]] ?? 'stopped'
                w.streamGen++
                w.stream = null
                closeStream(stream)
                if (targetPeerId !== w.peerId) {
                    w.failedParent = targetPeerId
                    triggerReparent(w, reason)
                } else {
                    finishWatch(w, reason)
                }
            }
        }
        const reader = typeof O.beforeRecord === 'function'
            ? (type, body) => { const wait = O.beforeRecord({ peerId: w.peerId, parentPeerId: targetPeerId, type }); return wait && typeof wait.then === 'function' ? wait.then(() => onRecord(type, body)) : onRecord(type, body) }
            : onRecord
        readRecords(stream.source ?? stream, reader, MAX_SHARER_RECORD)
            .then(
                () => {
                    if (gen !== w.streamGen || w.done) return
                    w.stream = null
                    if (targetPeerId !== w.peerId) {
                        w.failedParent = targetPeerId
                        triggerReparent(w, 'lost')
                    } else {
                        finishWatch(w, 'lost')
                    }
                },
                () => {
                    if (gen !== w.streamGen || w.done) return
                    abortStream(stream, 'screen record is not valid')
                    w.stream = null
                    if (targetPeerId !== w.peerId) {
                        w.failedParent = targetPeerId
                        triggerReparent(w, 'error')
                    } else {
                        finishWatch(w, 'error')
                    }
                }
            )
    }

    async function watchScreen(peerId) {
        if (stopped) throw new Error('The node is stopped.')
        if (idle()) throw new Error('Watching is not available in Idle Peer.')
        const share = peers.get(peerId)
        if (!share) throw new Error('This member does not share a screen.')
        // 1.0.6: one watch at a time. A new watch ends the old one: its sharer sends no more frames to this viewer.
        unwatchScreen('switched')
        const connection = connectionFor(peerId)
        if (!connection) throw new Error('No session with this member.')
        const w = {
            peerId, shareId: share.shareId, parentPeerId: peerId, confirmedParentPeerId: null, hop: 1,
            stream: null, streamGen: 0, configured: false, done: false,
            reparenting: false, reparentStartedAt: null, reparentAttempts: 0, reparentTimer: null,
            redirectCount: 0, failedParent: null, lastKeyRequest: -Infinity,
            frames: 0, bytes: 0, keys: 0, acks: 0,
            forwarder: null, forwarderChildren: new Map(), forwarderPending: new Set(),
            forwarderPaceTimer: null, forwarderEvalTimer: null, usedTokens: new Set()
        }
        if (O.fanout !== false && share.fanoutPub) {
            w.forwarder = createScreenForwarder({
                now: clock,
                allowed,
                voiceBackpressure,
                onKeyRequest: () => sendUpstreamKeyReq(w),
                onShed: childId => closeForwarderChild(w, childId),
                onReport: report => sendFanoutReport(w, report),
                params: { maxChildren: effectiveMaxChildren(), ...O.forwarderParams }
            })
            w.forwarderPaceTimer = setInterval(() => w.forwarder?.tick(), O.paceTickMs)
            w.forwarderEvalTimer = setInterval(() => w.forwarder?.evaluate(), O.evalMs)
        }
        watch = w
        const result = new Promise((resolve, reject) => { w.resolve = resolve; w.reject = reject })
        result.catch(() => {})
        w.timer = setTimeout(() => { if (!w.configured) { abortStream(w.stream, 'no CONFIG'); finishWatch(w, 'timeout') } }, O.watchTimeoutMs)
        await connectWatch(w, { targetPeerId: peerId, protocol: SCREEN_PROTOCOL })
        return result
    }

    function handleFanoutStream({ stream, connection }) {
        const peerId = connection.remotePeer.toString()
        if (stopped || idle() || !allowed(peerId) || !allowOpen(peerId)) {
            abortStream(stream, 'Screen fanout stream is not authorized')
            return
        }
        const w = watch
        if (!w || w.done || !w.forwarder) {
            abortStream(stream, 'Screen fanout is not active')
            return
        }
        let state = 'open'
        w.forwarderPending.add(stream)
        const refuse = reason => {
            state = 'closed'
            w.forwarderPending.delete(stream)
            try { stream.send(endRecord(reason)) } catch { /* closed */ }
            closeStream(stream)
        }
        const watchTimer = setTimeout(() => {
            if (state === 'open') {
                state = 'closed'
                w.forwarderPending.delete(stream)
                abortStream(stream, 'no WATCH record')
            }
        }, O.watchRecordMs)
        const onRecord = (type, body) => {
            if (state === 'closed') return
            if (state === 'open') {
                if (type !== TYPE.WATCH) return
                clearTimeout(watchTimer)
                w.forwarderPending.delete(stream)
                const value = parseJson(body, MAX_FANOUT_WATCH_JSON)
                const pubKey = peers.get(w.peerId)?.fanoutPub ?? null
                if (watch !== w || w.done || !w.forwarder || idle() || !allowed(peerId) ||
                    value?.v !== 1 || value.shareId !== w.shareId || value.sharerPeerId !== w.peerId ||
                    value.hop !== w.hop + 1 || w.usedTokens.has(value.tokenSeq) ||
                    !verifyRedirectToken(pubKey, {
                        shareId: w.shareId,
                        sharerPeerId: w.peerId,
                        parentPeerId: selfId,
                        childPeerId: peerId,
                        hop: value.hop,
                        tokenSeq: value.tokenSeq,
                        exp: value.exp,
                        sig: value.sig
                    })) {
                    return refuse('refused')
                }
                const added = w.forwarder.addChild(peerId, { send: bytes => stream.send(bytes), onDrain: () => stream.onDrain() })
                if (!added.ok) return refuse(added.reason)
                w.usedTokens.add(value.tokenSeq)
                const prev = w.forwarderChildren.get(peerId)
                if (prev && prev.stream !== stream) closeStream(prev.stream)
                w.forwarderChildren.set(peerId, { stream })
                state = 'watching'
                onTopologyChanged()
                return
            }
            if (watch !== w || w.done || w.forwarderChildren.get(peerId)?.stream !== stream) return
            if (type === TYPE.ACK && body.length === 4) w.forwarder.onAck(peerId, body.readUInt32BE(0))
            else if (type === TYPE.KEYREQ) w.forwarder.onChildKeyRequest(peerId)
        }
        readRecords(stream.source ?? stream, onRecord, MAX_FANOUT_VIEWER_RECORD)
            .catch(() => abortStream(stream, 'screen fanout record is not valid'))
            .finally(() => {
                clearTimeout(watchTimer)
                w.forwarderPending.delete(stream)
                state = 'closed'
                if (w.forwarderChildren.get(peerId)?.stream === stream) {
                    w.forwarderChildren.delete(peerId)
                    w.forwarder?.removeChild(peerId, 'stopped')
                    onForwarderChildLeft(peerId, w.shareId)
                    onTopologyChanged()
                }
            })
    }

    function unwatchScreen(reason = 'unwatched') {
        const w = watch
        if (!w) return false
        finishWatch(w, reason === 'switched' ? 'switched' : 'unwatched')
        abortStream(w.stream, 'unwatched')
        return true
    }

    function requestScreenKey() {
        const w = watch
        if (!w?.stream || !w.configured) return false
        const t = clock()
        if (t - w.lastKeyRequest < O.keyRequestMs) return false
        w.lastKeyRequest = t
        try { w.stream.send(record(TYPE.KEYREQ)) } catch { return false }
        return true
    }

    // ---- Hooks of node.mjs ----

    // 1.0.6: more than maxShares shares after the start of the own share (two members started at the same moment at
    // the limit). Only in conflictMs after the own start: a later share line cannot stop a running share (L11). The
    // young shares (the own share and each share with a first line in conflictMs) with the highest peer IDs stop, so
    // that each member that sees the same lines gets the same result. An old share does not stop for a new one. A line
    // on a session that opened after the own start counts as an old share (a Start before the sessions opened).
    function checkLimit(peerId) {
        const t = clock()
        if (!own || t - own.startedAt > O.conflictMs) return
        const excess = peers.size + 1 - O.maxShares
        if (excess <= 0) return
        const young = [selfId, ...[...peers].filter(([, s]) => t - s.at <= O.conflictMs).map(([id]) => id)].sort()
        if (!young.slice(-excess).includes(selfId)) return
        own.limitBy = peerId
        stopScreenShare('limit')
    }

    function handleLine(peerId, control) {
        if (!validScreenLine(control) || !allowLine(peerId)) return
        const old = peers.get(peerId)
        if (control.sharing) {
            const preset = SCREEN_QUALITIES.includes(control.preset) ? control.preset : null
            const audio = control.audio === true
            const fanoutPub = parseFanoutPub(control.fanoutPub)
            slotLedger.setOwnSharing(peerId, true)
            if (old?.shareId === control.shareId && old.preset === preset && old.audio === audio &&
                Boolean(old.fanoutPub) === Boolean(fanoutPub)) return
            // One entry for each member: a new share ID of a member replaces its old share (one event, L11).
            const openedAt = sessionOpenedAt.get(peerId)
            const unknownAge = own && openedAt !== undefined && openedAt >= own.startedAt
            if (old?.shareId !== control.shareId && peerTrees.delete(peerId)) onTopologyChanged()
            peers.set(peerId, { shareId: control.shareId, preset, audio, fanoutPub,
                at: old?.shareId === control.shareId ? old.at : unknownAge ? -Infinity : clock() })
            events.emit('screen-state', { peerId, sharing: true, shareId: control.shareId, preset, audio })
            // Section 2.6, item 6 (1.0.6): two shares at the same time are permitted. Only a share over the limit stops.
            checkLimit(peerId)
        } else {
            slotLedger.setOwnSharing(peerId, false)
            if (peerTrees.delete(peerId)) onTopologyChanged()
            if (old) {
                peers.delete(peerId)
                events.emit('screen-state', { peerId, sharing: false, shareId: old.shareId, preset: null, audio: false })
            }
        }
    }
    function opened(peerId) {
        sessionOpenedAt.set(peerId, clock())
        if (own) {
            sendLine(peerId, screenLine())
            if (own.lastTree) sendLine(peerId, own.lastTree)
        }
        checkIsolated()
    }
    function peerLeft(peerId) {
        sessionOpenedAt.delete(peerId)
        slotLedger.setOwnSharing(peerId, false)
        slotLedger.releaseAllForPeer(peerId)
        const hadTree = peerTrees.delete(peerId)
        const old = peers.get(peerId)
        if (peers.delete(peerId)) events.emit('screen-state', { peerId, sharing: false, shareId: old.shareId, preset: null, audio: false })
        const v = own?.viewers.get(peerId)
        let treeChanged = false
        if (v) {
            own.viewers.delete(peerId)
            own.rate.removeViewer(peerId)
            own.dirty = true
            abortStream(v.stream, 'peer left')
            treeChanged = true
        }
        if (own?.fanout) {
            const { removed } = own.fanout.onPeerLeft(peerId)
            if (removed) {
                own.dirty = true
                emitViewers()
                treeChanged = true
            }
        }
        if (treeChanged) broadcastTree()
        const fc = watch?.forwarderChildren?.get(peerId)
        if (fc) {
            watch.forwarderChildren.delete(peerId)
            watch.forwarder?.removeChild(peerId, 'stopped')
            onForwarderChildLeft(peerId, watch.shareId)
            abortStream(fc.stream, 'peer left')
            onTopologyChanged()
        } else if (hadTree) {
            onTopologyChanged()
        }
        checkIsolated()
    }
    function setIdle(value) {
        if (!value) return
        stopScreenShare('idle')
        unwatchScreen()
    }
    function setScreenForwarding(maxChildren) {
        configuredMaxChildren = clampMaxChildren(maxChildren)
        const eff = effectiveMaxChildren()
        if (watch?.forwarder) {
            watch.forwarder.setMaxChildren(eff)
            const entries = [...watch.forwarderChildren.entries()]
            let shedAny = false
            for (let i = entries.length - 1; i >= eff; i--) {
                const [childId, entry] = entries[i]
                watch.forwarder.removeChild(childId, 'stopped')
                watch.forwarderChildren.delete(childId)
                onForwarderChildLeft(childId, watch.shareId)
                closeStream(entry.stream)
                shedAny = true
            }
            sendFanoutReport(watch, {
                event: 'capacity',
                children: watch.forwarder.childCount(),
                maxChildren: watch.forwarder.maxChildren(),
                congested: watch.forwarder.isCongested()
            })
            if (shedAny) onTopologyChanged()
        }
        return { maxChildren: configuredMaxChildren, effectiveMaxChildren: eff }
    }
    function screenEdges() {
        const seen = new Set()
        const out = []
        const add = (from, to, sharer) => {
            if (!from || !to || from === to) return
            const key = `${from}|${to}`
            if (seen.has(key)) return
            seen.add(key)
            out.push({ from, to, sharer })
        }
        if (own) {
            for (const [from, to] of ownTreeEdges()) add(from, to, selfId)
        }
        for (const [sharer, list] of peerTrees) {
            if (!peers.has(sharer)) continue
            for (const edge of list) add(edge.from, edge.to, sharer)
        }
        if (watch && !watch.done) {
            if (watch.configured && watch.parentPeerId) add(watch.parentPeerId, selfId, watch.peerId)
            for (const childId of watch.forwarderChildren.keys()) add(selfId, childId, watch.peerId)
        }
        return out
    }
    async function stop() {
        if (stopped) return
        const sharing = stopScreenShare('stopped')
        stopped = true
        unwatchScreen()
        // Give END a short time to go out before the sessions close.
        let timer
        if (sharing) await Promise.race([Promise.allSettled([...closing]), new Promise(resolve => { timer = setTimeout(resolve, 300) })])
        clearTimeout(timer)
    }

    function screenState() {
        return {
            own: own ? { shareId: own.shareId, preset: own.quality, audio: own.audio, viewers: allViewerIds(own), bitrate: own.rate.tiers()[0]?.bitrate ?? null,
                tiers: own.rate.tiers(), cap: own.rate.cap(), capture: own.rate.capture() } : null,
            peers: Object.fromEntries([...peers].map(([peerId, value]) => [peerId, { shareId: value.shareId, preset: value.preset, audio: value.audio === true }])),
            watching: watch?.peerId ?? null,
            watchingShare: watch?.shareId ?? null,
            watchingParent: watch?.parentPeerId ?? null,
            maxShares: O.maxShares
        }
    }
    function screenStats() {
        return {
            own: own ? { ...own.rate.stats(), history: own.rate.history().slice(-200), fanout: own.fanout?.snapshot() ?? null } : null,
            ended: ended.slice(-50),
            watching: watch ? {
                peerId: watch.peerId, parentPeerId: watch.parentPeerId, hop: watch.hop, reparenting: watch.reparenting,
                configured: watch.configured, frames: watch.frames, bytes: watch.bytes,
                keys: watch.keys, acks: watch.acks, config: watch.config ?? null,
                forwarder: watch.forwarder?.stats() ?? null
            } : null
        }
    }

    return {
        handleStream, handleFanoutStream, handleLine, handleFanoutLine, opened, peerLeft, setIdle, stop,
        screenEdges,
        getOwnShare: () => (own ? { shareId: own.shareId, audio: own.audio } : null),
        getPeerShare: peerId => {
            const p = peers.get(peerId)
            return p ? { shareId: p.shareId, audio: p.audio === true } : null
        },
        getVideoWatch: () => (watch && !watch.done ? { peerId: watch.peerId, shareId: watch.shareId, parentPeerId: watch.parentPeerId, hop: watch.hop } : null),
        isForwarderChild: (peerId, shareId) => Boolean(watch && !watch.done && watch.shareId === shareId && watch.forwarderChildren.has(peerId)),
        // A test hook of rule A9 and A7 (W1 check 13a, W5 check 8a).
        testRate: () => own?.rate ?? null,
        api: {
            startScreenShare, stopScreenShare, sendScreenFrame, reportScreenEncoder, setScreenSize,
            watchScreen, unwatchScreen, requestScreenKey, setScreenForwarding, screenState, screenStats
        }
    }
}
