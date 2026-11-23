// The release notes ("What's new"). release-notes.json is the one source of the note text: the window shows it
// (About, View > What's new, the card after an update) and tools/sign-update.mjs puts the text of a version into
// update.json. Newest entry first. Each entry: { version, date (YYYY-MM-DD), notes: [block] }. A block that starts
// with "- " is a list item; other blocks are paragraphs.
//
// The card after an update: whats-new.json in the data folder keeps the last version that the card was decided for.
// The main process decides one time at the start (whatsNewStart) and writes the file at once.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, MAX_NOTES, parseVersion } from './update-manifest.mjs';

export const RELEASE_NOTES_FILE = fileURLToPath(new URL('./release-notes.json', import.meta.url));
export const WHATS_NEW_FILE = 'whats-new.json';
// The files that each older version (1.0.0 to 1.0.5) left in its data folder. "Local State" is written by Chromium at
// each run; the other two by the app. One of them: the profile is not new.
export const OLD_PROFILE_MARKS = ['Local State', 'window-bounds.json', 'update-state.json'];
// The first version with notes in the file.
export const FIRST_NOTES_VERSION = '1.0.0';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function readReleaseNotes(file = RELEASE_NOTES_FILE) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

// The plain text of one entry, as in update.json: paragraphs with a blank line between, list items one on each line.
export function notesText(entry) {
    let out = '';
    let lastItem = false;
    for (const block of entry.notes) {
        const item = block.startsWith('- ');
        if (out) out += item && lastItem ? '\n' : '\n\n';
        out += block;
        lastItem = item;
    }
    return out;
}

export function entryFor(list, version) {
    return Array.isArray(list) ? list.find(entry => entry?.version === version) ?? null : null;
}

// The problems of the notes list. An empty list: the file is good.
export function releaseNotesProblems(list) {
    const problems = [];
    if (!Array.isArray(list) || list.length === 0) return ['The notes file is not a list with entries.'];
    let previous = null;
    for (const [index, entry] of list.entries()) {
        const where = `Entry ${index + 1}`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { problems.push(`${where} is not an object.`); continue; }
        const keys = Object.keys(entry).sort().join(',');
        if (keys !== 'date,notes,version') problems.push(`${where} has the keys ${keys} (needs version, date, notes).`);
        const parsed = typeof entry.version === 'string' ? parseVersion(entry.version) : null;
        if (!parsed) problems.push(`${where}: the version ${entry.version} is not valid.`);
        else if (parsed.pre.length > 0) problems.push(`${where}: the version ${entry.version} has a pre-release part.`);
        const dateOk = typeof entry.date === 'string' && DATE.test(entry.date)
            && !Number.isNaN(Date.parse(`${entry.date}T00:00:00Z`))
            && new Date(`${entry.date}T00:00:00Z`).toISOString().slice(0, 10) === entry.date;
        if (!dateOk) problems.push(`${where}: the date ${entry.date} is not YYYY-MM-DD.`);
        if (!Array.isArray(entry.notes) || entry.notes.length === 0
            || entry.notes.some(block => typeof block !== 'string' || block.trim() !== block || block === '' || block === '- '
                || block.includes('\n') || block.includes('\r'))) {
            problems.push(`${where}: the notes are not a list of one-line texts.`);
        } else if (notesText(entry).length > MAX_NOTES) {
            problems.push(`${where}: the note text has more than ${MAX_NOTES} characters.`);
        }
        if (previous && parsed && previous.parsed) {
            if (compareVersions(previous.version, entry.version) <= 0) {
                problems.push(`${where}: ${entry.version} is not older than ${previous.version} (newest first).`);
            }
            if (dateOk && previous.dateOk && entry.date > previous.date) {
                problems.push(`${where}: the date ${entry.date} is after the date of ${previous.version}.`);
            }
        }
        previous = { version: entry.version, date: entry.date, parsed, dateOk };
    }
    return problems;
}

// The problems of a release: the notes file has problems, or no entry for the version, or the version is not the
// newest entry, or the oldest entry is not 1.0.0.
export function releaseNotesGaps(list, version) {
    const problems = releaseNotesProblems(list);
    if (problems.length > 0) return problems;
    if (!entryFor(list, version)) problems.push(`The notes file has no entry for ${version}. Add the notes before the build.`);
    else if (list[0].version !== version) problems.push(`The newest entry is ${list[0].version}, not ${version}.`);
    if (list.at(-1).version !== FIRST_NOTES_VERSION) problems.push(`The oldest entry is ${list.at(-1).version}, not ${FIRST_NOTES_VERSION}.`);
    return problems;
}

// True when the data folder has a file of an older version. Call it before this run writes to the folder.
export function hadOldProfile(dir, exists = existsSync) {
    return OLD_PROFILE_MARKS.some(name => exists(path.join(dir, name)));
}

// The decision of the start. current: the version of this run. lastSeen: the saved version, or null. oldProfile: the
// result of hadOldProfile. Returns { show: the version of the card, or null, save: the version to save, or null }.
// - A saved version that is lower than current: show the card (when the notes have an entry), save current.
// - No saved version and an old profile: an update from a version with no card; the same.
// - No saved version and a new profile: a fresh install; no card, save current.
// - A saved version that is current or higher (a downgrade): no card, no save.
export function whatsNewStart({ current, lastSeen, oldProfile, list }) {
    const cur = parseVersion(current);
    if (!cur) return { show: null, save: null };
    const seen = typeof lastSeen === 'string' && parseVersion(lastSeen) ? lastSeen : null;
    if (seen && compareVersions(current, seen) <= 0) return { show: null, save: null };
    const updated = seen !== null || oldProfile === true;
    const show = updated && cur.pre.length === 0 && entryFor(list, current) ? current : null;
    return { show, save: current };
}

export function readLastSeen(dir) {
    try {
        const value = JSON.parse(readFileSync(path.join(dir, WHATS_NEW_FILE), 'utf8'));
        return typeof value?.lastSeen === 'string' ? value.lastSeen : null;
    } catch {
        return null;
    }
}

export function writeLastSeen(dir, version) {
    const file = path.join(dir, WHATS_NEW_FILE);
    writeFileSync(`${file}.tmp`, JSON.stringify({ lastSeen: version }) + '\n');
    renameSync(`${file}.tmp`, file);
}
