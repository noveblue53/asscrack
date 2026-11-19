// Tests of findCore in src/application/find.js. The file loads in node:vm with no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/find.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'find.js' });
const f = context.window.findCore;

test('find.js loads with no DOM and gives no window.findBar', () => {
    assert.equal(typeof f, 'object');
    assert.equal(context.window.findBar, undefined);
});

test('matcher: case-insensitive, empty query gives no match', () => {
    const texts = ['Hello World', 'nothing', 'hello again', 'HELLO'];
    assert.deepEqual(Array.from(f.matchLines(texts, 'hello')), [0, 2, 3]);
    assert.deepEqual(Array.from(f.matchLines(texts, 'WORLD')), [0]);
    assert.deepEqual(Array.from(f.matchLines(texts, '')), []);
    assert.deepEqual(Array.from(f.matchLines(texts, '   ')), []);
    assert.deepEqual(Array.from(f.matchLines(texts, 'zzz')), []);
});

test('ranges: each match in one text', () => {
    assert.deepEqual(Array.from(f.matchRanges('abcABCabc', 'abc'), r => ({ ...r })),
        [{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }]);
    assert.deepEqual(Array.from(f.matchRanges('aaaa', 'aa'), r => ({ ...r })), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    assert.deepEqual(Array.from(f.matchRanges('abc', '')), []);
});

test('step wraps in both directions', () => {
    assert.equal(f.step(-1, 3, 1), 0);
    assert.equal(f.step(-1, 3, -1), 2);
    assert.equal(f.step(0, 3, 1), 1);
    assert.equal(f.step(2, 3, 1), 0);
    assert.equal(f.step(0, 3, -1), 2);
    assert.equal(f.step(0, 0, 1), -1);
});

test('labels', () => {
    assert.equal(f.countLabel(0, 3), '1 of 3');
    assert.equal(f.countLabel(2, 3), '3 of 3');
    assert.equal(f.countLabel(-1, 0), 'No results');
});

test('200 lines: each has a hit and step from 199 goes to 0', () => {
    const texts = Array.from({ length: 200 }, (_, i) => `line ${i} has the Needle`);
    const hits = f.matchLines(texts, 'needle');
    assert.equal(hits.length, 200);
    assert.deepEqual(Array.from(hits), Array.from({ length: 200 }, (_, i) => i));
    assert.equal(f.step(199, 200, 1), 0);
    assert.equal(f.countLabel(199, 200), '200 of 200');
});
