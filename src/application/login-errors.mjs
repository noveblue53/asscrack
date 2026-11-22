// Plain texts for the login and reopen errors (gaps A3 and N8 of the 1.0 roadmap). The network modules keep their
// own texts: the tests and the terminal demo use them. main.js gives the user the text of loginErrorText() and
// writes the original text to the log.

// True when the error, its cause or one of its errors has the code EADDRINUSE.
// OI1: libp2p gives UnsupportedListenAddressesError with no code, no cause and no errors for a port in use. Only its
// message has the text EADDRINUSE.
export function isAddressInUse(err, depth = 0) {
    if (!err || typeof err !== 'object' || depth > 4) return false;
    if (err.code === 'EADDRINUSE') return true;
    if (err.name === 'UnsupportedListenAddressesError' && /EADDRINUSE/.test(String(err.message))) return true;
    if (isAddressInUse(err.cause, depth + 1)) return true;
    return Array.isArray(err.errors) && err.errors.some(e => isAddressInUse(e, depth + 1));
}

// The port of an EADDRINUSE error, from the error or one of its causes. null when no error has a port.
function errorPort(err, depth = 0) {
    if (!err || typeof err !== 'object' || depth > 4) return null;
    if (Number.isInteger(err.port) && err.port > 0) return err.port;
    const fromCause = errorPort(err.cause, depth + 1);
    if (fromCause !== null) return fromCause;
    for (const inner of Array.isArray(err.errors) ? err.errors : []) {
        const port = errorPort(inner, depth + 1);
        if (port !== null) return port;
    }
    return null;
}

const NOT_INVITE = 'Not a valid invite code.';
const INCOMPLETE = 'Invite code is incomplete. Copy all of it.';
const VERSION = 'This invite is from another app version. Both of you need the latest update.';
const OTHER_DEVICE = 'This invite is for another device. Send the owner your device ID.';
const PUBLIC_ADDRESS = 'Use IP:port, for example 203.0.113.5:47000.';
const EXPIRED = 'Invite expired. Ask for a new one.';

// err: the error of the login or the reopen. port: the listen port of the start, if known.
export function loginErrorText(err, { port } = {}) {
    const text = String(err?.message ?? err ?? '');
    if (isAddressInUse(err)) {
        const n = Number.isInteger(port) && port > 0 ? port : errorPort(err);
        const which = n !== null ? `Port ${n} is` : 'The port is';
        return `${which} in use. Close the other app or choose another port.`;
    }
    if (/wrong prefix|not text/.test(text)) return NOT_INVITE;
    if (/damaged|not valid JSON|characters that are not valid|has a bad|no valid node list|too large/.test(text)) return INCOMPLETE;
    if (/unknown version/.test(text)) return VERSION;
    if (/for another device/.test(text)) return OTHER_DEVICE;
    if (/The public address must be/.test(text)) return PUBLIC_ADDRESS;
    if (/This device has been removed from the room/.test(text)) return KNOCK_TEXTS.removed;
    // L4 (P10a), UI copy 4.19: the expiry text of invite.mjs gets the short window text.
    if (/This invite has expired/.test(text)) return EXPIRED;
    return text;
}

// easy-join part 2: the text for the joiner when a knock with a room code ends with no Allow (knock-client.mjs).
// outcome: { result: 'denied' | 'timeout' | 'offline' | 'refused', reason? }.
export const KNOCK_TEXTS = Object.freeze({
    denied: 'The owner declined.',
    offline: 'Owner is offline. Try again later.',
    'old-code': 'This room code was replaced. Ask the owner for the new one.',
    expired: 'This room code expired. Ask the owner for a new one.',
    busy: 'The owner has too many join requests. Try again in a few minutes.',
    rate: 'Too many join requests. Try again in a few minutes.',
    pending: 'You already asked to join. Wait for the owner.',
    owner: 'Open your own room from your saved rooms.',
    removed: 'You were removed from this room.',
    role: 'This PC needs a device invite for this room.'
});
export function knockResultText(outcome) {
    if (outcome?.result === 'denied') return KNOCK_TEXTS.denied;
    if (outcome?.result === 'refused' && Object.hasOwn(KNOCK_TEXTS, outcome.reason) && outcome.reason !== 'denied' &&
        outcome.reason !== 'offline') return KNOCK_TEXTS[outcome.reason];
    if (outcome?.result === 'refused') return 'The owner couldn\'t answer. Try again later.';
    // 'timeout' (no answer in 2 minutes) and 'offline' (no peer proved the owner key).
    return KNOCK_TEXTS.offline;
}
