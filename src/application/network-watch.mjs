// 1.0.6: a network change of this PC for the friend links (main.js). The main process of Electron has no 'online'
// event. Thus this module reads the addresses of the network interfaces each intervalMs (main.js gives the 2 s cache of
// interface-cache.mjs) and compares the set of the addresses that are not internal and not link-local.
// onChange(cause): 'online' (the first address after none) or 'changed' (another set of addresses). A set with no
// address (offline) gives no call: a try then cannot work. A change waits settleMs (Windows adds an address in steps),
// and two calls have at least gapMs between them.
import os from 'node:os';

export const NETWORK_POLL_MS = 5000;
export const NETWORK_SETTLE_MS = 3000;
export const NETWORK_GAP_MS = 15000;

// The sorted external addresses of os.networkInterfaces() as one text ('' for none).
export function addressSignature(interfaces) {
    const out = [];
    for (const list of Object.values(interfaces ?? {})) {
        for (const item of Array.isArray(list) ? list : []) {
            if (!item || item.internal || typeof item.address !== 'string') continue;
            const low = item.address.toLowerCase();
            if (low.startsWith('169.254.') || /^fe[89ab]/.test(low)) continue;
            out.push(low);
        }
    }
    return [...new Set(out)].sort().join(',');
}

export function createNetworkWatch({ read = () => os.networkInterfaces(), onChange = () => {}, intervalMs = NETWORK_POLL_MS,
    settleMs = NETWORK_SETTLE_MS, gapMs = NETWORK_GAP_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    setRepeat = setInterval, clearRepeat = clearInterval } = {}) {
    const safeRead = () => { try { return addressSignature(read()); } catch { return null; } };
    let last = safeRead();
    let base = last;
    let settle = null;
    let lastCall = -Infinity;
    let repeat = null;
    const fire = cause => { lastCall = now(); onChange(cause); };

    function check() {
        const current = safeRead();
        if (current === null || current === last) return;
        last = current;
        clearTimer(settle);
        settle = setTimer(() => {
            settle = null;
            const value = last;
            if (value === base) return;
            const cause = base === '' ? 'online' : 'changed';
            base = value;
            if (value === '') return;
            const wait = gapMs - (now() - lastCall);
            if (wait <= 0) { fire(cause); return; }
            // Too soon after the last call: one call when the gap ends.
            settle = setTimer(() => { settle = null; fire(cause); }, wait);
            settle?.unref?.();
        }, settleMs);
        settle?.unref?.();
    }

    return {
        start() {
            if (repeat) return;
            repeat = setRepeat(check, intervalMs);
            repeat?.unref?.();
        },
        check,
        stop() {
            clearRepeat(repeat);
            repeat = null;
            clearTimer(settle);
            settle = null;
        }
    };
}
