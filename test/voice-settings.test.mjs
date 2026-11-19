// The voice settings store (src/application/voice-settings.mjs). No network, no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS, LIMITS, PTT_FORBIDDEN, normalize, merge, load, save, validPttKey } from '../src/application/voice-settings.mjs';

test('normalize gives the defaults for a missing or bad value', () => {
    for (const value of [undefined, null, 42, 'text', [], {}]) {
        assert.deepEqual(normalize(value), { ...DEFAULTS });
    }
    const bad = normalize({
        mode: 'always', vadThresholdDb: 'loud', vadReleaseMs: Number.NaN, pttKey: 'Key V', pttReleaseMs: null,
        pttGlobal: 'yes', echoCancellation: 'yes', noiseSuppression: 'krisp', autoGainControl: undefined,
        inputDeviceId: 7, outputDeviceId: {}
    });
    assert.deepEqual(bad, { ...DEFAULTS });
});

test('normalize keeps good values and clamps numbers to the limits', () => {
    const value = normalize({
        mode: 'ptt', vadThresholdDb: -200, vadReleaseMs: 99999, pttKey: 'ControlLeft', pttReleaseMs: 150.6,
        pttGlobal: false, echoCancellation: false, noiseSuppression: 'standard', autoGainControl: false,
        inputDeviceId: 'abc', outputDeviceId: 'def', unknown: 'dropped'
    });
    assert.equal(value.mode, 'ptt');
    assert.equal(value.vadThresholdDb, LIMITS.thresholdDb.min);
    assert.equal(value.vadReleaseMs, LIMITS.releaseMs.max);
    assert.equal(value.pttKey, 'ControlLeft');
    assert.equal(value.pttReleaseMs, 151);
    assert.equal(value.echoCancellation, false);
    assert.equal(value.pttGlobal, false);
    assert.equal(value.noiseSuppression, 'standard');
    assert.equal(value.autoGainControl, false);
    assert.equal(value.inputDeviceId, 'abc');
    assert.equal(value.outputDeviceId, 'def');
    assert.equal('unknown' in value, false);
});

test('noise suppression is rnnoise, standard or off; an old true or false value still loads', () => {
    assert.equal(DEFAULTS.noiseSuppression, 'rnnoise');
    for (const v of ['rnnoise', 'standard', 'off']) assert.equal(normalize({ noiseSuppression: v }).noiseSuppression, v);
    assert.equal(normalize({ noiseSuppression: true }).noiseSuppression, 'standard');
    assert.equal(normalize({ noiseSuppression: false }).noiseSuppression, 'off');
    assert.equal(merge(normalize({ noiseSuppression: 'off' }), { noiseSuppression: 'RNNoise' }).noiseSuppression, 'off');
});

test('the push-to-talk key must be a key code that the window does not use', () => {
    for (const key of PTT_FORBIDDEN) assert.equal(validPttKey(key), false, key);
    for (const key of ['', 'a b', 'Key-V', 'x'.repeat(33), 5, null]) assert.equal(validPttKey(key), false, String(key));
    for (const key of ['KeyV', 'Backquote', 'F13', 'ControlRight', 'Mouse4']) assert.equal(validPttKey(key), true, key);
});

test('merge applies only the good fields of a change', () => {
    const current = normalize({ mode: 'ptt', pttKey: 'KeyV', vadThresholdDb: -40 });
    const next = merge(current, { vadThresholdDb: 'bad', pttKey: 'Escape', mode: 'voice', vadReleaseMs: 500, other: 1 });
    assert.equal(next.vadThresholdDb, -40, 'a bad value keeps the current value');
    assert.equal(next.pttKey, 'KeyV', 'a forbidden key keeps the current key');
    assert.equal(next.mode, 'voice');
    assert.equal(next.vadReleaseMs, 500);
    assert.equal('other' in next, false);
    assert.equal(merge(next, { pttKey: null }).pttKey, null, 'null removes the key');
    assert.deepEqual(merge(next, 'not an object'), next);
});

test('load and save use one JSON file, and a bad file gives the defaults', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-voice-settings-'));
    try {
        const file = path.join(dir, 'voice-settings.json');
        assert.deepEqual(load(file), { ...DEFAULTS }, 'no file');
        writeFileSync(file, '{ not json');
        assert.deepEqual(load(file), { ...DEFAULTS }, 'bad JSON');
        const saved = save(file, { mode: 'ptt', pttKey: 'KeyB', vadThresholdDb: 5 });
        assert.equal(saved.vadThresholdDb, LIMITS.thresholdDb.max);
        assert.deepEqual(load(file), saved);
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved);
        assert.equal(existsSync(`${file}.tmp`), false, 'no temporary file stays');
        // An old file with fewer fields keeps its fields and gets the defaults for the others.
        writeFileSync(file, JSON.stringify({ mode: 'ptt' }));
        assert.deepEqual(load(file), { ...DEFAULTS, mode: 'ptt' });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
