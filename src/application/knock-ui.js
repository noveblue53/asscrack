// easy-join part 2: the join requests of a room code (#knock-bar above the composer, owner only). One request shows at
// a time: "<name> #<mark> wants to join." with Allow and Deny. The other requests wait in the list of the main process.
// Classic script; all names stay inside this function. window.knockCore: the pure text (tests).
(function () {
    'use strict';

    // view: { name, mark }. more: the number of other requests that wait.
    function barText(view, more = 0) {
        const name = view?.name || 'Someone';
        const who = typeof view?.mark === 'string' && /^[0-9a-f]{6}$/.test(view.mark) ? `${name} #${view.mark}` : name;
        return `${who} wants to join.` + (more > 0 ? ` ${more} more ${more === 1 ? 'request waits' : 'requests wait'}.` : '');
    }
    // easy-join part 3: the room line of "Always allow my friends". view: { name, mark } (the name of the Friends list).
    function autoText(view) {
        const name = view?.name || 'A friend';
        const who = typeof view?.mark === 'string' && /^[0-9a-f]{6}$/.test(view.mark) ? `${name} #${view.mark}` : name;
        return `${who} joined, friend auto-allowed.`;
    }
    window.knockCore = Object.freeze({ barText, autoText });

    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const api = window.asscrack;
    const bar = document.getElementById('knock-bar');
    if (!api || !bar) return;
    const text = document.getElementById('knock-text');
    const allow = document.getElementById('knock-allow');
    const deny = document.getElementById('knock-deny');
    let list = [];
    let busy = false;

    function show() {
        const next = list[0];
        bar.hidden = !next;
        text.textContent = next ? barText(next, list.length - 1) : '';
        bar.dataset.knockId = next?.id ?? '';
        allow.disabled = deny.disabled = busy;
    }
    async function answer(yes) {
        const current = list[0];
        if (!current || busy) return;
        busy = true;
        list = list.slice(1);
        show();
        try {
            const done = await api.answerKnock(current.id, yes);
            const status = document.getElementById('status');
            if (status) status.textContent = !done ? `The request of ${current.name || 'this person'} ended before your answer.`
                : yes ? `${current.name || 'The person'} can join now.` : `You did not let ${current.name || 'the person'} in.`;
        } catch { /* the list event shows the state */ }
        finally {
            busy = false;
            show();
        }
    }
    allow.addEventListener('click', () => answer(true));
    deny.addEventListener('click', () => answer(false));
    function update(next) {
        list = Array.isArray(next) ? next.filter(row => row && typeof row.id === 'string') : [];
        show();
    }
    api.onKnocks?.(update);
    // A note row of the chat list (transcript-notes.js): never unread, never saved.
    api.onKnockAuto?.(view => window.transcriptNotes?.append('presence', autoText(view), Date.now()));
    Promise.resolve(api.getKnocks?.()).then(next => { if (Array.isArray(next) && !list.length) update(next); }).catch(() => {});
})();
