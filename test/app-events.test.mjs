// Source checks for the event path from the network node to the window. Electron does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
