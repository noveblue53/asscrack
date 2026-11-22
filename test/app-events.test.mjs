// Source checks for the event path from the network node to the window. Electron does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const read = name => readFile(new URL(`../src/application/${name}`, import.meta.url), 'utf8');

test('main.js forwards the history event', async () => {
    const source = await read('main.js');
    const match = source.match(/const EVENTS = \[([^\]]*)\]/);
    assert.ok(match, 'EVENTS not found in main.js');
    assert.match(match[1], /'history'/);
});

test('only an explicit local debug run writes raw console logs', async () => {
    const source = await read('main.js');
    assert.ok(source.includes("'console-message'"));
    assert.match(source, /indexOf\('--log-dir'\)[\s\S]+if \(index === -1/);
    assert.match(source, /if \(logFile\) mainWindow\.webContents\.on\('console-message'/);
    assert.match(source, /logBytes \+ bytes > MAX_DEBUG_LOG_BYTES/);
});

test('main.js forwards the topology event', async () => {
    const source = await read('main.js');
    const match = source.match(/const EVENTS = \[([^\]]*)\]/);
    assert.ok(match, 'EVENTS not found in main.js');
    assert.match(match[1], /'topology'/);
    assert.ok(source.includes("handleRoomIpc('asscrack:topology'"));
});

test('main.js logs the direction, the cancel side and the file actions', async () => {
    const source = await read('main.js');
    assert.ok(source.includes('parts.push(`direction ${direction}`)'));
    assert.ok(source.includes('parts.push(`by ${by}`)'));
    for (const action of ['offer-file', 'accept-file', 'refuse-file', 'cancel-file']) {
        assert.ok(source.includes(`logAction('${action}'`), action);
    }
});

test('the transfer window labels confirmed delivery, legacy sends, failure and the saved file', async () => {
    const room = await loadRoomWindow();
    const send = { offerId: 'first', peerId: 'peer', direction: 'send', name: 'note.txt', size: 5 };
    room.handlers.onFileDone({ ...send, confirmed: true });
    room.handlers.onFileDone({ ...send, offerId: 'second', confirmed: false });
    room.handlers.onFileFailed({ ...send, offerId: 'third', reason: 'peer left' });
    room.handlers.onFileDone({ ...send, offerId: 'fourth', direction: 'receive', savedName: 'note.txt' });
    const labels = room.el('transfers').children.map(row => row.querySelector('.state-text').textContent);
    assert.deepEqual(labels, ['Delivered', 'Sent ?', 'Failed: they left', 'Saved as note.txt']);
});

test('a live file card and its Transfers row share one offer, actions and saved path key', async () => {
    const room = await loadRoomWindow();
    const offer = { offerId: 'first', peerId: 'peer-00000001', from: 'Sam', name: 'note.txt', size: 5 };
    const calls = [];
    room.window.asscrack.acceptFile = async id => { calls.push(id); return true; };
    room.window.asscrack.revealFile = async key => { calls.push(key); return { ok: true }; };
    room.el('message-input').value = 'draft';
    room.handlers.onFileOffer(offer);
    room.handlers.onFileOffer(offer);
    const [card] = room.rows();
    const [row] = room.el('transfers').children;
    assert.equal(room.rows().length, 1);
    assert.equal(room.el('transfers').children.length, 1);
    assert.equal(card.querySelector('.file-name').textContent, 'note.txt');
    assert.equal(card.querySelector('.file-size').textContent, '5 B');
    assert.match(card.querySelector('.peer-name').textContent, /Sam/);
    assert.equal(card.dataset.id, undefined);
    assert.deepEqual([...room.window.menuCore.actionsFor(room.window.roomActions.rowInfo(card))], ['accept', 'refuse']);
    card.querySelector('[data-action="accept"]').click();
    await settle();
    assert.deepEqual(calls, ['first']);
    assert.equal(row.dataset.state, 'receiving');
    assert.equal(row.querySelector('[data-action="accept"]'), null);
    assert.ok(card.querySelector('[data-action="cancel-receive"]'));
    room.handlers.onFileProgress({ ...offer, direction: 'receive', bytes: 3 });
    assert.equal(card.querySelector('progress').value, 3);
    room.handlers.onFileDone({ ...offer, direction: 'receive', savedName: 'note (1).txt' });
    room.handlers.onFileOffer(offer);
    assert.deepEqual([row, card].map(el => el.querySelector('.state-text').textContent), ['Saved as note (1).txt', 'Saved as note (1).txt']);
    card.querySelector('[data-action="reveal"]').click();
    assert.deepEqual(calls, ['first', 'first|peer-00000001']);
    room.receive({ from: 'Sam', peerId: offer.peerId, text: 'next message', id: 'msg' });
    assert.equal(room.rows().length, 2);
    assert.equal(room.rows()[1].classList.contains('cont'), false);
    assert.equal(room.el('message-input').value, 'draft');
});

test('the failed card and Transfers row retry once and show the verified result on the same rows', async () => {
    const room = await loadRoomWindow();
    const offer = { offerId: 'first', peerId: 'source', from: 'Sam', name: 'note.txt', size: 5 };
    const attempts = [], accepted = [];
    room.window.asscrack.retryFile = async id => { attempts.push(id); return true; };
    room.window.asscrack.acceptFile = async id => { accepted.push(id); return true; };
    room.handlers.onPeerJoined({ peerId: offer.peerId });
    room.handlers.onFileOffer(offer);
    const [card] = room.rows();
    const [row] = room.el('transfers').children;
    card.querySelector('[data-action="accept"]').click();
    room.handlers.onFileProgress({ ...offer, direction: 'receive', bytes: 3 });
    room.handlers.onPeerLeft({ peerId: offer.peerId });
    room.handlers.onFileFailed({ ...offer, direction: 'receive', reason: 'peer left', retryable: true });
    assert.equal(card.querySelector('[data-action="retry"]').textContent, 'Sender offline');
    assert.equal(card.querySelector('[data-action="retry"]').disabled, true);
    assert.equal(await room.window.roomActions.run('retry', row), false);

    room.handlers.onPeerJoined({ peerId: 'different-peer' });
    room.handlers.onPeerName({ peerId: 'different-peer', name: 'Sam' });
    assert.equal(card.querySelector('[data-action="retry"]').disabled, true);
    room.handlers.onPeerJoined({ peerId: offer.peerId });
    const button = card.querySelector('[data-action="retry"]');
    assert.equal(button.disabled, false);
    assert.deepEqual([...room.window.menuCore.actionsFor(room.window.roomActions.rowInfo(row))], ['retry']);
    button.click();
    button.click();
    assert.equal(await room.window.roomActions.run('retry', row), false);
    assert.deepEqual(attempts, ['first']);
    assert.equal(card.dataset.state, 'requesting');

    const next = { ...offer, offerId: 'next', retryOf: 'first' };
    room.handlers.onFileOffer(next);
    room.handlers.onFileOffer(next);
    assert.deepEqual(accepted, ['first', 'next']);
    assert.equal(card.dataset.state, 'receiving');
    assert.equal(card.querySelector('progress').value, 0);
    assert.equal(row.querySelector('[data-action="reveal"]'), null);
    room.handlers.onFileDone({ ...next, direction: 'receive', savedName: 'note.txt' });
    await settle();
    assert.equal(card.querySelector('.state-text').textContent, 'Saved as note.txt');
    assert.ok(row.querySelector('[data-action="reveal"]'));
    assert.deepEqual(room.rows(), [card]);
    assert.deepEqual(room.el('transfers').children, [row]);
});

test('room offer groups list every recipient and distinguish delivery, legacy sends, decline and failure', async () => {
    const room = await loadRoomWindow();
    const recipients = ['one', 'two', 'three', 'four'];
    const offer = { offerId: 'group', name: 'plans.txt', size: 12, peers: 4, recipients };
    room.window.asscrack.offerFile = async () => {
        room.handlers.onFileRefused({ offerId: offer.offerId, peerId: 'two' });
        return offer;
    };
    for (const peerId of recipients) {
        room.handlers.onPeerJoined({ peerId });
        room.handlers.onPeerName({ peerId, name: 'Sam' });
    }
    const picker = room.el('file-input');
    picker.files = [{ name: 'plans.txt' }];
    picker.dispatchEvent(new room.Event('change'));
    room.el('send-file').click();
    await settle();
    const [head, ...rows] = room.el('transfers').children;
    assert.deepEqual(rows.map(el => el.dataset.peerId), recipients);
    assert.equal(rows[1].querySelector('.file-name').textContent, offer.name);
    assert.match(head.querySelector('.offer-summary').textContent, /3 waiting/);
    const event = { direction: 'send', offerId: offer.offerId };
    room.handlers.onFileDone({ ...event, peerId: 'one', confirmed: true });
    room.handlers.onFileDone({ ...event, peerId: 'three', confirmed: false });
    room.handlers.onFileFailed({ ...event, peerId: 'four', reason: 'peer left' });
    assert.equal(head.querySelector('.offer-summary').textContent, '1 delivered · 1 declined · 1 sent (unconfirmed) · 1 failed');
    assert.deepEqual(rows.map(el => el.querySelector('.peer-name').textContent), recipients.map(id => `to Sam (${id})`));
    assert.equal(head.querySelector('[data-action="cancel-offer"]').hidden, true);
    assert.equal(room.rows().length, 0);
    const toggle = head.querySelector('.offer-toggle');
    toggle.click();
    assert.ok(rows.every(row => row.hidden));
    toggle.click();
    assert.ok(rows.every(row => !row.hidden));
});

test('the file picker keeps the selected buddy distinct from the room after a disconnect', async () => {
    const room = await loadRoomWindow();
    const sent = [];
    room.window.asscrack.offerFile = async (file, recipientId) => {
        sent.push(recipientId);
        return { name: file.name, size: 12, peers: 1, recipients: [recipientId ?? 'peer-22222222'], offerId: String(sent.length) };
    };
    const selected = 'peer-11111111';
    for (const peerId of [selected, 'peer-22222222']) {
        room.handlers.onPeerJoined({ peerId });
        room.handlers.onPeerName({ peerId, name: 'Sam' });
    }
    const recipient = room.el('file-recipient');
    const buddies = recipient.children.slice(1);
    assert.deepEqual(buddies.map(option => option.textContent), ['Sam (11111111)', 'Sam (22222222)']);
    const send = async () => {
        room.el('file-input').files = [{ name: 'plans.txt' }];
        room.el('file-input').dispatchEvent(new room.Event('change'));
        room.el('send-file').click();
        await settle();
    };
    recipient.value = selected;
    await send();
    assert.deepEqual(sent, [selected]);
    assert.match(room.el('transfers').firstElementChild.querySelector('.state-text').textContent, /Sam \(11111111\)/);
    room.handlers.onPeerLeft({ peerId: selected });
    assert.equal(recipient.value, selected);
    await send();
    assert.deepEqual(sent, [selected]);
    assert.match(room.el('status').textContent, /Recipient is offline/);
    assert.equal(room.el('file-draft-name').textContent, 'plans.txt');
    recipient.value = 'room';
    await send();
    assert.deepEqual(sent, [selected, undefined]);
});

test('a dropped file waits for Send file, survives offer failure, and can be removed independently of text', async () => {
    const room = await loadRoomWindow();
    const file = { name: 'game.cfg', size: 3 };
    const drop = (where, files, types = ['Files']) => {
        const event = new room.Event('drop', { dataTransfer: { files, types } });
        room.el(where).dispatchEvent(event);
        return event;
    };
    room.el('message-input').value = 'unsent room message';
    assert.equal(drop('message-input', [], ['text/plain']).defaultPrevented, false);
    assert.equal(drop('peers', [file]).defaultPrevented, true);
    assert.equal(room.el('file-draft').hidden, true);
    assert.equal(drop('messages', [file]).defaultPrevented, true);
    assert.equal(room.el('file-draft-name').textContent, file.name);
    drop('composer', [file, { name: 'extra.txt' }]);
    assert.equal(room.el('file-draft-name').textContent, file.name);
    assert.equal(room.el('file-draft').hidden, false);
    assert.equal(room.el('transfers').children.length, 0);
    const calls = [];
    room.window.asscrack.offerFile = async f => {
        calls.push(f);
        if (calls.length === 1) throw new Error('File could not be read');
        return { offerId: 'offer', peers: 0, name: f.name, size: f.size };
    };
    for (const message of [/could not be read/, /No one received the file/]) {
        room.el('send-file').click();
        room.el('send-file').click();
        await settle();
        assert.match(room.el('status').textContent, message);
        assert.equal(room.el('file-draft').hidden, false);
    }
    assert.deepEqual(calls, [file, file]);
    room.el('file-remove').click();
    assert.equal(room.el('file-draft').hidden, true);
    assert.equal(room.document.activeElement, room.el('attach-file'));
    assert.equal(room.el('message-input').value, 'unsent room message');
    assert.equal(room.el('transfers').children.length, 0);
});

// ---- Package C (room window): row actions, context menus, Escape, Show in Explorer ----

test('main.js records the receive path of file-done by offerId|peerId and checks that the file exists', async () => {
    const source = await read('main.js');
    assert.ok(source.includes("node.events.on('file-done'"));
    assert.ok(source.includes("data?.direction !== 'receive'"));
    assert.ok(source.includes('receivedFiles.set(`${data.offerId}|${data.peerId}`, data.path)'));
    assert.ok(source.includes("handleRoomIpc('asscrack:reveal-file'"));
    const handler = source.slice(source.indexOf("handleRoomIpc('asscrack:reveal-file'"));
    const existsAt = handler.indexOf('existsSync(filePath)');
    const revealAt = handler.indexOf('shell.showItemInFolder(filePath)');
    assert.ok(existsAt > 0 && revealAt > existsAt, 'existsSync must come before showItemInFolder');
    assert.ok(handler.includes("reason: 'missing'"));
    assert.ok(handler.includes("reason: 'unknown'"));
    // The handler takes the key only. The path comes from the map of main.js.
    assert.ok(handler.includes('const filePath = receivedFiles.get(key)'));
    assert.match(source, /const \{ path: localPath, \.\.\.event \} = data;[\s\S]+sendToWindow\('asscrack:file-done', \{ \.\.\.event, savedName \}\)/);
});

// A code rule, not a behavior: renderer.js has one Escape listener. test/room-escape.test.mjs checks the sequence of
// the layers. This rule also stops a new layer that comes with its own Escape listener.
test('renderer.js has one Escape dispatcher', async () => {
    const source = await read('renderer.js');
    const escapes = source.match(/e\.key === 'Escape'|e\.key !== 'Escape'/g) ?? [];
    assert.equal(escapes.length, 1, 'one Escape listener only');
});

test('the row buttons and the menus call the same action functions', async () => {
    const source = await read('renderer.js');
    for (const [action, fn] of [['accept', 'acceptTransfer'], ['refuse', 'refuseTransfer'], ['cancel-receive', 'cancelReceive'],
        ['cancel-receiver', 'cancelToReceiver'], ['cancel-offer', 'cancelWholeOffer'], ['reveal', 'revealTransfer']]) {
        assert.ok(source.includes(`case '${action}': return ${fn}(`), `menu action ${action}`);
        assert.match(source, new RegExp(`makeButton\\([^\\n]*${fn}\\([^\\n]*'${action}'`), `button ${action}`);
    }
    // The cancel of one receiver sends the offer ID and the peer ID of the row.
    assert.ok(source.includes('window.asscrack.cancelFile(entry.item.dataset.offerId, entry.item.dataset.peerId)'));
});

test('nodemap.js highlights a node by peer ID with a data attribute', async () => {
    const source = await read('nodemap.js');
    assert.ok(source.includes('window.nodeMap = { update, highlight, select }'));
    assert.ok(source.includes("node.group.setAttribute('data-highlight', 'true')"));
    assert.ok(source.includes('highlight() { return false; }'));
});

test('menu.js, renderer.js and nodemap.js set no inline style', async () => {
    for (const name of ['menu.js', 'renderer.js', 'nodemap.js']) {
        const source = await read(name);
        assert.doesNotMatch(source, /\.style\.(?!setProperty)\w+\s*=|setAttribute\('style'|\.style\s*=/, name);
    }
});

// menuCore: the pure part of menu.js, loaded in node:vm with no DOM.
async function loadMenuCore() {
    const source = await read('menu.js');
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'menu.js' });
    return context;
}

test('menu.js loads with no DOM and gives menuCore only', async () => {
    const context = await loadMenuCore();
    assert.equal(typeof context.window.menuCore, 'object');
    assert.equal(context.window.contextMenu, undefined);
});

test('menuCore.actionsFor gives the actions of each target', async () => {
    const { actionsFor } = (await loadMenuCore()).window.menuCore;
    const list = info => [...actionsFor(info)];
    assert.deepEqual(list({ kind: 'buddy', self: true, onMap: true }), ['copy-name', 'show-on-map']);
    assert.deepEqual(list({ kind: 'buddy', self: true, onMap: false }), ['copy-name']);
    assert.deepEqual(list({ kind: 'message' }), ['copy-message']);
    assert.deepEqual(list({ kind: 'transfer', direction: 'receive', state: 'offered' }), ['accept', 'refuse']);
    assert.deepEqual(list({ kind: 'transfer', direction: 'receive', state: 'receiving' }), ['cancel-receive']);
    assert.deepEqual(list({ kind: 'transfer', direction: 'receive', state: 'receiving', cancelRequested: true }), []);
    assert.deepEqual(list({ kind: 'transfer', direction: 'receive', state: 'done', revealable: true }), ['reveal']);
    assert.deepEqual(list({ kind: 'transfer', direction: 'receive', state: 'done', revealable: false }), []);
    assert.deepEqual(list({ kind: 'transfer', direction: 'send', state: 'sending' }), ['cancel-receiver']);
    assert.deepEqual(list({ kind: 'transfer', direction: 'send', state: 'offered' }), ['cancel-receiver']);
    assert.deepEqual(list({ kind: 'offer', active: true }), ['cancel-offer']);
    assert.deepEqual(list({ kind: 'offer', active: false }), []);
    assert.deepEqual(list(null), []);
});

test('menuCore.allowed stops a stale action after the transfer completed', async () => {
    const { allowed } = (await loadMenuCore()).window.menuCore;
    for (const state of ['done', 'failed', 'cancelled', 'refused']) {
        assert.equal(allowed('cancel-receive', { kind: 'transfer', direction: 'receive', state }), false, state);
        assert.equal(allowed('accept', { kind: 'transfer', direction: 'receive', state }), false, state);
        assert.equal(allowed('cancel-receiver', { kind: 'transfer', direction: 'send', state }), false, state);
    }
    assert.equal(allowed('reveal', { kind: 'transfer', direction: 'send', state: 'done', revealable: true }), false);
    assert.equal(allowed('cancel-receiver', { kind: 'transfer', direction: 'send', state: 'sending', cancelRequested: true }), false);
    assert.equal(allowed('accept', null), false);
});

test('menuCore keys and position', async () => {
    const { nextIndex, clampPosition, isMenuKey } = (await loadMenuCore()).window.menuCore;
    assert.equal(nextIndex(-1, 3, 'ArrowDown'), 0);
    assert.equal(nextIndex(2, 3, 'ArrowDown'), 0);
    assert.equal(nextIndex(0, 3, 'ArrowUp'), 2);
    assert.equal(nextIndex(1, 3, 'Home'), 0);
    assert.equal(nextIndex(1, 3, 'End'), 2);
    assert.equal(nextIndex(1, 3, 'Enter'), -1);
    assert.equal(nextIndex(0, 0, 'ArrowDown'), -1);
    assert.equal(isMenuKey('ContextMenu', false), true);
    assert.equal(isMenuKey('F10', true), true);
    assert.equal(isMenuKey('F10', false), false);
    assert.deepEqual({ ...clampPosition(790, 590, 160, 60, 800, 600) }, { x: 636, y: 536 });
    assert.deepEqual({ ...clampPosition(-20, 10, 160, 60, 800, 600) }, { x: 4, y: 10 });
    assert.deepEqual({ ...clampPosition(NaN, 10, 160, 60, 100, 600) }, { x: 4, y: 10 });
});

// ---- Milestone 2: Quote and Find ----

// A code rule: no inline style. test/room-escape.test.mjs checks that find.js and quote.js close no layer on Escape.
test('find.js and quote.js set no inline style', async () => {
    for (const name of ['find.js', 'quote.js']) {
        const source = await read(name);
        assert.doesNotMatch(source, /\.style\b|setAttribute\('style'/, name);
    }
});

test('index.html loads find.js and quote.js before renderer.js, and has the find bar and the quote chip', async () => {
    const html = await read('index.html');
    const at = name => html.indexOf(`<script src="${name}"></script>`);
    assert.ok(at('reading.js') < at('find.js') && at('find.js') < at('renderer.js'));
    assert.ok(at('quote.js') > 0 && at('quote.js') < at('renderer.js'));
    for (const id of ['find-bar', 'find-input', 'find-count', 'find-prev', 'find-next', 'find-close', 'quote-chip', 'quote-remove']) {
        assert.ok(html.includes(`id="${id}"`), id);
    }
    assert.doesNotMatch(html, /\sstyle=/);
});

test('menuCore gives Quote for a quotable message line', async () => {
    const { actionsFor, allowed, label } = (await loadMenuCore()).window.menuCore;
    assert.deepEqual([...actionsFor({ kind: 'message', quotable: true })], ['quote', 'copy-message']);
    assert.deepEqual([...actionsFor({ kind: 'message', quotable: false })], ['copy-message']);
    assert.equal(allowed('quote', { kind: 'message' }), false);
    assert.equal(label('quote'), 'Quote');
});

test('each progress bar reports its own percentage when another recipient cancels', async () => {
    const room = await loadRoomWindow();
    const offer = { offerId: 'shared', direction: 'send', name: 'plans.txt', size: 10 };
    room.handlers.onFileProgress({ ...offer, peerId: 'a', bytes: 5 });
    room.handlers.onFileProgress({ ...offer, peerId: 'b', bytes: 2 });
    room.handlers.onFileCancelled({ ...offer, peerId: 'b' });
    const rows = room.el('transfers').children;
    assert.deepEqual(rows.map(row => [
        row.querySelector('.progress-cell').dataset.pct,
        row.querySelector('progress').getAttribute('aria-valuetext'),
        row.querySelector('.state-text').textContent
    ]), [['50%', '50%', 'Sending'], ['20%', '20%', 'Cancelled']]);
});

test('message details show the local archive fact for the selected message only', async () => {
    const room = await loadRoomWindow({ send: async () => ({ saved: true, id: 'saved', time: 123, accepted: 1 }) });
    await room.login('Me');
    const dialog = room.el('message-details');
    dialog.showModal = () => { dialog.open = true; };
    room.el('message-input').value = 'saved text';
    room.el('send').click();
    await settle();
    const saved = room.rows()[0];
    const other = room.receive({ from: 'Sam', text: 'other', peerId: 'sam', id: 'other' });
    for (const [row, fact] of [[saved, 'Saved'], [other, 'Not saved']]) {
        const info = room.window.roomActions.rowInfo(row);
        assert.ok(room.window.menuCore.actionsFor(info).includes('message-details'));
        assert.equal(row.querySelector('.saved-mark'), null);
        assert.equal(room.window.roomActions.run('message-details', row), true);
        assert.equal(room.el('message-detail-archive').textContent, fact);
        assert.equal(room.el('message-detail-author').textContent, row.querySelector('.from').textContent);
        dialog.open = false;
    }
});

test('the self orb opens availability editing and focuses the state selector', async () => {
    const room = await loadRoomWindow();
    await room.login('Me');
    const dialog = room.el('availability-dialog');
    dialog.showModal = () => { dialog.open = true; };
    const row = room.el('peers').children.find(li => li.classList.contains('self'));
    row.querySelector('button.avatar').click();
    assert.equal(dialog.open, true);
    assert.equal(room.document.activeElement, room.el('presence-state'));
});
