// The guard of a screen share that replaces a window share (Windows 10: a window share has the yellow capture border,
// a screen share has none). The screen shows more than the window: the share shows the screen only while the chosen
// window is the foreground window, is not minimized, is on the same monitor and covers all of it. Else the room window
// sends a "Paused" picture (screen-share.js). The state comes from one helper process (win-helper.mjs).
// Fail closed: no state yet, a stale state, a helper error or a helper exit all give "paused".
// Electron is not imported: main.js gives the helper start, so that a test can use a fake.
import { parseGuardLine } from './win-helper.mjs';

export const GUARD_FIRST_MS = 5000; // the first state of a new helper (Add-Type compiles C#)
export const GUARD_STALE_MS = 1500; // three heartbeats
// A pause starts at once. The share shows the screen again only after the window stays in front for this time: the
// screen can show the old window for some frames after a switch.
export const GUARD_RESUME_MS = 300;

// rect covers area: each edge of rect is on or outside the edge of area.
export function covers(rect, area) {
    return Boolean(rect && area && rect.left <= area.left && rect.top <= area.top && rect.right >= area.right && rect.bottom >= area.bottom);
}

export const sameRect = (a, b) => Boolean(a && b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);

// The reason to pause for one state of the window, or null (show the screen). monitor: the monitor of the share.
export function pauseReason(state, monitor) {
    if (!state) return 'starting';
    if (!state.alive) return 'closed';
    if (state.minimized) return 'minimized';
    if (!state.visible) return 'hidden';
    if (!state.foreground) return 'background';
    if (!sameRect(state.monitor, monitor)) return 'moved';
    if (!covers(state.rect, monitor)) return 'size';
    return null;
}

// start(hwnd, { onLine, onExit }) starts a helper and gives { pid, stop() }. onChange({ active, paused, reason }) at
// each change of the share state. setTimer(fn, ms) / clearTimer(id): the timers (a test gives fakes).
export function createShareGuard({ start, onChange = () => {}, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
    firstMs = GUARD_FIRST_MS, staleMs = GUARD_STALE_MS, resumeMs = GUARD_RESUME_MS }) {
    let run = null; // { helper, monitor, state, armed, paused, reason, staleTimer, gen }
    let gen = 0;

    function emit() {
        onChange(run?.armed ? { active: true, paused: run.paused, reason: run.reason } : { active: false, paused: true, reason: 'off' });
    }

    function apply(paused, reason) {
        if (paused === run.paused && reason === run.reason) return;
        const was = run.paused;
        run.paused = paused;
        run.reason = reason;
        if (paused !== was) log('EVENT', paused ? `screen guard paused reason=${reason}` : 'screen guard resumed');
        emit();
    }
    const cancelResume = mine => {
        if (mine.resumeTimer !== null) clearTimer(mine.resumeTimer);
        mine.resumeTimer = null;
    };

    function evaluate(stale = false) {
        if (!run?.armed) return;
        const mine = run;
        mine.stale = stale;
        const reason = stale ? 'stale' : mine.failed ? 'helper' : pauseReason(mine.state, mine.monitor);
        if (reason !== null) {
            cancelResume(mine);
            apply(true, reason);
            return;
        }
        if (!mine.paused || mine.resumeTimer !== null) return;
        mine.resumeTimer = setTimer(() => {
            mine.resumeTimer = null;
            if (run !== mine || mine.stale || mine.failed || pauseReason(mine.state, mine.monitor) !== null) return;
            apply(false, null);
        }, resumeMs);
    }

    function armStale() {
        if (!run) return;
        if (run.staleTimer !== null) clearTimer(run.staleTimer);
        const mine = run;
        run.staleTimer = setTimer(() => { if (run === mine) { mine.staleTimer = null; evaluate(true); } }, staleMs);
    }

    // Starts the helper for the window. Gives a promise of the first state ({ alive, foreground, rect, monitor ... }).
    // A failure before the first state, and a close before it, stop the helper and reject the promise.
    function open(hwnd) {
        close('reopen');
        const mine = { helper: null, monitor: null, state: null, armed: false, paused: true, reason: 'starting', staleTimer: null,
            resumeTimer: null, stale: false, failed: false, gen: ++gen, cancel: null };
        run = mine;
        return new Promise((resolve, reject) => {
            let settled = false;
            let firstTimer = null;
            const settle = (fn, value) => {
                if (settled) return;
                settled = true;
                mine.cancel = null;
                if (firstTimer !== null) clearTimer(firstTimer);
                fn(value);
            };
            const fail = (why, message) => {
                if (settled) return;
                settle(reject, new Error(message));
                if (run === mine) close(why);
            };
            mine.cancel = () => settle(reject, new Error('The window guard stopped.'));
            firstTimer = setTimer(() => { firstTimer = null; fail('timeout', 'The window state did not come.'); }, firstMs);
            mine.helper = start(hwnd, {
                onLine(line) {
                    if (run !== mine) return;
                    if (line.startsWith('error')) {
                        mine.failed = true;
                        log('WARN', `screen guard helper failed: ${line.slice(6, 40) || 'error'}`);
                        fail('failed', 'The window guard did not start.');
                        evaluate();
                        return;
                    }
                    const state = parseGuardLine(line);
                    if (!state) return;
                    mine.state = state;
                    armStale();
                    settle(resolve, state);
                    evaluate();
                },
                onExit(info) {
                    if (run !== mine) return;
                    mine.failed = true;
                    if (mine.staleTimer !== null) { clearTimer(mine.staleTimer); mine.staleTimer = null; }
                    log('WARN', `screen guard helper ended code=${info?.code ?? 'none'}${info?.error ? ` error=${info.error}` : ''}`);
                    fail('ended', 'The window guard ended.');
                    evaluate();
                }
            });
            if (run === mine && mine.helper?.pid) log('EVENT', 'screen guard helper started');
        });
    }

    // The share uses the screen of this monitor. From now on, each state gives paused or not.
    function arm(monitor) {
        if (!run) return null;
        run.monitor = monitor ?? null;
        run.armed = true;
        run.paused = true;
        run.reason = 'starting';
        evaluate();
        emit();
        return current();
    }

    function close(why = 'stop') {
        const mine = run;
        if (!mine) return false;
        run = null;
        mine.cancel?.();
        cancelResume(mine);
        if (mine.staleTimer !== null) clearTimer(mine.staleTimer);
        try { mine.helper?.stop(); } catch { /* ended */ }
        log('EVENT', `screen guard stopped reason=${why}`);
        if (mine.armed) emit();
        return true;
    }

    function current() {
        return run?.armed ? { active: true, paused: run.paused, reason: run.reason } : { active: false, paused: true, reason: 'off' };
    }

    return { open, arm, close, state: current, running: () => run !== null, pid: () => run?.helper?.pid ?? null };
}
