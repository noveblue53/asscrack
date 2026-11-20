import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { createAsscrackNode } from '../src/network/node.mjs';
import { newRoomKey } from '../src/network/invite.mjs';
import { loadRoomWindow } from './helpers/renderer-fixture.mjs';

const scripts = await Promise.all(['voice-gate.js', 'voice-worklet.js', 'voice.js'].map(name =>
    readFile(new URL('../src/application/' + name, import.meta.url), 'utf8')));

// Keep the real buddy menu, voice bridge callbacks, decoder output handler, queued PCM and mixing code.
// Replace the OS audio device and codec with two known constant signals.
async function listener(peerIds = ['a', 'b']) {
    const room = await loadRoomWindow();
    const registered = {};
    let mixer;
    const device = { connect() {}, disconnect() {} };
    const track = { label: 'Test input', enabled: true, getSettings: () => ({}), stop() {} };
    const api = room.window.asscrack;
    api.getHost = async () => ({ self: 'local', host: null });
    api.getVoiceSettings = async () => ({ noiseSuppression: 'off' });
    const context = vm.createContext({
        window: room.window, performance, console, Uint8Array, Float32Array,
        navigator: { mediaDevices: { getUserMedia: async () =>
            ({ id: 'mic', getAudioTracks: () => [track], getTracks: () => [track] }) } },
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
                if (name === 'voice-playback') mixer = processor;
                this.port = { postMessage(data) { processor.port.onmessage({ data }); } };
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
            constructor({ output }) { this.output = output; }
            configure() {}
            close() {}
            decode(chunk) {
                this.output({ numberOfFrames: 960, copyTo(samples) { samples.fill(chunk.data[0] / 8); }, close() {} });
            }
        }
    });
    for (const script of scripts) vm.runInContext(script, context);
    const dialog = room.el('listening-dialog');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    for (const id of peerIds) {
        room.handlers.onPeerJoined({ peerId: id });
        room.handlers.onPeerName({ peerId: id, name: 'Same name' });
    }
    await room.window.voice.join();
    function samples() {
        for (let i = 0; i < 3; i++) {
            room.handlers.onVoiceFrame({ origin: 'a', data: Uint8Array.of(2) });
            room.handlers.onVoiceFrame({ origin: 'b', data: Uint8Array.of(4) });
        }
    }
    function open(id) {
        const row = room.el('peers').children.find(item => item.dataset.peerId === id);
        row.focus();
        assert.equal(room.window.contextMenu.open(row, row), true);
        const item = room.el('row-menu').children.find(el => el.dataset.action === 'listening');
        item.focus();
        room.key(item, 'Enter');
        assert.equal(dialog.open, true);
    }
    function output() {
        const stereo = [new Float32Array(128), new Float32Array(128)];
        mixer.process([], [stereo]);
        assert.deepEqual(stereo[0], stereo[1]);
        assert.ok(stereo[0].every(s => s === stereo[0][0]));
        return stereo[0][0];
    }
    return { room, samples, open, output, dialog, track };
}

test('buddy listening controls change only that listener’s mix, including already queued PCM', async () => {
    const a = await listener();
    const other = await listener();
    try {
        a.samples();
        other.samples();
        assert.equal(a.output(), 0.75);
        a.open('a');
        const mute = a.room.el('listener-muted');
        const volume = a.room.el('listener-volume');
        mute.checked = true;
        mute.dispatchEvent(new a.room.Event('change'));
        assert.equal(a.output(), 0.5);
        a.dialog.close();
        a.open('b');
        volume.value = '50';
        volume.dispatchEvent(new a.room.Event('input'));
        assert.equal(volume.getAttribute('aria-valuetext'), '50%');
        assert.equal(a.output(), 0.25);
        assert.equal(other.output(), 0.75);
        assert.ok(a.track.enabled);
        assert.equal(a.room.calls.filter(c => c.name === 'setVoice').length, 1); // Join only.
        volume.value = '100';
        volume.dispatchEvent(new a.room.Event('input'));
        a.dialog.close();
        a.open('a');
        assert.equal(mute.checked, true);
        mute.checked = false;
        mute.dispatchEvent(new a.room.Event('change'));
        assert.equal(a.output(), 0.75);
        mute.checked = true;
        mute.dispatchEvent(new a.room.Event('change'));
        a.room.handlers.onPeerLeft({ peerId: 'a' });
        assert.equal(a.dialog.open, false);
        assert.equal(a.room.window.voice.listeningFor('a').muted, false);
        assert.equal(a.output(), 0.5);
    } finally {
        await Promise.all([a.room.window.voice.leave(), other.room.window.voice.leave()]);
    }
});

test('127.0.0.1: muting at the host leaves its voice relay audible to another listener', { timeout: 20000 }, async () => {
    const options = { room: 'listening', roomKey: newRoomKey(), listen: ['/ip4/127.0.0.1/tcp/0'],
        heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500, discovery: false };
    const nodes = [];
    const listeners = [];
    async function waitFor(check) {
        const end = Date.now() + 5000;
        while (!check() && Date.now() < end) await delay(20);
        assert.ok(check());
    }
    try {
        const host = await createAsscrackNode({ ...options, fullNode: true });
        nodes.push(host);
        for (let i = 0; i < 2; i++) {
            const member = await createAsscrackNode({ ...options, relayOnly: true, fullNode: false });
            nodes.push(member);
            await member.connect(host.getMultiaddrs()[0]);
        }
        const [, source, viaHost] = nodes;
        await waitFor(() => nodes.every(node => node.host()?.peerId === host.peerId));
        for (const node of nodes) node.setVoice({ inVoice: true });
        await waitFor(() => host.voiceStats().streams === 2);
        const counts = [0, 0];
        for (const [index, node] of [host, viaHost].entries()) {
            const ui = await listener([source.peerId]);
            listeners.push(ui);
            node.events.on('voice-frame', frame => {
                if (frame.origin === source.peerId) {
                    ui.room.handlers.onVoiceFrame(frame);
                    counts[index]++;
                }
            });
        }
        const [direct, relayed] = listeners;
        direct.open(source.peerId);
        const mute = direct.room.el('listener-muted');
        mute.checked = true;
        mute.dispatchEvent(new direct.room.Event('change'));
        for (let i = 0; i < 3; i++) assert.ok(source.sendVoiceFrame(Uint8Array.of(4)));
        await waitFor(() => counts.every(n => n === 3));
        assert.equal(host.voiceStats().forwardedTo[source.peerId]?.[viaHost.peerId], 3);
        assert.equal(direct.output(), 0);
        assert.equal(relayed.output(), 0.5);
    } finally {
        await Promise.allSettled(listeners.map(ui => ui.room.window.voice.leave()));
        await Promise.allSettled(nodes.map(node => node.stop()));
    }
});
