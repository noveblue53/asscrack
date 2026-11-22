import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = '.asscrack-download-owner';
const PART = /^\.asscrack-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.part$/i;
// A partial that the user paused (src/network/partial-store.mjs). It moves to the folder of the next run.
const PAUSED = /^\.asscrack-resume-[0-9a-f]{64}-(?:0|[1-9]\d{0,15})\.(?:part|json)$/;

function processExists(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
}

export function createDownloadScratch(downloads, profile, { pid = process.pid, alive = processExists } = {}) {
    const owner = createHash('sha256').update(profile).digest('hex').slice(0, 24);
    const prefix = `.asscrack-download-${owner}-`;
    const markerText = `Asscrack downloads v1 ${owner}\n`;
    mkdirSync(downloads, { recursive: true });

    function owned(directory) {
        if (!lstatSync(directory).isDirectory()) return false;
        const marker = path.join(directory, MARKER);
        const stat = lstatSync(marker);
        return stat.isFile() && stat.size === markerText.length && readFileSync(marker, 'utf8') === markerText;
    }

    // Moves the paused partials of a dead run to the current folder. The store of the current run finds them,
    // and it deletes each expired one.
    function adopt(directory, target) {
        try {
            if (!owned(directory)) return;
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (!entry.isFile() || !PAUSED.test(entry.name)) continue;
                const from = path.join(directory, entry.name);
                const to = path.join(target, entry.name);
                try {
                    if (existsSync(to)) unlinkSync(from);
                    else renameSync(from, to);
                } catch { /* The next launch can retry. */ }
            }
        } catch { /* An unreadable folder stays in place. */ }
    }

    function cleanup(directory) {
        try {
            if (!owned(directory)) return;
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (entry.isFile() && PART.test(entry.name)) unlinkSync(path.join(directory, entry.name));
            }
            // Leave any unfamiliar names, hard failures and live files in place.
            const remaining = readdirSync(directory);
            if (remaining.length !== 1 || remaining[0] !== MARKER) return;
            unlinkSync(path.join(directory, MARKER));
            rmdirSync(directory);
        } catch { /* The next launch can retry app-owned partials locked during shutdown. */ }
    }

    const directory = mkdtempSync(path.join(downloads, `${prefix}${pid}-`));
    try { writeFileSync(path.join(directory, MARKER), markerText, { flag: 'wx', mode: 0o600 }); }
    catch (error) { try { rmdirSync(directory); } catch {} throw error; }
    for (const entry of readdirSync(downloads, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        const match = /^([1-9]\d{0,9})-[A-Za-z0-9]{6}$/.exec(entry.name.slice(prefix.length));
        const ownerPid = match && Number(match[1]);
        const old = path.join(downloads, entry.name);
        if (old === directory || !ownerPid || ownerPid > 2147483647 || alive(ownerPid)) continue;
        adopt(old, directory);
        cleanup(old);
    }
    // clear() at quit removes only the interrupted downloads. A folder with paused partials stays for the next run.
    return { directory, clear: () => cleanup(directory) };
}
