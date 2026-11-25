// The Windows identity of each kind of build (1.0.3, DECISIONS R103-1).
//
// Electron 45.4.1 (shell/browser/notifications/win/windows_toast_activator.cc) makes the notification presenter at
// the first Notification.isSupported() or new Notification(). Then it writes two values with the path of the
// running exe (GetModuleFileNameW):
// - the shortcut <Start Menu>\Programs\<ProductName of the exe>.lnk, with the AUMID and the toast CLSID of the app.
//   It writes it again when the target or the working folder is different from the running exe.
// - HKCU\Software\Classes\CLSID\<toast CLSID>\LocalServer32.
// The shortcut name comes from the version resource of the exe, not from app.setName. Thus each kind of build gets
// its own AUMID and toast CLSID, and its own ProductName where Electron must write a shortcut:
// - installed: ASSCRACK.lnk (also the shortcut of the installer), com.asscrack.app. Electron keeps it correct.
// - portable: ASSCRACK Portable.lnk ("npm run dist" sets this product name), com.asscrack.portable. Electron points
//   it to the unpack folder, which Windows deletes at exit. repairPortableIdentity then points the shortcut and the
//   LocalServer32 value to PORTABLE_EXECUTABLE_FILE (the .exe that the user starts).
// - dev (electron . without --profile): Electron.lnk (the ProductName of electron.exe), com.asscrack.dev.
// - test (any start with --profile, dev or packaged, or a packaged build that is not installed and not portable): the
//   ProductName of its exe can be ASSCRACK or Electron, and the presenter then writes a Start menu shortcut and a
//   CLSID key. Thus this kind never makes the presenter: no desktop notifications, no Start menu shortcut, no toast
//   CLSID key.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { WINDOWS_APP_ID, WINDOWS_TOAST_ID } from './attention.mjs';

export const PORTABLE_PRODUCT_NAME = 'ASSCRACK Portable';
const DEV_ID = Object.freeze({ appId: 'com.asscrack.dev', clsid: '{AB0DC94C-048E-4960-8BA8-F5ED6ED4DC12}' });

export const WINDOWS_IDENTITIES = Object.freeze({
    installed: Object.freeze({ kind: 'installed', appId: WINDOWS_APP_ID, clsid: WINDOWS_TOAST_ID, shortcut: 'ASSCRACK', toasts: true }),
    portable: Object.freeze({ kind: 'portable', appId: 'com.asscrack.portable', clsid: '{85762B16-DB2C-4C45-9D7B-E20EFE5CAB50}',
        shortcut: PORTABLE_PRODUCT_NAME, toasts: true }),
    dev: Object.freeze({ kind: 'dev', ...DEV_ID, shortcut: 'Electron', toasts: true }),
    test: Object.freeze({ kind: 'test', ...DEV_ID, shortcut: null, toasts: false })
});

// profile: true for a start with --profile. portableFile: PORTABLE_EXECUTABLE_FILE. installed: isInstalledBuild().
export function windowsIdentity({ isPackaged, profile, portableFile, installed }) {
    if (profile) return WINDOWS_IDENTITIES.test;
    if (isPackaged !== true) return WINDOWS_IDENTITIES.dev;
    if (portableFile) return WINDOWS_IDENTITIES.portable;
    if (installed) return WINDOWS_IDENTITIES.installed;
    return WINDOWS_IDENTITIES.test;
}

const sameFile = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 &&
    path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();

export const localServerKey = clsid => `HKCU\\Software\\Classes\\CLSID\\${clsid}\\LocalServer32`;

// The default value in the output of "reg query <key> /ve", or '' when there is none.
export function parseRegDefault(stdout) {
    const match = /^\s*\(Default\)\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/m.exec(String(stdout ?? ''));
    return match ? match[1] : '';
}

// The LocalServer32 value of a CLSID with reg.exe (no new dependency). run(file, args) gives { stdout }.
export function localServerRegistry(run) {
    return {
        async read(clsid) {
            try { return parseRegDefault((await run('reg', ['query', localServerKey(clsid), '/ve'])).stdout); }
            catch { return ''; }
        },
        async write(clsid, value) {
            await run('reg', ['add', localServerKey(clsid), '/ve', '/t', 'REG_SZ', '/d', value, '/f']);
        }
    };
}

// After Electron made the presenter of a portable start: wait until Electron wrote LocalServer32 (the running exe),
// then point the portable shortcut and LocalServer32 to the outer portable .exe. Only the values of the portable
// identity change: a shortcut with a different AUMID stays as it is.
export async function repairPortableIdentity({ programsDir, portableFile, execPath, shell, registry, sleep,
    timeoutMs = 10_000, stepMs = 200 }) {
    const id = WINDOWS_IDENTITIES.portable;
    let waited = 0;
    while (!sameFile(await registry.read(id.clsid), execPath) && waited < timeoutMs) {
        await sleep(stepMs);
        waited += stepMs;
    }
    const result = { waited, timedOut: waited >= timeoutMs, shortcut: 'kept', server: 'kept' };
    const file = path.win32.join(programsDir, `${id.shortcut}.lnk`);
    const present = existsSync(file);
    const old = present ? shell.readShortcutLink(file) : null;
    if (old && old.appUserModelId !== id.appId) result.shortcut = 'foreign';
    else if (!old || !sameFile(old.target, portableFile) || !sameFile(old.cwd, path.win32.dirname(portableFile)) ||
        old.toastActivatorClsid?.toLowerCase() !== id.clsid.toLowerCase()) {
        mkdirSync(programsDir, { recursive: true });
        const ok = shell.writeShortcutLink(file, present ? 'replace' : 'create', {
            target: portableFile, cwd: path.win32.dirname(portableFile), args: '', description: id.shortcut,
            appUserModelId: id.appId, toastActivatorClsid: id.clsid
        });
        result.shortcut = ok ? 'written' : 'failed';
    }
    if (!sameFile(await registry.read(id.clsid), portableFile)) {
        await registry.write(id.clsid, portableFile);
        result.server = 'written';
    }
    return result;
}
