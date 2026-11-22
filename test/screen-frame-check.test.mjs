// P8b, design work package W5, checks 1 to 3 (work-orders/astra/P8/DESIGN.md, section 2.9, "Limits at the viewer"):
// the CONFIG check, the VP8 keyframe header check and the sequence gate of screen-frame-check.js. The classic script
// runs in node:vm, the pattern of voice-gate.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/screen-frame-check.js', import.meta.url), 'utf8');
function load() {
    const window = {};
    vm.runInNewContext(source, { window, Number, Object, Date }, { filename: 'screen-frame-check.js' });
    return window.screenFrameCheck;
}

// A VP8 keyframe header (RFC 6386, section 9.1): a 3-byte frame tag (bit 0 = 0: keyframe), the start code 9d 01 2a,
// then the 14-bit width and height, little endian, with 2 scale bits at the top.
function keyframe(width, height, { scale = 0, tag = 0x10, start = [0x9d, 0x01, 0x2a], length = 64 } = {}) {
    const bytes = new Uint8Array(length);
    bytes[0] = tag;
    bytes[1] = 0x02;
    bytes[2] = 0x00;
    bytes.set(start, 3);
    bytes[6] = width & 0xff;
    bytes[7] = ((width >> 8) & 0x3f) | (scale << 6);
    bytes[8] = height & 0xff;
    bytes[9] = ((height >> 8) & 0x3f) | (scale << 6);
    return bytes;
}

const SHARE = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

test('W5 check 1: the keyframe header check accepts the size of CONFIG and refuses each wrong header', () => {
    const { checkKeyframe } = load();
    assert.deepEqual({ ...checkKeyframe(keyframe(1280, 720), 1280, 720) }, { ok: true, reason: null });
    assert.equal(checkKeyframe(keyframe(2560, 1440), 2560, 1440).ok, true, 'the largest size');
    assert.equal(checkKeyframe(keyframe(1280, 720, { scale: 3 }), 1280, 720).ok, true, 'the scale bits are not part of the size');
    assert.equal(checkKeyframe(keyframe(1282, 720), 1280, 720).reason, 'width', 'a different width');
    assert.equal(checkKeyframe(keyframe(1280, 722), 1280, 720).reason, 'height', 'a different height');
    assert.equal(checkKeyframe(keyframe(1280, 720, { start: [0x9d, 0x01, 0x2b] }), 1280, 720).reason, 'start code');
    assert.equal(checkKeyframe(keyframe(1280, 720, { tag: 0x11 }), 1280, 720).reason, 'not a keyframe', 'a delta frame as the first frame');
    assert.equal(checkKeyframe(keyframe(1280, 720, { length: 9 }), 1280, 720).reason, 'short', 'fewer than 10 bytes');
    assert.equal(checkKeyframe(keyframe(1280, 720, { length: 10 }), 1280, 720).ok, true, 'exactly 10 bytes');
    assert.equal(checkKeyframe(null, 1280, 720).ok, false);
    // VP8 permits 16383 x 16383: the header check stops a frame that is larger than CONFIG.
    assert.equal(checkKeyframe(keyframe(16383, 16383), 1280, 720).ok, false);
});

test('W5 check 2: the CONFIG check refuses each value outside the limits of revision 2', () => {
    const { checkConfig } = load();
    const good = { codec: 'vp8', width: 1920, height: 1080, fps: 60, shareId: SHARE };
    assert.equal(checkConfig(good, SHARE).ok, true);
    assert.equal(checkConfig({ ...good, width: 2560, height: 1440 }, SHARE).ok, true, 'revision 2: up to 2560 x 1440');
    assert.equal(checkConfig({ ...good, width: 16, height: 16, fps: 1 }, SHARE).ok, true, 'the smallest values');
    assert.equal(checkConfig({ ...good, fps: undefined }, SHARE).ok, true, 'fps is information and can be absent');
    assert.equal(checkConfig({ ...good, codec: 'vp9' }, SHARE).reason, 'codec');
    assert.equal(checkConfig({ ...good, codec: 'h264' }, SHARE).reason, 'codec');
    assert.equal(checkConfig({ ...good, width: 15 }, SHARE).reason, 'width');
    assert.equal(checkConfig({ ...good, width: 2561 }, SHARE).reason, 'width');
    assert.equal(checkConfig({ ...good, width: 1280.5 }, SHARE).reason, 'width');
    assert.equal(checkConfig({ ...good, height: 1441 }, SHARE).reason, 'height');
    assert.equal(checkConfig({ ...good, height: 15 }, SHARE).reason, 'height');
    assert.equal(checkConfig({ ...good, fps: 0 }, SHARE).reason, 'fps');
    assert.equal(checkConfig({ ...good, fps: 61 }, SHARE).reason, 'fps');
    assert.equal(checkConfig({ ...good, shareId: '00000000-0000-4000-8000-000000000000' }, SHARE).reason, 'share', 'not the ID of the screen line');
    assert.equal(checkConfig(null, SHARE).ok, false);
});

test('W5 check 3: a delta frame after a gap does not go to the decoder, and two gaps in 2 s give one KEYREQ', () => {
    const { createFrameGate } = load();
    let t = 0;
    const gate = createFrameGate({ now: () => t, keyRequestMs: 2000 });
    // The first frame after CONFIG must be a keyframe.
    assert.deepEqual({ ...gate.frame(0, false) }, { decode: false, keyRequest: true }, 'a delta frame as the first frame');
    assert.deepEqual({ ...gate.frame(1, true) }, { decode: true, keyRequest: false });
    assert.equal(gate.frame(2, false).decode, true);
    assert.equal(gate.frame(3, false).decode, true);
    // A gap (4 is missing).
    t = 2500;
    assert.deepEqual({ ...gate.frame(5, false) }, { decode: false, keyRequest: true });
    assert.deepEqual({ ...gate.frame(6, false) }, { decode: false, keyRequest: false }, 'no frame until the keyframe');
    assert.equal(gate.frame(7, true).decode, true);
    // A second gap in the same 2 s: no second KEYREQ.
    t = 3000;
    assert.deepEqual({ ...gate.frame(9, false) }, { decode: false, keyRequest: false });
    t = 4600;
    assert.deepEqual({ ...gate.frame(10, false) }, { decode: false, keyRequest: true }, 'after 2 s a new KEYREQ');
    assert.equal(gate.frame(11, true).decode, true);
    // The numbers wrap at 2^32 with no gap.
    assert.equal(gate.frame(12, false).decode, true);
    const wrap = createFrameGate({ now: () => 0 });
    assert.equal(wrap.frame(0xffffffff, true).decode, true);
    assert.equal(wrap.frame(0, false).decode, true, 'modulo 2^32');
    // A new CONFIG needs a keyframe again.
    gate.config();
    assert.equal(gate.frame(13, false).decode, false);
    assert.equal(gate.frame(14, true).decode, true);
});
