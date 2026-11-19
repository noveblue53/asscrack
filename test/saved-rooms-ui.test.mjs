// Saved rooms (milestone 6 part 2): source checks for the IPC names, the preload functions and the window events.
// Electron does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL(`../src/application/${name}`, import.meta.url), 'utf8');

test('main.js has the IPC handlers of part 2 with a roomId check', async () => {
    const source = await read('main.js');
    for (const name of ['saved-room-lines', 'set-keep-history', 'clear-history', 'forget-room']) {
        assert.ok(source.includes(`ipcMain.handle('asscrack:${name}'`), name);
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

test('preload.cjs exposes the part 2 functions', async () => {
    const source = await read('preload.cjs');
    for (const name of ['savedRoomLines', 'setKeepHistory', 'clearHistory', 'forgetRoom']) {
        assert.match(source, new RegExp(`\\b${name}: `), name);
    }
    assert.ok(source.includes("onLineSaved: listen('asscrack:line-saved')"));
    assert.ok(source.includes("onSaveFailed: listen('asscrack:save-failed')"));
    assert.ok(source.includes("ipcRenderer.invoke('asscrack:set-keep-history'"));
    assert.ok(source.includes("ipcRenderer.invoke('asscrack:clear-history'"));
    assert.ok(source.includes("ipcRenderer.invoke('asscrack:forget-room'"));
});

test('the window listens for line-saved and save-failed', async () => {
    const source = await read('saved-rooms-ui.js');
    assert.ok(source.includes('api.onLineSaved('));
    assert.ok(source.includes('api.onSaveFailed('));
});

test('index.html has the room storage controls', async () => {
    const source = await read('index.html');
    for (const id of ['room-storage', 'room-keep-history', 'history-state', 'clear-history', 'clear-confirm',
        'clear-confirm-yes', 'clear-confirm-no']) {
        assert.ok(source.includes(`id="${id}"`), id);
    }
});

test('the window marks local-only and saved lines', async () => {
    const source = await read('renderer.js');
    assert.ok(source.includes("'local-only-mark'"));
    assert.ok(source.includes("'Only on this computer'"));
    assert.ok(source.includes("'Saved on this device'"));
    assert.ok(source.includes('It is only in this window.'));
});

test('the login screen has Forget with a confirmation, and the list has paging', async () => {
    const source = await read('saved-rooms-ui.js');
    for (const cls of ['forget-room', 'forget-confirm', 'forget-yes', 'forget-no']) {
        assert.ok(source.includes(`'${cls}'`), cls);
    }
    assert.ok(source.includes('messageList.dataset.older = value'));
    const reading = await read('reading.js');
    assert.ok(reading.includes('keepPosition,'));
});
