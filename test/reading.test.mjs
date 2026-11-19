// Tests of readingCore in src/application/reading.js. The file loads in node:vm with no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/reading.js', import.meta.url), 'utf8');

function loadCore() {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'reading.js' });
    return context.window.readingCore;
}

const core = loadCore();

// Lines of 20 px with a gap of 6 px, like the list.
function layout(count, height = 20, gap = 6) {
    return Array.from({ length: count }, (_, i) => ({ top: i * (height + gap), height }));
}

test('reading.js loads with no DOM and gives no window.reading', () => {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(source, context);
    assert.equal(typeof context.window.readingCore, 'object');
    assert.equal(context.window.reading, undefined);
});

test('anchor is the first visible line with its offset', () => {
    const lines = layout(50);
    // scrollTop 100: line 3 is 78..98 (above), line 4 is 104..124 (first visible, offset 4).
    assert.deepEqual({ ...core.chooseAnchor(lines, 100) }, { index: 4, offset: 4 });
    // A line that is partly visible is the anchor, with a negative offset.
    assert.deepEqual({ ...core.chooseAnchor(lines, 110) }, { index: 4, offset: -6 });
    assert.deepEqual({ ...core.chooseAnchor(lines, 0) }, { index: 0, offset: 0 });
    assert.equal(core.chooseAnchor([], 0), null);
});

test('scrolled back 20 lines, 3 live lines and an older history insert keep the anchor', () => {
    const step = 26;
    let lines = layout(60);
    const clientHeight = 200;
    const scrollHeight = lines.length * step;
    let scrollTop = scrollHeight - clientHeight - 20 * step;
    assert.equal(core.isAtEnd(scrollHeight, scrollTop, clientHeight), false);
    const anchor = core.chooseAnchor(lines, scrollTop);
    const unread = core.createUnread();
    // 3 live lines at the end: the anchor does not move, the count is 3.
    for (const key of ['a', 'b', 'c']) unread.note(key);
    lines = layout(63);
    scrollTop = core.restoreScrollTop(scrollTop, lines[anchor.index].top, anchor.offset);
    assert.equal(lines[anchor.index].top - scrollTop, anchor.offset);
    // A history insert of 2 older lines at the start: the anchor line is now 2 lines lower in the list.
    const newIndex = anchor.index + 2;
    lines = layout(65);
    scrollTop = core.restoreScrollTop(scrollTop, lines[newIndex].top, anchor.offset);
    assert.ok(Math.abs((lines[newIndex].top - scrollTop) - anchor.offset) <= 2);
    assert.equal(unread.count, 3);
});

test('restore is a change from the current position', () => {
    // The browser moved the list already: the anchor is at its old offset, so no change.
    assert.equal(core.restoreScrollTop(500, 510, 10), 500);
    // The anchor moved down 40 px: scroll down 40 px.
    assert.equal(core.restoreScrollTop(500, 550, 10), 540);
    // The anchor moved up 20 px: scroll up 20 px.
    assert.equal(core.restoreScrollTop(500, 490, 10), 480);
});

test('fallback when the anchor line is removed: next line below, else the line above', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const alive = gone => key => !gone.includes(key);
    assert.equal(core.survivorIndex(keys, 2, alive([])), 2);
    assert.equal(core.survivorIndex(keys, 2, alive(['c'])), 3);
    assert.equal(core.survivorIndex(keys, 2, alive(['c', 'd'])), 4);
    assert.equal(core.survivorIndex(keys, 2, alive(['c', 'd', 'e'])), 1);
    assert.equal(core.survivorIndex(keys, 2, alive(['b', 'c', 'd', 'e'])), 0);
    assert.equal(core.survivorIndex(keys, 2, alive(keys)), -1);
    assert.equal(core.survivorIndex(keys, -1, alive([])), -1);
});

test('equal timestamps keep the arrival sequence', () => {
    const times = [100, 200, 200, 300];
    // A line with time 200 goes after the last 200 line, before 300.
    assert.equal(core.insertIndex(times, 200), 3);
    assert.equal(core.insertIndex(times, 50), 0);
    assert.equal(core.insertIndex(times, 400), 4);
    assert.equal(core.insertIndex(times.map(String), 200), 3);
    // The anchor is chosen by position, not by time: equal times give different anchors.
    const lines = layout(4);
    assert.equal(core.chooseAnchor(lines, 30).index, 1);
    assert.equal(core.chooseAnchor(lines, 50).index, 2);
});

test('each unread line counts one time and the first one is the marker', () => {
    const unread = core.createUnread();
    assert.equal(unread.note('x'), true);
    assert.equal(unread.note('y'), true);
    assert.equal(unread.note('x'), false);
    assert.equal(unread.count, 2);
    assert.equal(unread.first, 'x');
});

test('jump to latest clears the count and the marker', () => {
    const unread = core.createUnread();
    for (const key of ['a', 'b', 'c']) unread.note(key);
    assert.equal(unread.count, 3);
    unread.clear();
    assert.equal(unread.count, 0);
    assert.equal(unread.first, null);
    // After the clear, a new line counts again and is the new marker.
    assert.equal(unread.note('d'), true);
    assert.equal(unread.first, 'd');
});

test('a history replay of shown lines adds no line and no unread', () => {
    const shown = new Set(['1', '2', '3']);
    const unread = core.createUnread();
    unread.note('3');
    const replay = [
        { id: '2', from: 'a', text: 'two', time: 20 },
        { id: '1', from: 'a', text: 'one', time: 10 },
        { id: '3', from: 'b', text: 'three', time: 30 }
    ];
    assert.equal(core.newHistoryLines(replay, id => shown.has(id)).length, 0);
    assert.equal(unread.count, 1);
});

test('history lines: duplicates in a batch go out, the rest is sorted by time, stable', () => {
    const out = core.newHistoryLines([
        { id: 'c', time: 30 },
        { id: 'a', time: 10 },
        { id: 'b1', time: 20 },
        { id: 'a', time: 10 },
        { id: 'b2', time: 20 },
        { id: 'old', time: 5 }
    ], id => id === 'old');
    assert.deepEqual(Array.from(out, m => m.id), ['a', 'b1', 'b2', 'c']);
    assert.equal(core.newHistoryLines(undefined, () => false).length, 0);
});

test('at end uses a 24 px limit', () => {
    assert.equal(core.isAtEnd(1000, 777, 200), true);
    assert.equal(core.isAtEnd(1000, 776, 200), false);
});
