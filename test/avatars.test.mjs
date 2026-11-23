// Profile pictures of the app (src/application/avatars.mjs): the own picture, the cache by device, the limits, the
// fallback to the letter and the rule that the main process does not decode a picture (a fake decoder window does
// the work). Electron does not start. All results of this file are results on this PC (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { createAvatars, inspectAvatar, CACHE_MAX_FILES, OWN_CHANGES_PER_MINUTE } from '../src/application/avatars.mjs';
import { avatarHash, AVATAR_MAX_BYTES } from '../src/network/avatar.mjs';
import { redact } from '../src/application/journal.mjs';

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
    return Buffer.concat([head, data, crc]);
}
// A PNG of one color (the bytes of a real PNG; nothing decodes it here).
export function makePng(w, h, seed = 0) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) row.writeUInt32BE((((seed * 2654435761) >>> 0) | 255) >>> 0, 1 + x * 4);
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The decoder window of the test. It records each job. show: the answer for 'avatar-show' (default: good).
function fakeDecoder({ show = 'good', crop = null } = {}) {
    const jobs = [];
    let seed = 1;
    const decode = async (info, limit, job = null) => {
        jobs.push({ width: info.width, height: info.height, limit, job });
        if (job?.mode === 'avatar') return crop ?? makePng(128, 128, ++seed);
        if (job?.mode === 'avatar-show') {
            if (show !== 'good') return null;
            return Buffer.concat([Buffer.alloc(128 * 128 * 4, 7), makePng(128, 128, 999)]);
        }
        return makePng(64, 48, 5); // the preview of the dialog
    };
    return { jobs, decode };
}

function setup(t, options = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-avatars-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let clock = 1_000_000;
    const journal = [];
    const decoder = options.decoder ?? fakeDecoder();
    const make = () => createAvatars({ dir, decode: decoder.decode, journal: (type, fields) => journal.push(redact(type, fields)),
        now: () => clock });
    return { dir, decoder, journal, make, avatars: make(), tick: ms => { clock += ms; } };
}

function fakeNode(devices = {}) {
    const requests = [];
    return { events: new EventEmitter(), requests, deviceOf: peerId => devices[peerId] ?? null,
        requestAvatar: (peerId, hash) => { requests.push({ peerId, hash }); return 'sent'; } };
}

test('avatars: the own picture is made by the decoder window, kept in the data folder and given to the hub', async t => {
    const s = setup(t);
    const source = path.join(s.dir, 'me.gif');
    // A GIF89a of 300 x 200 with one frame (its geometry only is read here).
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([44, 1, 200, 0, 0, 0, 0]),
        Buffer.from([44, 0, 0, 0, 0, 44, 1, 200, 0, 0, 2, 2, 68, 1, 0]), Buffer.from([59])]);
    writeFileSync(source, gif);
    const picked = await s.avatars.choose(source);
    assert.equal(s.decoder.jobs[0].job, null, 'the preview job');
    assert.deepEqual([s.decoder.jobs[0].width, s.decoder.jobs[0].height], [300, 200]);
    assert.deepEqual([picked.width, picked.height], [64, 48]);
    const crop = { x: 0.1, y: 0, w: 2 / 3, h: 1 };
    const view = await s.avatars.setOwn(picked.token, crop);
    assert.deepEqual(s.decoder.jobs[1].job, { mode: 'avatar', crop });
    assert.equal(s.decoder.jobs[1].limit, AVATAR_MAX_BYTES);
    assert.equal(s.decoder.jobs[2].job.mode, 'avatar-show');
    const own = readFileSync(path.join(s.dir, 'own.img'));
    assert.equal(view.self, avatarHash(own));
    assert.equal(s.avatars.hub.own().hash, view.self);
    assert.ok(s.journal.some(e => e.type === 'avatar' && e.event === 'set' && e.result === 'ok' && e.bytes === own.length));
    // A restart keeps it.
    assert.equal(s.make().hub.own().hash, view.self);
    // The served PNG is the checked output of the decoder.
    const res = await s.avatars.serve({ url: `asscrack-app://app/avatar/${view.self}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    // Remove.
    const removed = s.avatars.removeOwn();
    assert.equal(removed.self, null);
    assert.equal(existsSync(path.join(s.dir, 'own.img')), false);
    assert.ok(s.journal.some(e => e.type === 'avatar' && e.event === 'removed'));
    for (const e of s.journal) assert.deepEqual(Object.keys(e).filter(k => !['type', 'event', 'result', 'bytes', 'peer'].includes(k)), []);
})

test('avatars: a bad file or a bad decoder result gives an error and no picture', async t => {
    const s = setup(t, { decoder: fakeDecoder({ crop: makePng(100, 100, 3) }) });
    const text = path.join(s.dir, 'x.png');
    writeFileSync(text, 'not a picture at all, just text bytes');
    await assert.rejects(s.avatars.choose(text), /Can't open this picture/);
    await assert.rejects(s.avatars.choose(path.join(s.dir, 'x.txt')), /Pick a PNG/);
    const png = path.join(s.dir, 'y.png');
    writeFileSync(png, makePng(400, 400, 2));
    const picked = await s.avatars.choose(png);
    // The decoder gave a 100 x 100 picture: not 128 x 128.
    await assert.rejects(s.avatars.setOwn(picked.token, { x: 0, y: 0, w: 1, h: 1 }), /Can't use this picture/);
    assert.equal(s.avatars.view().self, null);
    await assert.rejects(s.avatars.setOwn('other', { x: 0, y: 0, w: 1, h: 1 }), /Pick the picture again/);
})

test('avatars: at most OWN_CHANGES_PER_MINUTE own changes in one minute', async t => {
    const s = setup(t);
    const png = path.join(s.dir, 'y.png');
    writeFileSync(png, makePng(200, 200, 2));
    for (let i = 0; i < OWN_CHANGES_PER_MINUTE; i++) {
        const picked = await s.avatars.choose(png);
        await s.avatars.setOwn(picked.token, { x: 0, y: 0, w: 1, h: 1 });
    }
    const picked = await s.avatars.choose(png);
    await assert.rejects(s.avatars.setOwn(picked.token, { x: 0, y: 0, w: 1, h: 1 }), /Too many changes/);
    s.tick(60000);
    await s.avatars.setOwn(picked.token, { x: 0, y: 0, w: 1, h: 1 });
})

test('avatars: an announce of a hash that is not in the cache fetches it; a cached hash does not', async t => {
    const s = setup(t);
    const node = fakeNode({ P1: 'D'.repeat(43) });
    s.avatars.attach(node);
    const picture = makePng(128, 128, 11);
    const hash = avatarHash(picture);
    node.events.emit('avatar', { peerId: 'P1', hash });
    assert.deepEqual(node.requests, [{ peerId: 'P1', hash }]);
    assert.deepEqual(s.avatars.view().peers, {}, 'no picture before the bytes');
    node.events.emit('avatar-data', { peerId: 'P1', hash, bytes: picture });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(s.avatars.view().peers, { P1: hash });
    assert.deepEqual(s.avatars.view().devices, { ['D'.repeat(43)]: hash });
    // A second peer with the same picture: no fetch.
    node.events.emit('avatar', { peerId: 'P2', hash });
    assert.equal(node.requests.length, 1);
    assert.ok(s.journal.some(e => e.type === 'avatar' && e.event === 'fetch' && e.result === 'ok'));
})

test('avatars: the cache is keyed by device, survives a restart and a new peer ID', async t => {
    const s = setup(t);
    const device = 'E'.repeat(43);
    const picture = makePng(128, 128, 12);
    const hash = avatarHash(picture);
    const first = fakeNode({ OLD: device });
    s.avatars.attach(first);
    first.events.emit('avatar', { peerId: 'OLD', hash });
    assert.equal(await s.avatars.received(hash, picture), true);
    // Restart: a new module on the same folder, the same device with a new peer ID. No fetch, the picture is there.
    const again = s.make();
    assert.equal(again.view().devices[device], hash);
    assert.equal(again.deviceHash(device), hash);
    const node = fakeNode({ NEW: device });
    again.attach(node);
    node.events.emit('avatar', { peerId: 'NEW', hash });
    assert.deepEqual(node.requests, []);
    assert.equal(again.view().peers.NEW, hash);
    const res = await again.serve({ url: `asscrack-app://app/avatar/${hash}` });
    assert.equal(res.status, 200);
    // The removal of the picture on the peer side: hash null removes the device row.
    node.events.emit('avatar', { peerId: 'NEW', hash: null });
    assert.equal(again.view().peers.NEW, undefined);
    assert.equal(again.deviceHash(device), null);
})

test('avatars: the cache keeps at most CACHE_MAX_FILES pictures and removes the oldest', async t => {
    const s = setup(t);
    const hashes = [];
    for (let i = 0; i < CACHE_MAX_FILES + 3; i++) {
        const picture = makePng(128, 128, 100 + i);
        hashes.push(avatarHash(picture));
        assert.equal(await s.avatars.received(hashes[i], picture), true);
        s.tick(1);
    }
    assert.equal(s.avatars.cacheStats().files, CACHE_MAX_FILES);
    assert.equal(readdirSync(path.join(s.dir, 'cache')).filter(n => !n.endsWith('.tmp')).length, CACHE_MAX_FILES);
    assert.equal(existsSync(path.join(s.dir, 'cache', hashes[0])), false, 'the oldest is gone');
    assert.equal(existsSync(path.join(s.dir, 'cache', hashes.at(-1))), true);
})

test('avatars: a bad picture of a peer falls back to the letter and is not fetched again', async t => {
    const s = setup(t, { decoder: fakeDecoder({ show: 'bad' }) });
    const node = fakeNode({ P: 'F'.repeat(43) });
    s.avatars.attach(node);
    // Bytes that pass the hash but fail the decoder.
    const picture = makePng(128, 128, 13);
    const hash = avatarHash(picture);
    node.events.emit('avatar', { peerId: 'P', hash });
    node.events.emit('avatar-data', { peerId: 'P', hash, bytes: picture });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(s.avatars.view().peers, {});
    assert.ok(s.journal.some(e => e.type === 'avatar' && e.event === 'fetch' && e.result === 'bad'));
    node.events.emit('avatar', { peerId: 'P', hash: null });
    node.events.emit('avatar', { peerId: 'P', hash });
    assert.equal(node.requests.length, 1, 'no second fetch of a bad hash');
    const res = await s.avatars.serve({ url: `asscrack-app://app/avatar/${hash}` });
    assert.equal(res.status, 404);
    // Bytes that are not 128 x 128, or too large: refused before the decoder.
    const jobs = s.decoder.jobs.length;
    assert.equal(await s.avatars.received(avatarHash(makePng(64, 64)), makePng(64, 64)), false);
    assert.equal(s.decoder.jobs.length, jobs);
    assert.equal(inspectAvatar(Buffer.alloc(AVATAR_MAX_BYTES + 1)), null);
})

test('avatars: the main process code of the pictures does not decode (no nativeImage, no createImageBitmap)', () => {
    for (const file of ['../src/application/avatars.mjs', '../src/network/avatar.mjs']) {
        const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/nativeImage|createImageBitmap|createFromBuffer|createFromPath|from 'electron'/.test(source), file);
    }
    const main = readFileSync(new URL('../src/application/main.js', import.meta.url), 'utf8');
    // The notification icon is made from the bitmap pixels of the decoder window (no decode in main).
    const lines = main.split('\n').filter(l => /avatar/i.test(l) && /nativeImage\./.test(l));
    for (const line of lines) assert.match(line, /createFromBitmap/, line);
})

test('avatars window: the crop of the dialog stays inside the picture and gives a square part', async () => {
    const vm = await import('node:vm');
    const window = {};
    vm.runInNewContext(readFileSync(new URL('../src/application/avatars-ui.js', import.meta.url), 'utf8'), { window });
    const { crop, deviceOfMessage } = window.avatarsCore;
    // 400 x 200 at zoom 1: the square covers the full height, half of the width.
    const r = crop(400, 200, 1, -50, 0, 200);
    assert.deepEqual({ ...r.crop }, { x: 0.125, y: 0, w: 0.5, h: 1 });
    // An offset out of the picture is clamped; zoom over 4 is 4.
    const far = crop(400, 200, 9, 500, -5000, 200);
    assert.equal(far.ox, 0);
    assert.equal(far.oy, 200 - far.H);
    assert.ok(Math.abs(far.crop.w * 400 * (far.W / 400) - 200) < 1e-9);
    assert.ok(far.crop.y + far.crop.h <= 1 + 1e-9);
    // The chat line of a protected room: the device ID is the start of the message ID.
    assert.equal(deviceOfMessage(`${'A'.repeat(43)}.abc`), 'A'.repeat(43));
    assert.equal(deviceOfMessage('no-device'), null);
})
