// 1.0.6: the link status of one friend for the Friends list (friend-links.mjs). This module has no network and no
// timers of its own: the caller gives now, setTimer and clearTimer (the tests give a fake clock).
// Statuses (DECISIONS: friend presence, 1.0.6):
//   'connecting'  the first tries after the start of the friend node, after a lost session, or after a network change
//                 of this PC. It ends with a session, or after CONNECT_GRACE_MS: the start dial, the first redial round
//                 (30 s) with its dial timeout, and the first mDNS round (60 s) have run then.
//   'online'      the friend link has a session.
//   'unreachable' the tries keep failing and nothing tells that the friend left. The Friends list shows "Can't reach"
//                 with what to try. It ends after UNREACHABLE_MS (10 redial rounds) with no sign of the friend.
//   'offline'     the friend left with a bye line (a clean quit), or the 'unreachable' time ended.
// A helper answer (friend-refresh.mjs) proves that the friend runs: 'offline' goes back to 'unreachable' and its time
// starts again.
export const CONNECT_GRACE_MS = 60000;
export const UNREACHABLE_MS = 5 * 60000;

// onChange({ from, to, cause, ms }): each change of the status. cause: 'start' 'session' 'lost' 'bye' 'network'
// 'grace' 'timeout' 'answer'. ms: the time in the previous status.
export function createPresence({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {},
    graceMs = CONNECT_GRACE_MS, unreachableMs = UNREACHABLE_MS } = {}) {
    let status = null;
    let since = now();
    let timer = null;
    // True after a bye line: the friend quit. A grace time then ends in 'offline', not in 'unreachable'.
    let gone = false;
    let stopped = false;

    function arm(ms, fn) {
        clearTimer(timer);
        timer = setTimer(() => { timer = null; if (!stopped) fn(); }, ms);
        timer?.unref?.();
    }
    function move(to, cause) {
        if (stopped) return;
        const from = status;
        const time = now();
        const ms = Math.max(0, time - since);
        if (to !== from) since = time;
        status = to;
        if (to !== from) onChange({ from, to, cause, ms });
    }
    function connecting(cause) {
        move('connecting', cause);
        arm(graceMs, () => (gone ? move('offline', 'grace') : unreachable('grace')));
    }
    function unreachable(cause) {
        move('unreachable', cause);
        arm(unreachableMs, () => move('offline', 'timeout'));
    }

    return {
        status: () => status ?? 'connecting',
        since: () => since,
        gone: () => gone,
        // The friend node started (also again after a stop).
        started() { gone = false; connecting('start'); },
        sessionOpened() {
            gone = false;
            clearTimer(timer);
            timer = null;
            move('online', 'session');
        },
        // bye: the friend sent a bye line on this session (a clean quit).
        sessionClosed(bye) {
            if (bye) {
                gone = true;
                clearTimer(timer);
                timer = null;
                move('offline', 'bye');
                return;
            }
            connecting('lost');
        },
        // A network change of this PC (online, a new address, resume from sleep): new tries go out now.
        network() {
            if (status === 'online' || stopped) return;
            connecting('network');
        },
        // A helper answer: the friend runs now, but this device has no session yet.
        answered() {
            if (stopped) return;
            gone = false;
            if (status === 'offline' || status === 'unreachable') unreachable('answer');
        },
        stop() {
            stopped = true;
            clearTimer(timer);
            timer = null;
        }
    };
}
