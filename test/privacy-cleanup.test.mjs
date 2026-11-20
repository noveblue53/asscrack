import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDownloadScratch } from '../src/application/download-scratch.mjs';
import { clearLegacyDebugLogs } from '../src/application/local-debug.mjs';

test('new download sessions clear dead owned partials and leave live and unrelated files alone', t => {
    const downloads = mkdtempSync(path.join(tmpdir(), 'asscrack-downloads-'));
    t.after(() => rmSync(downloads, { recursive: true, force: true }));
    const profile = path.join(downloads, 'profile');
    const part = '.asscrack-a12d1f58-9cac-4db5-bef0-ebec1f57161c.part';
    const dead = createDownloadScratch(downloads, profile, { pid: 12345, alive: () => true });
    writeFileSync(path.join(dead.directory, part), 'abandoned');
    const live = createDownloadScratch(downloads, profile, { pid: 12346, alive: () => true });
    writeFileSync(path.join(live.directory, part), 'in use');
    writeFileSync(path.join(live.directory, 'notes.txt'), 'unfamiliar');
    const unrelated = `${dead.directory.slice(0, -6)}other0`;
    mkdirSync(unrelated);
    writeFileSync(path.join(unrelated, part), 'not app-owned');
    writeFileSync(path.join(downloads, part), 'previous versions do not have an owner marker');
    writeFileSync(path.join(downloads, 'received.png'), 'verified download');

    const current = createDownloadScratch(downloads, profile, { pid: 12347, alive: pid => pid === 12346 });
    assert.equal(path.dirname(current.directory), downloads);
    assert.equal(existsSync(dead.directory), false);
    assert.equal(existsSync(path.join(live.directory, part)), true);
    assert.equal(existsSync(path.join(unrelated, part)), true);
    assert.equal(existsSync(path.join(downloads, part)), true);
    assert.equal(existsSync(path.join(downloads, 'received.png')), true);
    live.clear();
    assert.equal(existsSync(path.join(live.directory, 'notes.txt')), true);
    current.clear();
    assert.equal(existsSync(current.directory), false);
});

test('cleanup removes old automatic logs while keeping unrelated files and explicit debug captures', t => {
    const logs = mkdtempSync(path.join(tmpdir(), 'asscrack-logs-'));
    t.after(() => rmSync(logs, { recursive: true, force: true }));
    const header = '2026-11-20T15:00:00.000Z INFO ASSCRACK 0.7.0 Electron 40.5.0 args ["app"]\n';
    const old = path.join(logs, 'asscrack-20261120-150000.log');
    const explicit = path.join(logs, 'asscrack-20261120-150000-77.log');
    const unrelated = path.join(logs, 'asscrack-20261120-150001.log');
    writeFileSync(old, header);
    writeFileSync(explicit, header);
    writeFileSync(unrelated, 'unrelated file');
    clearLegacyDebugLogs(logs);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(explicit), true);
    assert.equal(existsSync(unrelated), true);
});
