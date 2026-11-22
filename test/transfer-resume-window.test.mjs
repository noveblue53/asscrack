// P7b: the window part of transfer resume. Pause on a receive row, the paused row and its actions, Resume on the
// same rows (the resume attempt has a new offer ID and links with resumeOf), Waiting for the sender, the Discard
// question, the restarted and expired texts, the kept rows of an earlier session, and the N6 count with a paused
// transfer. The real scripts run in the fake DOM of test/helpers/renderer-fixture.mjs with bridge stubs. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const SAM = '12D3KooWsamAAAAAAaaaa01';
const SHA = 'a'.repeat(64);
const MIB = 1024 * 1024;
const SIZE = 100 * MIB;
const KEY = `${SHA}-${SIZE}`;
const EXPIRES = Date.UTC(2026, 10, 24, 18, 30);
const OFFER = { offerId: '11111111-1111-4111-8111-111111111111', peerId: SAM, from: 'Sam', name: 'big.iso', size: SIZE };
const NEXT = '22222222-2222-4222-8222-222222222222';

const DIALOGS = [
    { id: 'discard-dialog', tag: 'dialog', children: [{ id: 'discard-text', tag: 'p' }, { id: 'discard-confirm', tag: 'button' }] },
    { id: 'quit-dialog', tag: 'dialog', children: [{ id: 'quit-text', tag: 'p' }, { id: 'quit-confirm', tag: 'button' }] }
];

const partial = (fields = {}) => ({ key: KEY, sha256: SHA, size: SIZE, name: 'big.iso', offerId: OFFER.offerId,
    bytes: 40 * MIB, lastByteAt: EXPIRES - 72 * 3600 * 1000, expiresAt: EXPIRES, active: false, ...fields });

// The room window with Sam in the room. api: the bridge calls of the test (each call is recorded in `log`).
async function room(api = {}) {
    const log = [];
    const record = (name, result) => async (...args) => { log.push([name, ...args]); return result(...args); };
    const f = await loadRoomWindow({
        elements: DIALOGS,
        scripts: ['app-shell.js'],
        globals: { CSS: { escape: s => s } },
        api: {
            acceptFile: record('acceptFile', () => true),
            pauseFile: record('pauseFile', () => true),
            resumeFile: record('resumeFile', () => true),
            discardPartial: record('discardPartial', () => true),
            listPartials: record('listPartials', () => []),
            ...api
        }
    });
    for (const id of ['discard-dialog', 'quit-dialog']) {
        const dialog = f.el(id);
        dialog.open = false;
        dialog.showModal = () => { dialog.open = true; };
        dialog.close = () => { dialog.open = false; };
    }
    f.log = log;
    await f.login('Parker');
    f.handlers.onPeerJoined({ peerId: SAM });
    f.handlers.onPeerName({ peerId: SAM, name: 'Sam' });
    return f;
}

const text = row => row.querySelector('.state-text').textContent;
const actions = row => row.querySelector('.buttons').children.map(button => button.dataset.action);
const button = (row, action) => row.querySelector(`[data-action="${action}"]`);

// An accepted offer of Sam at 40 %. Returns the Transfers row and the chat card.
async function receiving(f) {
    f.handlers.onFileOffer(OFFER);
    const [card] = f.rows();
    const [row] = f.el('transfers').children;
    button(card, 'accept').click();
    await settle();
    f.handlers.onFileProgress({ ...OFFER, direction: 'receive', bytes: 40 * MIB });
    return { row, card };
}

// The pause of the receive and the node events of P7a (file-partials comes before file-paused).
async function paused(f, fields = {}) {
    const rows = await receiving(f);
    button(rows.row, 'pause').click();
    await settle();
    f.handlers.onFilePartials({ partials: [partial()] });
    f.handlers.onFilePaused({ offerId: OFFER.offerId, peerId: SAM, direction: 'receive', bytes: 40 * MIB, size: SIZE,
        key: KEY, expiresAt: EXPIRES, resumable: true, ...fields });
    return rows;
}

test('a receiving row has Pause; a paused row shows the kept bytes, the expiry and Resume and Discard', async () => {
    const f = await room();
    const { row, card } = await receiving(f);
    assert.deepEqual(actions(row), ['pause', 'cancel-receive']);
    assert.deepEqual(actions(card), ['pause', 'cancel-receive']);
    button(card, 'pause').click();
    assert.equal(text(row), 'Pausing…');
    assert.deepEqual(actions(row), [], 'no second Pause and no Cancel while the pause runs');
    await settle();
    assert.deepEqual(f.log.filter(([name]) => name === 'pauseFile'), [['pauseFile', OFFER.offerId]]);
    f.handlers.onFilePartials({ partials: [partial()] });
    f.handlers.onFilePaused({ offerId: OFFER.offerId, peerId: SAM, direction: 'receive', bytes: 40 * MIB, size: SIZE,
        key: KEY, expiresAt: EXPIRES, resumable: true });
    const expected = `Paused · 40.0 MB of 100.0 MB · kept until ${new Date(EXPIRES).toLocaleString()}`;
    for (const r of [row, card]) {
        assert.equal(r.dataset.state, 'paused');
        assert.equal(text(r), expected);
        assert.deepEqual(actions(r), ['resume', 'discard']);
        assert.equal(r.querySelector('progress').value, 40 * MIB);
    }
    assert.equal(f.el('transfers').children.length, 1, 'no second row');
    assert.deepEqual(f.errors, []);
});

test('a pause that the node refuses gives the receiving row back', async () => {
    const f = await room({ pauseFile: async () => false });
    const { row } = await receiving(f);
    button(row, 'pause').click();
    await settle();
    assert.equal(row.dataset.state, 'receiving');
    assert.equal(text(row), 'Receiving');
    assert.deepEqual(actions(row), ['pause', 'cancel-receive']);
    assert.equal(f.el('status').textContent, 'Pause is not possible now.');
});

test('an attachment or shelf receive that pauses has Discard but no Resume', async () => {
    const f = await room();
    const { row } = await paused(f, { resumable: false });
    assert.deepEqual(actions(row), ['discard']);
});

test('Resume asks the sender, and the resume attempt continues on the same rows to the saved file', async () => {
    const f = await room();
    const { row, card } = await paused(f);
    button(row, 'resume').click();
    assert.equal(text(row), 'Resuming…');
    await settle();
    assert.deepEqual(f.log.filter(([name]) => name === 'resumeFile'), [['resumeFile', OFFER.offerId]]);
    f.handlers.onFilePartials({ partials: [partial({ active: true })] });
    f.handlers.onFileResumed({ offerId: NEXT, peerId: SAM, direction: 'receive', offset: 40 * MIB, size: SIZE, resumeOf: OFFER.offerId });
    for (const r of [row, card]) {
        assert.equal(r.dataset.offerId, NEXT);
        assert.equal(r.dataset.state, 'receiving');
        assert.equal(text(r), 'Receiving · continues from 40.0 MB');
    }
    f.handlers.onFileProgress({ offerId: NEXT, peerId: SAM, direction: 'receive', bytes: 70 * MIB, size: SIZE });
    assert.equal(row.querySelector('progress').value, 70 * MIB);
    // Pause and Cancel act on the new attempt.
    assert.deepEqual(actions(row), ['pause', 'cancel-receive']);
    f.handlers.onFilePartials({ partials: [] });
    f.handlers.onFileDone({ offerId: NEXT, peerId: SAM, direction: 'receive', name: 'big.iso', size: SIZE, offset: 40 * MIB,
        resumeOf: OFFER.offerId, savedName: 'big.iso' });
    assert.equal(text(card), 'Saved as big.iso');
    assert.equal(f.el('transfers').children.length, 1);
    assert.equal(f.rows().length, 1);
    assert.deepEqual(f.errors, []);
});

test('with no session to the sender, Resume shows Waiting for <name> and starts when the sender comes back', async () => {
    const f = await room();
    const { row } = await paused(f);
    f.handlers.onPeerLeft({ peerId: SAM });
    button(row, 'resume').click();
    await settle();
    assert.equal(row.dataset.state, 'waiting');
    assert.equal(text(row), 'Waiting for Sam');
    assert.deepEqual(actions(row), ['discard']);
    assert.deepEqual(f.log.filter(([name]) => name === 'resumeFile'), [], 'no request while Sam is away');
    f.handlers.onPeerJoined({ peerId: SAM });
    await settle();
    assert.deepEqual(f.log.filter(([name]) => name === 'resumeFile'), [['resumeFile', OFFER.offerId]]);
    assert.equal(row.dataset.state, 'requesting');
});

test('Discard asks first with the file name, then deletes the kept part', async () => {
    const f = await room();
    const { row } = await paused(f);
    button(row, 'discard').click();
    const dialog = f.el('discard-dialog');
    assert.equal(dialog.open, true);
    assert.equal(f.el('discard-text').textContent,
        'Discard the partial file of big.iso? The download starts again from the beginning next time.');
    assert.deepEqual(f.log.filter(([name]) => name === 'discardPartial'), [], 'no delete before the answer');
    f.el('discard-confirm').click();
    await settle();
    assert.equal(dialog.open, false);
    assert.deepEqual(f.log.filter(([name]) => name === 'discardPartial'), [['discardPartial', KEY]]);
    assert.equal(row.dataset.state, 'failed');
    assert.equal(text(row), 'The kept part is discarded. The download starts again from the beginning next time.');
    // The offer stays open to a new attempt from byte 0 (Retry as before).
    assert.deepEqual(actions(row), ['retry']);
    // The node event of the same Discard changes nothing more.
    f.handlers.onFileDiscarded({ ...partial(), reason: 'user' });
    assert.equal(text(row), 'The kept part is discarded. The download starts again from the beginning next time.');
});

test('a restarted event shows that the download started again from the beginning', async () => {
    const f = await room();
    const { row } = await paused(f);
    button(row, 'resume').click();
    await settle();
    f.handlers.onFileRestarted({ offerId: NEXT, peerId: SAM, direction: 'receive', reason: 'the sender cannot continue from an offset',
        resumeOf: OFFER.offerId });
    assert.equal(row.dataset.offerId, NEXT);
    assert.equal(text(row), 'The download started again from the beginning.');
    assert.equal(row.querySelector('progress').value, 0);
    f.handlers.onFileProgress({ offerId: NEXT, peerId: SAM, direction: 'receive', bytes: 5 * MIB, size: SIZE });
    assert.equal(text(row), 'The download started again from the beginning.');
    assert.equal(f.el('transfers').children.length, 1);
});

test('an expired kept part shows "The kept part expired." and only Retry', async () => {
    const f = await room();
    const { row } = await paused(f);
    f.handlers.onFileExpired(partial());
    f.handlers.onFilePartials({ partials: [] });
    assert.equal(row.dataset.state, 'failed');
    assert.equal(text(row), 'The kept part expired.');
    assert.deepEqual(actions(row), ['retry']);
});

test('a failed resume keeps Discard for the part that stays on disk', async () => {
    const f = await room();
    const { row } = await paused(f);
    button(row, 'resume').click();
    await settle();
    f.handlers.onFileFailed({ offerId: OFFER.offerId, peerId: SAM, direction: 'receive',
        reason: 'the sender can no longer offer this file', retryable: false });
    assert.equal(text(row), 'Failed: the sender can no longer offer this file');
    assert.deepEqual(actions(row), ['discard']);
});

test('a kept part of an earlier session gets its own row with Discard, and the row goes when a receive uses it', async () => {
    const f = await room({ listPartials: async () => [partial({ offerId: 'old-offer' })] });
    await settle();
    const [row] = f.el('transfers').children;
    assert.equal(row.dataset.state, 'paused');
    assert.equal(row.querySelector('.peer-name').textContent, 'from an earlier session');
    assert.equal(text(row), `Paused · 40.0 MB of 100.0 MB · kept until ${new Date(EXPIRES).toLocaleString()} · ` +
        'it continues when the sender offers the file again');
    assert.deepEqual(actions(row), ['discard']);
    // Sam offers the same file again. The accepted receive uses the kept part (the node continues it).
    f.handlers.onFileOffer({ ...OFFER, offerId: NEXT });
    f.handlers.onFilePartials({ partials: [partial({ offerId: 'old-offer', active: true })] });
    assert.equal(row.isConnected, false);
    assert.equal(f.el('transfers').children.length, 1);
    assert.equal(f.el('transfer-count').textContent, '1');
});

test('N6 and A7 count only the transfers that send or receive, not a paused or waiting one', async () => {
    const f = await room();
    const { row } = await paused(f);
    assert.equal(f.window.roomTransfers.activeCount(), 0);
    const quits = () => f.calls.filter(c => c.name === 'quit').length;
    f.window.appShell.quit();
    assert.equal(quits(), 1, 'Quit asks nothing with only a paused transfer');
    assert.equal(f.el('quit-dialog').open, false);
    f.handlers.onPeerLeft({ peerId: SAM });
    button(row, 'resume').click();
    await settle();
    assert.equal(row.dataset.state, 'waiting');
    assert.equal(f.window.roomTransfers.activeCount(), 0);
    f.handlers.onPeerJoined({ peerId: SAM });
    await settle();
    f.handlers.onFileResumed({ offerId: NEXT, peerId: SAM, direction: 'receive', offset: 40 * MIB, size: SIZE, resumeOf: OFFER.offerId });
    assert.equal(f.window.roomTransfers.activeCount(), 1);
    f.window.appShell.quit();
    assert.equal(f.el('quit-dialog').open, true);
    assert.equal(f.el('quit-text').textContent, 'Quit ASSCRACK? 1 file transfer stops.');
});

test('the sender row shows the pause of the receiver and continues as the resume attempt', async () => {
    const f = await room();
    const offer = { offerId: OFFER.offerId, name: 'big.iso', size: SIZE };
    f.handlers.onFileProgress({ ...offer, peerId: SAM, direction: 'send', bytes: 40 * MIB });
    const [row] = f.el('transfers').children;
    f.handlers.onFilePaused({ ...offer, peerId: SAM, direction: 'send', bytes: 40 * MIB });
    assert.equal(row.dataset.state, 'paused');
    assert.equal(text(row), 'Paused by Sam · 40.0 MB of 100.0 MB');
    assert.equal(f.window.roomTransfers.activeCount(), 0);
    f.handlers.onFileRetried({ offerId: NEXT, retryOf: OFFER.offerId, peerId: SAM, direction: 'send', name: 'big.iso', size: SIZE });
    f.handlers.onFileResumed({ offerId: NEXT, peerId: SAM, direction: 'send', offset: 40 * MIB, size: SIZE });
    assert.equal(row.dataset.offerId, NEXT);
    assert.equal(text(row), 'Sending · continues from 40.0 MB');
    f.handlers.onFileDone({ offerId: NEXT, peerId: SAM, direction: 'send', confirmed: true, offset: 40 * MIB, sent: 60 * MIB });
    assert.equal(text(row), 'Delivered · 60.0 MB sent after the resume');
    assert.equal(f.el('transfers').children.length, 1);
});

test('main.js forwards the P7a events, checks the offer ID and the key, and keeps the scratch folder at Leave room', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/application/main.js', import.meta.url), 'utf8');
    const events = source.match(/const EVENTS = \[([^\]]*)\]/)[1];
    for (const type of ['file-paused', 'file-resumed', 'file-restarted', 'file-discarded', 'file-expired', 'file-partials']) {
        assert.match(events, new RegExp(`'${type}'`), type);
    }
    for (const channel of ['pause-file', 'resume-file', 'discard-partial', 'list-partials']) {
        assert.ok(source.includes(`handleRoomIpc('asscrack:${channel}'`), channel);
    }
    const key = new RegExp(source.match(/const PARTIAL_KEY = \/(.+)\/;/)[1]);
    assert.equal(key.test(`${'a'.repeat(64)}-104857600`), true);
    for (const bad of [`${'a'.repeat(64)}-01`, `${'A'.repeat(64)}-1`, `../${'a'.repeat(61)}-1`, `${'a'.repeat(64)}-1/x`]) {
        assert.equal(key.test(bad), false, bad);
    }
    const leave = source.slice(source.indexOf('function leaveRoom()'), source.indexOf("handleRoomIpc('asscrack:leave-room'"));
    assert.match(leave, /if \(!downloadScratch \|\| !existsSync\(downloadScratch\.directory\)\) downloadScratch = null;/);
});

// A received file failed at its end in the app (origin/main daf2c56): the file-done listener of main.js used `live`,
// a const of another block, and the ReferenceError went into the receive of the node ("stream ended").
test('the file-done listener of main.js uses only names of its own scope', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/application/main.js', import.meta.url), 'utf8');
    const start = source.indexOf("node.events.on('file-done', data => {");
    assert.ok(start > 0, 'the listener that records the path of a received file');
    assert.match(source.slice(start - 40, start), /const doneNode = node;\s*$/);
    const body = source.slice(start, source.indexOf('\n    });', start));
    assert.match(body, /if \(node !== doneNode\) return;/);
    assert.doesNotMatch(body, /\blive\b/);
});

test('a Shared download has no Pause: the Shared panel has no paused state', async () => {
    const f = await room();
    f.handlers.onFileOffer({ ...OFFER, shelfId: 'shelf-1' });
    const [row] = f.el('transfers').children;
    assert.equal(row.dataset.state, 'receiving');
    assert.deepEqual(actions(row), ['cancel-receive']);
});
