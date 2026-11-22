// Gap D2: the check of the main process before it opens a chat link (src/application/link-policy.mjs). Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinkPolicy, parseLink, MAX_LINK_LENGTH, LINK_INTERVAL_MS } from '../src/application/link-policy.mjs';

test('http and https URLs with a host pass, in the parsed form', () => {
    assert.deepEqual(parseLink('https://example.com/a(b)'), { ok: true, href: 'https://example.com/a(b)' });
    assert.deepEqual(parseLink('http://example.com'), { ok: true, href: 'http://example.com/' });
    assert.deepEqual(parseLink('HTTPS://EXAMPLE.com/X'), { ok: true, href: 'https://example.com/X' });
    assert.equal(parseLink('https://exаmple.com/').href.startsWith('https://xn--'), true);
});

test('other schemes, a user name, a password, an empty host, a long string and a value that is not a string do not pass', () => {
    for (const value of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'ftp://example.com/', 'data:text/html,x',
        'mailto:a@example.com', 'https://user@example.com/', 'https://:secret@example.com/', 'https://u:p@example.com/',
        'https://', 'http://', 'not a url', '', 'www.example.com']) {
        assert.equal(parseLink(value).ok, false, value);
    }
    for (const value of [null, undefined, 42, { href: 'https://example.com/' }, ['https://example.com/']]) {
        assert.equal(parseLink(value).ok, false, String(value));
    }
    const max = 'https://example.com/' + 'a'.repeat(MAX_LINK_LENGTH - 'https://example.com/'.length);
    assert.equal(max.length, 2048);
    assert.equal(parseLink(max).ok, true);
    assert.equal(parseLink(max + 'a').ok, false);
    assert.equal(parseLink('https://example.com/' + 'a'.repeat(3000)).ok, false);
});

test('at most one accepted link each 500 ms; a refused value does not start the interval', () => {
    let now = 1000;
    const policy = createLinkPolicy({ now: () => now });
    assert.equal(LINK_INTERVAL_MS, 500);
    assert.equal(policy.check('https://a.example/').ok, true);
    now += 499;
    const fast = policy.check('https://b.example/');
    assert.equal(fast.ok, false);
    assert.match(fast.reason, /500 ms/);
    now += 1;
    assert.equal(policy.check('https://c.example/').ok, true);
    now += 600;
    assert.equal(policy.check('javascript:alert(1)').ok, false);
    now += 1;
    assert.equal(policy.check('https://d.example/').ok, true, 'the refused value did not start an interval');
});
