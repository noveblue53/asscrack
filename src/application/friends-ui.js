// G7a: the Friends panel (#friends-panel, design F6). Classic script; all names stay inside this function.
// window.friendsCore: pure texts with no DOM (the tests load this file with node:vm).
// window.friendsUi: { relation(peerId), rowInfo(row), run(action, row), add(peerId), openFor(peerId), refresh() } for
//   renderer.js and menu.js (the buddy menu lines and the row menu of the panel).
// The bridge is window.friends (preload.cjs). The window gets no key and no address of a friend.
// On the login screen the panel is a column at the side of the login card. In a room the titlebar button "Friends"
// opens it as a drawer. Escape with the focus in the drawer closes it (this listener is on the panel only).
// 1.0.1: "Pop out" in the drawer opens the Friends window (friends-window.html, friends-popout.mjs). That window runs
// this file too: its panel has data-mode="window", and it has no drawer, no Friends button and no Retry call.
(function () {
    'use strict';

    const pad = n => String(n).padStart(2, '0');
    function timeText(time, now = Date.now()) {
        const d = new Date(time);
        const today = new Date(now);
        const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        if (d.toDateString() === today.toDateString()) return hm;
        return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${hm}`;
    }
    // G7b: the availability of a friend on the friend link, and a friend in the same room with no friend link.
    const AVAILABILITY = { away: 'Away', dnd: 'Do not disturb', idle: 'Idle Peer' };
    function stateText(friend, now = Date.now()) {
        if (friend.state === 'online') {
            const label = AVAILABILITY[friend.availability];
            // easy-join part 3: the friend is in a protected room that this device is not in.
            const where = friend.join?.room ? ` · in ${friend.join.room}` : '';
            return (label ? `Online · ${label}${friend.note ? ` · ${friend.note}` : ''}` : 'Online') + where;
        }
        if (friend.state === 'room') return `Online · in ${friend.roomName}`;
        if (friend.state === 'removed-you') return 'Removed you as a friend';
        return Number.isFinite(friend.lastSeen) ? `Offline · last seen ${timeText(friend.lastSeen, now)}` : 'Offline';
    }
    // U13 of the UI copy pass: the reach line is a dot and a short label. The tooltip has the reason.
    function reachText(reach) {
        if (reach === 'reachable') return 'Reachable';
        if (reach === 'asking') return 'Opening port…';
        return 'LAN only';
    }
    function reachTip(reach) {
        if (reach === 'reachable') return 'Friends can connect to this PC';
        if (reach === 'asking') return 'Asking your router to open a port';
        return 'Friends elsewhere need an open port on one side';
    }
    const reachKind = reach => (reach === 'reachable' ? 'ok' : reach === 'asking' ? 'busy' : 'warn');
    // U15: a request that waits is a row with the name and a "Pending" tag. This text is the tooltip of the tag.
    const waitingText = name => `Waiting for ${name || 'your friend'} to accept`;
    // easy-join: the result of "Invite to room" (friend-links.mjs invite()).
    function inviteText(result, name) {
        switch (result) {
            case 'sending': return `Invite sent to ${name}.`;
            case 'waiting': return `Invite queued. ${name} gets it when you are both online.`;
            case 'not-owner': return 'Only the room owner can invite.';
            case 'no-room': return 'Open your room first.';
            case 'no-address': return 'This room cannot be reached from the internet. See Invite for details.';
            case 'full': return `Too many unsent messages for ${name}. Try again when ${name} is online.`;
            case 'removed': return `${name} removed you as a friend.`;
            default: return 'Couldn\'t send the invite.';
        }
    }
    // easy-join part 3: Join of a friend row. The status while the knock waits, and the result (main.js
    // 'asscrack:friend-knock'; answer.text is the knock result text of login-errors.mjs).
    const knockStateText = (state, room) => (state === 'waiting'
        ? `Waiting for the owner of ${room}…` : `Looking for the owner of ${room}…`);
    const askText = name => `Ask ${name} for an invite`;
    function joinText(answer, name) {
        switch (answer?.result) {
            case 'joining': return `Allowed. Joining ${answer.room}…`;
            case 'knock': return answer.text || 'Owner is offline. Try again later.';
            case 'ask': return `${askText(name)}.`;
            case 'gone': return `${name} is not in a room you can join.`;
            case 'saved': return 'This room is in your saved rooms. Open it there.';
            case 'busy': return 'Try again in a moment.';
            default: return 'Couldn\'t join the room. Try again.';
        }
    }
    window.friendsCore = Object.freeze({ stateText, reachText, reachTip, reachKind, waitingText, timeText, inviteText, knockStateText, askText, joinText });

    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const api = window.friends;
    const panel = document.getElementById('friends-panel');
    if (!api || !panel) return;
    const byId = id => document.getElementById(id);
    const list = byId('friend-list');
    const waitingList = byId('friend-waiting');
    const toggle = byId('friends-toggle');
    const unreadBadge = byId('friends-unread');
    const loginScreen = byId('login-screen');
    const confirmDialog = byId('friend-confirm');
    const windowMode = panel.dataset?.mode === 'window';
    const popOutButton = byId('friends-popout');
    const nameDialog = byId('friend-name-dialog');
    let view = { state: 'stopped', friends: [], waiting: [], blocked: [] };
    let relations = {};
    let drawerOpen = false;
    let confirmAction = null;
    let confirmKeep = false;
    let nameAction = null;
    // easy-join part 3: a friend Join waits for the owner.
    let knockBusy = false;
    let knockRoom = '';

    const statusLine = text => { byId('friends-status').textContent = text; };
    const roomStatus = text => { const s = byId('status'); if (s) s.textContent = text; };
    const friendById = id => view.friends.find(f => f.friendId === id) ?? null;

    function render() {
        const locked = view.state === 'locked';
        const open = view.state === 'open';
        byId('friends-locked').hidden = !locked;
        byId('friends-retry').hidden = !locked || typeof api.retry !== 'function';
        byId('friends-empty').hidden = !open || view.friends.length > 0 || view.waiting.length > 0;
        byId('friends-settings').hidden = !open;
        const rows = view.friends.map(friend => {
            const row = document.createElement('li');
            row.dataset.friendId = friend.friendId;
            row.dataset.state = friend.state;
            row.tabIndex = -1;
            const name = document.createElement('span');
            name.className = 'friend-name';
            name.textContent = friend.name;
            const state = document.createElement('span');
            state.className = 'friend-state';
            state.textContent = stateText(friend);
            row.append(name, state);
            // easy-join part 3: Join, or "Ask <name> for an invite" when the friend cannot forward a knock.
            if (friend.join && friend.join.ask) {
                const ask = document.createElement('span');
                ask.className = 'friend-ask';
                ask.textContent = askText(friend.name);
                row.append(ask);
            } else if (friend.join) {
                const join = document.createElement('button');
                join.type = 'button';
                join.className = 'friend-join';
                join.textContent = 'Join';
                join.setAttribute('aria-label', `Join ${friend.join.room}`);
                join.disabled = knockBusy;
                join.addEventListener('click', event => {
                    event.stopPropagation();
                    void knockJoin(friend.friendId);
                });
                join.addEventListener('keydown', event => { if (event.key === 'Enter') event.stopPropagation(); });
                row.append(join);
            }
            if (friend.unread > 0) {
                const count = document.createElement('span');
                count.className = 'count';
                count.textContent = String(friend.unread);
                count.setAttribute('aria-label', `${friend.unread} unread`);
                row.append(count);
            }
            return row;
        });
        list.replaceChildren(...rows);
        if (rows[0]) rows[0].tabIndex = 0;
        waitingList.replaceChildren(...view.waiting.map(w => {
            const row = document.createElement('li');
            const tag = document.createElement('span');
            tag.className = 'state-tag';
            tag.textContent = 'Pending';
            tag.title = waitingText(w.name);
            row.append(w.name || 'Your friend', ' ', tag);
            return row;
        }));
        if (open) {
            const reach = byId('friends-reach');
            reach.textContent = reachText(view.reach);
            reach.title = reachTip(view.reach);
            reach.dataset.reach = reachKind(view.reach);
            byId('friends-upnp').hidden = view.reach !== 'local' || view.upnp === true;
            byId('friends-name').textContent = view.name || 'your room name';
            const blocked = byId('friends-blocked');
            blocked.hidden = view.blocked.length === 0;
            byId('friend-blocked-list').replaceChildren(...view.blocked.map(b => {
                const row = document.createElement('li');
                const name = document.createElement('span');
                name.textContent = b.name || 'Blocked person';
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = 'Unblock';
                button.addEventListener('click', () => act(api.unblock(b.deviceId)));
                row.append(name, ' ', button);
                return row;
            }));
        }
        const unread = view.friends.reduce((sum, f) => sum + (f.unread || 0), 0);
        if (unreadBadge) {
            unreadBadge.textContent = unread ? String(unread) : '';
            unreadBadge.hidden = unread === 0;
        }
    }

    function act(promise, ok = '') {
        return Promise.resolve(promise).then(result => { statusLine(ok); return result; }, err => {
            statusLine(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
            return false;
        });
    }

    function setView(next) {
        if (next && typeof next === 'object') view = { friends: [], waiting: [], blocked: [], ...next };
        render();
        refreshRelations();
    }

    // The buddy menu lines: 'add' or 'open' for each peer of the room (only in a protected room).
    function peerIds() {
        return Array.from(byId('peers')?.children ?? []).map(row => row.dataset.peerId).filter(Boolean);
    }
    function refreshRelations() {
        const ids = peerIds();
        if (!ids.length || view.state !== 'open') { relations = {}; return; }
        Promise.resolve(api.relations(ids)).then(value => { relations = value && typeof value === 'object' ? value : {}; }, () => {});
    }

    // ---- The drawer in a room ----
    function inRoom() { return !windowMode && Boolean(loginScreen?.hidden); }
    function refresh() {
        if (windowMode) return;
        const room = inRoom();
        toggle.hidden = !room;
        if (room && panel.parentElement !== document.body) {
            document.body.appendChild(panel);
            panel.classList.add('friends-drawer');
            panel.hidden = !drawerOpen;
        }
        byId('friends-close').hidden = !room;
        if (popOutButton) popOutButton.hidden = !room || typeof api.popOut !== 'function';
        refreshRelations();
    }
    function setDrawer(open) {
        refresh();
        if (!inRoom()) return;
        drawerOpen = open;
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) (list.querySelector('li[tabindex="0"]') ?? byId('friends-close')).focus();
        else toggle.focus();
    }
    toggle?.addEventListener('click', () => setDrawer(!drawerOpen));
    byId('friends-close')?.addEventListener('click', () => setDrawer(false));
    // 1.0.1: the Friends window. The drawer closes when the window opens.
    popOutButton?.addEventListener('click', () => act(api.popOut()).then(opened => { if (opened === true) setDrawer(false); }));
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape' && drawerOpen && !event.defaultPrevented && !document.querySelector('dialog[open]')) {
            event.preventDefault();
            setDrawer(false);
        }
    });
    if (loginScreen && typeof MutationObserver === 'function') {
        new MutationObserver(refresh).observe(loginScreen, { attributes: true, attributeFilter: ['hidden'] });
    }

    // ---- Rows ----
    function openChat(friendId) {
        if (!friendById(friendId)) return false;
        return act(api.openChat(friendId));
    }
    function rowOf(node) {
        while (node && node.parentElement !== list) node = node.parentElement;
        return node ?? null;
    }
    list.addEventListener('click', event => {
        const row = rowOf(event.target);
        if (row) openChat(row.dataset.friendId);
    });
    list.addEventListener('keydown', event => {
        const row = rowOf(event.target);
        if (row && event.key === 'Enter') { event.preventDefault(); openChat(row.dataset.friendId); }
    });

    function askName(title, value, save) {
        byId('friend-name-title').textContent = title;
        byId('friend-name-input').value = value;
        byId('friend-name-error').textContent = '';
        nameAction = save;
        nameDialog.showModal?.();
        byId('friend-name-input').focus();
    }
    byId('friend-name-form').addEventListener('submit', event => {
        event.preventDefault();
        const value = byId('friend-name-input').value.trim();
        if (!value) { byId('friend-name-error').textContent = 'Enter a name of up to 64 characters.'; return; }
        const save = nameAction;
        Promise.resolve(save?.(value)).then(() => nameDialog.close?.(), err => {
            byId('friend-name-error').textContent = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        });
    });
    byId('friend-name-cancel').addEventListener('click', () => nameDialog.close?.());
    byId('friends-name-change').addEventListener('click', () => askName('Your name for friends', view.name ?? '', name => api.setName(name)));

    // keep: run() writes its own status (no act()).
    function ask(text, button, run, keep = false) {
        byId('friend-confirm-text').textContent = text;
        byId('friend-confirm-yes').textContent = button;
        confirmAction = run;
        confirmKeep = keep;
        confirmDialog.showModal?.();
    }
    byId('friend-confirm-yes').addEventListener('click', () => {
        const run = confirmAction;
        const keep = confirmKeep;
        confirmAction = null;
        confirmDialog.close?.();
        if (run && keep) run();
        else if (run) act(run());
    });

    // easy-join part 3: Join of a friend row. In a room it first asks "Leave <room> and join <room>?" (the step of the
    // friend invite). The current room stays until the owner selects Allow.
    function joinStatus(text) {
        statusLine(text);
        roomStatus(text);
    }
    async function knockJoin(friendId, leave = false) {
        const friend = friendById(friendId);
        if (!friend?.join || friend.join.ask || !api.knockJoin || knockBusy) return false;
        knockBusy = true;
        knockRoom = friend.join.room;
        render();
        joinStatus(knockStateText('looking', knockRoom));
        let answer;
        try { answer = await api.knockJoin(friend.friendId, leave); } catch { answer = { result: 'failed' }; }
        knockBusy = false;
        render();
        if (answer?.result === 'confirm') {
            joinStatus('');
            ask(`Leave ${answer.current} and join ${answer.room}?`, 'Leave and join', () => { void knockJoin(friendId, true); }, true);
            return true;
        }
        joinStatus(joinText(answer, friend.name));
        return answer?.result === 'joining';
    }
    api.onKnockState?.(data => {
        if (knockBusy && data?.state) joinStatus(knockStateText(data.state, String(data.room || knockRoom)));
    });

    function run(action, row) {
        const friend = friendById(row?.dataset?.friendId);
        if (!friend) return false;
        const name = friend.name;
        switch (action) {
            case 'friend-open': return openChat(friend.friendId);
            case 'friend-rename': askName(`Rename ${name}`, name, value => api.rename(friend.friendId, value)); return true;
            case 'friend-remove':
                ask(`Remove ${name}? Your messages with ${name} are deleted from this PC.`, 'Remove friend',
                    () => api.remove(friend.friendId));
                return true;
            case 'friend-block':
                ask(`Block ${name}? They're removed and can't send you requests.`, 'Block',
                    () => api.block(friend.friendId));
                return true;
            case 'friend-join':
                if (!friend.join || friend.join.ask) return false;
                void knockJoin(friend.friendId);
                return true;
            case 'friend-invite':
                if (!friend.canInvite || !api.invite) return false;
                Promise.resolve(api.invite(friend.friendId)).then(answer => statusLine(inviteText(answer?.result, name)),
                    () => statusLine(inviteText('failed', name)));
                return true;
            default: return false;
        }
    }

    // ---- Settings ----
    byId('friends-upnp').addEventListener('click', () => act(api.setUpnp(true)));
    byId('friends-retry').addEventListener('click', () => act(api.retry()).then(() => api.list()).then(setView, () => {}));

    // ---- Add friend (the buddy menu of a protected room) ----
    const NOT_SENT = {
        busy: name => `Request to ${name} already sent.`,
        cap: () => `Friend limit reached (${view.cap ?? 32}).`,
        friend: name => `${name} is already your friend.`,
        blocked: name => `${name} is blocked. Unblock them first.`,
        locked: () => 'Friends are locked: secure storage is unavailable.'
    };
    async function add(peerId) {
        if (!peerId) return false;
        let answer;
        try { answer = await api.request(peerId); } catch { answer = null; }
        const name = answer?.name || 'this person';
        if (answer?.result === 'sent') roomStatus(`Friend request sent to ${name}.`);
        else roomStatus((NOT_SENT[answer?.result] ?? (() => 'Not available right now.'))(name));
        refreshRelations();
        return answer?.result === 'sent';
    }
    function openFor(peerId) {
        const value = relations[peerId];
        return value?.kind === 'open' ? openChat(value.friendId) : false;
    }

    api.onChanged(setView);
    window.asscrack?.onPeerJoined?.(refreshRelations);
    window.asscrack?.onPeerLeft?.(refreshRelations);
    window.asscrack?.onMembership?.(refreshRelations);
    Promise.resolve(api.list()).then(setView, () => {});
    refresh();

    window.friendsUi = Object.freeze({
        relation: peerId => relations[peerId]?.kind ?? null,
        rowInfo: row => {
            const friend = friendById(row?.dataset?.friendId);
            return friend ? { kind: 'friend', invite: friend.canInvite === true, join: Boolean(friend.join && !friend.join.ask) } : null;
        },
        run, add, openFor, refresh,
        view: () => view
    });
})();
