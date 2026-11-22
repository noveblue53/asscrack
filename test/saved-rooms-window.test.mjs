// Saved rooms (milestone 6 part 2) in the room window: renderer.js and saved-rooms-ui.js run in the fake DOM
// (test/helpers/renderer-fixture.mjs). The marks of an own line, the line-saved and save-failed events, Forget with a
// confirmation on the login screen, and the paging of older saved lines. These tests replace the source-text checks
// of the window in test/saved-rooms-ui.test.mjs. Electron does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const STORAGE = ['save-room', 'keep-history', 'save-room-fields', 'save-off-note', 'saved-rooms', 'saved-rooms-section',
    'archive-state', 'archive-unlock', 'room-storage', 'history-toggle', 'room-keep-history', 'history-state',
    'clear-history', 'clear-confirm', 'clear-confirm-yes', 'clear-confirm-no'];
const INPUTS = new Set(['save-room', 'keep-history', 'room-keep-history']);

// options.api: bridge calls of the saved rooms. listSavedRooms gives an open archive with options.rooms.
async function savedRoomWindow(options = {}) {
    const f = await loadRoomWindow({
        scripts: ['saved-rooms-ui.js'],
        elements: STORAGE.map(id => ({ id, tag: INPUTS.has(id) ? 'input' : id === 'saved-rooms' ? 'ul' : 'div' })),
        send: options.send,
        api: { listSavedRooms: async () => ({ state: 'open', rooms: options.rooms ?? [] }), ...(options.api ?? {}) }
    });
    await settle();
    const dialog = f.el('message-details');
    dialog.showModal = () => { dialog.open = true; };
    return f;
}

async function sendLine(f, text) {
    f.el('message-input').value = text;
    f.el('send').click();
    await settle();
    return f.rows().at(-1);
}

function archiveFact(f, row) {
    assert.equal(f.window.roomActions.run('message-details', row), true);
    return f.el('message-detail-archive').textContent;
}

test('an own line that no peer accepted gets the local-only mark; an accepted line gets no mark', async () => {
    const records = [{ id: 'm1', time: 1000, accepted: 0 }, { id: 'm2', time: 2000, accepted: 2 }];
    const f = await savedRoomWindow({ send: async () => records.shift() });
    await f.login('Me');
    const alone = await sendLine(f, 'nobody is here');
    const seen = await sendLine(f, 'two peers got this');
    assert.equal(alone.classList.contains('local-only'), true);
    assert.equal(alone.querySelector('.local-only-mark').textContent, 'Only on this computer');
    assert.equal(seen.querySelector('.local-only-mark'), null);
    assert.equal(seen.classList.contains('local-only'), false);
    assert.doesNotMatch(f.el('messages').textContent, /No peer got this message/);
    assert.deepEqual(f.errors, []);
});

test('the line-saved event marks the line as saved; the save-failed event shows the reason', async () => {
    const f = await savedRoomWindow({ send: async () => ({ id: 'm1', time: 1000, accepted: 1 }) });
    await f.login('Me');
    const row = await sendLine(f, 'keep me');
    assert.equal(archiveFact(f, row), 'No local archive copy recorded');
    // The dialog stays open: the fact changes when the main process reports the archive write.
    f.handlers.onLineSaved({ id: 'm1' });
    assert.equal(f.el('message-detail-archive').textContent, 'Saved on this device');
    f.handlers.onSaveFailed({ id: 'm2', reason: 'disk full' });
    assert.equal(f.el('status').textContent, 'Not saved: disk full');
    assert.equal(f.el('history-state').textContent, 'Not saved: disk full');
    assert.deepEqual(f.errors, []);
});

test('Forget room asks first; Cancel keeps the room; Forget room in the confirmation forgets it', async () => {
    const rooms = [{ roomId: 'room-1', name: 'Game night', userName: 'Me', protected: true }];
    const forgotten = [];
    const f = await savedRoomWindow({
        get rooms() { return rooms; },
        api: { forgetRoom: async id => { forgotten.push(id); rooms.length = 0; return { forgotten: true }; } }
    });
    const item = () => f.el('saved-rooms').querySelector('.saved-room');
    assert.ok(item(), 'the saved room is in the list');
    const confirm = item().querySelector('.forget-confirm');
    assert.equal(confirm.hidden, true);

    item().querySelector('.forget-room').click();
    assert.equal(confirm.hidden, false, 'the first click only asks');
    assert.match(confirm.textContent, /Peers keep their copies/);
    assert.deepEqual(forgotten, []);
    assert.equal(f.document.activeElement, confirm.querySelector('.forget-no'), 'the focus goes to Cancel');

    confirm.querySelector('.forget-no').click();
    assert.equal(confirm.hidden, true);
    assert.deepEqual(forgotten, []);
    assert.equal(f.document.activeElement, item().querySelector('.forget-room'));

    item().querySelector('.forget-room').click();
    confirm.querySelector('.forget-yes').click();
    await settle();
    assert.deepEqual(forgotten, ['room-1']);
    assert.equal(item(), null);
    assert.equal(f.el('saved-rooms-section').hidden, true);
    assert.deepEqual(f.errors, []);
});

test('a saved room with a full first page pages older lines at the top of the list until a short page', async () => {
    const line = (n, page) => ({ id: `${page}-${n}`, from: 'Sam', text: `line ${page} ${n}`, time: 100000 + n + (page === 'new' ? 1000 : 0) });
    const pages = [
        Array.from({ length: 200 }, (_, n) => line(n, 'new')),
        Array.from({ length: 3 }, (_, n) => line(n, 'old'))
    ];
    const reads = [];
    const f = await savedRoomWindow({ api: { savedRoomLines: async (roomId, opts) => {
        reads.push([roomId, opts]);
        return pages.shift() ?? [];
    } } });
    f.window.asscrack.login = async value => ({ room: value.room, internet: false, savedRoom: true, roomId: 'room-1' });
    await f.login('Me');
    assert.equal(f.rows().length, 200);
    assert.equal(f.el('messages').dataset.older, 'more', 'a full first page: older lines can exist');

    const list = f.el('messages');
    list.scrollTop = 0;
    list.dispatchEvent(new f.Event('scroll'));
    await settle();
    assert.equal(reads.length, 2);
    assert.deepEqual(reads[1][0], 'room-1');
    assert.deepEqual({ ...reads[1][1].before }, { time: 100000 + 1000, id: 'new-0' }, 'the page before the first line');
    assert.equal(f.rows().length, 203);
    assert.deepEqual(f.rows().slice(0, 4).map(r => r.dataset.id), ['old-0', 'old-1', 'old-2', 'new-0']);
    assert.equal(list.dataset.older, 'none', 'a short page: no more older lines');

    list.dispatchEvent(new f.Event('scroll'));
    await settle();
    assert.equal(reads.length, 2, 'no read after the last page');
    assert.deepEqual(f.errors, []);
});
