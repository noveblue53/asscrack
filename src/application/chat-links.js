// Links in chat lines and whisper lines (gap D2).
// window.chatLinksCore: a pure part with no DOM. linkRanges(text) gives { start, end, href } for each http:// or
// https:// URL in the text. The tests load this file with node:vm.
// window.chatLinks: the DOM part. apply(span) puts each part of a URL in <a class="chat-link">. One click listener on
// #messages and one on #whisper-lines send the URL to the main process (window.asscrack.openLink). The main process
// checks the URL again (link-policy.mjs). If this listener fails, the navigation lock (desktop-boundary.mjs) still
// stops the click.
// All names stay inside this function: the room window scripts are classic scripts in one global scope.
(function () {
    'use strict';

    // A longer URL gives no link: the main process refuses it (link-policy.mjs), thus a link would not open.
    const MAX_LINK = 2048;
    const TRAILING = '.,;:!?';
    const BRACKETS = { ')': '(', ']': '[', '}': '{' };
    // The scheme must not follow a letter or a digit ("xhttp://" is not a link). The URL ends at a space or at a
    // character that the chat text cannot have in a URL.
    const URL_PATTERN = /(?<![\p{L}\p{N}])https?:\/\/[^\s<>"]+/giu;

    // Cut the punctuation at the end. A closing bracket at the end goes when the URL has no opening bracket of that
    // kind. Repeat until nothing changes ("…/x)." loses the full stop and the bracket).
    function trimEnd(url) {
        let value = url;
        for (;;) {
            const last = value.at(-1);
            if (last !== undefined && TRAILING.includes(last)) value = value.slice(0, -1);
            else if (last in BRACKETS && !value.includes(BRACKETS[last])) value = value.slice(0, -1);
            else return value;
        }
    }

    function hasHost(href) {
        try {
            const url = new URL(href);
            return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
        } catch {
            return false;
        }
    }

    function linkRanges(text) {
        const value = String(text ?? '');
        const out = [];
        for (const match of value.matchAll(URL_PATTERN)) {
            const href = trimEnd(match[0]);
            if (href.length > MAX_LINK || !hasHost(href)) continue;
            out.push({ start: match.index, end: match.index + href.length, href });
        }
        return out;
    }

    window.chatLinksCore = Object.freeze({ MAX_LINK, linkRanges });

    if (typeof document === 'undefined') return;

    // ---- DOM part ----

    function isLink(node) {
        return node?.nodeType === 1 && node.tagName === 'A' && node.classList.contains('chat-link');
    }

    function makeLink(doc, href, text, focusable) {
        const link = doc.createElement('a');
        link.className = 'chat-link';
        // A chat line link is not a tab stop (polish report N01: no tab stops in the rows). The keyboard uses the
        // row action "Open link". A whisper line link stays a tab stop: the whisper pane has no row menu.
        if (!focusable) link.tabIndex = -1;
        link.setAttribute('href', href);
        // The parsed form: a look-alike host shows as xn--….
        let title = href;
        try { title = new URL(href).href; } catch {}
        link.setAttribute('title', title);
        link.setAttribute('rel', 'noreferrer');
        link.append(text);
        return link;
    }

    // Put the parts of one text node that are in a range into links. start: the offset of the node in the span.
    function wrap(node, start, ranges, focusable) {
        const data = node.data;
        const end = start + data.length;
        const doc = node.ownerDocument;
        const parts = [];
        let at = start;
        for (const range of ranges) {
            if (range.end <= at || range.start >= end) continue;
            const from = Math.max(range.start, at);
            const to = Math.min(range.end, end);
            if (from > at) parts.push(doc.createTextNode(data.slice(at - start, from - start)));
            parts.push(makeLink(doc, range.href, data.slice(from - start, to - start), focusable));
            at = to;
        }
        if (parts.length === 0) return;
        if (at < end) parts.push(doc.createTextNode(data.slice(at - start)));
        const parent = node.parentNode;
        for (const part of parts) parent.insertBefore(part, node);
        parent.removeChild(node);
    }

    // Make the links of a span. The textContent of the span does not change. A second call changes nothing: a text
    // node in a link stays as it is. options.focusable: the links are tab stops (default: no).
    function apply(span, options = {}) {
        if (!span || typeof span.textContent !== 'string') return;
        const ranges = linkRanges(span.textContent);
        if (ranges.length === 0) return;
        let offset = 0;
        const texts = [];
        (function visit(node, inLink) {
            for (const child of Array.from(node.childNodes)) {
                if (child.nodeType === 3) {
                    if (!inLink) texts.push({ node: child, start: offset });
                    offset += child.data.length;
                } else if (child.nodeType === 1) visit(child, inLink || isLink(child));
            }
        })(span, false);
        for (const { node, start } of texts) wrap(node, start, ranges, options.focusable === true);
    }

    function open(href) {
        if (typeof href !== 'string' || !href) return false;
        Promise.resolve(window.asscrack?.openLink?.(href)).catch(err => console.warn('Open link failed:', err?.message ?? err));
        return true;
    }

    function onClick(event) {
        const link = event.target?.closest?.('a.chat-link');
        if (!link) return;
        event.preventDefault();
        open(link.getAttribute('href'));
    }

    // The row action "Open link": the first link of the row.
    function firstLink(row) {
        return row?.querySelector?.('a.chat-link')?.getAttribute('href') ?? null;
    }

    for (const id of ['messages', 'whisper-lines']) document.getElementById(id)?.addEventListener('click', onClick);

    window.chatLinks = Object.freeze({ apply, firstLink, openFirst: row => open(firstLink(row)) });
})();
