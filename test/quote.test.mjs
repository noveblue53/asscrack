// Tests of quoteCore in src/application/quote.js. The file loads in node:vm with no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/quote.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'quote.js' });
const q = context.window.quoteCore;

test('format: the quote line, one LF, then the reply', () => {
    assert.equal(q.formatQuote('Alice', 'first words', 'the reply'), '> Alice: first words\nthe reply');
    assert.equal(q.QUOTE_PREFIX, '> ');
    assert.equal(q.EXCERPT_MAX, 120);
    assert.equal(q.AUTHOR_MAX, 40);
});

test('caps: excerpt 120 and author 40 code points with an ellipsis', () => {
    const long = 'a'.repeat(300);
    const ex = q.makeExcerpt(long);
    assert.equal(Array.from(ex).length, 120);
    assert.ok(ex.endsWith('…'));
    assert.equal(q.makeExcerpt('a'.repeat(120)), 'a'.repeat(120));
    const name = q.clip('n'.repeat(50), q.AUTHOR_MAX);
    assert.equal(Array.from(name).length, 40);
    assert.ok(name.endsWith('…'));
    const line = q.formatQuote('n'.repeat(50), long, 'r').split('\n')[0];
    assert.ok(line.length <= 170);
});

test('surrogate pairs are never split', () => {
    const emoji = '\u{1F600}'.repeat(200);
    const ex = q.makeExcerpt(emoji);
    assert.equal(Array.from(ex).length, 120);
    assert.equal(ex, '\u{1F600}'.repeat(119) + '…');
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(ex));
    assert.equal(q.clip('x' + '\u{1F600}'.repeat(10), 5), 'x\u{1F600}\u{1F600}\u{1F600}…');
});

test('multiline clipboard text becomes one excerpt line, the reply keeps its lines', () => {
    const original = '  line one\r\n\tline two\n\n line three  ';
    const out = q.formatQuote('Bob', original, 'reply 1\nreply 2');
    assert.equal(out, '> Bob: line one line two line three\nreply 1\nreply 2');
    assert.equal(out.split('\n').length, 3);
    assert.deepEqual({ ...q.parseQuote(out) }, { author: 'Bob', excerpt: 'line one line two line three', reply: 'reply 1\nreply 2' });
});

test('nested quote: the excerpt is the reply part of the quoted line', () => {
    const first = q.formatQuote('Alice', 'hello all', 'hi Alice');
    const second = q.formatQuote('Bob', first, 'and hi Bob');
    assert.equal(second, '> Bob: hi Alice\nand hi Bob');
    assert.equal(q.parseQuote('plain text'), null);
    assert.equal(q.parseQuote('> no separator\nx'), null);
    assert.equal(q.makeExcerpt('> no separator'), '> no separator');
});

test('duplicate names: label with the last 4 characters of the peer ID', () => {
    assert.equal(q.authorLabel('Alice', '12D3KooWabcd', 1), 'Alice');
    assert.equal(q.authorLabel('Alice', '12D3KooWabcd', 2), 'Alice (abcd)');
    assert.equal(q.authorLabel('Alice', 'abc', 2), 'Alice');
    assert.equal(q.authorLabel('Alice', undefined, 3), 'Alice');
    const label = q.authorLabel('Alice', '12D3KooWabcd', 2);
    assert.equal(q.formatQuote(label, 'x', 'y'), '> Alice (abcd): x\ny');
});

test('cancel: no quote gives the plain reply unchanged', () => {
    assert.equal(q.composeText(null, '  reply\ntext '), '  reply\ntext ');
    assert.equal(q.composeText({ label: 'Alice', text: 'hi' }, 'yo'), '> Alice: hi\nyo');
});

test('duplicate names: a long name keeps its peer tag in the quote line', () => {
    const label = q.authorLabel('N'.repeat(60), '12D3KooWabcdWXYZ', 2);
    assert.ok(label.endsWith(' (WXYZ)'));
    assert.ok(Array.from(label).length <= q.AUTHOR_MAX);
    const text = q.formatQuote(label, 'hello', 'reply');
    assert.ok(text.split('\n')[0].includes(' (WXYZ): hello'));
});
