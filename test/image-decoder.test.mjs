// L7 (P10a): the main process must not decode peer images. room-media gives the bytes to a decoder outside the main
// process (a hidden sandboxed window, image-decoder.mjs) and only checks the PNG that comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { createRoomMedia } from '../src/application/room-media.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQCdjyHwADrAIYvvruLQAAAABJRU5ErkJggg==', 'base64');
function sized(w, h) {
    const data = Buffer.from(png); data.writeUInt32BE(w, 16); data.writeUInt32BE(h, 20);
    data.writeUInt32BE(crc32(data.subarray(12, 29)), 29);
    return data;
}
const descriptor = bytes => ({ id: '31e69ba1-2dbc-416a-ae60-727092a82188', source: 'publisher', kind: 'image', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
// A main-process decoder that must not run.
const forbidden = () => { let calls = 0; return { get calls() { return calls; }, createFromBuffer() { calls++; throw new Error('main-process decode'); } }; };

test('a peer preview goes to the outside decoder, and the main process does not decode it', async () => {
    const nativeImage = forbidden();
    const jobs = [];
    const media = createRoomMedia({ nativeImage, decodeImage: async (info, limit) => { jobs.push({ info, limit }); return png; } });
    const d = descriptor(png);
    assert.equal(await media.storePreview(d, png), true);
    assert.equal(nativeImage.calls, 0);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].info.width, 1);
    assert.ok(media.info(d.id).thumbnailUrl);
});

test('a decoder result that is not a valid preview PNG is refused', async () => {
    for (const out of [Buffer.from('not a png at all, not a png at all'), sized(1025, 1), sized(1001, 1000), null]) {
        const media = createRoomMedia({ nativeImage: forbidden(), decodeImage: async () => out });
        assert.equal(await media.storePreview(descriptor(png), png), false);
    }
});

function fakeElectron() {
    const ipc = new EventEmitter();
    const windows = [];
    class Win extends EventEmitter {
        constructor(options) {
            super(); this.options = options; this.destroyed = false; windows.push(this);
            this.webContents = Object.assign(new EventEmitter(), { sent: [], send: (...args) => this.webContents.sent.push(args),
                mainFrame: {} });
        }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; this.emit('closed'); }
        async loadURL(url) { this.url = url; }
    }
    return { ipc, windows, Win };
}

test('the decoder window is sandboxed, accepts a result only from its own frame, and times out', async () => {
    const { createImageDecoder } = await import('../src/application/image-decoder.mjs');
    const { ipc, windows, Win } = fakeElectron();
    const timers = [];
    const decoder = createImageDecoder({ BrowserWindow: Win, ipc, page: 'asscrack-app://app/image-decoder.html', preload: 'p.cjs',
        isFrame: (win, event) => event.sender === win.webContents, timeoutMs: 1000, idleMs: 5000,
        setTimer: (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; }, clearTimer: t => { if (t) t.on = false; } });
    const pending = decoder.decode({ bytes: png, width: 1, height: 1 }, 65536);
    await new Promise(r => setImmediate(r));
    assert.equal(windows.length, 1);
    const [win] = windows;
    assert.equal(win.url, 'asscrack-app://app/image-decoder.html');
    const prefs = win.options.webPreferences;
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    assert.equal(win.options.show, false);
    const [channel, id, bytes, size] = win.webContents.sent[0];
    assert.equal(channel, 'asscrack:image-decode');
    assert.deepEqual(Buffer.from(bytes), png);
    assert.deepEqual(size, { width: 1, height: 1, limit: 65536 });
    ipc.emit('asscrack:image-decoded', { sender: {} }, id, new Uint8Array([1, 2, 3]));
    ipc.emit('asscrack:image-decoded', { sender: win.webContents }, id, new Uint8Array(png));
    assert.deepEqual(await pending, png);
    // A job with no answer ends with null at the timeout, and the window closes.
    const slow = decoder.decode({ bytes: png, width: 1, height: 1 }, 65536);
    await new Promise(r => setImmediate(r));
    timers.filter(t => t.on && t.ms === 1000).at(-1).fn();
    assert.equal(await slow, null);
    assert.equal(win.destroyed, true);
    decoder.dispose();
    assert.equal(await decoder.decode({ bytes: png, width: 1, height: 1 }, 65536), null);
});
