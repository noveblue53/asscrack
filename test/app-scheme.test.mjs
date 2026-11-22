// I4 (P10a): the pages load from a custom scheme, not from file://, and the fuse grantFileProtocolExtraPrivileges is
// off. The handler gives only the files of the application folder with a known type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');

test('the app scheme gives the files of the application folder with the correct type', async t => {
    const { createAppHandler, appPage, APP_ORIGIN } = await import('../src/application/app-scheme.mjs');
    const handle = createAppHandler({ root: path.join(import.meta.dirname, '..', 'src', 'application'),
        extra: { '/vendor/w.js': path.join(import.meta.dirname, '..', 'src', 'application', 'voice-worklet.js') } });
    assert.equal(appPage('index.html'), APP_ORIGIN + '/index.html');
    const ok = async (url, type) => {
        const res = await handle(new Request(url));
        assert.equal(res.status, 200, url);
        assert.equal(res.headers.get('content-type'), type, url);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        return res;
    };
    assert.match(await (await ok(appPage('index.html'), 'text/html; charset=utf-8')).text(), /Content-Security-Policy/);
    await ok(appPage('renderer.js'), 'text/javascript; charset=utf-8');
    await ok(appPage('styles.css'), 'text/css; charset=utf-8');
    await ok(appPage('img/logo.svg'), 'image/svg+xml');
    await ok(appPage('vendor/w.js'), 'text/javascript; charset=utf-8');
    for (const bad of [
        appPage('../../package.json'), APP_ORIGIN + '/%2e%2e/%2e%2e/package.json', APP_ORIGIN + '/..%5c..%5cpackage.json',
        appPage('preload.cjs'), appPage('main.mjs'), appPage('img/../../../package.json'), appPage('node_modules/x/y.js'),
        appPage('missing.js'), 'asscrack-app://other/index.html', 'asscrack-app://app:1/index.html', appPage('vendor/other.js')
    ]) assert.equal((await handle(new Request(bad))).status, 404, bad);
    assert.equal((await handle(new Request(appPage('index.html'), { method: 'POST' }))).status, 405);
});

test('the windows load their pages from the app scheme, and the fuse is off', async () => {
    const pkg = JSON.parse(await read('package.json'));
    assert.equal(pkg.build.electronFuses.grantFileProtocolExtraPrivileges, false);
    const main = await read('src/application/main.js');
    assert.ok(main.includes("const ROOM_PAGE = appPage('index.html');"));
    assert.ok(main.includes('protocol.handle(APP_SCHEME, createAppHandler('));
    assert.ok(!main.includes('pathToFileURL'));
    for (const file of ['friend-windows.mjs', 'voice-monitor.mjs']) {
        const source = await read('src/application/' + file);
        assert.ok(!source.includes('loadFile('), file);
        assert.ok(!source.includes('pathToFileURL'), file);
        assert.ok(source.includes('loadURL('), file);
    }
});

test('room media allows only the app origin, not the file origin null', async t => {
    const { createRoomMedia } = await import('../src/application/room-media.mjs');
    const { APP_ORIGIN } = await import('../src/application/app-scheme.mjs');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ac-scheme-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm....'), Buffer.alloc(64, 88)]);
    const file = path.join(dir, 'clip.webm');
    await writeFile(file, bytes);
    const d = { id: '31e69ba1-2dbc-416a-ae60-727092a82188', source: 'publisher', kind: 'video', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') };
    const media = createRoomMedia({ nativeImage: null });
    await media.verified(d, file);
    const res = await media.serve(new Request(media.info(d.id).originalUrl));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), APP_ORIGIN);
    await res.arrayBuffer();
});
