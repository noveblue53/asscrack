// Network-level reproduction of test card 2, steps 1 to 8, with 2 nodes on 127.0.0.1.
// Usage: node history-net.mjs <repo-root> <out.json> [repeats]
// Each node is a process (history-worker.mjs). The host process is killed (TerminateProcess).
// The restarted node is a new process, so it has a NEW peer ID.
// Cases: a = the host that closes sent "before voice"; b = the node that stays sent it.
// Restart delay: 0 s or 8 s after the remaining node shows itself as host.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [root, outFile, repeatsArg] = process.argv.slice(2)
const repeats = Number(repeatsArg || 3)
const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'history-worker.mjs')

function startNode(room, name) {
    const proc = spawn(process.execPath, [worker, root, room, name], { stdio: ['pipe', 'pipe', 'pipe'] })
    const n = { name, proc, events: [], peerId: null, stderr: '' }
    let buf = ''
    proc.stdout.on('data', d => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1)
            try { const e = JSON.parse(line); n.events.push(e); if (e.ev === 'ready') n.peerId = e.peerId } catch { n.events.push({ t: Date.now(), ev: 'stdout', line }) }
        }
    })
    proc.stderr.on('data', d => { n.stderr += d })
    n.cmd = c => proc.stdin.write(JSON.stringify(c) + '\n')
    return n
}
async function waitFor(fn, ms) {
    const s = Date.now()
    while (Date.now() - s < ms) { const v = fn(); if (v) return v; await delay(50) }
    return null
}
const lastHost = n => [...n.events].reverse().find(e => e.ev === 'host-changed')?.data?.peerId ?? null

async function run(kase, restartDelay, k) {
    const room = `hn${kase}${restartDelay}${k}${Date.now().toString(36)}`
    const A = startNode(room, 'A'), B = startNode(room, 'B')
    const r = { case: kase, restartDelayMs: restartDelay, repeat: k, steps: [] }
    try {
        if (!await waitFor(() => A.peerId && B.peerId && lastHost(A) && lastHost(A) === lastHost(B), 20000)) {
            throw new Error('no common host: ' + JSON.stringify({ A: A.events.map(e => e.ev), B: B.events.map(e => e.ev), errA: A.stderr.slice(0, 300), errB: B.stderr.slice(0, 300) }))
        }
        A.cmd({ cmd: 'send', text: 'line from A' }); B.cmd({ cmd: 'send', text: 'line from B' })
        await delay(300)
        const host = lastHost(A) === A.peerId ? A : B
        const other = host === A ? B : A
        const sender = kase === 'a' ? host : other
        sender.cmd({ cmd: 'send', text: 'before voice' })
        await delay(300)
        A.cmd({ cmd: 'voice' }); B.cmd({ cmd: 'voice' })
        await delay(1000)
        r.host = host.name; r.sender = sender.name
        const killAt = Date.now()
        host.proc.kill()
        const newHost = await waitFor(() => other.events.find(e => e.t > killAt && e.ev === 'host-changed' && e.data?.peerId === other.peerId), 20000)
        r.failoverMs = newHost ? newHost.t - killAt : null
        await delay(restartDelay)
        other.cmd({ cmd: 'state' })
        const R = startNode(room, host.name + "'")
        const ready = await waitFor(() => R.peerId && R.events.find(e => e.ev === 'peer-joined'), 20000)
        if (!ready) throw new Error('restarted node got no session')
        await delay(8000)
        R.cmd({ cmd: 'state' }); other.cmd({ cmd: 'state' })
        await delay(500)
        const t0 = ready.t
        const ev = R.events.filter(e => ['peer-joined', 'host-changed', 'history', 'state'].includes(e.ev))
        r.restartedIdLower = R.peerId < other.peerId
        r.restartedTimeline = ev.map(e => ({ dt: e.t - t0, ev: e.ev, host: e.data?.peerId === R.peerId ? 'self' : e.data?.peerId === other.peerId ? 'remaining' : undefined,
            texts: e.ev === 'history' ? e.data.messages.map(m => m.text) : e.ev === 'state' ? e.history : undefined, isHost: e.isHost }))
        const hist = R.events.find(e => e.ev === 'history')
        const stateR = [...R.events].reverse().find(e => e.ev === 'state')
        const stateO = [...other.events].reverse().find(e => e.ev === 'state')
        r.remainingHasBeforeVoice = stateO?.history.includes('before voice') ?? null
        r.historyEvent = hist ? { dt: hist.t - t0, texts: hist.data.messages.map(m => m.text) } : null
        r.restartedHasBeforeVoice = stateR?.history.includes('before voice') ?? null
        r.restartedElectedSelf = R.events.some(e => e.ev === 'host-changed' && e.data?.peerId === R.peerId)
        r.restartedHostIsRemaining = stateR?.host?.peerId === other.peerId
        const hc = R.events.find(e => e.ev === 'host-changed')
        r.historyAfterHostKnown = hist && hc ? hist.t >= hc.t : null
        r.pass = r.restartedHasBeforeVoice === true && !r.restartedElectedSelf && r.restartedHostIsRemaining
        R.proc.kill()
    } catch (err) {
        r.error = String(err?.message ?? err); r.pass = false
    } finally {
        for (const n of [A, B]) n.proc.kill()
        r.stderr = [A, B].map(n => n.stderr.split('\n').filter(l => l.trim()).slice(0, 5))
    }
    return r
}

const results = []
for (const kase of (process.env.CASES || "ab").split("")) for (const rd of (process.env.DELAYS || "0,8000").split(",").map(Number)) for (let k = 0; k < repeats; k++) {
    const r = await run(kase, rd, k)
    results.push(r)
    console.log(`case ${kase} delay ${rd} #${k}: pass=${r.pass} restartedHas=${r.restartedHasBeforeVoice} remainingHas=${r.remainingHasBeforeVoice} electedSelf=${r.restartedElectedSelf} idLower=${r.restartedIdLower} historyDt=${r.historyEvent?.dt} failoverMs=${r.failoverMs}${r.error ? ' ERROR ' + r.error : ''}`)
}
writeFileSync(outFile, JSON.stringify({ node: process.version, results }, null, 2))
console.log(`pass ${results.filter(r => r.pass).length} of ${results.length}`)
