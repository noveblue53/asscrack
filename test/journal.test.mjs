// The diagnostics journal (journal.mjs): the allowlist, the redaction, the rotation, the budgets, the clock and the
// run records. No Electron, no network. Each result is a result of this PC.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { addrClass, beginRun, createJournal, deviceClass, endRun, EVENT_FIELDS, ipClass, listJournalFiles, recordRun,
    redact, scrubStack, scrubText, tagKey } from '../src/application/journal.mjs';

const PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const tempDir = t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-journal-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const readLines = dir => listJournalFiles(dir).flatMap(name => readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse));

test('the writer keeps only the fields of the allowlist and drops unknown types', () => {
    assert.equal(redact('chat', { text: 'x' }), null);
    assert.equal(redact('no-such-type', {}), null);
    const r = redact('session', { state: 'open', peer: PEER, route: 'direct', addr: 'lan', port: 4001, name: 'Alice',
        text: 'hello', roomKey: 'k', invite: 'asscrack3:abc', secs: 1.23456 });
    assert.deepEqual(r, { type: 'session', state: 'open', peer: PEER, route: 'direct', addr: 'lan', port: 4001, secs: 1.235 });
    // A value that does not fit its kind is dropped: a peer ID must be a peer ID, a code is lower case and short.
    assert.deepEqual(redact('session', { peer: 'Alice', route: 'carrier pigeon', state: 'open' }), { type: 'session', state: 'open' });
    assert.deepEqual(redact('file', { event: 'failed', reason: 'Secret File Name.txt', offer: 'not an id' }), { type: 'file', event: 'failed' });
    for (const [type, spec] of Object.entries(EVENT_FIELDS)) {
        for (const field of Object.keys(spec)) {
            assert.ok(!/name|text$|key|invite|grant|clipboard|topic|path|ip$/i.test(field) || ['text'].includes(field),
                `field ${type}.${field} looks like content`);
        }
    }
});

test('error text loses each path and each address, and stays short', () => {
    const text = scrubText('Store C:\\Users\\Bob\\AppData\\Roaming\\ASSCRACK\\rooms\\x.json not written, dial /ip4/203.0.113.9/tcp/4001/p2p/' +
        PEER + ' failed via 192.168.1.20:5000 and [2001:db8::1]:443 at \\\\nas\\share\\f and /home/bob/x.txt file:///C:/a/b');
    assert.ok(!/Bob|203\.0\.113|192\.168|2001:db8|nas|home/.test(text), text);
    assert.match(text, /<path>/);
    assert.match(text, /<public>/);
    assert.match(text, /<lan>/);
    assert.ok(text.length <= 120);
    assert.equal(scrubText('x'.repeat(500)).length, 120);
    assert.equal(scrubText('line\u0000one\r\ntwo'), 'line one two');
    const stack = scrubStack('Error: x\n    at f (D:\\wt\\app\\src\\a.js:1:2)\n    at g (C:\\Users\\Bob\\b.js:3:4)', 'D:\\wt\\app');
    assert.ok(stack.includes('<app>') && !stack.includes('Bob'), stack);
});

test('addresses become a class, a transport and a port', () => {
    assert.deepEqual(addrClass('/ip4/192.168.1.5/tcp/4001/p2p/' + PEER), { addr: 'lan', transport: 'tcp', port: 4001 });
    assert.deepEqual(addrClass('/ip4/8.8.8.8/tcp/443/ws'), { addr: 'public', transport: 'ws', port: 443 });
    assert.deepEqual(addrClass('/ip4/100.70.1.1/tcp/1'), { addr: 'cgnat', transport: 'tcp', port: 1 });
    assert.deepEqual(addrClass('/ip4/1.2.3.4/tcp/1/p2p/' + PEER + '/p2p-circuit/p2p/' + PEER).addr, 'relay');
    assert.deepEqual(addrClass('?'), { addr: 'unknown' });
    assert.equal(ipClass('127.0.0.1'), 'loopback');
    assert.equal(ipClass('fe80::1'), 'link-local');
    assert.equal(ipClass('fd00::1'), 'lan');
    assert.equal(ipClass('not an ip'), null);
});

test('rotation drops the oldest data, keeps at most 5 files of 1 MB and no file older than 7 days', async t => {
    const dir = tempDir(t);
    const old = path.join(dir, 'journal-20200101T000000000Z-00000000-0.jsonl');
    writeFileSync(old, '{"t":1}\n');
    const week = Date.now() / 1000 - 8 * 24 * 3600;
    utimesSync(old, week, week);
    const j = createJournal({ dir, fileBytes: 4096, maxFiles: 5, budgets: { default: [1e9, 0] } });
    for (let i = 0; i < 2000; i++) j.write('log', { level: 'INFO', text: `line ${i}` });
    j.flushSync();
    await j.flush();
    const files = listJournalFiles(dir);
    assert.ok(files.length <= 5, `files: ${files.length}`);
    assert.ok(!existsSync(old), 'the 8 days old file is gone');
    for (const name of files) assert.ok(fs.statSync(path.join(dir, name)).size <= 4096, name);
    const lines = readLines(dir);
    const texts = lines.filter(l => l.type === 'log').map(l => l.text);
    // The newest lines stay (the 4 MB rule of the old log lost the newest lines).
    assert.equal(texts.at(-1), 'line 1999');
    assert.ok(!texts.includes('line 0'), 'the oldest lines are gone');
    // The line counter has no gap inside the kept data.
    const ns = lines.map(l => l.n);
    for (let i = 1; i < ns.length; i++) assert.equal(ns[i], ns[i - 1] + 1);
});

test('each line has the schema version, the run, the counter, the wall clock and the monotonic clock', t => {
    const dir = tempDir(t);
    let wall = 1_700_000_000_000, mono = 5000;
    const j = createJournal({ dir, now: () => wall, mono: () => mono, run: 'abcdef12' });
    j.write('ready', { ms: 812 });
    wall += 1000; mono += 1000;
    j.write('ready', { ms: 1 });
    // The wall clock jumps 30 s forward (a time sync), the monotonic clock does not.
    wall += 30_000; mono += 10;
    j.write('ready', { ms: 2 });
    j.flushSync();
    const lines = readLines(dir);
    assert.deepEqual(lines[0], { v: 1, run: 'abcdef12', n: 1, t: 1_700_000_000_000, m: 5000, type: 'ready', ms: 812 });
    const jump = lines.find(l => l.type === 'clock-jump');
    assert.ok(jump, 'a clock-jump line');
    assert.equal(jump.deltaMs, 29_990);
});

test('a type over its budget gives one suppressed line with the count', t => {
    const dir = tempDir(t);
    const j = createJournal({ dir, budgets: { default: [5, 0], error: [3, 0] }, mono: () => 0 });
    for (let i = 0; i < 50; i++) j.write('error', { where: 'main', kind: 'exception', message: `e${i}` });
    j.write('ready', { ms: 1 });
    j.flushSync();
    const lines = readLines(dir);
    assert.equal(lines.filter(l => l.type === 'error').length, 3);
    assert.deepEqual(lines.filter(l => l.type === 'suppressed').map(({ of, count }) => ({ of, count })), [{ of: 'error', count: 47 }]);
    assert.equal(lines.filter(l => l.type === 'ready').length, 1);
});

test('a write error stops the journal for this run and does not throw', async t => {
    const dir = tempDir(t);
    const errors = [];
    const fsx = { ...fs, promises: { ...fs.promises, appendFile: async () => { const e = new Error('full'); e.code = 'ENOSPC'; throw e; } } };
    const j = createJournal({ dir, fsx, onError: code => errors.push(code) });
    assert.equal(j.write('ready', { ms: 1 }), true);
    await j.flush();
    assert.equal(j.failed, 'ENOSPC');
    assert.deepEqual(errors, ['ENOSPC']);
    assert.equal(j.write('ready', { ms: 2 }), false);
    assert.doesNotThrow(() => j.flushSync());
});

test('write() never writes synchronously, and a slow disk adds no event-loop delay', async t => {
    const dir = tempDir(t);
    let syncCalls = 0, asyncCalls = 0;
    const slow = {
        ...fs,
        appendFileSync: (...args) => { syncCalls++; return fs.appendFileSync(...args); },
        promises: { ...fs.promises, appendFile: async (...args) => {
            asyncCalls++;
            await new Promise(r => setTimeout(r, 300));
            return fs.promises.appendFile(...args);
        } }
    };
    const j = createJournal({ dir, fsx: slow, flushMs: 10, flushBytes: 2048 });
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const start = performance.now();
    for (let i = 0; i < 3000; i++) {
        j.write('log', { level: 'INFO', text: `voice relay tick ${i}` });
        if (i % 100 === 0) await new Promise(r => setImmediate(r));
    }
    const spent = performance.now() - start;
    await new Promise(r => setTimeout(r, 700));
    h.disable();
    assert.equal(syncCalls, 0, 'no sync append outside flushSync');
    assert.ok(asyncCalls > 0);
    assert.ok(spent < 1000, `3000 writes took ${spent} ms`);
    assert.ok(h.max / 1e6 < 250, `event-loop delay max ${h.max / 1e6} ms with a disk of 300 ms`);
    j.flushSync();
});

test('runs.jsonl keeps the last 50 runs; the marker shows an unclean end and a second copy', t => {
    const dir = tempDir(t);
    for (let i = 0; i < 60; i++) recordRun(dir, { run: `run${i}`, t: i });
    const rows = readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 50);
    assert.equal(rows[0].run, 'run10');
    recordRun(dir, { run: 'run59', t: 59, end: 99 });
    assert.equal(readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1).end, 99);

    // Run A writes lines and stops with no clean end.
    const a = createJournal({ dir, run: 'aaaaaaaa' });
    assert.deepEqual(beginRun(dir, { run: 'aaaaaaaa', pid: 11, t: 1 }), { previous: null, concurrent: false, last: null });
    a.write('ready', { ms: 3 });
    a.flushSync();
    // Run B: the marker of A is there and process 11 does not run.
    const b = beginRun(dir, { run: 'bbbbbbbb', pid: 12, t: 2, alive: () => false });
    assert.equal(b.previous.run, 'aaaaaaaa');
    assert.equal(b.last.type, 'ready');
    // Run C while B runs (a second copy on the same folder): not an unclean end, and the marker of B stays.
    const c = beginRun(dir, { run: 'cccccccc', pid: 13, t: 3, alive: pid => pid === 12 });
    assert.deepEqual(c, { previous: null, concurrent: true, last: null });
    endRun(dir, 'cccccccc');
    assert.ok(existsSync(path.join(dir, 'running.json')), 'C does not remove the marker of B');
    endRun(dir, 'bbbbbbbb');
    assert.ok(!existsSync(path.join(dir, 'running.json')));
});

test('a device label becomes a kind and a tag, never the label', t => {
    const dir = tempDir(t);
    const key = tagKey(dir);
    assert.equal(tagKey(dir), key, 'the key stays for the data folder');
    const own = deviceClass("Headset (Bob's AirPods Pro)", key);
    assert.equal(own.kind, 'bluetooth');
    assert.match(own.tag, /^[0-9a-f]{8}$/);
    assert.ok(!JSON.stringify(own).includes('Bob'));
    assert.equal(deviceClass('Microphone (Steam Streaming Microphone)', key).kind, 'steam-streaming');
    assert.equal(deviceClass('Microphone (Realtek(R) Audio)', key).kind, 'realtek');
    assert.notEqual(deviceClass('A', key).tag, deviceClass('B', key).tag);
    assert.deepEqual(deviceClass('', key), { kind: 'unknown' });
});

test('the journal file names sort in time order and other files are not journal files', t => {
    const dir = tempDir(t);
    writeFileSync(path.join(dir, 'tag-key.json'), '{}');
    writeFileSync(path.join(dir, 'journal-x.jsonl'), '');
    const j = createJournal({ dir });
    j.write('ready', { ms: 1 });
    j.flushSync();
    assert.equal(listJournalFiles(dir).length, 1);
    assert.equal(readdirSync(dir).length, 3);
});

test('the curated log lines lose the push-to-talk key, and a repeated text is journaled once in 10 s', async () => {
    const { logDeduper, logText } = await import('../src/application/diagnostics.mjs');
    assert.equal(logText('voice settings mode ptt ptt-key KeyJ ptt-release 200'), 'voice settings mode ptt ptt-key set ptt-release 200');
    assert.equal(logText('ptt-key none'), 'ptt-key none');
    let t = 0;
    const dedupe = logDeduper({ now: () => t });
    assert.equal(dedupe('Voice frame send failed: x'), 'Voice frame send failed: x');
    for (let i = 0; i < 49; i++) assert.equal(dedupe('Voice frame send failed: x'), null);
    assert.equal(dedupe('other'), 'other');
    t = 10_000;
    assert.equal(dedupe('Voice frame send failed: x'), 'Voice frame send failed: x (and 49 more)');
});

test('await flush() followed by flushSync() waits for an in-flight async append and keeps all lines', async t => {
    const dir = tempDir(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const slow = {
        ...fs,
        promises: {
            ...fs.promises,
            appendFile: async (...args) => {
                await gate;
                return fs.promises.appendFile(...args);
            }
        }
    };
    const j = createJournal({ dir, fsx: slow, flushMs: 5000 });
    t.after(() => j.close());
    j.write('ready', { ms: 1 });
    const inFlight = j.flush();
    // flushSync() alone cannot wait for an in-flight async flush (the 1 s timer race in diag-knock).
    j.flushSync();
    assert.deepEqual(readLines(dir), []);
    j.write('ready', { ms: 2 });
    release();
    await inFlight;
    j.flushSync();
    assert.deepEqual(readLines(dir).map(l => l.ms), [1, 2]);
});
