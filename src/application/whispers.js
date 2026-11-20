// Private drafts and received lines only exist in this window's memory, indexed by full Peer ID.
(() => {
    const api = window.asscrack;
    const el = name => document.getElementById('whisper-' + name);
    const dialog = el('dialog'), picker = el('peer'), draft = el('draft'), send = el('send');
    const nav = el('open'), lines = el('lines'), status = el('status'), identity = el('identity');
    const threads = new Map(), capable = new Set();
    let selected = null, capabilityRevision = 0;

    function thread(id) {
        if (!threads.has(id)) threads.set(id, { name: '', draft: '', attempt: null, busy: false, note: '', rows: [], unread: 0, online: false });
        return threads.get(id);
    }

    function label(id) {
        const name = thread(id).name;
        return (name ? name + ' · ' : '') + id.slice(-10);
    }

    function choices() {
        const options = [];
        for (const [id, data] of threads) {
            if (!data.online && !data.draft && !data.rows.length && !data.busy && id !== selected) continue;
            const option = document.createElement('option');
            option.value = id;
            option.textContent = label(id) + (data.unread ? ' (' + data.unread + ')' : '');
            options.push(option);
        }
        picker.replaceChildren(...options);
        picker.value = selected || '';
        const unread = [...threads.values()].reduce((sum, data) => sum + data.unread, 0);
        nav.textContent = unread ? 'Whispers (' + unread + ')' : 'Whispers';
    }

    function controls() {
        const data = threads.get(selected);
        draft.disabled = !data;
        send.disabled = !data || !capable.has(selected) || data.busy || !data.draft.trim();
        if (!data) status.textContent = 'Select a buddy to start a private conversation.';
        else if (data.busy) status.textContent = 'Waiting for the recipient…';
        else if (!capable.has(selected)) status.textContent = 'Unavailable. A live, private-capable connection to this buddy is required. Drafts stay here.';
        else status.textContent = data.note || 'Private connection available.';
    }

    function show(id) {
        selected = id || null;
        const data = threads.get(selected);
        if (data && dialog.open) data.unread = 0;
        choices();
        identity.textContent = selected || '';
        if (draft.value !== (data?.draft || '')) draft.value = data?.draft || '';
        lines.replaceChildren();
        for (const row of data?.rows || []) {
            const li = document.createElement('li');
            li.dataset.id = row.id;
            li.dataset.direction = row.mine ? 'out' : 'in';
            li.textContent = (row.mine ? 'You (received by peer)' : data.name || label(id)) + ' — ' + row.text;
            lines.append(li);
        }
        lines.scrollTop = lines.scrollHeight;
        controls();
    }

    function open(id, messageId) {
        if (messageId && (!capable.has(id) || !threads.get(id)?.rows.some(row => row.id === messageId && !row.mine))) return false;
        if (id) thread(id);
        if (!dialog.open) dialog.showModal();
        show(id || selected || [...threads].find(([,data]) => data.unread)?.[0] || [...capable][0] || [...threads.keys()][0]);
        if (messageId) [...lines.children].find(li => li.dataset.id === messageId && li.dataset.direction === 'in')?.scrollIntoView({ block: 'center' });
        draft.focus();
        window.roomAttention?.viewChanged();
        return true;
    }

    function append(data, row) {
        data.rows.push(row);
        if (data.rows.length > 100) data.rows.shift();
    }

    async function submit() {
        const peer = selected, data = threads.get(peer);
        if (!data || !capable.has(peer) || data.busy || !data.draft.trim()) return;
        const text = data.draft;
        const id = data.attempt ||= crypto.randomUUID();
        data.busy = true;
        controls();
        let result;
        try { result = await api.sendWhisper(peer, text, id); }
        catch { result = 'unconfirmed'; }
        data.busy = false;
        if (result === 'received') {
            append(data, { id, text, mine: true });
            if (data.attempt === id) { data.draft = ''; data.attempt = null; }
            data.note = 'Received by peer.';
        } else {
            data.note = result === 'unavailable' ? 'Unavailable. Your draft stays here.' : 'Delivery unconfirmed. Your draft stays here.';
        }
        if (selected === peer) show(peer);
    }

    nav.addEventListener('click', () => open());
    picker.addEventListener('change', () => { show(picker.value); window.roomAttention?.viewChanged(); });
    draft.addEventListener('input', () => {
        const data = threads.get(selected);
        if (!data) return;
        data.draft = draft.value;
        data.attempt = null;
        data.note = '';
        controls();
    });
    send.addEventListener('click', submit);
    el('close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => window.roomAttention?.viewChanged());
    api.onPeerName(({peerId, name}) => {
        thread(peerId).name = name;
        if (dialog.open && selected === peerId) show(peerId);
        else choices();
    });
    api.onPeerJoined(({peerId}) => { thread(peerId).online = true; choices(); });
    api.onPeerLeft(({peerId}) => {
        const data = threads.get(peerId);
        if (data) {
            data.online = false;
            if (!data.rows.length && !data.draft && !data.busy && selected !== peerId) threads.delete(peerId);
        }
        capabilityRevision++;
        capable.delete(peerId);
        choices();
        controls();
    });
    api.onWhisperCapability(({peerId, available}) => {
        capabilityRevision++;
        if (available) { thread(peerId).online = true; capable.add(peerId); }
        else capable.delete(peerId);
        choices();
        controls();
    });
    api.onWhisper(({peerId, text, id}) => {
        const data = thread(peerId);
        append(data, { id, text, mine: false });
        if (dialog.open && selected === peerId) show(peerId);
        else if (!window.idlePeer?.isIdle()) { data.unread++; choices(); }
        window.roomAttention?.incoming({ kind: 'whisper', peerId, id });
    });
    window.whispers = {
        open, close: () => { if (dialog.open) dialog.close(); }, isOpen: () => dialog.open, isViewing: id => dialog.open && selected === id,
        async refresh() {
            const revision = capabilityRevision;
            const peers = await api.getWhisperPeers();
            if (capabilityRevision !== revision || !Array.isArray(peers)) return;
            capable.clear();
            for (const id of peers) { thread(id).online = true; capable.add(id); }
            choices();
            controls();
        }
    };
})();
