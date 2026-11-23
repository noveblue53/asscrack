// L8 (partial fix): the window gives the main process the path of a file that the user chose (the file picker, a
// drop or a paste). The main process cannot prove that the user chose it: a drop and a paste give the path only in
// the window. Thus the main process checks each path before it sends the file to the room:
// - an absolute path with no device namespace (\?\ or \.\) and no NUL,
// - a regular file (after links),
// - not in a folder of this app or of the release key (the profile with the archive and its key files, the logs).
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_PATH = 32767;

function inside(dir, file, platform) {
    const fold = platform === 'win32' ? s => s.toLowerCase() : s => s;
    const relative = path.relative(fold(path.resolve(dir)), fold(file));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Gives the path of a file that the room can get, or throws an Error with a text for the user.
// blocked: the folders that the room must never get a file from.
export function checkChosenFile(filePath, { blocked = [], platform = process.platform, realpath = realpathSync.native,
    stat = statSync } = {}) {
    if (typeof filePath !== 'string' || !filePath || filePath.length > MAX_PATH || filePath.includes('\0') ||
        !path.isAbsolute(filePath) || /^[\/]{2}[?.][\/]/.test(filePath)) {
        throw new Error('Choose a local file');
    }
    let real;
    try {
        real = realpath(filePath);
        if (!stat(real).isFile()) throw new Error('not a file');
    } catch {
        throw new Error('Choose a local file');
    }
    if ([filePath, real].some(p => blocked.some(dir => dir && inside(dir, path.resolve(p), platform)))) {
        throw new Error("Can't share files from the app's private folder.");
    }
    return filePath;
}

// Save image as (chat-media.js): the main process checks the path of the Save dialog before it writes a file there.
// The same rules as checkChosenFile: an absolute path with no device namespace and no NUL, and not in a blocked
// folder (after links). The folder must exist. An existing target must be a regular file. Gives the path, or throws an
// Error with a text for the user.
export function checkSaveTarget(filePath, { blocked = [], platform = process.platform, realpath = realpathSync.native,
    stat = statSync } = {}) {
    if (typeof filePath !== 'string' || !filePath || filePath.length > MAX_PATH || filePath.includes('\0') ||
        !path.isAbsolute(filePath) || /^[\\/]{2}[?.][\\/]/.test(filePath) || !path.basename(filePath)) {
        throw new Error('Choose a local folder');
    }
    let folder, target = null;
    try {
        folder = realpath(path.dirname(filePath));
        if (!stat(folder).isDirectory()) throw new Error('not a folder');
    } catch {
        throw new Error('Choose a local folder');
    }
    try { target = realpath(filePath); } catch { target = null; }
    if (target !== null) {
        let file = false;
        try { file = stat(target).isFile(); } catch { file = false; }
        if (!file) throw new Error('Choose a file name, not a folder');
    }
    const paths = [filePath, path.join(folder, path.basename(filePath)), ...(target ? [target] : [])];
    if (paths.some(p => blocked.some(dir => dir && inside(dir, path.resolve(p), platform)))) {
        throw new Error("Can't save in the app's private folder.");
    }
    return filePath;
}
