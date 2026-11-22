// Ready check (milestone 9): the bar above the composer, the /ready command and the Ready check action of the Room
// menu. The node keeps the state (src/network/ready-check.mjs) and sends each new view (onReady). The bar has one block
// for each live check (each person has at most one): the open checks first. The bar is not in the transcript and not
// in the history.
// Rules: Idle Peer shows no bar (the vote stays "Not answered yet"). Do not disturb shows the bar with no sound. A new
// check of a different person plays the message cue of P11 only when roomAttention.wanted() is true.
// Reads the globals of renderer.js: ownName and peerNames.
(function () {
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const bar = byId('ready-bar');
    if (!bar || !api?.onReady) return;
    const TEXT_MAX = 120;
    const COMMAND = /^\/ready(?:\s+([\s\S]*))?$/i;
    const LISTS = [['ready', 'Ready:'], ['minute', 'Give me a minute:'], ['none', 'Not answered yet:']];
    let view = null;
    let idle = false;
    // check ID -> the block of the check in the bar.
    const blocks = new Map();
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
        const all = (view?.people ?? []).map(nameOf);
        return people.map(peerId => {
            const name = nameOf(peerId);
            return all.indexOf(name) !== all.lastIndexOf(name) ? `${name} (${String(peerId).slice(-4)})` : name;
        });
    }

    function element(tag, className, text) {
        const el = document.createElement(tag);
        el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    function button(className, text) {
        const el = element('button', className, text);
        el.type = 'button';
        return el;
    }

    function makeBlock(id) {
        const block = element('div', 'ready-check');
        block.dataset.id = id;
        block.setAttribute('role', 'group');
        const buttons = element('div', 'ready-buttons');
        buttons.append(button('ready-yes', 'Ready'), button('ready-minute', 'Give me a minute'), button('ready-close', 'Close'));
        block.append(element('p', 'ready-question'), element('span', 'ready-state', 'Closed'), buttons);
        for (const [key, label] of LISTS) {
            const row = element('p', 'ready-list');
            row.dataset.list = key;
            row.append(element('span', 'ready-label', label), document.createTextNode(' '), element('span', 'ready-names'));
            block.append(row);
        }
        return block;
    }

    function fillBlock(block, check) {
        const part = name => block.querySelector('.' + name);
        block.dataset.open = String(check.open);
        const from = check.mine ? 'You' : nameOf(check.from);
        const question = check.open ? `${from} ${check.mine ? 'ask' : 'asks'}: ${check.text}` : `${from} asked: ${check.text}`;
        part('ready-question').textContent = question;
        block.setAttribute('aria-label', question);
        part('ready-state').hidden = check.open;
        const own = check.votes[view.self];
        part('ready-yes').hidden = !check.open;
        part('ready-minute').hidden = !check.open;
        part('ready-yes').setAttribute('aria-pressed', String(own === 'ready'));
        part('ready-minute').setAttribute('aria-pressed', String(own === 'minute'));
        part('ready-close').hidden = !(check.open && check.mine);
        const people = view.people ?? [];
        const groups = {
            ready: people.filter(p => check.votes[p] === 'ready'),
            minute: people.filter(p => check.votes[p] === 'minute'),
            none: people.filter(p => !check.votes[p])
        };
        for (const row of block.querySelectorAll('.ready-list')) {
            const list = groups[row.dataset.list] ?? [];
            row.querySelector('.ready-names').textContent = list.length ? labels(list).join(', ') : '—';
            row.dataset.count = String(list.length);
        }
    }

    // The open checks first, then the closed checks; the older check first in each group.
    function ordered() {
        const checks = [...(view?.checks ?? [])];
        return checks.sort((a, b) => (a.open === b.open ? a.openedAt - b.openedAt : a.open ? -1 : 1));
    }

    function render() {
        const checks = ordered();
        const live = new Set(checks.map(c => c.id));
        for (const [id, block] of blocks) {
            if (!live.has(id)) {
                block.remove();
                blocks.delete(id);
            }
        }
        checks.forEach((check, index) => {
            let block = blocks.get(check.id);
            if (!block) {
                block = makeBlock(check.id);
                blocks.set(check.id, block);
            }
            fillBlock(block, check);
            // Move a block only when its place is wrong: a move removes the focus from its buttons.
            const here = bar.children[index] ?? null;
            if (here !== block) bar.insertBefore(block, here);
        });
        bar.hidden = !checks.length || idle || !!window.idlePeer?.isIdle();
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

    function find(id) {
        return view?.checks.find(c => c.id === id) ?? null;
    }

    // Open a check for the room. text: 0 to 120 characters on one line (empty gives "Ready?"). Returns true when it
    // opened.
    async function openCheck(text) {
        const value = String(text ?? '').trim();
        if (/[\r\n]/.test(value)) {
            setStatus('The text of a ready check is one line.');
            return false;
        }
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

    // One listener for the buttons of all the blocks.
    bar.addEventListener('click', async event => {
        const target = event.target;
        const block = target?.closest?.('.ready-check');
        const check = block ? find(block.dataset.id) : null;
        if (!check?.open) return;
        try {
            if (target.classList.contains('ready-yes')) apply(await api.voteReady(check.id, 'ready'));
            else if (target.classList.contains('ready-minute')) apply(await api.voteReady(check.id, 'minute'));
            else if (target.classList.contains('ready-close') && check.mine) apply(await api.closeReady(check.id));
        } catch (err) {
            setStatus(`Ready check: ${errorText(err)}`);
        }
    });
    byId('ready-open')?.addEventListener('click', () => {
        byId('room-options')?.hidePopover?.();
        void openCheck('');
    });
    api.onReady(apply);
    // A new name changes the lists.
    api.onPeerName?.(() => render());
    api.onIdlePeer?.(state => {
        idle = state?.idle === true;
        if (!idle) Promise.resolve(api.getReady?.()).then(apply).catch(() => {});
        render();
    });
    window.readyCheckUi = { command, openCheck, reset, view: () => view };
})();
