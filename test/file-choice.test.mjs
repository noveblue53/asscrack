// L8 (P10a, partial fix): the main process checks each file path that the window gives before the file goes to the
// room. A path in a private folder (the profile with the archive and its key files) or a path that is not a regular
// file is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkChosenFile } from '../src/application/file-choice.mjs';

test('a file of the user passes, and a file in a private folder or a folder or a device path is refused', async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ac-choice-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const profile = path.join(dir, 'Profile');
    await mkdir(path.join(profile, 'rooms'), { recursive: true });
    const key = path.join(profile, 'archive.key');
    await writeFile(key, 'wrapped key');
    const mine = path.join(dir, 'holiday.jpg');
    await writeFile(mine, 'jpeg');
    const blocked = [profile];
    assert.equal(checkChosenFile(mine, { blocked }), mine);
    assert.throws(() => checkChosenFile(key, { blocked }), /private folder/);
    // The case of the letters and a dot segment do not hide the profile on Windows.
    if (process.platform === 'win32') {
        assert.throws(() => checkChosenFile(key.toUpperCase(), { blocked }), /private folder/);
    }
    assert.throws(() => checkChosenFile(path.join(profile, 'rooms', '..', 'archive.key'), { blocked }), /private folder/);
    assert.throws(() => checkChosenFile(profile, { blocked: [] }), /Choose a local file/);
    assert.throws(() => checkChosenFile(path.join(dir, 'missing.txt'), { blocked }), /Choose a local file/);
    assert.throws(() => checkChosenFile('relative.txt', { blocked }), /Choose a local file/);
    assert.throws(() => checkChosenFile('//./PhysicalDrive0', { blocked }), /Choose a local file/);
    assert.throws(() => checkChosenFile('//?/C:/Windows/win.ini', { blocked }), /Choose a local file/);
    assert.throws(() => checkChosenFile(mine + '\0x', { blocked }), /Choose a local file/);
    // A link to a file in the profile is refused (the check uses the real path).
    const link = path.join(dir, 'innocent.txt');
    let linked = true;
    try { await symlink(key, link, 'file'); } catch { linked = false; }
    if (linked) assert.throws(() => checkChosenFile(link, { blocked }), /private folder/);
    assert.equal(await readFile(key, 'utf8'), 'wrapped key');
});

test('main.js checks the path of share-file, offer-file and post-media', async () => {
    const source = await readFile(new URL('../src/application/main.js', import.meta.url), 'utf8');
    assert.ok(source.includes('node.publishShelfFile(chosenFile(filePath))'));
    assert.ok(source.includes('node.offerFile(chosenFile(filePath), recipientId)'));
    assert.ok(source.includes('clipboardImages.stage(input) : chosenFile(input)'));
    assert.match(source, /app\.getPath\('userData'\)[^\n]*\n?[^\n]*\.asscrack-release/);
});
