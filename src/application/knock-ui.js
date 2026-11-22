// easy-join part 2: the join requests of a room code (#knock-bar above the composer, owner only). One request shows at
// a time: "<name> #<mark> wants to join" with Allow and Deny, and a "+N" tag for the other requests (U16 of the UI copy
// pass). The other requests wait in the list of the main process.
// Classic script; all names stay inside this function. window.knockCore: the pure text (tests).
(function () {
    'use strict';

    // view: { name, mark }.
    function barText(view) {
        const name = view?.name || 'Someone';
        const who = typeof view?.mark === 'string' && /^[0-9a-f]{6}$/.test(view.mark) ? `${name} #${view.mark}` : name;
        return `${who} wants to join`;
    }
    // more: the number of other requests that wait. '' for none.
    const moreText = more => (more > 0 ? `+${more}` : '');
    // easy-join part 3: the room line of "Always allow my friends". view: { name, mark } (the name of the Friends list).
    function autoText(view) {
        const name = view?.name || 'A friend';
        const who = typeof view?.mark === 'string' && /^[0-9a-f]{6}$/.test(view.mark) ? `${name} #${view.mark}` : name;
        return `${who} joined (friend)`;
    }
    window.knockCore = Object.freeze({ barText, moreText, autoText });

    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const api = window.asscrack;
    const bar = document.getElementById('knock-bar');
    if (!api || !bar) return;
    const text = document.getElementById('knock-text');
    const allow = document.getElementById('knock-allow');
    const deny = document.getElementById('knock-deny');
    const moreTag = document.getElementById('knock-more');
    let list = [];
    let busy = false;

    function show() {
        const next = list[0];
        bar.hidden = !next;
        text.textContent = next ? barText(next) : '';
        if (moreTag) {
            const more = next ? list.length - 1 : 0;
            moreTag.textContent = moreText(more);
            moreTag.title = more > 0 ? `${more} more waiting` : '';
            moreTag.hidden = more === 0;
        }
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
            const who = current.name || 'Someone';
            if (status) status.textContent = !done ? `Request from ${who} ended.` : yes ? `Allowed ${who}.` : `Denied ${who}.`;
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
