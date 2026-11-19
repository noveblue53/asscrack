// The send gate of the voice capture (src/application/voice-gate.js), loaded in node:vm. No audio, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/voice-gate.js', import.meta.url), 'utf8');
const context = { window: {}, Math, Number };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'voice-gate.js' });
const { createGate, levelDb, PREROLL_BLOCKS, FLOOR_DB } = context.window.voiceGate;

const BLOCK = 960;
const MS = 20;

// A block with a constant RMS level in dBFS (a square wave of that amplitude).
function block(db) {
    const a = 10 ** (db / 20);
    const samples = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) samples[i] = i % 2 === 0 ? a : -a;
    return samples;
}

// Push the levels one block each 20 ms. Returns the per-block results.
function run(gate, levels, start = 0) {
    return levels.map((db, i) => gate.push(block(db), start + i * MS));
}

test('levelDb gives the RMS level in dBFS', () => {
    assert.ok(Math.abs(levelDb(block(-20)) - -20) < 0.01);
    assert.ok(Math.abs(levelDb(block(-50)) - -50) < 0.01);
    assert.equal(levelDb(new Float32Array(BLOCK)), FLOOR_DB);
    assert.equal(levelDb(new Float32Array(0)), FLOOR_DB);
});

test('voice activity: the gate opens at the threshold and closes after the release delay', () => {
    const gate = createGate({ mode: 'voice', vadThresholdDb: -40, vadReleaseMs: 100 });
    const results = run(gate, [-60, -60, -30, -30, -60, -60, -60, -60, -60, -60, -60, -60]);
    const open = results.map(r => r.open);
    // Blocks 2 and 3 are loud (t = 40, 60 ms). The gate stays open to t = 60 + 100 = 160 ms (block 8).
    assert.deepEqual(open, [false, false, true, true, true, true, true, true, true, false, false, false]);
    assert.equal(results[0].send.length, 0, 'a closed gate sends nothing');
    assert.equal(results[10].send.length, 0);
    assert.equal(results[2].send.length, PREROLL_BLOCKS + 1, 'the pre-roll blocks go out first');
    assert.equal(results[3].send.length, 1);
    assert.equal(results[9].send.length, 1, 'the closing block goes out with a fade-out');
    // Just above and just below the threshold (Float32 samples: the level of block(-40) is not exactly -40).
    const edge = createGate({ mode: 'voice', vadThresholdDb: -40, vadReleaseMs: 0 });
    assert.equal(edge.push(block(-39.99), 0).open, true);
    assert.equal(edge.push(block(-40.01), 20).open, false);
});

test('voice activity: a release delay of 0 closes on the first quiet block', () => {
    const gate = createGate({ mode: 'voice', vadThresholdDb: -40, vadReleaseMs: 0 });
    assert.deepEqual(run(gate, [-30, -60, -30, -60]).map(r => r.open), [true, false, true, false]);
});

test('the pre-roll holds at most PREROLL_BLOCKS blocks and starts with a fade-in', () => {
    const gate = createGate({ mode: 'voice', vadThresholdDb: -40, vadReleaseMs: 0 });
    const quiet = [];
    for (let i = 0; i < 5; i++) {
        const b = block(-45);
        quiet.push(b);
        assert.equal(gate.push(b, i * MS).send.length, 0);
    }
    const loud = block(-20);
    const { send } = gate.push(loud, 5 * MS);
    assert.equal(send.length, PREROLL_BLOCKS + 1);
    assert.equal(send[0], quiet[5 - PREROLL_BLOCKS], 'the newest quiet blocks are the pre-roll');
    assert.equal(send[send.length - 1], loud);
    assert.equal(Math.abs(send[0][0]), 0, 'the first sample of a burst is 0 (fade-in)');
    assert.notEqual(send[1][0], 0, 'only the first block has the fade-in');
});

test('the closing block fades out to 0', () => {
    const gate = createGate({ mode: 'voice', vadThresholdDb: -40, vadReleaseMs: 0 });
    gate.push(block(-20), 0);
    const last = gate.push(block(-50), MS).send[0];
    assert.equal(Math.abs(last[last.length - 1]), 0);
    assert.ok(Math.abs(levelDb(last)) > 50, 'the faded block is quieter than the input');
});

test('push to talk: the key opens the gate and the release delay closes it', () => {
    const gate = createGate({ mode: 'ptt', pttReleaseMs: 50, vadThresholdDb: -40 });
    // Loud audio with no key: closed.
    assert.equal(gate.push(block(-10), 0).open, false);
    gate.setKey(true, 10);
    assert.equal(gate.push(block(-90), 20).open, true, 'the key opens the gate, also for quiet audio');
    assert.equal(gate.push(block(-90), 40).open, true);
    gate.setKey(false, 50);
    assert.equal(gate.push(block(-90), 60).open, true, '10 ms after the key up');
    assert.equal(gate.push(block(-90), 80).open, true, '30 ms after the key up');
    assert.equal(gate.push(block(-90), 100).open, false, '50 ms after the key up');
});

test('push to talk: a short press between two blocks sends at least one block', () => {
    const gate = createGate({ mode: 'ptt', pttReleaseMs: 0 });
    gate.push(block(-30), 0);
    gate.setKey(true, 5);
    gate.setKey(false, 10);
    assert.equal(gate.push(block(-30), 20).open, true);
    assert.equal(gate.push(block(-30), 40).open, false);
});

test('push to talk: key repeat does not extend the press, and a key up with no key down does nothing', () => {
    const gate = createGate({ mode: 'ptt', pttReleaseMs: 0 });
    gate.setKey(false, 0);
    assert.equal(gate.push(block(-30), 0).open, false);
    gate.setKey(true, 1);
    gate.setKey(true, 2);
    gate.setKey(true, 3);
    assert.equal(gate.keyDown(), true);
    gate.setKey(false, 4);
    assert.equal(gate.keyDown(), false);
    assert.equal(gate.push(block(-30), 20).open, true);
    assert.equal(gate.push(block(-30), 40).open, false);
});

test('a change of the mode resets the gate; a change of the threshold does not', () => {
    const gate = createGate({ mode: 'ptt', pttReleaseMs: 1000 });
    gate.setKey(true, 0);
    assert.equal(gate.push(block(-30), 0).open, true);
    gate.configure({ mode: 'ptt', pttReleaseMs: 500 });
    assert.equal(gate.keyDown(), true, 'the same mode keeps the key state');
    gate.configure({ mode: 'voice', vadThresholdDb: -40, vadReleaseMs: 0 });
    assert.equal(gate.keyDown(), false);
    assert.equal(gate.isOpen(), false);
    assert.equal(gate.push(block(-50), 20).open, false);
    gate.configure({ mode: 'voice', vadThresholdDb: -60, vadReleaseMs: 0 });
    assert.equal(gate.push(block(-50), 40).open, true, 'the new threshold applies to the next block');
});

test('bad settings give the defaults (voice activity at -50 dBFS)', () => {
    const gate = createGate({ mode: 'other', vadThresholdDb: 'x' });
    assert.equal(gate.push(block(-49), 0).open, true);
    const quiet = createGate(null);
    assert.equal(quiet.push(block(-51), 0).open, false);
});
