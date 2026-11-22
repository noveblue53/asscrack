// One data folder (src/application/data-folder.mjs): the selection of the folder, the probe, and the one move of the
// old data with fake folders. Electron does not start. The real %APPDATA% is never used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    chooseDataFolder, cleanHoldFolders, dataPaths, downloadOwner, holdFolder, INSTALLED_FOLDER, KEPT_MARKER, legacyFolder, moveOldData,
    needsMove, notWritableText, PORTABLE_FOLDER, probeWritable, writeKeptMarker
} from '../src/application/data-folder.mjs';
import { UNINSTALLER_NAME } from '../src/application/start-at-sign-in.mjs';
import { createDownloadScratch } from '../src/application/download-scratch.mjs';

const root = new URL('..', import.meta.url);
const INSTALLED = 'D:\\Apps\\ASSCRACK\\ASSCRACK.exe';
const UNPACKED = 'C:\\Users\\u\\AppData\\Local\\Temp\\ASSCRACK\\ASSCRACK.exe';
const base = { argv: ['ASSCRACK.exe'], env: {}, isPackaged: true, platform: 'win32', execPath: INSTALLED, exists: () => false };

function scratch(t) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'asscrack-data-folder-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('the portable build uses the folder next to the .exe, not the unpack folder of the process', () => {
    const got = chooseDataFolder({ ...base, execPath: UNPACKED,
        env: { PORTABLE_EXECUTABLE_DIR: 'E:\\Games', PORTABLE_EXECUTABLE_FILE: 'E:\\Games\\ASSCRACK-1.0.0-portable.exe' } });
    assert.deepEqual(got, { kind: 'portable', dir: `E:\\Games\\${PORTABLE_FOLDER}` });
    // build/portable.nsi really sets the variable.
    assert.match(readFileSync(new URL('build/portable.nsi', root), 'utf8'), /"PORTABLE_EXECUTABLE_DIR", "\$EXEDIR"/);
});

test('the installed build uses the data folder in the install folder', () => {
    const exists = file => file === path.join(path.dirname(INSTALLED), UNINSTALLER_NAME);
    assert.deepEqual(chooseDataFolder({ ...base, exists }), { kind: 'installed', dir: `D:\\Apps\\ASSCRACK\\${INSTALLED_FOLDER}` });
});

test('npm start and a copy of win-unpacked keep the Electron default, and --profile overrides each case', () => {
    assert.deepEqual(chooseDataFolder({ ...base, isPackaged: false }), { kind: 'default', dir: null });
    assert.deepEqual(chooseDataFolder({ ...base, isPackaged: false, env: { PORTABLE_EXECUTABLE_DIR: 'E:\\x' } }),
        { kind: 'default', dir: null });
    assert.deepEqual(chooseDataFolder(base), { kind: 'default', dir: null }, 'no uninstaller, no portable launcher');
    const argv = ['ASSCRACK.exe', '--profile', 'p1'];
    const exists = () => true;
    for (const extra of [{}, { isPackaged: false }, { env: { PORTABLE_EXECUTABLE_DIR: 'E:\\x' } }, { exists }]) {
        assert.deepEqual(chooseDataFolder({ ...base, ...extra, argv, resolve: p => `R:\\${p}` }), { kind: 'profile', dir: 'R:\\p1' });
    }
});

test('each Electron path is in the data folder', () => {
    const dir = path.join('E:', 'x', PORTABLE_FOLDER);
    for (const value of Object.values(dataPaths(dir))) assert.ok(value === dir || value.startsWith(dir + path.sep), value);
    assert.deepEqual(Object.keys(dataPaths(dir)).sort(), ['crashDumps', 'logs', 'sessionData', 'userData']);
});

test('the probe makes the folder and leaves no file, and a refused folder gives a text with the path', t => {
    const dir = path.join(scratch(t), 'new', PORTABLE_FOLDER);
    assert.deepEqual(probeWritable(dir), { ok: true });
    assert.deepEqual(readdirSync(dir), []);
    const refused = { ...fs, writeFileSync() { const e = new Error('no'); e.code = 'EPERM'; throw e; } };
    assert.deepEqual(probeWritable(dir, refused), { ok: false, error: 'EPERM' });
    const text = notWritableText('C:\\Program Files\\ASSCRACK\\data', 'EPERM');
    assert.ok(text.includes('C:\\Program Files\\ASSCRACK\\data') && text.includes('EPERM'));
});

test('the old folder comes from APPDATA of the process first (a test gives a fake folder)', () => {
    assert.equal(legacyFolder({ env: { APPDATA: 'F:\\fake' }, appData: 'C:\\real' }), path.join('F:\\fake', 'ASSCRACK'));
    assert.equal(legacyFolder({ env: {}, appData: 'C:\\real' }), path.join('C:\\real', 'ASSCRACK'));
});

function oldData(dir) {
    mkdirSync(path.join(dir, 'saved-rooms'), { recursive: true });
    mkdirSync(path.join(dir, 'rooms'), { recursive: true });
    writeFileSync(path.join(dir, 'Local State'), '{"os_crypt":{"encrypted_key":"x"}}');
    writeFileSync(path.join(dir, 'saved-rooms', 'archive.db'), Buffer.from([1, 2, 3, 4, 5]));
    writeFileSync(path.join(dir, 'saved-rooms', 'archive.key'), 'key');
    writeFileSync(path.join(dir, 'rooms', 'abc.json'), '[]');
}

test('the move is offered only for a new empty folder when the old folder has data', t => {
    const s = scratch(t);
    const legacy = path.join(s, 'appdata', 'ASSCRACK');
    const dir = path.join(s, 'a', PORTABLE_FOLDER);
    assert.equal(needsMove({ dir, legacy }), false, 'no old folder');
    mkdirSync(legacy, { recursive: true });
    assert.equal(needsMove({ dir, legacy }), false, 'empty old folder');
    oldData(legacy);
    assert.equal(needsMove({ dir, legacy }), true, 'no new folder');
    mkdirSync(dir, { recursive: true });
    assert.equal(needsMove({ dir, legacy }), true, 'empty new folder');
    writeKeptMarker(dir, legacy);
    assert.ok(existsSync(path.join(dir, KEPT_MARKER)));
    assert.equal(needsMove({ dir, legacy }), false, 'Keep there: no second question');
    assert.equal(needsMove({ dir: legacy.toUpperCase(), legacy }), false, 'the same folder');
    assert.equal(needsMove({ dir: path.join(legacy, 'sub'), legacy }), false, 'a folder in the old folder');
});

test('Move copies, checks and removes the old folder', t => {
    const s = scratch(t);
    const legacy = path.join(s, 'appdata', 'ASSCRACK');
    const dir = path.join(s, 'a', PORTABLE_FOLDER);
    oldData(legacy);
    mkdirSync(dir, { recursive: true });
    const result = moveOldData({ from: legacy, to: dir, suffix: 't1' });
    assert.deepEqual(result, { ok: true, files: 4, bytes: 34 + 5 + 3 + 2, leftover: null });
    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(`${legacy}.moving-t1`), false);
    assert.deepEqual(readFileSync(path.join(dir, 'saved-rooms', 'archive.db')), Buffer.from([1, 2, 3, 4, 5]));
    assert.equal(readFileSync(path.join(dir, 'Local State'), 'utf8'), '{"os_crypt":{"encrypted_key":"x"}}');
    assert.equal(needsMove({ dir, legacy }), false);
});

test('a failed copy check removes the copy and keeps the old folder as it was', t => {
    const s = scratch(t);
    const legacy = path.join(s, 'appdata', 'ASSCRACK');
    const dir = path.join(s, 'a', PORTABLE_FOLDER);
    oldData(legacy);
    // A bad copy: one file of the new folder has other bytes.
    const bad = { ...fs, cpSync(from, to, options) {
        fs.cpSync(from, to, options);
        writeFileSync(path.join(to, 'rooms', 'abc.json'), '[1]');
    } };
    const result = moveOldData({ from: legacy, to: dir, fsx: bad, suffix: 't2' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'copy-failed');
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(readFileSync(path.join(legacy, 'rooms', 'abc.json'), 'utf8'), '[]');
    assert.equal(existsSync(`${legacy}.moving-t2`), false);
});

test('an old folder in use (the rename fails) does not change, and a full new folder is never written', t => {
    const s = scratch(t);
    const legacy = path.join(s, 'appdata', 'ASSCRACK');
    const dir = path.join(s, 'a', PORTABLE_FOLDER);
    oldData(legacy);
    const busy = { ...fs, renameSync() { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } };
    assert.deepEqual(moveOldData({ from: legacy, to: dir, fsx: busy }), { ok: false, reason: 'in-use', error: 'EBUSY' });
    assert.ok(existsSync(path.join(legacy, 'saved-rooms', 'archive.db')));
    assert.deepEqual(moveOldData({ from: path.join(s, 'none'), to: dir }).reason, 'gone');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'x'), '');
    assert.equal(moveOldData({ from: legacy, to: dir }).reason, 'target-not-empty');
    assert.ok(existsSync(path.join(legacy, 'saved-rooms', 'archive.db')));
});

test('the hold folders of stopped runs are removed, the folders of running copies stay', t => {
    const s = scratch(t);
    for (const pid of [11, 22, 33]) mkdirSync(holdFolder(s, pid));
    mkdirSync(path.join(s, 'other'));
    cleanHoldFolders(s, { alive: pid => pid === 22, own: 33 });
    assert.deepEqual(readdirSync(s).sort(), ['ASSCRACK-hold-22', 'ASSCRACK-hold-33', 'other']);
});

test('main.js sets each path before ready, keeps --profile, and offers the move in a hold run', () => {
    const source = readFileSync(new URL('src/application/main.js', root), 'utf8');
    const select = source.indexOf('chooseDataFolder(');
    assert.ok(select !== -1 && select < source.indexOf('requestSingleInstanceLock'));
    assert.ok(select < source.indexOf("app.getPath('userData')"));
    for (const call of ["app.setPath('userData'", "app.setPath('sessionData'", 'app.setAppLogsPath(', "app.setPath('crashDumps'"]) {
        assert.ok(source.includes(call), call);
    }
    assert.ok(source.includes('dialog.showErrorBox('));
    assert.ok(source.includes('startEntry.repair('));
});

test('the uninstaller keeps the data folder at an update and at an uninstall', () => {
    const nsh = readFileSync(new URL('build/installer.nsh', root), 'utf8');
    assert.match(nsh, /!macro customRemoveFiles/);
    assert.match(nsh, /StrCmp \$R2 "data"/);
});

test('saved rooms of an other Windows account or computer show a plain text, not a reason code', () => {
    const source = readFileSync(new URL('src/application/saved-rooms-ui.js', root), 'utf8');
    assert.match(source, /result\.reason === 'key-unwrap-failed'[\s\S]{0,200}an other Windows user account or an other computer/);
});

test('the move works with the cpSync of Electron 45, which refuses an existing empty target folder', t => {
    const s = scratch(t);
    const legacy = path.join(s, 'appdata', 'ASSCRACK');
    const dir = path.join(s, 'a', PORTABLE_FOLDER);
    oldData(legacy);
    mkdirSync(dir, { recursive: true });
    const electronCp = { ...fs, cpSync(from, to, options) {
        if (options?.errorOnExist && existsSync(to)) {
            const e = new Error(`Target already exists: cp returned EEXIST (${to} already exists)`);
            e.code = 'ERR_FS_CP_EEXIST';
            throw e;
        }
        fs.cpSync(from, to, options);
    } };
    const result = moveOldData({ from: legacy, to: dir, fsx: electronCp, suffix: 't3' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(readFileSync(path.join(dir, 'rooms', 'abc.json'), 'utf8'), '[]');
    assert.equal(existsSync(legacy), false);
});

// A paused partial (P7c) in the download scratch of a run that stopped. dead: the process ID of that run.
function pausedPartial(downloads, owner, dead) {
    const scratchOf = createDownloadScratch(downloads, owner, { pid: dead, alive: () => false });
    const name = `.asscrack-resume-${'a'.repeat(64)}-5.part`;
    writeFileSync(path.join(scratchOf.directory, name), 'hello');
    return name;
}

test('the paused partials in the download folder stay with a data folder that moved on the same PC', t => {
    const s = scratch(t);
    const downloads = path.join(s, 'Downloads');
    const a = path.join(s, 'a', PORTABLE_FOLDER);
    mkdirSync(a, { recursive: true });
    const name = pausedPartial(downloads, downloadOwner(a, a), 1001);
    const b = path.join(s, 'b', PORTABLE_FOLDER);
    fs.renameSync(path.join(s, 'a'), path.join(s, 'b'));
    const next = createDownloadScratch(downloads, downloadOwner(b, b), { pid: 1002, alive: pid => pid === 1002 });
    assert.equal(readFileSync(path.join(next.directory, name), 'utf8'), 'hello', 'the new run adopts the partial');
    assert.deepEqual(readdirSync(downloads), [path.basename(next.directory)], 'the old scratch folder is gone');
});

test('after Move the new folder owns the paused partials of the old version', t => {
    const s = scratch(t);
    const downloads = path.join(s, 'Downloads');
    const legacy = path.join(s, 'appdata', 'ASSCRACK');
    oldData(legacy);
    // The old version used its user data path as the owner text.
    const name = pausedPartial(downloads, legacy, 2001);
    const dir = path.join(s, 'a', PORTABLE_FOLDER);
    assert.equal(moveOldData({ from: legacy, to: dir }).ok, true);
    assert.equal(downloadOwner(dir, legacy), legacy);
    const next = createDownloadScratch(downloads, downloadOwner(dir, dir), { pid: 2002, alive: pid => pid === 2002 });
    assert.equal(readFileSync(path.join(next.directory, name), 'utf8'), 'hello');
    // A new data folder with no owner file gets its own path: the folders of the current versions keep their hash.
    const fresh = path.join(s, 'fresh');
    mkdirSync(fresh);
    assert.equal(downloadOwner(fresh, fresh), fresh);
    assert.equal(downloadOwner(fresh, 'other'), fresh);
});

test('main.js gives the download scratch the owner text of the data folder', () => {
    const source = readFileSync(new URL('src/application/main.js', root), 'utf8');
    assert.match(source, /createDownloadScratch\(options\.downloadDir, downloadOwner\(app\.getPath\('userData'\)/);
    assert.match(source, /if \(result\.ok\) downloadOwner\(to, defaultUserData\)/);
    assert.ok(source.indexOf("const defaultUserData = app.getPath('userData')") < source.indexOf("app.setPath('userData'"));
});
