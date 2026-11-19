// Quote: reply to one chat line. Classic script. It loads before renderer.js.
// window.quoteCore: pure functions with no DOM. test/quote.test.mjs loads this file with node:vm and calls them.
//
// A quote is plain text in an ordinary chat message. The network format and the history format do not change.
// A 0.6.0 client shows the same text: its chat line has white-space: pre-wrap, thus the lines stay lines.
//
// The text of a message with a quote:
//   > Sam (a1b2c3) at 14:05:      the header: the name, a peer tag when two users have that name, the clock time
//   > first line of the excerpt   at most LIMITS.lines lines and LIMITS.chars characters, "…" when cut
//   > second line of the excerpt
//   the reply                     the text that the user typed (one or more lines)
//
// The quotation is a snapshot: the excerpt goes in the message. The original line can leave the history
// (the history keeps 200 lines) and the quote stays readable.
(function () {
    'use strict';

    const LIMITS = Object.freeze({ lines: 4, chars: 280, name: 48, tag: 6 });
    const MARK = '> ';
    const ELLIPSIS = '…';
    // A header line: "> name at HH:MM:" or "> name (tag) at HH:MM:".
    const HEADER = /^> (.+?)(?: \(([0-9A-Za-z]{1,16})\))? at (\d{1,2}:\d{2}):$/;

    // CR LF and CR become LF. A paste from the Windows clipboard has CR LF.
    function normalize(text) {
        return String(text ?? '').replace(/\r\n?/g, '\n');
    }

    // Remove the control characters (not LF and not TAB).
    function dropControls(text) {
        return String(text).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, '');
    }

    // The first max code points of text. An emoji is not cut into two halves.
    function cutCodePoints(text, max) {
        const points = Array.from(String(text));
        if (points.length <= max) return { text: String(text), cut: false };
        return { text: points.slice(0, max).join(''), cut: true };
    }

    // A name for the header: one line, no control characters, at most LIMITS.name characters.
    function cleanName(name) {
        const one = dropControls(normalize(name).replace(/\s+/g, ' ')).trim();
        if (!one) return '?';
        const { text, cut } = cutCodePoints(one, LIMITS.name);
        return cut ? `${text}${ELLIPSIS}` : text;
    }

    // The peer tag: the last LIMITS.tag characters of the peer ID. Empty when there is no peer ID.
    function peerTag(peerId) {
        const id = typeof peerId === 'string' ? peerId.replace(/[^0-9A-Za-z]/g, '') : '';
        return id.length >= LIMITS.tag ? id.slice(-LIMITS.tag) : '';
    }

    // True when more than one user in names has the name. names: the names of the buddy list (with the own name).
    function nameRepeats(name, names) {
        const wanted = String(name ?? '');
        let count = 0;
        for (const n of Array.isArray(names) ? names : []) if (String(n) === wanted) count++;
        return count > 1;
    }

    // Split a text into its leading quotation and the rest. Returns { quote, rest } or null when the text has no
    // quotation at the start. quote: the lines with the marks and the line ends, rest: the text after them.
    // quote + rest is the full text.
    function split(text) {
        const value = String(text ?? '');
        const firstEnd = value.indexOf('\n');
        if (firstEnd < 0 || !HEADER.test(value.slice(0, firstEnd))) return null;
        let at = firstEnd + 1;
        for (let i = 0; i < LIMITS.lines; i++) {
            if (!value.startsWith(MARK, at)) break;
            const end = value.indexOf('\n', at);
            if (end < 0) {
                at = value.length;
                break;
            }
            at = end + 1;
        }
        return { quote: value.slice(0, at), rest: value.slice(at) };
    }

    // The header data of a quotation line, or null. { from, tag, clock }.
    function parseHeader(line) {
        const match = HEADER.exec(String(line ?? ''));
        return match ? { from: match[1], tag: match[2] ?? '', clock: match[3] } : null;
    }

    // The excerpt of a message: an array of at most LIMITS.lines lines, at most LIMITS.chars characters in all.
    // A quotation at the start of the message does not go in the excerpt (no quote in a quote).
    // Empty lines and the spaces at the line ends go away. "…" shows that the excerpt is cut.
    function excerptOf(text) {
        const full = dropControls(normalize(text));
        const parts = split(full);
        let body = parts ? parts.rest : full;
        if (!body.trim() && parts) body = parts.quote.split('\n').slice(1).map(l => l.slice(MARK.length)).join('\n');
        const all = body.split('\n').map(l => l.replace(/\s+$/u, '')).filter(l => l.trim() !== '');
        let cut = all.length > LIMITS.lines;
        const lines = [];
        let left = LIMITS.chars;
        for (const line of all.slice(0, LIMITS.lines)) {
            if (left <= 0) {
                cut = true;
                break;
            }
            const part = cutCodePoints(line, left);
            lines.push(part.text);
            left -= Array.from(part.text).length;
            if (part.cut) {
                cut = true;
                break;
            }
        }
        if (lines.length === 0) return [];
        if (cut) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\s+$/u, '')}${ELLIPSIS}`;
        return lines;
    }

    // A quote of one chat line. from: the name on the line. peerId: the peer ID of the line, or null.
    // repeats: true when two users have the name (then the header gets the peer tag). clock: "HH:MM" of the line.
    function makeQuote({ from, peerId = null, repeats = false, clock = '', text = '' } = {}) {
        const time = /^\d{1,2}:\d{2}$/.test(String(clock)) ? String(clock) : '00:00';
        return Object.freeze({
            from: cleanName(from),
            tag: repeats ? peerTag(peerId) : '',
            clock: time,
            lines: Object.freeze(excerptOf(text))
        });
    }

    // The header text with no mark: "Sam (a1b2c3) at 14:05".
    function headerText(quote) {
        return `${quote.from}${quote.tag ? ` (${quote.tag})` : ''} at ${quote.clock}`;
    }

    // The quotation lines of a quote (with the marks), with no reply.
    function quotation(quote) {
        const lines = quote.lines.length > 0 ? quote.lines : [ELLIPSIS];
        return [`${MARK}${headerText(quote)}:`, ...lines.map(l => `${MARK}${l}`)].join('\n');
    }

    // The reply text: CR LF becomes LF, no empty lines at the start and at the end.
    function cleanReply(reply) {
        return normalize(reply).replace(/^\s*\n/, '').replace(/\s+$/u, '');
    }

    // The message text: the quotation, then the reply. With no quote: the reply as the user typed it.
    function compose(quote, reply) {
        if (!quote) return String(reply ?? '');
        return `${quotation(quote)}\n${cleanReply(reply)}`;
    }

    // The most characters that a quotation can have (the header and the excerpt, with the marks and the line ends).
    const MAX_QUOTATION = MARK.length * (LIMITS.lines + 1) + (LIMITS.name + 1) + ' (xxxxxx) at 00:00:'.length
        + LIMITS.chars + 1 + LIMITS.lines;

    window.quoteCore = Object.freeze({
        LIMITS,
        MAX_QUOTATION,
        normalize,
        cleanName,
        peerTag,
        nameRepeats,
        split,
        parseHeader,
        excerptOf,
        makeQuote,
        headerText,
        quotation,
        cleanReply,
        compose
    });
})();
