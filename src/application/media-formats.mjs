// Inspect declared geometry before handing bytes to a decoder. A full-size transfer
// is independent of these budgets for the disposable, inline representation.
import { crc32 } from 'node:zlib';

export const PREVIEW_LIMIT = 512 * 1024;
export const IMAGE_INPUT_LIMIT = 16 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const within = (w, h, pixels) => w > 0 && h > 0 && w * h <= pixels && Math.max(w,h) <= 16384;

function png(buffer, wire) {
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG)) return null;
    const w = buffer.readUInt32BE(16), h = buffer.readUInt32BE(20);
    if (!within(w, h, wire ? 1_000_000 : 12_000_000) || (wire && Math.max(w, h) > 1024)) return null;
    const parts = [PNG];
    let at = 8, blocks = 0, data = false;
    while (at + 12 <= buffer.length && blocks++ < 4096) {
        const n = buffer.readUInt32BE(at), end = at + 12 + n;
        if (end > buffer.length) return null;
        const type = buffer.toString('latin1', at + 4, at + 8);
        if ((at === 8) !== (type === 'IHDR') || (type === 'IHDR' && n !== 13)) return null;
        if (['acTL','fcTL','fdAT'].includes(type)) return null;
        if (crc32(buffer.subarray(at + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) return null;
        if (['IHDR','PLTE','tRNS','IDAT','IEND'].includes(type)) parts.push(buffer.subarray(at, end));
        else if (type[0] === type[0].toUpperCase()) return null;
        if (type === 'IDAT') data = true;
        if (type === 'IEND') return data && n === 0 && end === buffer.length
            ? { width: w, height: h, mime: 'image/png', bytes: Buffer.concat(parts) } : null;
        at = end;
    }
    return null;
}

export function inspectImage(bytes, wire = false) {
    if (!Buffer.isBuffer(bytes) || bytes.length > (wire ? PREVIEW_LIMIT : IMAGE_INPUT_LIMIT)) return null;
    if (wire || bytes.subarray(0, 8).equals(PNG)) return png(bytes, wire);
    if (bytes.length < 32) return null;
    let w, h, mime;
    if (bytes[0] === 255 && bytes[1] === 216) {
        let i = 2;
        while (i + 8 < bytes.length && bytes[i++] === 255) {
            while (bytes[i] === 255) i++;
            const marker = bytes[i++];
            if (marker === 218 || marker === 217 || i + 7 > bytes.length) return null;
            const size = bytes.readUInt16BE(i);
            if (size < 2 || i + size > bytes.length) return null;
            if ([192,193,194].includes(marker)) {
                h = bytes.readUInt16BE(i + 3); w = bytes.readUInt16BE(i + 5); mime = 'image/jpeg'; break;
            }
            i += size;
        }
    } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
        const type = bytes.toString('ascii', 12, 16);
        if (type === 'VP8X' && !(bytes[20] & 2)) { w = 1 + bytes.readUIntLE(24,3); h = 1 + bytes.readUIntLE(27,3); }
        if (type === 'VP8 ') { w = bytes.readUInt16LE(26) & 16383; h = bytes.readUInt16LE(28) & 16383; }
        if (type === 'VP8L' && bytes[20] === 47) {
            const bits = bytes.readUInt32LE(21); w = 1 + (bits & 16383); h = 1 + ((bits >>> 14) & 16383);
        }
        mime = 'image/webp';
    }
    return within(w, h, 12_000_000) ? { width: w, height: h, mime, bytes } : null;
}

// GIF frame rectangles and all extension/data subblocks are checked before the
// Chromium ImageDecoder can allocate frame buffers. Playback decodes one frame at a time.
export function inspectGif(bytes) {
    if (bytes.length < 14 || bytes.length > IMAGE_INPUT_LIMIT ||
        !['GIF87a','GIF89a'].includes(bytes.toString('ascii', 0, 6))) return null;
    const w = bytes.readUInt16LE(6), h = bytes.readUInt16LE(8);
    if (!within(w, h, 1_000_000) || Math.max(w, h) > 1024) return null;
    const colorTable = flags => flags & 128 ? 3 * (1 << ((flags & 7) + 1)) : 0;
    let at = 13 + colorTable(bytes[10]), frames = 0;
    while (at < bytes.length) {
        const tag = bytes[at++];
        if (tag === 59) return frames > 0 ? { width: w, height: h, frames, mime: 'image/gif' } : null;
        if (tag === 44) {
            if (at + 10 > bytes.length) return null;
            const fw = bytes.readUInt16LE(at + 4), fh = bytes.readUInt16LE(at + 6);
            if (!fw || !fh || bytes.readUInt16LE(at) + fw > w || bytes.readUInt16LE(at + 2) + fh > h) return null;
            if (++frames > 256 || frames * w * h > 16_000_000) return null;
            at += 10 + colorTable(bytes[at + 8]); // descriptor, optional table, LZW code size
        } else if (tag === 33) at++; // extension label
        else return null;
        let n;
        do {
            if (at >= bytes.length) return null;
            n = bytes[at++]; at += n;
        } while (n);
    }
    return null;
}

export function videoMime(bytes) {
    if (bytes.length > 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
    if (bytes.length > 4 && bytes.readUInt32BE(0) === 0x1a45dfa3 && bytes.includes(Buffer.from('webm'))) return 'video/webm';
    if (bytes.toString('ascii', 0, 4) === 'OggS') return 'video/ogg';
    return null;
}
