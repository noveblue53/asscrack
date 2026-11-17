// Window-level reproduction of test card 2, steps 1 to 8, with 2 Electron instances on 127.0.0.1.
// Usage: node history-app.mjs <repo-root> <case a|b> <out.json>
// Env EXE=<portable exe> runs the restarted instance from the exe (the build of the field test).
// The host instance is killed (TerminateProcess). The restarted instance has a new profile and a new peer ID.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [root, kase, outFile] = process.argv.slice(2)
const room = 'ha' + kase + Date.now().toString(36)
const work = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hcheck', room)
const t0 = Date.now()
const log = []
const info = (...a) => { const l = ((Date.now() - t0) / 1000).toFixed(1) + 's ' + a.join(' '); log.push(l); console.log(l) }

function startInstance(i, name, useExe) {
    const port = 9600 + i
    const profile = path.join(work, 'p' + i)
    mkdirSync(profile, { recursive: true })
    const exe = useExe ? process.env.EXE : path.join(root, 'node_modules/electron/dist/electron.exe')
    const args = [...(useExe ? [] : ['.']), '--profile', profile, '--downloads', profile,
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--remote-debugging-port=${port}`]
    const proc = spawn(exe, args, { cwd: root })
    const inst = { i, port, proc, name, profile, out: '', consoleLines: [], id: 0, pending: new Map(), exe: useExe ? process.env.EXE : 'dev' }
    proc.stdout.on('data', d => { inst.out += d })
    proc.stderr.on('data', d => { inst.out += d })
    return inst
}
// Stop every process of an instance. The portable .exe is a launcher: the app runs in a child process,
// so proc.kill() alone leaves the app window open. Each app process has the profile folder in its command line.
function killInst(inst) {
    try { inst.ws?.close() } catch {}
    try { inst.proc.kill() } catch {}
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${inst.profile.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 20000 })
}
async function attach(inst) {
    let target
    for (let k = 0; k < 150 && !target; k++) {
        await delay(200)
        try { target = (await (await fetch(`http://127.0.0.1:${inst.port}/json`)).json()).find(t => t.type === 'page') } catch {}
    }
    if (!target) throw new Error(`instance ${inst.i}: no page target`)
    inst.ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { inst.ws.onopen = res; inst.ws.onerror = rej })
    inst.ws.onmessage = ev => {
        const m = JSON.parse(ev.data)
        if (m.id && inst.pending.has(m.id)) { inst.pending.get(m.id)(m); inst.pending.delete(m.id); return }
        if (m.method === 'Runtime.consoleAPICalled') inst.consoleLines.push(`[console.${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description).join(' '))
        if (m.method === 'Runtime.exceptionThrown') inst.consoleLines.push('[exception] ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text))
        if (m.method === 'Log.entryAdded') inst.consoleLines.push(`[log.${m.params.entry.level}] ` + m.params.entry.text)
    }
    await send(inst, 'Runtime.enable'); await send(inst, 'Log.enable')
    await evaluate(inst, `new Promise(r => document.readyState === 'complete' ? r() : addEventListener('load', r))`)
}
function send(inst, method, params = {}) {
    const id = ++inst.id
    inst.ws.send(JSON.stringify({ id, method, params }))
    return new Promise(res => inst.pending.set(id, res))
}
async function evaluate(inst, expression) {
    const r = await send(inst, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(`instance ${inst.i}: ` + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text))
    return r.result?.result?.value
}
async function login(inst) {
    await evaluate(inst, `document.getElementById('username').value=${JSON.stringify(inst.name)}; document.getElementById('room').value=${JSON.stringify(room)}; document.getElementById('login').click(); true`)
    for (let k = 0; k < 75; k++) { if (await evaluate(inst, `!document.getElementById('chat-screen').hidden`)) return; await delay(200) }
    throw new Error(`instance ${inst.i}: login failed`)
}
const chat = (inst, text) => evaluate(inst, `document.getElementById('message-input').value=${JSON.stringify(text)}; document.getElementById('send').click(); true`)
const hostOf = async inst => JSON.parse(await evaluate(inst, `window.asscrack.getHost().then(h => JSON.stringify(h))`))
const messages = inst => evaluate(inst, `[...document.querySelectorAll('#messages li')].map(e => e.textContent)`)
async function waitUntil(fn, ms) { const s = Date.now(); while (Date.now() - s < ms) { const v = await fn(); if (v) return v; await delay(200) } return null }

const result = { case: kase, room, restartedFrom: process.env.EXE ? path.basename(process.env.EXE) : 'dev' }
const insts = []
try {
    const A = startInstance(0, 'A', false), B = startInstance(1, 'B', false)
    insts.push(A, B)
    await Promise.all([attach(A), attach(B)])
    await Promise.all([login(A), login(B)])
    const common = await waitUntil(async () => { const [a, b] = await Promise.all([hostOf(A), hostOf(B)]); return a.host && b.host && a.host.peerId === b.host.peerId ? { a, b } : null }, 20000)
    if (!common) throw new Error('no common host')
    await chat(A, 'line from A'); await chat(B, 'line from B')
    await delay(500)
    const host = common.a.host.peerId === common.a.self ? A : B
    const other = host === A ? B : A
    const sender = kase === 'a' ? host : other
    await chat(sender, 'before voice')
    await delay(500)
    await evaluate(A, `document.getElementById('join-voice').click(), true`)
    await evaluate(B, `document.getElementById('join-voice').click(), true`)
    await delay(3000)
    result.host = host.name; result.sender = sender.name
    result.windowsBeforeClose = { [A.name]: await messages(A), [B.name]: await messages(B) }
    info('host', host.name, 'sender', sender.name, 'windows', JSON.stringify(result.windowsBeforeClose))
    const killAt = Date.now()
    killInst(host)
    const selfHost = await waitUntil(async () => { const h = await hostOf(other); return h.host?.peerId === h.self ? h : null }, 20000)
    result.failoverMs = selfHost ? Date.now() - killAt : null
    info('failover', result.failoverMs, 'ms')
    const R = startInstance(2, host.name + "'", Boolean(process.env.EXE))
    insts.push(R)
    await attach(R); await login(R)
    const joined = await waitUntil(async () => (await evaluate(R, `document.querySelectorAll('#peers li:not(.self)').length`)) > 0, 20000)
    result.restartedSeesPeer = Boolean(joined)
    await delay(8000)
    const rh = await hostOf(R)
    result.restartedHostIsRemaining = rh.host?.peerId !== undefined && rh.host?.peerId !== rh.self
    result.restartedWindow = await messages(R)
    result.remainingWindow = await messages(other)
    result.restartedWindowHasBeforeVoice = result.restartedWindow.some(t => t.includes('before voice'))
    result.consoleLines = Object.fromEntries(insts.map(x => [x.name, x.consoleLines]))
    info('restarted window', JSON.stringify(result.restartedWindow), 'has before voice:', result.restartedWindowHasBeforeVoice)
} catch (err) {
    result.error = String(err?.message ?? err)
    info('ERROR', result.error)
} finally {
    for (const x of insts) killInst(x)
    result.log = log
    writeFileSync(outFile, JSON.stringify(result, null, 2))
}
