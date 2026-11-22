// G7a: the friend chat window (design F7). Classic script; the bridge is window.friendChat (friend-chat-preload.cjs).
// The saved lines (200, then pages of 100 at the top), the live lines, the state line and the composer.
// Enter sends, Shift+Enter makes a new line. Marks: "Sending", "Delivered", "Not confirmed".
(function () {
    'use strict';
    const MARKS = { sending: 'Sending', delivered: 'Delivered', unconfirmed: 'Not confirmed' };
    const pad = n => String(n).padStart(2, '0');
    const clock = time => { const d = new Date(time); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    function stateText(state) {
        if (state.state === 'online') return 'Online';
        if (state.state === 'removed-you') return `${state.name} removed you as a friend.`;
        return `Not connected. You can send when ${state.name} is online.`;
    }
    // Operator decision 3 (2026-11-21): the app tells why the friend cannot be reached.
    const REACH_NOTE = 'A link needs one computer with an open port (UPnP or a forwarded port), or the same network. ' +
        'Two computers with no open port cannot connect.';
    window.friendChatCore = Object.freeze({ stateText, MARKS, REACH_NOTE });

    if (typeof document === 'undefined' || !window.friendChat) return;
    const api = window.friendChat;
    const byId = id => document.getElementById(id);
    const list = byId('messages');
    const input = byId('message-input');
    const older = byId('older');
    const rows = new Map(); // id -> <li>
    let state = { name: '', state: 'offline' };
    let first = null; // { time, id } of the oldest shown line

    try {
        const theme = localStorage.getItem('asscrack.theme.v1');
        if (theme) document.documentElement.dataset.theme = theme;
    } catch { /* no saved theme */ }
    window.addEventListener('storage', event => {
        if (event.key === 'asscrack.theme.v1' && event.newValue) document.documentElement.dataset.theme = event.newValue;
    });

    function makeRow(line) {
        const row = document.createElement('li');
        row.dataset.id = line.id;
        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = clock(line.time);
        const from = document.createElement('span');
        from.className = 'from';
        from.textContent = line.own ? 'You' : (line.from || state.name);
        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = line.text;
        window.chatLinks?.apply(text);
        row.append(time, from, text);
        rows.set(line.id, row);
        return row;
    }
    function setMark(id, mark) {
        const row = rows.get(id);
        if (!row) return;
        let el = row.querySelector('.mark');
        if (!el) {
            el = document.createElement('span');
            el.className = 'mark';
            row.append(el);
        }
        el.dataset.mark = mark;
        el.textContent = MARKS[mark] ?? '';
    }
    const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    function addLive(line) {
        if (!line || rows.has(line.id)) return;
        const stick = atBottom();
        list.append(makeRow(line));
        if (stick) list.scrollTop = list.scrollHeight;
    }
    function showState(next) {
        if (next && typeof next === 'object') state = next;
        byId('friend-name').textContent = state.name;
        if (state.name) document.title = `${state.name} – ASSCRACK`;
        const line = byId('friend-state');
        line.textContent = stateText(state);
        line.dataset.online = String(state.state === 'online');
        const reach = byId('friend-reach');
        reach.hidden = state.state === 'online' || state.state === 'removed-you' || state.reach !== 'local';
        reach.textContent = REACH_NOTE;
    }

    async function loadOlder() {
        const page = await api.lines(first);
        if (!Array.isArray(page) || !page.length) {
            older.hidden = true;
            return;
        }
        const height = list.scrollHeight;
        list.prepend(...page.filter(line => !rows.has(line.id)).map(makeRow));
        first = { time: page[0].time, id: page[0].id };
        older.hidden = page.length < 100;
        list.scrollTop += list.scrollHeight - height;
    }
    older.addEventListener('click', () => { loadOlder().catch(() => {}); });

    async function send() {
        const text = input.value;
        if (!text.trim()) return;
        let answer;
        try { answer = await api.send(text); } catch { answer = { result: 'unavailable' }; }
        const status = byId('send-status');
        if (answer?.result === 'sending' && answer.line) {
            input.value = '';
            status.textContent = '';
            addLive(answer.line);
            setMark(answer.line.id, 'sending');
            list.scrollTop = list.scrollHeight;
        } else if (answer?.result === 'invalid') {
            status.textContent = 'The message must have 1 to 4096 characters.';
        } else {
            // The draft stays.
            status.textContent = `${state.name} is not connected. The message was not sent.`;
        }
    }
    byId('composer').addEventListener('submit', event => {
        event.preventDefault();
        send();
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            send();
        }
    });

    api.onLine(addLive);
    api.onReceipt(({ id, result }) => setMark(id, result === 'delivered' ? 'delivered' : 'unconfirmed'));
    api.onState(showState);
    window.friendChatReady = (async () => {
        showState(await api.state());
        const page = await api.lines(null);
        if (Array.isArray(page) && page.length) {
            list.append(...page.filter(line => !rows.has(line.id)).map(makeRow));
            first = { time: page[0].time, id: page[0].id };
            older.hidden = page.length < 200;
            list.scrollTop = list.scrollHeight;
        }
        input.focus();
    })().catch(err => console.warn('Friend chat not loaded:', err?.message ?? err));
})();
