// Find in the chat list (milestone 2, D-Q6).
// window.findCore: pure functions with no DOM. The tests load this file with node:vm.
// window.findBar: the DOM part. renderer.js opens it (Ctrl+F) and closes it (Escape).
(function () {
    'use strict';

    function normalQuery(query) {
        const q = String(query ?? '');
        return q.trim() === '' ? '' : q.toLocaleLowerCase();
    }

    // The indexes of the texts that contain the query, case-insensitive.
    function matchLines(texts, query) {
        const q = normalQuery(query);
        const out = [];
        if (!q) return out;
        Array.from(texts ?? []).forEach((t, i) => {
            if (String(t ?? '').toLocaleLowerCase().includes(q)) out.push(i);
        });
        return out;
    }

    // [{ start, end }] of each match in one text (UTF-16 offsets, no overlap).
    function matchRanges(text, query) {
        const q = normalQuery(query);
        const out = [];
        if (!q) return out;
        const s = String(text ?? '');
        const low = s.toLocaleLowerCase();
        // A case change that changes the length makes the offsets wrong: give no ranges then.
        if (low.length !== s.length) return out;
        let at = low.indexOf(q);
        while (at >= 0) {
            out.push({ start: at, end: at + q.length });
            at = low.indexOf(q, at + q.length);
        }
        return out;
    }

    // The next index with wrap. current -1: none (next gives 0, previous gives the last).
    function step(current, count, dir) {
        if (count <= 0) return -1;
        if (current < 0 || current >= count) return dir < 0 ? count - 1 : 0;
        return ((current + (dir < 0 ? -1 : 1)) % count + count) % count;
    }

    function countLabel(current, count) {
        if (count <= 0) return 'No results';
        return `${current + 1} of ${count}`;
    }

    window.findCore = { matchLines, matchRanges, step, countLabel };

    if (typeof document === 'undefined') return;

    // ---- DOM part ----

    const bar = document.getElementById('find-bar');
    const input = document.getElementById('find-input');
    const countEl = document.getElementById('find-count');
    const prevButton = document.getElementById('find-prev');
    const nextButton = document.getElementById('find-next');
    const closeButton = document.getElementById('find-close');
    const list = document.getElementById('messages');
    if (!bar || !input || !list) return;

    const HIT = 'find-hit';
    const CURRENT = 'find-current';
    const canHighlight = typeof CSS !== 'undefined' && CSS && CSS.highlights
        && typeof Highlight === 'function' && typeof Range === 'function';

    let open = false;
    let saved = null;
    let rows = [];
    let hits = [];
    let current = -1;

    function textOf(row) {
        const span = row.querySelector ? row.querySelector('.text') : null;
        return span ? span.textContent : '';
    }

    function clearMarks() {
        for (const row of rows) {
            if (row.classList) row.classList.remove(HIT, CURRENT);
        }
        if (canHighlight) {
            CSS.highlights.delete('find-match');
            CSS.highlights.delete('find-current');
        }
    }

    function rangesOf(row, query) {
        const span = row.querySelector ? row.querySelector('.text') : null;
        const node = span ? span.firstChild : null;
        if (!node || node.nodeType !== 3) return [];
        return matchRanges(node.data, query).map(({ start, end }) => {
            const r = new Range();
            r.setStart(node, start);
            r.setEnd(node, end);
            return r;
        });
    }

    function paint() {
        const query = input.value;
        for (const row of rows) row.classList.remove(CURRENT);
        if (countEl) countEl.textContent = query.trim() === '' ? '' : countLabel(current, hits.length);
        const row = current >= 0 ? rows[hits[current]] : null;
        if (row) {
            row.classList.add(CURRENT);
            if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
        }
        if (canHighlight) {
            const all = [];
            for (const i of hits) all.push(...rangesOf(rows[i], query));
            CSS.highlights.set('find-match', new Highlight(...all));
            CSS.highlights.set('find-current', new Highlight(...(row ? rangesOf(row, query) : [])));
        }
    }

    function search() {
        clearMarks();
        rows = Array.from(list.children);
        hits = matchLines(rows.map(textOf), input.value);
        for (const i of hits) rows[i].classList.add(HIT);
        current = hits.length > 0 ? hits.length - 1 : -1;
        paint();
    }

    // Next or previous match. The rows that exist now count (lines that arrived while open).
    function move(dir) {
        if (!open) return;
        const before = hits.length > 0 && current >= 0 ? rows[hits[current]] : null;
        clearMarks();
        rows = Array.from(list.children);
        hits = matchLines(rows.map(textOf), input.value);
        for (const i of hits) rows[i].classList.add(HIT);
        const at = before ? hits.indexOf(rows.indexOf(before)) : -1;
        current = step(at, hits.length, dir);
        paint();
    }

    function openBar() {
        if (!open) {
            saved = window.reading ? window.reading.saveView() : null;
            if (window.reading) window.reading.setHold(true);
            open = true;
            bar.hidden = false;
        }
        input.focus();
        input.select();
        search();
    }

    function closeBar(restore) {
        if (!open) return false;
        clearMarks();
        rows = [];
        hits = [];
        current = -1;
        if (countEl) countEl.textContent = '';
        bar.hidden = true;
        open = false;
        if (window.reading) {
            window.reading.setHold(false);
            if (restore) window.reading.restoreView(saved);
        }
        saved = null;
        return true;
    }

    input.addEventListener('input', () => { if (open) search(); });
    input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
    });
    if (prevButton) prevButton.addEventListener('click', () => move(-1));
    if (nextButton) nextButton.addEventListener('click', () => move(1));
    if (closeButton) closeButton.addEventListener('click', () => closeBar(true));

    window.findBar = {
        open: openBar,
        close: closeBar,
        isOpen: () => open
    };
})();
