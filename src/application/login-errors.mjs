// Plain texts for the login and reopen errors (gaps A3 and N8 of the 1.0 roadmap). The network modules keep their
// own texts: the tests and the terminal demo use them. main.js gives the user the text of loginErrorText() and
// writes the original text to the log.

// True when the error, its cause or one of its errors has the code EADDRINUSE.
export function isAddressInUse(err, depth = 0) {
    if (!err || typeof err !== 'object' || depth > 4) return false;
    if (err.code === 'EADDRINUSE') return true;
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

const NOT_INVITE = 'This is not an ASSCRACK invite. Copy the whole code from the person who invited you.';
const INCOMPLETE = 'The invite code is not complete. Copy the whole code again from the person who invited you.';
const VERSION = 'This invite comes from a different ASSCRACK version. You and the room owner must use the same version.';
const OTHER_DEVICE = 'This invite is for a different device. Select “Copy my device ID”, send the ID to the room owner, '
    + 'and ask for a new invite.';
const PUBLIC_ADDRESS = 'Write the public address as IP:port, for example 203.0.113.5:47000.';

// err: the error of the login or the reopen. port: the listen port of the start, if known.
export function loginErrorText(err, { port } = {}) {
    const text = String(err?.message ?? err ?? '');
    if (isAddressInUse(err)) {
        const n = Number.isInteger(port) && port > 0 ? port : errorPort(err);
        const which = n !== null ? `Port ${n} is` : 'The port is';
        return `${which} in use on this computer. Close the other program or the other ASSCRACK, or use a different port.`;
    }
    if (/wrong prefix|not text/.test(text)) return NOT_INVITE;
    if (/damaged|not valid JSON|characters that are not valid|has a bad|no valid node list|too large/.test(text)) return INCOMPLETE;
    if (/unknown version/.test(text)) return VERSION;
    if (/for another device/.test(text)) return OTHER_DEVICE;
    if (/The public address must be/.test(text)) return PUBLIC_ADDRESS;
    return text;
}
