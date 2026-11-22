// Find and the unread marker (workplan P2, docs/WORK_PLAN_1.0.md milestone 2A). The real room window scripts load in
// node:vm (renderer-fixture.mjs). The list #messages gets a small layout: each line has the same height, the viewport
// is 100 px. Chromium can post the scroll event of a scrollTop change after close() returned. The tests dispatch that
// late scroll event after Escape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const VIEW = 100;

// Give the list and its lines a layout of `line` px for each line. scrollTop stays in the scroll range.
function addLayout(list, line) {
    let top = 0;
    const place = node => {
        Object.defineProperty(node, 'offsetTop', { configurable: true, get: () => Math.max(0, list.children.indexOf(node)) * line });
        Object.defineProperty(node, 'offsetHeight', { configurable: true, get: () => line });
    };
    for (const node of list.children) place(node);
    const insert = list.insertBefore.bind(list);
    list.insertBefore = (node, ref) => {
        const out = insert(node, ref);
        if (out && out.nodeType === 1) place(out);
        return out;
    };
    list.clientHeight = VIEW;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => list.children.length * line });
    Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: v => { top = Math.max(0, Math.min(Number(v) || 0, list.scrollHeight - list.clientHeight)); }
    });
}

async function room(line, count) {
    const f = await loadRoomWindow();
    await f.login('Reader');
    const list = f.el('messages');
    addLayout(list, line);
    f.el('find-input').select = () => {}; // The fixture has no native text selection.
    let n = 0;
    const receive = () => {
        n++;
        return f.receive({ id: `m${n}`, from: 'Other', text: `line ${n}`, peerId: 'other-peer', time: 1000 + n });
    };
    for (let i = 0; i < count; i++) receive();
    const scroll = top => {
        if (top !== undefined) list.scrollTop = top;
        list.dispatchEvent(new f.Event('scroll'));
    };
    const markers = () => Array.from(list.children).filter(li => li.classList.contains('unread-first'));
    return { f, list, receive, scroll, markers, reading: f.window.reading };
}

// Open Find, let the find bar move the list (findTop), add one line, close with Escape, then the late scroll event.
async function findAndEscape(r, findTop) {
    const { f, list, receive, scroll } = r;
    f.el('message-input').focus();
    assert.equal(f.window.findBar.open(), true);
    if (findTop !== undefined) scroll(findTop);
    const fresh = receive();
    assert.ok(fresh, 'the new line is in the list');
    assert.equal(r.reading.unreadCount(), 1, 'a line that comes while Find is open is unread');
    const escape = f.key(f.el('find-input'), 'Escape');
    assert.equal(escape.defaultPrevented, true);
    assert.equal(f.window.findBar.isOpen(), false);
    const afterEscape = list.scrollTop;
    // The late scroll event: Chromium posts it after close() returned, thus after the hold ended.
    scroll();
    await settle();
    return { fresh, afterEscape };
}

for (const line of [30, 20]) {
    test(`at the end (${line} px lines): Escape goes back to the old last line and the new line stays unread`, async () => {
        const r = await room(line, 10);
        const { list, markers, reading, f } = r;
        // The list has a day row before the first line (gap D6). It is a row of the layout too.
        const end = list.children.length * line - VIEW;
        assert.equal(list.scrollTop, end);
        assert.equal(reading.isFollowing(), true);
        const { fresh, afterEscape } = await findAndEscape(r);
        assert.equal(afterEscape, end, 'after Escape the list shows the position before Find opened');
        assert.equal(list.scrollTop, end, 'the late scroll does not move the list');
        assert.equal(reading.isFollowing(), false, 'a list with an unread line below does not follow');
        assert.equal(reading.unreadCount(), 1, 'the new line stays unread after the late scroll');
        assert.deepEqual(markers(), [fresh], 'the unread marker is before the new line');
        assert.equal(f.el('unread-count').textContent, '1');
        assert.equal(f.el('jump-latest').hidden, false);
        // The user scrolls to the end by hand: then the line is read (milestone 1).
        r.scroll(list.scrollHeight);
        assert.equal(reading.unreadCount(), 0);
        assert.deepEqual(markers(), []);
        assert.equal(reading.isFollowing(), true);
    });
}

test('at the end: Find moves the list to a result, then Escape goes back to the old last line', async () => {
    const r = await room(30, 10);
    const { list, markers, reading } = r;
    const end = list.children.length * 30 - VIEW;
    const { fresh, afterEscape } = await findAndEscape(r, 30);
    assert.equal(afterEscape, end);
    assert.equal(list.scrollTop, end);
    assert.equal(reading.isFollowing(), false);
    assert.equal(reading.unreadCount(), 1);
    assert.deepEqual(markers(), [fresh]);
});

test('at the end with no new line: Escape goes back to the end and the list follows again', async () => {
    const r = await room(30, 10);
    const { f, list, reading, scroll, receive } = r;
    // The 10 lines and the day row before the first line (gap D6).
    const rows = list.children.length;
    f.el('message-input').focus();
    assert.equal(f.window.findBar.open(), true);
    scroll(30);
    f.key(f.el('find-input'), 'Escape');
    scroll();
    await settle();
    assert.equal(list.scrollTop, rows * 30 - VIEW);
    assert.equal(reading.isFollowing(), true);
    assert.equal(reading.unreadCount(), 0);
    receive();
    assert.equal(list.scrollTop, (rows + 1) * 30 - VIEW, 'a following list shows the next line');
    assert.equal(reading.unreadCount(), 0);
});

test('not at the end: Escape goes back to the old position and the new line stays unread', async () => {
    const r = await room(30, 20);
    const { list, markers, reading, scroll } = r;
    scroll(120);
    assert.equal(reading.isFollowing(), false);
    const { fresh, afterEscape } = await findAndEscape(r, 0);
    assert.equal(afterEscape, 120);
    assert.equal(list.scrollTop, 120);
    assert.equal(reading.isFollowing(), false);
    assert.equal(reading.unreadCount(), 1);
    assert.deepEqual(markers(), [fresh]);
});
