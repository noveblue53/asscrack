import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { localServerKey, parseRegDefault, WINDOWS_IDENTITIES } from '../src/application/windows-identity.mjs';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export const CDP_PORT_MIN = 9500;
export const CDP_PORT_MAX = 9599;
const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_TIMEOUT_MS = 20000;
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

const ERROR_LINE_RE = /^(?:Error:|TypeError:|ReferenceError:|SyntaxError:|RangeError:|AssertionError|Uncaught\b|Unhandled\b|\[\d+:\d+\/[^:]+:ERROR\b)|\bERROR\b|\bERR_[A-Z0-9_]+\b/i;

function readPositiveInt(flag, raw, { allowZero = false } = {}) {
    if (raw === undefined) throw new Error(`Missing value for ${flag}`);
    if (!/^\d+$/.test(String(raw))) throw new Error(`Invalid integer for ${flag}: ${raw}`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || (!allowZero && n <= 0)) {
        throw new Error(`Invalid value for ${flag}: ${raw}`);
    }
    return n;
}

/**
 * Parse CLI arguments for app-smoke-check.
 */
export function parseArgs(argv = process.argv.slice(2)) {
    const out = {
        port: null,
        runDir: null,
        profileDir: null,
        settleMs: DEFAULT_SETTLE_MS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        evalExpr: null,
        checkNoDevShortcut: false,
        allowOtherElectron: false,
        keepRunDir: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--port') {
            const port = readPositiveInt('--port', argv[++i]);
            if (port < CDP_PORT_MIN || port > CDP_PORT_MAX) {
                throw new Error(`--port must be in ${CDP_PORT_MIN}-${CDP_PORT_MAX}, got ${port}`);
            }
            out.port = port;
        } else if (arg === '--run-dir') {
            out.runDir = argv[++i];
            if (!out.runDir) throw new Error('Missing value for --run-dir');
        } else if (arg === '--profile') {
            out.profileDir = argv[++i];
            if (!out.profileDir) throw new Error('Missing value for --profile');
        } else if (arg === '--settle-ms') {
            out.settleMs = readPositiveInt('--settle-ms', argv[++i], { allowZero: true });
        } else if (arg === '--timeout-ms') {
            out.timeoutMs = readPositiveInt('--timeout-ms', argv[++i]);
        } else if (arg === '--eval') {
            out.evalExpr = argv[++i];
            if (!out.evalExpr) throw new Error('Missing value for --eval');
        } else if (arg === '--check-no-dev-shortcut') {
            out.checkNoDevShortcut = true;
        } else if (arg === '--allow-other-electron') {
            out.allowOtherElectron = true;
        } else if (arg === '--keep-run-dir') {
            out.keepRunDir = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return out;
}

async function isPortFree(port) {
    return new Promise(resolve => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve(true));
        });
    });
}

/**
 * Choose a free CDP port inside 9500-9599 (or verify an explicit port).
 */
export async function pickFreePort({ port = null, start = CDP_PORT_MIN, end = CDP_PORT_MAX, testBind = isPortFree } = {}) {
    if (port !== null) {
        if (!Number.isInteger(port) || port < CDP_PORT_MIN || port > CDP_PORT_MAX) {
            throw new Error(`CDP port must be in ${CDP_PORT_MIN}-${CDP_PORT_MAX}, got ${port}`);
        }
        if (!(await testBind(port))) throw new Error(`CDP port ${port} is busy`);
        return port;
    }
    for (let p = start; p <= end; p++) {
        if (await testBind(p)) return p;
    }
    throw new Error(`No free CDP port in ${start}-${end}`);
}

/**
 * Build an isolated Electron launch configuration (fresh profile, fake APPDATA, stripped ELECTRON_RUN_AS_NODE).
 */
export function buildLaunchConfig({
    repoRoot = REPO_ROOT,
    runDir,
    profileDir = null,
    port,
    env = process.env
} = {}) {
    if (!Number.isInteger(port) || port < CDP_PORT_MIN || port > CDP_PORT_MAX) {
        throw new Error(`CDP port must be in ${CDP_PORT_MIN}-${CDP_PORT_MAX}, got ${port}`);
    }
    if (!runDir) throw new Error('runDir is required');
    const resolvedRunDir = path.resolve(runDir);
    const resolvedProfile = path.resolve(profileDir ?? path.join(resolvedRunDir, 'profile'));
    const fakeAppData = path.join(resolvedRunDir, 'fake-appdata');
    const childEnv = { ...env, APPDATA: fakeAppData };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    return {
        repoRoot: path.resolve(repoRoot),
        port,
        runDir: resolvedRunDir,
        profileDir: resolvedProfile,
        fakeAppData,
        args: ['.', `--profile=${resolvedProfile}`, `--remote-debugging-port=${port}`],
        env: childEnv
    };
}

/**
 * Split process output into lines and detect error lines.
 */
export function classifyOutputLines(text) {
    const lines = String(text ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    const errors = lines.filter(line => ERROR_LINE_RE.test(line));
    return { lines, errors };
}

/**
 * Verify no unrelated Electron process is running outside this repository.
 */
export async function checkSharedHardware({ repoRoot = REPO_ROOT, exec = execFileAsync, platform = process.platform } = {}) {
    if (platform !== 'win32') return { ok: true, others: [] };
    const { stdout } = await exec('powershell.exe', [
        '-NoProfile',
        '-Command',
        '@(Get-Process electron -ErrorAction SilentlyContinue | Select-Object Id, Path) | ConvertTo-Json -Compress'
    ]);
    const raw = stdout.trim();
    if (!raw) return { ok: true, others: [] };
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const normRoot = path.win32.normalize(path.resolve(repoRoot)).toLowerCase();
    const others = list.filter(proc => {
        if (!proc || !proc.Path) return true;
        return !path.win32.normalize(proc.Path).toLowerCase().startsWith(normRoot);
    });
    return { ok: others.length === 0, others };
}

/**
 * Read-only check that Electron.lnk and the dev toast CLSID were not created.
 */
export async function inspectDevShortcutState({
    appDataList = [],
    exec = execFileAsync,
    exists = fs.existsSync,
    platform = process.platform
} = {}) {
    if (platform !== 'win32') return { devShortcutAbsent: true, devClsidAbsent: true };
    const shortcutName = `${WINDOWS_IDENTITIES.dev.shortcut}.lnk`;
    const shortcutPaths = appDataList
        .filter(Boolean)
        .map(dir => path.join(dir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', shortcutName));
    const devShortcutAbsent = shortcutPaths.every(p => !exists(p));
    let devClsidAbsent = true;
    try {
        const { stdout } = await exec('reg', ['query', localServerKey(WINDOWS_IDENTITIES.dev.clsid), '/ve']);
        devClsidAbsent = parseRegDefault(stdout) === '';
    } catch {
        devClsidAbsent = true;
    }
    return { devShortcutAbsent, devClsidAbsent };
}

async function waitForPageTarget(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            if (res.ok) {
                const targets = await res.json();
                const page = targets.find(
                    t => t?.type === 'page' && typeof t.webSocketDebuggerUrl === 'string' && t.url?.includes('index.html')
                );
                if (page) return page;
            }
        } catch {
            // CDP endpoint not ready yet.
        }
        await delay(100);
    }
    throw new Error(`Timed out waiting for CDP index.html target on port ${port}`);
}

function connectCdp(wsUrl) {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const consoleErrors = [];
    const exceptions = [];
    const logErrors = [];

    const openPromise = new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', err => reject(err?.error ?? new Error('CDP WebSocket error')), { once: true });
    });

    ws.addEventListener('message', event => {
        const msg = JSON.parse(String(event.data));
        if (msg.id) {
            const item = pending.get(msg.id);
            if (!item) return;
            pending.delete(msg.id);
            if (msg.error) item.reject(new Error(msg.error.message || 'CDP error'));
            else item.resolve(msg.result);
            return;
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
            const type = msg.params?.type;
            if (type === 'error' || type === 'assert') {
                const text = (msg.params.args ?? []).map(a => a.value ?? a.description ?? a.type).join(' ');
                consoleErrors.push(text || type);
            }
        } else if (msg.method === 'Runtime.exceptionThrown') {
            const details = msg.params?.exceptionDetails;
            exceptions.push(details?.exception?.description || details?.text || 'Runtime exception');
        } else if (msg.method === 'Log.entryAdded') {
            const entry = msg.params?.entry;
            if (entry?.level === 'error') logErrors.push(entry.text || 'Log error');
        }
    });

    function call(method, params = {}) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async function evaluate(expression) {
        const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (res.exceptionDetails) {
            throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Evaluate error');
        }
        return res.result?.value;
    }

    return {
        openPromise,
        call,
        evaluate,
        consoleErrors,
        exceptions,
        logErrors,
        close: () => ws.close()
    };
}

async function stopChildByPid(child, platform = process.platform) {
    if (!child || child.pid === undefined || child.exitCode !== null) return;
    if (platform === 'win32') {
        try {
            await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
        } catch {
            // Process already exited.
        }
        return;
    }
    child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        delay(2000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })
    ]);
}

/**
 * Launch Electron cleanly via CDP, verify DOM + errors, and stop strictly by PID.
 */
export async function main(argv = process.argv.slice(2)) {
    const startedAt = Date.now();
    const opts = parseArgs(argv);
    if (!opts.allowOtherElectron) {
        const hw = await checkSharedHardware({ repoRoot: REPO_ROOT });
        if (!hw.ok) {
            throw new Error(`Other electron.exe processes are running outside ${REPO_ROOT}: ${JSON.stringify(hw.others)}`);
        }
    }

    const ownsRunDir = !opts.runDir;
    const runDir = opts.runDir ? path.resolve(opts.runDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'ac-smoke-'));
    const port = await pickFreePort({ port: opts.port });
    const cfg = buildLaunchConfig({ repoRoot: REPO_ROOT, runDir, profileDir: opts.profileDir, port });
    fs.mkdirSync(cfg.profileDir, { recursive: true });
    fs.mkdirSync(cfg.fakeAppData, { recursive: true });

    const electronExe = require('electron');
    const child = spawn(electronExe, cfg.args, {
        cwd: cfg.repoRoot,
        env: cfg.env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    const cdpClients = [];
    let domReady = false;
    let evalResult = undefined;
    let runError = null;

    try {
        const page = await waitForPageTarget(port, opts.timeoutMs);
        const cdp = connectCdp(page.webSocketDebuggerUrl);
        cdpClients.push(cdp);
        await cdp.openPromise;
        await cdp.call('Runtime.enable');
        await cdp.call('Log.enable');

        const domDeadline = Date.now() + opts.timeoutMs;
        while (Date.now() < domDeadline) {
            domReady = Boolean(await cdp.evaluate(
                'document.readyState === "complete" && Boolean(document.querySelector("#username")) && Boolean(document.querySelector("#room")) && Boolean(document.querySelector("#login"))'
            ));
            if (domReady) break;
            await delay(50);
        }
        if (!domReady) throw new Error('Timed out waiting for login DOM readiness');

        if (opts.settleMs > 0) await delay(opts.settleMs);
        if (opts.evalExpr) evalResult = await cdp.evaluate(opts.evalExpr);
    } catch (err) {
        runError = err;
    } finally {
        for (const c of cdpClients) c.close();
        await stopChildByPid(child);
    }

    const { consoleErrors = [], exceptions = [], logErrors = [] } = cdpClients[0] ?? {};
    const stderrErrors = classifyOutputLines(stderr).errors;
    const stdoutErrors = classifyOutputLines(stdout).errors;
    const shortcutState = opts.checkNoDevShortcut
        ? await inspectDevShortcutState({ appDataList: [process.env.APPDATA, cfg.fakeAppData] })
        : { devShortcutAbsent: null, devClsidAbsent: null };

    if (ownsRunDir && !opts.keepRunDir) {
        fs.rmSync(runDir, { recursive: true, force: true });
    }

    const ok =
        !runError &&
        domReady &&
        consoleErrors.length === 0 &&
        exceptions.length === 0 &&
        logErrors.length === 0 &&
        stderrErrors.length === 0 &&
        stdoutErrors.length === 0 &&
        (opts.checkNoDevShortcut ? shortcutState.devShortcutAbsent && shortcutState.devClsidAbsent : true);

    const report = {
        ok,
        cdpPort: port,
        durationMs: Date.now() - startedAt,
        domReady,
        consoleErrors,
        exceptions,
        logErrors,
        stderrErrors,
        stdoutErrors,
        ...shortcutState,
        ...(evalResult !== undefined ? { evalResult } : {}),
        ...(runError ? { error: runError.message } : {})
    };
    console.log(JSON.stringify(report));
    return report;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
    try {
        const report = await main();
        process.exit(report.ok ? 0 : 1);
    } catch (err) {
        console.error(err?.stack || String(err));
        process.exit(1);
    }
}
