import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { inspectImage, IMAGE_INPUT_LIMIT } from './media-formats.mjs'
import { ATTACHMENT_LIFETIME } from '../network/attachment.mjs'

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

// Each staged PNG lives in its own private temporary directory. A native file chosen by the user never enters it.
export function createClipboardStaging(tempDirectory) {
    const entries = new Map()
    let stagedBytes = 0
    function schedule(file, delay) {
        const entry = entries.get(file)
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => discard(file), delay)
        entry.timer.unref?.()
    }
    function discard(file) {
        const entry = entries.get(file)
        if (!entry) return
        try { rmSync(path.dirname(file), { recursive: true, force: true }) }
        catch { schedule(file, 30000); return } // A reader may still be closing its file handle on Windows.
        clearTimeout(entry.timer)
        stagedBytes -= entry.size
        entries.delete(file)
    }
    function stage(input) {
        if (!(input instanceof Uint8Array) || input.length < 33 || input.length > IMAGE_INPUT_LIMIT ||
            stagedBytes + input.length > 32 * 1024 * 1024 || entries.size >= 16) throw new Error('Clipboard image exceeds staging capacity')
        const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
        if (!bytes.subarray(0, 8).equals(PNG) || !inspectImage(bytes)) throw new Error('Invalid or oversized clipboard PNG')
        const dir = mkdtempSync(path.join(tempDirectory, 'ac-img-'))
        const file = path.join(dir, 'Screenshot.png')
        try { writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' }) }
        catch (err) { rmSync(dir, { recursive: true, force: true }); throw err }
        entries.set(file, { size: bytes.length, timer: null })
        schedule(file, ATTACHMENT_LIFETIME)
        stagedBytes += bytes.length
        return file
    }
    function retain(file, expires) {
        if (entries.has(file)) schedule(file, Math.max(0, expires - Date.now()))
    }
    return { stage, discard, retain, clear() { for (const file of entries.keys()) discard(file) } }
}
