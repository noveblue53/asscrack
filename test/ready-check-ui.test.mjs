// Ready check (milestone 9): the bar of ready-check-ui.js, the /ready command of renderer.js and the Ready check action,
// with the real scripts in the fake DOM (test/helpers/renderer-fixture.mjs) and the fake clock. The node side is the
// real src/network/ready-check.mjs on the same clock. No network: these are results of this PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createClock } from './helpers/fake-clock.mjs';
import { createReadyCheck, READY_RESULT_MS } from '../src/network/ready-check.mjs';

const SELF = 'self-peer-id';
const SAM = '12D3KooWsamAAAAAAaaaa01';
const SAM2 = '12D3KooWsamCCCCCCcccc03';
const ALEX = '12D3KooWalexBBBBBbbbb02';
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

const ATTENTION = [
    { id: 'attention-settings', tag: 'dialog', children: [
        { id: 'attention-cues', tag: 'input' }, { id: 'attention-other-cues', tag: 'input' },
        { id: 'attention-message-cues', tag: 'input' }, { id: 'attention-volume', tag: 'input' },
        { id: 'attention-percent', tag: 'output' }, { id: 'attention-tone', tag: 'select', value: 'join' },
        { id: 'attention-preview', tag: 'button' }, { id: 'attention-alerts', tag: 'input' },
        { id: 'attention-windows', tag: 'p' }, { id: 'attention-content', tag: 'input' },
        { id: 'attention-sound', tag: 'input' }, { id: 'attention-status', tag: 'p' }
    ] }
];
const list = id => ({ id, tag: 'p', class: 'ready-list', children: [{ tag: 'span', class: 'ready-label' }, { tag: 'span', class: 'ready-names' }] });
const READY = [
    { id: 'room-options', children: [{ id: 'ready-open', tag: 'button' }] },
    { id: 'ready-bar', tag: 'section', hidden: true, children: [
        { id: 'ready-question', tag: 'p' }, { id: 'ready-state', tag: 'span', hidden: true },
        { id: 'ready-yes', tag: 'button' }, { id: 'ready-minute', tag: 'button' }, { id: 'ready-close', tag: 'button', hidden: true },
        list('ready-list-ready'), list('ready-list-minute'), list('ready-list-none')
    ] }
];

async function room({ peers = [[SAM, 'Sam'], [ALEX, 'Alex']] } = {}) {
    const clock = createClock();
    const settings = { voiceCues: true, otherVoiceCues: true, messageCues: true, volume: 35, alerts: false,
        previews: false, sound: false };
    let f = null;
    const ids = [ID2, ID3];
    const node = createReadyCheck({
        selfId: SELF, peers: () => peers.map(p => p[0]),
        send: () => true, broadcast: () => peers.length,
        changed: view => f?.handlers.onReady(view),
        newId: () => ids.shift(),
        now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout
    });
    const bridge = [];
    f = await loadRoomWindow({
        clock,
        elements: [...ATTENTION, ...READY],
        scripts: ['attention.js', 'ready-check-ui.js'],
        globals: {
            navigator: { userAgent: 'test' },
            AudioContext: class { state = 'running'; destination = {}; async resume() {} },
            CSS: { escape: s => s }
        },
        api: {
            getAttentionSettings: async () => ({ ...settings }),
            setAttentionSettings: async patch => Object.assign(settings, patch) && { ...settings },
            setPresence: async value => value,
            openReady: async text => { bridge.push(['openReady', text]); return node.open(text); },
            voteReady: async (id, vote) => { bridge.push(['voteReady', id, vote]); return node.vote(id, vote); },
            closeReady: async id => { bridge.push(['closeReady', id]); return node.close(id); },
            getReady: async () => node.state()
        }
    });
    const state = { idle: false, focus: true };
    const played = [];
    f.window.voiceCues = { play: (context, kind) => { played.push(kind); return true; } };
    f.window.idlePeer = { isIdle: () => state.idle };
    f.document.hasFocus = () => state.focus;
    f.document.visibilityState = 'visible';
    await f.login('Parker');
    for (const [peerId, name] of peers) {
        f.handlers.onPeerJoined({ peerId });
        f.handlers.onPeerName({ peerId, name });
    }
    const names = id => f.el(id).querySelector('.ready-names').textContent;
    Object.assign(f, {
        clock, node, bridge, played, state,
        bar: () => ({
            hidden: f.el('ready-bar').hidden,
            question: f.el('ready-question').textContent,
            ready: names('ready-list-ready'), minute: names('ready-list-minute'), none: names('ready-list-none'),
            buttons: !f.el('ready-yes').hidden && !f.el('ready-minute').hidden,
            close: !f.el('ready-close').hidden,
            closed: !f.el('ready-state').hidden
        }),
        async type(text) {
            f.el('message-input').value = text;
            f.el('send').click();
            await settle();
        },
        async dnd() {
            f.el('presence-state').value = 'dnd';
            f.el('presence-set').click();
            await settle();
        }
    });
    return f;
}
const open = (id, text) => ({ type: 'ready', v: 1, op: 'open', id, text });
const vote = (id, v) => ({ type: 'ready', v: 1, op: 'vote', id, vote: v });

test('the bar shows the check of a different person, with the three lists', async () => {
    const f = await room();
    assert.equal(f.bar().hidden, true);
    f.node.handle(SAM, open(ID1, 'Race in five?'));
    assert.deepEqual(f.bar(), { hidden: false, question: 'Sam asks: Race in five?', ready: '—', minute: '—',
        none: 'Parker, Sam, Alex', buttons: true, close: false, closed: false });
    f.node.handle(ALEX, vote(ID1, 'minute'));
    f.el('ready-yes').click();
    await settle();
    assert.deepEqual(f.bridge.at(-1), ['voteReady', ID1, 'ready']);
    assert.equal(f.el('ready-yes').getAttribute('aria-pressed'), 'true');
    assert.deepEqual([f.bar().ready, f.bar().minute, f.bar().none], ['Parker', 'Alex', 'Sam']);
    // A changed vote replaces the previous vote.
    f.el('ready-minute').click();
    await settle();
    assert.deepEqual([f.bar().ready, f.bar().minute, f.bar().none], ['—', 'Parker, Alex', 'Sam']);
    assert.equal(f.el('ready-yes').getAttribute('aria-pressed'), 'false');
    assert.equal(f.rows().length, 0, 'no line in the transcript');
    assert.deepEqual(f.errors, []);
});

test('two people with the same name are two entries', async () => {
    const f = await room({ peers: [[SAM, 'Sam'], [SAM2, 'Sam']] });
    f.node.handle(SAM, open(ID1, 'Go?'));
    f.node.handle(SAM, vote(ID1, 'ready'));
    f.node.handle(SAM2, vote(ID1, 'ready'));
    assert.equal(f.bar().ready, 'Sam (aa01), Sam (cc03)');
    assert.equal(f.bar().none, 'Parker');
});

test('/ready with a text and with no text opens a check; a text that is too long stays in the box', async () => {
    const f = await room();
    await f.type('/ready Race in five?');
    assert.deepEqual(f.bridge, [['openReady', 'Race in five?']]);
    assert.equal(f.el('message-input').value, '');
    assert.equal(f.bar().question, 'You ask: Race in five?');
    assert.equal(f.bar().close, true);
    assert.equal(f.calls.filter(c => c.name === 'send').length, 0);

    const long = '/ready ' + 'x'.repeat(121);
    await f.type(long);
    assert.equal(f.bridge.length, 1);
    assert.equal(f.el('message-input').value, long);
    assert.match(f.el('status').textContent, /at most 120 characters/);

    f.node.close();
    f.clock.advance(READY_RESULT_MS);
    await f.type('/ready');
    assert.deepEqual(f.bridge.at(-1), ['openReady', '']);
    assert.equal(f.el('message-input').value, '');
    assert.equal(f.bar().question, 'You ask: Ready?');
});

test('the Ready check action of the Room menu opens "Ready?"', async () => {
    const f = await room();
    f.el('ready-open').click();
    await settle();
    assert.deepEqual(f.bridge, [['openReady', '']]);
    assert.equal(f.bar().question, 'You ask: Ready?');
});

test('Close: the initiator closes; the result shows for 10 s, then the bar goes away', async () => {
    const f = await room();
    f.el('ready-open').click();
    await settle();
    f.node.handle(SAM, vote(ID2, 'ready'));
    f.el('ready-close').click();
    await settle();
    assert.deepEqual(f.bridge.at(-1), ['closeReady', ID2]);
    const bar = f.bar();
    assert.equal(bar.question, 'You asked: Ready?');
    assert.equal(bar.closed, true);
    assert.equal(bar.buttons, false);
    assert.equal(bar.close, false);
    assert.equal(bar.ready, 'Sam');
    f.clock.advance(READY_RESULT_MS - 1);
    assert.equal(f.bar().hidden, false);
    f.clock.advance(1);
    assert.equal(f.bar().hidden, true);
});

test('a person that is not the initiator has no Close', async () => {
    const f = await room();
    f.node.handle(SAM, open(ID1, 'Go?'));
    assert.equal(f.bar().close, false);
});

test('a new check plays the message cue once when the conversation is not in view; DND shows the bar with no cue', async () => {
    const f = await room();
    f.state.focus = false;
    f.node.handle(SAM, open(ID1, 'Go?'));
    await settle();
    assert.deepEqual(f.played, ['mention']);
    // The same check again (a new session): no second cue.
    f.node.opened(SAM);
    f.node.handle(SAM, open(ID1, 'Go?'));
    f.clock.advance(5000);
    await settle();
    assert.deepEqual(f.played, ['mention']);

    await f.dnd();
    f.node.handle(ALEX, open(ID2, 'Now?'));
    await settle();
    assert.equal(f.bar().hidden, false);
    assert.equal(f.bar().question, 'Alex asks: Now?');
    assert.deepEqual(f.played, ['mention']);
    assert.equal(f.calls.filter(c => c.name === 'addAttention').length, 0, 'no notification');
});

test('no cue when the conversation is in view', async () => {
    const f = await room();
    f.node.handle(SAM, open(ID1, 'Go?'));
    await settle();
    assert.deepEqual(f.played, []);
    assert.equal(f.bar().hidden, false);
});

test('Idle Peer: no bar and no cue; the vote stays not answered; the bar comes back after Idle Peer', async () => {
    const f = await room();
    // The voice stub of the fixture has no enterIdle (renderer.js calls it when Idle Peer starts).
    f.window.voice.enterIdle = async () => {};
    f.state.idle = true;
    f.handlers.onIdlePeer({ idle: true });
    f.state.focus = false;
    f.node.handle(SAM, open(ID1, 'Go?'));
    await settle();
    assert.equal(f.bar().hidden, true);
    assert.deepEqual(f.played, []);
    f.state.idle = false;
    f.handlers.onIdlePeer({ idle: false });
    await settle();
    assert.equal(f.bar().hidden, false);
    assert.equal(f.bar().none, 'Parker, Sam, Alex');
});
