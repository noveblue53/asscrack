// F1 check (goal 7): a second start of the portable app must not change the files of the running copy.
//
// Usage:
//   node tools/second-start-check.mjs --first <portable.exe> [--second <portable.exe>] [--temp <dir>] [--out <file>]
//
// The script starts the first portable launcher, waits for the window of the app, and takes the SHA-256 of each file
// in the build-specific unpack directory. Then it starts the second launcher (the same exe when --second is not given). It measures the
// time until the second launcher exits (limit 10 s), takes the SHA-256 values and the file IDs again, and checks
// that the first copy still runs. At the end it closes each process that it started and deletes its own temporary check directory.
//
// --temp selects the parent for a fresh TEMP and TMP directory for the launchers. Use a dedicated test account
// or close any running ASSCRACK copy before starting this single-instance check.
//
// Exit code 0: PASS. 1: FAIL. 2: the run was not possible.

import { spawn, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const LIMIT_MS = 10_000;
const HANG_KILL_MS = 20_000;
const WINDOW_WAIT_MS = 90_000;

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const first = arg('--first');
const second = arg('--second', first);
const tempParent = path.resolve(arg('--temp', process.env.TMP || process.env.TEMP || os.tmpdir()));
const outFile = arg('--out');
if (!first) {
    console.error('Usage: node tools/second-start-check.mjs --first <exe> [--second <exe>] [--temp <dir>] [--out <file>]');
    process.exit(2);
}
let tempDir;
let unpackDir;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function ps(command) {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
}

// Only processes from this invocation's isolated temporary tree.
function appProcesses() {
    const prefix = (tempDir + path.sep).replace(/'/g, "''");
    const out = ps(
        `$p = Get-CimInstance Win32_Process -Filter "Name='ASSCRACK.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', [StringComparison]::OrdinalIgnoreCase) };` +
        ` @($p | ForEach-Object { $g = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;` +
        ` [pscustomobject]@{ id = $_.ProcessId; parent = $_.ParentProcessId; window = [int64]($g.MainWindowHandle); executable = $_.ExecutablePath } }) | ConvertTo-Json -Compress`);
    if (!out) return [];
    const value = JSON.parse(out);
    return Array.isArray(value) ? value : [value];
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function listFiles(dir) {
    const files = [];
    const walk = d => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else files.push(full);
        }
    };
    if (existsSync(dir)) walk(dir);
    return files.sort();
}

function hashFile(file) {
    return new Promise(resolve => {
        const hash = createHash('sha256');
        createReadStream(file)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', err => resolve(`error ${err.code}`));
    });
}

// For each file: the SHA-256 and the file identity (file ID and creation time). A launcher that deletes a file and
// unpacks the same content again gives the same SHA-256 but a new file ID.
async function snapshot() {
    const map = new Map();
    for (const file of listFiles(unpackDir)) {
        let id = 'none';
        try {
            const st = statSync(file, { bigint: true });
            id = `${st.ino}/${st.birthtimeNs}`;
        } catch (err) {
            id = `error ${err.code}`;
        }
        map.set(path.relative(unpackDir, file), { sha256: await hashFile(file), id });
    }
    return map;
}

function compare(before, after) {
    const missing = [...before.keys()].filter(k => !after.has(k));
    const added = [...after.keys()].filter(k => !before.has(k));
    const changed = [...before.keys()].filter(k => after.has(k) && after.get(k).sha256 !== before.get(k).sha256);
    const replaced = [...before.keys()].filter(k => after.has(k) && after.get(k).id !== before.get(k).id);
    return { countBefore: before.size, countAfter: after.size, missing, added, changed, replaced };
}

function startLauncher(exe, tag) {
    const env = { ...process.env, TEMP: tempDir, TMP: tempDir };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, ['--log-dir', path.join(tempDir, `logs-${tag}`)], {
        env,
        stdio: 'ignore',
        windowsHide: false
    });
    const state = { child, pid: child.pid, exited: false, code: null, exitAt: null };
    child.on('exit', code => {
        state.exited = true;
        state.code = code;
        state.exitAt = Date.now();
    });
    child.on('error', err => {
        state.exited = true;
        state.error = String(err);
        state.exitAt = Date.now();
    });
    return state;
}

function taskkill(args) {
    try {
        execFileSync('taskkill.exe', args, { stdio: 'ignore' });
    } catch {
        // The process is already gone.
    }
}

async function waitFor(check, ms, step = 500) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return true;
        await sleep(step);
    }
    return false;
}

async function cleanup(launchers) {
    // Close the window of the app (WM_CLOSE, no force), so that the first launcher does its normal end.
    for (const p of appProcesses().filter(p => p.window !== 0)) taskkill(['/PID', String(p.id)]);
    await waitFor(() => launchers.every(l => l.exited) && appProcesses().length === 0, 20_000, 1000);
    for (const l of launchers.filter(l => !l.exited)) taskkill(['/F', '/T', '/PID', String(l.pid)]);
    for (const p of appProcesses()) taskkill(['/F', '/T', '/PID', String(p.id)]);
    await waitFor(() => appProcesses().length === 0, 15_000, 1000);
    const left = appProcesses().length;
    const folderAfterNormalEnd = Boolean(unpackDir && existsSync(unpackDir));
    if (left === 0) rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    return { processesLeft: left, folderAfterNormalEnd, folderDeleted: !existsSync(tempDir) };
}

async function main() {
    const result = { first, second, limitMs: LIMIT_MS, start: new Date().toISOString() };
    log(`first ${first}`);
    log(`second ${second}`);
    for (const exe of [first, second]) {
        if (!existsSync(exe)) {
            console.error(`Not found: ${exe}`);
            return 2;
        }
    }
    mkdirSync(tempParent, { recursive: true });
    tempDir = mkdtempSync(path.join(tempParent, 'asscrack-f1-check-'));
    result.tempDir = tempDir;

    const launchers = [];
    let pass = false;
    try {
        const a = startLauncher(first, 'first');
        launchers.push(a);
        log(`first launcher pid ${a.pid}`);
        let mainApp = null;
        const shown = await waitFor(() => {
            mainApp = appProcesses().find(p => p.window !== 0) ?? null;
            return mainApp !== null || a.exited;
        }, WINDOW_WAIT_MS, 1000);
        if (!shown || !mainApp) {
            result.error = a.exited ? `first launcher exited (code ${a.code})` : 'no window';
            log(`FAIL: ${result.error}`);
            return 1;
        }
        unpackDir = path.dirname(mainApp.executable);
        result.unpackDir = unpackDir;
        log(`window of the first copy: pid ${mainApp.id}`);
        log(`unpack folder ${unpackDir}`);
        await sleep(3000);
        const s1 = await snapshot();
        await sleep(2000);
        const s2 = await snapshot();
        result.control = compare(s1, s2);
        log(`files: ${s2.size}; control (no second start, 2 s): changed ${result.control.changed.length}, replaced ${result.control.replaced.length}, missing ${result.control.missing.length}, added ${result.control.added.length}`);

        const b = startLauncher(second, 'second');
        launchers.push(b);
        const t0 = Date.now();
        log(`second launcher pid ${b.pid}`);
        await waitFor(() => b.exited, HANG_KILL_MS, 100);
        result.secondExitMs = b.exited ? b.exitAt - t0 : null;
        result.secondExitCode = b.code;
        if (!b.exited) {
            log(`second launcher did not exit in ${HANG_KILL_MS} ms (hang): stop it`);
            taskkill(['/F', '/T', '/PID', String(b.pid)]);
        } else {
            log(`second launcher exited after ${result.secondExitMs} ms, code ${b.code}`);
        }
        await sleep(3000);
        const s3 = await snapshot();
        result.afterSecond = compare(s2, s3);
        log(`after the second start: files ${s3.size}, changed ${result.afterSecond.changed.length}, replaced ${result.afterSecond.replaced.length}, missing ${result.afterSecond.missing.length}, added ${result.afterSecond.added.length}`);

        const now = appProcesses();
        result.firstStillRuns = !a.exited && alive(mainApp.id) && now.some(p => p.id === mainApp.id && p.window !== 0);
        result.processesAfter = now;
        log(`first copy still runs: ${result.firstStillRuns} (app processes ${now.length})`);

        const filesSame = s3.size === s2.size && result.afterSecond.missing.length === 0 &&
            result.afterSecond.added.length === 0 && result.afterSecond.changed.length === 0 &&
            result.afterSecond.replaced.length === 0;
        const exitInTime = result.secondExitMs !== null && result.secondExitMs <= LIMIT_MS;
        result.checks = { filesSame, exitInTime, firstStillRuns: result.firstStillRuns };
        pass = filesSame && exitInTime && b.code === 0 && result.firstStillRuns;
    } finally {
        result.cleanup = await cleanup(launchers);
        log(`cleanup: ${JSON.stringify(result.cleanup)}`);
    }
    result.pass = pass;
    log(pass ? 'PASS' : `FAIL ${JSON.stringify(result.checks ?? {})}`);
    if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 2));
    return pass ? 0 : 1;
}

main().then(code => process.exit(code), err => {
    console.error(err);
    process.exit(2);
});
