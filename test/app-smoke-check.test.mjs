import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import {
    buildLaunchConfig,
    CDP_PORT_MAX,
    CDP_PORT_MIN,
    checkSharedHardware,
    classifyOutputLines,
    inspectDevShortcutState,
    parseArgs,
    pickFreePort
} from '../tools/app-smoke-check.mjs';
import { WINDOWS_IDENTITIES } from '../src/application/windows-identity.mjs';

test('parseArgs parses defaults and valid flags, and rejects out-of-range CDP ports', () => {
    const def = parseArgs([]);
    assert.equal(def.port, null);
    assert.equal(def.settleMs, 1500);
    assert.equal(def.timeoutMs, 20000);
    assert.equal(def.checkNoDevShortcut, false);

    const parsed = parseArgs([
        '--port', '9512',
        '--run-dir', 'D:\\work\\run 1',
        '--profile', 'D:\\work\\run 1\\prof',
        '--settle-ms', '0',
        '--timeout-ms', '5000',
        '--eval', '1+1',
        '--check-no-dev-shortcut',
        '--allow-other-electron',
        '--keep-run-dir'
    ]);
    assert.equal(parsed.port, 9512);
    assert.equal(parsed.runDir, 'D:\\work\\run 1');
    assert.equal(parsed.profileDir, 'D:\\work\\run 1\\prof');
    assert.equal(parsed.settleMs, 0);
    assert.equal(parsed.timeoutMs, 5000);
    assert.equal(parsed.evalExpr, '1+1');
    assert.equal(parsed.checkNoDevShortcut, true);
    assert.equal(parsed.allowOtherElectron, true);
    assert.equal(parsed.keepRunDir, true);

    assert.throws(() => parseArgs(['--port', '9499']), /9500-9599/);
    assert.throws(() => parseArgs(['--port', '9600']), /9500-9599/);
    assert.throws(() => parseArgs(['--port', 'abc']), /Invalid integer/);
    assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
});

test('pickFreePort skips busy ports inside 9500-9599 and fails if explicit port is busy', async t => {
    const chosen = await pickFreePort({
        start: 9500,
        end: 9503,
        testBind: async p => p === 9502
    });
    assert.equal(chosen, 9502);

    await assert.rejects(
        () => pickFreePort({ start: 9500, end: 9502, testBind: async () => false }),
        /No free CDP port/
    );
    await assert.rejects(
        () => pickFreePort({ port: 9510, testBind: async () => false }),
        /CDP port 9510 is busy/
    );
    await assert.rejects(
        () => pickFreePort({ port: 9400, testBind: async () => true }),
        /9500-9599/
    );

    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const free = await pickFreePort({ start: CDP_PORT_MIN, end: CDP_PORT_MAX });
    assert.ok(free >= CDP_PORT_MIN && free <= CDP_PORT_MAX);
});

test('buildLaunchConfig isolates profile, sets fake APPDATA, and strips ELECTRON_RUN_AS_NODE', () => {
    const runDir = path.join('D:\\tmp with spaces', 'run-1');
    const cfg = buildLaunchConfig({
        repoRoot: 'D:\\Github Repos\\asscrack-gemini',
        runDir,
        port: 9525,
        env: { PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', APPDATA: 'C:\\RealAppData' }
    });
    assert.equal('ELECTRON_RUN_AS_NODE' in cfg.env, false);
    assert.equal(cfg.env.APPDATA, path.resolve(runDir, 'fake-appdata'));
    assert.equal(cfg.env.PATH, 'C:\\Windows');
    assert.deepEqual(cfg.args, ['.', `--profile=${path.resolve(runDir, 'profile')}`, '--remote-debugging-port=9525']);
    assert.throws(() => buildLaunchConfig({ runDir, port: 47200 }), /9500-9599/);
});

test('classifyOutputLines flags fatal/error lines and ignores benign status output', () => {
    const res = classifyOutputLines('\nFull node: false\n[123:ERROR:gpu.cc(1)] boom\nTypeError: bad\n  done \n');
    assert.deepEqual(res.lines, ['Full node: false', '[123:ERROR:gpu.cc(1)] boom', 'TypeError: bad', 'done']);
    assert.deepEqual(res.errors, ['[123:ERROR:gpu.cc(1)] boom', 'TypeError: bad']);
});

test('checkSharedHardware detects electron.exe outside repoRoot and allows inside repoRoot', async () => {
    const repoRoot = 'D:\\Github Repos\\asscrack-gemini';
    const emptyRes = await checkSharedHardware({
        repoRoot,
        platform: 'win32',
        exec: async () => ({ stdout: '[]' })
    });
    assert.equal(emptyRes.ok, true);
    assert.deepEqual(emptyRes.others, []);

    const okRes = await checkSharedHardware({
        repoRoot,
        platform: 'win32',
        exec: async () => ({ stdout: '{"Id":12,"Path":"D:\\\\Github Repos\\\\asscrack-gemini\\\\node_modules\\\\electron\\\\dist\\\\electron.exe"}' })
    });
    assert.equal(okRes.ok, true);
    assert.deepEqual(okRes.others, []);

    const blockedRes = await checkSharedHardware({
        repoRoot,
        platform: 'win32',
        exec: async () => ({ stdout: '[{"Id":99,"Path":"C:\\\\Other\\\\electron.exe"}]' })
    });
    assert.equal(blockedRes.ok, false);
    assert.equal(blockedRes.others.length, 1);
});

test('inspectDevShortcutState checks Electron.lnk and dev CLSID', async () => {
    const clean = await inspectDevShortcutState({
        appDataList: ['C:\\FakeAppData'],
        platform: 'win32',
        exists: () => false,
        exec: async () => { throw new Error('not found'); }
    });
    assert.deepEqual(clean, { devShortcutAbsent: true, devClsidAbsent: true });

    const dirty = await inspectDevShortcutState({
        appDataList: ['C:\\FakeAppData'],
        platform: 'win32',
        exists: p => p.endsWith(`${WINDOWS_IDENTITIES.dev.shortcut}.lnk`),
        exec: async () => ({ stdout: 'HKEY_CURRENT_USER\\...\n    (Default)    REG_SZ    C:\\electron.exe\n' })
    });
    assert.deepEqual(dirty, { devShortcutAbsent: false, devClsidAbsent: false });
});
