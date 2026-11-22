// Gaps A2, A4 and B2: the pure part of room-link.js (window.roomLinkCore) with a clock that the test gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/room-link.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'room-link.js' });
const { view, clock, TEXTS } = context.window.roomLinkCore;

const START = new Date(2026, 10, 21, 21, 0, 0).getTime();
const base = { role: 'joiner', owner: false, admitted: true, revoked: false, peers: 0, seen: false, startedAt: START,
    lostAt: null, allBye: true, restoredAt: null };
const at = (input, ms) => ({ ...view({ ...base, ...input, now: START + ms }) });

test('the loader gives the core with no DOM', () => {
    assert.equal(context.window.roomLink, undefined);
    assert.equal(typeof view, 'function');
});

test('revoked: the revoked text and no link key', () => {
    const r = at({ revoked: true, peers: 2, seen: true }, 0);
    assert.equal(r.text, 'This device’s access was revoked.');
    assert.equal(r.link, '');
    assert.equal(r.details, false);
});

test('creator with no peer seen: the Invite text, "Ready", also after 20 s', () => {
    for (const ms of [0, 19000, 20000, 600000]) {
        const r = at({ role: 'creator', owner: true }, ms);
        assert.equal(r.text, 'Waiting for a peer. Select Invite to add a friend’s device.');
        assert.equal(r.link, '');
        assert.equal(r.details, false);
    }
});

test('reopen as owner with no peer seen: "Waiting for a peer."', () => {
    const r = at({ role: 'reopen', owner: true }, 25000);
    assert.equal(r.text, 'Waiting for a peer.');
    assert.equal(r.link, '');
});

test('not admitted: the owner text before 20 s, the long text and Details at 20 s', () => {
    const early = at({ admitted: false }, 19000);
    assert.equal(early.text, 'Connecting to the room owner…');
    assert.equal(early.details, false);
    assert.equal(early.link, 'connecting');
    assert.equal(early.recheckAt, START + 20000);
    const late = at({ admitted: false }, 20000);
    assert.equal(late.text, 'Cannot reach the room owner yet. The owner must be online for your first join. ASSCRACK tries again each few seconds.');
    assert.equal(late.details, true);
    assert.equal(late.link, 'connecting');
    assert.equal(late.recheckAt, null);
});

test('joiner and reopen as member: the room text before 20 s, the long text and Details at 20 s', () => {
    for (const room of [{ role: 'joiner' }, { role: 'reopen', owner: false }]) {
        const early = at(room, 19000);
        assert.equal(early.text, 'Connecting to the room…');
        assert.equal(early.details, false);
        assert.equal(early.link, 'connecting');
        const late = at(room, 20000);
        assert.equal(late.text, 'Cannot reach the room yet. A different member must be online. ASSCRACK tries again each few seconds.');
        assert.equal(late.details, true);
        assert.equal(late.link, 'connecting');
    }
});

test('a peer was seen, 0 peers, no bye from one: "Connection lost at <local time>. Reconnecting…" and Details', () => {
    const lostAt = new Date(2026, 10, 21, 21, 4, 30).getTime();
    for (const room of [{ role: 'creator', owner: true }, { role: 'joiner' }, { role: 'reopen', owner: true }]) {
        const r = at({ ...room, seen: true, lostAt, allBye: false }, 300000);
        assert.equal(r.text, 'Connection lost at 21:04. Reconnecting…');
        assert.equal(r.details, true);
        assert.equal(r.link, 'reconnecting');
    }
    assert.equal(clock(lostAt), '21:04');
});

test('a peer was seen, 0 peers, each one said bye: "Everyone left the room. Waiting for a peer."', () => {
    const r = at({ role: 'joiner', seen: true, lostAt: START, allBye: true }, 1000);
    assert.equal(r.text, 'Everyone left the room. Waiting for a peer.');
    assert.equal(r.details, false);
    assert.equal(r.link, '');
});

test('1 or more peers: hidden, "Reconnected" for 5 s after a loss ends', () => {
    const plain = at({ peers: 1, seen: true }, 0);
    assert.equal(plain.text, '');
    assert.equal(plain.link, '');
    const restoredAt = START + 1000;
    const r = at({ peers: 1, seen: true, restoredAt }, 1000 + 4999);
    assert.equal(r.text, '');
    assert.equal(r.link, 'reconnected');
    assert.equal(r.recheckAt, restoredAt + 5000);
    assert.equal(at({ peers: 1, seen: true, restoredAt }, 1000 + 5000).link, '');
});

test('no text says that voice recovered', () => {
    for (const text of Object.values(TEXTS)) assert.doesNotMatch(text, /voice/i);
});
