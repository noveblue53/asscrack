// M3 (P10a): a received file must have the Mark-of-the-Web (Zone.Identifier, ZoneId=3) on Windows.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'

const windows = process.platform === 'win32'
const base = { room: 'zone-mark', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false,
    heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 300 }

async function waitUntil(check, limit) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        if (check()) return
        await delay(20)
    }
    assert.ok(check(), `Condition not true within ${limit} ms`)
}

const tempDir = prefix => fsp.mkdtemp(path.join(os.tmpdir(), `asscrack-${prefix}-`))

test('127.0.0.1: a received .exe file has Zone.Identifier with ZoneId=3', { skip: !windows && 'Windows only', timeout: 30000 }, async () => {
    const src = await tempDir('zone-src')
    const dirA = await tempDir('zone-a')
    const dirB = await tempDir('zone-b')
    const a = await createAsscrackNode({ ...base, downloadDir: dirA })
    const b = await createAsscrackNode({ ...base, downloadDir: dirB })
    try {
        await a.connect(b.getMultiaddrs()[0])
        await waitUntil(() => a.peers().includes(b.peerId) && b.peers().includes(a.peerId), 5000)
        const done = []
        b.events.on('file-offer', ({ offerId }) => b.acceptFile(offerId))
        b.events.on('file-done', e => done.push(e))
        const file = path.join(src, 'tool.exe')
        await fsp.writeFile(file, 'MZ not a real program')
        // The sender file has no mark: the mark must come from the receiver.
        await assert.rejects(fsp.readFile(file + ':Zone.Identifier'))
        await a.offerFile(file)
        await waitUntil(() => done.length === 1, 10000)
        assert.equal(done[0].path, path.join(dirB, 'tool.exe'))
        assert.equal(await fsp.readFile(done[0].path, 'utf8'), 'MZ not a real program')
        const zone = await fsp.readFile(done[0].path + ':Zone.Identifier', 'utf8')
        assert.match(zone, /^\[ZoneTransfer\]\r?\nZoneId=3\r?\n/)
    } finally {
        await Promise.allSettled([a.stop(), b.stop()])
        await Promise.allSettled([src, dirA, dirB].map(d => fsp.rm(d, { recursive: true, force: true })))
    }
})

test('the mark is not written on other platforms, and a refused stream write does not stop the receive', async () => {
    const { markFromInternet, ZONE_TEXT } = await import('../src/network/zone-mark.mjs')
    const writes = []
    const fs = { writeFile: async (file, text) => { writes.push([file, text]) } }
    assert.equal(await markFromInternet('/tmp/x', { platform: 'linux', fs }), false)
    assert.equal(writes.length, 0)
    assert.equal(await markFromInternet('C:/d/x.exe', { platform: 'win32', fs }), true)
    assert.deepEqual(writes, [['C:/d/x.exe:Zone.Identifier', ZONE_TEXT]])
    const refused = { writeFile: async () => { throw Object.assign(new Error('no streams'), { code: 'EINVAL' }) } }
    assert.equal(await markFromInternet('E:/x.exe', { platform: 'win32', fs: refused }), false)
})
