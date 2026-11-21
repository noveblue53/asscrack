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
    let state = null;
    let generatedFor = null;
    let confirming = null;
    let rendering = '';
    let busy = false;

    enrollment.addEventListener('click', async () => {
        enrollment.disabled = true;
        try {
            const id = await api.getDeviceId();
            await api.copyText(id);
            enrollmentNote.textContent = 'Device ID copied. Send it to the owner.';
        } catch (error) {
            enrollmentNote.textContent = error?.message ?? 'Could not copy your device ID.';
        } finally { enrollment.disabled = false; }
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

    function update(next) {
        if (!next?.protected) return;
        const first = state === null;
        state = next;
        inviteToggle.hidden = false;
        inviteToggle.textContent = next.owner ? 'Invite' : 'Access';
        if (first || !next.owner || next.members?.some(member => member.deviceId === generatedFor && member.revoked)) clearCode();
        accessStatus.hidden = false;
        accessStatus.textContent = next.revoked ? 'This device’s access was revoked.' : !next.admitted
            ? 'Waiting for the room owner to admit this device.' : next.owner ? 'You own this protected room.'
                : next.canHost ? 'This device is admitted and can host or relay.' : 'This device is admitted.';
        form.hidden = !next.owner;
        statusBar.querySelector('.net-note').textContent = next.lan ? 'Protected LAN room' : 'Protected internet room';
        if (waitingPeer) {
            waitingPeer.textContent = next.revoked ? 'This device’s access was revoked.'
                : next.admitted ? 'Waiting for a peer' : 'Waiting for the room owner';
        }
        listDevices();
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
            inviteNote.textContent = error?.message ?? 'Could not revoke access.';
        } finally {
            busy = false;
            listDevices();
            if (confirming === null) target.focus();
        }
    }

    target.addEventListener('input', clearCode);
    canHost.addEventListener('change', clearCode);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!state?.owner || busy) return;
        const id = target.value.trim();
        clearCode();
        busy = create.disabled = target.disabled = canHost.disabled = true;
        try {
            const code = await api.createMemberInvite(id, canHost.checked);
            if (typeof code !== 'string' || code.length === 0) throw new Error('No device invite was created.');
            generatedFor = id;
            inviteCode.value = code;
            codeLabel.hidden = inviteCode.hidden = copyInviteButton.hidden = false;
            copyInviteButton.disabled = false;
            inviteNote.textContent = 'Invite ready for this device.';
            copyInviteButton.focus();
        } catch (error) {
            inviteNote.textContent = error?.message ?? 'Could not create the device invite.';
        } finally {
            busy = create.disabled = target.disabled = canHost.disabled = false;
            listDevices();
        }
    });

    api.onMembership(update);
    api.onPeerName(() => { if (state?.owner) listDevices(); });
    window.roomMembership = { start: update, update };
})();
