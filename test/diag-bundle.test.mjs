// The diagnostics bundle (diag-bundle.mjs) and the projection of the node events (diag-events.mjs). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildBundle, makeZip, summarize } from '../src/application/diag-bundle.mjs';
import { createJournal, redact } from '../src/application/journal.mjs';
import { loginErrorCode, projectNodeEvent, refuseCause } from '../src/application/diag-events.mjs';
import { readZip } from './helpers/zip-reader.mjs';

const PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const RELAY = '12D3KooWRBy97UB99e3J6hiPesre1MZeuNQvfan4gBziswrRJsNK';
const tempDir = t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-bundle-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

test('the zip is a standard zip with a CRC for each file', async () => {
    const zip = await makeZip([{ name: 'a.txt', data: 'x'.repeat(1000) }, { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]) }]);
    const entries = readZip(zip);
    assert.equal(entries.get('a.txt').toString(), 'x'.repeat(1000));
    assert.deepEqual([...entries.get('dir/b.bin')], [1, 2, 3]);
    assert.ok(zip.length < 1000, 'deflate is used when smaller');
});

test('the bundle has the fixed file list, a manifest with the hash of each file, and the summary', async t => {
    const dir = tempDir(t);
    const j = createJournal({ dir, run: 'abcdef12' });
    j.write('start', { version: '1.0.1', build: 'portable', os: '10.0.19045', tzOffsetMin: 60 });
    j.write('room', { event: 'start', kind: 'join', protected: true, lan: false });
    j.write('session', { state: 'open', peer: PEER, route: 'relay', addr: 'relay' });
    j.write('peer-left', { peer: PEER, left: 'lost' });
    j.write('file', { event: 'failed', reason: 'peer left' });
    j.write('mark', { category: 'voice-bad' });
    j.write('voice-summary', { origin: PEER, frames: 2970, gaps: 30, underruns: 1 });
    j.flushSync();
    const crash = path.join(dir, 'Crashpad', 'reports');
    mkdirSync(crash, { recursive: true });
    writeFileSync(path.join(crash, '0c8a.dmp'), Buffer.alloc(2048, 7));
    const plain = await buildBundle({ diagDir: dir, crashDir: path.join(dir, 'Crashpad'), system: { version: '1.0.1', build: 'portable' },
        reach: { state: 'ready' }, exe: { sha256: 'e'.repeat(64) } });
    const entries = readZip(plain.zip);
    const names = [...entries.keys()].sort();
    assert.deepEqual(names.filter(n => !n.startsWith('journal-')), ['crashes/index.json', 'manifest.json', 'reach.json', 'runs.jsonl', 'summary.txt', 'system.json'].filter(n => n !== 'runs.jsonl'));
    assert.equal(names.filter(n => n.startsWith('journal-')).length, 1);
    const manifest = JSON.parse(entries.get('manifest.json'));
    assert.equal(manifest.exeSha256, 'e'.repeat(64));
    assert.equal(manifest.crashDumps, false);
    for (const f of manifest.files) assert.equal(createHash('sha256').update(entries.get(f.name)).digest('hex'), f.sha256, f.name);
    const index = JSON.parse(entries.get('crashes/index.json'));
    assert.deepEqual(index.dumps.map(d => d.name), ['0c8a.dmp'], 'the metadata of the dump, not its bytes');
    const summary = entries.get('summary.txt').toString();
    assert.match(summary, /Run abcdef12/);
    assert.match(summary, /Opened a room \(join, protected, internet\)/);
    assert.match(summary, /Lost the link to/);
    assert.match(summary, /You marked a problem: voice is bad/);
    assert.match(summary, /1\.0 % lost/);
    assert.match(summary, /0 files done, 1 failed \(1 peer left\)/);
    assert.equal(plain.summary, summary);

    // The second opt-in adds the memory files.
    const withDumps = readZip((await buildBundle({ diagDir: dir, crashDir: path.join(dir, 'Crashpad'), includeDumps: true })).zip);
    assert.ok(withDumps.has('crashes/0c8a.dmp'));
    assert.equal(JSON.parse(withDumps.get('manifest.json')).crashDumps, true);
});

test('the size cap drops the oldest journal files first', async t => {
    const dir = tempDir(t);
    const j = createJournal({ dir, fileBytes: 64 * 1024, maxFiles: 5, budgets: { default: [1e9, 0] } });
    // Text that does not compress: random hex.
    for (let i = 0; i < 1500; i++) j.write('log', { level: 'INFO', text: createHash('sha256').update(String(i)).digest('hex') + createHash('sha256').update('x' + i).digest('hex') });
    j.flushSync();
    const all = await buildBundle({ diagDir: dir });
    const capped = await buildBundle({ diagDir: dir, maxBytes: Math.floor(all.zip.length / 2) });
    assert.ok(capped.zip.length <= Math.floor(all.zip.length / 2));
    assert.ok(capped.manifest.droppedJournalFiles > 0);
    const kept = [...readZip(capped.zip).keys()].filter(n => n.startsWith('journal-')).sort();
    const allJournals = [...readZip(all.zip).keys()].filter(n => n.startsWith('journal-')).sort();
    assert.deepEqual(kept, allJournals.slice(-kept.length), 'the newest files stay');
});

test('the projection names each field and turns each address into a class', () => {
    assert.deepEqual(projectNodeEvent('connection', { state: 'session', peer: PEER, type: 'relay', dir: 'out', relay: RELAY,
        addr: `/ip4/203.0.113.7/tcp/4001/p2p/${RELAY}/p2p-circuit/p2p/${PEER}`, sid: 'a'.repeat(16), name: 'Bob' }),
    ['session', { state: 'open', peer: PEER, route: 'relay', dir: 'out', relay: RELAY, addr: 'relay', transport: 'tcp', port: 4001,
        sid: 'a'.repeat(16), peerSid: undefined }]);
    const [, dial] = projectNodeEvent('dial-failed', { peer: PEER, via: 'address', reason: 'timeout', addr: '/ip4/192.168.1.9/tcp/5000',
        error: 'dial /ip4/192.168.1.9/tcp/5000 timed out' });
    assert.equal(dial.addr, 'lan');
    assert.ok(!JSON.stringify(redact('dial', dial)).includes('192.168'), 'the journal writer scrubs the error text');
    assert.deepEqual(projectNodeEvent('upnp', { state: 'mapped', ip: '203.0.113.7', port: 47000, local: '192.168.1.9' }),
        ['upnp', { state: 'mapped', reason: undefined, port: 47000, external: 'public', renew: undefined }]);
    const [, file] = projectNodeEvent('file-discarded', { key: 'k', name: 'secret.txt', size: 5, offerId: 'x' });
    assert.ok(!JSON.stringify(file).includes('secret'));
    assert.equal(projectNodeEvent('message', { text: 'hi' }), null);
    assert.equal(projectNodeEvent('pm', { text: 'hi' }), null);
    assert.equal(refuseCause('no valid proof in 10000 ms'), 'timeout');
    assert.equal(refuseCause('wrong proof'), 'wrong-proof');
    assert.equal(loginErrorCode(new Error('This invite has expired. Ask for a new one.')), 'invite-expired');
    assert.equal(loginErrorCode(Object.assign(new Error('x'), { code: 'EADDRINUSE' })), 'address-in-use');
});

test('the summary is plain text with the local time of each run', () => {
    const t0 = Date.UTC(2026, 10, 22, 19, 1);
    const text = summarize([
        { v: 1, run: 'r1', n: 1, t: t0, type: 'start', version: '1.0.1', build: 'portable', os: '10', tzOffsetMin: 60 },
        { v: 1, run: 'r1', n: 2, t: t0 + 60000, type: 'previous-run-unclean' },
        { v: 1, run: 'r1', n: 3, t: t0 + 120000, type: 'quit' }
    ]);
    assert.match(text, /Run r1, 2026-11-22 20:01 \(UTC\+1\)/);
    assert.match(text, /20:02 The previous run did not end cleanly/);
    assert.match(text, /20:03 Quit cleanly/);
});
