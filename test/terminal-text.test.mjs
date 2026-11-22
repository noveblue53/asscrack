// L10 (P10a): the terminal demo must not give peer control characters to the terminal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const demo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'network', 'transceiver.mjs')

function start(args) {
    const child = spawn(process.execPath, [demo, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const state = { child, out: '' }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { state.out += chunk })
    child.stderr.on('data', () => {})
    return state
}

async function until(check, ms, what) {
    const end = Date.now() + ms
    while (Date.now() < end) {
        const value = check()
        if (value) return value
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Timeout: ' + what)
}

test('the terminal text function replaces C0, DEL and C1 controls', async () => {
    const { terminalText } = await import('../src/network/terminal-text.mjs')
    assert.equal(terminalText('a\x1b[31mred\x07\x7f\x9bz'), 'a?[31mred???z')
    assert.equal(terminalText('line\r\nnext'), 'line??next')
    assert.equal(terminalText('Grüße 名前 ✓'), 'Grüße 名前 ✓')
    assert.equal(terminalText(undefined), '')
})

test('the terminal demo prints a peer name and message with no escape character', { timeout: 60000 }, async () => {
    const a = start(['--room', 'l10-check', '--name', 'Alice'])
    let b
    try {
        const addr = await until(() => /^(\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\/\S+)$/m.exec(a.out)?.[1], 20000, 'demo A address')
        b = start(['--room', 'l10-check', '--name', 'Bob\x1b]0;owned\x07', addr])
        await until(() => a.out.includes('Chat ready with peer:') && b.out.includes('Chat ready with peer:'), 20000, 'chat ready')
        b.child.stdin.write('hi \x1b[2J\x1b[31mred\x9b\n')
        await until(() => /> .*: hi /.test(a.out), 20000, 'message at A')
        assert.ok(!a.out.includes('\x1b'), 'the output of A contains an ESC character')
        assert.ok(!a.out.includes('\x9b'), 'the output of A contains a C1 CSI character')
        assert.match(a.out, /> Bob\?\]0;owned\?: hi \?\[2J\?\[31mred\?/)
    } finally {
        a.child.kill()
        b?.child.kill()
    }
})
