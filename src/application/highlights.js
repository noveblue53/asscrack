// Nick and personal keyword highlights run only on new live messages in this window.
(function () {
    const next = document.getElementById('next-highlight');
    const words = document.getElementById('highlight-words');
    const list = document.getElementById('messages');
    const screen = document.getElementById('chat-screen');
    const pending = new Set();
    const storageKey = 'asscrack.highlightWords.v1';
    const wordChar = '[\\p{L}\\p{M}\\p{N}\\p{Pc}]';
    let name = '';
    let pattern = null;
    let selected = null;

    function compile() {
        const terms = [name, ...words.value.split(',')].map(s => s.trim()).filter(Boolean);
        const alternatives = [...new Set(terms)].sort((a, b) => b.length - a.length).map(RegExp.escape);
        pattern = alternatives.length
            ? new RegExp('(?<!' + wordChar + ')(?:' + alternatives.join('|') + ')(?!' + wordChar + ')', 'giu')
            : null;
    }

    try { words.value = (window.localStorage.getItem(storageKey) ?? '').slice(0, 512); } catch {}
    compile();
    words.addEventListener('input', () => {
        compile();
        try { window.localStorage.setItem(storageKey, words.value); } catch {}
    });

    function updateCount() {
        next.disabled = pending.size === 0;
        next.textContent = pending.size ? `Next highlight (${pending.size})` : 'Next highlight';
    }

    function note(row, text, unread) {
        if (!pattern) return false;
        const quote = window.quoteCore.split(text);
        const reply = quote ? quote.rest : String(text);
        const matches = reply.matchAll(pattern);
        const first = matches.next();
        if (first.done) return false;

        const span = row.querySelector('.text');
        const quotedBlock = span.querySelector('.quote');
        const children = quotedBlock ? [quotedBlock] : [];
        let end = 0;
        let hit = first;
        // Bound the number of DOM nodes for a 64 KiB line that repeats a short keyword.
        for (let i = 0; !hit.done && i < 64; i++, hit = matches.next()) {
            const match = hit.value;
            const mark = document.createElement('mark');
            mark.className = 'nick-highlight';
            mark.textContent = match[0];
            children.push(reply.slice(end, match.index), mark);
            end = match.index + match[0].length;
        }
        children.push(reply.slice(end));
        span.replaceChildren(...children);
        if (unread || document.hasFocus?.() === false) {
            pending.add(row);
            updateCount();
        }
        return true;
    }

    function nextHighlight() {
        if (!pending.size || screen.hidden) return false;
        window.findBar?.close();
        for (const row of pending) {
            pending.delete(row);
            if (row.parentElement !== list) continue;
            selected?.classList.remove('selected-highlight');
            selected = row;
            row.classList.add('selected-highlight');
            window.reading.revealLine(row);
            break;
        }
        updateCount();
        return true;
    }

    next.addEventListener('click', nextHighlight);
    document.addEventListener('keydown', event => {
        if (!event.defaultPrevented && !event.repeat && !event.isComposing && event.altKey && !event.ctrlKey &&
            !event.metaKey && !event.shiftKey && String(event.key).toLowerCase() === 'j' && nextHighlight()) {
            event.preventDefault();
        }
    });
    updateCount();
    window.chatHighlights = {
        setName(value) { name = String(value ?? ''); compile(); },
        note,
        clearUnread() { pending.clear(); updateCount(); }
    };
})();
