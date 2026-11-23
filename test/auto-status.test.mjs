// 1.0.4: the automatic status (operator, 2026-11-23). Away after no input for N minutes, on the lock screen and in
// sleep; Available again at the next input or at unlock; never in voice; a status of the user always wins; optional
// Do not disturb in a full-screen game. Fakes for the idle time, the timers and the helper; no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AWAY_CHECK_MS, createAutoStatus, IDLE_CHECK_MS, readSettings, wantedState } from '../src/application/auto-status.mjs';
import { redact } from '../src/application/journal.mjs';

function setup({ settings = {}, room = true } = {}) {
    const env = { idle: 0, voice: false, idlePeer: false, settings: { awayMinutes: 10, dndFullscreen: false, ...settings },
        presence: room ? { state: 'available', note: 'raid at 9' } : null, sets: [], journal: [], helpers: [], timers: new Map() };
    let nextTimer = 1;
    const auto = createAutoStatus({
        presence: () => env.presence && { ...env.presence },
        setPresence: value => { env.sets.push(value.state); env.presence = { ...value }; return { ...value }; },
        idleSeconds: () => env.idle,
        inVoice: () => env.voice,
        idlePeer: () => env.idlePeer,
        settings: () => env.settings,
        startQuns: (onState, onEnd) => {
            const helper = { onState, onEnd, stopped: false, stop() { this.stopped = true; } };
            env.helpers.push(helper);
            return helper;
        },
        journal: (event, reason) => env.journal.push(`${event} ${reason}`),
        setTimer: (fn, ms) => { const id = nextTimer++; env.timers.set(id, { fn, ms }); return id; },
        clearTimer: id => env.timers.delete(id)
    });
    // Run the pending check timer (there is at most one).
    env.tick = () => {
        const entries = [...env.timers];
        assert.equal(entries.length, 1, 'one check timer');
        const [id, t] = entries[0];
        env.timers.delete(id);
        t.fn();
        return t.ms;
    };
    env.nextMs = () => [...env.timers.values()][0]?.ms ?? null;
    // The user picks a status (asscrack:set-presence).
    env.user = state => { env.presence = { ...env.presence, state }; auto.manual(); };
    auto.start();
    return { auto, env };
}

test('idle rule: Away after 10 min with no input, Available at the next input; the note stays; checks each 20 s', () => {
    const { env } = setup();
    assert.equal(env.nextMs(), IDLE_CHECK_MS);
    env.idle = 599;
    env.tick();
    assert.deepEqual(env.sets, [], '9 min 59 s: no change');
    env.idle = 600;
    env.tick();
    assert.deepEqual(env.sets, ['away']);
    assert.deepEqual(env.presence, { state: 'away', note: 'raid at 9' }, 'the note of the user stays');
    assert.deepEqual(env.journal, ['auto-away idle']);
    assert.equal(env.nextMs(), AWAY_CHECK_MS, 'a short check while Away');
    env.idle = 1200;
    env.tick();
    assert.deepEqual(env.sets, ['away'], 'still no input');
    env.idle = 1;
    env.tick();
    assert.deepEqual(env.sets, ['away', 'available']);
    assert.deepEqual(env.presence, { state: 'available', note: 'raid at 9' });
    assert.deepEqual(env.journal, ['auto-away idle', 'auto-back input']);
    assert.equal(env.nextMs(), IDLE_CHECK_MS);
});

test('idle rule: 5 and 15 min, and Off (no Away on idle and no Away on lock)', () => {
    for (const [minutes, below, at] of [[5, 299, 300], [15, 899, 900]]) {
        const { env } = setup({ settings: { awayMinutes: minutes } });
        env.idle = below;
        env.tick();
        assert.deepEqual(env.sets, []);
        env.idle = at;
        env.tick();
        assert.deepEqual(env.sets, ['away'], `${minutes} min`);
    }
    const { auto, env } = setup({ settings: { awayMinutes: 0 } });
    assert.equal(env.nextMs(), null, 'Off: no idle check');
    env.idle = 99999;
    auto.check();
    auto.power('lock-screen');
    auto.power('suspend');
    assert.deepEqual(env.sets, []);
    // Off while the rule has its own Away gives Available again.
    const on = setup();
    on.env.idle = 600;
    on.env.tick();
    on.env.settings.awayMinutes = 0;
    on.auto.settingsChanged();
    assert.deepEqual(on.env.sets, ['away', 'available']);
    assert.deepEqual(on.env.journal, ['auto-away idle', 'auto-back off']);
});

test('manual status wins: the rule never changes Away, Do not disturb or Idle Peer that the user set', () => {
    for (const state of ['away', 'dnd']) {
        const { auto, env } = setup();
        env.user(state);
        env.idle = 5000;
        env.tick();
        auto.power('lock-screen');
        env.idle = 0;
        auto.power('unlock-screen');
        env.tick();
        assert.deepEqual(env.sets, [], `the user's ${state} stays`);
        assert.equal(env.presence.state, state);
    }
    // The rule has its own Away. The user picks Do not disturb: the next input does not give Available.
    const { auto, env } = setup();
    env.idle = 600;
    env.tick();
    env.user('dnd');
    env.idle = 0;
    env.tick();
    auto.power('unlock-screen');
    assert.deepEqual(env.sets, ['away']);
    assert.equal(env.presence.state, 'dnd');
    // The user picks Away while the rule has its own Away: the user's Away stays after input.
    const again = setup();
    again.env.idle = 600;
    again.env.tick();
    again.env.user('away');
    again.env.idle = 0;
    again.env.tick();
    assert.deepEqual(again.env.sets, ['away'], 'a manual Away is not ended by input');
    assert.equal(again.env.presence.state, 'away');
    // Idle Peer: no change.
    const idle = setup();
    idle.env.idlePeer = true;
    idle.env.idle = 5000;
    idle.env.tick();
    idle.auto.power('lock-screen');
    assert.deepEqual(idle.env.sets, []);
});

test('voice blocks Away: no Away on idle or lock in voice; joining voice ends the own Away', () => {
    const { auto, env } = setup();
    env.voice = true;
    env.idle = 5000;
    env.tick();
    auto.power('lock-screen');
    assert.deepEqual(env.sets, [], 'in voice');
    auto.power('unlock-screen');
    env.voice = false;
    env.tick();
    assert.deepEqual(env.sets, ['away'], 'out of voice: Away');
    env.voice = true;
    auto.voice();
    assert.deepEqual(env.sets, ['away', 'available']);
    assert.deepEqual(env.journal, ['auto-away idle', 'auto-back voice']);
});

test('lock and unlock, sleep and resume: Away at once, Available at unlock or at the next input after resume', () => {
    const { auto, env } = setup();
    env.idle = 3;
    auto.power('lock-screen');
    assert.deepEqual(env.sets, ['away']);
    env.idle = 0;
    env.tick();
    assert.deepEqual(env.sets, ['away'], 'input on the lock screen: still Away');
    auto.power('unlock-screen');
    assert.deepEqual(env.sets, ['away', 'available']);
    auto.power('suspend');
    assert.deepEqual(env.sets, ['away', 'available', 'away']);
    env.idle = 2;
    auto.power('resume');
    assert.deepEqual(env.sets, ['away', 'available', 'away', 'available']);
    assert.deepEqual(env.journal, ['auto-away lock', 'auto-back unlock', 'auto-away sleep', 'auto-back resume']);
    // Resume with no input since the sleep: Away stays until input.
    const idleWake = setup();
    idleWake.auto.power('suspend');
    idleWake.env.idle = 700;
    idleWake.auto.power('resume');
    assert.deepEqual(idleWake.env.sets, ['away']);
    idleWake.env.idle = 0;
    idleWake.env.tick();
    assert.deepEqual(idleWake.env.sets, ['away', 'available']);
});

test('full-screen Do not disturb: off by default (no helper); on: the helper runs, a game gives Do not disturb', () => {
    const off = setup();
    assert.equal(off.env.helpers.length, 0, 'no helper while the option is off');
    const { auto, env } = setup({ settings: { dndFullscreen: true } });
    assert.equal(env.helpers.length, 1);
    env.helpers[0].onState(5); // QUNS_ACCEPTS_NOTIFICATIONS
    assert.deepEqual(env.sets, []);
    env.helpers[0].onState(3); // QUNS_RUNNING_D3D_FULL_SCREEN
    assert.deepEqual(env.sets, ['dnd']);
    env.idle = 5000;
    env.tick();
    assert.deepEqual(env.sets, ['dnd'], 'a game with no input stays Do not disturb');
    env.idle = 0;
    env.helpers[0].onState(5);
    assert.deepEqual(env.sets, ['dnd', 'available']);
    env.helpers[0].onState(4); // QUNS_PRESENTATION_MODE
    env.helpers[0].onState(2); // QUNS_BUSY
    assert.deepEqual(env.sets, ['dnd', 'available', 'dnd']);
    assert.deepEqual(env.journal, ['auto-dnd fullscreen', 'auto-back fullscreen-end', 'auto-dnd fullscreen']);
    // The user's Away during a game: no Do not disturb.
    env.helpers[0].onState(5);
    env.user('away');
    env.helpers[0].onState(3);
    assert.equal(env.presence.state, 'away');
    // The option goes off: the helper stops.
    env.settings.dndFullscreen = false;
    auto.settingsChanged();
    assert.equal(env.helpers[0].stopped, true);
    // A helper that ends gives no Do not disturb.
    const ended = setup({ settings: { dndFullscreen: true } });
    ended.env.helpers[0].onState(3);
    ended.env.helpers[0].onEnd();
    assert.deepEqual(ended.env.sets, ['dnd', 'available']);
});

test('no room: no change; settings: only the choices 5, 10, 15 and Off; wantedState gives Do not disturb first', () => {
    const { auto, env } = setup({ room: false });
    env.idle = 5000;
    env.tick();
    auto.power('lock-screen');
    assert.deepEqual(env.sets, []);
    assert.deepEqual(readSettings(null), { awayMinutes: 10, dndFullscreen: false });
    assert.deepEqual(readSettings({ awayMinutes: 7, dndFullscreen: 'yes' }), { awayMinutes: 10, dndFullscreen: false });
    assert.deepEqual(readSettings({ awayMinutes: 0, dndFullscreen: true }), { awayMinutes: 0, dndFullscreen: true });
    assert.equal(wantedState({ awayMs: 600000, idleMs: 0, locked: true, asleep: false, inVoice: false, dndFullscreen: true, busy: true }).state, 'dnd');
    auto.stop();
    assert.equal(env.timers.size, 0, 'stop ends the checks');
});

test('journal: a status line has the event and the reason only', () => {
    assert.deepEqual(redact('status', { event: 'auto-away', reason: 'idle', idleMs: 600000, note: 'raid at 9' }),
        { type: 'status', event: 'auto-away', reason: 'idle' });
    assert.deepEqual(redact('status', { event: 'auto-back', reason: 'input' }), { type: 'status', event: 'auto-back', reason: 'input' });
    assert.deepEqual(redact('status', { event: 'typed hello', reason: 'x' }), { type: 'status' });
});
