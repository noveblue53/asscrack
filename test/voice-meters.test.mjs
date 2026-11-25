import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const read = name => readFile(new URL(`../src/application/${name}`, import.meta.url), 'utf8');
const voiceScripts = await Promise.all(['voice-gate.js', 'voice-worklet.js', 'voice.js'].map(read));
const voicePanelSource = await read('voice-panel.js');

function makeVoiceHost({ withAnalyser = false } = {}) {
    return loadRoomWindow().then(room => {
        const registered = {};
        let nowMs = 1000;
        let analyserConnected = false;
        const analyser = {
            fftSize: 64,
            smoothingTimeConstant: 0,
            getFloatTimeDomainData(buf) {
                for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((i / buf.length) * Math.PI * 2) * 0.5;
            },
            disconnect() { analyserConnected = false; }
        };
        const source = {
            connect(dest) { if (dest === analyser) analyserConnected = true; },
            disconnect() {}
        };
        const track = { label: 'Test mic', enabled: true, getSettings: () => ({}), stop() {} };
        const api = room.window.asscrack;
        api.getHost = async () => ({ self: 'self-id', host: null });
        api.getVoiceSettings = async () => ({ noiseSuppression: 'off', mode: 'voice', vadThresholdDb: -40 });
        let captureNode = null;
        const context = vm.createContext({
            window: room.window,
            performance: { now: () => nowMs },
            console,
            Uint8Array,
            Float32Array,
            navigator: {
                mediaDevices: {
                    getUserMedia: async () => ({ id: 'mic', getAudioTracks: () => [track], getTracks: () => [track] })
                }
            },
            AudioContext: class {
                audioWorklet = { async addModule() {} };
                createMediaStreamSource() { return source; }
                createAnalyser = withAnalyser ? (() => analyser) : undefined;
                async close() {}
            },
            AudioWorkletProcessor: class { port = {}; },
            registerProcessor: (name, ctor) => { registered[name] = ctor; },
            AudioWorkletNode: class {
                constructor(_ctx, name) {
                    const processor = new registered[name]();
                    this.port = {
                        onmessage: null,
                        postMessage(data) { processor.port.onmessage?.({ data }); }
                    };
                    if (name === 'voice-capture') captureNode = this;
                }
                connect() {}
                disconnect() {}
            },
            AudioEncoder: class {
                static async isConfigSupported() { return { supported: true }; }
                configure() {}
                close() {}
            },
            AudioData: class { close() {} },
            EncodedAudioChunk: class { constructor(init) { this.data = init.data; } },
            AudioDecoder: class {
                constructor({ output }) { this.output = output; }
                configure() {}
                close() {}
                decode(chunk) {
                    this.output({
                        numberOfFrames: 960,
                        copyTo(samples) {
                            const amp = chunk.data[0] / 10;
                            for (let i = 0; i < samples.length; i++) {
                                samples[i] = Math.sin((i / 48) * Math.PI * 2) * amp;
                            }
                        },
                        close() {}
                    });
                }
            }
        });
        for (const script of voiceScripts) vm.runInContext(script, context);
        return {
            room,
            voice: room.window.voice,
            advance(ms) { nowMs += ms; },
            now: () => nowMs,
            analyserConnected: () => analyserConnected,
            pushBlock(amp = 0.4) {
                const block = new Float32Array(960);
                for (let i = 0; i < block.length; i++) block[i] = Math.sin((i / 48) * Math.PI * 2) * amp;
                captureNode.port.onmessage({ data: block });
            }
        };
    });
}

test('voice.js meterSnapshot(): local waveform from onBlock and AnalyserNode, zeroed when muted', async () => {
    const hNoAnalyser = await makeVoiceHost({ withAnalyser: false });
    await hNoAnalyser.voice.join();
    hNoAnalyser.pushBlock(0.5);
    const snap1 = hNoAnalyser.voice.meterSnapshot(hNoAnalyser.now());
    assert.equal(snap1.local.capturing, true);
    assert.ok(snap1.local.level > 0, 'local level > 0 after speech block');
    assert.equal(snap1.local.wave.length, 24);
    assert.ok(snap1.local.wave.some(v => Math.abs(v) > 0.1), 'local wave populated from onBlock');

    hNoAnalyser.voice.setMuted(true);
    const snapMuted = hNoAnalyser.voice.meterSnapshot(hNoAnalyser.now());
    assert.equal(snapMuted.local.level, 0, 'local level zeroed when muted');
    assert.ok(snapMuted.local.wave.every(v => v === 0), 'local wave zeroed when muted');

    const hAnalyser = await makeVoiceHost({ withAnalyser: true });
    await hAnalyser.voice.join();
    assert.equal(hAnalyser.analyserConnected(), true, 'localAnalyser connected when supported');
    const snapA = hAnalyser.voice.meterSnapshot(hAnalyser.now());
    assert.ok(snapA.local.wave.some(v => Math.abs(v) > 0.1), 'local wave populated from AnalyserNode');
    await hAnalyser.voice.leave();
    assert.equal(hAnalyser.analyserConnected(), false, 'localAnalyser disconnected on leave');
});

test('voice.js meterSnapshot(): remote waveform, listening mute, and LEVEL_HOLD_MS expiry', async () => {
    const h = await makeVoiceHost();
    await h.voice.join();
    h.room.handlers.onVoiceFrame({ origin: 'peer-a', seq: 0, data: Uint8Array.of(5) });

    const active = h.voice.meterSnapshot(h.now());
    assert.ok(active.remotes['peer-a'], 'remote entry exists');
    assert.equal(active.remotes['peer-a'].active, true);
    assert.ok(active.remotes['peer-a'].level > 0);
    assert.ok(active.remotes['peer-a'].wave.some(v => Math.abs(v) > 0.1));

    h.voice.setListening('peer-a', true, 100);
    const mutedSnap = h.voice.meterSnapshot(h.now());
    assert.equal(mutedSnap.remotes['peer-a'].active, false);
    assert.equal(mutedSnap.remotes['peer-a'].level, 0);
    assert.ok(mutedSnap.remotes['peer-a'].wave.every(v => v === 0));

    h.voice.setListening('peer-a', false, 100);
    h.advance(350);
    const expired = h.voice.meterSnapshot(h.now());
    assert.equal(expired.remotes['peer-a'].active, false);
    assert.equal(expired.remotes['peer-a'].level, 0);
    assert.ok(expired.remotes['peer-a'].wave.every(v => v === 0));
});

test('voiceMetersCore: rmsToLevel, ledCount, 30fps createMeterLoop, and canvas drawing', () => {
    const ctxObj = { window: {} };
    vm.createContext(ctxObj);
    vm.runInContext(voicePanelSource, ctxObj);
    const core = ctxObj.window.voiceMetersCore;
    assert.ok(core, 'voiceMetersCore exported');

    assert.equal(core.rmsToLevel(0), 0);
    assert.ok(core.rmsToLevel(0.1) > 0.5);
    assert.equal(core.ledCount(0, 5), 0);
    assert.equal(core.ledCount(1, 5), 5);

    let now = 0;
    let active = false;
    let drawn = 0;
    let stoppedCount = 0;
    const queue = new Map();
    let nextId = 1;
    const loop = core.createMeterLoop({
        schedule: fn => { const id = nextId++; queue.set(id, fn); return id; },
        cancel: id => queue.delete(id),
        now: () => now,
        decide: () => active,
        draw: () => { drawn++; },
        stopped: () => { stoppedCount++; }
    });

    loop.refresh();
    assert.equal(loop.running(), false, 'does not start when silent/hidden');

    active = true;
    loop.refresh();
    assert.equal(loop.running(), true, 'starts when active');

    // Step at 16 ms (60 Hz): should throttle to ~30 fps
    for (let i = 0; i < 6; i++) {
        now += 16;
        const fns = [...queue.values()];
        queue.clear();
        for (const fn of fns) fn();
    }
    assert.equal(drawn, 3, 'throttled to ~30 fps across 96 ms');

    active = false;
    loop.refresh();
    assert.equal(loop.running(), false, 'stops immediately when hidden/silent');
    assert.ok(stoppedCount >= 1);

    // Mock 2D context drawing checks
    const ops = [];
    const mockCtx = {
        clearRect: (...a) => ops.push(['clear', ...a]),
        beginPath: () => ops.push(['begin']),
        moveTo: (...a) => ops.push(['move', ...a]),
        lineTo: (...a) => ops.push(['line', ...a]),
        stroke: () => ops.push(['stroke']),
        fillRect: (...a) => ops.push(['rect', ...a]),
        save: () => {},
        restore: () => {}
    };
    core.drawMiniOscilloscope(mockCtx, 0, 14, [0, 0.5, -0.5]);
    assert.equal(ops.length, 0, 'zero-width oscilloscope is a no-op');
    core.drawMiniOscilloscope(mockCtx, 38, 14, [0, 0.5, -0.5, 0]);
    assert.ok(ops.some(op => op[0] === 'stroke'), 'oscilloscope strokes waveform');

    ops.length = 0;
    core.drawLedBar(mockCtx, 38, 14, 0.8, 5);
    assert.equal(ops.filter(op => op[0] === 'rect').length, 5, '5 LED segments drawn');
});

test('voice-channels-ui.js renders canvas.vc-meter only for speaking members in own channel', async () => {
    const f = await loadRoomWindow({
        elements: [{ id: 'voice-channel-list', tag: 'ul' }],
        api: {
            getVoiceChannels: async () => ({
                owner: false,
                editable: false,
                seq: 1,
                channels: [{ id: 'general', name: 'General' }, { id: 'raid', name: 'Raid' }]
            })
        },
        scripts: ['voice-channels-ui.js']
    });
    await f.window.voiceChannels.start();
    await settle();
    f.window.voiceChannels.render({
        inVoice: true,
        channel: 'general',
        people: [
            { peerId: 'self-id', name: 'Me', self: true, inVoice: true, channel: 'general', speaking: true },
            { peerId: 'peer-quiet', name: 'Quiet', inVoice: true, channel: 'general', speaking: false },
            { peerId: 'peer-other', name: 'Other', inVoice: true, channel: 'raid', speaking: true }
        ]
    });

    const rows = f.el('voice-channel-list').children;
    const generalPeople = rows[0].querySelector('.vc-people').children;
    const raidPeople = rows[1].querySelector('.vc-people').children;
    assert.equal(generalPeople.length, 2);
    assert.equal(raidPeople.length, 1);

    const selfMeter = generalPeople[0].children.find(el => el.tagName === 'CANVAS');
    assert.ok(selfMeter, 'speaking member in own channel gets canvas.vc-meter');
    assert.equal(selfMeter.className, 'vc-meter');
    assert.equal(selfMeter.getAttribute('aria-hidden'), 'true');
    assert.equal(generalPeople[1].children.find(el => el.tagName === 'CANVAS'), undefined, 'quiet member has no canvas.vc-meter');
    assert.equal(raidPeople[0].children.find(el => el.tagName === 'CANVAS'), undefined, 'other-channel member has no canvas.vc-meter');
});
