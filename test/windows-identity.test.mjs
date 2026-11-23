// R103-1: the Windows identity of each kind of build (src/application/windows-identity.mjs). Electron writes the Start
// menu shortcut <ProductName of the exe>.lnk and the LocalServer32 value of the toast CLSID with the running exe. A dev
// start or a start with --profile must never use the shortcut or the CLSID of the installed copy.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_APP_ID, WINDOWS_TOAST_ID } from '../src/application/attention.mjs';
import { localServerKey, localServerRegistry, parseRegDefault, PORTABLE_PRODUCT_NAME, repairPortableIdentity, WINDOWS_IDENTITIES,
    windowsIdentity } from '../src/application/windows-identity.mjs';

const root = new URL('../', import.meta.url);
const INSTALLED_LNK = 'ASSCRACK';

test('each kind of build gets its own identity', () => {
    const kind = opts => windowsIdentity({ isPackaged: true, profile: false, portableFile: null, installed: false, ...opts }).kind;
    assert.equal(kind({ installed: true }), 'installed');
    assert.equal(kind({ portableFile: 'D:\\Games\\ASSCRACK-1.0.3-portable.exe' }), 'portable');
    assert.equal(kind({ isPackaged: false }), 'dev');
    assert.equal(kind({ isPackaged: false, profile: true }), 'dev');
    assert.equal(kind({ profile: true, installed: true }), 'test');
    assert.equal(kind({ profile: true, portableFile: 'D:\\x.exe' }), 'test');
    // A packaged exe that is not installed and not portable (for example win-unpacked) has the product name ASSCRACK.
    assert.equal(kind({}), 'test');
    assert.equal(WINDOWS_IDENTITIES.installed.appId, WINDOWS_APP_ID);
    assert.equal(WINDOWS_IDENTITIES.installed.clsid, WINDOWS_TOAST_ID);
    const ids = Object.values(WINDOWS_IDENTITIES);
    for (const id of ids) assert.match(id.clsid, /^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/);
    const own = ['installed', 'portable', 'dev'].map(k => WINDOWS_IDENTITIES[k]);
    assert.equal(new Set(own.map(id => id.appId)).size, 3);
    assert.equal(new Set(own.map(id => id.clsid.toUpperCase())).size, 3);
    assert.equal(new Set(own.map(id => id.shortcut.toLowerCase())).size, 3);
    assert.equal(WINDOWS_IDENTITIES.test.toasts, false);
});

test('a dev start or a start with --profile never uses the installed AUMID, CLSID or shortcut', () => {
    for (const isPackaged of [false, true]) {
        for (const portableFile of [null, 'D:\\ASSCRACK-portable.exe']) {
            for (const installed of [false, true]) {
                for (const profile of [false, true]) {
                    if (isPackaged && !profile) continue;
                    const id = windowsIdentity({ isPackaged, profile, portableFile, installed });
                    assert.notEqual(id.appId, WINDOWS_APP_ID);
                    assert.notEqual(id.clsid.toUpperCase(), WINDOWS_TOAST_ID.toUpperCase());
                    // The test kind has no presenter, thus Electron writes no shortcut for it.
                    if (id.toasts) assert.notEqual(id.shortcut.toLowerCase(), INSTALLED_LNK.toLowerCase());
                }
            }
        }
    }
    // main.js takes the AUMID and the CLSID from the identity, and the test kind never makes the presenter.
    const main = readFileSync(new URL('src/application/main.js', root), 'utf8');
    assert.doesNotMatch(main, /WINDOWS_APP_ID|WINDOWS_TOAST_ID|registerNotificationShortcut/);
    assert.match(main, /app\.setAppUserModelId\(winIdentity\.appId\);\s+app\.setToastActivatorCLSID\(winIdentity\.clsid\);/);
    const notify = main.slice(main.indexOf('notify: options =>'));
    assert.ok(notify.indexOf('if (!winToasts) throw') < notify.indexOf('new Notification('));
    const register = main.slice(main.indexOf('function registerAlerts()'));
    assert.ok(register.indexOf('if (!winToasts)') < register.indexOf('Notification.isSupported()'));
    // Only these two calls make the presenter (comment lines do not count).
    const code = main.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
    assert.equal((code.match(/new Notification\(|Notification\.isSupported\(\)|Notification\.getHistory/g) ?? []).length, 2);
});

test('the product names of the builds give three different shortcut names', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    assert.equal(pkg.build.productName, INSTALLED_LNK);
    assert.equal(WINDOWS_IDENTITIES.installed.shortcut, pkg.build.productName);
    assert.ok(pkg.scripts.dist.includes(`-c.productName="${PORTABLE_PRODUCT_NAME}"`));
    assert.ok(pkg.scripts.dist.includes('-c.executableName=ASSCRACK'));
    assert.equal(WINDOWS_IDENTITIES.portable.shortcut, PORTABLE_PRODUCT_NAME);
    assert.doesNotMatch(pkg.scripts['dist:installer'], /productName/);
});

test('the ProductName of electron.exe gives the dev shortcut name', { skip: process.platform !== 'win32' }, () => {
    const exe = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'electron', 'dist', 'electron.exe');
    const name = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductName`],
        { encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(name, WINDOWS_IDENTITIES.dev.shortcut);
});

test('reg.exe output gives the LocalServer32 value', async () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\Classes\\CLSID\\{X}\\LocalServer32\r\n    (Default)    REG_SZ    D:\\Games\\ASSCRACK 1\\a.exe\r\n\r\n';
    assert.equal(parseRegDefault(out), 'D:\\Games\\ASSCRACK 1\\a.exe');
    assert.equal(parseRegDefault('    (Default)    REG_SZ    (value not set)\r\n'), '(value not set)');
    assert.equal(parseRegDefault(''), '');
    assert.equal(localServerKey('{A}'), 'HKCU\\Software\\Classes\\CLSID\\{A}\\LocalServer32');
    const calls = [];
    const registry = localServerRegistry(async (file, args) => {
        calls.push([file, ...args]);
        if (args[0] === 'query') throw new Error('not found');
        return { stdout: '' };
    });
    assert.equal(await registry.read('{A}'), '');
    await registry.write('{A}', 'D:\\p.exe');
    assert.deepEqual(calls[1], ['reg', 'add', 'HKCU\\Software\\Classes\\CLSID\\{A}\\LocalServer32', '/ve', '/t', 'REG_SZ', '/d', 'D:\\p.exe', '/f']);
});

function fixture(t) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-identity-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const links = new Map();
    const writes = [];
    const shell = {
        readShortcutLink: file => { if (!links.has(file)) throw new Error('no link'); return links.get(file); },
        writeShortcutLink(file, op, value) { writes.push([path.basename(file), op, value]); links.set(file, value); writeFileSync(file, 'lnk'); return true; }
    };
    const server = new Map();
    const reads = [];
    const registry = { async read(clsid) { reads.push(clsid); return server.get(clsid) ?? ''; }, async write(clsid, value) { server.set(clsid, value); } };
    return { dir, links, writes, shell, server, reads, registry };
}

test('a portable start points its own shortcut and LocalServer32 to the portable .exe after the Electron write', async t => {
    const f = fixture(t);
    const id = WINDOWS_IDENTITIES.portable;
    const execPath = 'D:\\Temp\\User\\RND123\\ASSCRACK.exe';
    const portableFile = 'D:\\Games\\ASSCRACK-1.0.3-portable.exe';
    // The shortcut of the installed copy: no change.
    const installedLnk = path.win32.join(f.dir, 'ASSCRACK.lnk');
    f.links.set(installedLnk, { target: 'C:\\Programs\\asscrack\\ASSCRACK.exe', appUserModelId: WINDOWS_APP_ID, toastActivatorClsid: WINDOWS_TOAST_ID });
    f.server.set(WINDOWS_TOAST_ID, 'C:\\Programs\\asscrack\\ASSCRACK.exe');
    let slept = 0;
    // Electron writes its values (the unpack folder) after two waits.
    const sleep = async () => {
        slept++;
        if (slept === 2) {
            f.server.set(id.clsid, execPath);
            f.links.set(path.win32.join(f.dir, `${id.shortcut}.lnk`), { target: execPath, cwd: 'D:\\Temp\\User\\RND123', appUserModelId: id.appId, toastActivatorClsid: id.clsid });
            writeFileSync(path.win32.join(f.dir, `${id.shortcut}.lnk`), 'lnk');
        }
    };
    const result = await repairPortableIdentity({ programsDir: f.dir, portableFile, execPath, shell: f.shell, registry: f.registry, sleep, stepMs: 10 });
    assert.deepEqual(result, { waited: 20, timedOut: false, shortcut: 'written', server: 'written' });
    assert.deepEqual(f.writes, [[`${PORTABLE_PRODUCT_NAME}.lnk`, 'replace', { target: portableFile, cwd: 'D:\\Games', args: '',
        description: PORTABLE_PRODUCT_NAME, appUserModelId: id.appId, toastActivatorClsid: id.clsid }]]);
    assert.equal(f.server.get(id.clsid), portableFile);
    // The values of the installed copy did not change, and no read or write used its CLSID.
    assert.deepEqual(f.links.get(installedLnk), { target: 'C:\\Programs\\asscrack\\ASSCRACK.exe', appUserModelId: WINDOWS_APP_ID, toastActivatorClsid: WINDOWS_TOAST_ID });
    assert.equal(f.server.get(WINDOWS_TOAST_ID), 'C:\\Programs\\asscrack\\ASSCRACK.exe');
    assert.ok(f.reads.every(clsid => clsid === id.clsid));
    // A second repair with correct values writes nothing.
    f.server.set(id.clsid, execPath);
    const again = await repairPortableIdentity({ programsDir: f.dir, portableFile, execPath, shell: f.shell, registry: f.registry, sleep, stepMs: 10 });
    assert.equal(again.shortcut, 'kept');
    assert.equal(again.server, 'written');
    assert.equal(f.writes.length, 1);
});

test('a portable shortcut name with a different AUMID stays; no Electron write in time still repairs the server', async t => {
    const f = fixture(t);
    const id = WINDOWS_IDENTITIES.portable;
    const lnk = path.win32.join(f.dir, `${id.shortcut}.lnk`);
    f.links.set(lnk, { target: 'D:\\other.exe', appUserModelId: 'other.app', toastActivatorClsid: '{00000000-0000-0000-0000-000000000000}' });
    writeFileSync(lnk, 'lnk');
    const result = await repairPortableIdentity({ programsDir: f.dir, portableFile: 'D:\\p.exe', execPath: 'D:\\Temp\\x\\ASSCRACK.exe',
        shell: f.shell, registry: f.registry, sleep: async () => {}, timeoutMs: 50, stepMs: 10 });
    assert.deepEqual(result, { waited: 50, timedOut: true, shortcut: 'foreign', server: 'written' });
    assert.equal(f.writes.length, 0);
    assert.equal(f.server.get(id.clsid), 'D:\\p.exe');
    // No shortcut yet: the repair makes it.
    rmSync(lnk);
    f.links.clear();
    const made = await repairPortableIdentity({ programsDir: f.dir, portableFile: 'D:\\p.exe', execPath: 'D:\\Temp\\x\\ASSCRACK.exe',
        shell: f.shell, registry: f.registry, sleep: async () => {}, timeoutMs: 20, stepMs: 10 });
    assert.equal(made.shortcut, 'written');
    assert.equal(f.writes[0][1], 'create');
});
