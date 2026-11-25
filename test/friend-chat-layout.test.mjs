// The message list of the friend chat window fills the window, also when "Show older messages" is hidden. A real
// Electron window (not shown) loads friend-chat.html and measures it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const electron = createRequire(import.meta.url)('electron');

// Runs in the page: each combination of the older button, the messages and the status line.
function measurePage() {
    const el = id => document.getElementById(id);
    el('friend-name').textContent = 'Mira';
    el('friend-state').textContent = 'Online';
    const out = [];
    for (const older of [false, true]) for (const lines of [0, 60]) for (const status of ['', 'Not sent.']) {
        el('older').hidden = !older;
        el('messages').replaceChildren(...Array.from({ length: lines }, (_, i) => {
            const li = document.createElement('li');
            li.textContent = `line ${i}`;
            return li;
        }));
        el('send-status').textContent = status;
        const box = id => { const r = el(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        out.push({ name: `older ${older}, ${lines} lines, status "${status}"`, height: innerHeight,
            messages: box('messages'), status: box('send-status'), composer: box('composer') });
    }
    return out;
}

// The Electron main script. It is text in a temporary folder because node --test runs each script below test/.
const mainScript = `
const { app, BrowserWindow } = require('electron');
const page = process.argv.at(-1);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    const w = new BrowserWindow({ show: false, width: 420, height: 520 });
    try {
        await w.loadFile(page);
        const result = await w.webContents.executeJavaScript('(' + ${JSON.stringify(measurePage.toString())} + ')()');
        process.stdout.write('RESULT ' + JSON.stringify(result) + '\\n');
    } catch (e) { process.stdout.write('ERROR ' + String(e) + '\\n'); }
    app.exit(0);
});
`;

function measure() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'friend-chat-layout-'));
    const main = path.join(dir, 'main.cjs');
    writeFileSync(main, mainScript);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise((resolve, reject) => {
        execFile(electron, [main, `--user-data-dir=${path.join(dir, 'profile')}`, path.join(root, 'src/application/friend-chat.html')],
            { timeout: 60000, env }, (err, stdout) => {
                rmSync(dir, { recursive: true, force: true });
                const line = stdout.split('\n').find(l => l.startsWith('RESULT '));
                if (!line) return reject(new Error(`no result: ${err ?? ''} ${stdout}`));
                resolve(JSON.parse(line.slice(7)));
            });
    });
}

test('the message list fills the friend chat window and the items do not overlap, in each state', async () => {
    const states = await measure();
    assert.equal(states.length, 8);
    for (const s of states) {
        const text = `${s.name}: ${JSON.stringify(s)}`;
        assert.ok(s.messages.bottom - s.messages.top > s.height * 0.6, `the list is too small, ${text}`);
        assert.ok(s.messages.bottom <= s.status.top + 0.5, `the list overlaps the status line, ${text}`);
        assert.ok(s.status.bottom <= s.composer.top + 0.5, `the status line overlaps the composer, ${text}`);
        assert.ok(s.composer.bottom <= s.height + 0.5, `the composer is outside the window, ${text}`);
    }
});
