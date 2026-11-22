// Saved rooms (milestone 6 part 2): source checks of main.js (the IPC names) and index.html (the controls). Electron
// does not start. test/preload-bridge.test.mjs and test/saved-rooms-window.test.mjs test the bridge and the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL(`../src/application/${name}`, import.meta.url), 'utf8');

test('main.js has the IPC handlers of part 2 with a roomId check', async () => {
    const source = await read('main.js');
    for (const name of ['saved-room-lines', 'set-keep-history', 'clear-history', 'forget-room']) {
        assert.ok(source.includes(`handleRoomIpc('asscrack:${name}'`), name);
    }
    assert.ok(source.includes("roomId.length <= 128"));
});

test('main.js sends line-saved and save-failed to the window', async () => {
    const source = await read('main.js');
    assert.ok(source.includes("sendToWindow('asscrack:line-saved'"));
    assert.ok(source.includes("sendToWindow('asscrack:save-failed'"));
    assert.ok(source.includes('forgetHints'));
    assert.match(source, /\$\{tag\}\.host\.json/);
});

test('main.js send returns saved and saveError with the record', async () => {
    const source = await read('main.js');
    assert.ok(source.includes('return { ...record, ...save };'));
});

test('index.html has the room storage controls', async () => {
    const source = await read('index.html');
    assert.match(source, /<header id="room-heading">[\s\S]*?<h1 id="chat-room"><\/h1>[\s\S]*?<button id="invite-toggle"[\s\S]*?<\/header>/);
    assert.match(source, /<button id="history-toggle"[^>]+popovertarget="room-storage"/);
    for (const id of ['room-storage', 'room-keep-history', 'history-state', 'clear-history', 'clear-confirm',
        'clear-confirm-yes', 'clear-confirm-no']) {
        assert.ok(source.includes(`id="${id}"`), id);
    }
});

test('a page already returned by the archive cannot restore saved marks after Clear', async () => {
    const { createDom } = await import('./helpers/fake-dom.mjs');
    const { runInNewContext } = await import('node:vm');
    const html = await read('index.html');
    const { document, window } = createDom([...html.matchAll(/\bid="([^"]+)"/g)].map(m => ({ id: m[1] })));
    const el = id => document.getElementById(id);
    const page = Promise.withResolvers();
    const marked = new Set();
    let reads = 0;
    let clears = 0;
    window.asscrack = {
        listSavedRooms: async () => ({ state: 'open', rooms: [] }),
        savedRoomLines: () => { reads++; return page.promise; },
        clearHistory: async () => { clears++; return { cleared: 1 }; },
        onPeerJoined() {}, onPeerLeft() {}, onLineSaved() {}, onSaveFailed() {}
    };
    window.reading = { keepPosition: fn => fn(), followLatest() {} };
    window.readingCore = { newHistoryLines: lines => lines };
    runInNewContext(await read('saved-rooms-ui.js'), {
        document, window, status: el('status'), roomTypeSelect: el('room-type'), messageList: el('messages'),
        peerItems: new Map(), savedMessageIds: marked, clearSavedMarks: () => marked.clear(), insertMessage() {}
    });
    window.savedRoomsUi.roomStarted({ savedRoom: true, roomId: 'r' });
    assert.equal(reads, 1);
    el('clear-confirm-yes').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clears, 1);
    page.resolve([{ id: 'stale', text: 'deleted' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(marked.has('stale'), false);
    assert.equal(el('messages').dataset.older, 'none');
});
