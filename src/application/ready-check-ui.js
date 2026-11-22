// Ready check (milestone 9): the bar above the composer, the /ready command and the Ready check action of the Room
// menu. The node keeps the state (src/network/ready-check.mjs) and sends each new view (onReady). This file only shows
// the newest check. The bar is not in the transcript and not in the history.
// Rules: Idle Peer shows no bar (the vote stays "Not answered yet"). Do not disturb shows the bar with no sound. A new
// check of a different person plays the message cue of P11 only when roomAttention.wanted() is true.
// Reads the globals of renderer.js: ownName and peerNames.
(function () {
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const bar = byId('ready-bar');
    if (!bar || !api?.onReady) return;
    const question = byId('ready-question');
    const stateText = byId('ready-state');
    const yes = byId('ready-yes');
    const minute = byId('ready-minute');
    const closeButton = byId('ready-close');
    const lists = { ready: byId('ready-list-ready'), minute: byId('ready-list-minute'), none: byId('ready-list-none') };
    const TEXT_MAX = 120;
    const COMMAND = /^\/ready(?:\s+([\s\S]*))?$/i;
    let view = null;
    let idle = false;
    // The IDs of the checks that this window saw: a check gives one cue only (also after a new session).
    const seen = new Set();

    function setStatus(text) {
        const status = byId('status');
        if (status) status.textContent = text;
    }

    function errorText(err) {
        return String(err?.message ?? err ?? '').replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
    }

    function nameOf(peerId) {
        if (peerId === view?.self) return (typeof ownName === 'string' && ownName) || 'You';
        const name = typeof peerNames !== 'undefined' ? peerNames.get(peerId) : '';
        return name || String(peerId ?? '').slice(-8);
    }

    // The names of a list. Two people with the same name get the end of the peer ID: each person is one entry.
    function labels(people) {
        const names = people.map(nameOf);
        return people.map((peerId, i) => names.indexOf(names[i]) !== names.lastIndexOf(names[i])
            ? `${names[i]} (${String(peerId).slice(-4)})` : names[i]);
    }

    function newest() {
        const checks = view?.checks ?? [];
        return checks.length ? checks[checks.length - 1] : null;
    }

    function fillList(element, people) {
        const value = element.querySelector('.ready-names');
        value.textContent = people.length ? labels(people).join(', ') : '—';
        element.dataset.count = String(people.length);
    }

    function render() {
        const check = newest();
        bar.hidden = !check || idle || !!window.idlePeer?.isIdle();
        if (!check) {
            bar.dataset.id = '';
            return;
        }
        bar.dataset.id = check.id;
        bar.dataset.open = String(check.open);
        const from = check.mine ? 'You' : nameOf(check.from);
        question.textContent = check.open ? `${from} ${check.mine ? 'ask' : 'asks'}: ${check.text}` : `${from} asked: ${check.text}`;
        stateText.textContent = check.open ? '' : 'Closed';
        stateText.hidden = check.open;
        const own = check.votes[view.self];
        yes.hidden = !check.open;
        minute.hidden = !check.open;
        yes.setAttribute('aria-pressed', String(own === 'ready'));
        minute.setAttribute('aria-pressed', String(own === 'minute'));
        closeButton.hidden = !(check.open && check.mine);
        const people = view.people ?? [];
        fillList(lists.ready, people.filter(p => check.votes[p] === 'ready'));
        fillList(lists.minute, people.filter(p => check.votes[p] === 'minute'));
        fillList(lists.none, people.filter(p => !check.votes[p]));
    }

    function cueNew() {
        for (const check of view?.checks ?? []) {
            if (seen.has(check.id)) continue;
            seen.add(check.id);
            if (check.mine || !check.open || idle || window.idlePeer?.isIdle()) continue;
            const target = { kind: 'mention', channelId: 'general', id: check.id, from: check.from };
            if (window.roomAttention?.wanted(target)) void window.roomAttention.cue('mention', 'message', target);
        }
    }

    function apply(next) {
        if (!next || !Array.isArray(next.checks)) return;
        view = next;
        cueNew();
        render();
    }

    async function vote(value) {
        const check = newest();
        if (!check?.open) return;
        try { apply(await api.voteReady(check.id, value)); }
        catch (err) { setStatus(`Vote not sent: ${errorText(err)}`); }
    }

    // Open a check for the room. text: 0 to 120 characters (empty gives "Ready?"). Returns true when it opened.
    async function openCheck(text) {
        const value = String(text ?? '').trim();
        if ([...value].length > TEXT_MAX) {
            setStatus(`The text of a ready check has at most ${TEXT_MAX} characters.`);
            return false;
        }
        try {
            apply(await api.openReady(value));
            setStatus('');
            return true;
        } catch (err) {
            setStatus(`Ready check not opened: ${errorText(err)}`);
            return false;
        }
    }

    // renderer.js (sendMessage): false when the text is not a /ready command; else a promise of true when it opened.
    function command(text) {
        const match = COMMAND.exec(String(text ?? '').trim());
        return match ? openCheck(match[1] ?? '') : false;
    }

    // G5 leaveRoom(): forget the view of the room (the node of the room stops).
    function reset() {
        view = null;
        render();
    }

    yes.addEventListener('click', () => vote('ready'));
    minute.addEventListener('click', () => vote('minute'));
    closeButton.addEventListener('click', async () => {
        const check = newest();
        if (!check?.mine || !check.open) return;
        try { apply(await api.closeReady(check.id)); }
        catch (err) { setStatus(`Ready check not closed: ${errorText(err)}`); }
    });
    byId('ready-open')?.addEventListener('click', () => {
        byId('room-options')?.hidePopover?.();
        void openCheck('');
    });
    api.onReady(apply);
    // The peers change the "Not answered yet" list.
    api.onPeerName?.(() => render());
    api.onIdlePeer?.(state => {
        idle = state?.idle === true;
        if (!idle) Promise.resolve(api.getReady?.()).then(apply).catch(() => {});
        render();
    });
    window.readyCheckUi = { command, openCheck, reset, view: () => view };
})();
