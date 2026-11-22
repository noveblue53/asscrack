// The check of a link that the room window wants to open (gap D2, IPC asscrack:open-link of main.js).
// Pure: no Electron. The caller gives the clock. check(value) returns { ok: true, href } for a URL to open, or
// { ok: false, reason } for all other input. The main process then opens only href, in the system browser.

export const MAX_LINK_LENGTH = 2048;
export const LINK_INTERVAL_MS = 500;

// The parsed URL, or a reason when the value is not a link that the app opens.
export function parseLink(value) {
    if (typeof value !== 'string') return { ok: false, reason: 'not a string' };
    if (value.length > MAX_LINK_LENGTH) return { ok: false, reason: `longer than ${MAX_LINK_LENGTH} characters` };
    let url;
    try {
        url = new URL(value);
    } catch {
        return { ok: false, reason: 'not a URL' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `protocol ${url.protocol}` };
    if (!url.hostname) return { ok: false, reason: 'no host' };
    if (url.username || url.password) return { ok: false, reason: 'user name or password in the URL' };
    return { ok: true, href: url.href };
}

// At most one accepted link each intervalMs. A refused value does not start the interval.
export function createLinkPolicy({ now = () => Date.now(), intervalMs = LINK_INTERVAL_MS } = {}) {
    let last = -Infinity;
    return {
        check(value) {
            const parsed = parseLink(value);
            if (!parsed.ok) return parsed;
            const t = now();
            if (t - last < intervalMs) return { ok: false, reason: `more than one link in ${intervalMs} ms` };
            last = t;
            return parsed;
        }
    };
}
