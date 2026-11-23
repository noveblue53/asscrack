// History thumbnails after a quit or a room reopen (operator report 2026-11-23, 1.0.3: "upon re-opening Crackers Unite,
// i cant see picture thumbnails anymore. show thumbnail does nothing").
// - The cause: the thumbnail of a card was only in the memory cache of room-media.mjs, and the sender kept its preview
//   source only in memory for 30 minutes. After a quit, no copy could show the thumbnail, and the "Show thumbnail"
//   click changed nothing in the window.
// - Now the checked PNG of an archived image card stays in the encrypted room archive (message_thumbnails), the sender
//   gives its stored thumbnail of an own post after a restart, and the window says why a thumbnail is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRoomArchive, THUMBNAIL_LIMITS } from '../src/application/room-archive.mjs';
import { createRoomMedia } from '../src/application/room-media.mjs';
import { createAttachments } from '../src/network/attachment.mjs';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQCdjyHwADrAIYvvruLQAAAABJRU5ErkJggg==', 'base64');
const SENDER = '12D3KooWQywidz6ZPBn4JkDYuVmkyMrteYfnWbxtDt6HoK1pRQ1N';
const SELF = '12D3KooWCksvcsuzM6xHeV5BNVr593yb3FTZC7n7hUQNUm3pwW7N';
const KEY = Buffer.alloc(32, 7);

function protector() {
    return { available: () => true, wrap: b => Buffer.concat([Buffer.from('t:'), b]), unwrap: b => Buffer.from(b.subarray(2)) };
}
function descriptor(over = {}) {
    return { id: randomUUID(), source: SENDER, sha256: 'a'.repeat(64), size: 42133, kind: 'image', name: 'cat.jpg',
        expires: Date.now() - 60 * 60 * 1000, ...over };
}
// The store of main.js (saved-rooms.mjs) for one open room.
const storeOf = (archive, roomId) => ({
    save: (d, bytes) => archive.rememberThumbnail(roomId, d, bytes),
    load: d => archive.getThumbnail(roomId, d)
});

test('a thumbnail of an archived image card is shown again after a quit (a new archive and media cache)', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-thumbs-'));
    const d = descriptor();
    let archive = openRoomArchive({ dir, protector: protector() });
    const { roomId } = archive.saveRoom({ name: 'Crackers Unite', roomKey: KEY, keepHistory: true });
    archive.addMessage(roomId, { id: 'm1', text: 'cat.jpg (42133 bytes)', time: 1, source: 'live', peerId: SENDER, attachment: d });
    const before = createRoomMedia({ decodeImage: async () => png, store: storeOf(archive, roomId) });
    assert.equal(await before.storePreview(d, png), true);
    assert.ok(before.info(d).thumbnailUrl, 'the thumbnail is shown before the quit');
    before.clear();
    archive.close();

    // The quit: a new process opens the archive and has an empty memory cache.
    archive = openRoomArchive({ dir, protector: protector() });
    t.after(() => { archive.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const after = createRoomMedia({ decodeImage: async () => null, store: storeOf(archive, roomId) });
    assert.equal(after.info(d).thumbnailUrl ?? null, null);
    assert.equal(after.loadStored(d), true);
    const url = after.info(d).thumbnailUrl;
    assert.match(url, /^room-media:\/\/asset\/[0-9a-f-]{36}\/thumbnail$/);
    const res = await after.serve(new Request(url));
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    assert.deepEqual(after.previewBytes(d), png, 'Copy image and the stored preview of the sender use the same PNG');

    // Only the exact archived descriptor gets the PNG.
    assert.equal(after.loadStored({ ...d, sha256: 'b'.repeat(64) }), false);
    assert.equal(after.loadStored(descriptor()), false);
});

test('a damaged stored PNG is not shown; a thumbnail made before its card was archived is stored later', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-thumbs-'));
    const archive = openRoomArchive({ dir, protector: protector() });
    t.after(() => { archive.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const { roomId } = archive.saveRoom({ name: 'room', roomKey: KEY, keepHistory: true });
    const d = descriptor();
    const bad = Buffer.from(png); bad[47] ^= 1;
    const media = createRoomMedia({ store: { save: () => false, load: () => bad } });
    assert.equal(media.loadStored(d), false);
    assert.equal(media.info(d).thumbnailUrl ?? null, null);

    // The thumbnail comes first (no card in the archive yet), then the card.
    const later = createRoomMedia({ decodeImage: async () => png, store: storeOf(archive, roomId) });
    await later.storePreview(d, png);
    assert.equal(archive.getThumbnail(roomId, d), null);
    archive.addMessage(roomId, { id: 'm1', text: 'cat', time: 1, source: 'live', peerId: SENDER, attachment: d });
    assert.equal(later.loadStored(d), true);
    assert.deepEqual(archive.getThumbnail(roomId, d), png);
});

test('stored thumbnails go with Clear thumbnail cache, Clear history and Forget; each room has a byte limit', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-thumbs-'));
    const archive = openRoomArchive({ dir, protector: protector(), limits: { maxThumbnailRoomBytes: png.length * 2 } });
    t.after(() => { archive.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const { roomId } = archive.saveRoom({ name: 'room', roomKey: KEY, keepHistory: true });
    const { roomId: other } = archive.saveRoom({ name: 'room', roomKey: Buffer.alloc(32, 9), keepHistory: true });
    const cards = [descriptor(), descriptor(), descriptor()];
    cards.forEach((d, i) => archive.addMessage(roomId, { id: 'm' + i, text: 'x', time: i, source: 'live', peerId: SENDER, attachment: d }));
    archive.addMessage(other, { id: 'm0', text: 'x', time: 0, source: 'live', peerId: SENDER, attachment: cards[0] });

    assert.equal(archive.rememberThumbnail(roomId, { ...cards[0], kind: 'video', name: 'a.mp4' }, png), false);
    assert.equal(archive.rememberThumbnail(roomId, cards[0], Buffer.alloc(THUMBNAIL_LIMITS.maxPng + 1)), false);
    for (const d of cards) assert.equal(archive.rememberThumbnail(roomId, d, png), true);
    // The limit: the oldest thumbnail goes first.
    assert.equal(archive.getThumbnail(roomId, cards[0]), null);
    assert.deepEqual(archive.getThumbnail(roomId, cards[2]), png);
    assert.equal(archive.getThumbnail(other, cards[0]), null, 'a thumbnail belongs to one room');
    assert.equal(archive.rememberThumbnail(other, cards[0], png), true);

    assert.equal(archive.clearThumbnails(roomId), 2);
    assert.equal(archive.getThumbnail(roomId, cards[2]), null);
    assert.equal(archive.listMessages(roomId).length, 3, 'the cards stay');
    archive.rememberThumbnail(roomId, cards[2], png);
    archive.clearMessages(roomId);
    assert.equal(archive.getThumbnail(roomId, cards[2]), null);
    archive.removeRoom(other);
    const raw = archive.getThumbnail(other, cards[0]);
    assert.equal(raw, null);
});

// A message queue with an async iterator (one direction of a fake libp2p stream).
function channel() {
    const items = [], waits = [];
    let ended = false;
    return {
        push(v) { if (waits.length) waits.shift()({ value: v, done: false }); else items.push(v); },
        end() { ended = true; while (waits.length) waits.shift()({ value: undefined, done: true }); },
        [Symbol.asyncIterator]() {
            return { next: () => items.length ? Promise.resolve({ value: items.shift(), done: false }) :
                ended ? Promise.resolve({ value: undefined, done: true }) : new Promise(r => waits.push(r)) };
        }
    };
}
// The two ends of one preview stream between a receiver and a sender.
function streamPair() {
    const request = channel(), response = channel();
    const end = (into, from) => ({
        source: from,
        sink: async parts => { for await (const p of parts) into.push(Buffer.from(p)); into.end(); },
        close: async () => {},
        abort: () => { into.end(); }
    });
    return { receiver: end(request, response), sender: end(response, request) };
}

const OLD_SENDER = SENDER;   // the peer ID of the sender at the time of the post
const NEW_SENDER = '12D3KooWRJC7wsnnCz44uoEZ5VLLD8H5pmLNQbdLauYUbznrn61L';   // the same device after a restart
const RECEIVER = SELF;

test('fake streams: a restarted sender (new peer ID) gives the stored thumbnail of its own post on the device route', async () => {
    const own = descriptor({ source: OLD_SENDER });
    const other = descriptor({ source: RECEIVER });
    const asked = [];
    const sender = createAttachments({ self: NEW_SENDER, sessions: new Map([[RECEIVER, { send: () => true }]]),
        connections: () => [], events: { emit() {} }, files: {},
        // The app: an own card of the archive (ownCard), never a card of another device.
        storedPreview: (id, live) => { asked.push([id, live]); return id === own.id ? { descriptor: own, png } : null; } });
    await sender.handle(RECEIVER, { v: 1, op: 'hello' });

    const opened = [];
    const connection = { status: 'open', remotePeer: { toString: () => NEW_SENDER }, newStream: async () => {
        const pair = streamPair();
        opened.push(NEW_SENDER);
        void sender.handlePreview({ stream: pair.sender, connection: { remotePeer: { toString: () => RECEIVER } } });
        return pair.receiver;
    } };
    const receiver = createAttachments({ self: RECEIVER, sessions: new Map([[NEW_SENDER, { send: () => true }]]),
        connections: () => [connection], events: { emit() {} }, files: {} });
    await receiver.handle(NEW_SENDER, { v: 1, op: 'hello' });

    // The card is older than the 200 newest lines of the node: the app gives the descriptor of its archive.
    assert.equal(receiver.descriptor(own), null);
    assert.equal(await receiver.requestPreviewById(own), null, 'the old peer ID has no session');
    assert.deepEqual(opened, []);
    const result = await receiver.requestPreviewById(own, { via: NEW_SENDER, descriptor: own });
    assert.deepEqual(result, { descriptor: own, bytes: png });
    assert.deepEqual(asked, [[own.id, null]], 'the post of an earlier start is not a live post of this node');

    // A card of another device: the sender has no own card with that ID and refuses.
    assert.equal(await receiver.requestPreviewById(other, { via: NEW_SENDER, descriptor: other }), null);
    // A descriptor that differs from the request is not used.
    assert.equal(await receiver.requestPreviewById(own, { via: NEW_SENDER, descriptor: { ...own, sha256: 'c'.repeat(64) } }), null);
    sender.stop(); receiver.stop();
});

test('a sender gives no stored answer for an other descriptor ID; the hello of a peer is an event', async () => {
    const d = descriptor({ source: OLD_SENDER });
    const emitted = [];
    const a = createAttachments({ self: NEW_SENDER, sessions: new Map([[RECEIVER, { send: () => true }]]), connections: () => [],
        events: { emit: (name, data) => emitted.push([name, data]) }, files: {},
        storedPreview: () => ({ descriptor: descriptor(), png }) });
    await a.handle(RECEIVER, { v: 1, op: 'hello' });
    assert.deepEqual(emitted.filter(([name]) => name === 'attachment-peer'), [['attachment-peer', { peer: RECEIVER }]]);
    const pair = streamPair();
    const answer = [];
    const reading = (async () => { for await (const c of pair.receiver.source) answer.push(c); })();
    await pair.receiver.sink([Buffer.from(d.id)]);
    await a.handlePreview({ stream: pair.sender, connection: { remotePeer: { toString: () => RECEIVER } } });
    await reading;
    assert.deepEqual(answer, []);
    a.stop();
});

test('a receiver asks for a thumbnail after the 30 minutes of the offer', async () => {
    const d = descriptor();
    const sessions = new Map([[SENDER, { send: () => true }]]);
    let opened = false;
    const connection = { status: 'open', remotePeer: { toString: () => SENDER },
        newStream: async () => { opened = true; throw new Error('closed'); } };
    const a = createAttachments({ self: SELF, sessions, connections: () => [connection], events: { emit() {} }, files: {} });
    a.remember({ attachment: d }, SENDER);
    assert.equal(a.sourceOnline(d), false);
    await a.handle(SENDER, { v: 1, op: 'hello' });
    assert.equal(a.sourceOnline(d), true);
    assert.equal(await a.requestPreviewById(d), null);
    assert.equal(opened, true, 'the request goes to the sender');
    a.stop();
});

test('the archive gives the checked card of a line and the own card of a descriptor ID', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-thumbs-'));
    const archive = openRoomArchive({ dir, protector: protector() });
    t.after(() => { archive.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const { roomId } = archive.saveRoom({ name: 'room', roomKey: KEY, keepHistory: true });
    const mine = descriptor({ source: OLD_SENDER }), theirs = descriptor({ source: NEW_SENDER });
    const device = 'A'.repeat(43);
    archive.addMessage(roomId, { id: device + '.1', text: 'x', time: 1, own: true, source: 'send', attachment: mine });
    archive.addMessage(roomId, { id: 'B'.repeat(43) + '.2', text: 'y', time: 2, source: 'live', peerId: NEW_SENDER, attachment: theirs });
    assert.deepEqual(archive.messageCard(roomId, device + '.1'), { descriptor: mine, own: true });
    assert.deepEqual(archive.messageCard(roomId, 'B'.repeat(43) + '.2'), { descriptor: theirs, own: false });
    assert.equal(archive.messageCard(roomId, 'none'), null);
    assert.deepEqual(archive.ownCard(roomId, mine.id), mine);
    assert.equal(archive.ownCard(roomId, theirs.id), null);
});

const DEVICE = 'D'.repeat(43);

async function thumbnailRoom(api, { own = false } = {}) {
    const room = await loadRoomWindow({
        scripts: ['chat-media.js', 'chat-attachments.js'],
        elements: [{ id: 'view-previews', tag: 'button' },
            { id: 'image-viewer', tag: 'dialog', children: [{ id: 'image-viewer-image', tag: 'img' }, { tag: 'button' }] }],
        api: { getMediaInfo: async () => ({}), attachmentAvailable: async () => false, savedOriginalAvailable: async () => false,
            onAttachmentStatus: () => {}, ...api }
    });
    await room.login('alice');
    const row = room.receive({ from: 'bob', text: 'cat.jpg (42133 bytes)', peerId: OLD_SENDER, id: DEVICE + '.m1' });
    room.window.chatAttachments.decorate(row, descriptor({ source: OLD_SENDER }), own);
    await settle();
    return { room, row, box: row.querySelector('.chat-media') };
}

test('the window says why a thumbnail is missing and asks again when the sender device is back', async () => {
    let answer = { reason: 'offline' };
    const requests = [];
    const { room, box } = await thumbnailRoom({ requestMediaPreview: async (ref, messageId) => { requests.push(messageId); return answer; } });
    assert.deepEqual(requests, [DEVICE + '.m1'], 'automatic thumbnails ask one time, with the ID of the line');
    assert.equal(box.querySelector('button').textContent, 'Sender offline. Try again');

    // A click is never silent: the button shows the request, then the result.
    let release;
    answer = new Promise(r => { release = r; });
    box.querySelector('button').click();
    assert.equal(box.querySelector('button').textContent, 'Loading thumbnail…');
    assert.equal(box.querySelector('button').disabled, true);
    release({ reason: 'offline' });
    await settle();
    assert.equal(box.querySelector('button').textContent, 'Sender offline. Try again');

    // The sender is back with a new peer ID (its attachment hello). Another device: no request.
    answer = { thumbnailUrl: 'room-media://asset/t1/thumbnail' };
    room.handlers.onMediaPeer({ peer: NEW_SENDER, device: 'E'.repeat(43) });
    await settle();
    assert.equal(requests.length, 2);
    room.handlers.onMediaPeer({ peer: NEW_SENDER, device: DEVICE });
    await settle();
    assert.equal(requests.length, 3);
    assert.equal(box.querySelector('img')?.src, 'room-media://asset/t1/thumbnail');
    assert.deepEqual(room.errors, []);
});

test('an own card with no stored thumbnail says unavailable, not offline', async () => {
    const { room, box } = await thumbnailRoom({ requestMediaPreview: async () => ({ reason: 'offline' }) }, { own: true });
    assert.equal(box.querySelector('button').textContent, 'Thumbnail unavailable. Try again');
    assert.deepEqual(room.errors, []);
});

test('a stored thumbnail shows with no request to the sender', async () => {
    const requests = [];
    const { room, box } = await thumbnailRoom({
        getMediaInfo: async () => ({ thumbnailUrl: 'room-media://asset/t2/thumbnail' }),
        requestMediaPreview: async ref => { requests.push(ref.id); return {}; }
    });
    assert.equal(box.querySelector('img')?.src, 'room-media://asset/t2/thumbnail');
    assert.deepEqual(requests, []);
    assert.deepEqual(room.errors, []);
});
