// G4 (C1, N1, C2, C5, C6, C7, C8): the real voice.js and the real room scripts (renderer.js) in node:vm, in the method
// of test/voice-listening.test.mjs. A fake getUserMedia, a fake device list and a fake AudioContext take the place of
// the audio devices. The playback worklet is the real one (voice-worklet.js), thus the mixer output is real. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createClock } from './helpers/fake-clock.mjs';

const worklet = await readFile(new URL('../src/application/voice-worklet.js', import.meta.url), 'utf8');
const MOD = { ctrlKey: true, shiftKey: true };
const NO_MIC = 'No microphone. You can listen, but the others cannot hear you. Connect a microphone and ASSCRACK uses it.';
const MIC_GONE = 'The microphone was disconnected. ASSCRACK uses the default microphone.';
const SPEAKERS_GONE = 'The selected speakers are not connected. ASSCRACK uses the default speakers.';

function domError(name) {
    return Object.assign(new Error(`${name} from the fake device`), { name });
}

function makeTrack(label) {
    const listeners = [];
    return {
        label, enabled: true, stopped: false,
        getSettings: () => ({}),
        stop() { this.stopped = true; },
        addEventListener(type, fn) { if (type === 'ended') listeners.push(fn); },
        // The device of the track went away.
        end() { for (const fn of listeners) fn(); }
    };
}

// settings: the saved voice settings. Returns the room fixture and the fake devices.
async function voiceRoom(settings = {}) {
    const clock = createClock();
    const registered = {};
    vm.runInContext(worklet, vm.createContext({
        AudioWorkletProcessor: class { port = {}; },
        registerProcessor: (name, ctor) => { registered[name] = ctor; }
    }));
    let mixer = null;
    const devices = [
        { kind: 'audioinput', deviceId: 'mic-usb' }, { kind: 'audioinput', deviceId: 'mic-built-in' },
        { kind: 'audiooutput', deviceId: 'speakers-usb' }, { kind: 'audiooutput', deviceId: 'speakers-built-in' }
    ];
    const mic = { fail: null, calls: [], tracks: [] };
    const sinks = [];
    const changeListeners = [];
    const navigator = {
        userAgent: 'test',
        mediaDevices: {
            async getUserMedia(constraints) {
                mic.calls.push(constraints);
                if (mic.fail) throw domError(mic.fail);
                const wanted = constraints.audio.deviceId?.exact;
                if (wanted && !devices.some(d => d.kind === 'audioinput' && d.deviceId === wanted)) {
                    throw domError('OverconstrainedError');
                }
                if (!devices.some(d => d.kind === 'audioinput')) throw domError('NotFoundError');
                const track = makeTrack(wanted ?? 'default');
                mic.tracks.push(track);
                const id = `stream-${mic.tracks.length}`;
                return { id, getAudioTracks: () => [track], getTracks: () => [track] };
            },
            enumerateDevices: async () => devices.map(d => ({ ...d, label: d.deviceId })),
            addEventListener(type, fn) { if (type === 'devicechange') changeListeners.push(fn); }
        }
    };
    const device = { connect() {}, disconnect() {} };
    class AudioContext {
        state = 'running';
        sinkId = '';
        destination = {};
        audioWorklet = { async addModule() {} };
        createMediaStreamSource() { return device; }
        async resume() {}
        async close() {}
        async setSinkId(id) {
            sinks.push(id);
            if (id !== '' && !devices.some(d => d.kind === 'audiooutput' && d.deviceId === id)) throw domError('NotFoundError');
            this.sinkId = id;
        }
    }
    class AudioWorkletNode {
        constructor(_context, name) {
            const processor = new registered[name]();
            if (name === 'voice-playback') mixer = processor;
            this.port = { postMessage(data) { processor.port.onmessage?.({ data }); } };
        }
        connect() {}
        disconnect() {}
    }
    const f = await loadRoomWindow({
        clock,
        before: ['voice-gate.js', 'voice.js'],
        globals: {
            navigator, AudioContext, AudioWorkletNode, performance,
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
        },
        api: {
            getHost: async () => ({ self: 'self-peer-id', host: null }),
            getVoiceSettings: async () => ({ noiseSuppression: 'off', inputDeviceId: '', outputDeviceId: '', ...settings })
        }
    });
    const dialog = f.el('listening-dialog');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    await f.login('Parker');
    for (const [peerId, name] of [['a', 'Sam'], ['b', 'Alex']]) {
        f.handlers.onPeerJoined({ peerId });
        f.handlers.onPeerName({ peerId, name });
    }
    Object.assign(f, {
        clock, devices, mic, sinks, dialog,
        voice: () => f.window.voice.state(),
        async join() {
            f.el('join-voice').click();
            await settle();
        },
        async leave() {
            f.el('leave-voice').click();
            await settle();
        },
        // The 'devicechange' event of the window, then the 500 ms of voice.js.
        async deviceChange() {
            for (const fn of changeListeners) fn();
            f.clock.advance(500);
            await settle();
        },
        setVoiceCalls: () => f.calls.filter(c => c.name === 'setVoice').map(c => c.args[0]),
        lastSetVoice: () => f.setVoiceCalls().at(-1),
        ownLine: () => f.el('peers').children[0].querySelector('.voice-state').textContent,
        line: peerId => f.el('peers').children.find(row => row.dataset.peerId === peerId).querySelector('.voice-state').textContent,
        error: () => f.el('voice-error').textContent,
        // Three frames of each person: 2/8 from a, 4/8 from b.
        samples() {
            for (let i = 0; i < 3; i++) {
                f.handlers.onVoiceFrame({ origin: 'a', data: Uint8Array.of(2) });
                f.handlers.onVoiceFrame({ origin: 'b', data: Uint8Array.of(4) });
            }
        },
        output() {
            const stereo = [new Float32Array(128), new Float32Array(128)];
            mixer.process([], [stereo]);
            return stereo[0][0];
        },
        keys(code) {
            return f.key(f.document, code.slice(-1), { code, ...MOD });
        }
    });
    return f;
}

test('an ended track opens the capture again; with no microphone the user stays in voice, and a device change opens it (C1)', async () => {
    const f = await voiceRoom();
    await f.join();
    assert.equal(f.voice().inVoice, true);
    assert.equal(f.voice().capturing, true);
    assert.equal(f.mic.calls.length, 1);
    assert.equal(f.ownLine(), 'in voice');

    // The device of the track went away and a different microphone is the default now.
    f.mic.tracks[0].end();
    await settle();
    assert.equal(f.mic.calls.length, 2, 'the capture opens again');
    assert.equal(f.voice().capturing, true);
    assert.equal(f.voice().inVoice, true);
    assert.equal(f.setVoiceCalls().length, 1, 'the peers see no change');

    // The last microphone went away.
    f.mic.fail = 'NotFoundError';
    f.mic.tracks[1].end();
    await settle();
    assert.equal(f.voice().inVoice, true);
    assert.equal(f.voice().capturing, false);
    assert.equal(f.voice().captureError, 'not-found');
    assert.equal(f.lastSetVoice().muted, true, 'the others see "in voice (muted)"');
    assert.equal(f.lastSetVoice().inVoice, true);
    assert.equal(f.error(), NO_MIC);
    assert.equal(f.ownLine(), 'in voice (no microphone)');

    // A microphone comes: the capture opens and the text goes away.
    f.mic.fail = null;
    await f.deviceChange();
    assert.equal(f.voice().capturing, true);
    assert.equal(f.voice().captureError, null);
    assert.equal(f.lastSetVoice().muted, false);
    assert.equal(f.error(), '');
    assert.equal(f.ownLine(), 'in voice');
    assert.deepEqual(f.errors, []);
});

test('Join with no microphone (NotFoundError) gives inVoice true, muted true to the peers, and the voice of the others (N1)', async () => {
    const f = await voiceRoom();
    f.mic.fail = 'NotFoundError';
    await f.join();
    assert.equal(f.voice().inVoice, true);
    assert.equal(f.document.body.classList.contains('in-voice'), true);
    assert.deepEqual(f.setVoiceCalls().map(c => [c.inVoice, c.muted]), [[true, true]]);
    assert.equal(f.voice().captureError, 'not-found');
    assert.equal(f.error(), NO_MIC);
    assert.equal(f.ownLine(), 'in voice (no microphone)');
    f.samples();
    assert.equal(f.output(), 0.75, 'the user hears the others');
    // A device change with still no microphone: no new state for the peers.
    await f.deviceChange();
    assert.equal(f.setVoiceCalls().length, 1);
    assert.equal(f.error(), NO_MIC);
    await f.leave();
    assert.equal(f.error(), '', 'the text goes away at Leave');
    assert.deepEqual(f.errors, []);
});

test('each microphone error name gives its text, and Join does not fail (C7)', async () => {
    const texts = {
        NotAllowedError: 'Windows does not let ASSCRACK use the microphone. Open Windows Settings, Privacy, Microphone, ' +
            'and allow desktop apps.',
        NotReadableError: 'The microphone did not start. A different app can have it in use. Close that app, or select ' +
            'a different microphone in Voice settings.',
        NotFoundError: NO_MIC,
        AbortError: 'The microphone did not start.'
    };
    const atJoin = { NotAllowedError: ' You can listen until then.', NotReadableError: ' You can listen until then.' };
    for (const [name, text] of Object.entries(texts)) {
        const f = await voiceRoom();
        f.mic.fail = name;
        await f.join();
        assert.equal(f.voice().inVoice, true, name);
        assert.equal(f.error(), text + (atJoin[name] ?? ''), name);
        // The text of the Voice settings panel (not in voice): the same function, with no addition.
        assert.equal(f.window.voice.microphoneErrorText(domError(name)), text, name);
    }
});

test('the selected devices: a missing microphone or speakers give the default device and a text until they come back (C1)', async () => {
    const f = await voiceRoom({ inputDeviceId: 'mic-usb', outputDeviceId: 'speakers-usb' });
    await f.join();
    assert.equal(f.voice().inputFallback, false);
    assert.deepEqual(f.sinks, ['speakers-usb']);
    assert.equal(f.error(), '');

    // The USB headset goes away: first the track ends, then the device list changes.
    f.devices.splice(0, 1);
    f.devices.splice(1, 1);
    f.mic.tracks[0].end();
    await settle();
    await f.deviceChange();
    assert.equal(f.voice().capturing, true);
    assert.equal(f.voice().inputFallback, true);
    assert.equal(f.voice().outputFallback, true);
    assert.equal(f.sinks.at(-1), '');
    assert.equal(f.error(), `${MIC_GONE} ${SPEAKERS_GONE}`);
    const opens = f.mic.calls.length;
    // A device change with no change of the selected devices does not open the capture again.
    await f.deviceChange();
    assert.equal(f.mic.calls.length, opens);

    // The headset comes back.
    f.devices.push({ kind: 'audioinput', deviceId: 'mic-usb' }, { kind: 'audiooutput', deviceId: 'speakers-usb' });
    await f.deviceChange();
    assert.equal(f.voice().inputFallback, false);
    assert.equal(f.voice().outputFallback, false);
    assert.equal(f.sinks.at(-1), 'speakers-usb');
    assert.equal(f.mic.calls.at(-1).audio.deviceId.exact, 'mic-usb');
    assert.equal(f.error(), '');
    assert.deepEqual(f.errors, []);
});

test('while deafened no samples reach the mixer, the levels still update, and the voice comes back after Deafen off (C2)', async () => {
    const f = await voiceRoom();
    await f.join();
    assert.equal(f.el('deafen').hidden, false);
    f.keys('KeyD');
    assert.equal(f.voice().deafened, true);
    assert.equal(f.voice().muted, true);
    assert.equal(f.el('deafen').getAttribute('aria-pressed'), 'true');
    assert.equal(f.mic.tracks[0].enabled, false, 'Deafen mutes the microphone');
    assert.deepEqual([f.lastSetVoice().muted, f.lastSetVoice().deafened], [true, true]);
    assert.equal(f.ownLine(), 'in voice (deafened)');
    f.samples();
    assert.equal(f.output(), 0, 'no samples while deafened');
    const levels = await f.window.voice.stats();
    assert.ok(levels.a.audioLevel > 0 && levels.b.audioLevel > 0, 'the level of each person still updates');

    f.el('deafen').click();
    assert.equal(f.voice().deafened, false);
    assert.equal(f.voice().muted, false);
    assert.equal(f.mic.tracks[0].enabled, true);
    f.samples();
    assert.equal(f.output(), 0.75, 'the voice comes back');
    assert.deepEqual([f.lastSetVoice().muted, f.lastSetVoice().deafened], [false, false]);
    assert.deepEqual(f.errors, []);
});

test('Deafen off and Leave give back the mute state from before; Unmute while deafened turns Deafen off (C2)', async () => {
    const f = await voiceRoom();
    await f.join();
    f.el('mute').click();
    f.keys('KeyD');
    f.keys('KeyD');
    assert.deepEqual([f.voice().muted, f.voice().deafened], [true, false], 'muted before Deafen: still muted');
    f.el('mute').click();
    f.keys('KeyD');
    f.keys('KeyD');
    assert.deepEqual([f.voice().muted, f.voice().deafened], [false, false], 'not muted before Deafen: not muted');
    // Unmute while deafened.
    f.keys('KeyD');
    f.el('mute').click();
    assert.deepEqual([f.voice().muted, f.voice().deafened], [false, false]);
    assert.equal(f.el('deafen').getAttribute('aria-pressed'), 'false');
    f.samples();
    assert.equal(f.output(), 0.75);
    // Leave while deafened, with Mute on from before.
    f.keys('KeyM');
    f.keys('KeyD');
    await f.leave();
    assert.deepEqual([f.voice().muted, f.voice().deafened], [true, false]);
    assert.equal(f.el('deafen').hidden, true);
    assert.equal(f.ownLine(), 'not in voice (mic muted)');
    // Deafen is only in voice.
    f.keys('KeyD');
    assert.equal(f.voice().deafened, false);
    assert.deepEqual(f.errors, []);
});

test('Mute before Join, the state through Leave and Join, Ctrl+Shift+M, and Idle Peer sets it to off (C6, C8)', async () => {
    const f = await voiceRoom();
    assert.equal(f.el('mute').hidden, false, 'Mute shows before Join');
    assert.equal(f.el('deafen').hidden, true);
    const event = f.keys('KeyM');
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.voice().muted, true);
    assert.equal(f.el('mute').getAttribute('aria-pressed'), 'true');
    assert.equal(f.ownLine(), 'not in voice (mic muted)');
    assert.equal(f.setVoiceCalls().length, 0, 'Mute before Join sends nothing to the peers');
    await f.join();
    assert.deepEqual(f.setVoiceCalls().map(c => [c.inVoice, c.muted]), [[true, true]], 'the first voice state is muted');
    assert.equal(f.mic.tracks[0].enabled, false);
    assert.equal(f.ownLine(), 'in voice (muted)');
    await f.leave();
    assert.equal(f.voice().muted, true);
    await f.join();
    assert.equal(f.lastSetVoice().muted, true, 'the mute state stays through Leave and Join');
    f.keys('KeyM');
    assert.equal(f.lastSetVoice().muted, false);
    assert.equal(f.ownLine(), 'in voice');
    f.keys('KeyM');
    // Idle Peer sets Mute and Deafen to off.
    f.keys('KeyD');
    f.handlers.onIdlePeer({ idle: true, closeToTray: true });
    await settle();
    assert.deepEqual([f.voice().inVoice, f.voice().muted, f.voice().deafened], [false, false, false]);
    assert.equal(f.el('mute').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(f.errors, []);
});

test('"muted for you" and the volume after the state text; no speaking text for a person muted for me (C5)', async () => {
    const f = await voiceRoom();
    await f.join();
    f.handlers.onVoiceState({ peerId: 'a', inVoice: true, muted: false });
    f.handlers.onVoiceState({ peerId: 'b', inVoice: true, muted: true, deafened: true });
    assert.equal(f.line('a'), 'in voice');
    assert.equal(f.line('b'), 'in voice (deafened)');
    // The stats timer reads the levels: a speaks.
    f.samples();
    f.clock.advance(250);
    await settle();
    assert.equal(f.line('a'), 'speaking');

    const row = f.el('peers').children.find(item => item.dataset.peerId === 'a');
    row.focus();
    assert.equal(f.window.contextMenu.open(row, row), true);
    const item = f.el('row-menu').children.find(el => el.dataset.action === 'listening');
    item.focus();
    f.key(item, 'Enter');
    assert.equal(f.dialog.open, true);
    const volume = f.el('listener-volume');
    volume.value = '40';
    volume.dispatchEvent(new f.Event('input'));
    assert.equal(f.line('a'), 'speaking · 40%');
    const mute = f.el('listener-muted');
    mute.checked = true;
    mute.dispatchEvent(new f.Event('change'));
    assert.equal(f.line('a'), 'muted for you · 40%');
    f.samples();
    f.clock.advance(250);
    await settle();
    assert.equal(f.line('a'), 'muted for you · 40%', 'no speaking text for a person muted for me');
    volume.value = '100';
    volume.dispatchEvent(new f.Event('input'));
    assert.equal(f.line('a'), 'muted for you');
    assert.deepEqual(f.errors, []);
});
