// What's new: the notes file src/application/release-notes.json (the one source of the release notes), the decision
// of the card after an update (release-notes.mjs), the note text of the sign script (tools/sign-update.mjs) and the
// window part (whats-new.js, in node:vm with the fake DOM of test/helpers/fake-dom.mjs).
//
// The release check: this file fails when package.json has a version with no notes entry. Add the notes of a new
// version to release-notes.json before the build (docs/RELEASE_UPDATES.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { compareVersions, MAX_NOTES } from '../src/application/update-manifest.mjs';
import { entryFor, FIRST_NOTES_VERSION, hadOldProfile, notesText, readLastSeen, readReleaseNotes, releaseNotesGaps,
    releaseNotesProblems, WHATS_NEW_FILE, whatsNewStart, writeLastSeen } from '../src/application/release-notes.mjs';
import { releaseNotesFor } from '../tools/sign-update.mjs';
import { createDom } from './helpers/fake-dom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const list = readReleaseNotes();
const tempDir = t => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'asscrack-notes-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

test('the notes file is valid: version, date and one-line notes in each entry, newest first, no duplicate', () => {
    assert.deepEqual(releaseNotesProblems(list), []);
    const versions = list.map(entry => entry.version);
    assert.equal(new Set(versions).size, versions.length);
    for (let i = 1; i < list.length; i++) {
        assert.ok(compareVersions(list[i - 1].version, list[i].version) > 0, `${list[i - 1].version} before ${list[i].version}`);
        assert.ok(list[i - 1].date >= list[i].date);
    }
    for (const entry of list) assert.ok(notesText(entry).length <= MAX_NOTES, entry.version);
});

test('release check: the notes file has an entry for the package.json version, from 1.0.0 to that version', () => {
    assert.deepEqual(releaseNotesGaps(list, PACKAGE_VERSION), [],
        `Add the notes of ${PACKAGE_VERSION} to src/application/release-notes.json before the build.`);
    assert.equal(list[0].version, PACKAGE_VERSION);
    assert.equal(list.at(-1).version, FIRST_NOTES_VERSION);
    for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5']) assert.ok(entryFor(list, version), version);
});

test('the release check finds a missing version, a wrong order, a bad date and a long text', () => {
    assert.match(releaseNotesGaps(list, '9.9.9').join(' '), /no entry for 9\.9\.9/);
    const swapped = [list[1], list[0], ...list.slice(2)];
    assert.match(releaseNotesProblems(swapped).join(' '), /newest first/);
    assert.match(releaseNotesProblems([{ ...list[0], date: '2026-13-01' }]).join(' '), /YYYY-MM-DD/);
    assert.match(releaseNotesProblems([{ ...list[0], version: '1.0.6-test' }]).join(' '), /pre-release/);
    assert.match(releaseNotesProblems([{ ...list[0], notes: ['x'.repeat(MAX_NOTES + 1)] }]).join(' '), /more than/);
    assert.match(releaseNotesProblems([{ ...list[0], notes: ['two\nlines'] }]).join(' '), /one-line/);
    assert.match(releaseNotesGaps(list.slice(0, -1), PACKAGE_VERSION).join(' '), /oldest entry/);
});

test('the note text of an entry is the published text: paragraphs with a blank line, list items one on each line', () => {
    assert.equal(notesText({ notes: ['Intro.', '- a', '- b', 'End.'] }), 'Intro.\n\n- a\n- b\n\nEnd.');
    // The text of the published update.json of 1.0.2 (the release on GitHub, 2026-11-22).
    assert.equal(notesText(entryFor(list, '1.0.2')).split('\n\n').length, 3);
    assert.ok(notesText(entryFor(list, '1.0.2')).startsWith('ASSCRACK 1.0.2 is a cleanup of the texts across the app.\n\n- Shorter'));
    assert.ok(notesText(entryFor(list, '1.0.5')).startsWith('- Join and leave times:'));
});

test('the card: a fresh install shows nothing, an update shows the new version, then never again', t => {
    const dir = tempDir(t);
    // A fresh install: an empty data folder.
    assert.equal(hadOldProfile(dir), false);
    const fresh = whatsNewStart({ current: '1.0.5', lastSeen: readLastSeen(dir), oldProfile: hadOldProfile(dir), list });
    assert.deepEqual(fresh, { show: null, save: '1.0.5' });
    writeLastSeen(dir, fresh.save);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, WHATS_NEW_FILE), 'utf8')), { lastSeen: '1.0.5' });
    // The same version again: nothing.
    assert.deepEqual(whatsNewStart({ current: '1.0.5', lastSeen: readLastSeen(dir), oldProfile: true, list }), { show: null, save: null });
    // An update from 1.0.4 (saved by a version with this feature).
    writeLastSeen(dir, '1.0.4');
    const updated = whatsNewStart({ current: '1.0.5', lastSeen: readLastSeen(dir), oldProfile: true, list });
    assert.deepEqual(updated, { show: '1.0.5', save: '1.0.5' });
    writeLastSeen(dir, updated.save);
    assert.deepEqual(whatsNewStart({ current: '1.0.5', lastSeen: readLastSeen(dir), oldProfile: true, list }), { show: null, save: null });
});

test('the card: an update from a version with no saved state (1.0.0 to 1.0.5) shows the card one time', t => {
    const dir = tempDir(t);
    writeFileSync(path.join(dir, 'Local State'), '{}');
    assert.equal(hadOldProfile(dir), true);
    const first = whatsNewStart({ current: '1.0.5', lastSeen: readLastSeen(dir), oldProfile: hadOldProfile(dir), list });
    assert.deepEqual(first, { show: '1.0.5', save: '1.0.5' });
    writeLastSeen(dir, first.save);
    assert.equal(whatsNewStart({ current: '1.0.5', lastSeen: readLastSeen(dir), oldProfile: hadOldProfile(dir), list }).show, null);
    for (const mark of ['window-bounds.json', 'update-state.json']) {
        const other = tempDir(t);
        writeFileSync(path.join(other, mark), '{}');
        assert.equal(hadOldProfile(other), true, mark);
    }
});

test('the card: no card for a downgrade, a test version or a version with no notes; a bad state file counts as none', t => {
    assert.deepEqual(whatsNewStart({ current: '1.0.4', lastSeen: '1.0.5', oldProfile: true, list }), { show: null, save: null });
    assert.deepEqual(whatsNewStart({ current: '1.0.6-test', lastSeen: '1.0.5', oldProfile: true, list }), { show: null, save: '1.0.6-test' });
    assert.deepEqual(whatsNewStart({ current: '9.0.0', lastSeen: '1.0.5', oldProfile: true, list }), { show: null, save: '9.0.0' });
    const dir = tempDir(t);
    writeFileSync(path.join(dir, WHATS_NEW_FILE), 'not json');
    assert.equal(readLastSeen(dir), null);
    assert.deepEqual(whatsNewStart({ current: '1.0.5', lastSeen: 'x', oldProfile: false, list }), { show: null, save: '1.0.5' });
});

test('the sign script takes the note text of the version from the notes file; --notes and --notes-file replace it', t => {
    const own = releaseNotesFor({ version: PACKAGE_VERSION });
    assert.deepEqual(own, { notes: notesText(entryFor(list, PACKAGE_VERSION)) });
    assert.deepEqual(releaseNotesFor({ version: '1.0.2' }), { notes: notesText(entryFor(list, '1.0.2')) });
    assert.match(releaseNotesFor({ version: '9.9.9' }).problem, /no entry for 9\.9\.9/);
    assert.deepEqual(releaseNotesFor({ version: '9.9.9', notes: ' Test ' }), { notes: 'Test' });
    const file = path.join(tempDir(t), 'notes.txt');
    writeFileSync(file, 'Line 1\r\nLine 2\r\n');
    assert.deepEqual(releaseNotesFor({ version: '9.9.9', notes: 'other', notesFile: file }), { notes: 'Line 1\nLine 2' });
    assert.match(releaseNotesFor({ version: '9.9.9', notes: 'x'.repeat(MAX_NOTES + 1) }).problem, /more than/);
    // The script refuses a version with no entry when no note option is given (before it reads a key).
    const run = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'sign-update.mjs'), tempDir(t), '--test', '--version', '9.9.9-test'],
        { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no entry for 9\.9\.9-test/);
});

// ---- The window part (whats-new.js) ----
const source = readFileSync(path.join(ROOT, 'src', 'application', 'whats-new.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

function loadUi({ pending = null, entries = list, current = '1.0.5' } = {}) {
    const { document, window } = createDom([
        { id: 'about-whats-new', tag: 'button' },
        { id: 'whats-new-dialog', tag: 'dialog', children: [{ id: 'whats-new-list' }, { id: 'whats-new-empty', tag: 'p', hidden: true }] },
        { id: 'whats-new-card', tag: 'section', hidden: true, children: [
            { id: 'whats-new-card-title', tag: 'h2' }, { id: 'whats-new-card-notes' },
            { id: 'whats-new-card-all', tag: 'button' }, { id: 'whats-new-card-close', tag: 'button' }
        ] }
    ]);
    const dialog = document.getElementById('whats-new-dialog');
    dialog.open = false;
    dialog.showModal = () => { dialog.open = true; };
    const calls = [];
    window.asscrack = {
        getWhatsNew: async () => { calls.push('get'); return { current, entries, pending }; },
        whatsNewDone: async () => { calls.push('done'); return true; }
    };
    window.window = window;
    window.document = document;
    const context = { window, document, console, Promise, Array, String };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'whats-new.js' });
    return { document, window, calls, dialog, el: id => document.getElementById(id) };
}

test('the window: the card shows the notes of the pending version, and Close hides it and tells the main process', async () => {
    const f = loadUi({ pending: '1.0.5' });
    await flush();
    assert.equal(f.el('whats-new-card').hidden, false);
    assert.equal(f.el('whats-new-card-title').textContent, "What's new in 1.0.5");
    const items = f.el('whats-new-card-notes').querySelectorAll('li');
    assert.equal(items.length, 2);
    assert.ok(items[0].textContent.startsWith('Join and leave times:'));
    assert.equal(f.dialog.open, false, 'the card is not modal');
    f.el('whats-new-card-close').click();
    await flush();
    assert.equal(f.el('whats-new-card').hidden, true);
    assert.deepEqual(f.calls, ['get', 'done']);
});

test('the window: no card with no pending version (a fresh install or the second start)', async () => {
    const f = loadUi({ pending: null });
    await flush();
    assert.equal(f.el('whats-new-card').hidden, true);
    assert.deepEqual(f.calls, ['get']);
});

test('the window: What\'s new lists each version newest first, with its date, paragraphs and list items', async () => {
    const f = loadUi({ pending: '1.0.5' });
    await flush();
    f.el('about-whats-new').click();
    await flush();
    assert.equal(f.dialog.open, true);
    const sections = f.el('whats-new-list').querySelectorAll('section');
    assert.deepEqual(sections.map(s => s.querySelectorAll('h3')[0].childNodes[0].textContent), list.map(e => e.version));
    assert.equal(sections[0].querySelectorAll('.whats-new-date')[0].textContent, list[0].date);
    const v102 = sections.find(s => s.querySelectorAll('h3')[0].childNodes[0].textContent === '1.0.2');
    assert.equal(v102.querySelectorAll('p').length, 2);
    assert.equal(v102.querySelectorAll('li').length, 5);
    assert.equal(f.el('whats-new-empty').hidden, true);
    // The card button opens the same list.
    f.dialog.open = false;
    f.el('whats-new-card-all').click();
    await flush();
    assert.equal(f.dialog.open, true);
    assert.equal(typeof f.window.whatsNew.open, 'function');
});
