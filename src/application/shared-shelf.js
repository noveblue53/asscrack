(() => {
    const api = window.asscrack;
    const open = document.getElementById('openSharedShelf');
    if (!open || !api.refreshShelf) return;
    const dialog = document.getElementById('shared-shelf');
    const list = document.getElementById('shared-list');
    const empty = document.getElementById('shared-empty');
    const notice = document.getElementById('shared-notice');
    const share = document.getElementById('share-in-room');
    const picker = document.getElementById('shared-file');
    const transfers = document.getElementById('shared-transfers');
    const rows = new Map();
    let revision = -1;
    let showTransfers = false;

    function update(row) {
        const { own, available, state, name, publisher, peerId, size, reason } = row.data;
        row.name.textContent = name;
        row.info.textContent = `${formatSize(size)} · ${own ? 'You' : `${publisher} (${peerId.slice(-8)})`}`;
        const badges = { requesting: 'Requesting from source…', receiving: 'Downloading', saved: 'Saved',
            failed: reason || 'Download failed', cancelled: 'Cancelled' };
        row.state.textContent = badges[state] ?? (available ? 'Available' : 'Unavailable');
        if (!available && ['failed', 'cancelled'].includes(state)) row.state.textContent += ' · Source unavailable';
        const text = own ? 'Remove' : state === 'receiving' ? 'Cancel' : state === 'saved' ? 'Show in Explorer' :
            ['failed', 'cancelled'].includes(state) ? 'Retry' : 'Download';
        row.action.textContent = text;
        row.action.setAttribute('aria-label', `${text} ${name} ${own ? 'from Shared' : `from ${publisher} (${peerId.slice(-8)})`}`);
        row.action.disabled = row.busy || (!own && !(state === 'receiving' || state === 'saved' || (available && state !== 'requesting')));
    }

    async function act(row) {
        if (row.action.disabled) return;
        const { own, state, peerId, id, offerId } = row.data;
        row.busy = true;
        update(row);
        notice.textContent = '';
        try {
            if (own) await api.removeSharedFile(id);
            else if (state === 'receiving') {
                if (!await api.cancelFile(offerId)) notice.textContent = 'The download can no longer be cancelled.';
            } else if (state === 'saved') {
                if (!(await api.revealFile(`${offerId}|${peerId}`))?.ok) notice.textContent = 'The saved file was moved or deleted.';
            } else if (!await api.downloadSharedFile(peerId, id)) notice.textContent = 'The source is no longer available.';
        } catch { notice.textContent = 'The file action could not be completed.'; }
        finally { row.busy = false; update(row); }
    }

    function makeRow() {
        const item = document.createElement('li');
        const row = { item, name: document.createElement('span'), info: document.createElement('span'),
            state: document.createElement('span'), action: document.createElement('button') };
        row.name.className = 'shared-name';
        row.info.className = 'shared-info';
        row.state.className = 'shared-state';
        row.action.className = 'shared-action';
        row.action.type = 'button';
        row.action.addEventListener('click', () => act(row));
        item.append(row.name, row.info, row.state, row.action);
        list.append(item);
        return row;
    }

    function render(snapshot) {
        if (!snapshot || snapshot.revision < revision) return;
        revision = snapshot.revision;
        const current = new Set();
        for (const data of snapshot.items) {
            const key = `${data.peerId}|${data.id}`;
            current.add(key);
            const row = rows.get(key) ?? makeRow();
            rows.set(key, row);
            row.data = data;
            update(row);
        }
        for (const [key, row] of rows) {
            if (current.has(key)) continue;
            if (row.action === document.activeElement) share.focus({ preventScroll: true });
            row.item.remove();
            rows.delete(key);
        }
        empty.hidden = rows.size > 0;
        transfers.hidden = !snapshot.items.some(item => item.offerId);
    }

    open.addEventListener('click', async () => {
        document.getElementById('room-options')?.hidePopover();
        showTransfers = false;
        notice.textContent = '';
        dialog.showModal();
        try { render(await api.refreshShelf()); }
        catch { notice.textContent = 'Could not refresh the shared files.'; }
    });
    dialog.addEventListener('close', () => {
        if (showTransfers) {
            const button = document.getElementById('frame-transfers');
            if (button?.getAttribute('aria-expanded') === 'false') button.click();
            button?.focus();
        } else document.getElementById('room-options-toggle')?.focus();
    });
    transfers.addEventListener('click', () => { showTransfers = true; dialog.close(); });
    share.addEventListener('click', () => picker.click());
    picker.addEventListener('change', async () => {
        const file = picker.files[0];
        picker.value = '';
        if (!file || share.disabled) return;
        share.disabled = true;
        notice.textContent = `Preparing ${file.name}…`;
        try {
            await api.shareFile(file);
            notice.textContent = '';
        } catch (error) {
            const reason = error.message?.split('Error: ').at(-1);
            notice.textContent = reason || 'Could not share that file.';
        } finally {
            share.disabled = false;
            if (dialog.open && document.activeElement === document.body) share.focus();
        }
    });
    api.onShelf(render);
})();
