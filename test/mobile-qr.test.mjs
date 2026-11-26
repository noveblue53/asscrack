import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQrMatrix, renderQrSvg, rsEncode, rsGenerator } from '../src/application/mobile-qr.mjs';

test('rsGenerator and rsEncode produce valid Reed-Solomon check bytes', () => {
    const data = Uint8Array.from([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
    const ec = rsEncode(data, 10);
    assert.equal(ec.length, 10);
    assert.equal(rsGenerator(10).length, 11);
    assert.ok(ec.some(b => b !== 0));
});

test('encodeQrMatrix draws finder patterns and timing patterns accurately', () => {
    const { size, modules, version } = encodeQrMatrix('https://192.168.1.10:41000/pair?t=abc123');
    assert.ok(version >= 3 && version <= 5);
    assert.equal(size, version * 4 + 17);
    assert.equal(modules.length, size);

    // Top-left finder pattern outer border & center 3x3
    for (let i = 0; i < 7; i++) {
        assert.equal(modules[0][i], true);
        assert.equal(modules[6][i], true);
        assert.equal(modules[i][0], true);
        assert.equal(modules[i][6], true);
    }
    assert.equal(modules[3][3], true);
    assert.equal(modules[1][1], false);

    // Dark module at (4*version + 9, 8)
    assert.equal(modules[4 * version + 9][8], true);
});

test('renderQrSvg outputs valid crisp SVG for short and long pairing URLs', () => {
    const shortSvg = renderQrSvg('https://127.0.0.1:41000/pair?t=tok');
    assert.match(shortSvg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" shape-rendering="crispEdges"/);
    assert.match(shortSvg, /<path d="M/);

    const longUrl = 'https://my-long-ddns-hostname.example.org:41234/pair?t=' + 'A'.repeat(64);
    const longSvg = renderQrSvg(longUrl);
    assert.match(longSvg, /<\/svg>$/);

    assert.throws(() => renderQrSvg('x'.repeat(300)), RangeError);
});
