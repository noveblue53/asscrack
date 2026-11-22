// The keys of the message box (gaps D3 and D4). renderer.js keeps Enter; this file adds Up, Down and Tab.
// window.composerKeysCore: a pure part with no DOM. The tests load this file with node:vm.
// - createRecall(limit): the last texts that this run sent (also commands). Not saved.
// - createCompletion(): Tab completion of buddy names.
// window.composerKeys: the DOM part. renderer.js calls remember(text) for each text that it sends.
// All names stay inside this function: the room window scripts are classic scripts in one global scope.
(function () {
    'use strict';

    const RECALL_LIMIT = 50;

    // Up and Down return the new text of the box, or null when the key must do its usual work (move the caret).
    function createRecall(limit = RECALL_LIMIT) {
        const texts = [];
        let index = null; // the position of the text that the box shows, or null when no recall runs
        function stop() {
            index = null;
        }
        return {
            remember(text) {
                const value = String(text ?? '');
                index = null;
                if (!value.trim()) return;
                if (texts.at(-1) === value) return;
                texts.push(value);
                if (texts.length > limit) texts.splice(0, texts.length - limit);
            },
            // Up: one step older. Only in an empty box or in a box that shows a recalled text with no change.
            up(value) {
                if (index !== null && value !== texts[index]) stop();
                if (index === null && value !== '') return null;
                if (texts.length === 0) return null;
                index = index === null ? texts.length - 1 : Math.max(0, index - 1);
                return texts[index];
            },
            // Down: one step newer, then the empty box.
            down(value) {
                if (index === null) return null;
                if (value !== texts[index]) {
                    stop();
                    return null;
                }
                if (index === texts.length - 1) {
                    stop();
                    return '';
                }
                index++;
                return texts[index];
            },
            size: () => texts.length,
            recalling: () => index !== null
        };
    }

    // The word that ends at the caret: { start, prefix }, or null when the caret is not at the end of a word of 1 or
    // more characters.
    function wordAtCaret(value, caret) {
        if (caret < 1 || caret > value.length) return null;
        if (caret < value.length && !/\s/.test(value[caret])) return null;
        let start = caret;
        while (start > 0 && !/\s/.test(value[start - 1])) start--;
        if (start === caret) return null;
        return { start, prefix: value.slice(start, caret) };
    }

    // The names that start with prefix, with no case, without the own name. Each name one time, in a fixed sequence.
    function matchingNames(prefix, names, ownName) {
        const lower = prefix.toLocaleLowerCase();
        const own = String(ownName ?? '');
        const out = [];
        for (const raw of names) {
            const name = String(raw ?? '');
            if (!name || name === own || out.includes(name)) continue;
            if (name.toLocaleLowerCase().startsWith(lower)) out.push(name);
        }
        return out.sort((a, b) => a.localeCompare(b));
    }

    // tab({ value, caret, names, ownName }) returns { value, caret } for the box, or null (the Tab moves the focus).
    // A Tab directly after a completion, with no change of the box, gives the next match.
    function createCompletion() {
        let last = null; // { before, after, matches, i, value, caret }
        function result(state) {
            const name = state.matches[state.i];
            const lineStart = state.before === '' || state.before.endsWith('\n');
            const text = name + (lineStart ? ': ' : ' ');
            const value = state.before + text + state.after;
            const caret = state.before.length + text.length;
            last = { ...state, value, caret };
            return { value, caret };
        }
        return {
            tab({ value, caret, names, ownName }) {
                const text = String(value ?? '');
                if (last && last.value === text && last.caret === caret && last.matches.length > 1) {
                    return result({ ...last, i: (last.i + 1) % last.matches.length });
                }
                if (last && last.value === text && last.caret === caret) return null;
                last = null;
                const word = wordAtCaret(text, caret);
                if (!word) return null;
                const matches = matchingNames(word.prefix, names, ownName);
                if (matches.length === 0) return null;
                return result({ before: text.slice(0, word.start), after: text.slice(caret), matches, i: 0 });
            },
            reset() {
                last = null;
            }
        };
    }

    window.composerKeysCore = Object.freeze({ RECALL_LIMIT, createRecall, createCompletion, wordAtCaret, matchingNames });

    if (typeof document === 'undefined') return;

    // ---- DOM part ----

    const input = document.getElementById('message-input');
    if (!input) return;
    const recall = createRecall();
    const completion = createCompletion();

    function caretOf() {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        return start === end ? start : null;
    }

    // Put a text in the box with the caret at caret. The input event lets typing.js and the other listeners see it.
    function show(value, caret = value.length) {
        input.value = value;
        if (typeof input.setSelectionRange === 'function') input.setSelectionRange(caret, caret);
        else {
            input.selectionStart = caret;
            input.selectionEnd = caret;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function names() {
        return typeof buddyNames === 'function' ? buddyNames() : [];
    }

    input.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'Tab') {
            // Shift+Tab always moves the focus.
            if (event.shiftKey) return;
            const caret = caretOf();
            if (caret === null) return;
            const next = completion.tab({ value: input.value, caret, names: names(), ownName: typeof ownName === 'string' ? ownName : '' });
            if (!next) return;
            event.preventDefault();
            show(next.value, next.caret);
            return;
        }
        if (event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        const next = event.key === 'ArrowUp' ? recall.up(input.value) : recall.down(input.value);
        if (next === null) return;
        event.preventDefault();
        show(next);
    });

    window.composerKeys = Object.freeze({
        remember: text => recall.remember(text),
        recalling: () => recall.recalling()
    });
})();
