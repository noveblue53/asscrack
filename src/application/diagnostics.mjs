// The main-process part of the diagnostics journal (1.0.1, docs/DIAGNOSTICS.md): the start record, the run records,
// the crash, hang and error hooks, the power events and the load sampler. main.js gives the Electron objects; this
// module does not import electron. Each value goes through the allowlist of journal.mjs.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { beginRun, createJournal, endRun, ipClass, JOURNAL_DIR, recordRun, scrubStack, scrubText, tagKey } from './journal.mjs';
import { reasonCode } from './diag-events.mjs';

export const METRICS_MS = 60_000;

// The text of an exception with no quoted part (a JSON error can quote its input) and no path or address.
export function errorMessage(value) {
    const text = String(value ?? '').replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"');
    return scrubText(text, 120);
}

// The name of an error ('TypeError'), or 'other'.
export function errorType(err) {
    const name = typeof err?.name === 'string' ? err.name : typeof err?.constructor?.name === 'string' ? err.constructor.name : '';
    return /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) ? name.toLowerCase() : 'other';
}

// The network interfaces by class: a count for each class and a count of virtual or VPN adapters. No address, no
// MAC address, no adapter name.
export function interfaceSummary(interfaces = os.networkInterfaces()) {
    const out = { ifLan: 0, ifPublic: 0, ifCgnat: 0, ifVirtual: 0 };
    for (const [name, list] of Object.entries(interfaces ?? {})) {
        const v4 = (list ?? []).filter(a => a && a.family === 'IPv4' && !a.internal);
        if (!v4.length) continue;
        if (/vpn|virtual|vethernet|hyper-v|vmware|virtualbox|tap|tun|wireguard|zerotier|tailscale|hamachi|radmin|wsl/i.test(name)) out.ifVirtual++;
        for (const a of v4) {
            const kind = ipClass(a.address);
            if (kind === 'lan') out.ifLan++;
            else if (kind === 'public') out.ifPublic++;
            else if (kind === 'cgnat') out.ifCgnat++;
        }
    }
    return out;
}

// The text of a writeLog line for the journal. Known lines with a value of the user lose that value.
export function logText(text) {
    return String(text ?? '')
        // ptt-hook.mjs promises "It keeps and logs no key": the voice settings line names the push-to-talk key.
        .replace(/ptt-key (?!none\b)\S+/g, 'ptt-key set');
}

// The same log text again within windowMs is not journaled again (for example "Voice frame send failed" up to 50
// times each second). The next line after the window has the count of the skipped lines in its text.
export function logDeduper({ windowMs = 10_000, now = Date.now, max = 256 } = {}) {
    const seen = new Map();
    return text => {
        const t = now();
        const entry = seen.get(text);
        if (entry && t - entry.at < windowMs) { entry.skipped++; return null; }
        const skipped = entry?.skipped ?? 0;
        seen.delete(text);
        seen.set(text, { at: t, skipped: 0 });
        if (seen.size > max) seen.delete(seen.keys().next().value);
        return skipped ? `${text} (and ${skipped} more)` : text;
    };
}

// The total CPU use of the system between two os.cpus() samples, in %.
export function systemCpu(before, after) {
    let idle = 0, total = 0;
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
        const a = before[i].times, b = after[i].times;
        const t = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq);
        total += t;
        idle += b.idle - a.idle;
    }
    return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

// app: the Electron app. userData: the data folder of this run. info: { buildKind, dataKind, startKind }.
// Gives { write, flushSync, dir, run, ... }. A failure to make the folder gives a journal that writes nothing.
export function createDiagnostics({ app, userData, info = {}, fsx = fs, now = Date.now, pid = process.pid,
    alive = () => false, appRoot = null }) {
    const dir = path.join(userData, JOURNAL_DIR);
    const journal = createJournal({ dir, fsx, now });
    const startedAt = now();
    const run = journal.run;
    const write = (type, fields) => journal.write(type, fields);
    const started = beginRun(dir, { run, pid, t: startedAt, alive, fsx });
    let key = null;
    let quitDone = false;

    write('start', {
        version: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome,
        node: process.versions.node, os: os.release(), arch: process.arch, build: info.buildKind, data: info.dataKind,
        start: info.startKind, prevClean: started.previous === null, tzOffsetMin: -new Date(startedAt).getTimezoneOffset(), pid
    });
    if (started.previous) {
        write('previous-run-unclean', { run: started.previous.run, lastT: started.last?.t, lastType: started.last?.type });
    }
    if (started.concurrent) write('concurrent-run', {});
    try {
        recordRun(dir, { run, t: startedAt, version: app.getVersion(), build: info.buildKind ?? null,
            prevClean: started.previous === null, clean: false }, { fsx });
    } catch { /* the journal lines stay */ }

    // ---- Errors of the main process. uncaughtExceptionMonitor and 'warning' only observe: the default behavior of
    // Electron 45 does not change (an unhandled rejection is a warning there, measured on this PC 2026-11-22). ----
    function onException(err, origin) {
        write('error', { where: 'main', kind: origin === 'unhandledRejection' ? 'rejection' : 'exception',
            errorType: errorType(err), message: errorMessage(err?.message ?? err), stack: scrubStack(err?.stack, appRoot) });
        journal.flushSync();
    }
    function onWarning(warning) {
        if (warning?.name !== 'UnhandledPromiseRejectionWarning') return;
        const first = String(warning.message ?? '').split('\n')[0];
        if (/^Unhandled promise rejection\. This error originated/.test(first)) return;
        const m = /^([A-Za-z][A-Za-z0-9_]*)(?::\s*(.*))?$/.exec(first);
        write('error', { where: 'main', kind: 'rejection', errorType: m ? m[1].toLowerCase() : 'other',
            message: errorMessage(m ? m[2] ?? '' : first) });
    }
    process.on('uncaughtExceptionMonitor', onException);
    process.on('warning', onWarning);

    // ---- Crashes and hangs ----
    function hookApp() {
        app.on('render-process-gone', (_event, _contents, details) => {
            write('crash', { process: 'renderer', reason: reasonCode(details?.reason), exitCode: details?.exitCode });
            journal.flushSync();
        });
        app.on('child-process-gone', (_event, details) => {
            write('crash', { process: reasonCode(details?.type), reason: reasonCode(details?.reason), exitCode: details?.exitCode,
                service: reasonCode(details?.serviceName ?? details?.name) });
            journal.flushSync();
        });
    }
    function attachWindow(win) {
        let since = null;
        win.on('unresponsive', () => { since = now(); write('hang', { state: 'unresponsive' }); journal.flushSync(); });
        win.on('responsive', () => { write('hang', { state: 'responsive', ms: since === null ? undefined : now() - since }); since = null; });
        // Each uncaught exception and unhandled rejection of the room window ("Uncaught ..."). Other console lines
        // of the window do not go in the journal.
        win.webContents.on('console-message', details => {
            const message = String(details?.message ?? '');
            if (details?.level !== 'error' || !message.startsWith('Uncaught')) return;
            const m = /^Uncaught(?: \(in promise\))?\s+([A-Za-z][A-Za-z0-9_]*)?:?\s*(.*)$/s.exec(message);
            const source = typeof details.sourceId === 'string' ? details.sourceId.split(/[\\/]/).pop() : '';
            write('error', { where: 'renderer', kind: message.startsWith('Uncaught (in promise)') ? 'rejection' : 'exception',
                errorType: m?.[1] ? m[1].toLowerCase() : 'other', message: errorMessage(m?.[2] ?? ''),
                stack: scrubText(`${source}:${details.lineNumber ?? 0}`, 80) });
        });
    }

    // ---- Power and clock ----
    function hookPower(powerMonitor) {
        for (const state of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown']) {
            powerMonitor.on(state, () => { write('power', { state }); if (state === 'suspend' || state === 'shutdown') journal.flushSync(); });
        }
    }

    // ---- The environment (after ready: screen and GPU need it) ----
    function environment({ screen } = {}) {
        let displays, scale, gpu;
        try { const all = screen.getAllDisplays(); displays = all.length; scale = Math.max(...all.map(d => d.scaleFactor)); } catch { /* none */ }
        try { gpu = reasonCode(app.getGPUFeatureStatus()?.gpu_compositing); } catch { /* none */ }
        const cpus = os.cpus();
        write('env', { cpu: cpus[0]?.model?.trim(), cpus: cpus.length, ramMb: Math.round(os.totalmem() / 1048576), displays, scale,
            gpu, ...interfaceSummary() });
    }

    // ---- The load sampler: each 60 s, the event-loop delay, the CPU and memory of the processes, the system CPU ----
    let sampler = null;
    function startMetrics(intervalMs = METRICS_MS) {
        if (sampler) return;
        const loop = monitorEventLoopDelay({ resolution: 20 });
        loop.enable();
        let cpus = os.cpus();
        sampler = setInterval(() => {
            const next = os.cpus();
            const fields = { loopP50: loop.percentile(50) / 1e6, loopP99: loop.percentile(99) / 1e6, loopMax: loop.max / 1e6,
                sysCpuPct: systemCpu(cpus, next) };
            cpus = next;
            loop.reset();
            try {
                let cpu = 0, mem = 0, renderer = 0, gpuMem = 0;
                for (const m of app.getAppMetrics()) {
                    cpu += m.cpu?.percentCPUUsage ?? 0;
                    const kb = m.memory?.workingSetSize ?? 0;
                    mem += kb;
                    if (m.type === 'Tab') renderer += kb;
                    if (m.type === 'GPU') gpuMem += kb;
                }
                Object.assign(fields, { cpuPct: cpu, memMb: Math.round(mem / 1024), rendererMb: Math.round(renderer / 1024), gpuMb: Math.round(gpuMem / 1024) });
            } catch { /* no metrics */ }
            write('metrics', fields);
        }, intervalMs);
        sampler.unref?.();
    }

    // The clean end of the run: the last lines, the run record, the marker goes away. Synchronous (before-quit).
    function quit() {
        if (quitDone) return;
        quitDone = true;
        clearInterval(sampler);
        write('quit', { uptimeS: Math.round((now() - startedAt) / 1000), lines: journal.lines });
        journal.flushSync();
        try {
            recordRun(dir, { run, t: startedAt, version: app.getVersion(), build: info.buildKind ?? null,
                prevClean: started.previous === null, clean: true, end: now(), lines: journal.lines, counts: journal.counts() }, { fsx });
        } catch { /* the marker still goes */ }
        endRun(dir, run, fsx);
    }

    return {
        dir, run, write, journal, hookApp, attachWindow, hookPower, environment, startMetrics, quit,
        flushSync: () => journal.flushSync(),
        tagKey: () => (key ??= tagKey(dir, fsx)),
        files: () => journal.files()
    };
}
