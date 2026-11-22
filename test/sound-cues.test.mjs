// P11: the sound cues for other people in voice and for messages (attention.js, renderer.js), with the real scripts in
// the fake DOM (test/helpers/renderer-fixture.mjs) and the fake clock. window.voiceCues.play is a stub that records
// each cue. The rules are the table "Cue and attention rules" of the 1.0 review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createClock } from './helpers/fake-clock.mjs';

const SELF = 'self-peer-id';
const SAM = '12D3KooWsamAAAAAAaaaa01';
const ALEX = '12D3KooWalexBBBBBbbbb02';
const OWN_KINDS = new Set(['join', 'leave', 'mute', 'unmute']);

const ATTENTION = [
    { id: 'attention-settings', tag: 'dialog', children: [
        { id: 'attention-cues', tag: 'input' }, { id: 'attention-other-cues', tag: 'input' },
        { id: 'attention-message-cues', tag: 'input' }, { id: 'attention-volume', tag: 'input' },
        { id: 'attention-percent', tag: 'output' }, { id: 'attention-tone', tag: 'select', value: 'join' },
        { id: 'attention-preview', tag: 'button' }, { id: 'attention-alerts', tag: 'input' },
        { id: 'attention-windows', tag: 'p' }, { id: 'attention-content', tag: 'input' },
        { id: 'attention-sound', tag: 'input' }, { id: 'attention-status', tag: 'p' },
        // G5 (E1): the box of the flash setting is in the dialog.
        { id: 'attention-flash', tag: 'input' }
    ] }
];

// prefs: changes to the defaults of attention.mjs. Returns the fixture with played (the cue kinds of other people and
// of messages), own (the own cue kinds), state ({ idle, focus }) and the helpers below.
async function room(prefs = {}, peers = [[SAM, 'Sam'], [ALEX, 'Alex']]) {
    const clock = createClock();
    const settings = { voiceCues: true, otherVoiceCues: true, messageCues: true, volume: 35, alerts: false,
        previews: false, sound: false, ...prefs };
    const f = await loadRoomWindow({
        clock,
        elements: ATTENTION,
        scripts: ['attention.js'],
        globals: {
            navigator: { userAgent: 'test' },
            AudioContext: class { state = 'running'; destination = {}; async resume() {} },
            CSS: { escape: s => s }
        },
        api: {
            getAttentionSettings: async () => ({ ...settings }),
            setAttentionSettings: async patch => Object.assign(settings, patch) && { ...settings },
            setPresence: async value => value
        }
    });
    const state = { idle: false, focus: true };
    const played = [], own = [];
    f.window.voiceCues = { play: (context, kind) => { (OWN_KINDS.has(kind) ? own : played).push(kind); return true; } };
    f.window.idlePeer = { isIdle: () => state.idle };
    f.document.hasFocus = () => state.focus;
    f.document.visibilityState = 'visible';
    await f.login('Parker');
    for (const [peerId, name] of peers) {
        f.handlers.onPeerJoined({ peerId });
        f.handlers.onPeerName({ peerId, name });
    }
    Object.assign(f, {
        clock, played, own, state, settings,
        async joinVoice() {
            f.el('join-voice').click();
            await settle();
        },
        voiceState(peerId, inVoice) {
            f.handlers.onVoiceState({ peerId, inVoice, streamId: null, muted: false });
        },
        async dnd() {
            f.el('presence-state').value = 'dnd';
            f.el('presence-set').click();
            await settle();
        },
        adds: () => f.calls.filter(c => c.name === 'addAttention')
    });
    return f;
}

// ---- Voice cues of other people ----

test('a peer that is in voice when its session opens gives no cue, and the states at my own Join give no cue', async () => {
    const f = await room();
    // The voice line of the session open comes in the base time.
    f.clock.advance(200);
    f.voiceState(SAM, true);
    f.clock.advance(5000);
    await f.joinVoice();
    // A state again at my own Join (for example the relay sends it again): no change.
    f.voiceState(SAM, true);
    assert.deepEqual(f.own, ['join']);
    assert.deepEqual(f.played, []);
    assert.deepEqual(f.errors, []);
});

test('a real join and a real leave of a different person play while I am in voice', async () => {
    const f = await room();
    await f.joinVoice();
    f.clock.advance(5000);
    f.voiceState(SAM, true);
    assert.deepEqual(f.played, ['other-join']);
    // A mute change is not a voice change.
    f.handlers.onVoiceState({ peerId: SAM, inVoice: true, muted: true });
    f.clock.advance(1000);
    f.voiceState(SAM, false);
    assert.deepEqual(f.played, ['other-join', 'other-leave']);
    assert.deepEqual(f.errors, []);
});

test('the voice cues of other people do not play while I am not in voice', async () => {
    const f = await room();
    f.clock.advance(5000);
    f.voiceState(SAM, true);
    f.clock.advance(1000);
    f.voiceState(SAM, false);
    assert.deepEqual(f.played, []);
});

test('a reconnect in the 10 s gives no cue; a peer in voice that does not come back gives the leave cue', async () => {
    const f = await room();
    await f.joinVoice();
    f.clock.advance(5000);
    f.voiceState(SAM, true);
    f.voiceState(ALEX, true);
    f.played.length = 0;
    f.clock.advance(1000);
    // Sam goes with no bye and comes back in 4 s, in voice: no cue.
    f.handlers.onPeerLeft({ peerId: SAM, left: false });
    f.clock.advance(4000);
    f.handlers.onPeerJoined({ peerId: SAM });
    f.clock.advance(300);
    f.voiceState(SAM, true);
    f.clock.advance(10000);
    assert.deepEqual(f.played, []);
    // Alex goes with no bye and does not come back: the leave cue at the end of the 10 s, not before.
    f.handlers.onPeerLeft({ peerId: ALEX, left: false });
    f.clock.advance(9000);
    assert.deepEqual(f.played, []);
    f.clock.advance(1500);
    assert.deepEqual(f.played, ['other-leave']);
    assert.deepEqual(f.errors, []);
});

test('a peer in voice that goes with a bye gives the leave cue at once; my own loss gives none', async () => {
    const f = await room();
    await f.joinVoice();
    f.clock.advance(5000);
    f.voiceState(SAM, true);
    f.voiceState(ALEX, true);
    f.played.length = 0;
    f.clock.advance(1000);
    f.handlers.onPeerLeft({ peerId: SAM, left: true });
    assert.deepEqual(f.played, ['other-leave']);
    // Alex is the last peer: 0 peers after the event is my own loss. No cue now and no cue at the end of the 10 s.
    f.clock.advance(1000);
    f.handlers.onPeerLeft({ peerId: ALEX, left: false });
    f.clock.advance(11000);
    assert.deepEqual(f.played, ['other-leave']);
    assert.deepEqual(f.errors, []);
});

test('a full room that joins voice at once makes one cue (0.5 s limit, dropped, not queued)', async () => {
    const peers = [1, 2, 3, 4, 5].map(i => ['12D3KooWpeer' + i, 'Peer ' + i]);
    const f = await room({}, peers);
    await f.joinVoice();
    f.clock.advance(5000);
    for (const [peerId] of peers) {
        f.voiceState(peerId, true);
        f.clock.advance(20);
    }
    assert.deepEqual(f.played, ['other-join']);
    f.clock.advance(2000);
    assert.deepEqual(f.played, ['other-join'], 'no queued cue');
    f.voiceState(peers[0][0], false);
    assert.deepEqual(f.played, ['other-join', 'other-leave']);
});

test('the voice cues of other people are silent in Idle Peer, in Do not disturb and when the setting is off', async () => {
    const idle = await room();
    await idle.joinVoice();
    idle.clock.advance(5000);
    idle.state.idle = true;
    idle.voiceState(SAM, true);
    assert.deepEqual(idle.played, []);

    const dnd = await room();
    await dnd.joinVoice();
    dnd.clock.advance(5000);
    await dnd.dnd();
    dnd.voiceState(SAM, true);
    assert.deepEqual(dnd.played, []);
    // The own cues keep the behavior of 0.8 in DND (G4 changes it): silent.
    dnd.el('mute').click();
    assert.deepEqual(dnd.own, ['join']);

    const off = await room({ otherVoiceCues: false });
    await off.joinVoice();
    off.clock.advance(5000);
    off.voiceState(SAM, true);
    assert.deepEqual(off.played, []);
    assert.deepEqual(off.own, ['join'], 'the own cues have their own setting');

    const mute = await room({ volume: 0 });
    await mute.joinVoice();
    mute.clock.advance(5000);
    mute.voiceState(SAM, true);
    assert.deepEqual(mute.played, []);
});

// ---- Message cues ----

test('a mention outside my view plays the cue with alerts off and sends no notification', async () => {
    const f = await room();
    f.state.focus = false;
    f.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'm1' });
    assert.deepEqual(f.played, ['mention']);
    assert.deepEqual(f.adds(), []);
    assert.deepEqual(f.errors, []);
});

test('no message cue for a line in view, my own line, a line with no match, or a history replay', async () => {
    const f = await room();
    f.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'v1' });
    f.state.focus = false;
    f.receive({ from: 'Parker', text: 'Parker here', peerId: SELF, id: 'o1' });
    f.receive({ from: 'Sam', text: 'hello all', peerId: SAM, id: 'n1' });
    f.history([{ from: 'Sam', text: 'old Parker line', time: Date.now(), id: 'h1' }]);
    await settle();
    assert.deepEqual(f.played, []);
    assert.deepEqual(f.errors, []);
});

test('a whisper to me outside its view plays the whisper cue; in view it does not', async () => {
    const f = await room();
    f.state.focus = false;
    f.window.roomAttention.incoming({ kind: 'whisper', peerId: SAM, id: 'w1' });
    assert.deepEqual(f.played, ['whisper']);
    f.clock.advance(3000);
    f.window.whispers = { isViewing: id => id === SAM, isOpen: () => true };
    f.state.focus = true;
    f.window.roomAttention.incoming({ kind: 'whisper', peerId: SAM, id: 'w2' });
    assert.deepEqual(f.played, ['whisper']);
});

test('the message cues are silent in Idle Peer, in Do not disturb and when the setting is off', async () => {
    const idle = await room();
    idle.state.focus = false;
    idle.state.idle = true;
    idle.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'i1' });
    idle.window.roomAttention.incoming({ kind: 'whisper', peerId: SAM, id: 'i2' });
    assert.deepEqual(idle.played, []);

    const dnd = await room();
    dnd.state.focus = false;
    await dnd.dnd();
    dnd.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'd1' });
    dnd.window.roomAttention.incoming({ kind: 'whisper', peerId: SAM, id: 'd2' });
    assert.deepEqual(dnd.played, []);

    const off = await room({ messageCues: false });
    off.state.focus = false;
    off.receive({ from: 'Sam', text: 'hi Parker', peerId: SAM, id: 'f1' });
    off.window.roomAttention.incoming({ kind: 'whisper', peerId: SAM, id: 'f2' });
    assert.deepEqual(off.played, []);
});

test('at most one message cue each 2 s; with alerts on each line still goes to the notification', async () => {
    const f = await room({ alerts: true });
    f.state.focus = false;
    f.receive({ from: 'Sam', text: 'Parker 1', peerId: SAM, id: 'r1' });
    f.clock.advance(500);
    f.window.roomAttention.incoming({ kind: 'whisper', peerId: ALEX, id: 'r2' });
    f.clock.advance(1000);
    f.receive({ from: 'Alex', text: 'Parker 3', peerId: ALEX, id: 'r3' });
    assert.deepEqual(f.played, ['mention']);
    f.clock.advance(600);
    f.receive({ from: 'Alex', text: 'Parker 4', peerId: ALEX, id: 'r4' });
    assert.deepEqual(f.played, ['mention', 'mention']);
    assert.deepEqual(f.adds().map(c => c.args[0].id), ['r1', 'r2', 'r3', 'r4']);
    // The notification target has no author field.
    assert.equal(Object.hasOwn(f.adds()[0].args[0], 'from'), false);
    assert.equal(f.window.roomAttention.wanted({ kind: 'mention', channelId: 'general', id: 'x', from: SELF }), false);
    assert.equal(f.window.roomAttention.wanted({ kind: 'mention', channelId: 'general', id: 'x', from: SAM }), true);
});
