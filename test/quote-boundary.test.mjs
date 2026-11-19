// The boundary between the quoted excerpt and the reply (milestone 2 fix). A reply line that starts with "> " is the
// words of the replier, not a line of the excerpt. Tests of the real formatter and parser (quote.js), then of the
// real rendering in renderer.js with the fake DOM (test/helpers/renderer-fixture.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const source = await readFile(new URL('../src/application/quote.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'quote.js' });
const q = context.window.quoteCore;
const plain = value => JSON.parse(JSON.stringify(value));

const SAM = '12D3KooWsamAAAAAAaaaa01';
const REPLY = '> these are my words\nand this is my second line';

test('a reply that starts with "> " stays out of a one-line excerpt', () => {
    const quote = q.makeQuote({ from: 'Sam', clock: '14:05', text: 'old line' });
    const text = q.compose(quote, REPLY);
    assert.equal(text, `> Sam at 14:05, 1 line:\n> old line\n${REPLY}`);
    const parts = q.split(text);
    assert.equal(parts.quote, '> Sam at 14:05, 1 line:\n> old line\n');
    assert.equal(parts.rest, REPLY);
    assert.equal(parts.quote + parts.rest, text);
});

test('the header count gives the exact excerpt lines, also for 4 lines and two "> " reply lines', () => {
    const quote = q.makeQuote({ from: 'Sam', clock: '9:00', text: 'a\nb\nc\nd\ne' });
    const reply = '> first\n> second\nthird';
    const text = q.compose(quote, reply);
    const parts = q.split(text);
    assert.equal(parts.quote, '> Sam at 9:00, 4 lines:\n> a\n> b\n> c\n> d…\n');
    assert.equal(parts.rest, reply);
    // A quote of that message takes the reply, with its "> " lines, as the excerpt.
    const again = q.makeQuote({ from: 'Ann', clock: '9:01', text });
    assert.deepEqual(plain(again.lines), ['> first', '> second', 'third']);
    const nested = q.compose(again, 'ok');
    assert.equal(nested, '> Ann at 9:01, 3 lines:\n> > first\n> > second\n> third\nok');
    assert.equal(q.split(nested).rest, 'ok');
});

test('a header with a count but missing excerpt lines is not a quotation', () => {
    assert.equal(q.split('> Sam at 14:05, 2 lines:\n> only one\nreply'), null);
    assert.equal(q.split('> Sam at 14:05, 1 line:\nno mark'), null);
});

test('stored 0.6.0-era text: one excerpt line before a plain reply is still a quote', () => {
    const text = '> Sam at 14:05:\n> old line\nmy reply';
    const parts = q.split(text);
    assert.equal(parts.quote, '> Sam at 14:05:\n> old line\n');
    assert.equal(parts.rest, 'my reply');
});

test('stored text with two possible boundaries is not a quote: no line goes to an author', () => {
    // Before the fix the excerpt could have 1 to 4 lines and the reply could start with "> ".
    assert.equal(q.split(`> Sam at 14:05:\n> old line\n${REPLY}`), null);
    assert.equal(q.split('> Sam at 14:05:\n> a\n> b\n> c\n> d\n> e\nreply'), null);
    // An ordinary message that starts with "> " stays plain text.
    assert.equal(q.split('> just a line\nmore'), null);
    // A quote of such a message takes all of its text, with no author for the disputed lines.
    const quote = q.makeQuote({ from: 'Ann', clock: '10:00', text: `> Sam at 14:05:\n> old line\n${REPLY}` });
    assert.deepEqual(plain(quote.lines), ['> Sam at 14:05:', '> old line', '> these are my words', 'and this is my second line']);
});

async function roomWithSam() {
    const f = await loadRoomWindow();
    await f.login('Me');
    f.handlers.onPeerJoined({ peerId: SAM });
    f.handlers.onPeerName({ peerId: SAM, name: 'Sam' });
    return f;
}

// The parts of a rendered chat line: the text of the quotation block, the text after it, the whole text.
function rendered(row) {
    const text = row.querySelector('.text');
    const block = text.querySelector('.quote');
    const outside = text.childNodes.filter(n => n !== block).map(n => n.textContent).join('');
    return { block: block ? block.textContent : null, lines: text.querySelectorAll('.quote-line').length, outside, all: text.textContent };
}

test('the rendered quotation block has only the words of Sam; the reply keeps its "> " outside it', async () => {
    const f = await roomWithSam();
    const original = f.receive({ from: 'Sam', text: 'old line', peerId: SAM, id: 'm1' });
    original.querySelector('.btn-quote').click();
    f.el('message-input').value = REPLY;
    f.el('send').click();
    await settle();
    const own = f.rows()[f.rows().length - 1];
    assert.ok(own.classList.contains('own'));
    const view = rendered(own);
    assert.match(view.block, /^> Sam at \d{1,2}:\d{2}, 1 line:\n> old line\n$/);
    assert.equal(view.lines, 1);
    assert.equal(view.outside, REPLY);
    // Copy of the whole row gives the message text as it was sent.
    const sent = view.all;
    assert.equal(sent, `${view.block}${REPLY}`);
    f.window.roomActions.run('copy-message', own);
    await settle();
    assert.equal(f.calls.find(c => c.name === 'copyText').args[0], sent);
    // A quote of the reply: the excerpt has the two lines of the replier, then the new quotation has its own block.
    own.querySelector('.btn-quote').click();
    assert.equal(f.chip().excerpt, REPLY);
    f.el('message-input').value = '> agree\n> fully';
    f.el('send').click();
    await settle();
    const second = rendered(f.rows()[f.rows().length - 1]);
    assert.match(second.block, /^> Me \(you\)|^> Me at/);
    assert.equal(second.lines, 2);
    assert.ok(second.block.endsWith('> > these are my words\n> and this is my second line\n'));
    assert.equal(second.outside, '> agree\n> fully');
    assert.deepEqual(f.errors, []);
});

test('a stored message with two possible boundaries shows its text with no quotation block', async () => {
    const f = await roomWithSam();
    const text = `> Sam at 14:05:\n> old line\n${REPLY}`;
    f.history([{ id: 'h1', from: 'Ann', text, time: Date.now() - 60000 }]);
    const row = f.rows().find(r => r.dataset.id === 'h1');
    const view = rendered(row);
    assert.equal(view.block, null);
    assert.equal(view.all, text);
    // A stored quote with one excerpt line and a plain reply keeps its block.
    f.history([{ id: 'h2', from: 'Ann', text: '> Sam at 14:05:\n> old line\nmy reply', time: Date.now() - 50000 }]);
    const old = rendered(f.rows().find(r => r.dataset.id === 'h2'));
    assert.equal(old.block, '> Sam at 14:05:\n> old line\n');
    assert.equal(old.outside, 'my reply');
});
