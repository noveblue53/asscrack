// Find in the loaded conversation text (#messages). Classic script. It loads after reading.js.
// window.findCore: pure functions with no DOM. test/find.test.mjs loads this file with node:vm and calls them.
// window.findBar: { isOpen(), open(), close() }. The one Escape dispatcher of renderer.js calls isOpen() and
//   close(). This file does not handle Escape itself.
//
// Ctrl+F opens the find bar. Enter or F3: next result. Shift+Enter or Shift+F3: previous result.
// The search looks only at the lines in the list now (the text of each line, not the name and not the time).
// The results show with the CSS Custom Highlight API. The lines do not change: the unread marker, the ids and the
// reading anchor of reading.js stay as they are. While the bar is open, reading.js holds the unread count.
// Close (Escape or the Close button) puts the list back at the position before the open.
(function () {
    'use strict';

    // At most this many results. The count then shows "n of 1000+".
    const MAX_RESULTS = 1000;

    // The lower case form of a text, and for each character of that form the index in the original text.
    // map has one more item: the length of the original text. A character can give two lower case characters
    // ("İ"), thus the indexes of the folded text and the original text can be different.
    function fold(text) {
        const source = String(text ?? '');
        let folded = '';
        const map = [];
        for (let i = 0; i < source.length;) {
            const ch = String.fromCodePoint(source.codePointAt(i));
            const lower = ch.toLowerCase();
            for (let k = 0; k < lower.length; k++) map.push(i);
            folded += lower;
            i += ch.length;
        }
        map.push(source.length);
        return { folded, map };
    }

    // All results of query in texts, in list sequence. Case is not important. The results do not overlap.
    // Returns { results: [{ line, start, end }], capped }. start and end: indexes in texts[line].
    function findAll(texts, query, max = MAX_RESULTS) {
        const needle = fold(query).folded;
        const results = [];
        if (needle === '') return { results, capped: false };
        const list = Array.isArray(texts) ? texts : [];
        for (let line = 0; line < list.length; line++) {
            const { folded, map } = fold(list[line]);
            let from = 0;
            for (;;) {
                const at = folded.indexOf(needle, from);
                if (at < 0) break;
                if (results.length >= max) return { results, capped: true };
                const start = map[at];
                const end = Math.max(start + 1, map[at + needle.length]);
                results.push({ line, start, end });
                from = at + needle.length;
            }
        }
        return { results, capped: false };
    }

    // The first result to show: the first result in the line fromLine or below it. Else the last result.
    // -1 when there is no result.
    function startIndex(results, fromLine) {
        if (!Array.isArray(results) || results.length === 0) return -1;
        const line = Number.isFinite(fromLine) ? fromLine : 0;
        const index = results.findIndex(r => r.line >= line);
        return index < 0 ? results.length - 1 : index;
    }

    // The next (+1) or previous (-1) result, with wrap. -1 when there is no result.
    function step(index, length, direction) {
        if (!(length > 0)) return -1;
        if (index < 0 || index >= length) return direction < 0 ? length - 1 : 0;
        return (index + (direction < 0 ? -1 : 1) + length) % length;
    }

    // The text of the result count. Empty for an empty query.
    function countText(index, total, capped, query) {
        if (String(query ?? '') === '') return '';
        if (!(total > 0)) return 'No results';
        return `${index + 1} of ${total}${capped ? '+' : ''}`;
    }

    // The key of a result: it stays the same when new lines come.
    function sameResult(a, b) {
        return Boolean(a && b) && a.key === b.key && a.start === b.start && a.end === b.end;
    }

    const findCore = Object.freeze({ MAX_RESULTS, fold, findAll, startIndex, step, countText, sameResult });
    window.findCore = findCore;

    // ---- DOM part ----

    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;

    const list = document.getElementById('messages');
    const bar = document.getElementById('find-bar');
    const input = document.getElementById('find-input');
    const count = document.getElementById('find-count');
    const prevButton = document.getElementById('find-prev');
    const nextButton = document.getElementById('find-next');
    const closeButton = document.getElementById('find-close');
    const chatScreen = document.getElementById('chat-screen');
    if (!list || !bar || !input) return;

    const HIGHLIGHT_ALL = 'asscrack-find';
    const HIGHLIGHT_CURRENT = 'asscrack-find-current';
    const CURRENT_CLASS = 'find-current';
    const highlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function' ? CSS.highlights : null;

    // { saved, returnFocus, fromLine, results: [{ key, row, start, end }], capped, index, observer }
    let state = null;

    function isOpen() {
        return state !== null;
    }

    function rows() {
        return Array.from(list.children).filter(li => li.querySelector('.text'));
    }

    // A DOM range for the characters start to end of the text of a line. The text can have child elements
    // (the quotation of quote.js), thus walk the text nodes.
    function rangeFor(textEl, start, end) {
        const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let offset = 0;
        let started = false;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const length = node.nodeValue.length;
            if (!started && start <= offset + length) {
                range.setStart(node, start - offset);
                started = true;
            }
            if (started && end <= offset + length) {
                range.setEnd(node, end - offset);
                return range;
            }
            offset += length;
        }
        return started ? range : null;
    }

    function current() {
        return state && state.index >= 0 ? state.results[state.index] ?? null : null;
    }

    function clearMarks() {
        if (highlights) {
            highlights.delete(HIGHLIGHT_ALL);
            highlights.delete(HIGHLIGHT_CURRENT);
        }
        for (const row of list.querySelectorAll(`li.${CURRENT_CLASS}`)) row.classList.remove(CURRENT_CLASS);
    }

    function paint() {
        clearMarks();
        if (!state) return;
        const now = current();
        if (highlights && state.results.length > 0) {
            const all = new Highlight();
            for (const result of state.results) {
                const range = rangeFor(result.row.querySelector('.text'), result.start, result.end);
                if (range) all.add(range);
            }
            highlights.set(HIGHLIGHT_ALL, all);
            if (now) {
                const range = rangeFor(now.row.querySelector('.text'), now.start, now.end);
                if (range) highlights.set(HIGHLIGHT_CURRENT, new Highlight(range));
            }
        }
        if (now) now.row.classList.add(CURRENT_CLASS);
        count.textContent = countText(state.index, state.results.length, state.capped, input.value);
        bar.dataset.empty = String(input.value !== '' && state.results.length === 0);
        prevButton.disabled = state.results.length === 0;
        nextButton.disabled = state.results.length === 0;
    }

    // Put the current result in the middle of the list viewport. Only the list scrolls (not the page).
    function reveal() {
        const now = current();
        if (!now) return;
        const range = rangeFor(now.row.querySelector('.text'), now.start, now.end);
        const box = range ? range.getBoundingClientRect() : null;
        const listBox = list.getBoundingClientRect();
        let top;
        let height;
        if (box && box.height > 0) {
            top = box.top - listBox.top + list.scrollTop;
            height = box.height;
        } else {
            top = now.row.offsetTop;
            height = now.row.offsetHeight;
        }
        const wanted = top - (list.clientHeight - height) / 2;
        list.scrollTop = Math.max(0, Math.min(wanted, list.scrollHeight - list.clientHeight));
    }

    // Search again. keep: keep the current result when it is still there (new lines came).
    function refresh(keep) {
        if (!state) return;
        const before = keep ? current() : null;
        const lineRows = rows();
        const found = findAll(lineRows.map(row => row.querySelector('.text').textContent), input.value);
        state.results = found.results.map(r => ({ key: lineRows[r.line], row: lineRows[r.line], start: r.start, end: r.end }));
        state.capped = found.capped;
        const kept = before ? state.results.findIndex(r => sameResult(r, before)) : -1;
        let index = kept;
        if (index < 0) {
            const fromLine = state.fromRow ? Math.max(0, lineRows.indexOf(state.fromRow)) : 0;
            index = startIndex(found.results, fromLine);
        }
        state.index = index;
        paint();
        // A kept result does not move the list: a new line must not take the view away from the result.
        if (kept < 0) reveal();
    }

    function go(direction) {
        if (!state || state.results.length === 0) return;
        state.index = step(state.index, state.results.length, direction);
        paint();
        reveal();
    }

    // The first line in the viewport now: the search starts there.
    function firstVisibleRow() {
        const items = rows();
        const core = window.readingCore;
        if (!core) return items[0] ?? null;
        const index = core.firstVisibleIndex(items.length, i => items[i].offsetTop, i => items[i].offsetHeight, list.scrollTop);
        return index >= 0 ? items[index] : null;
    }

    function open() {
        if (!chatScreen || chatScreen.hidden) return false;
        if (!state) {
            const reading = window.reading;
            state = {
                saved: reading ? reading.savePosition() : null,
                returnFocus: document.activeElement,
                fromRow: firstVisibleRow(),
                results: [],
                capped: false,
                index: -1,
                observer: new MutationObserver(() => refresh(true))
            };
            reading?.setHold(true);
            state.observer.observe(list, { childList: true });
            bar.hidden = false;
            document.body.classList.add('find-open');
            if (input.value !== '') refresh(false);
            else paint();
        }
        input.focus({ preventScroll: true });
        input.select();
        return true;
    }

    // Close the bar and put the list back at the position before the open. The unread count stays.
    function close() {
        if (!state) return false;
        const { saved, returnFocus, observer } = state;
        observer.disconnect();
        state = null;
        clearMarks();
        bar.hidden = true;
        document.body.classList.remove('find-open');
        const reading = window.reading;
        if (reading) {
            if (saved) reading.restorePosition(saved);
            reading.setHold(false);
        }
        const target = returnFocus && returnFocus.isConnected && returnFocus !== document.body
            ? returnFocus : document.getElementById('message-input');
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
        return true;
    }

    input.addEventListener('input', () => refresh(false));
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            go(event.shiftKey ? -1 : 1);
        }
    });
    prevButton.addEventListener('click', () => go(-1));
    nextButton.addEventListener('click', () => go(1));
    closeButton.addEventListener('click', () => close());

    // Ctrl+F (Cmd+F on a Mac) opens the bar, also when it is open: then the query is selected.
    // F3 and Shift+F3 go to the next and the previous result while the bar is open.
    document.addEventListener('keydown', event => {
        if (event.defaultPrevented) return;
        const key = String(event.key).toLowerCase();
        if (key === 'f' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
            if (open()) event.preventDefault();
            return;
        }
        if (event.key === 'F3' && state) {
            event.preventDefault();
            go(event.shiftKey ? -1 : 1);
        }
    });

    window.findBar = Object.freeze({ isOpen, open, close, next: () => go(1), previous: () => go(-1) });
})();
