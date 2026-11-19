// Tests of quoteCore in src/application/quote.js: the quote format and its limits. The file loads in node:vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/quote.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'quote.js' });
const q = context.window.quoteCore;
// Arrays from the vm context have another Array.prototype. Compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));
const points = text => Array.from(text).length;

test('quote.js loads with no DOM and gives quoteCore', () => {
    assert.equal(typeof q, 'object');
    assert.equal(typeof q.compose, 'function');
});

test('compose gives the quotation lines, then the reply, in one plain text', () => {
    const quote = q.makeQuote({ from: 'Sam', clock: '14:05', text: 'hello there' });
    assert.equal(q.compose(quote, 'my reply'), '> Sam at 14:05, 1 line:\n> hello there\nmy reply');
    // No quote: the text as the user typed it (the 0.6.0 message, unchanged).
    assert.equal(q.compose(null, '  keep  my spaces '), '  keep  my spaces ');
});

test('a repeated name gets the peer tag of the quoted line, not of the other user', () => {
    const names = ['Me', 'Sam', 'Sam'];
    assert.equal(q.nameRepeats('Sam', names), true);
    assert.equal(q.nameRepeats('Me', names), false);
    const first = q.makeQuote({ from: 'Sam', peerId: '12D3KooWfirstAAAAaaaa11', repeats: true, clock: '09:00', text: 'a' });
    const second = q.makeQuote({ from: 'Sam', peerId: '12D3KooWsecondBBBBbbbb22', repeats: true, clock: '09:00', text: 'a' });
    assert.equal(q.headerText(first), 'Sam (aaaa11) at 09:00');
    assert.equal(q.headerText(second), 'Sam (bbbb22) at 09:00');
    // A name that does not repeat gets no tag. A history line has no peer ID: no tag.
    assert.equal(q.makeQuote({ from: 'Sam', peerId: '12D3KooWfirstAAAAaaaa11', repeats: false, clock: '09:00', text: 'a' }).tag, '');
    assert.equal(q.makeQuote({ from: 'Sam', peerId: null, repeats: true, clock: '09:00', text: 'a' }).tag, '');
});

test('the excerpt has at most 4 lines and 280 characters, with an ellipsis when cut', () => {
    const many = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    assert.deepEqual(plain(q.excerptOf(many)), ['line 0', 'line 1', 'line 2', 'line 3…']);
    const long = 'x'.repeat(1000);
    const cut = q.excerptOf(long);
    assert.equal(cut.length, 1);
    assert.equal(points(cut[0]), 281);
    assert.ok(cut[0].endsWith('…'));
    // The characters of all lines count together.
    const two = q.excerptOf(`${'a'.repeat(200)}\n${'b'.repeat(200)}`);
    assert.equal(points(two.join('')), 281);
    // A short text is not cut.
    assert.deepEqual(plain(q.excerptOf('short')), ['short']);
});

test('an emoji at the limit is not cut into two halves', () => {
    const text = `${'a'.repeat(279)}\u{1F600}\u{1F600}`;
    const [line] = q.excerptOf(text);
    assert.equal(line, `${'a'.repeat(279)}\u{1F600}…`);
    assert.doesNotMatch(line, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('multiline clipboard text: CR LF becomes LF in the excerpt and in the reply', () => {
    const quote = q.makeQuote({ from: 'Ann', clock: '7:30', text: 'one\r\ntwo\rthree\r\n\r\n  \r\nfour   ' });
    assert.deepEqual(plain(quote.lines), ['one', 'two', 'three', 'four']);
    const text = q.compose(quote, '\r\n\r\nfirst\r\nsecond\r\n\r\n');
    assert.equal(text, '> Ann at 7:30, 4 lines:\n> one\n> two\n> three\n> four\nfirst\nsecond');
    assert.doesNotMatch(text, /\r/);
});

test('a quote of a quote takes only the reply part', () => {
    const inner = q.compose(q.makeQuote({ from: 'Sam', clock: '10:00', text: 'old text' }), 'the answer');
    const outer = q.makeQuote({ from: 'Ann', clock: '10:01', text: inner });
    assert.deepEqual(plain(outer.lines), ['the answer']);
    // A message that is only a quotation: the excerpt is the quoted excerpt with no marks and no header.
    const only = q.makeQuote({ from: 'Ann', clock: '10:01', text: '> Sam at 10:00:\n> old text' });
    assert.deepEqual(plain(only.lines), ['old text']);
});

test('the name in the header is one line with no control characters, at most 48 characters', () => {
    assert.equal(q.cleanName('Bad\nName\u0007\tX'), 'Bad Name X');
    assert.equal(q.cleanName(''), '?');
    const long = q.cleanName('N'.repeat(100));
    assert.equal(points(long), 49);
    assert.ok(long.endsWith('…'));
});

test('the quotation part is bounded for any input', () => {
    const quote = q.makeQuote({
        from: '\u{1F600}'.repeat(500),
        peerId: '12D3KooW' + 'z'.repeat(60),
        repeats: true,
        clock: '23:59',
        text: Array.from({ length: 50 }, () => '\u{1F600}'.repeat(400)).join('\n')
    });
    const quotation = q.quotation(quote);
    assert.ok(points(quotation) <= q.MAX_QUOTATION, `${points(quotation)} > ${q.MAX_QUOTATION}`);
    assert.ok(q.MAX_QUOTATION < 400);
    // The reply is not cut: it is the text of the user.
    const reply = 'r'.repeat(5000);
    assert.ok(q.compose(quote, reply).endsWith(`\n${reply}`));
});

test('a bad clock gives 00:00, a missing text gives an ellipsis line', () => {
    const quote = q.makeQuote({ from: 'Sam', clock: 'soon', text: '   ' });
    assert.equal(quote.clock, '00:00');
    assert.equal(q.compose(quote, 'hi'), '> Sam at 00:00, 1 line:\n> …\nhi');
});

test('split finds the quotation at the start, and quote + rest is the full text', () => {
    const quote = q.makeQuote({ from: 'Sam', peerId: '12D3KooWabcdefAAAAaaaa11', repeats: true, clock: '14:05', text: 'a\nb\nc\nd\ne' });
    const text = q.compose(quote, 'reply\n> not a quote line');
    const parts = q.split(text);
    assert.equal(parts.quote, '> Sam (aaaa11) at 14:05, 4 lines:\n> a\n> b\n> c\n> d…\n');
    assert.equal(parts.rest, 'reply\n> not a quote line');
    assert.equal(parts.quote + parts.rest, text);
    assert.deepEqual(plain(q.parseHeader('> Sam (aaaa11) at 14:05, 4 lines:')), { from: 'Sam', tag: 'aaaa11', clock: '14:05' });
    // The header of the text from before the line count.
    assert.deepEqual(plain(q.parseHeader('> Sam (aaaa11) at 14:05:')), { from: 'Sam', tag: 'aaaa11', clock: '14:05' });
    // A name with " at " in it.
    assert.deepEqual(plain(q.parseHeader('> Bob at 10:00 at 14:05:')), { from: 'Bob at 10:00', tag: '', clock: '14:05' });
    // Text with no header: no quotation. A plain "> " line is not a quote.
    assert.equal(q.split('> just a line\nmore'), null);
    assert.equal(q.split('hello'), null);
    assert.equal(q.split(''), null);
});
