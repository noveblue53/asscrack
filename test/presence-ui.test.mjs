// The manual status UI of renderer.js (milestone 3), with the real scripts in the fake DOM
// (test/helpers/renderer-fixture.mjs): the badge of each buddy line, the own state controls, the state read after
// login, and Do not disturb with no effect on the voice view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const SAM_A = '12D3KooWsamAAAAAAaaaa01';
const SAM_B = '12D3KooWsamBBBBBBbbbb02';
const ALEX = '12D3KooWalexCCCCCcccc03';

// options.bridge: extra calls of window.asscrack (for example getPresence), set before the login.
async function room(options = {}) {
    const f = await loadRoomWindow(options);
    Object.assign(f.window.asscrack, options.bridge ?? {});
    await f.login('Me');
    for (const [peerId, name] of options.peers ?? [[SAM_A, 'Sam'], [SAM_B, 'Sam']]) {
        f.handlers.onPeerJoined({ peerId });
        f.handlers.onPeerName({ peerId, name });
    }
    return f;
}

function line(f, peerId) {
    return f.el('peers').children.find(li => li.dataset.peerId === peerId) ?? null;
}

function badge(f, peerId) {
    return line(f, peerId).querySelector('.presence-mark');
}

function selfBadge(f) {
    return f.el('peers').children.find(li => li.classList.contains('self')).querySelector('.presence-mark');
}

test('a presence event sets the badge text and the note of the right buddy', async () => {
    const f = await room();
    f.handlers.onPresence({ peerId: SAM_B, state: 'away', note: 'back at 9' });
    assert.equal(badge(f, SAM_B).textContent, 'Away: back at 9');
    assert.equal(badge(f, SAM_B).title, 'Away: back at 9');
    assert.equal(badge(f, SAM_B).dataset.presence, 'away');
    assert.equal(badge(f, SAM_A).textContent, 'status unknown');
    // The note goes in as text, never as markup.
    f.handlers.onPresence({ peerId: SAM_A, state: 'dnd', note: '<b>x</b>' });
    assert.equal(badge(f, SAM_A).textContent, 'Do not disturb: <b>x</b>');
    assert.equal(badge(f, SAM_A).children.length, 0);
    f.handlers.onPresence({ peerId: SAM_A, state: 'available', note: '' });
    assert.equal(badge(f, SAM_A).textContent, 'Available');
    // An unknown state changes nothing.
    f.handlers.onPresence({ peerId: SAM_A, state: 'busy', note: 'x' });
    assert.equal(badge(f, SAM_A).textContent, 'Available');
    assert.deepEqual(f.errors, []);
});

test('two buddies with the same name keep their own states', async () => {
    const f = await room();
    f.handlers.onPresence({ peerId: SAM_A, state: 'dnd', note: 'racing' });
    f.handlers.onPresence({ peerId: SAM_B, state: 'away', note: 'lunch' });
    assert.equal(badge(f, SAM_A).textContent, 'Do not disturb: racing');
    assert.equal(badge(f, SAM_B).textContent, 'Away: lunch');
    // A name change does not move the state to the other line.
    f.handlers.onPeerName({ peerId: SAM_B, name: 'Sam' });
    assert.equal(badge(f, SAM_A).textContent, 'Do not disturb: racing');
    assert.equal(badge(f, SAM_B).textContent, 'Away: lunch');
});

test('peer-left removes the state: the same peer ID that joins again shows status unknown', async () => {
    const f = await room();
    f.handlers.onPresence({ peerId: SAM_A, state: 'away', note: 'brb' });
    f.handlers.onPeerLeft({ peerId: SAM_A });
    await new Promise(resolve => setTimeout(resolve, 0));
    f.handlers.onPeerJoined({ peerId: SAM_A });
    assert.equal(badge(f, SAM_A).textContent, 'status unknown');
    assert.equal(badge(f, SAM_A).dataset.presence, 'unknown');
});

test('a buddy with no state (an old client) shows status unknown; a state before the line applies at join', async () => {
    const f = await room({ peers: [[ALEX, 'Alex']] });
    assert.equal(badge(f, ALEX).textContent, 'status unknown');
    assert.equal(badge(f, ALEX).title, 'status unknown');
    f.handlers.onPresence({ peerId: SAM_A, state: 'away', note: 'early' });
    f.handlers.onPeerJoined({ peerId: SAM_A });
    assert.equal(badge(f, SAM_A).textContent, 'Away: early');
});

test('the set action sends the state and a note cut to 80 code points', async () => {
    const sent = [];
    const f = await room({
        bridge: { setPresence: async value => { sent.push(value); return { state: value.state, note: value.note }; } }
    });
    assert.equal(selfBadge(f).textContent, 'Available');
    const select = f.el('presence-state');
    const note = f.el('presence-note');
    assert.ok(select && note && f.el('presence-set'), 'the state controls are in the window');
    // 81 code points, each one 2 UTF-16 units.
    const long = '\u{1F600}'.repeat(81);
    select.value = 'away';
    note.value = long;
    f.el('presence-set').click();
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].state, 'away');
    assert.equal([...sent[0].note].length, 80);
    assert.equal(sent[0].note, '\u{1F600}'.repeat(80));
    assert.equal(selfBadge(f).textContent, `Away: ${'\u{1F600}'.repeat(80)}`);
    assert.equal(note.value, '\u{1F600}'.repeat(80));

    // Enter in the note field also sets.
    select.value = 'dnd';
    note.value = 'gaming';
    const event = f.key(note, 'Enter');
    assert.equal(event.defaultPrevented, true);
    await settle();
    assert.deepEqual({ ...sent[1] }, { state: 'dnd', note: 'gaming' });
    assert.equal(selfBadge(f).textContent, 'Do not disturb: gaming');
    assert.deepEqual(f.errors, []);
});

test('a failed set shows the error and keeps the old own badge', async () => {
    const f = await room({ bridge: { setPresence: async () => { throw new Error('Not logged in'); } } });
    f.el('presence-state').value = 'away';
    f.el('presence-set').click();
    await settle();
    assert.equal(selfBadge(f).textContent, 'Available');
    assert.match(f.el('status').textContent, /^Status not set: Not logged in/);
});

test('the state read after login applies to the own line and the buddies', async () => {
    let reads = 0;
    const f = await room({
        bridge: {
            getPresence: async () => {
                reads++;
                return { self: { state: 'away', note: 'kept' }, peers: { [SAM_A]: { state: 'dnd', note: 'race' } } };
            }
        }
    });
    // The buddy line comes after the read in room(): the state is kept and applies at join.
    assert.equal(reads, 1);
    assert.equal(selfBadge(f).textContent, 'Away: kept');
    assert.equal(f.el('presence-state').value, 'away');
    assert.equal(f.el('presence-note').value, 'kept');
    assert.equal(badge(f, SAM_A).textContent, 'Do not disturb: race');
    assert.equal(badge(f, SAM_B).textContent, 'status unknown');
});

test('an event that comes while the state read runs is not overwritten by the older read', async () => {
    let answer;
    const f = await loadRoomWindow();
    f.window.asscrack.getPresence = () => new Promise(resolve => { answer = resolve; });
    f.handlers.onPeerJoined({ peerId: SAM_A });
    await f.login('Me');
    f.handlers.onPresence({ peerId: SAM_A, state: 'away', note: 'new' });
    answer({ self: { state: 'available', note: '' }, peers: { [SAM_A]: { state: 'dnd', note: 'old' } } });
    await settle();
    assert.equal(badge(f, SAM_A).textContent, 'Away: new');
});

test('Do not disturb does not change the voice view and calls no voice function', async () => {
    const f = await loadRoomWindow();
    const voiceCalls = [];
    const voice = f.window.voice;
    for (const name of ['join', 'leave', 'setMuted', 'stats']) {
        const original = voice[name];
        voice[name] = (...args) => {
            voiceCalls.push(name);
            return original(...args);
        };
    }
    voice.state = () => ({
        self: 'self-peer-id', host: null,
        members: { [SAM_A]: { inVoice: true, muted: true }, [SAM_B]: { inVoice: true, muted: false } }
    });
    f.window.asscrack.setPresence = async value => value;
    await f.login('Me');
    for (const peerId of [SAM_A, SAM_B]) f.handlers.onPeerJoined({ peerId });
    f.el('join-voice').click();
    await settle();
    f.el('mute').click();
    const view = () => ({
        mute: f.el('mute').textContent,
        pressed: f.el('mute').getAttribute('aria-pressed'),
        leaveHidden: f.el('leave-voice').hidden,
        states: f.el('peers').children.map(li => li.querySelector('.voice-state').textContent)
    });
    const before = view();
    assert.equal(before.mute, 'Unmute');
    assert.deepEqual(before.states, ['in voice (muted)', 'in voice (muted)', 'in voice']);
    const callsBefore = voiceCalls.length;
    const bridgeBefore = f.calls.length;

    f.el('presence-state').value = 'dnd';
    f.el('presence-note').value = 'focus';
    f.el('presence-set').click();
    await settle();
    f.handlers.onPresence({ peerId: SAM_B, state: 'dnd', note: '' });

    assert.equal(selfBadge(f).textContent, 'Do not disturb: focus');
    assert.equal(badge(f, SAM_B).textContent, 'Do not disturb');
    assert.deepEqual(view(), before);
    assert.equal(voiceCalls.length, callsBefore, 'no voice function call');
    const voiceBridge = f.calls.slice(bridgeBefore).filter(c => /voice|signal/i.test(c.name));
    assert.deepEqual(voiceBridge, []);
    assert.deepEqual(f.errors, []);
});
