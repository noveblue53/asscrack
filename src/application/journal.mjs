// The diagnostics journal (1.0.1, docs/DIAGNOSTICS.md). One JSON object for each line in the data folder:
// diagnostics/journal-<stamp>-<run>-<n>.jsonl. It is always on and stays on this computer. Only the "Send" of the user
// or "Save diagnostics" puts a copy in a bundle (diag-bundle.mjs).
//
// Redaction at write time: each event type has a fixed list of fields and a kind for each field. The writer drops each
// unknown type and each unknown field, and each value that does not fit its kind. Text from a peer never has a field.
// Remote addresses become a class (addrClass). Error text goes through scrubText (no paths, no addresses, 120 chars).
//
// Cost: lines go to a memory buffer. An async append writes the buffer each second or at 64 KB. Only flushSync (quit
// and an uncaught exception) writes synchronously. A write error stops the journal until the next run.
// Rotation drops the oldest data: files of 1 MB, at most 5 files, at most 7 days. runs.jsonl keeps one line for
// each of the last 50 runs. This module does not import electron (node tests use it).
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export const SCHEMA_VERSION = 1;
export const JOURNAL_DIR = 'diagnostics';
export const RUNS_FILE = 'runs.jsonl';
export const MARKER_FILE = 'running.json';
export const FILE_BYTES = 1024 * 1024;
export const MAX_FILES = 5;
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const MAX_RUNS = 50;
export const FLUSH_MS = 1000;
export const FLUSH_BYTES = 64 * 1024;
const JOURNAL_NAME = /^journal-\d{8}T\d{9}Z-[0-9a-f]{8}-\d{1,6}\.jsonl$/;

// ---- Redaction helpers ----

// The class of an IPv4 or IPv6 address: loopback, lan, link-local, cgnat or public.
export function ipClass(ip) {
    const kind = isIP(String(ip ?? ''));
    if (kind === 4) {
        const [a, b] = ip.split('.').map(Number);
        if (a === 127) return 'loopback';
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
        if (a === 169 && b === 254) return 'link-local';
        if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
        if (a === 0 || a >= 224) return 'other';
        return 'public';
    }
    if (kind === 6) {
        const low = ip.toLowerCase();
        if (low === '::1') return 'loopback';
        if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return 'link-local';
        if (low.startsWith('fc') || low.startsWith('fd')) return 'lan';
        if (low.startsWith('::ffff:')) return ipClass(low.slice(7));
        return 'public';
    }
    return null;
}

// A multiaddr text gives { addr, transport, port } with no address: addr is the class of the first IP, 'relay' for a
// circuit address, 'dns' for a name. Unknown input gives { addr: 'unknown' }.
export function addrClass(text) {
    const value = typeof text === 'string' ? text : '';
    if (!value || value === '?') return { addr: 'unknown' };
    const parts = value.split('/');
    let addr = 'unknown', transport = null, port = null;
    for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if ((p === 'ip4' || p === 'ip6') && addr === 'unknown') addr = ipClass(parts[i + 1]) ?? 'unknown';
        else if ((p === 'dns' || p === 'dns4' || p === 'dns6' || p === 'dnsaddr') && addr === 'unknown') addr = 'dns';
        else if ((p === 'tcp' || p === 'udp') && transport === null) {
            transport = p;
            const n = Number(parts[i + 1]);
            if (Number.isInteger(n) && n >= 0 && n <= 65535) port = n;
        } else if (p === 'ws' || p === 'wss' || p === 'quic-v1' || p === 'webtransport') transport = p;
    }
    if (value.includes('/p2p-circuit')) addr = 'relay';
    const out = { addr };
    if (transport) out.transport = transport;
    if (port !== null) out.port = port;
    return out;
}

const WIN_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)[^\s"'<>|]*/g;
const FILE_URL = /file:\/\/\/?[^\s"'<>]*/gi;
const MULTIADDR = /\/(?:ip4|ip6|dns4|dns6|dns|dnsaddr)\/[^\s"',)]+/g;
const POSIX_PATH = /(?<![\w:/.])\/(?:[\w.@-]+\/)+[\w.@-]*/g;
const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?\b/g;
const IPV6 = /\[?(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])\]?(?::\d{1,5})?/gi;

// Error text with no path and no address. Each path becomes <path>, each address or multiaddr its class in brackets.
// Control characters become spaces. The result has at most max characters.
export function scrubText(value, max = 120) {
    let s = String(value ?? '');
    if (s.length > 4096) s = s.slice(0, 4096);
    s = s.replace(FILE_URL, '<path>')
        .replace(MULTIADDR, m => `<${addrClass(m).addr}>`)
        .replace(WIN_PATH, '<path>')
        .replace(POSIX_PATH, '<path>')
        .replace(IPV4, (m, ip) => (isIP(ip) ? `<${ipClass(ip)}>` : m))
        .replace(IPV6, m => {
            const ip = m.replace(/^\[|\](?::\d+)?$/g, '');
            return isIP(ip) === 6 ? `<${ipClass(ip)}>` : m;
        })
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// A stack trace with each path made relative to the app folder (or <path>), at most 6 frames.
export function scrubStack(stack, appRoot = null) {
    if (typeof stack !== 'string') return undefined;
    const lines = stack.split('\n').slice(1, 7).map(line => {
        let s = line.trim();
        if (appRoot) s = s.split(appRoot).join('<app>');
        return scrubText(s, 160);
    });
    return lines.join(' | ').slice(0, 600);
}

// ---- The fields of each event type ----

const PEER = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8,64})$/;
const CODE = /^[a-z0-9][a-z0-9 ._-]{0,63}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

const kinds = {
    int: v => (Number.isSafeInteger(v) ? v : Number.isFinite(v) ? Math.round(v) : undefined),
    num: v => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : undefined),
    bool: v => (typeof v === 'boolean' ? v : undefined),
    peer: v => (typeof v === 'string' && PEER.test(v) ? v : undefined),
    id: v => (typeof v === 'string' && ID.test(v) ? v : undefined),
    // A code of this program (a reason, a state, a mode): lower case, short. Not text of a peer.
    code: v => (typeof v === 'string' && CODE.test(v) ? v : undefined),
    version: v => (typeof v === 'string' && VERSION.test(v) ? v : undefined),
    text: v => (v === undefined || v === null ? undefined : scrubText(v)),
    stack: v => (typeof v === 'string' ? v.slice(0, 600) : undefined)
};
const oneOf = (...values) => v => (values.includes(v) ? v : undefined);

const ADDR = oneOf('lan', 'public', 'cgnat', 'loopback', 'link-local', 'relay', 'dns', 'other', 'unknown');
const TRANSPORT = oneOf('tcp', 'udp', 'ws', 'wss', 'quic-v1', 'webtransport');
const where = { addr: ADDR, transport: TRANSPORT, port: kinds.int };

// type -> { field: check }. A check gives the value to write, or undefined (the field is dropped).
export const EVENT_FIELDS = Object.freeze({
    start: { version: kinds.version, electron: kinds.version, chromium: kinds.version, node: kinds.version,
        os: kinds.version, arch: kinds.code, build: oneOf('portable', 'installed', 'dev', 'other'),
        data: oneOf('portable', 'installed', 'profile', 'default'), start: oneOf('manual', 'sign-in', 'second'),
        prevClean: kinds.bool, tzOffsetMin: kinds.int, pid: kinds.int },
    env: { cpu: kinds.text, cpus: kinds.int, ramMb: kinds.int, displays: kinds.int, scale: kinds.num,
        gpu: kinds.code, ifLan: kinds.int, ifPublic: kinds.int, ifCgnat: kinds.int, ifVirtual: kinds.int },
    ready: { ms: kinds.int },
    quit: { uptimeS: kinds.int, lines: kinds.int },
    'previous-run-unclean': { run: kinds.id, lastT: kinds.int, lastType: kinds.code },
    'concurrent-run': { pid: kinds.int },
    power: { state: oneOf('suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown') },
    'clock-jump': { deltaMs: kinds.int },
    suppressed: { of: kinds.code, count: kinds.int },
    log: { level: oneOf('INFO', 'WARN', 'ERROR', 'EVENT'), text: kinds.text },
    room: { event: oneOf('start', 'start-failed', 'leave', 'reopen'), kind: oneOf('new', 'lan', 'join', 'reopen'),
        protected: kinds.bool, lan: kinds.bool, upnp: kinds.bool, address: kinds.bool, reason: kinds.code, peer: kinds.peer },
    session: { state: oneOf('open', 'closed', 'replaced'), peer: kinds.peer, route: oneOf('direct', 'relay', 'unknown'),
        dir: oneOf('in', 'out', '?'), relay: kinds.peer, ...where, secs: kinds.num, sid: kinds.id, peerSid: kinds.id },
    'session-ids': { peer: kinds.peer, sid: kinds.id, peerSid: kinds.id, clock: kinds.bool, diag: kinds.bool },
    'session-refused': { peer: kinds.peer, cause: kinds.code },
    'peer-left': { peer: kinds.peer, left: oneOf('bye', 'lost') },
    dial: { peer: kinds.peer, via: kinds.code, result: oneOf('ok', 'failed'), reason: kinds.code, ...where,
        error: kinds.text, count: kinds.int },
    upnp: { state: kinds.code, reason: kinds.code, port: kinds.int, external: ADDR, renew: kinds.bool },
    'full-node': { peer: kinds.peer, on: kinds.bool, self: kinds.bool },
    host: { host: kinds.peer, term: kinds.int, reason: kinds.code, self: kinds.bool, none: kinds.bool },
    admission: { event: oneOf('admitted', 'refused', 'revoked', 'invite-made'), peer: kinds.peer, cause: kinds.code },
    reach: { state: kinds.code, reason: kinds.code, proven: kinds.bool },
    clock: { peer: kinds.peer, rttMs: kinds.int, offsetMs: kinds.int },
    'voice-state': { in: kinds.bool, muted: kinds.bool, deafened: kinds.bool, host: kinds.bool },
    'voice-device': { dir: oneOf('in', 'out'), ok: kinds.bool, kind: kinds.code, tag: kinds.id, fallback: kinds.bool,
        error: kinds.code, sampleRate: kinds.int, channels: kinds.int, ec: kinds.bool, ns: kinds.bool, agc: kinds.bool,
        suppressor: oneOf('rnnoise', 'standard', 'off'), reopen: kinds.bool, ended: kinds.bool },
    'voice-summary': { origin: kinds.peer, frames: kinds.int, gaps: kinds.int, dups: kinds.int, late: kinds.int,
        jitterMs: kinds.num, trims: kinds.int, decodeErrors: kinds.int, own: kinds.bool,
        sent: kinds.int, gateOpenPct: kinds.num, encodeErrors: kinds.int, sendErrors: kinds.int, secs: kinds.int },
    'voice-relay': { forwarded: kinds.int, dropped: kinds.int, duplicates: kinds.int, direct: kinds.int, host: kinds.bool },
    ptt: { status: kinds.code, mode: kinds.code, global: kinds.bool, presses: kinds.int },
    file: { event: oneOf('offer', 'action', 'done', 'failed', 'refused', 'cancelled', 'paused', 'resumed', 'restarted',
        'discarded', 'expired', 'retried'), offer: kinds.id, dir: oneOf('send', 'receive'), by: oneOf('self', 'peer', 'none'),
        size: kinds.int, reason: kinds.code, action: kinds.code, peer: kinds.peer, retryOf: kinds.id },
    screen: { event: oneOf('start', 'stop', 'watch-end', 'tier', 'stats'), share: kinds.id, preset: kinds.code,
        reason: kinds.code, tier: kinds.code, why: kinds.code, viewers: kinds.int },
    update: { event: kinds.code, ok: kinds.bool, reason: kinds.code, text: kinds.text },
    crash: { process: kinds.code, reason: kinds.code, exitCode: kinds.int, service: kinds.code },
    hang: { state: oneOf('unresponsive', 'responsive'), ms: kinds.int },
    error: { where: oneOf('main', 'renderer'), kind: oneOf('exception', 'rejection'), errorType: kinds.code,
        message: kinds.text, stack: kinds.stack },
    metrics: { loopP50: kinds.num, loopP99: kinds.num, loopMax: kinds.num, cpuPct: kinds.num, sysCpuPct: kinds.num,
        memMb: kinds.int, rendererMb: kinds.int, gpuMb: kinds.int, longTasks: kinds.int, longMaxMs: kinds.int },
    mark: { category: oneOf('voice-bad', 'cannot-hear-them', 'they-cannot-hear-me', 'screen-bad', 'cannot-connect',
        'file-failed', 'other'), peer: kinds.peer, inVoice: kinds.bool, sharing: kinds.bool, peers: kinds.int },
    diag: { event: oneOf('ask', 'asked', 'prompt', 'sent', 'declined', 'refused', 'expired', 'granted', 'received', 'saved',
        'failed', 'save-failed', 'saved-own'), peer: kinds.peer, id: kinds.id, reason: kinds.code, size: kinds.int,
        crashDumps: kinds.bool },
    'writer-error': { code: kinds.code }
});

// The budget of a type: a burst and a refill each second. A line over the budget is not written; the writer gives one
// "suppressed" line for each type and window.
const BUDGETS = { default: [60, 1], log: [200, 4], dial: [60, 0.5], 'voice-summary': [120, 2], error: [30, 0.2],
    file: [200, 4], session: [120, 2], 'session-refused': [30, 0.5] };

// Gives { type, ...fields } with only the allowed fields, or null for an unknown type.
export function redact(type, fields = {}) {
    const spec = EVENT_FIELDS[type];
    if (!spec || fields === null || typeof fields !== 'object') return null;
    const out = { type };
    for (const [key, check] of Object.entries(spec)) {
        if (!Object.hasOwn(fields, key)) continue;
        const value = check(fields[key]);
        if (value !== undefined) out[key] = value;
    }
    return out;
}

function compactStamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace('.', '');
}

export function listJournalFiles(dir, fsx = fs) {
    let names;
    try { names = fsx.readdirSync(dir); } catch { return []; }
    return names.filter(name => JOURNAL_NAME.test(name)).sort();
}

// The time and type of the last complete line of a journal file (the last 8 KB), or null.
export function lastLine(file, fsx = fs) {
    let fd;
    try {
        fd = fsx.openSync(file, 'r');
        const size = fsx.fstatSync(fd).size;
        const length = Math.min(size, 8192);
        const buf = Buffer.alloc(length);
        fsx.readSync(fd, buf, 0, length, size - length);
        const lines = buf.toString('utf8').split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            try { const v = JSON.parse(lines[i]); if (Number.isFinite(v.t)) return { t: v.t, type: v.type, run: v.run }; } catch { /* a cut line */ }
        }
    } catch { /* no file */ }
    finally { if (fd !== undefined) try { fsx.closeSync(fd); } catch { /* ignore */ } }
    return null;
}

// The journal of one run.
// dir: the diagnostics folder. now: wall clock ms. mono: monotonic ms. timers: { setTimeout, clearTimeout }.
export function createJournal({ dir, fsx = fs, now = Date.now, mono = () => performance.now(), run = randomBytes(4).toString('hex'),
    fileBytes = FILE_BYTES, maxFiles = MAX_FILES, maxAgeMs = MAX_AGE_MS, flushMs = FLUSH_MS, flushBytes = FLUSH_BYTES,
    budgets = BUDGETS, timers = { setTimeout, clearTimeout }, onError = () => {} } = {}) {
    let n = 0;
    let buffer = '';
    let file = null;
    let fileSize = 0;
    let fileSeq = 0;
    let failed = null;
    let timer = null;
    let writing = null;
    let lastT = null, lastM = null;
    let closed = false;
    const buckets = new Map();
    const suppressed = new Map();
    const counts = new Map();

    try { fsx.mkdirSync(dir, { recursive: true }); } catch (err) { fail(err); }

    function fail(err) {
        if (failed) return;
        failed = err?.code ?? 'write-failed';
        buffer = '';
        if (timer) { timers.clearTimeout(timer); timer = null; }
        // One line, one time, best effort. Then the journal stops until the next run.
        try {
            if (file) fsx.appendFileSync(file, JSON.stringify({ v: SCHEMA_VERSION, run, n: ++n, t: now(), m: Math.round(mono()),
                type: 'writer-error', code: kinds.code(String(failed).toLowerCase()) ?? 'other' }) + '\n');
        } catch { /* nothing more */ }
        try { onError(failed); } catch { /* ignore */ }
    }

    function allow(type) {
        const [burst, rate] = budgets[type] ?? budgets.default;
        const t = mono();
        let b = buckets.get(type);
        if (!b) { b = { tokens: burst, at: t }; buckets.set(type, b); }
        b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * rate);
        b.at = t;
        if (b.tokens >= 1) { b.tokens -= 1; return true; }
        suppressed.set(type, (suppressed.get(type) ?? 0) + 1);
        return false;
    }

    function newFile() {
        file = path.join(dir, `journal-${compactStamp(now())}-${run}-${fileSeq++}.jsonl`);
        fileSize = 0;
        prune();
    }

    // Drop the oldest files: more than maxFiles, or older than maxAgeMs. The file of this run stays.
    function prune() {
        const names = listJournalFiles(dir, fsx);
        const current = file ? path.basename(file) : null;
        const others = names.filter(name => name !== current);
        const keep = Math.max(0, maxFiles - (current ? 1 : 0));
        const limit = now() - maxAgeMs;
        others.forEach((name, i) => {
            const full = path.join(dir, name);
            let old = i < others.length - keep;
            if (!old) { try { old = fsx.statSync(full).mtimeMs < limit; } catch { old = false; } }
            if (old) { try { fsx.rmSync(full, { force: true }); } catch { /* next rotation */ } }
        });
    }

    function line(record) {
        const t = now();
        const m = Math.round(mono());
        let jump = '';
        if (lastT !== null) {
            const delta = (t - lastT) - (m - lastM);
            if (Math.abs(delta) > 2000) {
                jump = JSON.stringify({ v: SCHEMA_VERSION, run, n: ++n, t, m, type: 'clock-jump', deltaMs: Math.round(delta) }) + '\n';
            }
        }
        lastT = t; lastM = m;
        return jump + JSON.stringify({ v: SCHEMA_VERSION, run, n: ++n, t, m, ...record }) + '\n';
    }

    function drainSuppressed() {
        let text = '';
        for (const [type, count] of suppressed) text += line({ type: 'suppressed', of: type, count });
        buffer += text;
        suppressed.clear();
    }

    function schedule() {
        if (timer || failed || closed) return;
        timer = timers.setTimeout(() => { timer = null; flush(); }, flushMs);
        timer?.unref?.();
    }

    // Takes the buffer, with rotation at fileBytes. Gives [[file, text], ...].
    function take() {
        const out = [];
        let text = buffer;
        buffer = '';
        while (text) {
            if (!file || fileSize >= fileBytes) newFile();
            let part = text;
            const room = fileBytes - fileSize;
            if (Buffer.byteLength(part) > room) {
                // Cut at a line end that fits; at least one line goes to each file.
                let cut = part.lastIndexOf('\n', room - 1);
                if (cut < 0) {
                    if (fileSize > 0) { newFile(); continue; }
                    cut = part.indexOf('\n');
                }
                part = text.slice(0, cut + 1);
            }
            text = text.slice(part.length);
            fileSize += Buffer.byteLength(part);
            out.push([file, part]);
        }
        return out;
    }

    function flush() {
        if (failed || writing) { if (!failed && buffer) schedule(); return writing ?? Promise.resolve(); }
        if (suppressed.size) drainSuppressed();
        if (!buffer) return Promise.resolve();
        const parts = take();
        writing = (async () => {
            for (const [target, text] of parts) await fsx.promises.appendFile(target, text);
            if (parts.length > 1) prune();
        })().catch(fail).finally(() => {
            writing = null;
            if (buffer) schedule();
        });
        return writing;
    }

    function flushSync() {
        if (failed) return;
        if (timer) { timers.clearTimeout(timer); timer = null; }
        if (suppressed.size) drainSuppressed();
        if (!buffer) return;
        try {
            const parts = take();
            for (const [target, text] of parts) fsx.appendFileSync(target, text);
            if (parts.length > 1) prune();
        } catch (err) { fail(err); }
    }

    // Writes one event. Unknown types and fields are dropped (redact). Returns true when the line is in the buffer.
    function write(type, fields) {
        if (failed || closed) return false;
        const record = redact(type, fields);
        if (!record) return false;
        if (!allow(type)) return false;
        counts.set(type, (counts.get(type) ?? 0) + 1);
        const text = line(record);
        buffer += text;
        if (Buffer.byteLength(buffer) >= flushBytes) flush();
        else schedule();
        return true;
    }

    return {
        run, write, flush, flushSync,
        get failed() { return failed; },
        get lines() { return n; },
        counts: () => Object.fromEntries(counts),
        files: () => listJournalFiles(dir, fsx).map(name => path.join(dir, name)),
        close() { flushSync(); closed = true; }
    };
}

// ---- runs.jsonl and the running marker ----

function readJsonLines(file, fsx) {
    try {
        return fsx.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(text => {
            try { return JSON.parse(text); } catch { return null; }
        }).filter(v => v && typeof v === 'object');
    } catch { return []; }
}

function writeAtomic(file, text, fsx) {
    fsx.writeFileSync(`${file}.tmp`, text);
    fsx.renameSync(`${file}.tmp`, file);
}

// Puts or replaces the line of one run in runs.jsonl (at most maxRuns lines, the newest last).
export function recordRun(dir, entry, { fsx = fs, maxRuns = MAX_RUNS } = {}) {
    const file = path.join(dir, RUNS_FILE);
    const rows = readJsonLines(file, fsx).filter(row => row.run !== entry.run);
    rows.push(entry);
    writeAtomic(file, rows.slice(-maxRuns).map(row => JSON.stringify(row)).join('\n') + '\n', fsx);
}

// The start of a run: reads the marker of the previous run and writes the marker of this run.
// alive(pid): true when that process runs (then it is a second copy on the same folder, not an unclean end).
// Gives { previous: null | { run, pid, t }, concurrent: boolean, last: { t, type } | null }.
export function beginRun(dir, { run, pid, t, alive = () => false, fsx = fs }) {
    const marker = path.join(dir, MARKER_FILE);
    let previous = null;
    try {
        const value = JSON.parse(fsx.readFileSync(marker, 'utf8'));
        if (value && typeof value === 'object' && typeof value.run === 'string') previous = value;
    } catch { /* no marker: the last run ended cleanly */ }
    const concurrent = previous !== null && Number.isInteger(previous.pid) && previous.pid !== pid && alive(previous.pid);
    let last = null;
    if (previous && !concurrent) {
        const files = listJournalFiles(dir, fsx);
        for (let i = files.length - 1; i >= 0 && !last; i--) {
            const found = lastLine(path.join(dir, files[i]), fsx);
            if (found && found.run === previous.run) last = found;
        }
    }
    if (!concurrent) {
        try { fsx.mkdirSync(dir, { recursive: true }); writeAtomic(marker, JSON.stringify({ run, pid, t }), fsx); } catch { /* journal off */ }
    }
    return { previous: concurrent ? null : previous, concurrent, last };
}

// A clean end: the marker goes away (only the marker of this run).
export function endRun(dir, run, fsx = fs) {
    const marker = path.join(dir, MARKER_FILE);
    try {
        const value = JSON.parse(fsx.readFileSync(marker, 'utf8'));
        if (value?.run === run) fsx.rmSync(marker, { force: true });
    } catch { /* gone */ }
}

// ---- Device labels ----

const DEVICE_KINDS = [
    [/steam streaming/i, 'steam-streaming'], [/vb-audio|voicemeeter|cable (in|out)put/i, 'virtual-cable'],
    [/nvidia broadcast|rtx voice/i, 'nvidia-broadcast'], [/krisp/i, 'krisp'], [/realtek/i, 'realtek'],
    [/hands-free|airpods|bluetooth|\bbt\b/i, 'bluetooth'], [/usb/i, 'usb'], [/hdmi|display audio|nvidia high definition/i, 'hdmi'],
    [/webcam|camera|c9\d\d|brio/i, 'webcam'], [/headset|headphone/i, 'headset'], [/microphone array|mic array/i, 'mic-array'],
    [/^default\b|^default -/i, 'default'], [/^communications\b|^communications -/i, 'communications']
];

// A device label gives { kind, tag }: a fixed kind from a list of known words, and the first 8 hex characters of an
// HMAC of the label with a key of this data folder. The label itself (it can be a name: "Bob's AirPods") never goes
// in the journal. The tag tells two devices apart in one bundle.
export function deviceClass(label, key) {
    const text = typeof label === 'string' ? label : '';
    if (!text) return { kind: 'unknown' };
    const kind = DEVICE_KINDS.find(([re]) => re.test(text))?.[1] ?? 'other';
    const tag = key ? createHmac('sha256', key).update(text).digest('hex').slice(0, 8) : undefined;
    return tag ? { kind, tag } : { kind };
}

// The random key of the device tags, in the diagnostics folder. A missing or bad file gets a new key.
export function tagKey(dir, fsx = fs) {
    const file = path.join(dir, 'tag-key.json');
    try {
        const value = JSON.parse(fsx.readFileSync(file, 'utf8'));
        if (typeof value?.key === 'string' && /^[0-9a-f]{32}$/.test(value.key)) return value.key;
    } catch { /* new key */ }
    const key = randomBytes(16).toString('hex');
    try { fsx.mkdirSync(dir, { recursive: true }); writeAtomic(file, JSON.stringify({ key }), fsx); } catch { /* this run only */ }
    return key;
}
