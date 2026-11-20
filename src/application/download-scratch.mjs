import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = '.asscrack-download-owner';
const PART = /^\.asscrack-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.part$/i;

function processExists(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
}

export function createDownloadScratch(downloads, profile, { pid = process.pid, alive = processExists } = {}) {
    const owner = createHash('sha256').update(profile).digest('hex').slice(0, 24);
    const prefix = `.asscrack-download-${owner}-`;
    const markerText = `Asscrack downloads v1 ${owner}\n`;
    mkdirSync(downloads, { recursive: true });

    function cleanup(directory) {
        try {
            if (!lstatSync(directory).isDirectory()) return;
            const marker = path.join(directory, MARKER);
            const stat = lstatSync(marker);
            if (!stat.isFile() || stat.size !== markerText.length || readFileSync(marker, 'utf8') !== markerText) return;
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (entry.isFile() && PART.test(entry.name)) unlinkSync(path.join(directory, entry.name));
            }
            // Leave any unfamiliar names, hard failures and live files in place.
            const remaining = readdirSync(directory);
            if (remaining.length !== 1 || remaining[0] !== MARKER) return;
            unlinkSync(marker);
            rmdirSync(directory);
        } catch { /* The next launch can retry app-owned partials locked during shutdown. */ }
    }

    for (const entry of readdirSync(downloads, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        const match = /^([1-9]\d{0,9})-[A-Za-z0-9]{6}$/.exec(entry.name.slice(prefix.length));
        const ownerPid = match && Number(match[1]);
        if (ownerPid && ownerPid <= 2147483647 && !alive(ownerPid)) cleanup(path.join(downloads, entry.name));
    }
    const directory = mkdtempSync(path.join(downloads, `${prefix}${pid}-`));
    try { writeFileSync(path.join(directory, MARKER), markerText, { flag: 'wx', mode: 0o600 }); }
    catch (error) { try { rmdirSync(directory); } catch {} throw error; }
    return { directory, clear: () => cleanup(directory) };
}
