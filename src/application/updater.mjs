// P9C: the updater. It finds a new signed release (GitHub, or the manifest that a peer sends), downloads the file of
// this build, checks it, and gives main.js the file for the restart. This module does not import electron: main.js
// (update-service.mjs) gives the folders, the fetch function, the store and the timers. The tests use fakes.
//
// Rules (design P9C):
// - The check reads the latest release from api.github.com, then update.json and update.json.sig of that tag. The
//   request has no user data (no name, no room, no peer ID) and a generic User-Agent.
// - The app accepts a manifest only with a good signature (update-manifest.mjs). A manifest of a version that is not
//   higher than this app gives no update. The app keeps the newest good manifest (also of its own version) for the
//   peers: an older peer gets it one time for each session (src/network/update-spread.mjs).
// - The file comes only from the GitHub release of the tag v<version>. It is good only when its size and SHA-256
//   agree with the signed manifest. The download goes to a .part file; a rename follows the check.
// - A failed check is quiet: a log line and a note in About.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync,
    unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { compareVersions, fileMatches, MAX_MANIFEST_BYTES, MAX_SIGNATURE_TEXT, parseVersion, verifyManifest } from './update-manifest.mjs';

export const REPOSITORY = 'noveblue53/asscrack';
export const USER_AGENT = 'ASSCRACK-updater';
export const STATE_FILE = 'update-state.json';
export const FIRST_CHECK_MS = 20 * 1000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAX_RELEASE_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 30 * 1000;
export const DOWNLOAD_IDLE_MS = 60 * 1000;
export const SETUP_FOLDER_PREFIX = 'asscrack-update-';
export const TEST_SERVER_FLAG = '--update-server';

// The two addresses of a release. testBase: http://127.0.0.1:<port> of tools/update-test-server.mjs, or null.
export function releaseSource(testBase = null) {
    const file = base => (tag, name) => `${base}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    if (testBase) {
        return { test: true, latest: `${testBase}/api/repos/${REPOSITORY}/releases/latest`, file: file(`${testBase}/download`) };
    }
    return { test: false, latest: `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
        file: file(`https://github.com/${REPOSITORY}/releases/download`) };
}

// The test option --update-server 127.0.0.1:<port> (no "http://": a packaged start with an http:// argument before an
// other argument stops before its log, also in 0.8.0). Only a test version (a pre-release part "test", for example
// 1.0.0-test) accepts it, and only the address 127.0.0.1. A release build thus always uses GitHub.
export function testServerBase(argv, version) {
    const index = argv.indexOf(TEST_SERVER_FLAG);
    if (index === -1) return null;
    const parsed = parseVersion(version);
    if (!parsed || !parsed.pre.includes('test')) return null;
    const m = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(String(argv[index + 1] ?? ''));
    if (!m || Number(m[1]) > 65535) return null;
    return `http://127.0.0.1:${m[1]}`;
}

// Read a response body with a size limit. The fetch stops when the body is too large.
async function readLimited(response, limit, controller) {
    const header = response.headers.get('content-length');
    const declared = header === null ? NaN : Number(header);
    if (Number.isFinite(declared) && declared > limit) { controller.abort(); throw new Error('response too large'); }
    const chunks = [];
    let size = 0;
    if (!response.body) return Buffer.alloc(0);
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) { controller.abort(); throw new Error('response too large'); }
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

export function hashFile(file) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        let size = 0;
        createReadStream(file).on('data', chunk => { hash.update(chunk); size += chunk.length; })
            .on('error', reject).on('end', () => resolve({ size, sha256: hash.digest('hex') }));
    });
}

// Delete the setup folders of earlier updates (the installer ran from them). A folder that is in use stays.
export function cleanSetupFolders(tempDir, { now = Date.now(), minAgeMs = 10 * 60 * 1000 } = {}) {
    let removed = 0;
    let names = [];
    try { names = readdirSync(tempDir); } catch { return 0; }
    for (const name of names) {
        if (!name.startsWith(SETUP_FOLDER_PREFIX)) continue;
        const dir = path.join(tempDir, name);
        try {
            if (now - statSync(dir).mtimeMs < minAgeMs) continue;
            rmSync(dir, { recursive: true, force: true });
            removed++;
        } catch { /* in use: the next start tries again */ }
    }
    return removed;
}

// deps:
//   currentVersion: app.getVersion(). kind: 'setup' (installed build), 'portable' or null (no download: npm start,
//   win-unpacked). publicKey: UPDATE_PUBLIC_KEY. source: releaseSource(). fetch: the fetch function.
//   folders: { setup(): a new empty folder for the setup file, portable(): the folder of the portable file or null,
//   downloads(): the Downloads folder }.
//   store: { read(): the saved state or null, write(state) }. log(level, text). changed(view).
//   now(), setTimer(fn, ms), clearTimer(id).
export function createUpdater({ currentVersion, kind = null, publicKey, source, fetch, folders, store, log = () => {},
    changed = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    firstCheckMs = FIRST_CHECK_MS, intervalMs = CHECK_INTERVAL_MS }) {
    if (!parseVersion(currentVersion)) throw new TypeError('The app version is not valid');
    const saved = (() => { try { return store.read() ?? {}; } catch { return {}; } })();
    let enabled = saved.enabled !== false;
    let lastCheck = saved.lastCheck && typeof saved.lastCheck === 'object' ? {
        time: Number(saved.lastCheck.time) || null, result: String(saved.lastCheck.result ?? ''), note: String(saved.lastCheck.note ?? '')
    } : null;
    // best: the newest good manifest (version >= currentVersion). from: 'github' or 'peer'.
    let best = null;
    let from = null;
    let checking = null;
    let downloading = null;
    let ready = null;
    let downloadNote = '';
    let dismissed = null;
    let timer = null;
    let stopped = false;
    const shareListeners = new Set();

    if (saved.manifest && typeof saved.manifest === 'object') {
        const r = verifyManifest(String(saved.manifest.text ?? ''), String(saved.manifest.signature ?? ''),
            { publicKey, currentVersion, newerOnly: false });
        if (r.ok && compareVersions(r.manifest.version, currentVersion) >= 0) {
            best = r;
            from = saved.manifest.from === 'peer' ? 'peer' : 'github';
        }
    }

    const newer = () => !!best && compareVersions(best.manifest.version, currentVersion) > 0;

    function persist() {
        try {
            store.write({ enabled, lastCheck, manifest: best ? { text: best.text, signature: best.signature, from } : null });
        } catch (err) {
            log('WARN', `Update state not saved: ${err?.message ?? err}`);
        }
    }

    function view() {
        const update = newer() ? {
            version: best.manifest.version,
            date: best.manifest.date,
            notes: best.manifest.notes,
            from,
            canDownload: !!kind && !!best.manifest.files[kind],
            downloading: !!downloading,
            ready: !!ready,
            inDownloads: ready?.fallback === true,
            // The last download failed (for example a wrong size or SHA-256): no bar, only the note in About.
            failed: !ready && !downloading && downloadNote !== '',
            note: downloadNote
        } : null;
        return { current: currentVersion, enabled, buildKind: kind, checking: !!checking, lastCheck, update,
            dismissed: !!update && dismissed === update.version };
    }
    const emit = () => { if (!stopped) changed(view()); };

    // A good manifest from GitHub or a peer. Returns true when it is new.
    function accept(result, origin) {
        if (compareVersions(result.manifest.version, currentVersion) < 0) return false;
        if (best && compareVersions(result.manifest.version, best.manifest.version) <= 0) return false;
        best = result;
        from = origin;
        ready = null;
        downloadNote = '';
        persist();
        log('INFO', `Update: ASSCRACK ${result.manifest.version} found (${origin})`);
        for (const listener of shareListeners) {
            try { listener(); } catch (err) { log('WARN', `Update share failed: ${err?.message ?? err}`); }
        }
        return true;
    }

    async function get(url, limit, timeoutMs = REQUEST_TIMEOUT_MS) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: {
                'User-Agent': USER_AGENT, Accept: url === source.latest ? 'application/vnd.github+json' : 'application/octet-stream' } });
            if (!response.ok) {
                controller.abort();
                const err = new Error(`HTTP ${response.status}`);
                err.status = response.status;
                throw err;
            }
            return await readLimited(response, limit, controller);
        } finally {
            clearTimeout(t);
        }
    }

    function setLast(result, note) {
        lastCheck = { time: now(), result, note };
        persist();
    }

    async function runCheck() {
        try {
            let release;
            try {
                release = JSON.parse((await get(source.latest, MAX_RELEASE_BYTES)).toString('utf8'));
            } catch (err) {
                if (err?.status === 404) { setLast('none', 'No release yet.'); return; }
                throw err;
            }
            const tag = release?.tag_name;
            if (typeof tag !== 'string' || !/^v/.test(tag) || !parseVersion(tag.slice(1))) {
                setLast('failed', 'The latest release has no valid tag.');
                log('WARN', 'Update check: the latest release has no valid tag');
                return;
            }
            const names = Array.isArray(release.assets) ? release.assets.map(asset => asset?.name) : [];
            if (!names.includes('update.json') || !names.includes('update.json.sig')) {
                setLast('none', `The release ${tag} has no update manifest.`);
                return;
            }
            const bytes = await get(source.file(tag, 'update.json'), MAX_MANIFEST_BYTES);
            const signature = (await get(source.file(tag, 'update.json.sig'), MAX_SIGNATURE_TEXT + 8)).toString('utf8');
            const r = verifyManifest(bytes, signature, { publicKey, currentVersion, newerOnly: false });
            if (!r.ok) {
                setLast('failed', `The update manifest was refused (${r.reason}).`);
                log('WARN', `Update check: the manifest of ${tag} was refused (${r.reason})`);
                return;
            }
            if (tag !== `v${r.manifest.version}`) {
                setLast('failed', 'The release tag and the manifest version do not agree.');
                log('WARN', `Update check: the tag ${tag} and the manifest version ${r.manifest.version} do not agree`);
                return;
            }
            accept(r, 'github');
            const cmp = compareVersions(r.manifest.version, currentVersion);
            setLast(cmp > 0 ? 'found' : 'none', cmp > 0 ? `ASSCRACK ${r.manifest.version} is available.` : 'ASSCRACK is up to date.');
        } catch (err) {
            setLast('failed', 'The check did not get an answer. ASSCRACK tries again later.');
            log('WARN', `Update check failed: ${err?.message ?? err}`);
        }
    }

    function check() {
        if (stopped) return Promise.resolve(view());
        if (checking) return checking;
        checking = (async () => {
            await null;
            emit();
            await runCheck();
            checking = null;
            if (newer() && enabled) void download();
            emit();
            return view();
        })();
        return checking;
    }

    function schedule(ms) {
        clearTimer(timer);
        timer = null;
        if (stopped || !enabled) return;
        timer = setTimer(async () => {
            timer = null;
            await check();
            schedule(intervalMs);
        }, ms);
    }

    // Stream the file into a .part file, with the SHA-256 and the size limit of the signed entry.
    async function downloadTo(url, part, entry, signal) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort);
        let idle = setTimeout(abort, DOWNLOAD_IDLE_MS);
        const fd = openSync(part, 'w');
        try {
            const response = await fetch(url, { signal: controller.signal, redirect: 'follow',
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const header = response.headers.get('content-length');
            const declared = header === null ? NaN : Number(header);
            if (Number.isFinite(declared) && declared !== entry.size) { abort(); throw new Error('the file size does not agree'); }
            const hash = createHash('sha256');
            let size = 0;
            for await (const chunk of response.body) {
                clearTimeout(idle);
                idle = setTimeout(abort, DOWNLOAD_IDLE_MS);
                size += chunk.length;
                if (size > entry.size) { abort(); throw new Error('the file is larger than the manifest size'); }
                hash.update(chunk);
                const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                let offset = 0;
                while (offset < data.length) offset += writeSync(fd, data, offset);
            }
            if (!fileMatches(entry, size, hash.digest('hex'))) throw new Error('the size or the SHA-256 does not agree with the manifest');
        } finally {
            clearTimeout(idle);
            signal?.removeEventListener('abort', abort);
            closeSync(fd);
        }
    }

    // The folder for the file and a probe that the folder is writable.
    function openFolder() {
        if (kind === 'setup') return { folder: folders.setup(), fallback: false };
        const own = folders.portable();
        if (own) {
            const probe = path.join(own, `.asscrack-write-${randomBytes(4).toString('hex')}`);
            try {
                closeSync(openSync(probe, 'wx'));
                unlinkSync(probe);
                return { folder: own, fallback: false };
            } catch { /* not writable: use Downloads */ }
        }
        return { folder: folders.downloads(), fallback: true };
    }

    function download() {
        if (stopped || !kind || !newer() || ready || downloading) return downloading ?? Promise.resolve(view());
        const entry = best.manifest.files[kind];
        if (!entry) {
            downloadNote = 'This release has no file for this build.';
            emit();
            return Promise.resolve(view());
        }
        const version = best.manifest.version;
        const controller = new AbortController();
        downloading = (async () => {
            await null;
            downloadNote = '';
            emit();
            let part = null;
            try {
                const { folder, fallback } = openFolder();
                const target = path.join(folder, entry.name);
                if (existsSync(target)) {
                    const have = await hashFile(target);
                    if (!fileMatches(entry, have.size, have.sha256)) throw new Error(`an other file has the name ${entry.name}`);
                } else {
                    part = `${target}.part`;
                    await downloadTo(source.file(`v${version}`, entry.name), part, entry, controller.signal);
                    renameSync(part, target);
                    part = null;
                }
                if (best?.manifest.version === version) {
                    ready = { file: target, fallback, version, entry };
                    log('INFO', `Update: ASSCRACK ${version} is ready (${kind}${fallback ? ', in Downloads' : ''})`);
                }
            } catch (err) {
                downloadNote = 'The download did not complete. ASSCRACK tries again at the next check.';
                log('WARN', `Update download failed: ${err?.message ?? err}`);
                if (part) { try { rmSync(part, { force: true }); } catch { /* ignore */ } }
            } finally {
                downloading = null;
                emit();
            }
            return view();
        })();
        downloading.abort = () => controller.abort();
        return downloading;
    }

    return {
        view,
        start() {
            if (!stopped && enabled) schedule(firstCheckMs);
            if (newer()) emit();
        },
        check,
        download: () => download(),
        setEnabled(on) {
            enabled = on === true;
            persist();
            if (enabled) schedule(firstCheckMs);
            else schedule(0);
            emit();
            return view();
        },
        dismiss() {
            if (newer()) dismissed = best.manifest.version;
            emit();
            return view();
        },
        // The checked file for the restart, or null. The file is checked again here: a change on the disk stops it.
        async prepareRestart() {
            if (!ready) return null;
            const current = ready;
            let have;
            try { have = await hashFile(current.file); } catch { have = null; }
            if (!have || !fileMatches(current.entry, have.size, have.sha256)) {
                ready = null;
                downloadNote = 'The downloaded file changed. ASSCRACK downloads it again at the next check.';
                log('WARN', 'Update: the downloaded file changed before the restart');
                emit();
                return null;
            }
            return { kind, file: current.file, version: current.version, fallback: current.fallback };
        },
        // The peer part (node option "updates" of createAsscrackNode).
        offerFor(peerVersion) {
            if (!best || !parseVersion(peerVersion)) return null;
            return compareVersions(peerVersion, best.manifest.version) < 0 ? { text: best.text, signature: best.signature } : null;
        },
        receivePeer(payload) {
            if (stopped || typeof payload?.text !== 'string' || typeof payload?.signature !== 'string') return false;
            if (best && payload.text === best.text) return false;
            const r = verifyManifest(payload.text, payload.signature, { publicKey, currentVersion, newerOnly: true });
            if (!r.ok) {
                log('INFO', `Update: a peer manifest was refused (${r.reason})`);
                return false;
            }
            if (!accept(r, 'peer')) return false;
            if (enabled) void download();
            emit();
            return true;
        },
        onShare(listener) {
            shareListeners.add(listener);
            return () => shareListeners.delete(listener);
        },
        stop() {
            stopped = true;
            clearTimer(timer);
            timer = null;
            downloading?.abort?.();
        }
    };
}

// Read the ProductName and the ProductVersion of the version resource of a Windows executable (the first 2 MB; the
// portable launcher has the resource at about 200 KB). Returns { product, version } or null.
export function readExeVersion(file, limit = 2 * 1024 * 1024) {
    let fd;
    try {
        fd = openSync(file, 'r');
        const buffer = Buffer.alloc(limit);
        const length = readSync(fd, buffer, 0, limit, 0);
        const data = buffer.subarray(0, length);
        if (data.length < 2 || data[0] !== 0x4d || data[1] !== 0x5a) return null;
        const value = key => {
            const at = data.indexOf(Buffer.from(`${key}\0`, 'utf16le'));
            if (at === -1) return null;
            let i = at + (key.length + 1) * 2;
            while (i + 1 < data.length && data[i] === 0 && data[i + 1] === 0) i += 2;
            let end = i;
            while (end + 1 < data.length && (data[end] !== 0 || data[end + 1] !== 0) && end - i < 256) end += 2;
            return data.subarray(i, end).toString('utf16le');
        };
        const product = value('ProductName');
        const version = value('ProductVersion');
        return product && version ? { product, version } : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

const OLD_PORTABLE = /^ASSCRACK-(.+)-portable\.exe$/;

// After an update of the portable build: delete the old portable file. ownFile: PORTABLE_EXECUTABLE_FILE of the new
// copy. oldName: a file name only (no folder), from the --update-old argument. The file must be in the folder of the
// new copy, have the exact name of an older ASSCRACK portable file, and have the ASSCRACK version resource of that
// version. Returns the full path of the old file, or null (refused).
export function oldPortableTarget({ ownFile, oldName, ownVersion, readVersion = readExeVersion }) {
    if (typeof ownFile !== 'string' || typeof oldName !== 'string' || path.basename(oldName) !== oldName) return null;
    if (/[\\/:]/.test(oldName)) return null;
    const m = OLD_PORTABLE.exec(oldName);
    if (!m || !parseVersion(m[1]) || !parseVersion(ownVersion) || compareVersions(m[1], ownVersion) >= 0) return null;
    if (oldName.toLowerCase() === path.basename(ownFile).toLowerCase()) return null;
    const target = path.join(path.dirname(ownFile), oldName);
    try { if (!statSync(target).isFile()) return null; } catch { return null; }
    const info = readVersion(target);
    if (!info || info.product !== 'ASSCRACK' || info.version !== m[1]) return null;
    return target;
}

// Delete the old file. Returns { result: 'deleted' | 'refused' | 'failed' }. The old launcher can hold the file for some
// seconds after its exit: try again for up to tries x waitMs.
export async function removeOldPortable(options, { tries = 30, waitMs = 1000, unlink = unlinkSync, wait } = {}) {
    const target = oldPortableTarget(options);
    if (!target) return { result: 'refused' };
    const pause = wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (let i = 0; i < tries; i++) {
        try {
            unlink(target);
            return { result: 'deleted', file: path.basename(target) };
        } catch (err) {
            if (err?.code === 'ENOENT') return { result: 'deleted', file: path.basename(target) };
            if (i === tries - 1) return { result: 'failed', error: err?.code ?? String(err) };
            await pause(waitMs);
        }
    }
    return { result: 'failed' };
}

// Windows command line quotes of one argument (the rules of CommandLineToArgvW).
export function quoteArg(arg) {
    const value = String(arg);
    if (value !== '' && !/[\s"]/.test(value)) return value;
    let out = '"';
    let slashes = 0;
    for (const ch of value) {
        if (ch === '\\') { slashes++; continue; }
        if (ch === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
        out += '\\'.repeat(slashes) + ch;
        slashes = 0;
    }
    return out + '\\'.repeat(slashes * 2) + '"';
}

const psText = value => `'${String(value).replace(/'/g, "''")}'`;

// The PowerShell script of the restart. It waits until the old app (and the portable launcher) stopped, then runs the
// installer silently (installed build), then starts the new version with the same test arguments.
//   waitPids: the process IDs to wait for. setup: { file, installDir } or null. start: { file, args }.
export function restartScript({ waitPids, setup = null, start }) {
    const lines = ["$ErrorActionPreference = 'SilentlyContinue'"];
    for (const pid of waitPids) {
        if (Number.isSafeInteger(pid) && pid > 0) lines.push(`Wait-Process -Id ${pid} -Timeout 60`);
    }
    if (setup) {
        // NSIS: /D= is the last argument and has no quotes. --updated: the update path (no question, no shortcut change).
        lines.push(`$p = Start-Process -FilePath ${psText(setup.file)} -ArgumentList ${psText(`--updated /S /D=${setup.installDir}`)} -Wait -PassThru`);
    }
    const args = start.args.map(quoteArg).join(' ');
    lines.push(args
        ? `Start-Process -FilePath ${psText(start.file)} -ArgumentList ${psText(args)}`
        : `Start-Process -FilePath ${psText(start.file)}`);
    return lines.join('\r\n');
}

export function encodedCommand(script) {
    return Buffer.from(script, 'utf16le').toString('base64');
}

// The arguments of the restart helper (two stages). From the app, a PowerShell with DETACHED_PROCESS exits at once and
// does nothing, and a child that is not detached is in the job of libuv: it stops with the app (this PC, Electron
// 45). Thus the first stage (a normal child) starts the second stage with Start-Process and exits. The second stage
// is not in that job: it waits for the app, then does the restart script.
export function helperArgs(powershell, script) {
    const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
    const second = [...base, '-EncodedCommand', encodedCommand(script)].map(psText).join(',');
    const first = `Start-Process -FilePath ${psText(powershell)} -WindowStyle Hidden -ArgumentList ${second}`;
    return [...base, '-EncodedCommand', encodedCommand(first)];
}
