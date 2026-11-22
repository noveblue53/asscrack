// A clock for the window tests: Date, setTimeout and setInterval that run only when the test calls advance(ms).
// renderer-fixture.mjs gives them to the scripts (options.clock). The promise callbacks are not on this clock.
export function createClock(start = new Date(2026, 10, 21, 21, 0, 0).getTime()) {
    let now = start;
    let seq = 0;
    const timers = new Map(); // id -> { at, fn, every }
    class FakeDate extends Date {
        constructor(...args) {
            if (args.length) super(...args);
            else super(now);
        }

        static now() {
            return now;
        }
    }
    function add(fn, ms, every) {
        const id = ++seq;
        timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, every });
        return id;
    }
    return {
        Date: FakeDate,
        setTimeout: (fn, ms) => add(fn, ms, 0),
        clearTimeout: id => { timers.delete(id); },
        setInterval: (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 1)),
        clearInterval: id => { timers.delete(id); },
        now: () => now,
        // Move the time forward. Each timer runs at its time, in time sequence.
        advance(ms) {
            const end = now + ms;
            for (;;) {
                let next = null;
                for (const [id, timer] of timers) if (timer.at <= end && (!next || timer.at < next[1].at)) next = [id, timer];
                if (!next) break;
                const [id, timer] = next;
                now = timer.at;
                if (timer.every) timer.at += timer.every;
                else timers.delete(id);
                timer.fn();
            }
            now = end;
        }
    };
}
