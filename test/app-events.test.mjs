// Source checks for the event path from the network node to the window. Electron does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = name => readFile(new URL(`../src/application/${name}`, import.meta.url), 'utf8');

test('main.js forwards the history event', async () => {
    const source = await read('main.js');
    const match = source.match(/const EVENTS = \[([^\]]*)\]/);
    assert.ok(match, 'EVENTS not found in main.js');
    assert.match(match[1], /'history'/);
});

test('preload.cjs exposes onHistory', async () => {
    const source = await read('preload.cjs');
    assert.ok(source.includes("onHistory: listen('asscrack:history')"));
});

test('renderer.js listens for history', async () => {
    const source = await read('renderer.js');
    assert.ok(source.includes('window.asscrack.onHistory('));
});

test('main.js writes a log file with the window console', async () => {
    const source = await read('main.js');
    assert.ok(source.includes("'console-message'"));
    assert.ok(source.includes("app.getPath('logs')"));
});

test('main.js forwards the topology event', async () => {
    const source = await read('main.js');
    const match = source.match(/const EVENTS = \[([^\]]*)\]/);
    assert.ok(match, 'EVENTS not found in main.js');
    assert.match(match[1], /'topology'/);
    assert.ok(source.includes("ipcMain.handle('asscrack:topology'"));
});

test('preload.cjs exposes onTopology and getTopology', async () => {
    const source = await read('preload.cjs');
    assert.ok(source.includes("onTopology: listen('asscrack:topology')"));
    assert.ok(source.includes("getTopology: () => ipcRenderer.invoke('asscrack:topology')"));
});

test('main.js logs the direction, the cancel side and the file actions', async () => {
    const source = await read('main.js');
    assert.ok(source.includes('parts.push(`direction ${direction}`)'));
    assert.ok(source.includes('parts.push(`by ${by}`)'));
    for (const action of ['offer-file', 'accept-file', 'refuse-file', 'cancel-file']) {
        assert.ok(source.includes(`logAction('${action}'`), action);
    }
});

test('preload.cjs passes a peer ID in cancelFile', async () => {
    const source = await read('preload.cjs');
    assert.ok(source.includes("cancelFile: (offerId, peerId) => ipcRenderer.invoke('asscrack:cancel-file', offerId, peerId)"));
});

// ---- Package C (room window): row actions, context menus, Escape, Show in Explorer ----

test('preload.cjs exposes revealFile by key and no path API for the reveal', async () => {
    const source = await read('preload.cjs');
    assert.ok(source.includes("revealFile: key => ipcRenderer.invoke('asscrack:reveal-file', String(key))"));
    assert.doesNotMatch(source, /showItemInFolder|openPath|shell\./);
    assert.doesNotMatch(source, /reveal\w*\s*:\s*\(?\s*\w*[pP]ath/);
});

test('main.js records the receive path of file-done by offerId|peerId and checks that the file exists', async () => {
    const source = await read('main.js');
    assert.ok(source.includes("node.events.on('file-done'"));
    assert.ok(source.includes("data?.direction !== 'receive'"));
    assert.ok(source.includes('receivedFiles.set(`${data.offerId}|${data.peerId}`, data.path)'));
    assert.ok(source.includes("ipcMain.handle('asscrack:reveal-file'"));
    const handler = source.slice(source.indexOf("ipcMain.handle('asscrack:reveal-file'"));
    const existsAt = handler.indexOf('existsSync(filePath)');
    const revealAt = handler.indexOf('shell.showItemInFolder(filePath)');
    assert.ok(existsAt > 0 && revealAt > existsAt, 'existsSync must come before showItemInFolder');
    assert.ok(handler.includes("reason: 'missing'"));
    assert.ok(handler.includes("reason: 'unknown'"));
    // The handler takes the key only. The path comes from the map of main.js.
    assert.ok(handler.includes('const filePath = receivedFiles.get(key)'));
});

test('renderer.js has one Escape dispatcher in the sequence menu, layout, invite panel, map', async () => {
    const source = await read('renderer.js');
    const escapes = source.match(/e\.key === 'Escape'|e\.key !== 'Escape'/g) ?? [];
    assert.equal(escapes.length, 1, 'one Escape listener only');
    assert.doesNotMatch(source, /if \(e\.key === 'Escape'\) setMapOpen\(false\)/);
    assert.doesNotMatch(source, /if \(e\.key === 'Escape'\) setInvitePanelOpen\(false\)/);
    const at = source.indexOf("e.key !== 'Escape'");
    const order = ['window.contextMenu?.isOpen()', 'window.layout?.closeTopLayer()', 'setInvitePanelOpen(false)', 'setMapOpen(false)']
        .map(text => source.indexOf(text, at));
    for (const index of order) assert.ok(index > at);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('menu.js handles no Escape itself', async () => {
    const source = await read('menu.js');
    assert.doesNotMatch(source, /'Escape'/);
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
    assert.ok(source.includes('window.nodeMap = { update, highlight }'));
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
