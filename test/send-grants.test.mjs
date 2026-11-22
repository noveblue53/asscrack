// P7c: the resume grants of a sender in its profile (src/network/send-grants.mjs). Disk of this PC only, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createGrantStore, GRANT_LIMIT } from '../src/network/send-grants.mjs'

const grant = (fields = {}) => ({ offerId: '11111111-1111-4111-8111-111111111111', device: 'device-b',
    filePath: path.join(os.tmpdir(), 'big.bin'), name: 'big.bin', size: 1000, sha256: 'a'.repeat(64), dev: 1, ino: 2.5,
    mtimeMs: 1700000000123.456, ctimeMs: 1700000000999.25, expiresAt: Date.now() + 60000, ...fields })

async function file(t) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asscrack-grants-'))
    t.after(() => fsp.rm(dir, { recursive: true, force: true }))
    return path.join(dir, 'profile', 'resume-grants.json')
}

test('a saved grant loads with the same stat numbers; an expired or bad grant does not load', async t => {
    const target = await file(t)
    const store = createGrantStore({ file: target })
    const good = grant()
    await store.save([good, grant({ offerId: '22222222-2222-4222-8222-222222222222', expiresAt: Date.now() - 1 }),
        grant({ offerId: 'not-a-uuid' }), grant({ filePath: 'relative.bin' }), grant({ device: '' }), grant({ ino: 'x' })])
    assert.deepEqual(await createGrantStore({ file: target }).load(), [good])
    let clock = Date.now() + 120000
    assert.deepEqual(await createGrantStore({ file: target, now: () => clock }).load(), [], 'expired at the next start')
    await store.save([])
    await assert.rejects(fsp.stat(target), /ENOENT/, 'no grant: no file')
})

test('the store keeps at most GRANT_LIMIT grants and ignores a damaged file', async t => {
    const target = await file(t)
    const store = createGrantStore({ file: target })
    const many = Array.from({ length: GRANT_LIMIT + 5 }, (_, i) =>
        grant({ offerId: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}` }))
    await store.save(many)
    const loaded = await store.load()
    assert.equal(loaded.length, GRANT_LIMIT)
    assert.deepEqual(loaded.at(-1), many.at(-1))
    await fsp.writeFile(target, '{ not json')
    assert.deepEqual(await store.load(), [])
})
