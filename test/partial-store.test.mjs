import test from 'node:test'
import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createPartialStore, partialKey, PARTIAL_BUDGET, PARTIAL_TTL_MS } from '../src/network/partial-store.mjs'

// These tests use the disk of this PC only. They need no network.
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

async function folder(t) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asscrack-partials-'))
    t.after(() => fsp.rm(dir, { recursive: true, force: true }))
    return dir
}

async function temp(dir, name, bytes) {
    const file = path.join(dir, name)
    await fsp.writeFile(file, Buffer.alloc(bytes, 7))
    return file
}

function store(dir, options = {}) {
    const changes = []
    const partials = createPartialStore({ dir, onChange: (type, entry) => changes.push({ type, ...entry }), ...options })
    return { partials, changes }
}

test('the proposed limits are 8 GiB and 72 hours', () => {
    assert.equal(PARTIAL_BUDGET, 8 * 1024 ** 3)
    assert.equal(PARTIAL_TTL_MS, 72 * 3600 * 1000)
})

test('a kept partial expires 72 hours after its last byte and its disk space is free', async t => {
    const dir = await folder(t)
    let clock = 1_000_000
    const { partials, changes } = store(dir, { now: () => clock })
    const file = await temp(dir, '.asscrack-11111111-1111-4111-8111-111111111111.part', 4096)
    assert.equal(await partials.adopt(file, { sha256: SHA_A, size: 10000, name: 'big.bin', offerId: 'o1', bytes: 4096 }), true)
    const part = path.join(dir, `.asscrack-resume-${partialKey(SHA_A, 10000)}.part`)
    assert.equal((await fsp.stat(part)).size, 4096)
    const [kept] = await partials.list()
    assert.deepEqual(kept, { key: partialKey(SHA_A, 10000), sha256: SHA_A, size: 10000, name: 'big.bin', offerId: 'o1', bytes: 4096,
        lastByteAt: 1_000_000, expiresAt: 1_000_000 + PARTIAL_TTL_MS, active: false })
    clock += PARTIAL_TTL_MS - 1
    assert.equal((await partials.list()).length, 1)
    clock += 1
    assert.deepEqual(await partials.list(), [])
    assert.equal(changes.at(-1).type, 'expired')
    assert.deepEqual(await fsp.readdir(dir), [], 'the expiry deleted the bytes and the description')
})

test('the budget refuses a partial that does not fit, and Discard frees the space', async t => {
    const dir = await folder(t)
    const { partials, changes } = store(dir, { budget: 10000 })
    const a = await temp(dir, 'a.tmp', 6000)
    const b = await temp(dir, 'b.tmp', 6000)
    assert.equal(await partials.adopt(a, { sha256: SHA_A, size: 9000, name: 'a', bytes: 6000 }), true)
    assert.equal(await partials.adopt(b, { sha256: SHA_B, size: 9000, name: 'b', bytes: 6000 }), false)
    assert.ok((await fsp.readdir(dir)).includes('b.tmp'), 'the caller deletes a refused partial')
    assert.equal(await partials.discard(partialKey(SHA_A, 9000)), true)
    assert.equal(changes.at(-1).type, 'discarded')
    assert.equal(changes.at(-1).reason, 'user')
    assert.equal(await partials.discard(partialKey(SHA_A, 9000)), false)
    assert.equal(await partials.adopt(b, { sha256: SHA_B, size: 9000, name: 'b', bytes: 6000 }), true)
    assert.deepEqual((await partials.list()).map(p => p.sha256), [SHA_B])
})

test('one receive at a time can claim a partial, and a release over the budget deletes it', async t => {
    const dir = await folder(t)
    const { partials } = store(dir, { budget: 5000 })
    await partials.adopt(await temp(dir, 'a.tmp', 1000), { sha256: SHA_A, size: 9000, name: 'a', bytes: 1000 })
    const claim = await partials.claim(SHA_A, 9000)
    assert.equal(claim.bytes, 1000)
    assert.equal(await partials.claim(SHA_A, 9000), null)
    assert.equal(await partials.discard(claim.key), false, 'Discard cannot delete a partial in use')
    assert.equal((await partials.list())[0].active, true)
    assert.equal(await partials.release(claim.key, { bytes: 3000 }), true)
    assert.equal((await partials.list())[0].bytes, 3000)
    const again = await partials.claim(SHA_A, 9000)
    assert.equal(await partials.release(again.key, { bytes: 6000 }), false)
    assert.deepEqual(await fsp.readdir(dir), [])
})

test('a new store reads the partials of an earlier run and removes damaged ones', async t => {
    const dir = await folder(t)
    const { partials } = store(dir, { now: () => 5000 })
    await partials.adopt(await temp(dir, 'a.tmp', 100), { sha256: SHA_A, size: 900, name: 'kept.bin', offerId: 'o', bytes: 100 })
    const key = partialKey(SHA_B, 900)
    await fsp.writeFile(path.join(dir, `.asscrack-resume-${key}.part`), Buffer.alloc(950))
    await fsp.writeFile(path.join(dir, `.asscrack-resume-${key}.json`),
        JSON.stringify({ v: 1, sha256: SHA_B, size: 900, name: 'too long', lastByteAt: 5000 }))
    await fsp.writeFile(path.join(dir, `.asscrack-resume-${partialKey('c'.repeat(64), 5)}.json`), 'not json')
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'not a partial')
    const next = store(dir, { now: () => 6000 }).partials
    assert.deepEqual((await next.list()).map(p => [p.name, p.bytes, p.lastByteAt]), [['kept.bin', 100, 5000]])
    assert.deepEqual((await fsp.readdir(dir)).sort(), [`.asscrack-resume-${partialKey(SHA_A, 900)}.json`,
        `.asscrack-resume-${partialKey(SHA_A, 900)}.part`, 'notes.txt'].sort())
})

// P7c: the retry state of a partial (the sender of its last attempt) is in its description. The window gets the
// sender name and peer ID, not the device ID.
test('P7c: the retry state survives a restart, a bad retry state keeps the part, and forgetSource keeps the bytes', async t => {
    const dir = await folder(t)
    const source = { peerId: '12D3KooWsender', device: 'device-of-sender', from: 'Sam', flow: true }
    const first = store(dir).partials
    const file = await temp(dir, '.asscrack-11111111-1111-4111-8111-111111111111.part', 4096)
    assert.equal(await first.adopt(file, { sha256: SHA_A, size: 10000, name: 'big.bin', offerId: 'o1', bytes: 4096, source }), true)
    const [kept] = await store(dir).partials.list()
    assert.equal(kept.resumable, true)
    assert.equal(kept.from, 'Sam')
    assert.equal(kept.peerId, source.peerId)
    assert.equal(Object.hasOwn(kept, 'device'), false)
    const again = store(dir)
    await again.partials.list()
    assert.deepEqual(again.partials.source(kept.key), { ...source, offerId: 'o1' })
    await again.partials.forgetSource(kept.key)
    const [after] = await store(dir).partials.list()
    assert.equal(after.resumable, undefined)
    assert.equal(after.bytes, 4096, 'the bytes stay')

    // A description of P7b (no retry state) and one with a bad retry state both load, with no retry state.
    const meta = path.join(dir, `.asscrack-resume-${kept.key}.json`)
    const description = JSON.parse(await fsp.readFile(meta, 'utf8'))
    for (const bad of [{ ...source, device: 'x'.repeat(129) }, { ...source, peerId: 7 }, 'text']) {
        await fsp.writeFile(meta, JSON.stringify({ ...description, source: bad }))
        const [loaded] = await store(dir).partials.list()
        assert.equal(loaded?.bytes, 4096, JSON.stringify(bad))
        assert.equal(loaded.resumable, undefined)
    }
})
