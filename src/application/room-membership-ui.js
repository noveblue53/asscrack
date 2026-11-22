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
    // easy-join part 2: "Copy room code" and "New room code" (owner only). Optional: older test pages have no box.
    const codeBox = get('room-code-box');
    const codeCopy = get('room-code-copy');
    const codeNew = get('room-code-new');
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

    // Gap A1: the texts of the owner for each reach state. A device invite needs an address (or a LAN room).
    const REACH_TEXTS = {
        untested: 'Address ready. ASSCRACK tests it when the first friend connects.',
        'upnp-wait': 'Asking the router to open a port. This can take up to 70 seconds.',
        'no-gateway': 'The router did not answer. Turn on UPnP in the router, or forward a TCP port.',
        'private-ip': 'The router has no public address (a second router or the provider is between you and the internet). '
            + 'UPnP cannot help. A friend with an open port must create the room.',
        failed: 'The router did not open a port.',
        none: 'Friends on the internet cannot join yet: this room has no address.'
    };
    function canInvite() {
        return !reach || reach.state === 'ready' || reach.state === 'lan';
    }
    function showReach() {
        if (!reachBox) return;
        let text = '';
        let action = '';
        if (state?.owner && reach) {
            if (reach.state === 'ready') text = reach.proven === true ? '' : REACH_TEXTS.untested;
            else if (reach.state === 'upnp-wait') text = REACH_TEXTS['upnp-wait'];
            else if (reach.state === 'upnp-failed') {
                text = REACH_TEXTS[reach.reason] ?? REACH_TEXTS.failed;
                action = 'Try UPnP again';
            } else if (reach.state === 'none') {
                text = REACH_TEXTS.none;
                action = 'Ask my router to open a port (UPnP)';
            }
        }
        reachBox.hidden = text === '';
        reachNote.textContent = text;
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
            if (result?.started === false) inviteNote.textContent = 'UPnP cannot start in this room.';
        } catch (error) {
            inviteNote.textContent = error?.message ? errorText(error) : 'Could not start UPnP.';
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

    function listDevices() {
        const current = state?.owner ? state.members ?? [] : [];
        const rows = current.map(member => ({ ...member, name: peerNames.get(member.peerId) ?? '' }));
        const signature = JSON.stringify([rows, confirming, busy]);
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
            const details = document.createElement('span');
            details.textContent = member.revoked ? 'Revoked' : (member.connected ? 'Connected' : 'Offline or invited')
                + (member.canHost ? ' · Can host' : ' · Member');
            device.append(name, id, details);
            if (member.revoked) return device;
            if (confirming === member.deviceId) {
                const confirm = button('Confirm revoke', () => revoke(member.deviceId));
                const cancel = button('Cancel', () => {
                    confirming = null;
                    listDevices();
                    devices.querySelector(`[data-device-id="${member.deviceId}"] button`)?.focus();
                });
                confirm.disabled = cancel.disabled = busy;
                device.append(confirm, cancel);
            } else {
                const deny = button('Revoke', () => {
                    confirming = member.deviceId;
                    listDevices();
                    devices.querySelector(`[data-device-id="${member.deviceId}"] button`)?.focus();
                });
                deny.disabled = busy;
                deny.setAttribute('aria-label', `Revoke ${member.name || 'device'} ${member.deviceId}`);
                device.append(deny);
            }
            return device;
        }));
    }

    function update(next, nextReach) {
        if (!next?.protected) return;
        const first = state === null;
        state = next;
        if (nextReach !== undefined) reach = nextReach;
        inviteToggle.hidden = false;
        inviteToggle.textContent = next.owner ? 'Invite' : 'Access';
        if (first || !next.owner || next.members?.some(member => member.deviceId === generatedFor && member.revoked)) clearCode();
        accessStatus.hidden = false;
        accessStatus.textContent = next.revoked ? 'This device’s access was revoked.' : !next.admitted
            ? 'Waiting for the room owner to admit this device.' : next.owner ? 'You own this protected room.'
                : next.canHost ? 'This device is admitted and can host or relay.' : 'This device is admitted.';
        form.hidden = !next.owner;
        if (codeBox) codeBox.hidden = !next.owner;
        if (autoAllow && !autoAllowBusy) autoAllow.checked = next.owner && next.autoAllowFriends === true;
        statusBar.querySelector('.net-note').textContent = next.lan ? 'Protected LAN room' : 'Protected internet room';
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
            if (!await api.revokeMember(id)) throw new Error('This device is already unavailable.');
            if (generatedFor === id) clearCode();
            inviteNote.textContent = 'Device access revoked.';
            confirming = null;
        } catch (error) {
            inviteNote.textContent = error?.message ? errorText(error) : 'Could not revoke access.';
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
            if (typeof made?.code !== 'string' || made.code.length === 0) throw new Error('Could not make the room code.');
            codeLabel.textContent = 'Room code';
            inviteCode.value = made.code;
            codeLabel.hidden = inviteCode.hidden = copyInviteButton.hidden = false;
            copyInviteButton.disabled = false;
            const until = new Date(made.expires).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
            inviteNote.textContent = renew
                ? `New room code copied. The old code no longer works. Valid until ${until}.`
                : `Room code copied. Valid until ${until}.`;
        } catch (error) {
            inviteNote.textContent = error?.message ? errorText(error) : 'Could not make the room code.';
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
            inviteNote.textContent = error?.message ? errorText(error) : 'Could not change the setting.';
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
        if (!state?.owner || busy || !canInvite()) return;
        const id = target.value.trim();
        clearCode();
        busy = create.disabled = target.disabled = canHost.disabled = true;
        try {
            const code = await api.createMemberInvite(id, canHost.checked);
            if (typeof code !== 'string' || code.length === 0) throw new Error('No device invite was created.');
            generatedFor = id;
            codeLabel.textContent = 'Invite for this device';
            inviteCode.value = code;
            codeLabel.hidden = inviteCode.hidden = copyInviteButton.hidden = false;
            copyInviteButton.disabled = false;
            inviteNote.textContent = 'Invite ready for this device.';
            copyInviteButton.focus();
        } catch (error) {
            inviteNote.textContent = error?.message ? errorText(error) : 'Could not create the device invite.';
        } finally {
            busy = target.disabled = canHost.disabled = false;
            create.disabled = !canInvite();
            listDevices();
        }
    });

    api.onMembership(update);
    api.onPeerName(() => { if (state?.owner) listDevices(); });
    window.roomMembership = { start: update, update };
})();
