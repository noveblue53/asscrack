// G6: voice channels in the room window. The pure part of voice-channels-ui.js, the real voice.js in node:vm (move and
// the channel filter), and the real window scripts in the fake DOM (test/helpers/renderer-fixture.mjs).
// No network, no Electron, no audio device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createClock } from './helpers/fake-clock.mjs';

const read = name => readFile(new URL(`../src/application/${name}`, import.meta.url), 'utf8');
const SELF = 'self-peer-id';
const SAM = '12D3KooWsamAAAAAAaaaa01';
const ALEX = '12D3KooWalexBBBBBbbbb02';
const RAID = '0b5c7a52-3f9d-4b38-9a0e-6c1f0f6a2d11';
const LOBBY = '7e0f8a11-2b6c-4d1e-8f3a-5b9c0d1e2f30';
const GENERAL = { id: 'general', name: 'General' };

// ---- The pure part ----

async function core() {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(await read('voice-channels-ui.js'), context);
    return context.window.voiceChannelsCore;
}

test('voiceChannelsCore: General first, then by name; the people below each row; the texts', async () => {
    const c = await core();
    const channels = [{ id: RAID, name: 'raid' }, GENERAL, { id: LOBBY, name: 'Lobby' }];
    assert.deepEqual(JSON.parse(JSON.stringify(c.sorted(channels).map(x => x.name))), ['General', 'Lobby', 'raid']);
    assert.equal(c.label([GENERAL], 'general'), '', 'no channel text with only General');
    assert.equal(c.label(channels, RAID), 'raid');
    assert.equal(c.label(channels, 'f0000000-0000-4000-8000-000000000000'), 'Unknown channel');
    const rows = c.rows(channels, [
        { peerId: 'a', name: 'Ann', inVoice: true, channel: RAID, muted: true, speaking: true },
        { peerId: 'b', name: 'Bo', inVoice: true, channel: RAID, deafened: true },
        { peerId: 'c', name: 'Cy', inVoice: true, channel: 'general', speaking: true },
        { peerId: 'd', name: 'Di', inVoice: false, channel: RAID }
    ], RAID);
    assert.deepEqual(JSON.parse(JSON.stringify(rows.map(r => [r.name, r.mine, r.people.map(p => [p.name, p.state, p.speaking])]))), [
        ['General', false, [['Cy', '', false]]],
        ['Lobby', false, []],
        ['raid', true, [['Ann', 'muted', false], ['Bo', 'deafened', false]]]
    ], 'the speaking ring only in the own channel, never for a muted person');
    assert.equal(c.action(false, 'general', RAID), 'join');
    assert.equal(c.action(true, 'general', RAID), 'move');
    assert.equal(c.action(true, RAID, RAID), 'none');
    assert.equal(c.deleteText('Raid', 3), 'Delete Raid? 3 people move to General.');
    assert.equal(c.deleteText('Raid', 1), 'Delete Raid? 1 person moves to General.');
    assert.equal(c.deleteText('Raid', 0), 'Delete Raid?');
    assert.equal(c.movedText('Raid'), 'Raid was deleted. You\'re in General.');
});

// ---- The real voice.js ----

const voiceScripts = await Promise.all(['voice-gate.js', 'voice-worklet.js', 'voice.js'].map(read));

async function listener() {
    const room = await loadRoomWindow();
    const registered = {};
    const removed = [];
    let microphones = 0;
    const device = { connect() {}, disconnect() {} };
    const track = { label: 'Test input', enabled: true, getSettings: () => ({}), stop() {} };
    const api = room.window.asscrack;
    api.getHost = async () => ({ self: 'local', host: null });
    api.getVoiceSettings = async () => ({ noiseSuppression: 'off' });
    const context = vm.createContext({
        window: room.window, performance, console, Uint8Array, Float32Array,
        navigator: { mediaDevices: { getUserMedia: async () => {
            microphones++;
            return { id: 'mic', getAudioTracks: () => [track], getTracks: () => [track] };
        } } },
        AudioContext: class {
            audioWorklet = { async addModule() {} };
            createMediaStreamSource() { return device; }
            async close() {}
        },
        AudioWorkletProcessor: class { port = {}; },
        registerProcessor: (name, ctor) => { registered[name] = ctor; },
        AudioWorkletNode: class {
            constructor(_context, name) {
                const processor = new registered[name]();
                this.port = { postMessage(data) {
                    if (data?.type === 'remove') removed.push(data.origin);
                    processor.port.onmessage({ data });
                } };
            }
            connect() {}
            disconnect() {}
        },
        AudioEncoder: class {
            static async isConfigSupported() { return { supported: true }; }
            configure() {}
            close() {}
        },
        EncodedAudioChunk: class { constructor(init) { this.data = init.data; } },
        AudioDecoder: class {
            constructor({ output }) { this.output = output; this.decoded = 0; }
            configure() {}
            close() {}
            decode(chunk) {
                this.output({ numberOfFrames: 960, copyTo(samples) { samples.fill(chunk.data[0] / 8); }, close() {} });
            }
        }
    });
    for (const script of voiceScripts) vm.runInContext(script, context);
    const setVoice = () => room.calls.filter(c => c.name === 'setVoice').map(c => c.args[0]);
    return { room, voice: room.window.voice, removed, microphones: () => microphones, setVoice };
}

test('voice.js: move() changes only the channel; no new microphone; the mute state stays; other channels stop', async () => {
    const l = await listener();
    const { voice, room } = l;
    room.handlers.onVoiceState({ peerId: SAM, inVoice: true, channel: RAID });
    room.handlers.onVoiceState({ peerId: ALEX, inVoice: true });
    await voice.join(RAID);
    assert.equal(voice.state().channel, RAID);
    assert.equal(l.setVoice().at(-1).channel, RAID);
    assert.deepEqual(l.removed.filter(o => o === ALEX).length > 0, true, 'Alex (General) is not in my channel');
    assert.equal(l.microphones(), 1);
    voice.setMuted(true);
    assert.equal(l.setVoice().at(-1).channel, RAID, 'a mute keeps the channel in the voice line');
    room.handlers.onVoiceFrame({ origin: SAM, data: Uint8Array.of(2) });
    room.handlers.onVoiceFrame({ origin: ALEX, data: Uint8Array.of(2) });
    assert.deepEqual([...voice.state().connections].sort(), [SAM, ALEX].sort());
    const removedBefore = l.removed.length;

    await voice.move('general');
    assert.equal(l.microphones(), 1, 'move() does not call getUserMedia again');
    assert.equal(voice.state().channel, 'general');
    assert.equal(voice.state().muted, true, 'the mute state stays');
    assert.equal(voice.state().inVoice, true);
    const line = l.setVoice().at(-1);
    assert.equal(line.channel, 'general');
    assert.equal(line.muted, true);
    assert.ok(l.removed.slice(removedBefore).includes(SAM), 'Sam goes out of my channel: removeOrigin');
    assert.equal(voice.state().connections.includes(SAM), false);

    // A member that moves out of my channel gets removeOrigin too.
    room.handlers.onVoiceFrame({ origin: ALEX, data: Uint8Array.of(2) });
    const mark = l.removed.length;
    room.handlers.onVoiceState({ peerId: ALEX, inVoice: true, channel: LOBBY });
    assert.ok(l.removed.slice(mark).includes(ALEX));
    assert.equal(voice.state().members[ALEX].channel, LOBBY);

    // The node moved this window to General after a delete: voice.js follows, with no voice line of its own.
    await voice.move(RAID);
    const lines = l.setVoice().length;
    room.handlers.onVoiceChannels({ owner: false, editable: false, seq: 3, channels: [GENERAL], movedFrom: { id: RAID, name: 'Raid' } });
    assert.equal(voice.state().channel, 'general');
    assert.equal(l.setVoice().length, lines);
    assert.equal(l.microphones(), 1);
});

// ---- The window ----

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

const ELEMENTS = [
    { id: 'voice-channels', children: [
        { id: 'voice-channel-create', tag: 'button', hidden: true },
        { id: 'voice-channel-list', tag: 'ul' },
        { id: 'voice-channel-dialog', tag: 'dialog', children: [{ id: 'voice-channel-form', tag: 'form', children: [
            { id: 'voice-channel-title', tag: 'h2' }, { id: 'voice-channel-name', tag: 'input' },
            { id: 'voice-channel-error', tag: 'p' }, { id: 'voice-channel-cancel', tag: 'button' },
            { id: 'voice-channel-submit', tag: 'button' }
        ] }] },
        { id: 'voice-channel-delete-dialog', tag: 'dialog', children: [
            { id: 'voice-channel-delete-text', tag: 'p' }, { id: 'voice-channel-delete-error', tag: 'p' },
            { id: 'voice-channel-delete-cancel', tag: 'button' }, { id: 'voice-channel-delete-confirm', tag: 'button' }
        ] }
    ] }
];

// A voice.js stub that keeps the channel. calls: ['join', id] and ['move', id].
function voiceStub() {
    const s = { inVoice: false, channel: 'general', members: {}, muted: false };
    const calls = [];
    return {
        s, calls,
        state: () => ({ self: SELF, host: null, members: s.members, inVoice: s.inVoice, channel: s.channel, muted: s.muted,
            deafened: false, transmitting: false, capturing: true }),
        onChange() {},
        stats: async () => null,
        listeningFor: () => ({ muted: false, volume: 100 }),
        join: async (channel = 'general') => { calls.push(['join', channel]); s.inVoice = true; s.channel = channel; },
        move: async channel => { calls.push(['move', channel]); s.channel = channel; },
        leave: async () => { s.inVoice = false; },
        setMuted() {},
        setDeafened() {}
    };
}

async function windowRoom({ owner = true, channels = [GENERAL, { id: RAID, name: 'Raid' }], clock = null, attention = false } = {}) {
    let view = { owner, editable: owner, seq: channels.length - 1, channels };
    const edits = [];
    const f = await loadRoomWindow({
        clock: clock ?? undefined,
        elements: attention ? [...ELEMENTS, ...ATTENTION] : ELEMENTS,
        scripts: attention ? ['attention.js', 'voice-channels-ui.js'] : ['voice-channels-ui.js'],
        globals: attention ? { navigator: { userAgent: 'test' }, AudioContext: class { state = 'running'; destination = {}; async resume() {} },
            CSS: { escape: s => s } } : {},
        api: {
            getVoiceChannels: async () => view,
            createVoiceChannel: async name => { edits.push(['create', name]); },
            renameVoiceChannel: async (id, name) => { edits.push(['rename', id, name]); },
            deleteVoiceChannel: async id => { edits.push(['delete', id]); },
            ...(attention ? {
                getAttentionSettings: async () => ({ voiceCues: true, voiceSound: true, mentionSound: false, whisperSound: false, friendSound: false, volume: 35,
                    mentionAlert: false, whisperAlert: false, friendAlert: false, previews: false, sound: false }),
                setAttentionSettings: async patch => patch
            } : {})
        }
    });
    const voice = voiceStub();
    f.window.voice = voice;
    for (const id of ['voice-channel-dialog', 'voice-channel-delete-dialog']) {
        const dialog = f.el(id);
        dialog.showModal = () => { dialog.open = true; };
        dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new f.Event('close')); };
    }
    await f.login('Parker');
    for (const [peerId, name] of [[SAM, 'Sam'], [ALEX, 'Alex']]) {
        f.handlers.onPeerJoined({ peerId });
        f.handlers.onPeerName({ peerId, name });
    }
    await settle();
    Object.assign(f, {
        voice, edits,
        setView(next) { view = { ...view, ...next }; f.handlers.onVoiceChannels(view); },
        rows: () => f.el('voice-channel-list').children,
        row: name => f.el('voice-channel-list').children.find(li => li.querySelector('.vc-name').textContent === name),
        member(peerId, state) {
            voice.s.members[peerId] = { inVoice: state.inVoice !== false, channel: state.channel ?? 'general', muted: state.muted === true,
                deafened: state.deafened === true };
            f.handlers.onVoiceState({ peerId, inVoice: state.inVoice !== false, channel: state.channel, muted: state.muted, deafened: state.deafened });
        },
        buddy: peerId => f.el('peers').children.find(li => li.dataset.peerId === peerId).querySelector('.voice-state')
    });
    return f;
}

test('the window shows each voice channel with its people; a click joins, then moves', async () => {
    const f = await windowRoom({ channels: [GENERAL, { id: RAID, name: 'Raid' }, { id: LOBBY, name: 'Lobby' }] });
    assert.deepEqual(f.rows().map(li => li.querySelector('.vc-name').textContent), ['General', 'Lobby', 'Raid']);
    f.member(SAM, { channel: RAID, muted: true });
    f.member(ALEX, { channel: 'general', deafened: true });
    const raid = f.row('Raid');
    assert.equal(raid.querySelector('.vc-count').textContent, '1');
    assert.deepEqual(raid.querySelector('.vc-people').children.map(p => p.textContent), ['Sammuted']);
    assert.deepEqual(f.row('General').querySelector('.vc-people').children.map(p => p.textContent), ['Alexdeafened']);
    assert.equal(raid.hasAttribute('aria-current'), false);

    // Buddy line: " · <channel name>" after the state, with 2 or more channels. data-state keeps the state only.
    assert.equal(f.buddy(SAM).textContent, 'in voice (muted) · Raid');
    assert.equal(f.buddy(SAM).dataset.state, 'in voice (muted)');
    f.window.voice.listeningFor = () => ({ muted: false, volume: 40 });
    f.member(SAM, { channel: RAID, muted: true });
    assert.equal(f.buddy(SAM).textContent, 'in voice (muted) · Raid · 40%');
    f.window.voice.listeningFor = () => ({ muted: false, volume: 100 });

    // Not in voice: a click joins in that channel.
    raid.click();
    await settle();
    assert.deepEqual(f.voice.calls, [['join', RAID]]);
    assert.equal(f.row('Raid').getAttribute('aria-current'), 'true');
    assert.equal(f.row('Raid').querySelector('.vc-you').hidden, false);
    assert.equal(f.row('Raid').querySelector('.vc-count').textContent, '2', 'me and Sam');
    // The same channel: no action. A different channel: a move.
    f.row('Raid').click();
    await settle();
    assert.deepEqual(f.voice.calls, [['join', RAID]]);
    const lobby = f.row('Lobby');
    f.key(lobby, 'Enter');
    await settle();
    assert.deepEqual(f.voice.calls, [['join', RAID], ['move', LOBBY]]);
    assert.equal(f.row('Lobby').getAttribute('aria-current'), 'true');
    assert.equal(f.row('Raid').hasAttribute('aria-current'), false);
    assert.match(f.el('peers').children[0].querySelector('.voice-state').textContent, / · Lobby$/, 'my own line');

    // "Join voice" joins the last channel of this run.
    f.el('leave-voice').click();
    await settle();
    f.el('join-voice').click();
    await settle();
    assert.deepEqual(f.voice.calls.at(-1), ['join', LOBBY]);
    assert.deepEqual(f.errors, []);
});

test('the owner sees Create, Rename and Delete; a member does not; the delete text and a forced move', async () => {
    const f = await windowRoom();
    assert.equal(f.el('voice-channel-create').hidden, false);
    const raid = f.row('Raid');
    raid.focus();
    assert.equal(f.window.contextMenu.open(raid, raid), true);
    assert.deepEqual(f.el('row-menu').children.map(i => i.textContent), ['Rename…', 'Delete…']);
    f.window.contextMenu.close(false);
    assert.equal(f.window.contextMenu.open(f.row('General'), f.row('General')), false, 'General has no menu');

    // Create and Rename use #voice-channel-dialog.
    f.el('voice-channel-create').click();
    assert.equal(f.el('voice-channel-dialog').open, true);
    assert.equal(f.el('voice-channel-title').textContent, 'Create voice channel');
    f.el('voice-channel-name').value = 'Lobby';
    f.el('voice-channel-form').dispatchEvent(new f.Event('submit'));
    await settle();
    assert.deepEqual(f.edits.at(-1), ['create', 'Lobby']);
    assert.equal(f.el('voice-channel-dialog').open, false);
    await f.window.roomActions.run('rename-voice-channel', raid);
    assert.equal(f.el('voice-channel-title').textContent, 'Rename voice channel');
    assert.equal(f.el('voice-channel-name').value, 'Raid');
    f.el('voice-channel-name').value = 'Raid night';
    f.el('voice-channel-form').dispatchEvent(new f.Event('submit'));
    await settle();
    assert.deepEqual(f.edits.at(-1), ['rename', RAID, 'Raid night']);

    // Delete asks first, with the number of people in the channel.
    f.member(SAM, { channel: RAID });
    f.member(ALEX, { channel: RAID });
    await f.window.roomActions.run('delete-voice-channel', raid);
    assert.equal(f.el('voice-channel-delete-text').textContent, 'Delete Raid? 2 people move to General.');
    f.el('voice-channel-delete-confirm').click();
    await settle();
    assert.deepEqual(f.edits.at(-1), ['delete', RAID]);

    // A forced move: the node moved me to General.
    f.row('General').click();
    await settle();
    await f.window.voiceChannels.render({ inVoice: true, channel: 'general', people: [] });
    f.voice.s.channel = RAID;
    f.voice.s.inVoice = true;
    f.setView({ seq: 5, channels: [GENERAL], movedFrom: { id: RAID, name: 'Raid' } });
    assert.equal(f.el('status').textContent, 'Raid was deleted. You\'re in General.');
    assert.deepEqual(f.rows().map(li => li.querySelector('.vc-name').textContent), ['General', 'Unknown channel'],
        'Sam and Alex are still in the old ID until their new voice lines come');
    assert.deepEqual(f.errors, []);

    const m = await windowRoom({ owner: false });
    assert.equal(m.el('voice-channel-create').hidden, true);
    assert.equal(m.window.contextMenu.open(m.row('Raid'), m.row('Raid')), false, 'a member has no row menu');
    assert.equal(m.window.voiceChannels.rename(m.row('Raid')), false);
});

test('with only General the section shows one row and the buddy line has no channel text', async () => {
    const f = await windowRoom({ owner: false, channels: [GENERAL] });
    assert.deepEqual(f.rows().map(li => li.querySelector('.vc-name').textContent), ['General']);
    f.member(SAM, {});
    assert.equal(f.buddy(SAM).textContent, 'in voice');
});

test('cues: a person that comes into my channel or goes out of it; no cue for a move between two other channels', async () => {
    const clock = createClock();
    const f = await windowRoom({ clock, attention: true, channels: [GENERAL, { id: RAID, name: 'Raid' }, { id: LOBBY, name: 'Lobby' }] });
    const played = [];
    const own = [];
    f.window.voiceCues = { play: (_context, kind) => { (['join', 'leave', 'mute', 'unmute'].includes(kind) ? own : played).push(kind); return true; } };
    f.window.idlePeer = { isIdle: () => false };
    f.document.hasFocus = () => true;
    f.document.visibilityState = 'visible';
    clock.advance(5000);
    f.member(SAM, { channel: LOBBY });
    f.member(ALEX, { channel: 'general' });
    f.row('Raid').click();
    await settle();
    assert.deepEqual(own, ['join']);
    clock.advance(1000);
    f.member(SAM, { channel: 'general' });
    assert.deepEqual(played, [], 'a move between two other channels: no cue');
    f.member(SAM, { channel: RAID });
    assert.deepEqual(played, ['other-join'], 'Sam comes into my channel');
    clock.advance(1000);
    f.member(SAM, { channel: RAID, muted: true });
    assert.deepEqual(played, ['other-join'], 'a mute is not a move');
    clock.advance(1000);
    f.member(SAM, { channel: LOBBY });
    assert.deepEqual(played, ['other-join', 'other-leave'], 'Sam goes out of my channel');
    // My own move plays the join cue, and no cue for the people of the two channels.
    f.row('General').click();
    await settle();
    assert.deepEqual(own, ['join', 'join']);
    assert.deepEqual(played, ['other-join', 'other-leave']);
    clock.advance(1000);
    f.member(ALEX, { inVoice: false });
    assert.deepEqual(played, ['other-join', 'other-leave', 'other-leave'], 'Alex leaves voice from my channel');
    assert.deepEqual(f.errors, []);
});

test('the detached voice panel starts the microphone line with the channel; the map says "in voice · Raid"', async () => {
    const { createDom } = await import('./helpers/fake-dom.mjs');
    const panel = createDom([{ id: 'mic' }, { id: 'mute', tag: 'button' }, { id: 'speakers' }, { id: 'back', tag: 'button' }]);
    let onState;
    panel.window.voiceMonitor = { onState: fn => { onState = fn; }, setMuted() {}, close() {} };
    vm.runInNewContext(await read('voice-monitor.js'), { window: panel.window, document: panel.document });
    onState({ inVoice: true, muted: false, deafened: false, transmitting: false, speakers: [], theme: 'x', channel: 'Raid' });
    assert.equal(panel.document.getElementById('mic').textContent, 'Raid · Mic ready');
    onState({ inVoice: false, muted: false, speakers: [], theme: 'x', channel: '' });
    assert.equal(panel.document.getElementById('mic').textContent, 'Mic off');

    const map = createDom([{ id: 'node-map' }, { id: 'map-legend' }]);
    map.document.createElementNS = (_, name) => map.document.createElement(name);
    map.window.matchMedia = () => ({ matches: true });
    vm.runInNewContext(await read('nodemap.js'), { document: map.document, window: map.window,
        ResizeObserver: class { observe() {} }, setTimeout: () => 1, clearTimeout() {} });
    map.window.nodeMap.update({ self: 'a', host: 'a', nodes: [{ id: 'a' }, { id: 'b', name: 'Bo', inVoice: true, channel: 'Raid' }],
        links: { a: ['b'] }, kinds: {} });
    const facts = map.document.querySelector('[data-node="b"]').querySelector('title').textContent;
    assert.match(facts, /^in voice · Raid$/m);
});

test('voice.js follows the channel that the node uses (General for an ID that the node does not know)', async () => {
    const l = await listener();
    l.room.window.asscrack.setVoice = async state => ({ channel: state.inVoice ? 'general' : 'general' });
    await l.voice.join(RAID);
    assert.equal(l.voice.state().channel, 'general');
    l.room.window.asscrack.setVoice = async state => ({ channel: state.channel === LOBBY ? 'general' : state.channel });
    await l.voice.move(LOBBY);
    assert.equal(l.voice.state().channel, 'general');
    assert.equal(l.microphones(), 1);
});
