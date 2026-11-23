// Note rows in the chat list (gaps B1 and D6): who came and who went, the own connection, and the day rows.
// A note row is <li class="note" data-kind="presence|link|day|offer" data-time="…"><span class="note-text"/></li>.
// It has no data-id, no .from, no .text and no button. It is never unread and plays no sound. A row that is not a day
// row has a span.time (the time, as a chat line). The presence and link notes of the roster have a data-note-id: a
// saved room keeps them in its archive (room_notes of room-archive.mjs), as local events of this PC.
//
// window.rosterNotesCore: a pure part with no DOM and no clock. createRoster() gives a state machine. Each call gets
// the time and returns actions for the window. The tests load this file with node:vm and give the time.
// window.dayRowsCore: the day functions. They change a list through children, insertBefore and remove only, thus
// they work on the fake DOM of the tests too.
// window.transcriptNotes: the DOM part. renderer.js calls it.
// All names stay inside this function: the room window scripts are classic scripts in one global scope.
(function () {
    'use strict';

    // A peer that went with no bye stays as a grey buddy line for this time.
    const HOLD_MS = 10 * 1000;
    // No join note in this time after the own first connection or the own reconnection.
    const QUIET_MS = 3 * 1000;
    // A note waits for the name of the peer for this time at most.
    const NAME_WAIT_MS = 2 * 1000;
    const ID_CHARS = 12;
    // A rejoin in this time after the leave note or the lost note of the same person replaces that note with one
    // "<name> reconnected." note. The person is the key that the window gives (the device mark of a protected room),
    // else the name: an app restart gives a new peer ID.
    const MERGE_MS = 60 * 1000;

    function clock(ms) {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    // options.creator: this computer created the room now (it always gets the join note of the first friend).
    // options.makeId(time): optional, the ID of a new note (tests).
    // Actions: { type: 'add' | 'restore' | 'grey' | 'remove', peerId } for the buddy list, and
    // { type: 'note', kind: 'presence' | 'link', text, time, id, replaces } for the chat list. replaces: the ID of an
    // earlier note that this note takes the place of, or null.
    function createRoster(options = {}) {
        const creator = options.creator === true;
        let idCount = 0;
        const makeId = typeof options.makeId === 'function' ? options.makeId
            : time => `${Number(time).toString(36)}-${(++idCount).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        // person -> { id, time } of the last leave or lost note of that person.
        const gone = new Map();
        const persons = new Map(); // peer ID -> person key of the window
        const present = new Set();
        const held = new Map(); // peer ID -> the end of its grey time
        const names = new Map();
        const waiting = []; // notes that wait for a name: { peerId, make, join, due }
        let out = [];
        let firstDone = false;
        let quietUntil = -Infinity;
        let seen = false;
        let lostAt = null;
        let allBye = true;
        let restoredAt = null;
        // The own loss: { at, before: the peers that went with no bye }. While it runs, no "lost the connection" note.
        let loss = null;
        // After the return: { at, before }. A peer of before that is not back at at + HOLD_MS gets its note then.
        let back = null;

        function note(kind, text, time, replaces = null) {
            const action = { type: 'note', kind, text, time, id: String(makeId(time)), replaces };
            out.push(action);
            return action;
        }

        // A join note after a leave or lost note of the same person in MERGE_MS replaces that note.
        function emitPeer(peerId, make, join, name, now) {
            const person = persons.get(peerId) ?? `name:${name}`;
            const last = gone.get(person);
            if (join) {
                gone.delete(person);
                if (last && now - last.time <= MERGE_MS) note('presence', reconnectedText(name), now, last.id);
                else note('presence', make(name), now);
                return;
            }
            gone.set(person, { id: note('presence', make(name), now).id, time: now });
        }

        function peerNote(peerId, make, now, join = false) {
            const name = names.get(peerId);
            if (name) emitPeer(peerId, make, join, name, now);
            else waiting.push({ peerId, make, join, due: now + NAME_WAIT_MS });
        }

        function flush() {
            const result = out;
            out = [];
            return result;
        }

        const joinedText = name => `${name} joined the room.`;
        const leftText = name => `${name} left the room.`;
        const lostText = name => `${name} lost the connection.`;
        const reconnectedText = name => `${name} reconnected.`;

        // person: optional, the key of the person (the window gives the device mark of a protected room).
        function setName(peerId, name, now, person) {
            if (typeof person === 'string' && person) persons.set(peerId, person);
            if (typeof name !== 'string' || !name) return;
            names.set(peerId, name);
            for (let i = 0; i < waiting.length; i++) {
                if (waiting[i].peerId !== peerId) continue;
                emitPeer(peerId, waiting[i].make, waiting[i].join, name, now);
                waiting.splice(i--, 1);
            }
        }

        return {
            joined(peerId, now, name, person) {
                setName(peerId, name, now, person);
                if (present.has(peerId)) return flush();
                const wasEmpty = present.size === 0;
                if (wasEmpty && loss) {
                    note('link', 'Reconnected.', now);
                    restoredAt = now;
                    back = { at: now, before: loss.before };
                    loss = null;
                    quietUntil = now + QUIET_MS;
                }
                const first = wasEmpty && !firstDone;
                if (first) {
                    firstDone = true;
                    quietUntil = now + QUIET_MS;
                }
                const heldBack = held.delete(peerId);
                const lossBack = back !== null && back.before.delete(peerId);
                present.add(peerId);
                seen = true;
                out.push({ type: heldBack ? 'restore' : 'add', peerId });
                if (!heldBack && !lossBack && ((first && creator) || now >= quietUntil)) peerNote(peerId, joinedText, now, true);
                return flush();
            },
            // withBye: the 'peer-left' event had left: true.
            left(peerId, withBye, now) {
                if (!present.delete(peerId)) return flush();
                if (withBye) {
                    out.push({ type: 'remove', peerId });
                    peerNote(peerId, leftText, now);
                } else {
                    held.set(peerId, now + HOLD_MS);
                    out.push({ type: 'grey', peerId });
                }
                if (present.size === 0) {
                    lostAt = now;
                    allBye = withBye && held.size === 0;
                    if (!allBye && !loss) {
                        const before = new Set(held.keys());
                        if (back) for (const id of back.before) before.add(id);
                        back = null;
                        restoredAt = null;
                        loss = { at: now, before };
                        note('link', 'Connection lost.', now);
                    }
                }
                return flush();
            },
            named(peerId, name, now, person) {
                setName(peerId, name, now, person);
                return flush();
            },
            // Call at nextDue() and later. Ends the grey times, the time after the return and the name waits.
            tick(now) {
                for (const [peerId, until] of [...held]) {
                    if (until > now) continue;
                    held.delete(peerId);
                    out.push({ type: 'remove', peerId });
                    if (!loss && !(back && back.before.has(peerId))) peerNote(peerId, lostText, now);
                }
                if (back && now >= back.at + HOLD_MS) {
                    for (const peerId of back.before) if (!present.has(peerId) && !held.has(peerId)) peerNote(peerId, lostText, now);
                    back = null;
                }
                for (let i = 0; i < waiting.length; i++) {
                    if (waiting[i].due > now) continue;
                    const w = waiting[i];
                    emitPeer(w.peerId, w.make, w.join, String(w.peerId).slice(0, ID_CHARS), now);
                    waiting.splice(i--, 1);
                }
                return flush();
            },
            // The next time for tick(), or null.
            nextDue() {
                const times = [...held.values(), ...waiting.map(w => w.due)];
                if (back) times.push(back.at + HOLD_MS);
                return times.length ? Math.min(...times) : null;
            },
            isHeld: peerId => held.has(peerId),
            // The facts for roomLinkCore.view.
            link: () => ({ peers: present.size, held: held.size, seen, lostAt, allBye, restoredAt })
        };
    }

    window.rosterNotesCore = Object.freeze({ HOLD_MS, QUIET_MS, NAME_WAIT_MS, MERGE_MS, clock, createRoster });

    // ---- Day rows (gap D6) ----

    const DATE_FORMAT = Object.freeze({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    function dayKey(ms) {
        const d = new Date(ms);
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    }

    // The time of local midnight at the start of the day of ms.
    function midnight(ms) {
        const d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }

    // "Today", "Yesterday" (by the calendar, not by 24 hours), else the long local date.
    function dayLabel(ms, now) {
        const day = midnight(ms);
        if (day === midnight(now)) return 'Today';
        const n = new Date(now);
        if (day === new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime()) return 'Yesterday';
        return new Date(ms).toLocaleDateString(undefined, DATE_FORMAT);
    }

    function isDayRow(row) {
        return Boolean(row?.classList?.contains('note')) && row.dataset?.kind === 'day';
    }

    // The time of a row, or null for a row with no time. A day row is not a row with a time for these rules.
    function timeOf(row) {
        if (!row || isDayRow(row)) return null;
        const t = Number(row.dataset?.time);
        return Number.isFinite(t) && t > 0 ? t : null;
    }

    // Make the day rows before row correct. A day row is directly before a row with a time exactly when the previous
    // row with a time has a different local day, or there is no such row. makeDay(time) makes a day row.
    function fixBefore(list, row, makeDay) {
        const t = timeOf(row);
        if (t === null || row.parentElement !== list) return;
        const rows = Array.from(list.children);
        const days = [];
        let prev = null;
        for (let i = rows.indexOf(row) - 1; i >= 0; i--) {
            if (isDayRow(rows[i])) days.push(rows[i]);
            else if (timeOf(rows[i]) !== null) {
                prev = rows[i];
                break;
            }
        }
        const need = prev === null || dayKey(timeOf(prev)) !== dayKey(t);
        const want = midnight(t);
        const keep = need ? days.find(day => Number(day.dataset.time) === want) ?? makeDay(want) : null;
        for (const day of days) if (day !== keep) day.remove();
        if (keep && row.previousElementSibling !== keep) list.insertBefore(keep, row);
    }

    function nextTimed(list, row) {
        const rows = Array.from(list.children);
        for (let i = rows.indexOf(row) + 1; i < rows.length; i++) if (timeOf(rows[i]) !== null) return rows[i];
        return null;
    }

    // After an append or an insert of row: check the row and the next row with a time.
    function fixAround(list, row, makeDay) {
        const next = nextTimed(list, row);
        fixBefore(list, row, makeDay);
        if (next) fixBefore(list, next, makeDay);
    }

    // Before the removal of row: returns a function to call after the removal. It checks the next row with a time
    // and removes the day rows at the end of the list.
    function beforeRemove(list, row, makeDay) {
        const next = nextTimed(list, row);
        return () => {
            if (next) fixBefore(list, next, makeDay);
            let last = Array.from(list.children).at(-1);
            while (isDayRow(last)) {
                last.remove();
                last = Array.from(list.children).at(-1);
            }
        };
    }

    window.dayRowsCore = Object.freeze({ dayKey, midnight, dayLabel, isDayRow, timeOf, fixBefore, fixAround, beforeRemove });

    if (typeof document === 'undefined') return;

    // ---- DOM part ----

    const messageList = document.getElementById('messages');
    let labelDay = dayKey(Date.now());

    // id: the note ID of a roster note (data-note-id), or nothing. A row that is not a day row shows its time.
    function makeNote(kind, text, time, id = null) {
        const item = document.createElement('li');
        item.className = 'note';
        item.dataset.kind = kind;
        item.dataset.time = String(time);
        if (id) item.dataset.noteId = String(id);
        const span = document.createElement('span');
        span.className = 'note-text';
        span.textContent = String(text);
        item.append(span);
        if (kind !== 'day') {
            const timeSpan = document.createElement('span');
            timeSpan.className = 'time';
            timeSpan.textContent = clock(Number(time) || 0);
            timeSpan.title = new Date(Number(time) || 0).toLocaleString();
            item.append(timeSpan);
        }
        return item;
    }

    function makeDay(time) {
        return makeNote('day', dayLabel(time, Date.now()), time);
    }

    function allLists() {
        const lists = [messageList, ...(window.roomChannels?.storedLists?.() ?? [])];
        return lists.filter((list, i) => list && lists.indexOf(list) === i);
    }

    // Write the labels again when the local day changed since the last write.
    function checkDay() {
        const now = Date.now();
        const key = dayKey(now);
        if (key === labelDay) return;
        labelDay = key;
        for (const list of allLists()) {
            for (const row of Array.from(list.children)) {
                if (!isDayRow(row)) continue;
                const span = row.querySelector('.note-text');
                if (span) span.textContent = dayLabel(Number(row.dataset.time), now);
            }
        }
    }

    function placed(list, row) {
        checkDay();
        if (list) fixAround(list, row, makeDay);
    }

    // A note at the end of the list of a channel (default: general, for presence and link notes). Gap N5 gives the
    // channel of a file offer. The visible list keeps its reading position.
    // id: the note ID of a roster note, or nothing.
    function append(kind, text, time = Date.now(), channelId = 'general', id = null) {
        const list = window.roomChannels?.listFor(channelId) ?? messageList;
        if (!list) return null;
        const visible = list === messageList;
        const state = visible ? window.reading?.beforeChange() : null;
        const item = makeNote(kind, text, time, id);
        list.appendChild(item);
        placed(list, item);
        if (visible) window.reading?.afterChange(state);
        return item;
    }

    // Remove a row and make the day rows correct.
    function remove(row) {
        const list = row?.parentElement;
        if (!list) return;
        const after = beforeRemove(list, row, makeDay);
        row.remove();
        after();
    }

    function generalList() {
        return window.roomChannels?.listFor('general') ?? messageList;
    }

    // Remove the roster note with this note ID from the general list (a rejoin in 60 s replaces it).
    function removeNote(id) {
        const list = generalList();
        if (!list || !id) return;
        const row = Array.from(list.children).find(li => li.dataset?.noteId === String(id));
        if (row) remove(row);
    }

    // Saved presence lines ([{ id, kind, text, time }] of the archive) into the general list, each before the first
    // row that is newer. A note ID that is shown does not come again. The caller keeps the reading position.
    function restore(notes) {
        const list = generalList();
        if (!list || !Array.isArray(notes)) return 0;
        const shown = new Set(Array.from(list.children).map(li => li.dataset?.noteId).filter(Boolean));
        let count = 0;
        for (const n of notes) {
            const t = Number(n?.time);
            if (!n || typeof n.id !== 'string' || shown.has(n.id) || !Number.isFinite(t)) continue;
            if (n.kind !== 'presence' && n.kind !== 'link') continue;
            shown.add(n.id);
            const item = makeNote(n.kind, String(n.text ?? ''), t, n.id);
            const rows = Array.from(list.children);
            const i = rows.findIndex(li => Number(li.dataset?.time) > t);
            list.insertBefore(item, i < 0 ? null : rows[i]);
            placed(list, item);
            count++;
        }
        return count;
    }

    window.transcriptNotes = Object.freeze({ append, placed, remove, removeNote, restore, checkDay, makeNote });
    // Each minute: a new local day writes the labels again ("Today" becomes "Yesterday").
    setInterval(checkDay, 60 * 1000);
})();
