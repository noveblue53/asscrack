(function () {
    const api = window.asscrack;
    const get = id => document.getElementById(id);
    const enrollment = get('copy-device-id');
    const enrollmentNote = get('device-id-note');
    const accessStatus = get('room-access-status');
    const form = get('member-invite-form');
    const target = get('member-device-id');
    const canHost = get('member-can-host');
    const create = get('member-invite-create');
    const codeLabel = get('invite-code-label');
    const devicesSection = get('room-members-section');
    const devices = get('room-members');
    const reachBox = get('reach-box');
    const reachNote = get('reach-note');
    const reachButton = get('reach-upnp');
    // UI copy pass: the router reason is one line under the UPnP button (optional: older test pages have no line).
    const reachReason = get('reach-reason');
    // easy-join part 2: "Copy room code" and "New room code" (owner only). Optional: older test pages have no box.
    const codeBox = get('room-code-box');
    const codeCopy = get('room-code-copy');
    const codeNew = get('room-code-new');
    // U5: the expiry of the copied room code as a small tag (optional).
    const codeExpiry = get('room-code-expiry');
    // easy-join part 3: "Always allow my friends" (owner only, off by default). Optional as the code box.
    const autoAllow = get('auto-allow-friends');
    let state = null;
    // The reach state of asscrack:invite (gap A1), or null before the first answer.
    let reach = null;
    let reachBusy = false;
    let generatedFor = null;
    let confirming = null;
    let rendering = '';
    let busy = false;
    let autoAllowBusy = false;

    // Gap A3: the device ID button is below the login button for each room type. After the copy, the window goes to
    // the join type, because the next step of the friend is to paste the invite.
    enrollment.addEventListener('click', async () => {
        enrollment.disabled = true;
        try {
            const id = await api.getDeviceId();
            await api.copyText(id);
            if (typeof setRoomType === 'function' && roomTypeSelect.value !== 'join') setRoomType('join');
            inviteInput?.focus();
            enrollmentNote.textContent = 'Copied. Send it to the room owner.';
        } catch (error) {
            enrollmentNote.textContent = error?.message ? errorText(error) : 'Couldn\'t copy.';
        } finally { enrollment.disabled = false; }
    });

    // Gap A1, U2 of the UI copy pass: the reach of the owner is a dot and a short label, with the detail in the
    // tooltip. A router failure gives one line under the UPnP button. A device invite needs an address (or a LAN room).
    const REACH_VIEWS = {
        untested: { kind: 'none', label: 'Not tested', tip: 'Checked when the first friend joins' },
        'upnp-wait': { kind: 'busy', label: 'Opening port…', tip: '' },
        none: { kind: 'bad', label: 'Not reachable', tip: 'Friends on the internet can\'t join yet' }
    };
    const REASON_TEXTS = {
        'no-gateway': { text: 'Router didn\'t respond. Turn on UPnP in your router or forward a TCP port.', tip: '' },
        'private-ip': { text: 'Your router has no public IP. Ask a friend with an open port to create the room.',
            tip: 'A second router or your provider (CGNAT) is in the way' },
        failed: { text: 'Router refused to open a port.', tip: '' }
    };
    function canInvite() {
        return !reach || reach.state === 'ready' || reach.state === 'lan';
    }
    function showReach() {
        if (!reachBox) return;
        let view = null;
        let reason = null;
        let action = '';
        if (state?.owner && reach) {
            if (reach.state === 'ready') view = reach.proven === true ? null : REACH_VIEWS.untested;
            else if (reach.state === 'upnp-wait') view = REACH_VIEWS['upnp-wait'];
            else if (reach.state === 'upnp-failed') {
                view = REACH_VIEWS.none;
                reason = REASON_TEXTS[reach.reason] ?? REASON_TEXTS.failed;
                action = 'Try UPnP again';
            } else if (reach.state === 'none') {
                view = REACH_VIEWS.none;
                action = 'Open port (UPnP)';
            }
        }
        reachBox.hidden = view === null;
        reachNote.textContent = view?.label ?? '';
        reachNote.title = view?.tip ?? '';
        reachNote.dataset.reach = view?.kind ?? '';
        if (reachReason) {
            reachReason.hidden = reason === null;
            reachReason.textContent = reason?.text ?? '';
            reachReason.title = reason?.tip ?? '';
        }
        reachButton.hidden = action === '';
        reachButton.textContent = action;
        reachButton.disabled = reachBusy;
        if (!busy) create.disabled = !canInvite();
    }
    reachButton?.addEventListener('click', async () => {
        if (reachBusy || !state?.owner) return;
        reachBusy = true;
        showReach();
        try {
            const result = await api.enableUpnp();
            if (result?.reach) reach = result.reach;
            if (result?.started === false) inviteNote.textContent = 'UPnP isn\'t available in this room.';
        } catch (error) {
            inviteNote.textContent = error?.message ? errorText(error) : 'Couldn\'t start UPnP.';
        } finally {
            reachBusy = false;
            showReach();
            if (typeof refreshInvite === 'function') refreshInvite();
        }
    });

    function clearCode() {
        generatedFor = null;
        inviteCode.value = '';
        copyInviteButton.disabled = true;
        codeLabel.hidden = inviteCode.hidden = copyInviteButton.hidden = true;
    }

    function button(text, action) {
        const result = document.createElement('button');
        result.type = 'button';
        result.textContent = text;
        result.addEventListener('click', action);
        return result;
    }

    function canManage() {
        return Boolean(state?.owner || state?.canManageMembers);
    }

    function canActOn(member) {
        if (!canManage() || !member) return false;
        if (state.owner) return true;
        return member.role !== 'admin';
    }

    async function runMemberAction(label, fn) {
        if (busy || !canManage()) return;
        busy = true;
        listDevices();
        try {
            await fn();
            inviteNote.textContent = label;
            confirming = null;
        } catch (error) {
            inviteNote.textContent = error?.message ? errorText(error) : 'Action failed.';
        } finally {
            busy = false;
            listDevices();
        }
    }

    function listDevices() {
        const current = canManage() ? state.members ?? [] : [];
        const rows = current
            .filter(member => !member.hidden)
            .map(member => ({ ...member, name: peerNames.get(member.peerId) ?? '' }));
        const signature = JSON.stringify([rows, confirming, busy, state?.owner, state?.canManageMembers]);
        if (signature === rendering) return;
        rendering = signature;
        devicesSection.hidden = rows.length === 0;
        devices.replaceChildren(...rows.map(member => {
            const device = document.createElement('li');
            device.dataset.deviceId = member.deviceId;
            const name = document.createElement('strong');
            name.textContent = member.name || 'Device';
            const id = document.createElement('code');
            id.textContent = member.deviceId;
            const status = member.status ?? (member.revoked ? 'removed' : 'active');
            const roleTag = document.createElement('span');
            roleTag.className = 'role-tag';
            roleTag.dataset.role = member.role ?? 'member';
            roleTag.dataset.status = status;
            roleTag.textContent = status === 'banned' ? 'Banned'
                : status === 'removed' ? 'Removed'
                    : status === 'kicked' ? 'Kicked'
                        : member.role === 'admin' ? 'Admin'
                            : member.canHost ? 'Member · Host' : 'Member';
            const details = document.createElement('span');
            details.textContent = status !== 'active' ? '' : (member.connected ? 'Connected' : 'Offline');
            device.append(name, roleTag, details, id);

            const actions = [];
            if (status === 'banned' || status === 'removed') {
                if (canActOn(member) && typeof api.unbanMember === 'function') {
                    const unbanBtn = button('Unban', () => runMemberAction('Device unbanned.', () => api.unbanMember(member.deviceId)));
                    unbanBtn.disabled = busy;
                    actions.push(unbanBtn);
                }
            } else if (status === 'kicked') {
                if (canActOn(member)) {
                    const banBtn = button('Ban', () => runMemberAction('Device banned.', () => api.banMember(member.deviceId)));
                    banBtn.className = 'btn-danger';
                    banBtn.disabled = busy;
                    const forgetBtn = button('Forget', () => runMemberAction('Device forgotten.', () => api.forgetMember(member.deviceId)));
                    forgetBtn.disabled = busy;
                    actions.push(banBtn, forgetBtn);
                }
            } else {
                const canToggleHost = state.owner || member.role !== 'admin' || member.deviceId === state.deviceId;
                if (canToggleHost) {
                    const hostLabel = document.createElement('label');
                    hostLabel.className = 'admission-check';
                    const hostCheck = document.createElement('input');
                    hostCheck.type = 'checkbox';
                    hostCheck.checked = member.canHost === true;
                    hostCheck.disabled = busy;
                    hostCheck.addEventListener('change', () => runMemberAction(
                        hostCheck.checked ? 'Host access enabled.' : 'Host access removed.',
                        () => api.setMemberCanHost(member.deviceId, hostCheck.checked)
                    ));
                    hostLabel.append(hostCheck, document.createTextNode(' Can host'));
                    actions.push(hostLabel);
                }
                if (canActOn(member)) {
                    if (confirming === member.deviceId) {
                        const confirm = button('Remove', () => runMemberAction('Device removed.', () => {
                            if (generatedFor === member.deviceId) clearCode();
                            return api.revokeMember(member.deviceId);
                        }));
                        confirm.className = 'btn-danger';
                        const cancel = button('Cancel', () => {
                            confirming = null;
                            listDevices();
                            devices.querySelector(`[data-device-id="${member.deviceId}"] button`)?.focus();
                        });
                        confirm.disabled = cancel.disabled = busy;
                        actions.push(confirm, cancel);
                    } else {
                        const deny = button('Remove', () => {
                            confirming = member.deviceId;
                            listDevices();
                            devices.querySelector(`[data-device-id="${member.deviceId}"] button`)?.focus();
                        });
                        deny.disabled = busy;
                        deny.setAttribute('aria-label', `Remove ${member.name || 'device'}`);
                        const kickBtn = button('Kick', () => runMemberAction('Device kicked.', () => api.kickMember(member.deviceId)));
                        kickBtn.disabled = busy;
                        actions.push(deny, kickBtn);
                    }
                }
                if (state.owner) {
                    const nextRole = member.role === 'admin' ? 'member' : 'admin';
                    const roleBtn = button(member.role === 'admin' ? 'Remove admin' : 'Make admin',
                        () => runMemberAction(nextRole === 'admin' ? 'Promoted to Admin.' : 'Admin removed.',
                            () => api.setMemberRole(member.deviceId, nextRole)));
                    roleBtn.disabled = busy;
                    actions.push(roleBtn);
                }
            }
            if (actions.length > 0) device.append(...actions);
            return device;
        }));
    }

    function contextActions(peerId) {
        if (!canManage() || !peerId) return [];
        const member = (state?.members ?? []).find(m => m.peerId === peerId);
        if (!member || member.status === 'banned' || member.status === 'kicked') return [];
        const out = [];
        if (state.owner) {
            const nextRole = member.role === 'admin' ? 'member' : 'admin';
            out.push({
                label: member.role === 'admin' ? 'Remove admin' : 'Make admin',
                run: () => runMemberAction(nextRole === 'admin' ? 'Promoted to Admin.' : 'Admin removed.',
                    () => api.setMemberRole(member.deviceId, nextRole))
            });
        }
        if (state.owner || member.role !== 'admin') {
            const nextHost = !member.canHost;
            out.push({
                label: nextHost ? 'Allow hosting (Can host)' : 'Remove hosting (Can host)',
                run: () => runMemberAction(nextHost ? 'Host access enabled.' : 'Host access removed.',
                    () => api.setMemberCanHost(member.deviceId, nextHost))
            });
            out.push({
                label: 'Kick',
                run: () => runMemberAction('Device kicked.', () => api.kickMember(member.deviceId))
            });
            out.push({
                label: 'Ban',
                danger: true,
                run: () => runMemberAction('Device banned.', () => api.banMember(member.deviceId))
            });
        }
        return out;
    }

    function update(next, nextReach) {
        if (!next?.protected) return;
        const first = state === null;
        state = next;
        if (nextReach !== undefined) reach = nextReach;
        inviteToggle.hidden = false;
        inviteToggle.textContent = next.owner || next.canManageMembers ? 'Invite' : 'Access';
        if (first || (!next.owner && !next.canManageMembers) ||
            next.members?.some(member => member.deviceId === generatedFor && member.revoked)) clearCode();
        // U1 of the UI copy pass: the role is a badge on the card head, not a sentence.
        const role = next.revoked ? ['removed', 'Removed', 'You were removed from this room']
            : !next.admitted ? ['waiting', 'Waiting for approval', 'Waiting for the room owner']
                : next.owner ? ['owner', 'Owner', 'You created this room']
                    : next.isAdmin ? ['admin', 'Admin', 'Can manage members, channels, and invites']
                        : next.canHost ? ['host', 'Member · Host', 'Can host and relay for the room'] : ['member', 'Member', ''];
        accessStatus.hidden = false;
        accessStatus.dataset.role = role[0];
        accessStatus.textContent = role[1];
        accessStatus.title = role[2];
        form.hidden = !canManage();
        if (codeBox) codeBox.hidden = !next.owner;
        if (autoAllow && !autoAllowBusy) autoAllow.checked = next.owner && next.autoAllowFriends === true;
        const netNote = statusBar.querySelector('.net-note');
        netNote.textContent = next.lan ? 'LAN room' : 'Internet room';
        netNote.classList.add('locked');
        netNote.title = 'Protected room';
        // Gap A2: room-link.js writes #waiting-peer from these facts and the peer facts.
        window.roomLink?.membership({ owner: next.owner, admitted: next.admitted, revoked: next.revoked });
        listDevices();
        showReach();
    }

    async function revoke(id) {
        if (busy || !state?.owner || confirming !== id) return;
        busy = true;
        listDevices();
        try {
            if (!await api.revokeMember(id)) throw new Error('Already removed.');
            if (generatedFor === id) clearCode();
            inviteNote.textContent = 'Device removed.';
            confirming = null;
        } catch (error) {
            inviteNote.textContent = error?.message ? errorText(error) : 'Couldn\'t remove the device.';
        } finally {
            busy = false;
            listDevices();
            if (confirming === null) target.focus();
        }
    }

    // easy-join part 2: the room code. The main process copies it; the box also shows it.
    async function roomCode(renew) {
        if (!state?.owner || busy || !codeCopy) return;
        busy = codeCopy.disabled = codeNew.disabled = true;
        clearCode();
        try {
            const made = await api.roomCode(renew);
            if (typeof made?.code !== 'string' || made.code.length === 0) throw new Error('Couldn\'t make the room code.');
            codeLabel.textContent = 'Room code';
            inviteCode.value = made.code;
            codeLabel.hidden = inviteCode.hidden = copyInviteButton.hidden = false;
            copyInviteButton.disabled = false;
            // U5: the expiry is a tag in the code box, not a sentence.
            const until = new Date(made.expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            if (codeExpiry) {
                codeExpiry.textContent = `Expires ${until}`;
                codeExpiry.hidden = false;
            }
            inviteNote.textContent = renew ? 'New room code copied. The old code no longer works.' : 'Room code copied.';
        } catch (error) {
            inviteNote.textContent = error?.message ? errorText(error) : 'Couldn\'t make the room code.';
        } finally {
            busy = codeCopy.disabled = codeNew.disabled = false;
            listDevices();
        }
    }
    // easy-join part 3: the main process saves the setting with the room of the owner.
    autoAllow?.addEventListener('change', async () => {
        if (!state?.owner || autoAllowBusy) return;
        const wanted = autoAllow.checked;
        autoAllowBusy = autoAllow.disabled = true;
        try {
            autoAllow.checked = (await api.setAutoAllowFriends(wanted)) === true;
            // The checkbox shows the state; its tooltip has the detail (index.html).
            inviteNote.textContent = '';
        } catch (error) {
            autoAllow.checked = !wanted;
            inviteNote.textContent = error?.message ? errorText(error) : 'Couldn\'t change the setting.';
        } finally {
            autoAllowBusy = autoAllow.disabled = false;
        }
    });
    codeCopy?.addEventListener('click', () => roomCode(false));
    codeNew?.addEventListener('click', () => roomCode(true));

    target.addEventListener('input', clearCode);
    canHost.addEventListener('change', clearCode);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!canManage() || busy || !canInvite()) return;
        const id = target.value.trim();
        clearCode();
        busy = create.disabled = target.disabled = canHost.disabled = true;
        try {
            const code = await api.createMemberInvite(id, canHost.checked);
            if (typeof code !== 'string' || code.length === 0) throw new Error('Couldn\'t create the invite.');
            generatedFor = id;
            codeLabel.textContent = 'Invite code';
            inviteCode.value = code;
            codeLabel.hidden = inviteCode.hidden = copyInviteButton.hidden = false;
            copyInviteButton.disabled = false;
            inviteNote.textContent = 'Invite ready. Copy it and send it.';
            copyInviteButton.focus();
        } catch (error) {
            inviteNote.textContent = error?.message ? errorText(error) : 'Couldn\'t create the invite.';
        } finally {
            busy = target.disabled = canHost.disabled = false;
            create.disabled = !canInvite();
            listDevices();
        }
    });

    api.onMembership(update);
    api.onPeerName(() => { if (canManage()) listDevices(); });
    window.roomMembership = { start: update, update, contextActions };
})();
