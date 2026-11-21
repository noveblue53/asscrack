import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createClipboardStaging } from '../src/application/clipboard-image.mjs'

test('clipboard staging preserves each PNG byte, rejects malformed inputs and removes only owned temporary files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ac-clip-'))
    const staging = createClipboardStaging(dir)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQ0bABAADMAHm9FcOvAAAAAElFTkSuQmCC', 'base64')
    try {
        const a = staging.stage(png)
        const b = staging.stage(png)
        assert.notEqual(a, b)
        assert.deepEqual(await readFile(a), png)
        assert.throws(() => staging.stage(png.subarray(0, 35)), /Invalid/)
        const malformed = Buffer.from(png)
        malformed[41] ^= 1
        assert.throws(() => staging.stage(malformed), /Invalid/)
        assert.throws(() => staging.stage(new Uint8Array(16 * 1024 * 1024 + 1)), /capacity/)
        staging.discard(a)
        assert.equal((await readdir(dir)).length, 1)
        assert.deepEqual(await readFile(b), png)
        staging.retain(b, Date.now())
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.deepEqual(await readdir(dir), [])
    } finally {
        staging.clear()
        await rm(dir, { recursive: true, force: true })
    }
})
