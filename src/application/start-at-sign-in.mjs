// P9B: "Start as Idle Peer when I sign in" (plan section 5F). Only the installed build (the per-user NSIS installer)
// has this setting. The portable build keeps the manual tray use. This module does not import electron: main.js gives
// the app object, the timers and the calls of the room. The tests use fakes.
//
// The start entry is the Run value RUN_VALUE_NAME of the user (HKCU\...\CurrentVersion\Run), written with
// app.setLoginItemSettings. Its arguments are START_IDLE_FLAG and, for a test profile, --profile <dir>. They never have
// a room key, an invite or a name: the start reads the choice (start-at-sign-in.json) and the room from the protected
// profile. build/installer.nsh deletes the same value at uninstall (test/start-at-sign-in.test.mjs checks the name).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RUN_VALUE_NAME = 'ASSCRACK';
export const START_IDLE_FLAG = '--start-idle';
export const CHOICE_FILE = 'start-at-sign-in.json';
// The NSIS uninstaller of electron-builder has this name ("Uninstall ${productName}.exe").
export const UNINSTALLER_NAME = 'Uninstall ASSCRACK.exe';
export const RETRY_MS = 30000;

const OFF = Object.freeze({ mode: 'off', roomId: null });

// The installed build: packaged, on Windows, not started by the portable launcher (build/portable.nsi sets
// PORTABLE_EXECUTABLE_FILE), and the uninstaller of the installer is next to the executable. A copy of win-unpacked
// thus does not count as installed.
export function isInstalledBuild({ platform, isPackaged, env, execPath, exists }) {
    if (platform !== 'win32' || isPackaged !== true) return false;
    if (env?.PORTABLE_EXECUTABLE_FILE) return false;
    try {
        return exists(path.join(path.dirname(execPath), UNINSTALLER_NAME)) === true;
    } catch {
        return false;
    }
}

// The arguments of the start entry. profile: the --profile folder of this run, or null (the default user data).
// app.setLoginItemSettings quotes each argument for the command line of the Run value (test on this PC, 2026-11-22:
// an argument with quotes got a second pair). Thus the path goes in as it is.
export function startArgs(profile = null) {
    if (typeof profile !== 'string' || profile === '') return [START_IDLE_FLAG];
    return [START_IDLE_FLAG, '--profile', profile];
}

// A choice: { mode: 'off' } or { mode: 'friends' } or { mode: 'room', roomId }.
export function normalizeChoice(raw) {
    if (raw?.mode === 'friends') return { mode: 'friends', roomId: null };
    if (raw?.mode === 'room' && typeof raw.roomId === 'string' && raw.roomId.length > 0 && raw.roomId.length <= 128) {
        return { mode: 'room', roomId: raw.roomId };
    }
    return { ...OFF };
}

export function readChoice(file) {
    try {
        return normalizeChoice(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
        return { ...OFF };
    }
}

export function writeChoice(file, choice) {
    const value = normalizeChoice(choice);
    writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return value;
}

// The rooms that the start can open: the protected saved rooms (a legacy room needs a trust confirmation at each
// reopen, and a start with no window cannot ask). The window gets the ID and the name only.
export function startRooms(rooms) {
    if (!Array.isArray(rooms)) return [];
    return rooms.filter(room => room?.protected === true && typeof room.roomId === 'string')
        .map(room => ({ roomId: room.roomId, name: String(room.name ?? '') }));
}

// Forget of the selected room removes the choice (and thus the start entry).
export function choiceAfterForget(choice, roomId) {
    const current = normalizeChoice(choice);
    return current.mode === 'room' && current.roomId === roomId ? { ...OFF } : current;
}

// A room choice whose room is not in the open profile is stale: a Forget in an other build (the portable build uses
// the same profile) or in an older version. Then the choice is off, and the installed build removes the start entry.
export function isStaleChoice(choice, status) {
    const current = normalizeChoice(choice);
    if (current.mode !== 'room' || status?.state !== 'open') return false;
    return !startRooms(status.rooms).some(room => room.roomId === current.roomId);
}

// What a start with START_IDLE_FLAG does now. status: the status() of the saved rooms.
// 'wait': the protected profile is missing or locked. 'friends': only the friend links. 'room': open roomId.
// 'missing': the selected room is not in the profile (or is not protected).
export function startStep(choice, status) {
    const current = normalizeChoice(choice);
    if (current.mode === 'off') return { action: 'none' };
    if (status?.state !== 'open') return { action: 'wait' };
    if (current.mode === 'friends') return { action: 'friends' };
    const found = startRooms(status.rooms).some(room => room.roomId === current.roomId);
    return found ? { action: 'room', roomId: current.roomId } : { action: 'missing' };
}

// The start entry in Windows. app: the electron app (setLoginItemSettings, getLoginItemSettings).
export function createStartEntry({ app, execPath, args, name = RUN_VALUE_NAME }) {
    function state() {
        let settings;
        try {
            settings = app.getLoginItemSettings({ path: execPath, args });
        } catch {
            return { present: false, enabled: false, args: [] };
        }
        const item = (settings?.launchItems ?? []).find(entry => entry?.name === name);
        if (!item) return { present: false, enabled: false, args: [] };
        // enabled is false when the user turned the entry off in Task Manager or in Settings (StartupApproved).
        return { present: true, enabled: item.enabled === true, args: Array.isArray(item.args) ? item.args : [] };
    }
    // Write the entry only on a change of the user. A write sets the entry to enabled (StartupApproved) again.
    function apply(choice) {
        const on = normalizeChoice(choice).mode !== 'off';
        if (on) app.setLoginItemSettings({ openAtLogin: true, path: execPath, args, name, enabled: true });
        else app.setLoginItemSettings({ openAtLogin: false, path: execPath, args, name });
        return state();
    }
    // One data folder: the install folder can move on the same PC. At each start of the installed build, when the
    // choice is on and the entry starts an other exe (or has other arguments), write the path of this exe. The
    // enabled state of the user (Task Manager) stays. Gives true when it wrote the entry.
    function repair(choice) {
        if (normalizeChoice(choice).mode === 'off') return false;
        let item;
        try {
            item = (app.getLoginItemSettings({ path: execPath, args })?.launchItems ?? []).find(entry => entry?.name === name);
        } catch {
            return false;
        }
        if (!item) return false;
        const samePath = typeof item.path === 'string' && path.win32.resolve(item.path).toLowerCase() === path.win32.resolve(execPath).toLowerCase();
        const sameArgs = Array.isArray(item.args) && item.args.length === args.length && item.args.every((arg, i) => arg === args[i]);
        if (samePath && sameArgs) return false;
        app.setLoginItemSettings({ openAtLogin: true, path: execPath, args, name, enabled: item.enabled === true });
        return true;
    }
    return { state, apply, repair };
}

// The start with START_IDLE_FLAG. It waits for the protected profile, then opens the friend links only or asks the
// window to reopen the selected room. A failed start or a locked profile tries again each RETRY_MS, and at once
// after a wake (wake()). deps:
//   status(): the status() of the saved rooms. unlock(): a new try to open the protected profile.
//   busy(): true when a room is open or a login runs (then the start stops: the user acts).
//   openRoom(roomId): asks the window to reopen the room (the normal reopen path).
//   done(result): 'friends', 'room', 'missing', 'none' (no choice) or 'stopped'.
//   log(level, text), setTimer(fn, ms), clearTimer(id).
export function createStartRunner({ choice, status, unlock, busy, openRoom, done, log = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout, retryMs = RETRY_MS }) {
    let timer = null;
    let finished = false;
    let pending = null;
    let running = false;

    function finish(result) {
        if (finished) return;
        finished = true;
        clearTimer(timer);
        timer = null;
        log('INFO', `Start at sign-in: ${result}`);
        done(result);
    }
    function later() {
        if (finished) return;
        clearTimer(timer);
        timer = setTimer(() => { timer = null; void step(); }, retryMs);
    }
    async function step() {
        if (finished || running || pending) return;
        if (busy()) { finish('stopped'); return; }
        running = true;
        try {
            let next = startStep(choice, status());
            if (next.action === 'wait') {
                try { await unlock(); } catch (err) { log('WARN', `Start at sign-in: unlock failed: ${err?.message ?? err}`); }
                if (finished) return;
                next = startStep(choice, status());
            }
            if (next.action === 'none') finish('none');
            else if (next.action === 'wait') { log('WARN', 'Start at sign-in: the protected profile is locked. Waiting'); later(); }
            else if (next.action === 'friends') finish('friends');
            else if (next.action === 'missing') finish('missing');
            else {
                pending = next.roomId;
                // The window can fail before it calls the reopen (then no result comes): try again after a time.
                clearTimer(timer);
                timer = setTimer(() => { timer = null; pending = null; log('WARN', 'Start at sign-in: no reopen result. Trying again'); later(); }, retryMs * 4);
                openRoom(next.roomId);
            }
        } finally {
            running = false;
        }
    }
    return {
        start: () => { void step(); },
        // The result of a reopen (from the reopen handler). Only the reopen of the selected room counts.
        reopened(roomId, ok, error = null) {
            if (finished || pending === null || roomId !== pending) return;
            pending = null;
            clearTimer(timer);
            timer = null;
            if (ok) { finish('room'); return; }
            log('WARN', `Start at sign-in: the room did not start (${error ?? 'unknown'}). Trying again`);
            later();
        },
        // After a wake or a network change: try again now.
        wake() {
            if (finished || pending) return;
            clearTimer(timer);
            timer = null;
            void step();
        },
        stop() { finish('stopped'); },
        finished: () => finished
    };
}
