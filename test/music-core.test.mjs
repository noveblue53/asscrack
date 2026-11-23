// Room music in the window (src/application/music-core.js, loaded in node:vm): the music gain (volume and ducking),
// the talk check and the chat commands. No audio, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/music-core.js', import.meta.url), 'utf8');
const context = { window: {}, Math, Number, String, Object };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'music-core.js' });
const core = context.window.musicCore;

test('mixer: the volume curve, the limits and ducking', () => {
    assert.equal(core.musicGain({ volume: 100, ducking: true, talking: false }), 1);
    assert.equal(core.musicGain({ volume: 0 }), 0);
    assert.equal(core.musicGain({ volume: 50, ducking: false }), 0.25);
    // Out of range and not a number.
    assert.equal(core.musicGain({ volume: 150 }), 1);
    assert.equal(core.musicGain({ volume: -5 }), 0);
    assert.equal(core.musicGain({ volume: NaN }), 0.36, 'the default 60 %');
    // Ducking: only with the setting on and while someone talks.
    assert.equal(core.musicGain({ volume: 100, ducking: true, talking: true }), core.DUCK_GAIN);
    assert.equal(core.musicGain({ volume: 100, ducking: false, talking: true }), 1);
    assert.ok(Math.abs(core.musicGain({ volume: 50, ducking: true, talking: true }) - 0.25 * core.DUCK_GAIN) < 1e-12);
});

test('talk check: a voice level above the speech level or the own send', () => {
    assert.equal(core.talking({}), false);
    assert.equal(core.talking({ a: { audioLevel: 0.001 }, b: { audioLevel: 0 } }), false);
    assert.equal(core.talking({ a: { audioLevel: 0.001 }, b: { audioLevel: 0.2 } }), true);
    assert.equal(core.talking({}, true), true);
    assert.equal(core.talking(null), false);
});

test('commands: /play <link>, /skip, /queue, /pause; a reserved command is never a chat line', () => {
    assert.deepEqual({ ...core.parseCommand('/play https://youtu.be/dQw4w9WgXcQ') }, { name: 'play', link: 'https://youtu.be/dQw4w9WgXcQ' });
    assert.deepEqual({ ...core.parseCommand('  /PLAY  ') }, { name: 'play', link: '' });
    assert.deepEqual({ ...core.parseCommand('/skip') }, { name: 'skip' });
    assert.deepEqual({ ...core.parseCommand('/queue now') }, { name: 'queue' });
    assert.deepEqual({ ...core.parseCommand('/pause') }, { name: 'pause' });
    for (const text of ['/player', '/skipper x', 'play x', 'hi /play x', '/ play', '']) {
        assert.equal(core.parseCommand(text), null, text);
        assert.equal(core.isCommand(text), false, text);
    }
    assert.equal(core.isCommand('/play not a link'), true);
    assert.equal(core.isCommand('/queue'), true);
});

test('queue text and time', () => {
    assert.equal(core.clock(0), '');
    assert.equal(core.clock(65), '1:05');
    assert.equal(core.clock(3725), '1:02:05');
    assert.deepEqual([...core.queueLines(null)], ['No music.']);
    const view = { dj: 'p1', paused: false, now: { title: 'Now', dur: 61 },
        queue: Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, dur: 0 })) };
    const lines = core.queueLines(view, id => `name-${id}`);
    assert.equal(lines[0], 'Playing: Now (1:01)');
    assert.equal(lines[1], '1. T0');
    assert.equal(lines[11], '+2 more');
    assert.equal(lines.at(-1), 'DJ: name-p1');
    assert.equal(core.noticeText('unavailable'), 'YouTube source unavailable.');
    assert.equal(core.noticeText('other'), '');
});
