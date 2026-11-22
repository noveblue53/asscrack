// P9B: the pure parts of "Start as Idle Peer when I sign in" (src/application/start-at-sign-in.mjs), the uninstall
// include of the installer and the bridge functions. Electron does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
    choiceAfterForget, CHOICE_FILE, isStaleChoice, createStartEntry, createStartRunner, isInstalledBuild, normalizeChoice, readChoice,
    RUN_VALUE_NAME, START_IDLE_FLAG, startArgs, startRooms, startStep, UNINSTALLER_NAME, writeChoice
} from '../src/application/start-at-sign-in.mjs';

const root = new URL('..', import.meta.url);
const INSTALLED = 'C:\\Users\\u\\AppData\\Local\\Programs\\ASSCRACK\\ASSCRACK.exe';

test('only the packaged Windows build with the uninstaller and with no portable launcher counts as installed', () => {
    const exists = file => file === path.join(path.dirname(INSTALLED), UNINSTALLER_NAME);
    const base = { platform: 'win32', isPackaged: true, env: {}, execPath: INSTALLED, exists };
    assert.equal(isInstalledBuild(base), true);
    // The portable launcher (build/portable.nsi) sets PORTABLE_EXECUTABLE_FILE, and its unpack folder has no uninstaller.
    assert.equal(isInstalledBuild({ ...base, env: { PORTABLE_EXECUTABLE_FILE: 'D:\\ASSCRACK-0.8.0-portable.exe' } }), false);
    assert.equal(isInstalledBuild({ ...base, execPath: 'C:\\Temp\\ASSCRACK\\ASSCRACK.exe' }), false);
    assert.equal(isInstalledBuild({ ...base, isPackaged: false }), false, 'npm start');
    assert.equal(isInstalledBuild({ ...base, platform: 'linux' }), false);
    assert.equal(isInstalledBuild({ ...base, exists: () => { throw new Error('no access'); } }), false);
    // The portable launcher really sets the variable (the check depends on it).
    assert.match(readFileSync(new URL('build/portable.nsi', root), 'utf8'), /"PORTABLE_EXECUTABLE_FILE", "\$EXEPATH"/);
});

test('the start arguments are one flag, and a test profile; never a key, an invite or a name', () => {
    assert.deepEqual(startArgs(), [START_IDLE_FLAG]);
    assert.deepEqual(startArgs(''), [START_IDLE_FLAG]);
    // Electron quotes the arguments of the Run value (a quoted path got a second pair of quotes on this PC).
    assert.deepEqual(startArgs('D:\\test profile\\p'), [START_IDLE_FLAG, '--profile', 'D:\\test profile\\p']);
});

test('the choice file keeps only off, friends or one room ID', t => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-start-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, CHOICE_FILE);
    assert.deepEqual(readChoice(file), { mode: 'off', roomId: null }, 'a missing file is off');
    writeFileSync(file, '{not json');
    assert.deepEqual(readChoice(file), { mode: 'off', roomId: null });
    assert.deepEqual(writeChoice(file, { mode: 'room', roomId: 'r1', roomKey: 'secret', invite: 'x' }), { mode: 'room', roomId: 'r1' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mode: 'room', roomId: 'r1' });
    assert.deepEqual(readChoice(file), { mode: 'room', roomId: 'r1' });
    assert.deepEqual(normalizeChoice({ mode: 'friends', roomId: 'r1' }), { mode: 'friends', roomId: null });
    assert.deepEqual(normalizeChoice({ mode: 'room', roomId: '' }), { mode: 'off', roomId: null });
    assert.deepEqual(normalizeChoice({ mode: 'room', roomId: 'x'.repeat(129) }), { mode: 'off', roomId: null });
    assert.deepEqual(normalizeChoice({ mode: 'other' }), { mode: 'off', roomId: null });
});

test('the start can open only protected saved rooms, and Forget of the selected room removes the choice', () => {
    const rooms = [{ roomId: 'p', name: 'Games', protected: true, userName: 'Ann' }, { roomId: 'l', name: 'Old' }];
    assert.deepEqual(startRooms(rooms), [{ roomId: 'p', name: 'Games' }]);
    assert.deepEqual(startRooms(null), []);
    assert.deepEqual(choiceAfterForget({ mode: 'room', roomId: 'p' }, 'p'), { mode: 'off', roomId: null });
    assert.deepEqual(choiceAfterForget({ mode: 'room', roomId: 'p' }, 'q'), { mode: 'room', roomId: 'p' });
    assert.deepEqual(choiceAfterForget({ mode: 'friends' }, 'p'), { mode: 'friends', roomId: null });
    const open = { state: 'open', rooms };
    assert.deepEqual(startStep({ mode: 'off' }, open), { action: 'none' });
    assert.deepEqual(startStep({ mode: 'room', roomId: 'p' }, { state: 'locked', rooms: [] }), { action: 'wait' });
    assert.deepEqual(startStep({ mode: 'friends' }, { state: 'unavailable', rooms: [] }), { action: 'wait' });
    assert.deepEqual(startStep({ mode: 'friends' }, open), { action: 'friends' });
    assert.deepEqual(startStep({ mode: 'room', roomId: 'p' }, open), { action: 'room', roomId: 'p' });
    assert.deepEqual(startStep({ mode: 'room', roomId: 'l' }, open), { action: 'missing' }, 'a legacy room needs a confirmation');
    assert.deepEqual(startStep({ mode: 'room', roomId: 'gone' }, open), { action: 'missing' });
});

test('a room choice of a room that is gone from the open profile is stale (a Forget in the portable build)', () => {
    const open = { state: 'open', rooms: [{ roomId: 'p', name: 'Games', protected: true }] };
    assert.equal(isStaleChoice({ mode: 'room', roomId: 'gone' }, open), true);
    assert.equal(isStaleChoice({ mode: 'room', roomId: 'p' }, open), false);
    assert.equal(isStaleChoice({ mode: 'room', roomId: 'gone' }, { state: 'locked', rooms: [] }), false, 'a locked profile waits');
    assert.equal(isStaleChoice({ mode: 'friends' }, open), false);
    assert.equal(isStaleChoice({ mode: 'off' }, open), false);
});

function fakeApp() {
    const calls = [];
    const run = new Map();
    return {
        calls, run,
        setLoginItemSettings(settings) {
            calls.push(settings);
            if (settings.openAtLogin) run.set(settings.name, { args: settings.args, enabled: settings.enabled !== false });
            else run.delete(settings.name);
        },
        getLoginItemSettings() {
            return { launchItems: [...run].map(([name, v]) => ({ name, path: INSTALLED, args: v.args, scope: 'user', enabled: v.enabled })) };
        }
    };
}

test('the start entry is written only on a change and reports the Startup apps state of Windows', () => {
    const app = fakeApp();
    const args = startArgs();
    const entry = createStartEntry({ app, execPath: INSTALLED, args });
    assert.deepEqual(entry.state(), { present: false, enabled: false, args: [] });
    assert.equal(app.calls.length, 0, 'a read writes nothing');
    assert.deepEqual(entry.apply({ mode: 'friends' }), { present: true, enabled: true, args });
    assert.deepEqual(app.calls[0], { openAtLogin: true, path: INSTALLED, args, name: RUN_VALUE_NAME, enabled: true });
    // The user turns the entry off in Task Manager: a read keeps it off.
    app.run.get(RUN_VALUE_NAME).enabled = false;
    assert.deepEqual(entry.state(), { present: true, enabled: false, args });
    assert.equal(app.calls.length, 1);
    assert.deepEqual(entry.apply({ mode: 'off' }), { present: false, enabled: false, args: [] });
    assert.equal(app.calls[1].openAtLogin, false);
    assert.equal(app.calls[1].name, RUN_VALUE_NAME);
    const broken = createStartEntry({ app: { getLoginItemSettings() { throw new Error('x'); } }, execPath: INSTALLED, args });
    assert.deepEqual(broken.state(), { present: false, enabled: false, args: [] });
});

function runner(choice, { state = 'open', rooms = [{ roomId: 'p', name: 'Games', protected: true }], busy = false } = {}) {
    const events = { opened: [], done: [], unlocks: 0, timers: [] };
    const box = { state, rooms, busy };
    const r = createStartRunner({
        choice,
        status: () => ({ state: box.state, rooms: box.rooms }),
        unlock: async () => { events.unlocks++; if (box.unlockOpens) box.state = 'open'; },
        busy: () => box.busy,
        openRoom: roomId => events.opened.push(roomId),
        done: result => events.done.push(result),
        setTimer: (fn, ms) => { const t = { fn, ms }; events.timers.push(t); return t; },
        clearTimer: t => { const i = events.timers.indexOf(t); if (i !== -1) events.timers.splice(i, 1); },
        retryMs: 1000
    });
    const fire = async () => { const t = events.timers.shift(); t.fn(); await new Promise(resolve => setImmediate(resolve)); };
    const tick = () => new Promise(resolve => setImmediate(resolve));
    return { r, events, box, fire, tick };
}

test('the runner opens the selected room through the window and finishes at its first good reopen', async () => {
    const { r, events, fire, tick } = runner({ mode: 'room', roomId: 'p' });
    r.start(); await tick();
    assert.deepEqual(events.opened, ['p']);
    r.reopened('other', true);
    assert.deepEqual(events.done, [], 'only the selected room counts');
    r.reopened('p', false, 'port in use');
    assert.deepEqual(events.done, []);
    assert.equal(events.timers.length, 1, 'a failed start tries again later');
    assert.equal(events.timers[0].ms, 1000);
    await fire();
    assert.deepEqual(events.opened, ['p', 'p']);
    r.reopened('p', true);
    assert.deepEqual(events.done, ['room']);
    assert.equal(events.timers.length, 0);
    r.wake(); await tick();
    assert.deepEqual(events.opened, ['p', 'p'], 'nothing after the finish');
});

test('the runner tries again when the window gives no reopen result', async () => {
    const { r, events, fire, tick } = runner({ mode: 'room', roomId: 'p' });
    r.start(); await tick();
    assert.equal(events.timers[0].ms, 4000);
    await fire();
    assert.equal(events.timers[0].ms, 1000);
    await fire();
    assert.deepEqual(events.opened, ['p', 'p']);
});

test('a locked profile keeps the runner waiting; an unlock or a wake continues', async () => {
    const { r, events, box, fire, tick } = runner({ mode: 'room', roomId: 'p' }, { state: 'locked', rooms: [] });
    r.start(); await tick();
    assert.equal(events.unlocks, 1);
    assert.deepEqual(events.opened, []);
    assert.equal(events.timers.length, 1);
    await fire();
    assert.equal(events.unlocks, 2);
    box.unlockOpens = true;
    box.rooms = [{ roomId: 'p', name: 'Games', protected: true }];
    r.wake(); await tick();
    assert.deepEqual(events.timers.map(t => t.ms), [4000], 'the wake replaces the retry timer (only the reopen timeout stays)');
    assert.deepEqual(events.opened, ['p']);
});

test('the runner ends for friends only, a missing room, no choice and a login of the user', async () => {
    for (const [choice, options, result] of [
        [{ mode: 'friends' }, {}, 'friends'],
        [{ mode: 'room', roomId: 'gone' }, {}, 'missing'],
        [{ mode: 'off' }, {}, 'none'],
        [{ mode: 'room', roomId: 'p' }, { busy: true }, 'stopped']
    ]) {
        const { r, events, tick } = runner(choice, options);
        r.start(); await tick();
        assert.deepEqual(events.done, [result], result);
        assert.deepEqual(events.opened, []);
        assert.equal(r.finished(), true);
    }
});

test('the uninstaller deletes the same start entry, but not at an upgrade', () => {
    const nsh = readFileSync(new URL('build/installer.nsh', root), 'utf8');
    const body = nsh.slice(nsh.indexOf('!macro customUnInstall'), nsh.indexOf('!macroend'));
    assert.match(body, /\$\{ifNot\} \$\{isUpdated\}/);
    const values = [...body.matchAll(/DeleteRegValue HKCU "([^"]+)" "([^"]+)"/g)].map(m => [m[1], m[2]]);
    assert.deepEqual(values, [
        ['Software\\Microsoft\\Windows\\CurrentVersion\\Run', RUN_VALUE_NAME],
        ['Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run', RUN_VALUE_NAME]
    ]);
});

test('the installer is a per-user nsis build next to the unchanged portable build', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    assert.equal(pkg.scripts.dist, 'electron-builder --win portable --publish never');
    assert.equal(pkg.scripts['dist:installer'], 'electron-builder --win nsis --publish never');
    assert.equal(pkg.build.win.target, 'portable');
    assert.equal(pkg.build.portable.artifactName, 'ASSCRACK-${version}-portable.exe');
    assert.equal(pkg.build.nsis.perMachine, false);
    assert.equal(pkg.build.nsis.artifactName, 'ASSCRACK-${version}-setup.exe');
    assert.equal(pkg.build.nsis.installerIcon, pkg.build.win.icon);
    assert.equal(pkg.build.nsis.uninstallerIcon, pkg.build.win.icon);
    assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
    assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
    // The uninstaller name of isInstalledBuild comes from the product name.
    assert.equal(UNINSTALLER_NAME, `Uninstall ${pkg.build.productName}.exe`);
});

test('the installer asks for the install folder and stays per user', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    assert.equal(pkg.build.nsis.oneClick, false);
    assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true);
    assert.equal(pkg.build.nsis.perMachine, false);
    assert.equal(pkg.build.nsis.allowElevation, false);
    const nsh = readFileSync(new URL('build/installer.nsh', root), 'utf8');
    // No install mode page: the installer forces the per-user mode (electron-builder multiUserUi.nsh).
    const mode = nsh.slice(nsh.indexOf('!macro customInstallMode'));
    assert.match(mode.slice(0, mode.indexOf('!macroend')), /StrCpy \$isForceCurrentInstall "1"/);
    // The folder page refuses the folders that need administrator rights, and its text tells the user why.
    const verify = nsh.slice(nsh.indexOf('Function .onVerifyInstDir'));
    const body = verify.slice(0, verify.indexOf('FunctionEnd'));
    for (const root of ['$PROGRAMFILES32', '$PROGRAMFILES64', '$WINDIR']) assert.ok(body.includes(`Push ${root}`), root);
    assert.match(body, /Abort/);
    assert.match(nsh, /!define MUI_DIRECTORYPAGE_TEXT_TOP "[^"]*Program Files[^"]*"/);
    assert.ok(nsh.indexOf('!ifndef BUILD_UNINSTALLER') < nsh.indexOf('Function .onVerifyInstDir'));
});

test('the bridge sends the start choice as text and plain fields only', async () => {
    const source = readFileSync(new URL('src/application/preload.cjs', root), 'utf8');
    const worlds = {}, invoked = [], listeners = {};
    const electron = {
        contextBridge: { exposeInMainWorld: (name, api) => { worlds[name] = api; } },
        ipcRenderer: {
            invoke: (channel, ...args) => { invoked.push([channel, ...args]); return Promise.resolve(null); },
            send() {}, on: (channel, fn) => (listeners[channel] ??= []).push(fn)
        },
        webUtils: { getPathForFile: () => '' }
    };
    vm.runInNewContext(source, { require: () => electron, Promise, Error, Number, String, Uint8Array }, { filename: 'preload.cjs' });
    const api = worlds.asscrack;
    api.getStartup();
    api.setStartup({ mode: 'room', roomId: 7, roomKey: 'secret' });
    api.setStartup({ mode: 'friends' });
    api.setStartup();
    assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [
        ['asscrack:startup'],
        ['asscrack:set-startup', { mode: 'room', roomId: '7' }],
        ['asscrack:set-startup', { mode: 'friends', roomId: null }],
        ['asscrack:set-startup', { mode: 'off', roomId: null }]
    ]);
    const got = [];
    api.onStartRoom(roomId => got.push(roomId));
    for (const fn of listeners['asscrack:start-room']) fn({ sender: 'main' }, 'room-1');
    assert.deepEqual(got, ['room-1']);
});

// One data folder: the install folder moved on the same PC. The entry gets the new exe path at the next start.
test('the repair writes the new exe path into a start entry of an other folder and keeps the state of the user', () => {
    const OLD = 'D:\Old\ASSCRACK\ASSCRACK.exe';
    const NEW = 'E:\New place\ASSCRACK\ASSCRACK.exe';
    const calls = [];
    let item = { name: RUN_VALUE_NAME, path: OLD, args: startArgs(), scope: 'user', enabled: false };
    const app = {
        setLoginItemSettings(settings) { calls.push(settings); item = { ...item, path: settings.path, args: settings.args, enabled: settings.enabled }; },
        getLoginItemSettings() { return { launchItems: item ? [item] : [] }; }
    };
    const entry = createStartEntry({ app, execPath: NEW, args: startArgs() });
    assert.equal(entry.repair({ mode: 'off' }), false, 'choice off: no write');
    assert.equal(calls.length, 0);
    assert.equal(entry.repair({ mode: 'friends' }), true);
    assert.deepEqual(calls[0], { openAtLogin: true, path: NEW, args: startArgs(), name: RUN_VALUE_NAME, enabled: false });
    assert.equal(entry.repair({ mode: 'friends' }), false, 'the same path: no second write');
    assert.equal(createStartEntry({ app, execPath: NEW.toLowerCase(), args: startArgs() }).repair({ mode: 'friends' }), false);
    // The user removed the entry: the repair does not make it again.
    item = null;
    assert.equal(entry.repair({ mode: 'friends' }), false);
    assert.equal(calls.length, 1);
});
