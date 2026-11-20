(() => {
    const button = document.getElementById('activity-open');
    const dialog = document.getElementById('room-activity');
    const text = document.getElementById('activity-lines');
    const pause = document.getElementById('activity-pause');
    const copy = document.getElementById('activity-copy');
    const status = document.getElementById('activity-status');
    const title = document.getElementById('activity-title');
    const transfers = document.getElementById('activity-transfers');
    const all = document.getElementById('activity-all');
    let timer;
    let generation = 0;
    let peerId = null;
    const roomOptions = document.getElementById('room-options');
    const roomOptionsToggle = document.getElementById('room-options-toggle');
    let opener = roomOptionsToggle;

    // Pull the bounded main-process snapshot only while visible and following live.
    async function refresh(version) {
        try {
            const lines = await window.asscrack.getRoomActivity(peerId, transfers.checked);
            if (version !== generation || !dialog.open) return;
            const next = lines.join('\n');
            if (next !== text.value) {
                text.value = next;
                text.scrollTop = text.scrollHeight;
            }
            copy.disabled = !next;
        } catch {
            if (version === generation) status.textContent = 'Activity unavailable';
        }
        if (version === generation && dialog.open) timer = setTimeout(() => refresh(version), 1000);
    }

    function follow(live) {
        clearTimeout(timer);
        generation++;
        pause.setAttribute('aria-pressed', String(!live));
        pause.textContent = live ? 'Pause' : 'Resume live';
        if (live) void refresh(generation);
    }

    function resetFilter() {
        text.value = '';
        copy.disabled = true;
        status.textContent = '';
        all.hidden = peerId === null;
        follow(true);
    }
    function open(id, name, control) {
        peerId = id;
        opener = control;
        title.textContent = id ? 'Recent activity · ' + name : 'Room activity on this device';
        transfers.checked = false;
        dialog.showModal();
        resetFilter();
    }
    window.roomActivity = { openPeer: open };
    button.addEventListener('click', () => {
        roomOptions.hidePopover();
        open(null, '', roomOptionsToggle);
    });
    transfers.addEventListener('change', resetFilter);
    all.addEventListener('click', () => {
        peerId = null;
        title.textContent = 'Room activity on this device';
        resetFilter();
    });
    pause.addEventListener('click', () => follow(pause.getAttribute('aria-pressed') === 'true'));
    text.addEventListener('select', () => {
        if (text.selectionStart !== text.selectionEnd) follow(false);
    });
    text.addEventListener('scroll', () => {
        if (text.scrollHeight - text.clientHeight - text.scrollTop > 4) follow(false);
    });
    copy.addEventListener('click', async () => {
        const selected = text.value.slice(text.selectionStart, text.selectionEnd);
        try {
            await window.asscrack.copyText(selected || text.value);
            status.textContent = selected ? 'Selection copied' : 'Diagnostics copied';
        } catch {
            status.textContent = 'Copy failed';
        }
    });
    document.getElementById('activity-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
        clearTimeout(timer);
        generation++;
        (opener.isConnected && opener.getClientRects().length > 0 ? opener : roomOptionsToggle).focus({ preventScroll: true });
    });
})();
