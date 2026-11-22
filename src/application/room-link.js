// The room-link state (gaps A2, A4, B2): the text of #waiting-peer and the link key of the status bar.
// window.roomLinkCore: a pure part with no DOM and no clock. The tests load this file with node:vm and give the time.
// window.roomLink: the DOM part. renderer.js and room-membership-ui.js give it the room facts.
// All names stay inside this function: the room window scripts are classic scripts in one global scope.
(function () {
    'use strict';

    // A first connection that takes this time or more gets the long text and the Details button.
    const SLOW_MS = 20 * 1000;
    // The status bar says "Reconnected" for this time after a loss ends.
    const RECONNECTED_MS = 5 * 1000;

    const TEXTS = Object.freeze({
        revoked: 'This device’s access was revoked.',
        creator: 'Waiting for a peer. Select Invite to add a friend’s device.',
        ownerReopen: 'Waiting for a peer.',
        ownerWait: 'Connecting to the room owner…',
        ownerSlow: 'Cannot reach the room owner yet. The owner must be online for your first join. ASSCRACK tries again each few seconds.',
        roomWait: 'Connecting to the room…',
        roomSlow: 'Cannot reach the room yet. A different member must be online. ASSCRACK tries again each few seconds.',
        everyoneLeft: 'Everyone left the room. Waiting for a peer.'
    });

    // The local time HH:MM of a time in ms.
    function clock(ms) {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    // input: { role: 'creator' | 'joiner' | 'reopen', owner, admitted, revoked, peers, seen, startedAt, lostAt, allBye,
    // restoredAt, now }. seen: a peer was connected one time or more. lostAt: the time when the peer count went to 0.
    // allBye: each peer that went at that time said bye. restoredAt: the time when the last loss ended, or null.
    // Returns { text, details, link, recheckAt }: text '' hides #waiting-peer. details: show the Details button.
    // link: '' (the status bar says "Ready"), 'connecting', 'reconnecting' or 'reconnected'. recheckAt: the time when
    // the result changes with no new input, or null.
    function view(input) {
        const now = Number(input?.now) || 0;
        const result = (text, details, link, recheckAt = null) => ({ text, details, link, recheckAt });
        if (input?.revoked === true) return result(TEXTS.revoked, false, '');
        if (Number(input?.peers) > 0) {
            const restoredAt = Number(input.restoredAt);
            if (input.restoredAt !== null && input.restoredAt !== undefined && now - restoredAt < RECONNECTED_MS) {
                return result('', false, 'reconnected', restoredAt + RECONNECTED_MS);
            }
            return result('', false, '');
        }
        if (input?.seen === true) {
            if (input.allBye === true) return result(TEXTS.everyoneLeft, false, '');
            return result(`Connection lost at ${clock(Number(input.lostAt) || now)}. Reconnecting…`, true, 'reconnecting');
        }
        if (input?.role === 'creator') return result(TEXTS.creator, false, '');
        if (input?.role === 'reopen' && input.owner === true) return result(TEXTS.ownerReopen, false, '');
        const startedAt = Number(input?.startedAt) || now;
        const slow = now - startedAt >= SLOW_MS;
        const recheck = slow ? null : startedAt + SLOW_MS;
        if (input?.admitted === false) {
            return slow ? result(TEXTS.ownerSlow, true, 'connecting') : result(TEXTS.ownerWait, false, 'connecting', recheck);
        }
        return slow ? result(TEXTS.roomSlow, true, 'connecting') : result(TEXTS.roomWait, false, 'connecting', recheck);
    }

    window.roomLinkCore = Object.freeze({ SLOW_MS, RECONNECTED_MS, TEXTS, clock, view });

    if (typeof document === 'undefined') return;

    // ---- DOM part ----

    const box = document.getElementById('waiting-peer');
    const bar = document.getElementById('statusbar');
    let facts = null;
    let timer = null;
    let shown = null;
    let details = null;

    function detailsButton() {
        if (details) return details;
        details = document.createElement('button');
        details.type = 'button';
        details.className = 'link-details';
        details.textContent = 'Details';
        details.addEventListener('click', () => window.roomActivity?.openPeer(null, '', details));
        return details;
    }

    function render() {
        if (!facts) return;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        const now = Date.now();
        const result = view({ ...facts, now });
        if (box) {
            const key = `${result.text}\n${result.details}`;
            if (key !== shown) {
                shown = key;
                // The Details button keeps its node: a render while it has the focus keeps the focus.
                box.textContent = result.text;
                if (result.details) box.append(' ', detailsButton());
            }
            box.hidden = result.text === '';
        }
        if (bar) {
            if (result.link) bar.dataset.link = result.link;
            else delete bar.dataset.link;
        }
        if (result.recheckAt !== null) timer = setTimeout(render, Math.max(0, result.recheckAt - now));
    }

    window.roomLink = Object.freeze({
        // At the start of the room. room: { role, owner, admitted, revoked }.
        start(room) {
            facts = { peers: 0, seen: false, lostAt: null, allBye: true, restoredAt: null, ...facts,
                role: room?.role ?? 'creator', owner: room?.owner === true, admitted: room?.admitted !== false,
                revoked: room?.revoked === true, startedAt: Date.now() };
            render();
        },
        // A membership change of a protected room: { owner, admitted, revoked }.
        membership(state) {
            if (!state) return;
            facts = { ...(facts ?? {}), owner: state.owner === true, admitted: state.admitted !== false, revoked: state.revoked === true };
            if (facts.role) render();
        },
        // The peer facts of the roster (rosterNotesCore link()): { peers, seen, lostAt, allBye, restoredAt }.
        presence(link) {
            if (!link) return;
            facts = { ...(facts ?? {}), peers: link.peers, seen: link.seen, lostAt: link.lostAt, allBye: link.allBye, restoredAt: link.restoredAt };
            if (facts.role) render();
        },
        state: () => (facts ? view({ ...facts, now: Date.now() }) : null)
    });
})();
