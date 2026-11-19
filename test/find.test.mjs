// Tests of findCore in src/application/find.js: the matcher of the find bar. The file loads in node:vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/find.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'find.js' });
const f = context.window.findCore;
const plain = value => JSON.parse(JSON.stringify(value));

test('find.js loads with no DOM and gives findCore only', () => {
    assert.equal(typeof f, 'object');
    assert.equal(context.window.findBar, undefined);
});

test('findAll finds each result, with no case, in list sequence, with no overlap', () => {
    const { results, capped } = f.findAll(['Hello hello', 'none', 'HELLO'], 'hello');
    assert.equal(capped, false);
    assert.deepEqual(plain(results), [
        { line: 0, start: 0, end: 5 },
        { line: 0, start: 6, end: 11 },
        { line: 2, start: 0, end: 5 }
    ]);
    assert.deepEqual(plain(f.findAll(['aaaa'], 'aa').results), [{ line: 0, start: 0, end: 2 }, { line: 0, start: 2, end: 4 }]);
});

test('an empty query gives no result, a space is a query', () => {
    assert.equal(f.findAll(['abc'], '').results.length, 0);
    assert.equal(f.findAll(['a b'], ' ').results.length, 1);
});

test('the indexes are indexes of the original text when lower case changes the length', () => {
    // "İ" (U+0130) gives two characters in lower case.
    const text = 'İİ Needle';
    const [result] = f.findAll([text], 'needle').results;
    assert.equal(text.slice(result.start, result.end), 'Needle');
    const emoji = '\u{1F600} x';
    const [hit] = f.findAll([emoji], 'x').results;
    assert.equal(emoji.slice(hit.start, hit.end), 'x');
});

test('multiline text and quotation marks are searched as text', () => {
    const text = '> Sam at 14:05:\n> old line\nnew reply';
    const results = f.findAll([text], 'line\nnew').results;
    assert.equal(results.length, 1);
    assert.equal(text.slice(results[0].start, results[0].end), 'line\nnew');
});

test('200 loaded lines: all results, the count text, next and previous with wrap', () => {
    const lines = Array.from({ length: 200 }, (_, i) => (i % 20 === 7 ? `line ${i} has the Needle` : `line ${i} plain`));
    const t0 = Date.now();
    const { results, capped } = f.findAll(lines, 'needle');
    const ms = Date.now() - t0;
    assert.equal(capped, false);
    assert.equal(results.length, 10);
    assert.deepEqual(plain(results.map(r => r.line)), [7, 27, 47, 67, 87, 107, 127, 147, 167, 187]);
    assert.ok(ms < 200, `${ms} ms`);
    // The search starts at the first visible line (line 100): the result in line 107.
    const start = f.startIndex(results, 100);
    assert.equal(start, 5);
    assert.equal(f.countText(start, results.length, false, 'needle'), '6 of 10');
    assert.equal(f.step(start, results.length, 1), 6);
    assert.equal(f.step(start, results.length, -1), 4);
    assert.equal(f.step(9, results.length, 1), 0);
    assert.equal(f.step(0, results.length, -1), 9);
    // Below the last result: the last result.
    assert.equal(f.startIndex(results, 199), 9);
    assert.equal(f.startIndex([], 0), -1);
    assert.equal(f.step(-1, 0, 1), -1);
});

test('the count text: empty query, no result, capped', () => {
    assert.equal(f.countText(-1, 0, false, ''), '');
    assert.equal(f.countText(-1, 0, false, 'zzz'), 'No results');
    assert.equal(f.countText(0, 1000, true, 'a'), '1 of 1000+');
});

test('findAll stops at the cap', () => {
    const lines = Array.from({ length: 200 }, () => 'a'.repeat(100));
    const { results, capped } = f.findAll(lines, 'a');
    assert.equal(results.length, f.MAX_RESULTS);
    assert.equal(capped, true);
});

test('sameResult compares the line key and the position', () => {
    const row = {};
    assert.equal(f.sameResult({ key: row, start: 1, end: 3 }, { key: row, start: 1, end: 3 }), true);
    assert.equal(f.sameResult({ key: row, start: 1, end: 3 }, { key: {}, start: 1, end: 3 }), false);
    assert.equal(f.sameResult(null, { key: row, start: 1, end: 3 }), false);
});
