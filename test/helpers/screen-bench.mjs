// Harness of the timed screen share checks B and C (work-orders/astra/P8/DESIGN.md, section 6, W2). The method of
// the design prototypes scratch/proto/route-bench.mjs and auto-bench.mjs, with the product code: real asscrack nodes
// on 127.0.0.1, the node API of the screen share, a synthetic encoder for each tier that replays measured VP8 frame
// sizes with rule E3 (the bucket starts full) and rule E10, and voice frames of 120 bytes each 20 ms with the send
// time in the payload. All results are 127.0.0.1 results on one computer. They are not LAN results.
import os from 'node:os'
import { appendFileSync, readFileSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'
import { createAsscrackNode } from '../../src/network/node.mjs'
import { newRoomKey } from '../../src/network/invite.mjs'
import { createThrottleProxy } from './throttle-proxy.mjs'

const SIZES = JSON.parse(readFileSync(new URL('../fixtures/screen-frame-sizes.json', import.meta.url), 'utf8'))
const TRACES = JSON.parse(readFileSync(new URL('../fixtures/screen-auto-traces.json', import.meta.url), 'utf8'))

// The timed checks take minutes and need a calm PC. `npm test` skips them. Run them with
// `node --test test/screen-voice.test.mjs` and `node --test test/screen-auto.test.mjs`.
export const TIMED_SKIP = process.env.npm_lifecycle_event === 'test' && process.env.SCREEN_TIMED !== '1'
    ? 'timed screen check: run it with node --test <file> (DECISIONS.md, P8a)' : false

const pct = (values, p) => {
    if (!values.length) return null
    const s = [...values].sort((a, b) => a - b)
    return Math.round(s[Math.floor((s.length - 1) * p)] * 10) / 10
}
export const stats = values => ({ n: values.length, p50: pct(values, 0.5), p95: pct(values, 0.95),
    max: values.length ? Math.round(Math.max(...values) * 10) / 10 : null })
function systemCpu() {
    let idle = 0
    let total = 0
    for (const cpu of os.cpus()) { for (const v of Object.values(cpu.times)) total += v; idle += cpu.times.idle }
    return { idle, total }
}
// Calls fn at the mean rate of one call each periodMs. A late timer does not move the next calls.
function every(periodMs, fn) {
    const start = performance.now()
    let n = 0
    let stopped = false
    let handle
    const arm = () => {
        n++
        handle = setTimeout(() => { if (stopped) return; fn(); arm() }, Math.max(0, start + n * periodMs - performance.now()))
    }
    arm()
    return () => { stopped = true; clearTimeout(handle) }
}
async function until(check, what, ms = 20000) {
    const end = performance.now() + ms
    while (!check() && performance.now() < end) await wait(20)
    if (!check()) throw new Error(`timeout: ${what}`)
}
const Bps = mbit => mbit === null || mbit === undefined ? Infinity : mbit * 1e6 / 8
const PRESET_BITRATE = { standard: 1500000, smooth: 3000000, balanced: 6000000, high: 9000000, max: 12000000 }

// s: { name, quality ('standard' or 'auto' or a preset), source: { width, height }, sizes ('frames': screen-frame-sizes,
//      'traces': screen-auto-traces), scene, seconds, baselineSeconds, relayLimit (null: no relay part),
//      sharerUp: [[atS, mbit|null], ...], viewers: [{ route: 'circuit' | 'direct', down: [[atS, mbit|null], ...],
//      stall: { atMs, ms } }] }
export async function runScreenScenario(s) {
    const options = { room: `p8-timed-${Math.random().toString(16).slice(2)}`, roomKey: newRoomKey(), discovery: false,
        heartbeatInterval: 200, hostTimeout: 1200, electionDelay: 400 }
    const nodes = []
    const proxies = []
    const timers = []
    // SCREEN_RATE_PARAMS: rate parameters for a comparison run (JSON), for example {"usedNow":true}.
    const extraRate = JSON.parse(process.env.SCREEN_RATE_PARAMS ?? '{}')
    const screenOptions = { rate: { ...(s.relayLimit === undefined ? {} : { relayLimit: s.relayLimit ?? Infinity }), ...extraRate } }
    const add = async extra => { const n = await createAsscrackNode({ ...options, ...extra }); nodes.push(n); return n }
    const startRef = { t: 0 }
    try {
        const host = await add({ listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: true })
        const hostAddr = host.getMultiaddrs().find(a => a.startsWith('/ip4/127.0.0.1/') && !a.includes('p2p-circuit'))
        const hostPort = Number(/\/tcp\/(\d+)/.exec(hostAddr)[1])
        const viaProxy = async (node, schedule, direction) => {
            const proxy = await createThrottleProxy({ targetPort: hostPort, queueBytes: 64 * 1024 })
            proxy.setRate(direction, Bps(schedule?.[0]?.[1]))
            proxies.push({ proxy, schedule: schedule ?? [], direction })
            await node.connect(`/ip4/127.0.0.1/tcp/${proxy.port}/p2p/${host.peerId}`)
        }
        const sharer = await add({ relayOnly: true, fullNode: false, screen: screenOptions })
        if (s.sharerUp) await viaProxy(sharer, s.sharerUp, 'up')
        else await sharer.connect(hostAddr)
        const watchers = []
        for (const spec of s.viewers) {
            const stall = { until: 0 }
            if (spec.route === 'direct') { watchers.push({ node: host, spec, stall }); continue }
            const beforeRecord = () => {
                const left = stall.until - performance.now()
                return left > 0 ? wait(left) : null
            }
            const v = await add({ relayOnly: true, fullNode: false, screen: { beforeRecord } })
            if (spec.down) await viaProxy(v, spec.down, 'down')
            else await v.connect(hostAddr)
            watchers.push({ node: v, spec, stall })
        }
        const all = [...new Set([host, sharer, ...watchers.map(w => w.node)])]
        await until(() => all.every(n => n.host()?.peerId === host.peerId && n.peers().length === all.length - 1), 'room with all sessions')
        for (const n of all) n.setVoice({ inVoice: true })
        await until(() => host.voiceStats().streams === all.length - 1, 'voice streams on the host')
        for (const w of watchers) {
            const connection = w.node.libp2p.getConnections().find(c => c.remotePeer.toString() === sharer.peerId && c.status === 'open')
            if (!connection) throw new Error('no connection from the viewer to the sharer')
            const circuit = connection.remoteAddr.toString().includes('/p2p-circuit')
            if (circuit !== (w.spec.route === 'circuit')) throw new Error(`route is not ${w.spec.route}: ${connection.remoteAddr}`)
        }

        // Voice: the payload has the send time. All nodes are in one process, thus one clock.
        const voice = new Map()
        for (const w of watchers) {
            const bucket = { delay: [], at: [] }
            voice.set(w.node.peerId, bucket)
            w.node.events.on('voice-frame', frame => {
                if (frame.origin !== sharer.peerId || frame.data.length < 8) return
                const t = performance.now()
                bucket.delay.push(t - Buffer.from(frame.data.buffer, frame.data.byteOffset, 8).readDoubleBE(0))
                bucket.at.push(t)
            })
        }
        let voiceSent = 0
        let phase = 'baseline'
        const sentIn = { baseline: 0, share: 0 }
        timers.push(every(20, () => {
            const payload = Buffer.alloc(120)
            payload.writeDoubleBE(performance.now(), 0)
            if (sharer.sendVoiceFrame(payload)) { voiceSent++; sentIn[phase]++ }
        }))
        const baselineStart = performance.now()
        await wait((s.baselineSeconds ?? 10) * 1000)
        const baselineEnd = performance.now()
        phase = 'share'

        // The share.
        const source = s.source ?? { width: 2560, height: 1440 }
        const cpuBefore = systemCpu()
        sharer.startScreenShare({ preset: s.quality ?? 'auto', ...source })
        await until(() => watchers.every(w => w.node.screenState().peers[sharer.peerId]), 'the screen state at each viewer')
        const received = new Map()
        for (const w of watchers) {
            const b = { frames: 0, bytes: 0, keys: 0, delay: [], perSecond: [], bytesPerSecond: [], keyTimes: [], ended: null, configs: [] }
            received.set(w.node.peerId, b)
            w.node.events.on('screen-frame', f => {
                if (f.peerId !== sharer.peerId) return
                const t = performance.now()
                b.frames++
                b.bytes += f.data.length
                if (f.key) { b.keys++; b.keyTimes.push(t - startRef.t) }
                b.delay.push(t - (startRef.t + f.timestampMs))
                const sec = Math.floor((t - startRef.t) / 1000)
                b.perSecond[sec] = (b.perSecond[sec] ?? 0) + 1
                b.bytesPerSecond[sec] = (b.bytesPerSecond[sec] ?? 0) + f.data.length
            })
            w.node.events.on('screen-config', c => { if (c.peerId === sharer.peerId) b.configs.push({ atMs: Math.round(performance.now() - startRef.t), ...c }) })
            w.node.events.on('screen-ended', e => { if (e.peerId === sharer.peerId && !b.ended) b.ended = { reason: e.reason, atMs: Math.round(performance.now() - startRef.t) } })
        }

        // The synthetic encoder of each tier (rules E2, E3 with a full bucket, E7, E10, E11).
        const encoders = new Map()
        let lastEvent = { tiers: [] }
        sharer.events.on('screen-encoder', e => {
            lastEvent = e
            for (const t of e.tiers) {
                let enc = encoders.get(t.tier)
                if (!enc || enc.preset !== t.preset) {
                    const now = performance.now()
                    enc = { tier: t.tier, preset: t.preset, fps: t.fps, start: now, slot: -1, tokens: t.bitrate / 8, at: now, tick: 0,
                        key: true, slots: 0, skipped: 0, produced: enc?.produced ?? 0, bytes: enc?.bytes ?? 0 }
                    encoders.set(t.tier, enc)
                    sharer.setScreenSize({ tier: t.tier, width: t.width, height: t.height })
                }
                enc.bitrate = t.bitrate
                if (t.keyFrame) enc.key = true
            }
            for (const id of [...encoders.keys()]) if (!e.tiers.some(t => t.tier === id)) encoders.delete(id)
        })
        const keyOf = trace => trace.keyBytes ??= Math.max(...trace.sizes.slice(trace.sizes.length > 15 ? 15 : 0).filter(f => f[2]).map(f => f[1]), 0) || trace.sizes[0][1]
        const deltasOf = trace => trace.deltas ??= trace.sizes.filter(f => !f[2])
        function frameSize(enc, key) {
            if ((s.sizes ?? 'traces') === 'frames') {
                // route-bench: the frame sizes go down only when the bitrate is below the need of the scene.
                const trace = SIZES[s.scene]
                const fps = enc.fps
                const target = PRESET_BITRATE[enc.preset]
                const t = { sizes: trace }
                const demand = Math.min(1, trace.reduce((a, f) => a + f[1], 0) / trace.length * fps * 8 / target)
                const scale = Math.min(1, enc.bitrate / target / demand)
                return key ? Math.round(keyOf(t) * (0.5 + 0.5 * scale)) : Math.max(200, Math.round(deltasOf(t)[enc.tick % deltasOf(t).length][1] * scale))
            }
            // auto-bench with sMin 1: the sizes of the measured stream of the preset.
            const trace = TRACES[enc.preset][s.scene]
            return key ? keyOf(trace) : Math.max(200, deltasOf(trace)[enc.tick % deltasOf(trace).length][1])
        }
        const produceStart = performance.now()
        startRef.t = produceStart
        timers.push(every(5, () => {
            const now = performance.now()
            for (const enc of encoders.values()) {
                const slot = Math.floor((now - enc.start) * enc.fps / 1000)
                if (slot <= enc.slot) continue
                enc.slot = slot
                enc.slots++
                const rate = (enc.bitrate ?? 500000) / 8
                enc.tokens = Math.min(rate, enc.tokens + (now - enc.at) / 1000 * rate)
                enc.at = now
                if (enc.tokens < 0) { enc.skipped++; continue }
                const key = enc.key
                enc.key = false
                enc.tick++
                const size = frameSize(enc, key)
                enc.tokens -= size
                enc.produced++
                enc.bytes += size
                sharer.sendScreenFrame({ tier: enc.tier, key, timestampMs: Math.round(now - produceStart), data: Buffer.alloc(size, enc.tick & 255) })
            }
        }))
        timers.push(every(500, () => {
            sharer.reportScreenEncoder({ tiers: [...encoders.values()].map(enc => {
                const r = { tier: enc.tier, slots: enc.slots, skipped: enc.skipped, dropped: 0, encodeP95Ms: 3 }
                enc.slots = 0
                enc.skipped = 0
                return r
            }) })
        }))
        // The sharer state each 250 ms: the tier and the preset of each viewer, the queue bytes.
        const samples = []
        timers.push(every(250, () => {
            const st = sharer.screenStats().own
            if (!st) return
            samples.push({ atMs: Math.round(performance.now() - produceStart), tiers: st.tiers.map(t => ({ tier: t.tier, role: t.role, preset: t.preset, bitrate: t.bitrate })),
                viewers: st.viewers.map(v => ({ peerId: v.peerId, tier: v.tier, slow: v.slow, rate: v.rate, queueBytes: v.queueBytes, queueLimitBytes: v.queueLimitBytes })) })
        }))
        for (const w of watchers) w.node.watchScreen(sharer.peerId).catch(err => { received.get(w.node.peerId).watchError = String(err.message ?? err) })
        // The link schedules and the stalls.
        for (const p of proxies) for (const [atS, mbit] of p.schedule.slice(1)) {
            const h = setTimeout(() => p.proxy.setRate(p.direction, Bps(mbit)), atS * 1000)
            timers.push(() => clearTimeout(h))
        }
        for (const w of watchers) if (w.spec.stall) {
            const h = setTimeout(() => { w.stall.until = performance.now() + w.spec.stall.ms; w.stallAt = performance.now() - produceStart }, w.spec.stall.atMs)
            timers.push(() => clearTimeout(h))
        }
        await wait((s.seconds ?? 40) * 1000)
        const stats0 = sharer.screenStats()
        for (const stop of timers) stop()
        timers.length = 0
        const elapsed = (performance.now() - produceStart) / 1000
        const cpuAfter = systemCpu()
        await wait(800)
        const result = {
            name: s.name, elapsedS: Math.round(elapsed * 10) / 10,
            pcLoadPercent: Math.round((1 - (cpuAfter.idle - cpuBefore.idle) / (cpuAfter.total - cpuBefore.total)) * 1000) / 10,
            voiceSent, voiceSentIn: sentIn,
            history: (stats0.own?.history ?? []).map(h => ({ ...h, t: Math.round(h.t - produceStart) })),
            ended: stats0.ended.map(e => ({ ...e, at: Math.round(e.at - produceStart) })),
            samples,
            encoders: [...encoders.values()].map(e => ({ tier: e.tier, preset: e.preset, produced: e.produced, kbit: Math.round(e.bytes * 8 / elapsed / 1000) })),
            sharerViewers: stats0.own?.viewers ?? [],
            viewers: watchers.map((w, i) => {
                const b = received.get(w.node.peerId)
                const vo = voice.get(w.node.peerId)
                const base = vo.delay.filter((_, k) => vo.at[k] >= baselineStart && vo.at[k] < baselineEnd)
                const shareDelays = vo.delay.filter((_, k) => vo.at[k] >= produceStart)
                const shareAt = vo.at.filter(at => at >= produceStart)
                const gaps = shareAt.slice(1).map((t, k) => t - shareAt[k])
                const secondVoiceMax = []
                vo.delay.forEach((d, k) => {
                    if (vo.at[k] < produceStart) return
                    const sec = Math.floor((vo.at[k] - produceStart) / 1000)
                    secondVoiceMax[sec] = Math.max(secondVoiceMax[sec] ?? 0, Math.round(d))
                })
                return {
                    index: i, peerId: w.node.peerId, route: w.spec.route, frames: b.frames, keys: b.keys,
                    fps: Math.round(b.frames / elapsed * 10) / 10, kbit: Math.round(b.bytes * 8 / elapsed / 1000),
                    perSecond: Array.from(b.perSecond, x => x ?? 0), kbitPerSecond: Array.from(b.bytesPerSecond, x => Math.round((x ?? 0) * 8 / 1000)),
                    frameDelayMs: stats(b.delay), keyTimes: b.keyTimes.map(Math.round), configs: b.configs, ended: b.ended,
                    watchError: b.watchError ?? null, stallAtMs: w.stallAt === undefined ? null : Math.round(w.stallAt),
                    voice: { received: vo.delay.length, baseline: stats(base), share: stats(shareDelays), gapMs: stats(gaps), secondMax: Array.from(secondVoiceMax, x => x ?? null) },
                    voiceAt: shareAt.map(t => Math.round(t - produceStart)), voiceDelays: shareDelays.map(d => Math.round(d * 10) / 10)
                }
            }),
            at: new Date().toISOString()
        }
        if (process.env.SCREEN_RESULTS) {
            const { voiceAt, ...rest } = result
            appendFileSync(process.env.SCREEN_RESULTS, JSON.stringify({ ...rest, viewers: rest.viewers.map(({ voiceAt: a, voiceDelays: d, ...v }) => v) }) + '\n')
        }
        return result
    } finally {
        for (const stop of timers) stop()
        await Promise.allSettled(nodes.map(n => n.stop()))
        for (const p of proxies) await p.proxy.close()
    }
}

// The voice delays of one viewer in a time window of the share (ms since the start of the share).
export function voiceIn(viewer, fromMs, toMs = Infinity) {
    return viewer.voiceDelays.filter((_, k) => viewer.voiceAt[k] >= fromMs && viewer.voiceAt[k] < toMs)
}
// The role and the preset of the tier of a viewer in each sample of the sharer.
export function tierTrack(result, peerId) {
    return result.samples.map(s => {
        const v = s.viewers.find(x => x.peerId === peerId)
        const t = v ? s.tiers.find(x => x.tier === v.tier) : null
        return { atMs: s.atMs, tier: v?.tier ?? null, role: t?.role ?? null, preset: t?.preset ?? null, slow: v?.slow ?? null, rate: v?.rate ?? null }
    })
}
export const PRESET_ORDER = ['standard', 'smooth', 'balanced', 'high', 'max']
export const presetIndex = id => PRESET_ORDER.indexOf(id)
// One summary line for the test output (the results file has the full data).
export function summary(result) {
    return `${result.name}: load ${result.pcLoadPercent} % | ` + result.viewers.map(v =>
        `viewer ${v.index} ${v.route}: ${v.fps} fps, ${v.kbit} kbit/s, voice p95 ${v.voice.share.p95} ms (baseline ${v.voice.baseline.p95}) max ${v.voice.share.max} ms, voice ${v.voice.received}/${result.voiceSent}`).join(' | ')
}
