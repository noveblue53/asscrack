// Room-scoped media capabilities. The renderer receives only opaque read-only URLs.
// Encoder/decoder input is bounded separately from unrestricted streamed originals.
import { sameAttachment } from '../network/attachment.mjs';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { IMAGE_INPUT_LIMIT, PREVIEW_LIMIT, inspectGif, inspectImage, videoMime } from './media-formats.mjs';

const CACHE_LIMIT = 32 * 1024 * 1024;
const MAX_OPEN_ORIGINALS = 12;
const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(',');
const failed = (status, headers) => new Response(null, { status, headers });

async function openRegular(file) {
    const before = await lstat(file, { bigint: true });
    if (!before.isFile()) throw Error('Media must be a regular file');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
        const now = await handle.stat({ bigint: true });
        if (stamp(now) !== stamp(before)) throw Error('File changed');
        return handle;
    } catch (err) { await handle.close(); throw err; }
}

async function readPart(handle, length) {
    const bytes = Buffer.alloc(length);
    let at = 0;
    while (at < length) {
        const { bytesRead } = await handle.read(bytes, at, length - at, at);
        if (!bytesRead) break;
        at += bytesRead;
    }
    return bytes.subarray(0, at);
}

export function byteRange(header, size) {
    if (!header) return { start: 0, end: size - 1 };
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!match || (!match[1] && !match[2])) return null;
    const a = Number(match[1]), b = Number(match[2]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
    const start = match[1] ? a : Math.max(0, size - b);
    const end = match[1] && match[2] ? Math.min(size - 1, b) : size - 1;
    return start <= end && start < size ? { start, end } : null;
}

// Node stream high-water marks are measured in bytes. WHATWG streams count chunks
// by default, which would let a slow media consumer queue thousands of 64 KiB blocks.
export function mediaBody(stream) {
    return Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } });
}

export function createRoomMedia({ nativeImage, changed = () => {} }) {
    const entries = new Map(), routes = new Map(), cache = new Map(), streams = new Set();
    let bytesUsed = 0, decoding = 0, epoch = 0, thumbnailEpoch = 0, openingOriginals = 0;
    const hashWaiters = [];
    let hashing = 0, hashController = new AbortController();

    function dropPreview(entry) {
        if (!cache.delete(entry)) return;
        bytesUsed -= entry.thumbnail.length;
        entry.thumbnail = null;
        changed(entry.id);
    }

    function entryFor(d) {
        if (!d?.id || !d.sha256 || !['image','gif','video'].includes(d.kind)) return null;
        const old = entries.get(d.id);
        if (old) return sameAttachment(old, d) ? old : null;
        if (entries.size >= 512) {
            const first = entries.values().next().value;
            entries.delete(first.id); routes.delete(first.token); dropPreview(first);
        }
        const entry = { ...d, token: randomUUID(), thumbnail: null, original: null };
        entries.set(d.id, entry); routes.set(entry.token, entry);
        return entry;
    }

    function encode(info) {
        if (!info) return null;
        let image = nativeImage.createFromBuffer(info.bytes);
        const { width, height } = image.getSize();
        if (image.isEmpty() || width !== info.width || height !== info.height) return null;
        let ratio = Math.min(1, 1024 / Math.max(width, height), Math.sqrt(1_000_000 / (width * height)));
        if (ratio < 1) image = image.resize({ width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) });
        for (let i = 0; i < 8; i++) {
            const bytes = image.toPNG();
            if (bytes.length && bytes.length <= PREVIEW_LIMIT) return bytes;
            const size = image.getSize();
            image = image.resize({ width: Math.max(1, Math.floor(size.width * 0.72)), height: Math.max(1, Math.floor(size.height * 0.72)) });
        }
        return null;
    }

    async function makePreview(file, descriptor) {
        if (decoding >= 2) return null;
        decoding++;
        let fh;
        try {
            fh = await openRegular(file);
            const st = await fh.stat();
            if (!st.isFile() || st.size < 1 || st.size > IMAGE_INPUT_LIMIT) return null;
            const bytes = await readPart(fh, st.size);
            if (bytes.length !== descriptor?.size || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) return null;
            return encode(inspectImage(bytes));
        } catch { return null; }
        finally { await fh?.close(); decoding--; }
    }

    function saveThumbnail(d, bytes) {
        const entry = entryFor(d);
        if (!entry || !bytes?.length || bytes.length > PREVIEW_LIMIT) return false;
        if (cache.has(entry)) { bytesUsed -= entry.thumbnail.length; cache.delete(entry); }
        while (bytesUsed + bytes.length > CACHE_LIMIT) dropPreview(cache.keys().next().value);
        entry.thumbnail = bytes;
        cache.set(entry, true); bytesUsed += bytes.length; changed(d.id);
        return true;
    }

    function storePreview(d, bytes) {
        if (decoding >= 2 || d?.kind !== 'image') return false;
        decoding++;
        try { return saveThumbnail(d, encode(inspectImage(bytes, true))); }
        catch { return false; }
        finally { decoding--; }
    }

    async function verified(d, file, allowed = () => true) {
        const entry = entryFor(d);
        if (!entry) return;
        const version = epoch, thumbnailVersion = thumbnailEpoch;
        let fh;
        try {
            fh = await openRegular(file);
            const st = await fh.stat({ bigint: true });
            if (!st.isFile() || Number(st.size) !== d.size) return;
            let fmt;
            if (d.kind === 'video') {
                const mime = videoMime(await readPart(fh, Math.min(d.size, 4096)));
                if (mime) fmt = { mime };
            } else if (d.kind === 'gif' && d.size <= IMAGE_INPUT_LIMIT) {
                fmt = inspectGif(await readPart(fh, d.size));
            } else if (d.kind === 'image') {
                const thumb = await makePreview(file, d);
                if (epoch === version && thumbnailVersion === thumbnailEpoch && entries.get(d.id) === entry && allowed() && thumb) saveThumbnail(d, thumb);
            }
            if (!fmt || version !== epoch || entries.get(d.id) !== entry || !allowed()) return;
            entry.original = { file, stamp: stamp(st), ...fmt, hashCheck: null };
            changed(d.id);
        } catch { /* Deleted or unreadable originals keep the card and original retrieval action. */ }
        finally { await fh?.close(); }
    }

    function info(ref) {
        const e = entries.get(typeof ref === 'string' ? ref : ref?.id);
        if (!e || (typeof ref !== 'string' && !sameAttachment(e, ref))) return {};
        if (cache.has(e)) { cache.delete(e); cache.set(e,true); }
        const base = 'room-media://asset/' + e.token;
        return { thumbnailUrl: e.thumbnail ? base + '/thumbnail' : null,
            originalUrl: e.original ? base + '/original' : null,
            mime: e.original?.mime, width: e.original?.width, height: e.original?.height };
    }

    // A local path can change between receipt, a later Play click and a range read.
    // Pin each response to an opened file, compare its identity, and stream the hash
    // once per registered original before releasing any original bytes to Chromium.
    async function verifyHash(entry, original) {
        const signal = hashController.signal;
        if (hashing >= 2) {
            if (hashWaiters.length >= 512) return false;
            await new Promise(resolve => hashWaiters.push(resolve));
            if (signal.aborted) return false;
        }
        hashing++;
        let fh;
        try {
            fh = await openRegular(original.file);
            if (stamp(await fh.stat({ bigint: true })) !== original.stamp) return false;
            const hash = createHash('sha256');
            const block = Buffer.allocUnsafe(128 * 1024);
            let position = 0;
            while (position < entry.size) {
                signal.throwIfAborted();
                const remaining = Math.min(block.length, entry.size - position);
                const { bytesRead } = await fh.read(block, 0, remaining, position);
                if (!bytesRead) return false;
                hash.update(block.subarray(0, bytesRead));
                position += bytesRead;
            }
            return hash.digest('hex') === entry.sha256 && stamp(await fh.stat({ bigint: true })) === original.stamp;
        } finally {
            await fh?.close(); hashing--; hashWaiters.shift()?.();
        }
    }

    async function serve(request) {
        const url = new URL(request.url);
        const m = /^\/([0-9a-f-]{36})\/(thumbnail|original)$/.exec(url.pathname);
        if (url.protocol !== 'room-media:' || url.host !== 'asset' || url.search || url.username || url.password || !m) return failed(404);
        if (!['GET','HEAD'].includes(request.method)) return failed(405);
        const entry = routes.get(m[1]);
        if (!entry) return failed(404);
        const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'", 'Access-Control-Allow-Origin': 'null' };
        if (m[2] === 'thumbnail') {
            if (!entry.thumbnail) return failed(404);
            headers['Content-Type'] = 'image/png';
            headers['Content-Length'] = String(entry.thumbnail.length);
            return new Response(request.method === 'HEAD' ? null : entry.thumbnail, { headers });
        }
        const original = entry.original;
        if (!original) return failed(404);
        if (openingOriginals + streams.size >= MAX_OPEN_ORIGINALS) return failed(503, { 'Retry-After': '1' });
        openingOriginals++;
        let fh;
        try {
            fh = await openRegular(original.file);
            const st = await fh.stat({ bigint: true });
            if (stamp(st) !== original.stamp) return failed(410);
            original.hashCheck ??= verifyHash(entry, original).catch(() => false);
            if (!await original.hashCheck || routes.get(entry.token) !== entry || entry.original !== original) return failed(410);
            const range = request.headers.get('Range'), size = Number(st.size);
            const part = byteRange(range, size);
            if (!part) return failed(416, { 'Content-Range': 'bytes */' + size });
            const { start, end } = part;
            headers['Content-Type'] = original.mime;
            headers['Accept-Ranges'] = 'bytes';
            headers['Content-Length'] = String(end - start + 1);
            if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
            const status = range ? 206 : 200;
            if (request.method === 'HEAD') return new Response(null, { status, headers });
            const stream = fh.createReadStream({ start, end, autoClose: true, signal: request.signal });
            fh = null; streams.add(stream);
            stream.once('close', () => streams.delete(stream));
            return new Response(mediaBody(stream), { status, headers });
        } catch { return failed(410); }
        finally { try { await fh?.close(); } finally { openingOriginals--; } }
    }

    async function canReveal(d, file) {
        try {
            const st = await lstat(file, { bigint: true });
            if (!st.isFile() || Number(st.size) !== d?.size) return false;
            return await verifyHash(d, { file, stamp: stamp(st) });
        } catch { return false; }
    }

    async function restore(d, file, allowed = () => true) {
        const version = epoch;
        if (!await canReveal(d, file) || version !== epoch || !allowed()) return false;
        await verified(d, file, allowed);
        return version === epoch && allowed();
    }

    function clearPreviews() {
        thumbnailEpoch++;
        for (const entry of [...cache.keys()]) dropPreview(entry);
    }

    function clear() {
        epoch++;
        hashController.abort(); hashController = new AbortController();
        for (const wake of hashWaiters.splice(0)) wake();
        const ids = [...entries.keys()];
        for (const stream of streams) stream.destroy();
        streams.clear(); entries.clear(); routes.clear(); cache.clear(); bytesUsed = 0;
        for (const id of ids) changed(id);
    }

    return { makePreview, storePreview, verified, restore, canReveal, info, serve, clear, clearPreviews };
}
