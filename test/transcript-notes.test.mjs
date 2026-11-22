// Gaps B1 and D6: the pure parts of transcript-notes.js (window.rosterNotesCore and window.dayRowsCore) with a clock
// that the test gives, and the day rows of the DOM part on the fake DOM. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom } from './helpers/fake-dom.mjs';

const source = await readFile(new URL('../src/application/transcript-notes.js', import.meta.url), 'utf8');

function loadCore() {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'transcript-notes.js' });
    return context.window;
}

const { rosterNotesCore, dayRowsCore } = loadCore();
const { createRoster, HOLD_MS } = rosterNotesCore;

const T0 = new Date(2026, 10, 21, 21, 4, 0).getTime();
const notes = actions => Array.from(actions).filter(a => a.type === 'note').map(a => a.text);
const buddy = actions => Array.from(actions).filter(a => a.type !== 'note').map(a => `${a.type} ${a.peerId}`);

// A roster with peers A and B connected long ago (no quiet time).
function connected(options = {}) {
    const roster = createRoster(options);
    roster.joined('peer-a', T0 - 60000, 'Alice');
    roster.joined('peer-b', T0 - 60000, 'Bob');
    return roster;
}

test('the loader gives the cores with no DOM', () => {
    const win = loadCore();
    assert.equal(win.transcriptNotes, undefined);
    assert.equal(typeof win.rosterNotesCore.createRoster, 'function');
    assert.equal(typeof win.dayRowsCore.fixAround, 'function');
});

test('bye: the buddy line goes and "<name> left the room." comes at once', () => {
    const roster = connected();
    const actions = roster.left('peer-a', true, T0);
    assert.deepEqual(buddy(actions), ['remove peer-a']);
    assert.deepEqual(notes(actions), ['Alice left the room.']);
    assert.equal(roster.link().peers, 1);
});

test('no bye: a grey line for 10 s; back in 9 s gives no note, gone at 10 s gives the note', () => {
    const roster = connected();
    let actions = roster.left('peer-a', false, T0);
    assert.deepEqual(buddy(actions), ['grey peer-a']);
    assert.deepEqual(notes(actions), []);
    assert.equal(roster.link().peers, 1, 'a grey line does not count');
    assert.equal(roster.nextDue(), T0 + HOLD_MS);
    actions = roster.joined('peer-a', T0 + 9000);
    assert.deepEqual(buddy(actions), ['restore peer-a']);
    assert.deepEqual(notes(actions), [], 'no join note for a peer back in its 10 s');
    assert.deepEqual(notes(roster.tick(T0 + 20000)), []);

    roster.left('peer-b', false, T0 + 30000);
    assert.deepEqual(Array.from(roster.tick(T0 + 30000 + 9999)), []);
    actions = roster.tick(T0 + 30000 + HOLD_MS);
    assert.deepEqual(buddy(actions), ['remove peer-b']);
    assert.deepEqual(notes(actions), ['Bob lost the connection.']);
});

test('own loss: one link note, no "lost the connection" notes, then the return and the 10 s after it', () => {
    const roster = connected();
    roster.left('peer-a', false, T0);
    const lost = roster.left('peer-b', false, T0 + 500);
    assert.deepEqual(notes(lost), ['Connection lost at 21:04.']);
    const link = roster.link();
    assert.equal(link.peers, 0);
    assert.equal(link.seen, true);
    assert.equal(link.allBye, false);
    assert.equal(link.lostAt, T0 + 500);
    // The grey times end during the loss: the lines go, the notes wait.
    const held = roster.tick(T0 + 60000);
    assert.deepEqual(buddy(held).sort(), ['remove peer-a', 'remove peer-b']);
    assert.deepEqual(notes(held), []);
    // The return at 21:05: Alice comes back; Bob does not.
    const ret = new Date(2026, 10, 21, 21, 5, 10).getTime();
    const back = roster.joined('peer-a', ret);
    assert.deepEqual(notes(back), ['Reconnected at 21:05.'], 'no join note for a peer that was there before the loss');
    assert.equal(roster.link().restoredAt, ret);
    assert.deepEqual(notes(roster.tick(ret + 9999)), []);
    assert.deepEqual(notes(roster.tick(ret + HOLD_MS)), ['Bob lost the connection.']);
    assert.equal(roster.nextDue(), null);
});

test('everyone said bye: no link note, allBye is true', () => {
    const roster = connected();
    assert.deepEqual(notes(roster.left('peer-a', true, T0)), ['Alice left the room.']);
    assert.deepEqual(notes(roster.left('peer-b', true, T0 + 1000)), ['Bob left the room.']);
    assert.equal(roster.link().allBye, true);
    assert.equal(roster.link().peers, 0);
    // A later join is not a reconnection: it gets the join note.
    assert.deepEqual(notes(roster.joined('peer-c', T0 + 5000, 'Carol')), ['Carol joined the room.']);
    assert.equal(roster.link().restoredAt, null);
});

test('the 3 s rule: no join notes in the 3 s after the own first connection, then notes', () => {
    const roster = createRoster({ creator: false });
    assert.deepEqual(notes(roster.joined('peer-a', T0, 'Alice')), []);
    assert.deepEqual(notes(roster.joined('peer-b', T0 + 2999, 'Bob')), []);
    assert.deepEqual(notes(roster.joined('peer-c', T0 + 3000, 'Carol')), ['Carol joined the room.']);
});

test('the 3 s rule after the own reconnection', () => {
    const roster = connected();
    roster.left('peer-a', false, T0);
    roster.left('peer-b', false, T0);
    roster.joined('peer-a', T0 + 60000);
    assert.deepEqual(notes(roster.joined('peer-c', T0 + 62000, 'Carol')), []);
    assert.deepEqual(notes(roster.joined('peer-d', T0 + 63000, 'Dave')), ['Dave joined the room.']);
});

test('the creator always gets the join note of the first friend', () => {
    const roster = createRoster({ creator: true });
    assert.deepEqual(notes(roster.joined('peer-a', T0, 'Alice')), ['Alice joined the room.']);
});

test('the name wait: a note waits 2 s for the name, then uses 12 characters of the peer ID', () => {
    const roster = createRoster({ creator: true });
    assert.deepEqual(notes(roster.joined('12D3KooWAbcdefghijk', T0)), []);
    assert.equal(roster.nextDue(), T0 + 2000);
    assert.deepEqual(notes(roster.named('12D3KooWAbcdefghijk', 'Alice', T0 + 500)), ['Alice joined the room.']);

    const late = createRoster({ creator: true });
    late.joined('12D3KooWZyxwvutsrq', T0);
    assert.deepEqual(notes(late.tick(T0 + 1999)), []);
    assert.deepEqual(notes(late.tick(T0 + 2000)), ['12D3KooWZyxw joined the room.']);
    assert.deepEqual(notes(late.named('12D3KooWZyxwvutsrq', 'Zed', T0 + 2500)), [], 'no second note');
});

// ---- Day rows ----

const { dayLabel, fixAround, beforeRemove, isDayRow } = dayRowsCore;

function makeList() {
    const { document } = createDom([{ id: 'messages', tag: 'ul' }]);
    return { document, list: document.getElementById('messages') };
}

function row(document, time, text = 'line') {
    const li = document.createElement('li');
    li.dataset.time = String(time);
    const from = document.createElement('span');
    from.className = 'from';
    from.textContent = 'Alice';
    li.append(from, text);
    return li;
}

function dayMaker(document) {
    return time => {
        const li = document.createElement('li');
        li.className = 'note';
        li.dataset.kind = 'day';
        li.dataset.time = String(time);
        return li;
    };
}

// The list as text: "D<day of month>" for a day row, "<hour>:<minute>" for a row.
function shape(list) {
    return Array.from(list.children).map(li => {
        const d = new Date(Number(li.dataset.time));
        return isDayRow(li) ? `D${d.getDate()}` : `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    });
}

const day = (date, h, m) => new Date(2026, 10, date, h, m).getTime();

test('day rows: live lines over midnight', () => {
    const { document, list } = makeList();
    const make = dayMaker(document);
    for (const t of [day(20, 23, 58), day(20, 23, 59), day(21, 0, 1), day(21, 0, 2)]) {
        const li = row(document, t);
        list.appendChild(li);
        fixAround(list, li, make);
    }
    assert.deepEqual(shape(list), ['D20', '23:58', '23:59', 'D21', '0:01', '0:02']);
    const dayRows = Array.from(list.children).filter(isDayRow);
    assert.equal(Number(dayRows[1].dataset.time), new Date(2026, 10, 21).getTime(), 'the day row has the time of local midnight');
});

// Insert with the same rule as insertMessage of renderer.js (readingCore.insertIndex: after the last time <= t).
function insert(list, li, make) {
    const items = Array.from(list.children);
    const t = Number(li.dataset.time);
    const at = items.findIndex(x => Number(x.dataset.time) > t);
    list.insertBefore(li, at < 0 ? null : items[at]);
    fixAround(list, li, make);
}

test('day rows: a history insert in the middle', () => {
    const { document, list } = makeList();
    const make = dayMaker(document);
    for (const t of [day(19, 10, 0), day(21, 9, 0)]) insert(list, row(document, t), make);
    assert.deepEqual(shape(list), ['D19', '10:00', 'D21', '9:00']);
    insert(list, row(document, day(20, 12, 0)), make);
    assert.deepEqual(shape(list), ['D19', '10:00', 'D20', '12:00', 'D21', '9:00']);
    insert(list, row(document, day(21, 8, 0)), make);
    assert.deepEqual(shape(list), ['D19', '10:00', 'D20', '12:00', 'D21', '8:00', '9:00']);
    insert(list, row(document, day(19, 11, 0)), make);
    assert.deepEqual(shape(list), ['D19', '10:00', '11:00', 'D20', '12:00', 'D21', '8:00', '9:00']);
});

test('day rows: an older page at the top', () => {
    const { document, list } = makeList();
    const make = dayMaker(document);
    for (const t of [day(21, 9, 0), day(21, 10, 0)]) insert(list, row(document, t), make);
    assert.deepEqual(shape(list), ['D21', '9:00', '10:00']);
    // The older page: a line of the same day and lines of the day before.
    for (const t of [day(20, 22, 0), day(20, 23, 0), day(21, 8, 30)]) insert(list, row(document, t), make);
    assert.deepEqual(shape(list), ['D20', '22:00', '23:00', 'D21', '8:30', '9:00', '10:00']);
});

test('day rows: a removed row leaves no extra day row', () => {
    const { document, list } = makeList();
    const make = dayMaker(document);
    const a = row(document, day(20, 10, 0));
    const b = row(document, day(21, 10, 0));
    for (const li of [a, b]) insert(list, li, make);
    const after = beforeRemove(list, b, make);
    b.remove();
    after();
    assert.deepEqual(shape(list), ['D20', '10:00']);
});

test('day labels: Today, Yesterday by the calendar, else the long local date', () => {
    const now = day(21, 0, 30);
    assert.equal(dayLabel(day(21, 0, 1), now), 'Today');
    assert.equal(dayLabel(day(20, 0, 1), now), 'Yesterday');
    assert.equal(dayLabel(day(19, 23, 0), now), new Date(day(19, 23, 0)).toLocaleDateString(undefined,
        { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    // Over a change of the clock time (March in Europe): still by the calendar.
    assert.equal(dayLabel(new Date(2026, 2, 29, 0, 30).getTime(), new Date(2026, 2, 30, 0, 10).getTime()), 'Yesterday');
});

test('day labels: the DOM part writes the labels again after the local day changes', () => {
    const { document, window } = createDom([{ id: 'messages', tag: 'ul' }]);
    let now = day(21, 23, 50);
    class FakeDate extends Date {
        constructor(...args) { if (args.length) super(...args); else super(now); }
        static now() { return now; }
    }
    const intervals = [];
    const context = { window, document, Date: FakeDate, setInterval: fn => intervals.push(fn), clearInterval() {} };
    window.document = document;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'transcript-notes.js' });
    const notesDom = window.transcriptNotes;
    const list = document.getElementById('messages');
    const note = notesDom.append('presence', 'Alice joined the room.', now);
    assert.equal(note.dataset.kind, 'presence');
    assert.equal(note.querySelector('.from'), null);
    assert.equal(note.querySelector('.text'), null);
    assert.equal(note.dataset.id, undefined);
    const label = () => list.children.find(isDayRow).querySelector('.note-text').textContent;
    assert.equal(label(), 'Today');
    now = day(22, 0, 1);
    assert.equal(intervals.length, 1, 'one check each minute');
    intervals[0]();
    assert.equal(label(), 'Yesterday');
});
