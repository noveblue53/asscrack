// easy-join part 3: the prompt "Join <room>?" for a device invite in the clipboard (clipboard-join.mjs in main).
// Classic script; all names stay inside this function. window.clipboardJoinCore: the pure texts (tests).
// The window gets { id, room } only. Join sends the id; the main process keeps the code and uses the Join of a friend
// invite (a one-time token for the login, renderer.js takeFriendJoin()).
(function () {
    'use strict';

    const promptText = room => `Join ${room}?`;
    const confirmText = (current, room) => `Leave ${current} and join ${room}?`;
    // The note after Join, or null (the bar closes).
    function answerText(answer) {
        switch (answer?.result) {
            case 'joining': case 'gone': return null;
            case 'busy': return 'ASSCRACK opens or leaves a room now. Try again in a moment.';
            case 'failed': return 'Could not leave the room. Try again.';
            default: return 'Could not join the room.';
        }
    }
    const NAME_TEXT = 'Enter a username, then select Join.';
    window.clipboardJoinCore = Object.freeze({ promptText, confirmText, answerText, NAME_TEXT });

    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const api = window.clipboardJoin;
    if (!api || !document.body) return;

    const bar = document.createElement('div');
    bar.id = 'clipboard-join-bar';
    bar.setAttribute('role', 'group');
    bar.hidden = true;
    const text = document.createElement('p');
    text.id = 'clipboard-join-text';
    bar.setAttribute('aria-labelledby', text.id);
    document.body.append(bar);
    let shown = null; // { id, room }

    const button = (label, run) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', run);
        return b;
    };
    function close() {
        shown = null;
        bar.hidden = true;
        bar.replaceChildren();
    }
    function show(prompt, note = '') {
        if (!prompt || typeof prompt.id !== 'string' || typeof prompt.room !== 'string') { close(); return; }
        shown = prompt;
        text.textContent = note || promptText(prompt.room);
        bar.replaceChildren(text, button('Join', () => { void join(false); }), button('Not now', notNow));
        bar.hidden = false;
    }
    function notNow() {
        const id = shown?.id;
        close();
        if (id) Promise.resolve(api.dismiss(id)).catch(() => {});
    }
    // The login screen needs a username (renderer.js login()). In a room, the field has the name of the last login.
    function needsName() {
        const chat = document.getElementById('chat-screen');
        const name = document.getElementById('username');
        return Boolean(chat?.hidden && name && !name.value.trim());
    }
    async function join(leave) {
        const prompt = shown;
        if (!prompt) return;
        if (needsName()) {
            show(prompt, NAME_TEXT);
            document.getElementById('username')?.focus();
            return;
        }
        for (const b of bar.querySelectorAll('button')) b.disabled = true;
        let answer;
        try { answer = await api.join(prompt.id, leave); } catch { answer = { result: 'error' }; }
        if (shown !== prompt) return;
        if (answer?.result === 'confirm') {
            text.textContent = confirmText(answer.current, answer.room);
            bar.replaceChildren(text, button('Leave and join', () => { void join(true); }), button('Cancel', () => show(prompt)));
            return;
        }
        const note = answerText(answer);
        if (note === null) close();
        else show(prompt, note);
    }
    async function refresh() {
        let prompt = null;
        try { prompt = await api.take(); } catch { prompt = null; }
        if (prompt?.id !== shown?.id) show(prompt);
    }
    api.onPrompt(() => { void refresh(); });
    void refresh();
})();
