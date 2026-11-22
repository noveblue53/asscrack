// P9C checks 1 and 3: the updater (src/application/updater.mjs) with a fake release server. Each refused case gives
// no update bar (view().update is null or not ready) and installs nothing (prepareRestart() gives null).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdater, encodedCommand, helperArgs, oldPortableTarget, quoteArg, readExeVersion, releaseSource, removeOldPortable,
    restartScript, testServerBase } from '../src/application/updater.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'jwk' }).x;
const other = generateKeyPairSync('ed25519');
const sha = data => createHash('sha256').update(data).digest('hex');
const source = releaseSource('http://127.0.0.1:9');

function release(version, { files = {}, key = keys.privateKey, tag = `v${version}` } = {}) {
    const entries = {};
    for (const [kind, data] of Object.entries(files)) {
        entries[kind] = { name: `ASSCRACK-${version}-${kind}.exe`, size: data.length, sha256: sha(data) };
    }
    const bytes = Buffer.from(JSON.stringify({ product: 'ASSCRACK', format: 1, version, date: '2026-12-01', notes: `Notes of ${version}.`, files: entries }, null, 2) + '\n');
    return { version, tag, bytes, signature: sign(null, bytes, key).toString('base64'), files, entries };
}

// A fake server: the route table gives a Buffer, a status number or a function.
function fakeFetch(routes) {
    const calls = [];
    const fn = async (url, options) => {
        calls.push({ url, headers: options?.headers });
        const route = routes[url];
        if (route === undefined) return new Response('not found', { status: 404 });
        if (typeof route === 'number') return new Response('error', { status: route });
        if (typeof route === 'function') return route();
        return new Response(route, { status: 200 });
    };
    fn.calls = calls;
    return fn;
}

function serve(rel, { body } = {}) {
    const routes = {
        [source.latest]: Buffer.from(JSON.stringify({ tag_name: rel.tag, assets: [{ name: 'update.json' }, { name: 'update.json.sig' }] })),
        [source.file(rel.tag, 'update.json')]: rel.bytes,
        [source.file(rel.tag, 'update.json.sig')]: Buffer.from(rel.signature + '\n')
    };
    for (const [kind, data] of Object.entries(rel.files)) {
        routes[source.file(`v${rel.version}`, `ASSCRACK-${rel.version}-${kind}.exe`)] = body?.[kind] ?? data;
    }
    return routes;
}

function memoryStore(initial = null) {
    let value = initial;
    return { read: () => value, write: next => { value = JSON.parse(JSON.stringify(next)); }, get: () => value };
}

function setup({ kind = 'setup', routes, store = memoryStore(), currentVersion = '1.0.0-test', portableDir } = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'asscrack-updater-test-'));
    const downloads = path.join(root, 'Downloads');
    mkdirSync(downloads);
    const views = [];
    const logs = [];
    const fetch = fakeFetch(routes ?? {});
    const updater = createUpdater({
        currentVersion, kind, publicKey, source, fetch, store,
        folders: { setup: () => mkdtempSync(path.join(root, 'asscrack-update-')), portable: () => portableDir ?? null, downloads: () => downloads },
        log: (level, text) => logs.push(`${level} ${text}`), changed: view => views.push(view),
        setTimer: () => 1, clearTimer: () => {}
    });
    return { updater, root, downloads, views, logs, fetch, store, done: () => { updater.stop(); rmSync(root, { recursive: true, force: true }); } };
}

const waitReady = async updater => {
    for (let i = 0; i < 100 && (updater.view().update?.downloading || updater.view().checking); i++) await new Promise(r => setTimeout(r, 10));
};

test('a check finds the newer signed release, downloads the setup file, checks it and gives it for the restart', async t => {
    const rel = release('1.0.1-test', { files: { setup: Buffer.from('setup file bytes'), portable: Buffer.from('portable') } });
    const s = setup({ routes: serve(rel) });
    t.after(s.done);
    await s.updater.check();
    await waitReady(s.updater);
    const view = s.updater.view();
    assert.equal(view.update.version, '1.0.1-test');
    assert.equal(view.update.ready, true);
    assert.equal(view.update.from, 'github');
    assert.equal(view.update.notes, 'Notes of 1.0.1-test.');
    assert.equal(view.lastCheck.result, 'found');
    const plan = await s.updater.prepareRestart();
    assert.equal(plan.kind, 'setup');
    assert.equal(path.basename(plan.file), 'ASSCRACK-1.0.1-test-setup.exe');
    assert.equal(readFileSync(plan.file, 'utf8'), 'setup file bytes');
    // The request has the generic User-Agent and no other data: only the fixed URLs of the release.
    for (const call of s.fetch.calls) assert.equal(call.headers['User-Agent'], 'ASSCRACK-updater');
    assert.deepEqual(s.fetch.calls.map(c => c.url), [source.latest, source.file('v1.0.1-test', 'update.json'),
        source.file('v1.0.1-test', 'update.json.sig'), source.file('v1.0.1-test', 'ASSCRACK-1.0.1-test-setup.exe')]);
    // The window view has no path.
    assert.doesNotMatch(JSON.stringify(view), /\\|\//);
});

test('a file with a wrong size or a wrong SHA-256 is refused: no ready bar, no restart, no file left', async t => {
    const data = Buffer.from('the real setup file');
    for (const [label, body] of [['larger', Buffer.concat([data, Buffer.from('x')])], ['shorter', data.subarray(1)],
        ['same size, other bytes', Buffer.from('the real setup filX')]]) {
        const rel = release('1.0.1-test', { files: { setup: data } });
        const s = setup({ routes: serve(rel, { body: { setup: body } }) });
        await s.updater.check();
        await waitReady(s.updater);
        const view = s.updater.view();
        assert.equal(view.update.ready, false, label);
        assert.match(view.update.note, /didn't complete/, label);
        assert.equal(view.update.failed, true, `${label}: the window shows no bar`);
        assert.equal(await s.updater.prepareRestart(), null, label);
        const left = readdirSync(s.root, { recursive: true }).filter(name => /\.exe/.test(name));
        assert.deepEqual(left, [], label);
        assert.ok(s.logs.some(line => line.startsWith('WARN Update download failed')), label);
        s.done();
    }
});

test('a refused manifest from GitHub gives no bar: bad signature, an other key, a lower or equal version, a wrong tag', async t => {
    const files = { setup: Buffer.from('s') };
    const cases = [
        ['bad signature', (() => { const r = release('1.0.1-test', { files }); return { ...r, signature: Buffer.alloc(64).toString('base64') }; })()],
        ['other key', release('1.0.1-test', { files, key: other.privateKey })],
        ['equal version', release('1.0.0-test', { files })],
        ['lower version', release('0.9.0', { files })],
        ['wrong tag', release('1.0.1-test', { files, tag: 'v1.0.2' })]
    ];
    for (const [label, rel] of cases) {
        const s = setup({ routes: serve(rel) });
        await s.updater.check();
        await waitReady(s.updater);
        assert.equal(s.updater.view().update, null, label);
        assert.equal(await s.updater.prepareRestart(), null, label);
        assert.ok(!s.fetch.calls.some(c => c.url.endsWith('.exe')), `${label}: no download`);
        s.done();
    }
});

test('a check with no answer is quiet: a WARN line and a note, no error', async t => {
    const s = setup({ routes: { [source.latest]: () => { throw new TypeError('fetch failed'); } } });
    t.after(s.done);
    await s.updater.check();
    const view = s.updater.view();
    assert.equal(view.update, null);
    assert.equal(view.lastCheck.result, 'failed');
    assert.match(view.lastCheck.note, /Retrying later/);
    assert.ok(s.logs.some(line => line.startsWith('WARN Update check failed')));
    assert.ok(!s.logs.some(line => line.startsWith('ERROR')));
    const none = setup({ routes: { [source.latest]: 404 } });
    await none.updater.check();
    assert.equal(none.updater.view().lastCheck.result, 'none');
    none.done();
});

test('a peer manifest is checked as a GitHub manifest; a bad peer signature gives no bar', async t => {
    const rel = release('1.0.1-test', { files: { portable: Buffer.from('portable bytes') } });
    const folder = mkdtempSync(path.join(os.tmpdir(), 'asscrack-portable-test-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    // The check is off: the peer news shows the bar with Download, and the download is one click.
    const s = setup({ kind: 'portable', routes: serve(rel), portableDir: folder, store: memoryStore({ enabled: false }) });
    t.after(s.done);
    assert.equal(s.updater.receivePeer({ text: rel.bytes.toString('utf8'), signature: Buffer.alloc(64).toString('base64') }), false);
    assert.equal(s.updater.receivePeer({ text: rel.bytes.toString('utf8'), signature: sign(null, rel.bytes, other.privateKey).toString('base64') }), false);
    assert.equal(s.updater.receivePeer({ text: 'x'.repeat(9000), signature: rel.signature }), false);
    assert.equal(s.updater.view().update, null);
    assert.ok(s.logs.some(line => line === 'INFO Update: a peer manifest was refused (bad signature)'));
    assert.ok(s.logs.some(line => line === 'INFO Update: a peer manifest was refused (manifest size)'));
    assert.equal(s.updater.receivePeer({ text: rel.bytes.toString('utf8'), signature: rel.signature }), true);
    let view = s.updater.view();
    assert.equal(view.update.from, 'peer');
    assert.equal(view.update.ready, false);
    assert.equal(view.update.canDownload, true);
    assert.equal(s.fetch.calls.length, 0, 'the check is off: no request before the click');
    await s.updater.download();
    view = s.updater.view();
    assert.equal(view.update.ready, true);
    assert.equal(view.update.inDownloads, false);
    assert.equal(readFileSync(path.join(folder, 'ASSCRACK-1.0.1-test-portable.exe'), 'utf8'), 'portable bytes');
    // The same text a second time is not new.
    assert.equal(s.updater.receivePeer({ text: rel.bytes.toString('utf8'), signature: rel.signature }), false);
});

test('a portable folder that is not writable gives the file in Downloads', async t => {
    const rel = release('1.0.1-test', { files: { portable: Buffer.from('portable bytes') } });
    const s = setup({ kind: 'portable', routes: serve(rel), portableDir: path.join(os.tmpdir(), 'asscrack-no-such-folder', 'x') });
    t.after(s.done);
    await s.updater.check();
    await waitReady(s.updater);
    assert.equal(s.updater.view().update.inDownloads, true);
    assert.ok(existsSync(path.join(s.downloads, 'ASSCRACK-1.0.1-test-portable.exe')));
    assert.equal((await s.updater.prepareRestart()).fallback, true);
});

test('a downloaded file that changed before the restart is refused', async t => {
    const rel = release('1.0.1-test', { files: { setup: Buffer.from('setup') } });
    const s = setup({ routes: serve(rel) });
    t.after(s.done);
    await s.updater.check();
    await waitReady(s.updater);
    const file = path.join(s.root, readdirSync(s.root, { recursive: true }).find(name => name.endsWith('-setup.exe')));
    writeFileSync(file, 'sNtup');
    assert.equal(await s.updater.prepareRestart(), null);
    assert.equal(s.updater.view().update.ready, false);
});

test('an older peer gets the manifest, an equal or newer peer and a bad version do not', async t => {
    const rel = release('1.0.1-test', { files: { setup: Buffer.from('s') } });
    const s = setup({ routes: serve(rel), store: memoryStore({ enabled: false }) });
    t.after(s.done);
    assert.equal(s.updater.offerFor('0.1.0'), null, 'no manifest yet');
    let shared = 0;
    s.updater.onShare(() => shared++);
    await s.updater.check();
    assert.equal(shared, 1);
    assert.deepEqual(s.updater.offerFor('1.0.0-test'), { text: rel.bytes.toString('utf8'), signature: rel.signature });
    assert.equal(s.updater.offerFor('1.0.1-test'), null);
    assert.equal(s.updater.offerFor('2.0.0'), null);
    assert.equal(s.updater.offerFor('not a version'), null);
    assert.equal(s.updater.offerFor(undefined), null);
});

test('the saved state keeps the setting and a good manifest; an app at that version keeps it only for the peers', async t => {
    const rel = release('1.0.1-test', { files: { setup: Buffer.from('s') } });
    const store = memoryStore({ enabled: false, manifest: { text: rel.bytes.toString('utf8'), signature: rel.signature, from: 'github' } });
    const s = setup({ store, currentVersion: '1.0.1-test' });
    t.after(s.done);
    assert.equal(s.updater.view().enabled, false);
    assert.equal(s.updater.view().update, null);
    assert.ok(s.updater.offerFor('1.0.0-test'));
    // A changed saved manifest is not trusted.
    const bad = memoryStore({ manifest: { text: rel.bytes.toString('utf8').replace('Notes', 'Nodes'), signature: rel.signature } });
    const b = setup({ store: bad });
    assert.equal(b.updater.offerFor('0.1.0'), null);
    assert.equal(b.updater.view().update, null);
    b.done();
});

test('the test server option works only for a test version and only for 127.0.0.1', () => {
    assert.equal(testServerBase(['--update-server', '127.0.0.1:8123'], '1.0.0-test'), 'http://127.0.0.1:8123');
    assert.equal(testServerBase(['--update-server', '127.0.0.1:8123'], '1.0.0'), null);
    assert.equal(testServerBase(['--update-server', '127.0.0.1:8123'], '1.0.0-beta'), null);
    for (const value of ['localhost:8123', 'http://127.0.0.1:8123', '127.0.0.1:8123/x', '10.0.0.1:8123', '127.0.0.1:0', '127.0.0.1:70000', '127.0.0.1', '']) {
        assert.equal(testServerBase(['--update-server', value], '1.0.0-test'), null, value);
    }
    assert.equal(testServerBase([], '1.0.0-test'), null);
    assert.equal(releaseSource().latest, 'https://api.github.com/repos/noveblue53/asscrack/releases/latest');
    assert.equal(releaseSource().file('v1.0.1', 'update.json'), 'https://github.com/noveblue53/asscrack/releases/download/v1.0.1/update.json');
});

// A small file with an MZ header and the version strings of the portable launcher (UTF-16LE, as in the resource).
function fakeExe(product, version) {
    const u = text => Buffer.from(text, 'utf16le');
    return Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100), u('ProductName\0\0'), u(`${product}\0`), Buffer.alloc(6),
        u('ProductVersion\0'), u(`${version}\0`), Buffer.alloc(50)]);
}

test('the old portable file is deleted only with its exact old name, in the own folder, with the ASSCRACK version', async t => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'asscrack-old-portable-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const ownFile = path.join(folder, 'ASSCRACK-1.0.1-test-portable.exe');
    writeFileSync(ownFile, fakeExe('ASSCRACK', '1.0.1-test'));
    writeFileSync(path.join(folder, 'ASSCRACK-1.0.0-test-portable.exe'), fakeExe('ASSCRACK', '1.0.0-test'));
    writeFileSync(path.join(folder, 'ASSCRACK-0.9.0-portable.exe'), fakeExe('OTHER', '0.9.0'));
    writeFileSync(path.join(folder, 'ASSCRACK-0.8.0-portable.exe'), fakeExe('ASSCRACK', '0.7.0'));
    writeFileSync(path.join(folder, 'notes.txt'), 'keep');
    assert.deepEqual(readExeVersion(ownFile), { product: 'ASSCRACK', version: '1.0.1-test' });
    const own = { ownFile, ownVersion: '1.0.1-test' };
    for (const oldName of ['ASSCRACK-0.9.0-portable.exe', 'ASSCRACK-0.8.0-portable.exe', 'notes.txt', '..\\ASSCRACK-1.0.0-test-portable.exe',
        'ASSCRACK-1.0.1-test-portable.exe', 'ASSCRACK-2.0.0-portable.exe', 'C:ASSCRACK-1.0.0-test-portable.exe', 'ASSCRACK-0.1.0-portable.exe']) {
        assert.equal(oldPortableTarget({ ...own, oldName }), null, oldName);
    }
    assert.equal((await removeOldPortable({ ...own, oldName: 'ASSCRACK-0.9.0-portable.exe' })).result, 'refused');
    // A locked file: try again, then delete.
    let tries = 0;
    const result = await removeOldPortable({ ...own, oldName: 'ASSCRACK-1.0.0-test-portable.exe' }, {
        waitMs: 1, unlink: file => { if (++tries < 3) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } rmSync(file); }
    });
    assert.deepEqual(result, { result: 'deleted', file: 'ASSCRACK-1.0.0-test-portable.exe' });
    assert.equal(tries, 3);
    assert.deepEqual(readdirSync(folder).sort(), ['ASSCRACK-0.8.0-portable.exe', 'ASSCRACK-0.9.0-portable.exe',
        'ASSCRACK-1.0.1-test-portable.exe', 'notes.txt']);
});

test('the restart script waits, installs silently, and starts the new version with the quoted test arguments', () => {
    assert.equal(quoteArg('--profile'), '--profile');
    assert.equal(quoteArg('C:\\a b\\'), '"C:\\a b\\\\"');
    assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteArg(''), '""');
    const script = restartScript({ waitPids: [12, 0, 'x', 34], setup: { file: "C:\\T\\it's\\ASSCRACK-1.0.1-setup.exe", installDir: 'C:\\P\\asscrack' },
        start: { file: 'C:\\P\\asscrack\\ASSCRACK.exe', args: ['--profile', 'D:\\my profile'] } });
    assert.deepEqual(script.split('\r\n'), [
        "$ErrorActionPreference = 'SilentlyContinue'",
        'Wait-Process -Id 12 -Timeout 60',
        'Wait-Process -Id 34 -Timeout 60',
        "$p = Start-Process -FilePath 'C:\\T\\it''s\\ASSCRACK-1.0.1-setup.exe' -ArgumentList '--updated /S /D=C:\\P\\asscrack' -Wait -PassThru",
        "Start-Process -FilePath 'C:\\P\\asscrack\\ASSCRACK.exe' -ArgumentList '--profile \"D:\\my profile\"'"
    ]);
    // A folder that the user picked at install can have spaces and an apostrophe. NSIS reads /D= to the end of the line.
    const custom = restartScript({ waitPids: [], setup: { file: 'C:\\T\\s.exe', installDir: "D:\\My Apps\\O'Neil\\ASSCRACK" },
        start: { file: 'x.exe', args: [] } });
    assert.ok(custom.includes("-ArgumentList '--updated /S /D=D:\\My Apps\\O''Neil\\ASSCRACK' -Wait"), custom);
    assert.equal(Buffer.from(encodedCommand('ab'), 'base64').toString('utf16le'), 'ab');
    // Two stages: the first stage starts the second stage (hidden) with the encoded restart script, and exits.
    const args = helperArgs('C:\W\powershell.exe', "Write-Output 'x'");
    assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    const first = Buffer.from(args[5], 'base64').toString('utf16le');
    assert.equal(first, "Start-Process -FilePath 'C:\W\powershell.exe' -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive'," +
        `'-ExecutionPolicy','Bypass','-EncodedCommand','${encodedCommand("Write-Output 'x'")}'`);
    assert.match(restartScript({ waitPids: [], start: { file: 'x.exe', args: [] } }), /Start-Process -FilePath 'x\.exe'$/);
});
