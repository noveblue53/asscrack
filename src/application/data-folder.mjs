// One data folder (operator 2026-11-22): all the data of a copy of ASSCRACK is in one folder that can move with it on
// the same PC. This module does not import electron: main.js gives the values, the tests use fake folders.
//
// The folder of a run:
//   --profile <dir>: that folder (the test option, it overrides each other case).
//   npm start (not packaged): null, thus the Electron default (%APPDATA%\asscrack). The tests and scripts stay as they are.
//   portable build: PORTABLE_FOLDER next to the .exe (PORTABLE_EXECUTABLE_DIR of build/portable.nsi). The process runs
//     from an unpack folder in %TEMP%, thus never the folder of process.execPath.
//   installed build: INSTALLED_FOLDER in the install folder. build/installer.nsh keeps it at an update and an uninstall.
//   other packaged copy (win-unpacked): null.
// The older versions (with no data folder) keep the data in %APPDATA%\ASSCRACK (LEGACY_NAME). The first start with a
// new empty folder offers one move of that data (moveOldData).
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isInstalledBuild } from './start-at-sign-in.mjs';

export const PORTABLE_FOLDER = 'ASSCRACK Data';
export const INSTALLED_FOLDER = 'data';
export const LEGACY_NAME = 'ASSCRACK';
// The file that "Keep there" writes in the new folder. Then the next start does not ask again.
export const KEPT_MARKER = 'old-data-kept.json';
// The temporary user data folder of the run that asks the move question (Chromium must not open the new folder
// before the move, because the safeStorage key is in its "Local State" file).
export const HOLD_PREFIX = 'ASSCRACK-hold-';

export function profileArg(argv) {
    const index = argv.indexOf('--profile');
    return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
}

// Gives { kind, dir }. kind: 'profile', 'portable', 'installed' or 'default' (dir null: the Electron default).
export function chooseDataFolder({ argv, env, isPackaged, platform, execPath, exists, resolve = path.resolve }) {
    const profile = profileArg(argv);
    if (profile) return { kind: 'profile', dir: resolve(profile) };
    if (isPackaged !== true || platform !== 'win32') return { kind: 'default', dir: null };
    if (env?.PORTABLE_EXECUTABLE_DIR) return { kind: 'portable', dir: path.win32.join(env.PORTABLE_EXECUTABLE_DIR, PORTABLE_FOLDER) };
    if (isInstalledBuild({ platform, isPackaged, env, execPath, exists })) {
        return { kind: 'installed', dir: path.win32.join(path.win32.dirname(execPath), INSTALLED_FOLDER) };
    }
    return { kind: 'default', dir: null };
}

// The paths that main.js sets before the ready event. Each one is in the data folder.
export function dataPaths(dir) {
    return { userData: dir, sessionData: dir, logs: path.join(dir, 'logs'), crashDumps: path.join(dir, 'Crashpad') };
}

// Makes the folder and writes and deletes a probe file. Gives { ok: true } or { ok: false, error }.
export function probeWritable(dir, fsx = fs) {
    try {
        fsx.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.asscrack-write-${randomBytes(4).toString('hex')}`);
        fsx.writeFileSync(probe, '', { flag: 'wx' });
        fsx.unlinkSync(probe);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err?.code ?? err?.message ?? String(err) };
    }
}

export function notWritableText(dir, error) {
    return `ASSCRACK keeps its rooms, history and settings in this folder:\n\n${dir}\n\n` +
        `ASSCRACK cannot write to it (${error}). Put ASSCRACK in a folder that your user account can write to, ` +
        'for example a folder in your user folder, and start it again.';
}

// The folder of the old versions. env.APPDATA first: a test process can give a fake folder (Electron reads the
// known folder of Windows, not the variable).
export function legacyFolder({ env, appData }) {
    return path.join(env?.APPDATA || appData, LEGACY_NAME);
}

function samePath(a, b) {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function inside(child, parent) {
    const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function entries(dir, fsx) {
    try { return fsx.readdirSync(dir); } catch { return null; }
}

// True when dir has no files (it does not exist or it is empty) and legacy has data.
export function needsMove({ dir, legacy, fsx = fs }) {
    if (!dir || !legacy) return false;
    if (samePath(dir, legacy) || inside(dir, legacy) || inside(legacy, dir)) return false;
    const now = entries(dir, fsx);
    if (now !== null && now.length > 0) return false;
    try { if (!fsx.statSync(legacy).isDirectory()) return false; } catch { return false; }
    const old = entries(legacy, fsx);
    return old !== null && old.length > 0;
}

// The files of a folder: a sorted list of { rel, size, hash } (each file), and { rel } (each folder).
function listTree(root, fsx) {
    const out = [];
    function walk(rel) {
        for (const entry of fsx.readdirSync(path.join(root, rel), { withFileTypes: true })) {
            const childRel = rel ? path.join(rel, entry.name) : entry.name;
            const full = path.join(root, childRel);
            if (entry.isDirectory()) { out.push({ rel: childRel, dir: true }); walk(childRel); }
            else if (entry.isFile()) {
                const data = fsx.readFileSync(full);
                out.push({ rel: childRel, size: data.length, hash: createHash('sha256').update(data).digest('hex') });
            } else out.push({ rel: childRel, other: true });
        }
    }
    walk('');
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function sameTree(a, b) {
    return a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]));
}

// The move of the old data: rename (a running copy of an older version keeps files open, then the rename fails and
// nothing changes), copy, check each file (size and SHA-256), then remove the old folder. A failure before the removal
// removes the copy and gives the old folder its name again.
// Gives { ok: true, files, bytes, leftover } or { ok: false, reason, error }. reason: 'in-use', 'gone',
// 'target-not-empty', 'copy-failed'. leftover: the renamed old folder when its removal failed (the copy is good).
export function moveOldData({ from, to, fsx = fs, suffix = randomBytes(4).toString('hex') }) {
    const staging = `${from}.moving-${suffix}`;
    const now = entries(to, fsx);
    if (now !== null && now.length > 0) return { ok: false, reason: 'target-not-empty', error: null };
    try {
        fsx.renameSync(from, staging);
    } catch (err) {
        return { ok: false, reason: err?.code === 'ENOENT' ? 'gone' : 'in-use', error: err?.code ?? String(err) };
    }
    let tree;
    try {
        // The cpSync of Electron 45 (Node 24.22) refuses an existing target folder with errorOnExist, also an empty
        // one (test on this PC, 2026-11-22). Thus the empty target folder goes away first, and cpSync makes it.
        if (now !== null) fsx.rmdirSync(to);
        fsx.mkdirSync(path.dirname(to), { recursive: true });
        fsx.cpSync(staging, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
        tree = listTree(staging, fsx);
        if (!sameTree(tree, listTree(to, fsx))) throw new Error('the copy is not the same as the old folder');
    } catch (err) {
        try { fsx.rmSync(to, { recursive: true, force: true }); fsx.mkdirSync(to, { recursive: true }); } catch { /* ignore */ }
        try { fsx.renameSync(staging, from); } catch { /* the old data stays in the staging folder */ }
        return { ok: false, reason: 'copy-failed', error: err?.code ?? err?.message ?? String(err) };
    }
    let leftover = null;
    try { fsx.rmSync(staging, { recursive: true, force: true }); } catch { leftover = staging; }
    if (leftover === null && fsx.existsSync(staging)) leftover = staging;
    const files = tree.filter(x => x.size !== undefined);
    return { ok: true, files: files.length, bytes: files.reduce((n, x) => n + x.size, 0), leftover };
}

// "Keep there": the old folder stays, and the new folder gets a marker file (thus it is not empty).
export function writeKeptMarker(dir, legacy, fsx = fs, now = Date.now()) {
    fsx.mkdirSync(dir, { recursive: true });
    fsx.writeFileSync(path.join(dir, KEPT_MARKER), JSON.stringify({ v: 1, kept: legacy, at: new Date(now).toISOString() }));
}

export function moveFailedText(result, from) {
    if (result.reason === 'in-use') {
        return `An other ASSCRACK copy uses the old folder ${from}. Close each ASSCRACK copy, then start this one again.`;
    }
    if (result.reason === 'gone') return `The old folder ${from} is not there now. Start ASSCRACK again.`;
    return `The move did not complete (${result.error ?? result.reason}). The old folder ${from} did not change. ` +
        'Start ASSCRACK again to try again.';
}

export function holdFolder(temp, pid) {
    return path.join(temp, `${HOLD_PREFIX}${pid}`);
}

// Deletes the hold folders of runs that stopped. alive(pid): true when the process runs.
export function cleanHoldFolders(temp, { alive, fsx = fs, own = null } = {}) {
    for (const name of entries(temp, fsx) ?? []) {
        if (!name.startsWith(HOLD_PREFIX)) continue;
        const pid = Number(name.slice(HOLD_PREFIX.length));
        if (!Number.isInteger(pid) || pid <= 0 || pid === own || alive(pid)) continue;
        try { fsx.rmSync(path.join(temp, name), { recursive: true, force: true }); } catch { /* next start */ }
    }
}
