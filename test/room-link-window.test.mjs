// Goal G2 in the room window: note rows, the grey buddy line, the room-link state, Send again (B3), the day rows (D6)
// and the status notices (N4). The real scripts run in the fake DOM (helpers/renderer-fixture.mjs) with the clock of
// helpers/fake-clock.mjs. No network, no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createClock } from './helpers/fake-clock.mjs';

const ELEMENTS = [{ id: 'waiting-peer', tag: 'p', hidden: true }];

async function roomWindow(options = {}) {
    const clock = createClock();
    const f = await loadRoomWindow({ elements: ELEMENTS, clock, ...options });
    f.clock = clock;
    f.waiting = () => {
        const box = f.el('waiting-peer');
        return box.hidden ? null : box.textContent;
    };
    f.link = () => f.el('statusbar').dataset.link ?? '';
    return f;
}

// A login as a joiner (the room type "Join with invite code").
async function joinRoom(f, name = 'Me') {
    f.el('room-type').value = 'join';
    f.el('room-type').dispatchEvent(new f.Event('change'));
    f.el('invite-input').value = 'invite-code';
    f.el('username').value = name;
    f.el('login').click();
    await settle();
}

function peer(f, peerId, name) {
    f.handlers.onPeerJoined({ peerId });
    if (name) f.handlers.onPeerName({ peerId, name });
}

const noteTexts = f => f.notes().filter(n => n.kind !== 'day').map(n => n.text);
const peerLine = (f, peerId) => f.el('peers').children.find(li => li.dataset.peerId === peerId) ?? null;

test('a message after a note row gives no error, and no line groups over the note', async () => {
    const f = await roomWindow();
    await f.login('Me');
    peer(f, 'peer-alice', 'Alice');
    assert.deepEqual(noteTexts(f), ['Alice joined the room.'], 'the creator gets the join note of the first friend');
    const first = f.receive({ id: 'm1', from: 'Alice', text: 'one', peerId: 'peer-alice', time: f.clock.now() });
    const second = f.receive({ id: 'm2', from: 'Alice', text: 'two', peerId: 'peer-alice', time: f.clock.now() + 1000 });
    assert.equal(first.classList.contains('cont'), false);
    assert.equal(second.classList.contains('cont'), true, 'two lines of one user group');
    // After the 3 s of the own first connection: Bob gets a join note.
    f.clock.advance(3000);
    f.handlers.onPeerJoined({ peerId: 'peer-bob' });
    f.handlers.onPeerName({ peerId: 'peer-bob', name: 'Bob' });
    const third = f.receive({ id: 'm3', from: 'Alice', text: 'three', peerId: 'peer-alice', time: f.clock.now() + 2000 });
    assert.equal(third.previousElementSibling.classList.contains('note'), true);
    assert.equal(third.classList.contains('cont'), false, 'no group over a note row');
    assert.deepEqual(f.errors, []);
});

test('rowInfo of a note row is null and the row menu skips it', async () => {
    const f = await roomWindow();
    await f.login('Me');
    peer(f, 'peer-alice', 'Alice');
    const notes = f.el('messages').children.filter(li => li.classList.contains('note'));
    assert.ok(notes.length >= 1);
    for (const row of notes) {
        assert.equal(f.window.roomActions.rowInfo(row), null);
        assert.equal(row.dataset.id, undefined);
        assert.equal(row.querySelector('.from'), null);
        assert.equal(row.querySelector('.text'), null);
        assert.equal(row.querySelector('button'), null);
    }
    assert.equal(f.window.reading.unreadCount(), 0, 'a note row is never unread');
});

test('a quit (bye) removes the line and gives "left the room."; then "Everyone left the room."', async () => {
    const f = await roomWindow();
    await f.login('Me');
    peer(f, 'peer-bob', 'Bob');
    assert.equal(f.waiting(), null, 'hidden with 1 peer');
    f.handlers.onPeerLeft({ peerId: 'peer-bob', left: true });
    assert.equal(peerLine(f, 'peer-bob'), null);
    assert.deepEqual(noteTexts(f), ['Bob joined the room.', 'Bob left the room.']);
    assert.equal(f.waiting(), 'Everyone left the room. Waiting for a peer.');
    assert.equal(f.link(), '');
});

test('a drop (no bye): a grey line for 10 s, out of the count; back in 9 s gives no note', async () => {
    const f = await roomWindow();
    await f.login('Me');
    peer(f, 'peer-bob', 'Bob');
    peer(f, 'peer-carol', 'Carol');
    f.handlers.onPeerLeft({ peerId: 'peer-bob', left: false });
    const grey = peerLine(f, 'peer-bob');
    assert.ok(grey, 'the line stays');
    assert.equal(grey.classList.contains('lost'), true);
    assert.equal(grey.querySelector('.voice-state').textContent, 'connection lost');
    assert.equal(f.el('peer-count').textContent, '2', 'Carol and me');
    assert.equal(f.window.roomActions.rowInfo(grey), null, 'no menu');
    assert.ok(!f.el('file-recipient').children.some(o => o.value === 'peer-bob'), 'no file recipient');
    f.clock.advance(9000);
    f.handlers.onPeerJoined({ peerId: 'peer-bob' });
    assert.equal(peerLine(f, 'peer-bob'), grey, 'the same line comes back');
    assert.equal(grey.classList.contains('lost'), false);
    f.clock.advance(20000);
    assert.deepEqual(noteTexts(f), ['Bob joined the room.'], 'no join note and no lost note');

    f.handlers.onPeerLeft({ peerId: 'peer-carol', left: false });
    f.clock.advance(9999);
    assert.ok(peerLine(f, 'peer-carol'));
    f.clock.advance(1);
    assert.equal(peerLine(f, 'peer-carol'), null);
    assert.deepEqual(noteTexts(f).at(-1), 'Carol lost the connection.');
    assert.deepEqual(f.errors, []);
});

test('the own loss: one link note, "Connection lost at …" with Details and the reconnecting key, then Reconnected', async () => {
    const f = await roomWindow();
    let opened = null;
    f.window.roomActivity = { openPeer: (...args) => { opened = args; } };
    await f.login('Me');
    peer(f, 'peer-bob', 'Bob');
    f.clock.advance(60000);
    const lostAt = f.clock.now();
    f.handlers.onPeerLeft({ peerId: 'peer-bob', left: false });
    const clockText = f.window.roomLinkCore.clock(lostAt);
    assert.equal(f.waiting(), `Connection lost at ${clockText}. Reconnecting… Details`);
    assert.equal(f.link(), 'reconnecting');
    assert.equal(noteTexts(f).at(-1), `Connection lost at ${clockText}.`);
    f.el('waiting-peer').querySelector('button').click();
    assert.equal(opened[0], null, 'Details opens Room activity for the room');
    f.clock.advance(30000);
    assert.equal(noteTexts(f).filter(t => /lost the connection/.test(t)).length, 0, 'no lost note during the own loss');
    f.handlers.onPeerJoined({ peerId: 'peer-bob' });
    assert.equal(noteTexts(f).at(-1), `Reconnected at ${f.window.roomLinkCore.clock(f.clock.now())}.`);
    assert.equal(f.waiting(), null);
    assert.equal(f.link(), 'reconnected');
    f.clock.advance(5000);
    assert.equal(f.link(), '', 'Ready after 5 s');
    assert.deepEqual(f.errors, []);
});

test('a joiner: "Connecting to the room…" for 19 s, the long text and Details at 20 s', async () => {
    const f = await roomWindow();
    await joinRoom(f);
    assert.equal(f.waiting(), 'Connecting to the room…');
    assert.equal(f.link(), 'connecting');
    f.clock.advance(19000);
    assert.equal(f.waiting(), 'Connecting to the room…');
    f.clock.advance(1000);
    assert.equal(f.waiting(), 'Can\'t reach the room yet. Another member needs to be online. Retrying… Details');
    // The first connection: no join notes in 3 s.
    peer(f, 'peer-owner', 'Owner');
    assert.equal(f.waiting(), null);
    assert.equal(f.link(), '');
    assert.deepEqual(noteTexts(f), []);
});

test('a creator: the Invite text and "Ready"', async () => {
    const f = await roomWindow();
    await f.login('Me');
    assert.equal(f.waiting(), 'Waiting for a peer. Select Invite to add a friend’s device.');
    assert.equal(f.link(), '');
});

test('Send again: 0 accepting peers keeps the row; 1 moves the line to the end', async () => {
    const answers = [{ id: 'm1', time: 1000, accepted: 0 }, { id: 'm2', time: 2000, accepted: 0 }, { id: 'm3', time: 3000, accepted: 1 }];
    const sent = [];
    const f = await roomWindow({ send: async (...args) => { sent.push(args); return answers.shift(); } });
    await f.login('Me');
    f.el('message-input').value = 'are you there';
    f.el('send').click();
    await settle();
    const row = f.rows().at(-1);
    assert.equal(row.classList.contains('local-only'), true);
    const button = row.querySelector('[data-action="resend"]');
    assert.equal(button.textContent, 'Send again');
    const menu = f.window.menuCore.actionsFor(f.window.roomActions.rowInfo(row));
    assert.ok(menu.includes('resend'));
    assert.equal(f.window.menuCore.label('resend'), 'Send again');

    button.click();
    await settle();
    assert.equal(f.el('status').textContent, 'Not sent: no one is connected.');
    assert.equal(row.isConnected, true);

    // A peer comes: one line was not sent.
    peer(f, 'peer-bob', 'Bob');
    assert.equal(f.el('status').textContent, '1 message was not sent. Select “Send again” on it.');
    f.receive({ id: 'p1', from: 'Bob', text: 'hi', peerId: 'peer-bob', time: 2500 });

    assert.equal(await f.window.roomActions.run('resend', row), true);
    assert.equal(row.isConnected, false, 'the old row goes');
    const last = f.rows().at(-1);
    assert.equal(last.querySelector('.text').textContent, 'are you there');
    assert.equal(last.dataset.id, 'm3');
    assert.equal(last.classList.contains('local-only'), false);
    assert.deepEqual(sent.map(args => args[0]), ['are you there', 'are you there', 'are you there']);
    assert.equal(f.el('status').textContent, '');
    assert.deepEqual(f.errors, []);
});

test('the count of lines that were not sent, with 2 lines', async () => {
    const f = await roomWindow({ send: async () => ({ id: `m${Math.random()}`, time: 1000, accepted: 0 }) });
    await f.login('Me');
    for (const text of ['one', 'two']) {
        f.el('message-input').value = text;
        f.el('send').click();
        await settle();
    }
    peer(f, 'peer-bob', 'Bob');
    assert.equal(f.el('status').textContent, '2 messages were not sent. Select “Send again” on each one.');
});

test('"Message copied." clears after 6 s; an error text stays', async () => {
    const f = await roomWindow();
    await f.login('Me');
    const row = f.receive({ id: 'm1', from: 'Alice', text: 'copy me', peerId: 'peer-alice', time: f.clock.now() });
    assert.equal(await f.window.roomActions.run('copy-message', row), true);
    assert.equal(f.el('status').textContent, 'Message copied.');
    f.clock.advance(5999);
    assert.equal(f.el('status').textContent, 'Message copied.');
    f.clock.advance(1);
    assert.equal(f.el('status').textContent, '');

    // A different text in the 6 s stays.
    await f.window.roomActions.run('copy-message', row);
    f.window.roomActions.notice('Name copied.');
    f.el('status').textContent = 'Error: something failed';
    f.clock.advance(7000);
    assert.equal(f.el('status').textContent, 'Error: something failed');
});

test('day rows: a day row before the first line and at a new day; .time has the full date', async () => {
    const f = await roomWindow();
    await f.login('Me');
    const day1 = new Date(2026, 10, 20, 23, 59).getTime();
    const day2 = new Date(2026, 10, 21, 0, 1).getTime();
    const a = f.receive({ id: 'm1', from: 'Alice', text: 'late', peerId: 'peer-alice', time: day1 });
    const b = f.receive({ id: 'm2', from: 'Alice', text: 'early', peerId: 'peer-alice', time: day2 });
    const days = f.notes().filter(n => n.kind === 'day').map(n => n.text);
    assert.deepEqual(days, ['Yesterday', 'Today']);
    assert.equal(b.classList.contains('cont'), false, 'no group over a day row');
    assert.equal(a.querySelector('.time').title, new Date(day1).toLocaleString());
    // An older history line on the first day goes after the first day row.
    f.history([{ id: 'h1', from: 'Alice', text: 'older', time: new Date(2026, 10, 20, 10, 0).getTime() }]);
    const kinds = f.el('messages').children.map(li => li.classList.contains('note') ? li.dataset.kind : li.dataset.id);
    assert.deepEqual(kinds, ['day', 'h1', 'm1', 'day', 'm2']);
    assert.deepEqual(f.errors, []);
});
