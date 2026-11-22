// A small zip reader for the tests of the diagnostics bundle. It reads the central directory, checks each CRC and
// inflates each entry. It never writes a file (no path from the zip is used).
import zlib from 'node:zlib';

export function readZip(buffer) {
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('no end of central directory');
    const count = buffer.readUInt16LE(eocd + 10);
    let p = buffer.readUInt32LE(eocd + 16);
    const entries = new Map();
    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
        const method = buffer.readUInt16LE(p + 10);
        const crc = buffer.readUInt32LE(p + 16);
        const compressed = buffer.readUInt32LE(p + 20);
        const size = buffer.readUInt32LE(p + 24);
        const nameLength = buffer.readUInt16LE(p + 28);
        const extra = buffer.readUInt16LE(p + 30);
        const comment = buffer.readUInt16LE(p + 32);
        const offset = buffer.readUInt32LE(p + 42);
        const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
        p += 46 + nameLength + extra + comment;
        if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('bad local header');
        const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
        const body = buffer.subarray(start, start + compressed);
        const data = method === 8 ? zlib.inflateRawSync(body) : method === 0 ? Buffer.from(body) : null;
        if (!data) throw new Error(`method ${method}`);
        if (data.length !== size || (zlib.crc32(data) >>> 0) !== crc) throw new Error(`bad entry ${name}`);
        entries.set(name, data);
    }
    return entries;
}
