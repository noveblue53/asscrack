// Checks the committed app icon (src/application/img/app.ico) and the build.win.icon entry of package.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ico = fs.readFileSync(path.join(root, 'src', 'application', 'img', 'app.ico'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function entries() {
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1, 'type 1 is an icon');
    const count = ico.readUInt16LE(4);
    return Array.from({ length: count }, (_, i) => {
        const e = 6 + 16 * i;
        return { size: ico[e] || 256, height: ico[e + 1] || 256, length: ico.readUInt32LE(e + 8), offset: ico.readUInt32LE(e + 12) };
    });
}

test('the icon has 7 images with the sizes 16 to 256', () => {
    const list = entries();
    assert.deepEqual(list.map(e => e.size), [16, 24, 32, 48, 64, 128, 256]);
    for (const e of list) assert.equal(e.height, e.size);
});

test('each image is in the file', () => {
    for (const e of entries()) {
        assert.ok(e.length > 0);
        assert.ok(e.offset >= 6 + 16 * entries().length);
        assert.ok(e.offset + e.length <= ico.length, `${e.size} px data ends after the file`);
    }
});

test('the 256 px image is a 256 x 256 PNG', () => {
    const e = entries().find(x => x.size === 256);
    const data = ico.subarray(e.offset, e.offset + e.length);
    assert.ok(data.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(data.toString('latin1', 12, 16), 'IHDR');
    assert.equal(data.readUInt32BE(16), 256);
    assert.equal(data.readUInt32BE(20), 256);
});

test('the images from 16 to 128 px are 32-bit DIB images', () => {
    for (const e of entries().filter(x => x.size < 256)) {
        const data = ico.subarray(e.offset, e.offset + e.length);
        const n = e.size;
        assert.equal(data.readUInt32LE(0), 40, `${n} px BITMAPINFOHEADER`);
        assert.equal(data.readInt32LE(4), n);
        assert.equal(data.readInt32LE(8), 2 * n);
        assert.equal(data.readUInt16LE(14), 32);
        assert.equal(e.length, 40 + n * n * 4 + Math.ceil(n / 32) * 4 * n, `${n} px pixels and AND mask`);
    }
});

test('package.json build.win.icon names a file that exists', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(typeof pkg.build.win.icon, 'string');
    assert.ok(fs.existsSync(path.join(root, pkg.build.win.icon)));
});
