// G7a: the friend chat window (design F7). Classic script; the bridge is window.friendChat (friend-chat-preload.cjs).
// The saved lines (200, then pages of 100 at the top), the live lines, the state line and the composer.
// Enter sends, Shift+Enter makes a new line. Marks: "Sending", "Delivered", "Not confirmed".
// G7b: a line to a friend with no session waits in the outbox ("Waiting: ..." and "Delete"). The received lines that were
// sent while this device was away have the mark "sent while you were away", and one note row before each batch.
(function () {
    'use strict';
    const MARKS = { sending: 'Sending', delivered: 'Delivered', unconfirmed: 'Not confirmed',
        waiting: 'Waiting: ASSCRACK sends it when you are both online' };
    const AWAY_MARK = 'sent while you were away';
    const pad = n => String(n).padStart(2, '0');
    const clock = time => { const d = new Date(time); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const AVAILABILITY = { away: 'Away', dnd: 'Do not disturb', idle: 'Idle Peer' };
    function stateText(state) {
        if (state.state === 'online') {
            const label = AVAILABILITY[state.availability];
            return label ? `Online · ${label}${state.note ? ` · ${state.note}` : ''}` : 'Online';
        }
        if (state.state === 'room') return `Online · in ${state.roomName}`;
        if (state.state === 'removed-you') return `${state.name} removed you as a friend.`;
        return 'Not connected. ASSCRACK sends your messages when you are both online.';
    }
    const awayNoteText = (name, count) => count === 1 ? `${name} sent a message while you were away.`
        : `${name} sent ${count} messages while you were away.`;
    const notDeliveredText = name => `Not delivered: ${name} removed you as a friend.`;
    const fullText = name => `200 messages wait for ${name}. Wait until ${name} is online.`;
    // Operator decision 3 (2026-11-21): the app tells why the friend cannot be reached.
    const REACH_NOTE = 'A link needs one computer with an open port (UPnP or a forwarded port), or the same network. ' +
        'Two computers with no open port cannot connect.';
    // easy-join: the text of an invite card. invite: { state, room } from the main process (never the code).
    function inviteCardText(invite, own, name) {
        const who = name || 'Your friend';
        if (own) {
            if (invite.state === 'sent') return `Invite to ${invite.room} sent`;
            if (invite.state === 'expired') return 'Invite expired';
            return 'Room invite sent';
        }
        if (invite.state === 'ok') return `${who} invites you to ${invite.room}.`;
        if (invite.state === 'expired') return `Invite expired. Ask ${name || 'your friend'} for a new one.`;
        return 'This invite is for a different device.';
    }
    // The answer of Join (friend-join.mjs), as a note of the card. null: no note.
    function joinNoteText(answer) {
        switch (answer?.result) {
            case 'joining': return `Joining ${answer.room}…`;
            case 'busy': return 'ASSCRACK opens or leaves a room now. Try again in a moment.';
            case 'expired': return 'Invite expired.';
            case 'gone': return 'Invite no longer available.';
            case 'wrong-device': case 'wrong-owner': case 'invalid': return 'This invite is for a different device.';
            default: return 'Could not join the room.';
        }
    }
    window.friendChatCore = Object.freeze({ stateText, MARKS, REACH_NOTE, AWAY_MARK, awayNoteText, notDeliveredText, fullText,
        inviteCardText, joinNoteText });

    if (typeof document === 'undefined' || !window.friendChat) return;
    const api = window.friendChat;
    const byId = id => document.getElementById(id);
    const list = byId('messages');
    const input = byId('message-input');
    const older = byId('older');
    const rows = new Map(); // id -> <li>
    const notes = new Map(); // G7b: away batch -> { row, count }
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
        if (line.invite) {
            row.classList.add('invite');
            text.textContent = inviteCardText(line.invite, line.own, state.name);
        } else {
            text.textContent = line.text;
            window.chatLinks?.apply(text);
        }
        row.append(time, from, text);
        if (line.invite && !line.own && line.invite.state === 'ok') row.append(inviteButtons(line.id));
        if (line.away && !line.own) {
            row.dataset.away = line.away.batch;
            const away = document.createElement('span');
            away.className = 'away-mark';
            away.textContent = AWAY_MARK;
            row.append(away);
        }
        rows.set(line.id, row);
        if (line.waiting) setMark(line.id, state.state === 'removed-you' ? 'not-delivered' : 'waiting');
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
        el.textContent = mark === 'not-delivered' ? notDeliveredText(state.name) : MARKS[mark] ?? '';
        // G7b: a waiting line (also one that is not delivered) has Delete. The other marks have no button.
        const waiting = mark === 'waiting' || mark === 'not-delivered';
        let button = row.querySelector('.delete');
        if (waiting && !button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'delete';
            button.textContent = 'Delete';
            button.addEventListener('click', () => { deleteWaiting(id).catch(() => {}); });
            row.append(button);
        } else if (!waiting && button) button.remove();
    }
    // easy-join: Join / Not now of an invite card. In a room, Join asks "Leave <room> and join?" first.
    function inviteButtons(id) {
        const box = document.createElement('span');
        box.className = 'invite-actions';
        const note = document.createElement('span');
        note.className = 'invite-note';
        const button = (label, run) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.addEventListener('click', run);
            return b;
        };
        async function join(leave) {
            for (const b of box.querySelectorAll('button')) b.disabled = true;
            let answer;
            try { answer = await api.join(id, leave); } catch { answer = { result: 'failed' }; }
            if (answer?.result === 'confirm') {
                note.textContent = `Leave ${answer.current} and join ${answer.room}?`;
                box.replaceChildren(note, button('Leave and join', () => join(true)), button('Cancel', show));
                return;
            }
            note.textContent = joinNoteText(answer);
            const again = answer?.result === 'busy' || answer?.result === 'failed';
            box.replaceChildren(note, ...(again ? [button('Join', () => join(false))] : []));
        }
        function show() {
            note.textContent = '';
            box.replaceChildren(button('Join', () => join(false)), button('Not now', () => box.replaceChildren()));
        }
        show();
        return box;
    }
    async function deleteWaiting(id) {
        const result = await api.deleteWaiting(id);
        const status = byId('send-status');
        if (result === 'deleted') {
            rows.get(id)?.remove();
            rows.delete(id);
            status.textContent = '';
        } else if (result === 'sending') {
            status.textContent = 'ASSCRACK sends this message now. It cannot be deleted.';
        }
    }
    // G7b: one note row (kind 'away', no button, never unread) before the first line of each away batch in the list.
    // The count is the highest count of the batch (a live batch grows; a saved line has the full count).
    function placeNotes(lines) {
        const first = new Map();
        for (const line of lines) if (line.away && !line.own && !first.has(line.away.batch)) first.set(line.away.batch, line);
        for (const [batch, line] of first) {
            let note = notes.get(batch);
            if (!note) {
                const row = document.createElement('li');
                row.className = 'note';
                row.dataset.kind = 'away';
                note = { row, count: 0 };
                notes.set(batch, note);
            }
            note.count = Math.max(note.count, ...lines.filter(l => l.away?.batch === batch).map(l => l.away.count));
            note.row.textContent = awayNoteText(state.name, note.count);
            const target = rows.get(line.id);
            if (!target) continue;
            // A note goes before the first line of its batch: a new note, or an older page with earlier lines.
            const shown = [...list.children];
            if (!note.row.parentElement || shown.indexOf(target) < shown.indexOf(note.row)) list.insertBefore(note.row, target);
        }
    }
    const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    function addLive(line) {
        if (!line || rows.has(line.id)) return;
        const stick = atBottom();
        list.append(makeRow(line));
        placeNotes([line]);
        if (stick) list.scrollTop = list.scrollHeight;
    }
    function showState(next) {
        if (next && typeof next === 'object') state = next;
        byId('friend-name').textContent = state.name;
        if (state.name) document.title = `${state.name} – ASSCRACK`;
        const line = byId('friend-state');
        line.textContent = stateText(state);
        line.dataset.online = String(state.state === 'online' || state.state === 'room');
        const reach = byId('friend-reach');
        reach.hidden = state.state === 'online' || state.state === 'room' || state.state === 'removed-you' || state.reach !== 'local';
        reach.textContent = REACH_NOTE;
        // G7b: after 'unfriend' from the other side, the waiting lines are not delivered.
        if (state.state === 'removed-you') {
            for (const [id, row] of rows) if (row.querySelector('.mark')?.dataset.mark === 'waiting') setMark(id, 'not-delivered');
        }
    }

    async function loadOlder() {
        const page = await api.lines(first);
        if (!Array.isArray(page) || !page.length) {
            older.hidden = true;
            return;
        }
        const height = list.scrollHeight;
        list.prepend(...page.filter(line => !rows.has(line.id)).map(makeRow));
        placeNotes(page);
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
        if ((answer?.result === 'sending' || answer?.result === 'waiting') && answer.line) {
            input.value = '';
            status.textContent = '';
            addLive(answer.line);
            if (answer.result === 'sending') setMark(answer.line.id, 'sending');
            list.scrollTop = list.scrollHeight;
        } else if (answer?.result === 'invalid') {
            status.textContent = 'The message must have 1 to 4096 characters.';
        } else if (answer?.result === 'full') {
            // The draft stays.
            status.textContent = fullText(state.name);
        } else if (answer?.result === 'removed') {
            status.textContent = `${state.name} removed you as a friend. The message was not sent.`;
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
            placeNotes(page);
            first = { time: page[0].time, id: page[0].id };
            older.hidden = page.length < 200;
            list.scrollTop = list.scrollHeight;
        }
        input.focus();
    })().catch(err => console.warn('Friend chat not loaded:', err?.message ?? err));
})();
