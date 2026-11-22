// The diagnostics bundle (1.0.1, docs/DIAGNOSTICS.md): one standard zip file that Windows Explorer opens. Fixed file
// names only. The zip writer uses zlib of Node (deflateRaw and crc32), no package. This module does not import
// electron: main.js gives the folders and the values, the node tests use temporary folders.
//
// Files: manifest.json, summary.txt, journal-*.jsonl (newest last), runs.jsonl, system.json, reach.json,
// crashes/index.json, and crashes/*.dmp only with the second opt-in ("Add crash memory files").
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { listJournalFiles, RUNS_FILE, SCHEMA_VERSION } from './journal.mjs';

export const BUNDLE_SCHEMA = 1;
export const MAX_BUNDLE_BYTES = 12 * 1024 * 1024;
export const REDACTION = 'allowlist-1';
const MAX_DUMPS = 5;
const deflateRaw = promisify(zlib.deflateRaw);

// ---- The zip writer ----

function dosTime(ms) {
    const d = new Date(ms);
    const year = Math.max(1980, d.getFullYear());
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
}

// entries: [{ name, data: Buffer | string }]. Gives the bytes of a zip file (deflate when smaller, else store).
// The deflate runs in the thread pool of libuv (async): no long stall of the main thread.
export async function makeZip(entries, now = Date.now()) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    const { time, date } = dosTime(now);
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
        const crc = zlib.crc32(raw) >>> 0;
        const deflated = await deflateRaw(raw, { level: 6 });
        const useDeflate = deflated.length < raw.length;
        const body = useDeflate ? deflated : raw;
        const method = useDeflate ? 8 : 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, body);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

// ---- Reading the journal for the summary ----

export function readJournal(dir, fsx = fs) {
    const lines = [];
    for (const name of listJournalFiles(dir, fsx)) {
        let text = '';
        try { text = fsx.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
        for (const raw of text.split('\n')) {
            if (!raw) continue;
            try { const v = JSON.parse(raw); if (v && typeof v === 'object' && v.v === SCHEMA_VERSION) lines.push(v); } catch { /* a cut line */ }
        }
    }
    return lines;
}

const short = peer => (typeof peer === 'string' ? `${peer.slice(0, 6)}..${peer.slice(-4)}` : 'a peer');

function clockText(t, offsetMin) {
    return new Date(t + offsetMin * 60000).toISOString().slice(11, 16);
}

function dayText(t, offsetMin) {
    return new Date(t + offsetMin * 60000).toISOString().slice(0, 10);
}

function zoneText(offsetMin) {
    const sign = offsetMin < 0 ? '-' : '+';
    const a = Math.abs(offsetMin);
    return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`;
}

const MARKS = { 'voice-bad': 'voice is bad', 'cannot-hear-them': 'I cannot hear a person', 'they-cannot-hear-me': 'they cannot hear me',
    'screen-bad': 'screen share is bad', 'cannot-connect': 'I cannot connect', 'file-failed': 'a file failed', other: 'other' };

// The plain-English summary: what went right and what went wrong in each run, newest run last. The same text is
// the "What is in it" preview of the consent prompt.
export function summarize(lines, { maxLines = 400 } = {}) {
    const runs = new Map();
    for (const line of lines) {
        if (!runs.has(line.run)) runs.set(line.run, []);
        runs.get(line.run).push(line);
    }
    const out = [];
    for (const [run, list] of runs) {
        const start = list.find(l => l.type === 'start');
        const offset = Number.isInteger(start?.tzOffsetMin) ? start.tzOffsetMin : 0;
        const first = list[0];
        const at = t => clockText(t, offset);
        out.push('');
        out.push(`Run ${run}, ${dayText(first.t, offset)} ${at(first.t)} (${zoneText(offset)})` +
            (start ? `, v${start.version ?? '?'} ${start.build ?? '?'}, Windows ${start.os ?? '?'}` : ''));
        const sessions = { direct: 0, relay: 0, other: 0 };
        let voiceFrames = 0, voiceGaps = 0, voiceMinutes = 0, badMinutes = 0;
        const files = { done: 0, failed: 0, reasons: new Map() };
        let errors = 0, dialFailed = 0;
        for (const l of list) {
            switch (l.type) {
                case 'previous-run-unclean': out.push(`  ${at(l.t)} Previous run ended unexpectedly.`); break;
                case 'room':
                    if (l.event === 'start') out.push(`  ${at(l.t)} Opened a room (${l.kind ?? 'room'}${l.protected ? ', protected' : ''}${l.lan ? ', LAN' : ', internet'}).`);
                    else if (l.event === 'start-failed') out.push(`  ${at(l.t)} Room failed to open (${l.reason ?? 'other'}).`);
                    else if (l.event === 'leave') out.push(`  ${at(l.t)} Left the room.`);
                    break;
                case 'session':
                    if (l.state === 'open') {
                        sessions[l.route === 'direct' || l.route === 'relay' ? l.route : 'other']++;
                        out.push(`  ${at(l.t)} Connected to ${short(l.peer)} (${l.route ?? '?'}, ${l.addr ?? '?'}).`);
                    }
                    break;
                case 'peer-left':
                    out.push(`  ${at(l.t)} ${l.left === 'bye' ? `${short(l.peer)} left.` : `Lost connection to ${short(l.peer)}.`}`);
                    break;
                case 'session-refused': out.push(`  ${at(l.t)} Refused a session from ${short(l.peer)} (${l.cause}).`); break;
                case 'dial': dialFailed++; break;
                case 'upnp': if (l.state === 'mapped' || l.state === 'none') out.push(`  ${at(l.t)} UPnP: ${l.state === 'mapped' ? 'the router opened a port' : `no port (${l.reason ?? 'other'})`}.`); break;
                case 'host': if (l.self) out.push(`  ${at(l.t)} Became host (${l.reason ?? '?'}).`); break;
                case 'voice-state': out.push(`  ${at(l.t)} ${l.in ? 'Joined voice' : 'Left voice'}.`); break;
                case 'voice-device':
                    if (l.ok === false) out.push(`  ${at(l.t)} ${l.dir === 'out' ? 'Speaker' : 'Microphone'} failed to open (${l.error ?? 'other'}).`);
                    else if (l.fallback) out.push(`  ${at(l.t)} Chosen ${l.dir === 'out' ? 'speaker' : 'microphone'} missing, using default.`);
                    break;
                case 'voice-summary':
                    if (!l.own) {
                        voiceFrames += l.frames ?? 0;
                        voiceGaps += l.gaps ?? 0;
                        voiceMinutes++;
                        if ((l.gaps ?? 0) + (l.underruns ?? 0) > 5) badMinutes++;
                    }
                    break;
                case 'file':
                    if (l.event === 'done') files.done++;
                    else if (l.event === 'failed') {
                        files.failed++;
                        files.reasons.set(l.reason ?? 'other', (files.reasons.get(l.reason ?? 'other') ?? 0) + 1);
                    }
                    break;
                case 'crash': out.push(`  ${at(l.t)} Crash: ${l.process ?? '?'} process (${l.reason ?? '?'}).`); break;
                case 'hang': if (l.state === 'unresponsive') out.push(`  ${at(l.t)} Window not responding.`); break;
                case 'error': errors++; break;
                case 'mark': out.push(`  ${at(l.t)} Problem marked: ${MARKS[l.category] ?? 'other'}.`); break;
                case 'clock-jump': out.push(`  ${at(l.t)} System clock jumped ${Math.round(l.deltaMs / 1000)} s.`); break;
                case 'power': if (l.state === 'suspend' || l.state === 'resume') out.push(`  ${at(l.t)} PC ${l.state === 'suspend' ? 'went to sleep' : 'woke up'}.`); break;
                case 'diag':
                    if (l.event === 'sent') out.push(`  ${at(l.t)} Sent diagnostics to ${short(l.peer)}.`);
                    else if (l.event === 'received') out.push(`  ${at(l.t)} Received diagnostics from ${short(l.peer)}.`);
                    break;
                case 'quit': out.push(`  ${at(l.t)} Quit cleanly.`); break;
                default: break;
            }
        }
        const totals = [];
        if (sessions.direct + sessions.relay + sessions.other) totals.push(`${sessions.direct} direct and ${sessions.relay} relayed connections`);
        if (dialFailed) totals.push(`${dialFailed} failed dials`);
        if (voiceMinutes) {
            const loss = voiceFrames + voiceGaps ? (100 * voiceGaps / (voiceFrames + voiceGaps)).toFixed(1) : '0.0';
            totals.push(`voice: ${voiceMinutes} person-minutes, ${loss} % lost, ${badMinutes} with dropouts`);
        }
        if (files.done || files.failed) {
            totals.push(`${files.done} files done, ${files.failed} failed` + (files.reasons.size ?
                ` (${[...files.reasons].map(([r, n]) => `${n} ${r}`).join(', ')})` : ''));
        }
        if (errors) totals.push(`${errors} program errors`);
        if (totals.length) out.push(`  Totals: ${totals.join('; ')}.`);
    }
    const text = out.length > maxLines ? ['(Older lines are in the journal files.)', ...out.slice(-maxLines)] : out;
    return text.join('\n').trim() + '\n';
}

// ---- Crash dumps ----

// The minidump files of the crash folder of Electron (Crashpad: reports, completed, pending). Newest first.
export function listDumps(crashDir, fsx = fs) {
    const found = [];
    const walk = (dir, depth) => {
        let entries;
        try { entries = fsx.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
            else if (entry.isFile() && /\.dmp$/i.test(entry.name)) {
                try { const st = fsx.statSync(full); found.push({ file: full, name: entry.name, size: st.size, t: Math.round(st.mtimeMs) }); } catch { /* gone */ }
            }
        }
    };
    if (crashDir) walk(crashDir, 0);
    return found.sort((a, b) => b.t - a.t);
}

const sha256 = data => createHash('sha256').update(data).digest('hex');

// Makes the bundle. diagDir: the diagnostics folder (journal and runs). crashDir: the Crashpad folder.
// system, reach: objects of main.js (no path, no address). exe: { sha256 } of the program file.
// includeDumps: the second opt-in. Gives { zip, manifest, summary, names }.
export async function buildBundle({ diagDir, crashDir = null, includeDumps = false, system = {}, reach = null, exe = {},
    maxBytes = MAX_BUNDLE_BYTES, now = Date.now(), fsx = fs }) {
    const lines = readJournal(diagDir, fsx);
    const summary = summarize(lines);
    const journalNames = listJournalFiles(diagDir, fsx);
    const dumps = listDumps(crashDir, fsx).slice(0, MAX_DUMPS);
    const crashIndex = { v: 1, dumps: dumps.map(({ name, size, t }) => ({ name, size, t })), included: includeDumps === true,
        events: lines.filter(l => l.type === 'crash' || l.type === 'hang' || l.type === 'previous-run-unclean') };

    const base = [
        { name: 'summary.txt', data: summary },
        { name: 'system.json', data: JSON.stringify(system, null, 2) },
        { name: 'reach.json', data: JSON.stringify(reach ?? {}, null, 2) },
        { name: 'crashes/index.json', data: JSON.stringify(crashIndex, null, 2) }
    ];
    let runs = null;
    try { runs = fsx.readFileSync(path.join(diagDir, RUNS_FILE)); } catch { /* none */ }
    if (runs) base.push({ name: RUNS_FILE, data: runs });
    const journals = [];
    for (const name of journalNames) {
        try { journals.push({ name, data: fsx.readFileSync(path.join(diagDir, name)) }); } catch { /* rotated away */ }
    }
    const dumpEntries = [];
    if (includeDumps) {
        for (const d of dumps) {
            try { dumpEntries.push({ name: `crashes/${d.name.replace(/[^A-Za-z0-9._-]/g, '_')}`, data: fsx.readFileSync(d.file) }); } catch { /* gone */ }
        }
    }
    // The size cap: the oldest journal files go first, then the dumps.
    const assemble = async () => {
        const files = [...base, ...journals, ...dumpEntries].map(e => ({ ...e, data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8') }));
        const manifest = {
            v: BUNDLE_SCHEMA, journalSchema: SCHEMA_VERSION, made: now, tzOffsetMin: -new Date(now).getTimezoneOffset(),
            app: system.version ?? null, build: system.build ?? null, exeSha256: exe.sha256 ?? null, redaction: REDACTION,
            crashDumps: dumpEntries.length > 0, droppedJournalFiles: journalNames.length - journals.length,
            files: files.map(f => ({ name: f.name, size: f.data.length, sha256: sha256(f.data) }))
        };
        const zip = await makeZip([{ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }, ...files], now);
        return { zip, manifest };
    };
    let result = await assemble();
    while (result.zip.length > maxBytes && (journals.length > 1 || dumpEntries.length)) {
        if (journals.length > 1) journals.shift();
        else dumpEntries.pop();
        result = await assemble();
    }
    return { ...result, summary, names: ['manifest.json', ...result.manifest.files.map(f => f.name)] };
}

// The SHA-256 of a file, streamed (the exe is large: no sync read on the main thread).
export function hashFile(file) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        fs.createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
    });
}
