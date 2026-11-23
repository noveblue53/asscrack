// Profile pictures (1.0.6). This module does not import electron (node tests use it).
//
// The own picture: the user picks a PNG, JPEG, WebP or GIF (the first frame). The sandboxed decoder window of L7
// (image-decoder.mjs) makes a preview for the crop dialog, and then the 128 x 128 picture (WebP, else PNG) of at most
// AVATAR_MAX_BYTES. The main process reads only the headers (inspectImage, inspectGif). It never decodes picture bytes.
//
// Storage: the profile folder (the data folder of the app), not the encrypted archive:
//   <data>/avatars/own.img      the own picture (the bytes that the peers get)
//   <data>/avatars/cache/<hash> the pictures of other people, by SHA-256
//   <data>/avatars/index.json   device -> hash (also after a restart and with a new peer ID), file -> size and last use
// The cache keeps at most CACHE_MAX_FILES files and CACHE_MAX_BYTES bytes. The least recently used file goes first.
//
// The peers: the nodes get the hub (avatar.mjs). A node announces the hash; a miss asks the peer for the bytes. A picture
// of a peer gets the header check, then the decoder; a bad picture goes on the bad list and the window keeps the letter.
// The window gets only hashes. It loads asscrack-app://app/avatar/<hash>: a PNG that the decoder made and that
// inspectImage checked with the wire rules.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectGif, inspectImage, IMAGE_INPUT_LIMIT, PREVIEW_LIMIT } from './media-formats.mjs';
import { AVATAR_MAX_BYTES, avatarHash, validAvatarHash } from '../network/avatar.mjs';

export { AVATAR_MAX_BYTES };
export const AVATAR_SIDE = 128;
export const CACHE_MAX_FILES = 200;
export const CACHE_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_DEVICES = 1000;
// Own changes (set or remove) in one minute.
export const OWN_CHANGES_PER_MINUTE = 6;
const PIXEL_BYTES = AVATAR_SIDE * AVATAR_SIDE * 4;
const SHOWN_MAX = 64;
const BAD_MAX = 256;
const PICK_EXT = /\.(png|jpe?g|webp|gif)$/i;

// The header check of a picture from the wire or from the disk (no decode): a 128 x 128 PNG or WebP of at most
// AVATAR_MAX_BYTES. Gives { bytes, width, height } for the decoder, or null.
export function inspectAvatar(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > AVATAR_MAX_BYTES) return null;
    const info = inspectImage(bytes);
    if (!info || !['image/png', 'image/webp'].includes(info.mime)) return null;
    if (info.width !== AVATAR_SIDE || info.height !== AVATAR_SIDE) return null;
    return { bytes: info.bytes, width: info.width, height: info.height };
}

// The geometry of a picked file (no decode): PNG, JPEG, WebP or GIF.
export function inspectPick(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 14 || bytes.length > IMAGE_INPUT_LIMIT) return null;
    if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
        const gif = inspectGif(bytes);
        return gif ? { bytes, width: gif.width, height: gif.height } : null;
    }
    const info = inspectImage(bytes);
    return info ? { bytes, width: info.width, height: info.height } : null;
}

// The crop of the dialog: a square part of the picture, in parts of 1 of the width and the height.
export function validCrop(crop) {
    if (!crop || typeof crop !== 'object') return null;
    const out = {};
    for (const key of ['x', 'y', 'w', 'h']) {
        const v = crop[key];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null;
        out[key] = v;
    }
    if (out.w <= 0 || out.h <= 0 || out.x + out.w > 1.0001 || out.y + out.h > 1.0001) return null;
    return out;
}

// dir: <data>/avatars. decode(info, limit, job): the decoder window (image-decoder.mjs). journal(type, fields): the
// diagnostics journal (no picture data). changed(): the view changed.
export function createAvatars({ dir, decode, journal = () => {}, log = () => {}, changed = () => {}, now = Date.now,
    fsApi = fs } = {}) {
    const cacheDir = path.join(dir, 'cache');
    const ownFile = path.join(dir, 'own.img');
    const indexFile = path.join(dir, 'index.json');
    const subscribers = new Set();
    const shown = new Map(); // hash -> { png, pixels } (least recently used first)
    const decoding = new Map(); // hash -> Promise
    const bad = new Set(); // hashes that failed a check
    const attached = new Set(); // { node, peers: Map(peerId -> key) }
    const changes = [];
    let own = null; // { hash, bytes }
    let pick = null; // { token, info, preview }
    let index = { v: 1, devices: {}, files: {} };

    const mkdir = d => { try { fsApi.mkdirSync(d, { recursive: true }); } catch { /* the write fails later */ } };
    function writeAtomic(file, bytes) {
        mkdir(path.dirname(file));
        const temp = `${file}.${process.pid}.tmp`;
        fsApi.writeFileSync(temp, bytes);
        fsApi.renameSync(temp, file);
    }
    function saveIndex() {
        try { writeAtomic(indexFile, JSON.stringify(index)); } catch (err) { log('WARN', `Picture index not saved: ${err?.message ?? err}`); }
    }
    function loadIndex() {
        try {
            const value = JSON.parse(fsApi.readFileSync(indexFile, 'utf8'));
            const devices = {}, files = {};
            for (const [key, row] of Object.entries(value?.devices ?? {})) {
                if (typeof key === 'string' && key.length <= 128 && validAvatarHash(row?.hash) && Number.isFinite(row?.at)) devices[key] = { hash: row.hash, at: row.at };
            }
            for (const [hash, row] of Object.entries(value?.files ?? {})) {
                if (validAvatarHash(hash) && Number.isSafeInteger(row?.size) && row.size > 0 && row.size <= AVATAR_MAX_BYTES &&
                    Number.isFinite(row?.used)) files[hash] = { size: row.size, used: row.used };
            }
            index = { v: 1, devices, files };
        } catch { index = { v: 1, devices: {}, files: {} }; }
    }
    function loadOwn() {
        try {
            const bytes = fsApi.readFileSync(ownFile);
            if (inspectAvatar(bytes)) own = { hash: avatarHash(bytes), bytes };
        } catch { own = null; }
    }
    loadIndex();
    loadOwn();

    const cacheFile = hash => path.join(cacheDir, hash);
    const hasFile = hash => Object.hasOwn(index.files, hash);
    function markBad(hash) {
        if (bad.size >= BAD_MAX) bad.delete(bad.values().next().value);
        bad.add(hash);
        shown.delete(hash);
    }

    // Remove the least recently used files over the limits. The hash of a device stays: a new announce fetches again.
    function prune() {
        const rows = Object.entries(index.files).sort((a, b) => a[1].used - b[1].used);
        let total = rows.reduce((sum, [, row]) => sum + row.size, 0);
        let count = rows.length;
        for (const [hash, row] of rows) {
            if (count <= CACHE_MAX_FILES && total <= CACHE_MAX_BYTES) break;
            try { fsApi.rmSync(cacheFile(hash), { force: true }); } catch { /* removed later */ }
            delete index.files[hash];
            shown.delete(hash);
            total -= row.size;
            count--;
        }
        const devices = Object.entries(index.devices);
        if (devices.length > MAX_DEVICES) {
            devices.sort((a, b) => a[1].at - b[1].at);
            for (const [key] of devices.slice(0, devices.length - MAX_DEVICES)) delete index.devices[key];
        }
    }

    // The decoder makes the bitmap pixels and the PNG of a checked picture. Gives { png, pixels } or null.
    async function show(hash, bytes) {
        const info = inspectAvatar(bytes);
        if (!info) return null;
        let out = null;
        try { out = await decode(info, PREVIEW_LIMIT, { mode: 'avatar-show' }); } catch { out = null; }
        if (!out?.length || out.length <= PIXEL_BYTES) return null;
        const buffer = Buffer.from(out);
        const pixels = buffer.subarray(0, PIXEL_BYTES);
        const png = inspectImage(buffer.subarray(PIXEL_BYTES), true);
        if (!png || png.width !== AVATAR_SIDE || png.height !== AVATAR_SIDE) return null;
        const entry = { png: png.bytes, pixels: Buffer.from(pixels) };
        shown.delete(hash);
        shown.set(hash, entry);
        while (shown.size > SHOWN_MAX) shown.delete(shown.keys().next().value);
        return entry;
    }

    function bytesOf(hash) {
        if (own?.hash === hash) return own.bytes;
        if (!hasFile(hash)) return null;
        try {
            const bytes = fsApi.readFileSync(cacheFile(hash));
            if (avatarHash(bytes) === hash) return bytes;
        } catch { /* a missing file */ }
        delete index.files[hash];
        return null;
    }

    // The shown form of a hash: from memory, else the disk and the decoder. Gives { png, pixels } or null.
    function shownOf(hash) {
        if (!validAvatarHash(hash) || bad.has(hash)) return Promise.resolve(null);
        const entry = shown.get(hash);
        if (entry) { shown.delete(hash); shown.set(hash, entry); return Promise.resolve(entry); }
        if (decoding.has(hash)) return decoding.get(hash);
        const bytes = bytesOf(hash);
        if (!bytes) return Promise.resolve(null);
        const job = show(hash, bytes).then(result => {
            if (!result) { markBad(hash); changed(); }
            return result;
        }).finally(() => decoding.delete(hash));
        decoding.set(hash, job);
        return job;
    }

    const good = hash => validAvatarHash(hash) && !bad.has(hash) && (own?.hash === hash || hasFile(hash));

    function setDevice(key, hash) {
        if (!key) return;
        const old = index.devices[key]?.hash ?? null;
        if (hash) index.devices[key] = { hash, at: now() };
        else delete index.devices[key];
        if (old !== hash) saveIndex();
    }

    function keyOf(node, peerId) {
        let device = null;
        try { device = node.deviceOf?.(peerId) ?? null; } catch { device = null; }
        return device ? device : `peer:${peerId}`;
    }

    // A picture from a peer (the bytes matched the hash in avatar.mjs). Gives true when the cache took it.
    async function received(hash, bytes) {
        if (!validAvatarHash(hash) || bad.has(hash)) return false;
        if (hasFile(hash)) return true;
        const buffer = Buffer.from(bytes);
        if (avatarHash(buffer) !== hash || !(await show(hash, buffer))) { markBad(hash); return false; }
        try { writeAtomic(cacheFile(hash), buffer); }
        catch (err) { log('WARN', `Picture not saved: ${err?.message ?? err}`); return false; }
        index.files[hash] = { size: buffer.length, used: now() };
        prune();
        saveIndex();
        return true;
    }

    function fetchMiss(node, peerId, hash) {
        if (!hash || bad.has(hash) || hasFile(hash) || own?.hash === hash) return;
        const result = node.requestAvatar?.(peerId, hash) ?? 'no';
        journal('avatar', { event: 'fetch', result, peer: peerId });
    }

    // A node of the app: the room node, or the node of a friend link. Gives detach().
    function attach(node) {
        const row = { node, peers: new Map() };
        attached.add(row);
        const onAnnounce = ({ peerId, hash }) => {
            const key = keyOf(node, peerId);
            row.peers.set(peerId, key);
            setDevice(key, hash);
            if (hash && hasFile(hash)) { index.files[hash].used = now(); }
            fetchMiss(node, peerId, hash);
            changed();
        };
        const onData = ({ peerId, hash, bytes }) => {
            void received(hash, bytes).then(ok => {
                journal('avatar', { event: 'fetch', result: ok ? 'ok' : 'bad', bytes: bytes?.length ?? 0, peer: peerId });
                if (!ok) log('WARN', 'A profile picture of a peer was not valid. The letter stays.');
                changed();
            });
        };
        const onFailed = ({ peerId, reason }) => journal('avatar', { event: 'fetch', result: reason, peer: peerId });
        const onLeft = ({ peerId }) => { if (row.peers.delete(peerId)) changed(); };
        node.events.on('avatar', onAnnounce);
        node.events.on('avatar-data', onData);
        node.events.on('avatar-failed', onFailed);
        node.events.on('peer-left', onLeft);
        let done = false;
        return function detach() {
            if (done) return;
            done = true;
            node.events.off('avatar', onAnnounce);
            node.events.off('avatar-data', onData);
            node.events.off('avatar-failed', onFailed);
            node.events.off('peer-left', onLeft);
            attached.delete(row);
            if (row.peers.size) changed();
        };
    }

    function allowChange() {
        const t = now();
        while (changes.length && t - changes[0] >= 60000) changes.shift();
        if (changes.length >= OWN_CHANGES_PER_MINUTE) return false;
        changes.push(t);
        return true;
    }
    function ownChanged() {
        for (const fn of subscribers) { try { fn(); } catch { /* a stopped node */ } }
        changed();
    }

    // The file of the pick dialog. Gives { token, width, height } of the preview, or throws.
    async function choose(file) {
        if (typeof file !== 'string' || !PICK_EXT.test(file)) throw new Error('Pick a PNG, JPEG, WebP or GIF file.');
        let bytes;
        try {
            const st = fsApi.statSync(file);
            if (!st.isFile() || st.size < 1 || st.size > IMAGE_INPUT_LIMIT) throw new Error('size');
            bytes = fsApi.readFileSync(file);
        } catch { throw new Error('Can\'t open this picture.'); }
        const info = inspectPick(bytes);
        if (!info) throw new Error('Can\'t open this picture.');
        let out = null;
        try { out = await decode(info, PREVIEW_LIMIT); } catch { out = null; }
        const preview = out?.length ? inspectImage(Buffer.from(out), true) : null;
        if (!preview) throw new Error('Can\'t open this picture.');
        pick = { token: randomUUID(), info, preview: preview.bytes };
        return { token: pick.token, width: preview.width, height: preview.height };
    }

    // Make the own picture from the pick and the crop. Gives the view.
    async function setOwn(token, crop) {
        const part = validCrop(crop);
        if (!pick || pick.token !== token || !part) throw new Error('Pick the picture again.');
        if (!allowChange()) throw new Error('Too many changes. Try again in a minute.');
        let out = null;
        try { out = await decode(pick.info, AVATAR_MAX_BYTES, { mode: 'avatar', crop: part }); } catch { out = null; }
        const bytes = out?.length ? Buffer.from(out) : null;
        const hash = bytes && inspectAvatar(bytes) ? avatarHash(bytes) : null;
        if (!hash || !(await show(hash, bytes))) {
            journal('avatar', { event: 'set', result: 'failed' });
            throw new Error('Can\'t use this picture.');
        }
        writeAtomic(ownFile, bytes);
        own = { hash, bytes };
        pick = null;
        journal('avatar', { event: 'set', result: 'ok', bytes: bytes.length });
        log('EVENT', `Profile picture set (${bytes.length} bytes)`);
        ownChanged();
        return view();
    }

    function removeOwn() {
        if (!own) return view();
        if (!allowChange()) throw new Error('Too many changes. Try again in a minute.');
        try { fsApi.rmSync(ownFile, { force: true }); } catch (err) { throw new Error(`Can't remove the picture: ${err?.message ?? err}`); }
        own = null;
        journal('avatar', { event: 'removed' });
        log('EVENT', 'Profile picture removed');
        ownChanged();
        return view();
    }

    // The view of the window: only hashes that passed the checks (a bad one gives the letter).
    function view() {
        const peers = {};
        for (const row of attached) {
            for (const [peerId, key] of row.peers) {
                const hash = index.devices[key]?.hash;
                if (good(hash)) peers[peerId] = hash;
            }
        }
        const devices = {};
        for (const [key, row] of Object.entries(index.devices)) if (!key.startsWith('peer:') && good(row.hash)) devices[key] = row.hash;
        return { self: own?.hash ?? null, peers, devices };
    }

    const deviceHash = deviceId => {
        const hash = typeof deviceId === 'string' ? index.devices[deviceId]?.hash : null;
        return good(hash) ? hash : null;
    };

    // The route of the app scheme: /avatar/<hash> (a picture) and /avatar-pick/<token> (the preview of the dialog).
    // Gives null for another path, else a Promise of a Response.
    function serve(request) {
        let url;
        try { url = new URL(request.url); } catch { return null; }
        const match = /^\/(avatar|avatar-pick)\/([0-9a-f-]{36,64})$/.exec(url.pathname);
        if (!match) return null;
        const headers = { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
        if (match[1] === 'avatar-pick') {
            if (!pick || pick.token !== match[2]) return Promise.resolve(new Response(null, { status: 404 }));
            return Promise.resolve(new Response(pick.preview, { status: 200, headers }));
        }
        return shownOf(match[2]).then(entry => (entry
            ? new Response(entry.png, { status: 200, headers: { ...headers, 'Cache-Control': 'max-age=31536000, immutable' } })
            : new Response(null, { status: 404 })));
    }

    return {
        // The hub of the nodes (avatar.mjs).
        hub: {
            own: () => own,
            subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
        },
        attach, choose, setOwn, removeOwn, view, deviceHash, serve, received,
        // The bitmap pixels (BGRA, 128 x 128) of a hash for a notification icon, when the decoder made them before.
        // A miss starts the decode for the next time.
        pixels(hash) {
            if (!good(hash)) return null;
            const entry = shown.get(hash);
            if (!entry) { void shownOf(hash); return null; }
            return entry.pixels;
        },
        cacheStats: () => ({ files: Object.keys(index.files).length,
            bytes: Object.values(index.files).reduce((sum, row) => sum + row.size, 0) })
    };
}
