// The presence lines of the chat (joins, leaves, a lost link, the reconnect; operator request 2026-11-23): each line
// shows its time as a chat line, a rejoin in 60 s merges with the leave line, and a saved room that keeps history keeps
// the lines in its archive (room_notes), as local events of this PC: not in the host replay, at most 500 for each room,
// gone with Clear history and Forget. The window puts the saved lines back in time order on a reopen.
// No network, no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as roomArchive from '../src/application/room-archive.mjs';
import { createSavedRooms } from '../src/application/saved-rooms.mjs';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createClock } from './helpers/fake-clock.mjs';

const { openRoomArchive, roomFingerprint } = roomArchive;

// ---- The roster core (transcript-notes.js) ----

const source = await readFile(new URL('../src/application/transcript-notes.js', import.meta.url), 'utf8');
function loadCore() {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'transcript-notes.js' });
    return context.window.rosterNotesCore;
}
const { createRoster, HOLD_MS } = loadCore();
const T0 = new Date(2026, 10, 23, 20, 0, 0).getTime();
const noteActions = actions => Array.from(actions).filter(a => a.type === 'note');

function connected() {
    let n = 0;
    const roster = createRoster({ makeId: () => `n${++n}` });
    roster.joined('peer-a', T0 - 60000, 'Alice');
    roster.joined('peer-b', T0 - 60000, 'Bob');
    return roster;
}

test('each roster note has a note ID and no replaces', () => {
    const roster = connected();
    const [left] = noteActions(roster.left('peer-a', true, T0));
    assert.equal(left.text, 'Alice left the room.');
    assert.equal(typeof left.id, 'string');
    assert.ok(left.id.length > 0);
    assert.equal(left.replaces, null);
    // The default IDs are different for each note and fit the archive (letters, digits, - and _).
    const plain = createRoster({ creator: true });
    const ids = [...noteActions(plain.joined('p1', T0, 'One')), ...noteActions(plain.left('p1', true, T0 + 1)),
        ...noteActions(plain.joined('p2', T0 + 70000, 'Two'))].map(a => a.id);
    assert.equal(new Set(ids).size, 3);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
});

test('a leave (bye) and a rejoin in 60 s merge into one "<name> reconnected." line; at 61 s they do not', () => {
    const roster = connected();
    const [left] = noteActions(roster.left('peer-a', true, T0));
    const [back] = noteActions(roster.joined('peer-a', T0 + 59000));
    assert.equal(back.text, 'Alice reconnected.');
    assert.equal(back.replaces, left.id, 'the rejoin line takes the place of the leave line');
    assert.equal(back.time, T0 + 59000);

    const late = connected();
    late.left('peer-b', true, T0);
    const [joined] = noteActions(late.joined('peer-b', T0 + 61000));
    assert.equal(joined.text, 'Bob joined the room.');
    assert.equal(joined.replaces, null);
});

test('a lost connection and a rejoin in 60 s after the lost line merge', () => {
    const roster = connected();
    roster.left('peer-b', false, T0);
    const [lost] = noteActions(roster.tick(T0 + HOLD_MS));
    assert.equal(lost.text, 'Bob lost the connection.');
    const [back] = noteActions(roster.joined('peer-b', T0 + HOLD_MS + 30000));
    assert.deepEqual([back.text, back.replaces], ['Bob reconnected.', lost.id]);
    // A second leave and a rejoin merge again; a rejoin with no leave line before it is a join.
    const [again] = noteActions(roster.left('peer-b', true, T0 + 200000));
    const [second] = noteActions(roster.joined('peer-b', T0 + 210000));
    assert.deepEqual([second.text, second.replaces], ['Bob reconnected.', again.id]);
});

test('an app restart (a new peer ID) of the same person merges; an other device with the same name does not', () => {
    let n = 0;
    const roster = createRoster({ makeId: () => `n${++n}` });
    roster.joined('peer-a1', T0 - 60000, 'Alice', 'device:aaaaaa');
    roster.joined('peer-x', T0 - 60000, 'Xavier');
    const [left] = noteActions(roster.left('peer-a1', true, T0));
    // The name comes after the join (the name wait): the merge waits for it too.
    assert.deepEqual(noteActions(roster.joined('peer-a2', T0 + 20000)), []);
    const [back] = noteActions(roster.named('peer-a2', 'Alice', T0 + 20500, 'device:aaaaaa'));
    assert.deepEqual([back.text, back.replaces], ['Alice reconnected.', left.id]);

    const [left2] = noteActions(roster.left('peer-a2', true, T0 + 100000));
    const [other] = noteActions(roster.joined('peer-a3', T0 + 110000, 'Alice', 'device:bbbbbb'));
    assert.deepEqual([other.text, other.replaces], ['Alice joined the room.', null], 'an other device of the same name');
    assert.ok(left2.id);

    // No person key (a legacy room): the name is the person.
    const [xLeft] = noteActions(roster.left('peer-x', true, T0 + 200000));
    const [xBack] = noteActions(roster.joined('peer-x2', T0 + 230000, 'Xavier'));
    assert.deepEqual([xBack.text, xBack.replaces], ['Xavier reconnected.', xLeft.id]);
});

test('the own link lines have no time in the text: the time column shows it', () => {
    const roster = connected();
    roster.left('peer-a', false, T0);
    const [lost] = noteActions(roster.left('peer-b', false, T0));
    assert.deepEqual([lost.kind, lost.text], ['link', 'Connection lost.']);
    const [back] = noteActions(roster.joined('peer-a', T0 + 60000));
    assert.deepEqual([back.kind, back.text], ['link', 'Reconnected.']);
});

// ---- The window ----

async function roomWindow(options = {}) {
    const clock = createClock(new Date(2026, 10, 23, 20, 15, 0).getTime());
    const f = await loadRoomWindow({ clock, ...options });
    f.clock = clock;
    return f;
}

test('a join and a leave line show their time as a chat line (span.time); a day row has no time', async () => {
    const f = await roomWindow();
    await f.login('Me');
    f.handlers.onPeerJoined({ peerId: 'peer-bob' });
    f.handlers.onPeerName({ peerId: 'peer-bob', name: 'Bob' });
    f.clock.advance(2 * 60000);
    f.handlers.onPeerLeft({ peerId: 'peer-bob', left: true });
    const rows = f.el('messages').children.filter(li => li.classList.contains('note'));
    const day = rows.find(li => li.dataset.kind === 'day');
    assert.ok(day, 'the day row is there');
    assert.equal(day.querySelector('.time'), null);
    const presence = rows.filter(li => li.dataset.kind === 'presence');
    assert.deepEqual(presence.map(li => li.querySelector('.note-text').textContent), ['Bob joined the room.', 'Bob left the room.']);
    assert.deepEqual(presence.map(li => li.querySelector('.time')?.textContent), ['20:15', '20:17']);
    assert.ok(presence[0].querySelector('.time').title.length > 0, 'the full date and time in the tooltip');
    assert.deepEqual(f.errors, []);
});

test('the window gives each roster note to saveNote; a rejoin in 60 s removes the leave row', async () => {
    const f = await roomWindow();
    await f.login('Me');
    f.handlers.onPeerJoined({ peerId: 'peer-bob' });
    f.handlers.onPeerName({ peerId: 'peer-bob', name: 'Bob' });
    f.clock.advance(5000);
    f.handlers.onPeerLeft({ peerId: 'peer-bob', left: true });
    f.clock.advance(20000);
    f.handlers.onPeerJoined({ peerId: 'peer-bob' });
    const texts = f.notes().filter(n => n.kind !== 'day').map(n => n.text);
    assert.deepEqual(texts, ['Bob joined the room.', 'Bob reconnected.']);
    const saved = f.calls.filter(c => c.name === 'saveNote').map(c => c.args[0]);
    assert.deepEqual(saved.map(n => n.text), ['Bob joined the room.', 'Bob left the room.', 'Bob reconnected.']);
    assert.equal(saved[2].replaces, saved[1].id);
    assert.equal(saved[2].kind, 'presence');
    assert.equal(saved[2].time, f.clock.now());
    const rows = f.el('messages').children.filter(li => li.dataset.kind === 'presence');
    assert.deepEqual(rows.map(li => li.dataset.noteId), [saved[0].id, saved[2].id]);
    assert.deepEqual(f.errors, []);
});

test('the window: a restart of a peer (a new peer ID, the same name) in 60 s gives one "reconnected" row', async () => {
    const f = await roomWindow();
    await f.login('Me');
    f.handlers.onPeerJoined({ peerId: 'peer-bob-1' });
    f.handlers.onPeerName({ peerId: 'peer-bob-1', name: 'Bob' });
    f.clock.advance(5000);
    f.handlers.onPeerLeft({ peerId: 'peer-bob-1', left: true });
    f.clock.advance(15000);
    f.handlers.onPeerJoined({ peerId: 'peer-bob-2' });
    f.handlers.onPeerName({ peerId: 'peer-bob-2', name: 'Bob' });
    assert.deepEqual(f.notes().filter(n => n.kind !== 'day').map(n => n.text), ['Bob joined the room.', 'Bob reconnected.']);
    assert.deepEqual(f.errors, []);
});

// ---- The archive ----

const protector = { available: () => true, wrap: b => Buffer.concat([Buffer.from('p:'), b]), unwrap: b => Buffer.from(b.subarray(2)) };
const KEY = Buffer.alloc(32, 9);

function tempArchive(t, limits = null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-lines-'));
    const a = openRoomArchive({ dir, protector, limits });
    t.after(() => { a.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const { roomId } = a.saveRoom({ name: 'room', roomKey: KEY, keepHistory: true });
    return { a, roomId, dir };
}

const note = (id, time, text = `line ${id}`, kind = 'presence') => ({ id, kind, text, time });

test('the archive keeps the presence lines in time order, apart from the chat lines and the host replay', t => {
    const { a, roomId } = tempArchive(t);
    a.addMessage(roomId, { id: 'm1', from: 'Bob', text: 'hi', time: 2000, source: 'live', peerId: 'peer-bob' });
    assert.equal(a.addNote(roomId, note('n2', 3000, 'Bob left the room.')), true);
    assert.equal(a.addNote(roomId, note('n1', 1000, 'Bob joined the room.')), true);
    assert.equal(a.addNote(roomId, note('n3', 4000, 'Connection lost.', 'link')), true);
    assert.equal(a.addNote(roomId, note('n3', 4000, 'Connection lost.', 'link')), false, 'a saved note ID is not saved again');
    assert.deepEqual(a.listNotes(roomId).map(n => [n.id, n.kind, n.text, n.time]), [
        ['n1', 'presence', 'Bob joined the room.', 1000], ['n2', 'presence', 'Bob left the room.', 3000],
        ['n3', 'link', 'Connection lost.', 4000]]);
    assert.deepEqual(a.listNotes(roomId, { from: 1000, to: 4000 }).map(n => n.id), ['n1', 'n2'], 'from <= time < to');
    assert.deepEqual(a.listMessages(roomId).map(m => m.id), ['m1'], 'no note in the chat lines');
    assert.deepEqual(a.replayMessages(roomId).map(m => m.id), ['m1'], 'no note in the host replay');
    assert.equal(a.roomUsage(roomId).rows, 1);
    // A line that is not valid is not saved.
    for (const bad of [note('bad id', 5000), note('x', 0), note('y', 5000, ''), note('z', 5000, 'x'.repeat(301)),
        { ...note('k', 5000), kind: 'chat' }, note('i'.repeat(65), 5000)]) {
        assert.equal(a.addNote(roomId, bad), false, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal(a.listNotes(roomId).length, 3);
});

test('a note with replaces takes the place of the older note in one write', t => {
    const { a, roomId } = tempArchive(t);
    a.addNote(roomId, note('left', 1000, 'Bob left the room.'));
    a.addNote(roomId, { ...note('back', 30000, 'Bob reconnected.'), replaces: 'left' });
    assert.deepEqual(a.listNotes(roomId).map(n => n.text), ['Bob reconnected.']);
});

test('the cap: at most 500 presence lines for each room, the oldest go first', t => {
    const { a, roomId } = tempArchive(t);
    const cap = roomArchive.NOTE_LIMITS?.maxRows;
    assert.equal(cap, 500);
    const other = a.saveRoom({ name: 'other', roomKey: Buffer.alloc(32, 3), keepHistory: true }).roomId;
    a.addNote(other, note('o1', 1));
    for (let i = 0; i < cap + 5; i++) a.addNote(roomId, note(`n${i}`, 10000 + i));
    const kept = a.listNotes(roomId);
    assert.equal(kept.length, cap);
    assert.equal(kept[0].id, 'n5', 'the 5 oldest went');
    assert.equal(kept.at(-1).id, `n${cap + 4}`);
    assert.equal(a.listNotes(other).length, 1, 'the cap is for each room');
});

test('Clear history and Forget remove the presence lines', t => {
    const { a, roomId } = tempArchive(t);
    a.addMessage(roomId, { id: 'm1', from: 'Bob', text: 'hi', time: 2000, source: 'live', peerId: 'peer-bob' });
    a.addNote(roomId, note('n1', 1000));
    assert.deepEqual(a.clearMessages(roomId), ['m1'], 'Clear gives the message IDs only');
    assert.deepEqual(a.listNotes(roomId), []);
    a.addNote(roomId, note('n2', 3000));
    a.removeRoom(roomId);
    a.saveRoom({ name: 'room', roomKey: KEY, keepHistory: true });
    assert.deepEqual(a.listNotes(roomId), [], 'Forget removed the lines');
});

test('saved-rooms.mjs saves a note only for the open room that keeps history', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-saved-'));
    const rooms = createSavedRooms({ dir, protector });
    t.after(() => { rooms.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    assert.deepEqual(rooms.saveNote(note('n0', 500)), { saved: false }, 'no open room');
    const { roomId } = rooms.afterLogin({ room: 'room', roomKey: KEY, userName: 'Me', save: true, keepHistory: true });
    assert.equal(roomId, roomFingerprint('room', KEY));
    assert.deepEqual(rooms.saveNote(note('n1', 1000)), { saved: true });
    rooms.setKeepHistory(roomId, false);
    assert.deepEqual(rooms.saveNote(note('n2', 2000)), { saved: false });
    rooms.setKeepHistory(roomId, true);
    assert.deepEqual(rooms.saveNote({ ...note('n3', 3000), replaces: 'n1' }), { saved: true });
    assert.deepEqual(rooms.notes(roomId).map(n => n.id), ['n3']);
    rooms.clear(roomId);
    assert.deepEqual(rooms.notes(roomId), []);
});

// ---- The window puts the saved lines back ----

const STORAGE = ['save-room', 'keep-history', 'save-room-fields', 'save-off-note', 'saved-rooms', 'saved-rooms-section',
    'archive-state', 'archive-unlock', 'room-storage', 'history-toggle', 'room-keep-history', 'history-state',
    'clear-history', 'clear-confirm', 'clear-confirm-yes', 'clear-confirm-no'];
const INPUTS = new Set(['save-room', 'keep-history', 'room-keep-history']);

async function savedRoomWindow(api) {
    const f = await roomWindow({
        scripts: ['saved-rooms-ui.js'],
        elements: STORAGE.map(id => ({ id, tag: INPUTS.has(id) ? 'input' : id === 'saved-rooms' ? 'ul' : 'div' })),
        api: { listSavedRooms: async () => ({ state: 'open', rooms: [{ roomId: 'room-1', name: 'Room', userName: 'Me', protected: true }] }), ...api }
    });
    await settle();
    return f;
}

// The rows of #messages with no day rows: chat lines by ID, note rows by text.
const order = f => f.el('messages').children.filter(li => li.dataset.kind !== 'day')
    .map(li => li.dataset.id ?? li.querySelector('.note-text').textContent);

const T = new Date(2026, 10, 22, 19, 0, 0).getTime();
const LINES = [{ id: 'm1', from: 'Bob', text: 'one', time: T + 2000 }, { id: 'm2', from: 'Me', text: 'two', time: T + 5000, own: true }];
const NOTES = [note('n1', T + 1000, 'Bob joined the room.'), note('n2', T + 3000, 'Carol joined the room.'),
    note('n3', T + 6000, 'Bob left the room.')];

test('a reopen puts the saved presence lines in time order with the chat lines, one time', async () => {
    const ranges = [];
    const f = await savedRoomWindow({
        savedRoomLines: async () => LINES.map(l => ({ ...l })),
        savedRoomNotes: async (roomId, range) => { ranges.push([roomId, { ...range }]); return NOTES.map(n => ({ ...n })); },
        reopenRoom: async () => ({ room: 'Room', internet: false, savedRoom: true, roomId: 'room-1', keepHistory: true })
    });
    f.el('saved-rooms').querySelector('.reopen-room').click();
    await settle();
    await settle();
    assert.deepEqual(order(f), ['Bob joined the room.', 'm1', 'Carol joined the room.', 'm2', 'Bob left the room.']);
    assert.deepEqual(ranges, [['room-1', { from: null, to: null }]], 'a short page: all the saved lines');
    const times = f.el('messages').children.filter(li => li.dataset.kind === 'presence').map(li => li.querySelector('.time').textContent);
    assert.deepEqual(times, ['19:00', '19:00', '19:00']);
    // The general channel opens again: no second copy.
    f.window.savedRoomsUi.channelOpened('general');
    await settle();
    assert.equal(order(f).length, 5);
    assert.deepEqual(f.errors, []);
});

test('a login into a saved room loads the presence lines with the first page; a full page limits the range', async () => {
    const full = Array.from({ length: 200 }, (_, n) => ({ id: `m${n}`, from: 'Bob', text: `l${n}`, time: T + 10000 + n }));
    const ranges = [];
    const f = await savedRoomWindow({
        savedRoomLines: async () => full,
        savedRoomNotes: async (roomId, range) => { ranges.push({ ...range }); return [note('n1', T + 10050, 'Bob left the room.')]; }
    });
    f.window.asscrack.login = async value => ({ room: value.room, internet: false, savedRoom: true, roomId: 'room-1' });
    await f.login('Me');
    await settle();
    assert.deepEqual(ranges, [{ from: T + 10000, to: null }]);
    const rows = order(f);
    assert.equal(rows.indexOf('Bob left the room.'), rows.indexOf('m50') + 1);
    assert.deepEqual(f.errors, []);
});
