// The voice settings of this profile: file voice-settings.json in the user data folder.
// The main process reads and writes the file. Each field has a check. A bad value in the file gives the default value
// of that field only. A bad value in a change from the window keeps the current value.
import { readFileSync, writeFileSync, renameSync } from 'fs';

export const VOICE_SETTINGS_FILE = 'voice-settings.json';

export const LIMITS = Object.freeze({
    thresholdDb: Object.freeze({ min: -80, max: -10 }),
    releaseMs: Object.freeze({ min: 0, max: 2000 })
});

// Keys that the window uses for other functions. They cannot be the push-to-talk key.
export const PTT_FORBIDDEN = Object.freeze(['Escape', 'Enter', 'NumpadEnter', 'Tab']);

export const DEFAULTS = Object.freeze({
    // 'voice': voice activity (the gate opens above the threshold). 'ptt': push to talk.
    mode: 'voice',
    vadThresholdDb: -50,
    vadReleaseMs: 300,
    // A KeyboardEvent.code ('KeyV', 'ControlLeft') or a mouse button ('MouseMiddle', 'MouseBack', 'MouseForward').
    // null: no key.
    pttKey: null,
    pttReleaseMs: 200,
    // true: push to talk also while the ASSCRACK window is not in front (key hook of the system, ptt-hook.mjs).
    pttGlobal: true,
    echoCancellation: true,
    // 'rnnoise': RNNoise in an AudioWorklet (Chromium noise suppression off). 'standard': the noise suppression of
    // Chromium. 'off': none. An old file has true ('standard') or false ('off').
    noiseSuppression: 'rnnoise',
    autoGainControl: true,
    // '' is the default device of the system.
    inputDeviceId: '',
    outputDeviceId: ''
});

export function validPttKey(value) {
    return typeof value === 'string' && /^[A-Za-z0-9]{1,32}$/.test(value) && !PTT_FORBIDDEN.includes(value);
}

function number(limits) {
    return value => (typeof value === 'number' && Number.isFinite(value)
        ? Math.min(limits.max, Math.max(limits.min, Math.round(value)))
        : undefined);
}

function bool(value) {
    return typeof value === 'boolean' ? value : undefined;
}

const SUPPRESSORS = Object.freeze(['rnnoise', 'standard', 'off']);

function suppressor(value) {
    if (value === true) return 'standard';
    if (value === false) return 'off';
    return SUPPRESSORS.includes(value) ? value : undefined;
}

function deviceId(value) {
    return typeof value === 'string' && value.length <= 256 ? value : undefined;
}

// field -> check(value): the valid value, or undefined for a bad value.
const CHECKS = Object.freeze({
    mode: value => (value === 'voice' || value === 'ptt' ? value : undefined),
    vadThresholdDb: number(LIMITS.thresholdDb),
    vadReleaseMs: number(LIMITS.releaseMs),
    pttKey: value => (value === null || validPttKey(value) ? value : undefined),
    pttReleaseMs: number(LIMITS.releaseMs),
    pttGlobal: bool,
    echoCancellation: bool,
    noiseSuppression: suppressor,
    autoGainControl: bool,
    inputDeviceId: deviceId,
    outputDeviceId: deviceId
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A full, valid settings object from any value.
export function normalize(value) {
    const v = isObject(value) ? value : {};
    const result = {};
    for (const [key, check] of Object.entries(CHECKS)) {
        const checked = Object.prototype.hasOwnProperty.call(v, key) ? check(v[key]) : undefined;
        result[key] = checked === undefined ? DEFAULTS[key] : checked;
    }
    return result;
}

// The new settings after a change from the window. Only the known fields of the patch apply.
export function merge(current, patch) {
    const next = normalize(current);
    if (!isObject(patch)) return next;
    for (const [key, check] of Object.entries(CHECKS)) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        const checked = check(patch[key]);
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

// Write to a temporary file, then rename: a stop during the write does not leave half a file.
export function save(file, settings) {
    const value = normalize(settings);
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2));
    renameSync(temp, file);
    return value;
}
