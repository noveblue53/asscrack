// The image menu of the chat (operator request 2026-11-22): a right-click on a chat image gives Copy image, Save image
// as… and Open original (when the original is on this computer). The image viewer gives the same actions.
// - The window: the room scripts run in node:vm with the fake DOM (test/helpers/renderer-fixture.mjs).
// - Copy image: the main process gives the checked preview PNG to the hidden decoder window, and that window copies it
//   (copyImageAt). L7: no decode in the main process.
// - Save image as: the path check of the target (L8, file-choice.mjs), a verified copy with the Mark-of-the-Web (M3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createClock } from './helpers/fake-clock.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQCdjyHwADrAIYvvruLQAAAABJRU5ErkJggg==', 'base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFile(new URL(`../src/application/${name}`, import.meta.url), 'utf8');

function viewerElements() {
    return [
        { id: 'view-previews', tag: 'button' },
        { id: 'image-viewer', tag: 'dialog', children: [{ id: 'image-viewer-image', tag: 'img' }, { tag: 'button' }] }
    ];
}

async function imageRoom(api = {}, own = false) {
    const calls = [];
    const clock = createClock(Date.now());
    const room = await loadRoomWindow({
        clock,
        scripts: ['chat-media.js', 'chat-attachments.js'],
        elements: viewerElements(),
        api: {
            getMediaInfo: async ref => (ref.id === 'd1' ? { thumbnailUrl: 'room-media://asset/t1/thumbnail' } : {}),
            requestMediaPreview: async () => ({}),
            attachmentAvailable: async () => true,
            savedOriginalAvailable: async () => false,
            copyMediaImage: async ref => { calls.push(['copy', ref.id]); return true; },
            saveMediaImage: async (messageId, ref) => { calls.push(['save', messageId, ref.id]); return { ok: true, name: 'cat.png' }; },
            openMediaOriginal: async (messageId, ref) => { calls.push(['open', messageId, ref.id]); return { ok: true }; },
            cancelMediaSave: async id => { calls.push(['cancel', id]); },
            requestOriginal: async ref => { calls.push(['request', ref.id]); return true; },
            onAttachmentStatus: () => {},
            ...api
        }
    });
    await room.login('alice');
    const dialog = room.el('image-viewer');
    dialog.open = false;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new room.Event('close')); };
    const row = room.receive({ from: 'bob', text: 'cat.png', peerId: 'p1', id: 'm1' });
    const descriptor = { id: 'd1', source: 'p1', kind: 'image', name: 'cat.png', size: 3, sha256: 'ab', expires: Date.now() + 60000 };
    room.window.chatAttachments.decorate(row, descriptor, own);
    await settle();
    return { room, row, dialog, calls, descriptor };
}

const menuItems = room => room.el('row-menu').querySelectorAll('[role="menuitem"]');
const labels = room => menuItems(room).map(item => item.textContent);
function rightClick(room, target) {
    const event = new room.Event('contextmenu', { button: 2, clientX: 20, clientY: 30 });
    target.dispatchEvent(event);
    return event;
}
const pick = (room, label) => menuItems(room).find(item => item.textContent === label).click();

test('a right-click on a chat image shows Copy image and Save image as… first; the actions call the bridge', async () => {
    const { room, row, calls } = await imageRoom();
    const image = row.querySelector('img');
    assert.ok(image, 'the preview is shown');
    const event = rightClick(room, image);
    assert.equal(event.defaultPrevented, true, 'the app menu, not the native menu');
    assert.deepEqual(labels(room).slice(0, 3), ['Copy image', 'Save image as…', 'View image']);
    assert.ok(!labels(room).includes('Open original'), 'no original on this computer');
    pick(room, 'Copy image');
    await settle();
    assert.deepEqual(calls.at(-1), ['copy', 'd1']);
    assert.equal(room.el('status').textContent, 'Image copied.');
    rightClick(room, image);
    pick(room, 'Save image as…');
    await settle();
    assert.deepEqual(calls.at(-1), ['save', 'm1', 'd1']);
    assert.equal(room.el('status').textContent, 'Saved cat.png.');
    // A right-click on the text of the line: the image actions come after View image.
    rightClick(room, row);
    const rowLabels = labels(room);
    assert.deepEqual(rowLabels.slice(0, 2), ['Quote', 'Copy message']);
    assert.deepEqual(rowLabels.slice(rowLabels.indexOf('View image'), rowLabels.indexOf('View image') + 3),
        ['View image', 'Copy image', 'Save image as…']);
    room.window.contextMenu.close(false);
    assert.deepEqual(room.errors, []);
});

test('Open original is in the menu when the original is on this computer', async () => {
    const { room, row, calls } = await imageRoom();
    room.window.chatAttachments.offer({ attachmentId: 'd1', peerId: 'p1', offerId: 'o1', sha256: 'ab', size: 3, name: 'cat.png' },
        { state: 'done', revealable: true });
    rightClick(room, row.querySelector('img'));
    assert.deepEqual(labels(room).slice(0, 4), ['Copy image', 'Save image as…', 'Open original', 'View image']);
    pick(room, 'Open original');
    await settle();
    assert.deepEqual(calls.at(-1), ['open', 'm1', 'd1']);
});

test('Save image as… with no local original starts the Download original path; with no original it cancels', async () => {
    const pending = await imageRoom({ saveMediaImage: async () => ({ ok: true, pending: true, name: 'cat.png' }) });
    rightClick(pending.room, pending.row.querySelector('img'));
    pick(pending.room, 'Save image as…');
    await settle();
    assert.deepEqual(pending.calls.at(-1), ['request', 'd1']);
    assert.equal(pending.room.el('status').textContent, 'Downloading the original. It is saved when the download is complete.');
    pending.room.handlers.onMediaSaved({ id: 'd1', ok: true, name: 'cat.png' });
    assert.equal(pending.room.el('status').textContent, 'Saved cat.png.');

    const none = await imageRoom({ saveMediaImage: async () => ({ ok: true, pending: true, name: 'cat.png' }), requestOriginal: async () => false });
    rightClick(none.room, none.row.querySelector('img'));
    pick(none.room, 'Save image as…');
    await settle();
    assert.deepEqual(none.calls.at(-1), ['cancel', 'd1']);
    assert.equal(none.room.el('status').textContent, 'The original is not available now.');
});

// Operator 2026-11-22: an own image (a pasted screenshot) has no Download original button, but the menu works.
test('an own image has Copy image, Save image as… and Open original, and no Download original button', async () => {
    const { room, row, calls } = await imageRoom({}, true);
    assert.equal(row.querySelector('.attachment-actions').children[0].hidden, true, 'Download original stays hidden for an own card');
    rightClick(room, row.querySelector('img'));
    assert.deepEqual(labels(room).slice(0, 4), ['Copy image', 'Save image as…', 'Open original', 'View image']);
    pick(room, 'Save image as…');
    await settle();
    assert.deepEqual(calls.at(-1), ['save', 'm1', 'd1']);
    assert.equal(calls.some(c => c[0] === 'request'), false, 'no download for an own image');
    assert.equal(room.el('status').textContent, 'Saved cat.png.');
    rightClick(room, row.querySelector('img'));
    pick(room, 'Copy image');
    await settle();
    assert.deepEqual(calls.at(-1), ['copy', 'd1']);
    assert.deepEqual(room.errors, []);
});

test('a right-click on the image viewer opens the image menu inside the viewer dialog', async () => {
    const { room, row, dialog, calls } = await imageRoom();
    row.querySelector('img').click();
    await settle();
    assert.equal(dialog.open, true);
    const event = rightClick(room, room.el('image-viewer-image'));
    assert.equal(event.defaultPrevented, true);
    const menu = room.el('row-menu');
    assert.equal(menu.parentNode, dialog, 'a modal dialog makes the body inert: the menu is in the dialog');
    assert.deepEqual(labels(room), ['Copy image', 'Save image as…']);
    pick(room, 'Copy image');
    await settle();
    assert.deepEqual(calls.at(-1), ['copy', 'd1']);
    assert.equal(menu.parentNode, room.document.body, 'the menu goes back to the body when it closes');
    // Escape with the menu open closes the menu, not the viewer.
    rightClick(room, room.el('image-viewer-image'));
    const cancel = new room.Event('cancel');
    dialog.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    assert.equal(room.window.contextMenu.isOpen(), false);
    assert.deepEqual(room.errors, []);
});

function fakeElectron() {
    const ipc = new EventEmitter();
    const windows = [];
    class Win extends EventEmitter {
        constructor(options) {
            super(); this.options = options; this.destroyed = false; windows.push(this);
            this.copied = [];
            this.webContents = Object.assign(new EventEmitter(), { sent: [], send: (...args) => this.webContents.sent.push(args),
                copyImageAt: (x, y) => this.copied.push([x, y]) });
        }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; this.emit('closed'); }
        async loadURL(url) { this.url = url; }
    }
    return { ipc, windows, Win };
}

test('Copy image: the decoder window gets the preview PNG and copies it; the main process does not decode', async () => {
    const { createImageDecoder } = await import('../src/application/image-decoder.mjs');
    const { ipc, windows, Win } = fakeElectron();
    const decoder = createImageDecoder({ BrowserWindow: Win, ipc, page: 'asscrack-app://app/image-decoder.html', preload: 'p.cjs',
        isFrame: (win, event) => event.sender === win.webContents, timeoutMs: 1000, idleMs: 5000 });
    const copying = decoder.copy(png);
    await new Promise(r => setImmediate(r));
    const [win] = windows;
    assert.equal(win.options.webPreferences.sandbox, true);
    const [channel, id, bytes] = win.webContents.sent[0];
    assert.equal(channel, 'asscrack:image-copy');
    assert.deepEqual(Buffer.from(bytes), png, 'the PNG bytes of the preview');
    // An answer of another frame does nothing.
    ipc.emit('asscrack:image-copy-ready', { sender: {} }, id, true);
    assert.deepEqual(win.copied, []);
    ipc.emit('asscrack:image-copy-ready', { sender: win.webContents }, id, true);
    assert.equal(await copying, true);
    assert.deepEqual(win.copied, [[0, 0]]);
    // An image that the page cannot show: no copy.
    const bad = decoder.copy(png);
    await new Promise(r => setImmediate(r));
    ipc.emit('asscrack:image-copy-ready', { sender: win.webContents }, win.webContents.sent[1][1], false);
    assert.equal(await bad, false);
    assert.equal(win.copied.length, 1);
    decoder.dispose();

    // room-media gives the checked preview bytes, and the main process sends them with no nativeImage and no
    // clipboard write of its own.
    const { createRoomMedia } = await import('../src/application/room-media.mjs');
    const media = createRoomMedia({ decodeImage: async () => png });
    const d = { id: '31e69ba1-2dbc-416a-ae60-727092a82188', source: 'p', kind: 'image', name: 'a.png', size: png.length, sha256: sha(png), expires: Date.now() + 60000 };
    assert.equal(media.previewBytes(d), null);
    assert.equal(await media.storePreview(d, png), true);
    assert.deepEqual(media.previewBytes(d), png);
    assert.equal(media.previewBytes({ ...d, sha256: sha(Buffer.from('x')) }), null, 'another descriptor gets nothing');
    const main = await read('main.js');
    const handler = main.slice(main.indexOf("handleRoomIpc('asscrack:media-copy-image'"));
    const body = handler.slice(0, handler.indexOf('});'));
    assert.match(body, /roomMedia\.previewBytes\(ref\)/);
    assert.match(body, /imageDecoder\.copy\(bytes\)/);
    assert.doesNotMatch(body, /nativeImage|clipboard\./);
    const page = await read('image-decoder.html');
    assert.match(page, /img-src blob:/);
});

test('Save image as: the target path check refuses private folders, device paths and folders', async t => {
    const { checkSaveTarget } = await import('../src/application/file-choice.mjs');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ac-save-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const profile = path.join(dir, 'Profile');
    await mkdir(profile);
    const blocked = [profile];
    const target = path.join(dir, 'cat.png');
    assert.equal(checkSaveTarget(target, { blocked }), target);
    assert.throws(() => checkSaveTarget(path.join(profile, 'cat.png'), { blocked }), /private folder/);
    if (process.platform === 'win32') {
        assert.throws(() => checkSaveTarget(path.join(profile, 'cat.png').toUpperCase(), { blocked }), /private folder/);
        assert.throws(() => checkSaveTarget('\\\\?\\' + target, { blocked }), /Choose a local folder/);
    }
    assert.throws(() => checkSaveTarget('//?/' + target, { blocked }), /Choose a local folder/);
    assert.throws(() => checkSaveTarget('cat.png', { blocked }), /Choose a local folder/);
    assert.throws(() => checkSaveTarget(path.join(dir, 'missing', 'cat.png'), { blocked }), /Choose a local folder/);
    assert.throws(() => checkSaveTarget(profile, { blocked: [] }), /not a folder/);
    assert.throws(() => checkSaveTarget(target + '\0', { blocked }), /Choose a local folder/);
});

test('Save image as: a verified copy with the Mark-of-the-Web, and no file when the source changed', async t => {
    const { saveVerifiedCopy } = await import('../src/application/media-save.mjs');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ac-save-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'original.png');
    await writeFile(source, png);
    await mkdir(path.join(dir, 'out'));
    const target = path.join(dir, 'out', 'cat.png');
    const marked = [];
    const mark = async file => { marked.push(file); return true; };
    const descriptor = { sha256: sha(png), size: png.length };
    assert.deepEqual(await saveVerifiedCopy({ source, target, descriptor, mark }), { ok: true, marked: true });
    assert.deepEqual(await readFile(target), png);
    assert.equal(marked.length, 1, 'the mark is on the file before the rename');
    assert.notEqual(marked[0], target);
    // An own image: no mark.
    assert.deepEqual(await saveVerifiedCopy({ source, target, descriptor, mark, fromPeer: false }), { ok: true, marked: false });
    assert.equal(marked.length, 1);
    // A changed source: no file, no temporary file.
    const other = path.join(dir, 'out', 'other.png');
    assert.deepEqual(await saveVerifiedCopy({ source, target: other, descriptor: { ...descriptor, sha256: sha(Buffer.from('x')) }, mark }),
        { ok: false, reason: 'changed' });
    assert.deepEqual((await readdir(path.join(dir, 'out'))).sort(), ['cat.png']);
    // The real mark on this PC (NTFS): the Zone.Identifier stream.
    if (process.platform === 'win32') {
        const real = path.join(dir, 'out', 'real.png');
        const result = await saveVerifiedCopy({ source, target: real, descriptor });
        assert.equal(result.ok, true);
        if (result.marked) assert.match(await readFile(`${real}:Zone.Identifier`, 'utf8'), /ZoneId=3/);
    }
    // main.js: the save path goes through checkSaveTarget and saveVerifiedCopy, with the private folders of chosenFile.
    const main = await read('main.js');
    const finish = main.slice(main.indexOf('async function finishSave'));
    assert.match(finish.slice(0, finish.indexOf('\n}')), /checkSaveTarget\(target, \{ blocked: privateFolders\(\) \}\)[\s\S]+saveVerifiedCopy\(/);
    const save = main.slice(main.indexOf("handleRoomIpc('asscrack:media-save-image'"));
    assert.match(save.slice(0, save.indexOf('\n});')), /checkSaveTarget\(target, \{ blocked: privateFolders\(\) \}\)/);
});
