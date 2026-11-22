// P9C check 4 and the restart plan: no update starts during voice or a transfer (Restart asks first), and the restart
// helper gets the right plan. The test uses a fake electron app and a fake spawn: no process starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdateService, keptArgs } from '../src/application/update-service.mjs';

function fakeApp(root, { version = '1.0.0-test', isPackaged = true } = {}) {
    const paths = { userData: path.join(root, 'profile'), temp: path.join(root, 'temp'), downloads: path.join(root, 'dl') };
    return { getVersion: () => version, isPackaged, getPath: name => paths[name] };
}

function service(t, { busy = { voice: false, transfers: 0 }, installedBuild = true, env = {}, argv = [] } = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'asscrack-update-service-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const handlers = {};
    const spawned = [];
    let quits = 0;
    const s = createUpdateService({
        app: fakeApp(root), shell: { showItemInFolder: () => {} }, handle: (channel, fn) => { handlers[channel] = fn; },
        send: () => {}, log: () => {}, busy: () => busy, installedBuild, quit: () => { quits++; }, env, argv,
        spawn: (file, args, options) => { spawned.push({ file, args, options }); return { on() {}, unref() {} }; },
        fetch: async () => { throw new Error('no request'); }, platform: 'win32'
    });
    return { s, handlers, spawned, quits: () => quits };
}

test('the update IPC channels are the six of the bridge', t => {
    const { handlers } = service(t);
    assert.deepEqual(Object.keys(handlers).sort(), ['asscrack:update', 'asscrack:update-auto', 'asscrack:update-check',
        'asscrack:update-download', 'asscrack:update-later', 'asscrack:update-restart']);
});

test('Restart in voice or during a transfer asks first: no helper, no quit, until the window sends force', async t => {
    for (const busy of [{ voice: true, transfers: 0 }, { voice: false, transfers: 2 }]) {
        const { handlers, spawned, quits } = service(t, { busy });
        const result = await handlers['asscrack:update-restart']({}, false);
        assert.deepEqual(result, { ok: false, busy: busy.voice ? 'voice' : 'transfer' });
        assert.equal(spawned.length, 0);
        assert.equal(quits(), 0);
        // With force and no ready file: still nothing.
        assert.deepEqual(await handlers['asscrack:update-restart']({}, true), { ok: false, error: 'not ready' });
        assert.equal(spawned.length, 0);
    }
});

test('the restart keeps only the test arguments, as absolute paths', () => {
    const resolve = value => path.win32.resolve('C:\\work', value);
    assert.deepEqual(keptArgs(['exe', '.', '--profile', 'p1', '--log-dir', 'logs', '--update-server', 'http://127.0.0.1:5000',
        '--start-idle', '--port', '9000'], resolve),
    ['--profile', 'C:\\work\\p1', '--log-dir', 'C:\\work\\logs', '--update-server', 'http://127.0.0.1:5000']);
    assert.deepEqual(keptArgs(['exe', '--profile', '--log-dir', 'x'], resolve), ['--log-dir', 'C:\\work\\x']);
});

test('the build kind comes from the build (installed, portable or none), and the node hub has the app version', t => {
    const { s } = service(t, { argv: ['--update-server', 'http://127.0.0.1:5000'] });
    assert.equal(s.hub.version, '1.0.0-test');
    assert.equal(s.view().buildKind, 'setup');
    const portable = service(t, { installedBuild: false, env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x\\ASSCRACK-1.0.0-test-portable.exe' } });
    assert.equal(portable.s.view().buildKind, 'portable');
    const unpacked = service(t, { installedBuild: false });
    assert.equal(unpacked.s.view().buildKind, null);
});
