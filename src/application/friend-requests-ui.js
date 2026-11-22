// G7a: the friend request bar above the composer (#friend-request-bar, design F3) and the status texts of a request.
// Classic script; all names stay inside this function. window.friendRequestsCore: the pure texts (tests).
// A G2 note row has no button, thus the request is a bar. One request shows at a time; the next waits.
(function () {
    'use strict';

    const barText = name => `${name} wants to add you as a friend. Friends can send private messages outside of rooms. ` +
        `${name} will know the internet address of this computer.`;
    // The status text at the end of a request, or '' (no text).
    function endText(event) {
        const name = event.name || 'This person';
        switch (event.result) {
            case 'friend': return `${name} is now your friend.`;
            case 'declined': return event.side === 'out' ? `${name} declined.` : '';
            case 'no-answer': return event.side === 'out' ? `No answer from ${name}.` : '';
            case 'failed': return `Could not add ${name} as a friend. Try again.`;
            case 'closed': return event.side === 'out' ? `The friend request to ${name} ended: ${name} is not in the room now.` : '';
            default: return '';
        }
    }
    window.friendRequestsCore = Object.freeze({ barText, endText });

    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const api = window.friends;
    const bar = document.getElementById('friend-request-bar');
    if (!api || !bar) return;
    const text = document.getElementById('friend-request-text');
    const queue = []; // { id, name }

    function show() {
        const next = queue[0];
        bar.hidden = !next;
        text.textContent = next ? barText(next.name) : '';
    }
    function answer(accept) {
        const current = queue.shift();
        show();
        if (current) Promise.resolve(api.respond(current.id, accept)).catch(() => {});
    }
    document.getElementById('friend-request-accept').addEventListener('click', () => answer(true));
    document.getElementById('friend-request-decline').addEventListener('click', () => answer(false));

    api.onRequest(event => {
        if (!event || typeof event !== 'object') return;
        if (event.kind === 'incoming') {
            queue.push({ id: event.id, name: event.name || 'Someone' });
            show();
            return;
        }
        if (event.kind !== 'ended') return;
        const index = queue.findIndex(entry => entry.id === event.id);
        if (index >= 0) { queue.splice(index, 1); show(); }
        const line = endText(event);
        const status = document.getElementById('status');
        if (line && status) status.textContent = line;
    });
})();
