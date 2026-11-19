// Quote of a chat line (milestone 2, D-Q1 to D-Q4). Pure functions with no DOM.
// window.quoteCore: renderer.js calls it. The tests load this file with node:vm.
// A quote is plain text in the text field: the quote line, one "\n", then the reply.
(function () {
    'use strict';

    const QUOTE_PREFIX = '> ';
    const EXCERPT_MAX = 120;
    const AUTHOR_MAX = 40;
    const ELLIPSIS = '…';

    // Collapse whitespace runs (also CR, LF, tab) to one space, trim, cut to max code points with an ellipsis.
    // Array.from splits by code point, so a cut never splits a surrogate pair.
    function clip(text, max) {
        const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
        const points = Array.from(flat);
        if (points.length <= max) return flat;
        const keep = Math.max(0, max - 1);
        return points.slice(0, keep).join('').trimEnd() + ELLIPSIS;
    }

    // The author label. Two or more current people with the name: add the last 4 characters of the peer ID.
    function authorLabel(name, peerId, sameNameCount) {
        if (sameNameCount >= 2 && typeof peerId === 'string' && peerId.length >= 4) {
            // The tag ' (abcd)' has 7 characters. The full label stays within AUTHOR_MAX, so formatQuote keeps the tag.
            return `${clip(name, AUTHOR_MAX - 7)} (${peerId.slice(-4)})`;
        }
        return clip(name, AUTHOR_MAX);
    }

    // { author, excerpt, reply } when line 1 starts with the prefix and has ': ', else null.
    function parseQuote(text) {
        if (typeof text !== 'string' || !text.startsWith(QUOTE_PREFIX)) return null;
        const nl = text.indexOf('\n');
        const first = nl < 0 ? text : text.slice(0, nl);
        const body = first.slice(QUOTE_PREFIX.length);
        const sep = body.indexOf(': ');
        if (sep < 0) return null;
        return {
            author: body.slice(0, sep),
            excerpt: body.slice(sep + 2),
            reply: nl < 0 ? '' : text.slice(nl + 1)
        };
    }

    // The excerpt of a line. A quoted quote gives its reply part only (D-Q3).
    function makeExcerpt(text) {
        const parsed = parseQuote(text);
        return clip(parsed ? parsed.reply : text, EXCERPT_MAX);
    }

    function formatQuote(label, originalText, reply) {
        return `${QUOTE_PREFIX}${clip(label, AUTHOR_MAX)}: ${makeExcerpt(originalText)}\n${reply}`;
    }

    // The text to send. quote: null or { label, text }.
    function composeText(quote, reply) {
        if (!quote) return reply;
        return formatQuote(quote.label, quote.text, reply);
    }

    window.quoteCore = {
        QUOTE_PREFIX,
        EXCERPT_MAX,
        AUTHOR_MAX,
        clip,
        authorLabel,
        parseQuote,
        makeExcerpt,
        formatQuote,
        composeText
    };
})();
