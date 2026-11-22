// Gap D2: links in chat lines. The pure part (window.chatLinksCore.linkRanges) and the DOM part (window.chatLinks.apply)
// of src/application/chat-links.js run in node:vm. The window tests use test/helpers/renderer-fixture.mjs. No Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom } from './helpers/fake-dom.mjs';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const source = await readFile(new URL('../src/application/chat-links.js', import.meta.url), 'utf8');

function loadCore() {
    const window = {};
    vm.runInNewContext(source, { window, URL }, { filename: 'chat-links.js' });
    return window.chatLinksCore;
}

function loadDom(layout = []) {
    const { document, window, Event } = createDom(layout);
    const opened = [];
    window.asscrack = { openLink: async href => { opened.push(href); return true; } };
    vm.runInNewContext(source, { window, document, URL, Promise, console }, { filename: 'chat-links.js' });
    return { document, window, Event, opened };
}

// Array.from: the arrays of the vm realm become arrays of this realm for deepEqual.
const hrefs = (text, core = loadCore()) => Array.from(core.linkRanges(text), r => r.href);

test('linkRanges cuts the punctuation at the end and keeps the start and end offsets of the text', () => {
    const core = loadCore();
    const text = 'see https://example.com/a. and http://x.org/b?q=1!, ok';
    const ranges = Array.from(core.linkRanges(text));
    assert.deepEqual(ranges.map(r => r.href), ['https://example.com/a', 'http://x.org/b?q=1']);
    for (const r of ranges) assert.equal(text.slice(r.start, r.end), r.href);
    assert.deepEqual(hrefs('end https://example.com/path;:?!.', core), ['https://example.com/path']);
});

test('linkRanges keeps a closing bracket that has an opening bracket in the URL, and cuts one that has none', () => {
    const core = loadCore();
    assert.deepEqual(hrefs('see https://example.com/a(b). ok', core), ['https://example.com/a(b)']);
    assert.deepEqual(hrefs('(see https://example.com/x)', core), ['https://example.com/x']);
    assert.deepEqual(hrefs('[https://example.com/y].', core), ['https://example.com/y']);
    assert.deepEqual(hrefs('{https://example.com/z}', core), ['https://example.com/z']);
    assert.deepEqual(hrefs('https://en.wikipedia.org/wiki/Foo_(bar)', core), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
});

test('linkRanges finds two links in one line, and a link in a quotation', () => {
    const core = loadCore();
    assert.deepEqual(hrefs('https://a.example/1 https://b.example/2', core), ['https://a.example/1', 'https://b.example/2']);
    assert.deepEqual(hrefs('> Alice at 10:00: look https://example.com/q\nyes', core), ['https://example.com/q']);
    assert.deepEqual(hrefs('HTTPS://EXAMPLE.COM/Up', core), ['HTTPS://EXAMPLE.COM/Up']);
});

test('linkRanges gives no range for other schemes, a bare www, a URL with no host, or a URL longer than 2048', () => {
    const core = loadCore();
    for (const text of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'file://server/share', 'www.example.com',
        'ftp://example.com/x', 'https://', 'http://', 'xhttp://example.com', 'data:text/html,<b>x</b>']) {
        assert.equal(core.linkRanges(text).length, 0, text);
    }
    // A javascript: text after an http URL does not make the http URL a javascript link.
    assert.deepEqual(hrefs('javascript:void(0) https://ok.example/', core), ['https://ok.example/']);
    const long = 'https://example.com/' + 'a'.repeat(3000 - 'https://example.com/'.length);
    assert.equal(long.length, 3000);
    assert.equal(core.linkRanges(`see ${long} ok`).length, 0);
    const max = 'https://example.com/' + 'b'.repeat(core.MAX_LINK - 'https://example.com/'.length);
    assert.deepEqual(hrefs(max, core), [max]);
});

test('apply puts each part of a URL in a.chat-link with the full URL, keeps textContent, and a second call changes nothing', () => {
    const { document } = loadDom();
    const span = document.createElement('span');
    const mark = document.createElement('mark');
    mark.textContent = 'alice';
    // "see https://example.com/<mark>alice</mark>/page. ok": the highlight is inside the URL.
    span.append('see https://example.com/', mark, '/page. ok');
    const before = span.textContent;
    document.defaultView.chatLinks.apply(span);
    assert.equal(span.textContent, before);
    const links = span.querySelectorAll('a.chat-link');
    assert.equal(links.length, 3);
    for (const a of links) {
        assert.equal(a.getAttribute('href'), 'https://example.com/alice/page');
        assert.equal(a.getAttribute('title'), 'https://example.com/alice/page');
        assert.equal(a.getAttribute('rel'), 'noreferrer');
    }
    assert.equal(links.map(a => a.textContent).join(''), 'https://example.com/alice/page');
    assert.equal(links[1].parentElement, mark, 'the part in the highlight is a link inside the mark');
    const shape = JSON.stringify(span.childNodes.map(n => n.textContent));
    document.defaultView.chatLinks.apply(span);
    assert.equal(span.querySelectorAll('a.chat-link').length, 3);
    assert.equal(JSON.stringify(span.childNodes.map(n => n.textContent)), shape);
});

test('the title shows the parsed host, thus a look-alike host shows as xn--', () => {
    const { document } = loadDom();
    const span = document.createElement('span');
    span.textContent = 'https://exаmple.com/';
    document.defaultView.chatLinks.apply(span);
    const link = span.querySelector('a.chat-link');
    assert.equal(link.getAttribute('href'), 'https://exаmple.com/');
    assert.match(link.getAttribute('title'), /^https:\/\/xn--/);
});

test('a click on a link of #messages or #whisper-lines is prevented and asks the main process to open the URL', async () => {
    const { document, Event, opened } = loadDom([{ id: 'messages', tag: 'ul' }, { id: 'whisper-lines', tag: 'ul' }]);
    for (const id of ['messages', 'whisper-lines']) {
        const li = document.createElement('li');
        li.textContent = `go https://example.com/${id}`;
        document.getElementById(id).append(li);
        document.defaultView.chatLinks.apply(li, { focusable: id === 'whisper-lines' });
        assert.equal(li.querySelector('a.chat-link').tabIndex, id === 'whisper-lines' ? 0 : -1, id);
        const event = new Event('click');
        li.querySelector('a.chat-link').dispatchEvent(event);
        assert.equal(event.defaultPrevented, true, id);
    }
    // A click on the text that is not a link does nothing.
    const plain = new Event('click');
    document.getElementById('messages').children[0].dispatchEvent(plain);
    assert.equal(plain.defaultPrevented, false);
    await settle();
    assert.deepEqual(opened, ['https://example.com/messages', 'https://example.com/whisper-lines']);
});

test('room window: a live line, a quoted line and a highlighted line each get the link of the full URL', async () => {
    const room = await loadRoomWindow();
    await room.login('alice');
    const opened = [];
    room.window.asscrack.openLink = async href => { opened.push(href); return true; };
    const plain = room.receive({ from: 'bob', text: 'see https://example.com/a(b). ok', peerId: 'peer-bob', id: 'm1' });
    const link = plain.querySelector('a.chat-link');
    assert.equal(link.getAttribute('href'), 'https://example.com/a(b)');
    assert.equal(plain.querySelector('.text').textContent, 'see https://example.com/a(b). ok');
    // The own name "alice" is a highlight inside the URL: the highlight and the link are both there.
    const marked = room.receive({ from: 'bob', text: 'https://example.com/alice/x', peerId: 'peer-bob', id: 'm2' });
    assert.ok(marked.querySelector('mark.nick-highlight'), 'the line has a highlight');
    const parts = marked.querySelectorAll('a.chat-link');
    assert.ok(parts.length >= 2);
    for (const a of parts) assert.equal(a.getAttribute('href'), 'https://example.com/alice/x');
    const quoted = room.receive({ from: 'bob', text: '> carol at 09:00, 1 line:\n> look https://example.com/q\nthanks', peerId: 'peer-bob', id: 'm3' });
    assert.equal(quoted.querySelector('.quote')?.querySelector('a.chat-link').getAttribute('href'), 'https://example.com/q');
    const event = new room.Event('click');
    parts[0].dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await settle();
    assert.deepEqual(opened, ['https://example.com/alice/x']);
    // The keyboard: a chat link is not a tab stop; the row menu has "Open link" (the first link of the row).
    assert.equal(link.tabIndex, -1);
    const info = room.window.roomActions.rowInfo(plain);
    assert.equal(info.link, true);
    assert.ok([...room.window.menuCore.actionsFor(info)].includes('open-link'));
    assert.equal(room.window.menuCore.label('open-link'), 'Open link');
    assert.equal(room.window.roomActions.run('open-link', plain), true);
    await settle();
    assert.deepEqual(opened, ['https://example.com/alice/x', 'https://example.com/a(b)']);
    const none = room.receive({ from: 'bob', text: 'no link here', peerId: 'peer-bob', id: 'm4' });
    assert.equal([...room.window.menuCore.actionsFor(room.window.roomActions.rowInfo(none))].includes('open-link'), false);
    assert.deepEqual(room.errors, []);
});
