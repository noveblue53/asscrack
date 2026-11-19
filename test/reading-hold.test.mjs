// The DOM part of src/application/reading.js with a small fake list: the find bar hold keeps the unread count and the
// marker, and restorePosition puts the list back. Each line is 20 px high, the viewport is 100 px.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/reading.js', import.meta.url), 'utf8');
const LINE = 20;

function fakeItem() {
    const classes = new Set();
    return {
        parentElement: null,
        offsetHeight: LINE,
        offsetTop: 0,
        classList: {
            add: c => classes.add(c),
            remove: c => classes.delete(c),
            contains: c => classes.has(c)
        }
    };
}

function load(count) {
    const children = [];
    let scrollTop = 0;
    const handlers = {};
    const list = {
        children,
        clientHeight: 100,
        get scrollHeight() { return children.length * LINE; },
        get scrollTop() { return scrollTop; },
        set scrollTop(v) { scrollTop = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
        addEventListener: (type, fn) => { handlers[type] = fn; }
    };
    const append = () => {
        const item = fakeItem();
        item.parentElement = list;
        item.offsetTop = children.length * LINE;
        children.push(item);
        return item;
    };
    for (let i = 0; i < count; i++) append();
    const button = { hidden: true, setAttribute() {}, addEventListener() {} };
    const countSpan = { textContent: '' };
    const document = { getElementById: id => ({ messages: list, 'jump-latest': button, 'unread-count': countSpan })[id] ?? null };
    const context = { window: {}, document, setTimeout, clearTimeout };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'reading.js' });
    const reading = context.window.reading;
    const scrollTo = top => {
        list.scrollTop = top;
        handlers.scroll();
    };
    const live = () => {
        const state = reading.beforeChange();
        const item = append();
        reading.noteIncoming(item);
        reading.afterChange(state);
        return item;
    };
    return { list, reading, children, scrollTo, live, countSpan };
}

test('the find hold keeps the unread count and the marker, and restorePosition goes back', () => {
    const { list, reading, children, scrollTo, live, countSpan } = load(50);
    scrollTo(400);
    assert.equal(reading.isFollowing(), false);
    const first = live();
    live();
    live();
    assert.equal(reading.unreadCount(), 3);
    assert.equal(first.classList.contains('unread-first'), true);
    assert.equal(list.scrollTop, 400);

    // Find opens, then it moves the list to the end (the last result).
    const saved = reading.savePosition();
    reading.setHold(true);
    scrollTo(list.scrollHeight);
    assert.equal(reading.unreadCount(), 3, 'a find scroll to the end does not clear the count');
    assert.equal(first.classList.contains('unread-first'), true, 'the marker stays');
    assert.equal(countSpan.textContent, '3');
    // A line that comes while the bar is open counts as unread. The list does not move.
    const at = list.scrollTop;
    live();
    assert.equal(reading.unreadCount(), 4);
    assert.equal(list.scrollTop, at);

    // Escape: the old position, the count and the marker stay.
    reading.restorePosition(saved);
    reading.setHold(false);
    scrollTo(list.scrollTop);
    assert.equal(list.scrollTop, 400);
    assert.equal(reading.isFollowing(), false);
    assert.equal(reading.unreadCount(), 4);
    assert.equal(first.classList.contains('unread-first'), true);
    assert.equal(children.filter(c => c.classList.contains('unread-first')).length, 1);

    // With no hold, a scroll to the end clears the count (the rule of milestone 1 stays).
    scrollTo(list.scrollHeight);
    assert.equal(reading.unreadCount(), 0);
    assert.equal(first.classList.contains('unread-first'), false);
});

test('restorePosition of a following list goes to the end and follows again', () => {
    const { list, reading, scrollTo, live } = load(30);
    scrollTo(list.scrollHeight);
    assert.equal(reading.isFollowing(), true);
    const saved = reading.savePosition();
    reading.setHold(true);
    assert.equal(reading.isFollowing(), false, 'the find bar owns the view while it is open');
    scrollTo(100);
    live();
    assert.equal(list.scrollTop, 100, 'a new line does not move the list away from the result');
    reading.restorePosition(saved);
    reading.setHold(false);
    assert.equal(reading.isFollowing(), true);
    assert.equal(list.scrollTop, list.scrollHeight - list.clientHeight);
});
