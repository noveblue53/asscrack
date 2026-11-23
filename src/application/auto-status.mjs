// 1.0.4: the automatic status (operator, 2026-11-23: "detect desktop activity to set automatic status", non-invasive).
// - Away after no keyboard or mouse input for N minutes (powerMonitor.getSystemIdleTime only, no input data), and on
//   the lock screen and in sleep. Available again at the next input or at unlock. Not while in voice.
// - Optional: Do not disturb while a full-screen game or a presentation runs (SHQueryUserNotificationState through
//   the helper of win-helper.mjs, only while the option is on).
// The rule changes only Available to its own Away or Do not disturb, and back. A status that the user sets (Away, Do
// not disturb, Idle Peer, or Available while the rule has its own status) stays: the rule then does nothing more until
// the user is Available again.
// Electron is not imported: main.js gives the functions, so that a test can use fakes.

export const AWAY_CHOICES = Object.freeze([5, 10, 15, 0]); // minutes; 0 is Off
export const DEFAULT_SETTINGS = Object.freeze({ awayMinutes: 10, dndFullscreen: false });
export const IDLE_CHECK_MS = 20000;
// While the rule has its own Away: a short check, so that Available comes back soon after the next input.
export const AWAY_CHECK_MS = 2000;
// SHQueryUserNotificationState: QUNS_BUSY (2), QUNS_RUNNING_D3D_FULL_SCREEN (3), QUNS_PRESENTATION_MODE (4).
export const BUSY_STATES = Object.freeze([2, 3, 4]);

export function readSettings(value) {
    const v = value && typeof value === 'object' ? value : {};
    return {
        awayMinutes: AWAY_CHOICES.includes(v.awayMinutes) ? v.awayMinutes : DEFAULT_SETTINGS.awayMinutes,
        dndFullscreen: v.dndFullscreen === true
    };
}

// The wanted automatic state and its reason. awayMs 0: no automatic Away.
export function wantedState({ awayMs, idleMs, locked, asleep, inVoice, dndFullscreen, busy }) {
    if (dndFullscreen && busy) return { state: 'dnd', reason: 'fullscreen' };
    if (awayMs > 0 && !inVoice) {
        if (locked) return { state: 'away', reason: 'lock' };
        if (asleep) return { state: 'away', reason: 'sleep' };
        if (idleMs >= awayMs) return { state: 'away', reason: 'idle' };
    }
    return { state: 'available', reason: null };
}

// presence(): { state, note } of the room, or null (no room). setPresence({ state, note }) applies a state the same
// way as a choice of the user, and gives the new { state, note }. idleSeconds(): powerMonitor.getSystemIdleTime().
// inVoice(), idlePeer(): booleans. settings(): readSettings value. startQuns(onState, onEnd) starts the helper of the
// notification state and gives { stop() }. journal(event, reason): the journal line. awayMs(): an override of the
// Away time in ms for a dev check, or null.
export function createAutoStatus({ presence, setPresence, idleSeconds, inVoice, idlePeer, settings, startQuns = null,
    journal = () => {}, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, awayMs = () => null }) {
    let own = null; // 'away' | 'dnd' | null: the state that the rule set
    let ownNote = '';
    let locked = false;
    let asleep = false;
    let busy = false;
    let quns = null;
    let timer = null;
    let running = false;

    const config = () => {
        const s = readSettings(settings());
        const override = awayMs();
        return { ...s, awayMs: Number.isInteger(override) && override > 0 && s.awayMinutes > 0 ? override : s.awayMinutes * 60000 };
    };

    function schedule() {
        if (timer !== null) clearTimer(timer);
        timer = null;
        if (!running) return;
        const c = config();
        if (c.awayMs <= 0 && own !== 'away') return;
        const ms = own === 'away' ? AWAY_CHECK_MS : Math.min(IDLE_CHECK_MS, Math.max(1000, Math.floor(c.awayMs / 4)));
        timer = setTimer(() => { timer = null; check(); schedule(); }, ms);
    }

    function updateQuns() {
        const want = running && config().dndFullscreen && typeof startQuns === 'function';
        if (want && !quns) {
            try {
                const mine = startQuns(state => {
                    const value = BUSY_STATES.includes(state);
                    if (value === busy) return;
                    busy = value;
                    check();
                }, () => {
                    // The helper ended: no Do not disturb from it. No new start until the setting changes.
                    if (quns !== mine) return;
                    quns = null;
                    busy = false;
                    check();
                });
                quns = mine;
            } catch (err) {
                quns = null;
                log('WARN', `status helper not started: ${String(err?.message ?? err).slice(0, 80)}`);
            }
        } else if (!want && quns) {
            try { quns.stop(); } catch { /* ended */ }
            quns = null;
            busy = false;
        }
    }

    // trigger: the cause of this check, for the reason of a return to Available.
    function check(trigger = null) {
        if (!running) return null;
        let current;
        try { current = presence(); } catch { current = null; }
        if (!current) { own = null; return null; }
        // A status that the user set: the rule does not change it, and forgets its own.
        if (own && current.state !== own) own = null;
        if (!own && current.state !== 'available') return null;
        if (idlePeer()) return null;
        const c = config();
        let idleMs = 0;
        try { idleMs = Math.max(0, Number(idleSeconds()) || 0) * 1000; } catch { idleMs = 0; }
        const want = wantedState({ awayMs: c.awayMs, idleMs, locked, asleep, inVoice: inVoice(), dndFullscreen: c.dndFullscreen, busy });
        if (want.state === (own ?? 'available')) return null;
        const note = own ? ownNote : current.note ?? '';
        let applied;
        try {
            applied = setPresence({ state: want.state, note });
        } catch (err) {
            log('WARN', `automatic status not set: ${String(err?.message ?? err).slice(0, 80)}`);
            return null;
        }
        const was = own;
        if (want.state === 'available') {
            own = null;
            const reason = trigger ?? (was === 'dnd' ? 'fullscreen-end' : inVoice() ? 'voice' : c.awayMs <= 0 ? 'off' : 'input');
            journal('auto-back', reason);
        } else {
            own = want.state;
            ownNote = applied?.note ?? note;
            journal(want.state === 'dnd' ? 'auto-dnd' : 'auto-away', want.reason);
        }
        schedule();
        return want.state;
    }

    return {
        start() {
            if (running) return;
            running = true;
            own = null;
            updateQuns();
            schedule();
        },
        stop() {
            running = false;
            own = null;
            if (timer !== null) clearTimer(timer);
            timer = null;
            updateQuns();
        },
        // The user set a status (the status menu, /away, a note). The rule forgets its own status.
        manual() { own = null; schedule(); },
        // powerMonitor events: lock-screen, unlock-screen, suspend, resume.
        power(event) {
            if (event === 'lock-screen') { locked = true; return check(); }
            if (event === 'unlock-screen') { locked = false; asleep = false; return check('unlock'); }
            if (event === 'suspend') { asleep = true; return check(); }
            if (event === 'resume') { asleep = false; return check('resume'); }
            return null;
        },
        // The voice state changed: in voice, the rule gives no Away (and ends its own Away).
        voice() { return check(); },
        settingsChanged() { updateQuns(); const result = check(); schedule(); return result; },
        check,
        state: () => ({ own, locked, asleep, busy, running, quns: quns !== null })
    };
}
