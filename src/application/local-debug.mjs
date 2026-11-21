import { closeSync, constants, openSync, readSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// Older versions wrote unredacted troubleshooting logs during every launch.
// Only remove the exact filename and startup header those versions produced.
export function clearLegacyDebugLogs(directory) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (!entry.isFile() || !/^asscrack-\d{8}-\d{6}\.log$/.test(entry.name)) continue;
        const file = path.join(directory, entry.name);
        let fd;
        try {
            fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            const prefix = Buffer.alloc(192);
            const n = readSync(fd, prefix, 0, prefix.length, 0);
            closeSync(fd);
            fd = undefined;
            const header = prefix.toString('utf8', 0, n);
            if (/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO ASSCRACK \S+ Electron \S+ args \[/.test(header)) unlinkSync(file);
        } catch { /* Locked logs can be cleaned on another launch. */ }
        finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
    }
}
