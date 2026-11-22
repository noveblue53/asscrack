// P9C: the updater in the main process. main.js gives the electron parts; this file connects updater.mjs to the
// window (IPC 'asscrack:update*'), to the nodes (the hub of update-spread.mjs) and to the restart.
//
// The restart: a hidden PowerShell process (restartScript in updater.mjs) waits until this app stopped, then runs the
// installer silently for the current user (installed build) or starts the new portable file (portable build). It
// starts the new version with the same test arguments (--profile, --log-dir, --update-server). The NSIS option
// --force-run is not used: it starts the app with no arguments, thus with the default profile.
import { spawn as spawnProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UPDATE_PUBLIC_KEY } from './update-key.mjs';
import { cleanSetupFolders, createUpdater, encodedCommand, releaseSource, removeOldPortable, restartScript,
    SETUP_FOLDER_PREFIX, STATE_FILE, testServerBase } from './updater.mjs';

export const UPDATE_OLD_FLAG = '--update-old';
// The arguments that the new version gets again (each with one value).
const KEPT_ARGS = ['--profile', '--log-dir', '--update-server'];

// The arguments of this run for the new version. A path value becomes absolute (the new process has an other folder).
export function keptArgs(argv, resolve = path.resolve) {
    const out = [];
    for (const name of KEPT_ARGS) {
        const index = argv.indexOf(name);
        const value = index === -1 ? null : argv[index + 1];
        if (typeof value !== 'string' || value === '' || value.startsWith('--')) continue;
        out.push(name, name === '--update-server' ? value : resolve(value));
    }
    return out;
}

// deps: app, shell (electron). handle(channel, handler): the IPC of the room window. send(channel, data).
// log(level, text). busy(): { voice, transfers }. installedBuild: P9B isInstalledBuild(). quit(): app.quit().
export function createUpdateService({ app, shell, handle, send, log, busy, installedBuild, quit, env = process.env,
    argv = process.argv, spawn = spawnProcess, fetch = globalThis.fetch, platform = process.platform }) {
    const version = app.getVersion();
    const portableFile = env.PORTABLE_EXECUTABLE_FILE || null;
    const kind = platform !== 'win32' || !app.isPackaged ? null : installedBuild ? 'setup' : portableFile ? 'portable' : null;
    const testBase = testServerBase(argv, version);
    const stateFile = path.join(app.getPath('userData'), STATE_FILE);
    const updater = createUpdater({
        currentVersion: version, kind, publicKey: UPDATE_PUBLIC_KEY, source: releaseSource(testBase), fetch,
        folders: {
            setup: () => mkdtempSync(path.join(app.getPath('temp'), SETUP_FOLDER_PREFIX)),
            portable: () => (portableFile ? path.dirname(portableFile) : null),
            downloads: () => app.getPath('downloads')
        },
        store: {
            read: () => JSON.parse(readFileSync(stateFile, 'utf8')),
            write: state => {
                writeFileSync(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
                renameSync(`${stateFile}.tmp`, stateFile);
            }
        },
        log,
        changed: view => send('asscrack:update', view)
    });
    // npm start (not packaged) does no automatic check, except with the test server.
    const automatic = app.isPackaged || testBase !== null;
    if (testBase) log('INFO', `Update test server: ${testBase}`);

    let restarting = false;
    async function restart(force) {
        if (restarting) return { ok: false, error: 'running' };
        const state = busy();
        if (!force && (state.voice || state.transfers > 0)) return { ok: false, busy: state.voice ? 'voice' : 'transfer' };
        const plan = await updater.prepareRestart();
        if (!plan) return { ok: false, error: 'not ready' };
        const args = keptArgs(argv);
        let script;
        if (plan.kind === 'setup') {
            script = restartScript({ waitPids: [process.pid], setup: { file: plan.file, installDir: path.dirname(process.execPath) },
                start: { file: process.execPath, args } });
        } else {
            // The new portable file deletes the old one after its start (only next to it, not in Downloads).
            if (!plan.fallback) args.push(UPDATE_OLD_FLAG, path.basename(portableFile));
            else shell.showItemInFolder(plan.file);
            // Wait also for the portable launcher (the parent): it deletes the shared unpack folder at its end.
            script = restartScript({ waitPids: [process.pid, process.ppid], start: { file: plan.file, args } });
        }
        const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        try {
            const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
                '-EncodedCommand', encodedCommand(script)], { detached: true, stdio: 'ignore', windowsHide: true });
            child.on?.('error', err => log('WARN', `Update restart helper failed: ${err?.message ?? err}`));
            child.unref?.();
        } catch (err) {
            log('WARN', `Update restart helper failed: ${err?.message ?? err}`);
            return { ok: false, error: 'helper' };
        }
        restarting = true;
        log('INFO', `Update: restart to ASSCRACK ${plan.version} (${plan.kind})`);
        quit();
        return { ok: true };
    }

    handle('asscrack:update', () => updater.view());
    handle('asscrack:update-check', () => updater.check());
    handle('asscrack:update-auto', (_event, on) => updater.setEnabled(on === true));
    handle('asscrack:update-download', () => updater.download());
    handle('asscrack:update-later', () => updater.dismiss());
    handle('asscrack:update-restart', (_event, force) => restart(force === true));

    return {
        // The node option "updates" (src/network/update-spread.mjs).
        hub: {
            version,
            offer: peerVersion => updater.offerFor(peerVersion),
            received: (_peerId, payload) => { updater.receivePeer(payload); },
            onShare: listener => updater.onShare(listener)
        },
        // At app start: delete the setup folders of an earlier update, delete the old portable file after an update,
        // and start the checks.
        async startup() {
            if (kind === 'setup') {
                const removed = cleanSetupFolders(app.getPath('temp'));
                if (removed > 0) log('INFO', `Update: ${removed} old setup folder(s) deleted`);
            }
            const oldIndex = argv.indexOf(UPDATE_OLD_FLAG);
            if (kind === 'portable' && oldIndex !== -1) {
                const result = await removeOldPortable({ ownFile: portableFile, oldName: String(argv[oldIndex + 1] ?? ''), ownVersion: version });
                log(result.result === 'failed' ? 'WARN' : 'INFO', `Update: old portable file ${result.result}${result.error ? ` (${result.error})` : ''}`);
            }
            if (automatic) updater.start();
        },
        view: () => updater.view(),
        stop: () => updater.stop()
    };
}
