// Room music: the settings of this profile, file music-settings.json in the user data folder (MU-5). The main process
// reads and writes the file. A bad value in the file gives the default of that field. A bad value in a change from the
// window keeps the current value.
import { readFileSync, writeFileSync, renameSync } from 'fs';
import path from 'path';

export const MUSIC_SETTINGS_FILE = 'music-settings.json';

export const DEFAULTS = Object.freeze({
    // The music volume of this listener, 0 to 100 %.
    volume: 60,
    // Lower the music while someone talks.
    ducking: true,
    // The music folder of this computer (an absolute path), or ''. Only the DJ plays the files of its folder.
    folder: ''
});

const CHECKS = Object.freeze({
    volume: value => (typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : undefined),
    ducking: value => (typeof value === 'boolean' ? value : undefined),
    folder: value => (value === '' || (typeof value === 'string' && value.length <= 1024 && !value.includes('\0') &&
        path.isAbsolute(value) && !/^[\\/]{2}[?.][\\/]/.test(value)) ? value : undefined)
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalize(value) {
    const v = isObject(value) ? value : {};
    const result = {};
    for (const [key, check] of Object.entries(CHECKS)) {
        const checked = Object.hasOwn(v, key) ? check(v[key]) : undefined;
        result[key] = checked === undefined ? DEFAULTS[key] : checked;
    }
    return result;
}

// The new settings after a change from the window. fields: the fields that the window can change (not the folder:
// only the folder dialog of the main process sets it).
export function merge(current, patch, fields = ['volume', 'ducking']) {
    const next = normalize(current);
    if (!isObject(patch)) return next;
    for (const key of fields) {
        if (!Object.hasOwn(patch, key) || !Object.hasOwn(CHECKS, key)) continue;
        const checked = CHECKS[key](patch[key]);
        if (checked !== undefined) next[key] = checked;
    }
    return next;
}

export function load(file) {
    try {
        return normalize(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
        return normalize(null);
    }
}

// Write to a temporary file, then rename.
export function save(file, settings) {
    const value = normalize(settings);
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2));
    renameSync(temp, file);
    return value;
}
