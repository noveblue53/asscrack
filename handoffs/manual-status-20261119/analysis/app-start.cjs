// App start check (Xvfb, 127.0.0.1 VM). Starts two app windows A and B in one LAN room.
// Records each terminal line and each console line. A sets Away with a note. B must show the badge.
const { _electron } = require('playwright')
const fs = require('fs')
const path = require('path')
const S = __dirname
const repo = '/home/user/asscrack'
const out = { terminal: {}, console: {}, pageErrors: {} }

async function start(tag) {
    const dir = fs.mkdtempSync(path.join(S, `app-${tag}-`))
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    const app = await _electron.launch({
        executablePath: path.join(repo, 'node_modules/electron/dist/electron'),
        args: [repo, '--no-sandbox', '--profile', dir, '--log-dir', dir], env
    })
    out.terminal[tag] = []
    out.console[tag] = []
    out.pageErrors[tag] = []
    const proc = app.process()
    proc.stdout.on('data', d => out.terminal[tag].push(...String(d).split('\n').filter(Boolean)))
    proc.stderr.on('data', d => out.terminal[tag].push(...String(d).split('\n').filter(Boolean)))
    const win = await app.firstWindow()
    win.on('console', m => out.console[tag].push(`${m.type()}: ${m.text()}`))
    win.on('pageerror', e => out.pageErrors[tag].push(String(e)))
    await win.waitForSelector('#login')
    await win.fill('#username', tag)
    await win.fill('#room', 'wp3-app')
    await win.click('#login')
    await win.waitForSelector('#chat-screen:not([hidden])', { timeout: 20000 })
    return { app, win }
}

;(async () => {
    const A = await start('A')
    const B = await start('B')
    let result = {}
    try {
        // Wait for the buddy rows (mDNS on this VM).
        await B.win.waitForFunction(() => document.querySelectorAll('.presence-mark').length >= 2, null, { timeout: 30000 })
        result.bBadgesBefore = await B.win.$$eval('.presence-mark', els => els.map(e => e.textContent))
        await A.win.selectOption('#presence-state', 'away')
        await A.win.fill('#presence-note', 'back at 9')
        await A.win.press('#presence-note', 'Enter')
        await B.win.waitForFunction(() => [...document.querySelectorAll('.presence-mark')].some(e => /Away/.test(e.textContent)), null, { timeout: 10000 })
        result.bBadgesAfter = await B.win.$$eval('.presence-mark', els => els.map(e => [e.textContent, e.title]))
        await A.win.screenshot({ path: path.join(S, 'app-A.png') })
        await B.win.screenshot({ path: path.join(S, 'app-B.png') })
        result.pass = true
    } catch (err) {
        result.pass = false
        result.error = String(err)
        await B.win.screenshot({ path: path.join(S, 'app-B-fail.png') }).catch(() => {})
    }
    await new Promise(r => setTimeout(r, 1000))
    await A.app.close()
    await B.app.close()
    console.log('RESULT ' + JSON.stringify({ result, ...out }, null, 2))
})().catch(err => { console.error(err); process.exit(1) })
