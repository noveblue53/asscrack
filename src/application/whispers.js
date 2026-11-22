// Private thread contents stay in window memory and are keyed by full peer ID.
(() => {
    const api = window.asscrack;
    const el = name => document.getElementById('whisper-' + name);
    const pane = el('pane'), picker = el('peer'), draft = el('draft'), send = el('send');
    const nav = el('open'), lines = el('lines'), status = el('status'), back = el('close');
    const threads = new Map(), capable = new Set();
    const whisperPrefix = /^\s*\/(?:w|msg|whisper)(?:\s|$)/i;
    let selected = null, capabilityRevision = 0, chooser = null;

    function thread(id) {
        if (!threads.has(id)) threads.set(id, { name: '', draft: '', attempt: null, busy: false, note: '', rows: [], unread: 0, online: false });
        return threads.get(id);
    }

    const fold = value => value.trim().toLowerCase();
    function label(id) {
        const name = threads.get(id)?.name;
        if (!name) return id;
        const duplicates = [...threads.entries()].filter(([, data]) => fold(data.name) === fold(name));
        if (duplicates.length < 2) return name;
        const suffix = id.slice(-10);
        const sharedSuffix = duplicates.some(([other]) => other !== id && other.endsWith(suffix));
        return name + ' · ' + (sharedSuffix ? id : suffix);
    }

    function retained(data) {
        return data.unread > 0 || Boolean(data.draft) || data.busy || data.rows.length > 0;
    }

    function refreshContacts() {
        const total = [...threads.values()].reduce((sum, data) => sum + data.unread, 0);
        nav.textContent = total ? 'Whispers (' + total + ')' : 'Whispers';
        nav.hidden = !total && ![...threads.values()].some(data => !data.online && retained(data));
        for (const row of document.getElementById('peers')?.children || []) {
            const unread = threads.get(row.dataset.peerId)?.unread;
            if (unread) row.dataset.whisperUnread = String(unread);
            else delete row.dataset.whisperUnread;
        }
        if (!chooser) return;
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose a buddy';
        const options = [placeholder];
        for (const [id, data] of threads) {
            if (chooser.ids && !chooser.ids.includes(id)) continue;
            if (!data.online && !retained(data)) continue;
            const option = document.createElement('option');
            option.value = id;
            option.textContent = label(id) + (data.unread ? ' (' + data.unread + ')' : '') + (data.online ? '' : ' · Offline');
            options.push(option);
        }
        picker.replaceChildren(...options);
        picker.value = '';
    }

    function controls() {
        const data = threads.get(selected);
        draft.disabled = !data;
        send.disabled = !data || data.busy || !data.draft.trim() || (!capable.has(selected) && !whisperPrefix.test(data.draft));
        if (!data) status.textContent = chooser?.note || '';
        else if (data.busy) status.textContent = 'Waiting for receipt…';
        else if (!data.online) status.textContent = 'Offline';
        else if (!capable.has(selected)) status.textContent = 'Whispers unavailable';
        else status.textContent = data.note;
        status.hidden = !status.textContent;
    }

    function render() {
        const data = threads.get(selected);
        el('picker').hidden = !chooser;
        el('title').textContent = data ? label(selected) : 'Whisper';
        draft.placeholder = data ? 'Whisper to ' + label(selected) : 'Private message';
        draft.setAttribute('aria-label', draft.placeholder);
        if (draft.value !== (data?.draft || '')) draft.value = data?.draft || '';
        lines.replaceChildren();
        for (const row of data?.rows || []) {
            const li = document.createElement('li');
            li.dataset.id = row.id;
            li.dataset.direction = row.mine ? 'out' : 'in';
            // Gap D2: the links are only in the text of the line, not in the name.
            const body = document.createElement('span');
            body.className = 'whisper-text';
            body.textContent = row.text;
            li.append((row.mine ? 'You' : data.name || label(selected)) + ' — ', body);
            window.chatLinks?.apply(body, { focusable: true });
            if (row.mine) li.setAttribute('aria-label', li.textContent + ', received by peer');
            lines.append(li);
        }
        lines.scrollTop = lines.scrollHeight;
        refreshContacts();
        controls();
    }

    function enter() {
        if (window.layout?.isDrawerOpen?.()) window.layout.closeTopLayer();
        if (document.body.classList.contains('map-open') && !document.body.classList.contains('layout-map-docked')) {
            document.getElementById('map-close')?.click();
        }
        if (!pane.hidden) return;
        window.findBar?.close();
        window.reading?.suspendForWhisper?.();
        window.typingUi?.channelChanged?.();
        const channelPicker = document.getElementById('channel-select');
        const channelLabel = channelPicker?.selectedOptions?.[0]?.textContent || '#general';
        back.textContent = '← ' + channelLabel;
        pane.hidden = false;
        document.body.classList.add('whisper-open');
    }

    function close() {
        if (pane.hidden) return;
        selected = null;
        chooser = null;
        pane.hidden = true;
        document.body.classList.remove('whisper-open');
        window.reading?.resumeFromWhisper?.();
        document.getElementById('message-input')?.focus();
        window.roomAttention?.viewChanged();
    }

    function choose(options = {}) {
        enter();
        selected = null;
        chooser = options;
        render();
        picker.focus();
        window.roomAttention?.viewChanged();
    }

    function open(id, messageId) {
        const data = threads.get(id);
        if (messageId && (!capable.has(id) || !data?.rows.some(row => row.id === messageId && !row.mine))) return false;
        if (!id) { choose(); return true; }
        thread(id);
        enter();
        chooser = null;
        selected = id;
        thread(id).unread = 0;
        render();
        if (messageId) [...lines.children].find(li => li.dataset.id === messageId && li.dataset.direction === 'in')?.scrollIntoView({ block: 'center' });
        draft.focus();
        window.roomAttention?.viewChanged();
        return true;
    }

    // /w <name or full peer ID> [draft]. Longest matching display name wins word boundaries;
    // an ambiguous abbreviation requires the user to choose an identity before any text moves.
    function command(raw, origin = null) {
        const match = /^\s*\/(?:w|msg|whisper)(?:\s+([\s\S]*))?$/i.exec(raw);
        if (!match) return false;
        const args = (match[1] || '').trimStart();
        if (!args.trim()) { choose(); return true; }
        const quoted = /^"([^"]+)"(?:\s+([\s\S]*)|$)/.exec(args);
        const word = /^\S+/.exec(args)[0];
        let ids = [], message = '';
        if (threads.has(word)) {
            ids = [word];
            message = args.slice(word.length).trimStart();
        } else {
            const names = [...threads.values()].map(data => data.name).filter(Boolean);
            const input = args.toLowerCase();
            const fullName = quoted?.[1] || names.filter(name => {
                const n = name.toLowerCase();
                return input.startsWith(n) && (!input[n.length] || /\s/.test(input[n.length]));
            }).sort((a, b) => b.length - a.length)[0];
            const term = fold(fullName || word);
            for (const [id, data] of threads) {
                const name = fold(data.name);
                if (fullName ? name === term : name.startsWith(term)) ids.push(id);
            }
            message = quoted ? quoted[2] || '' : args.slice((fullName || word).length).trimStart();
        }
        if (ids.length !== 1) {
            choose(ids.length ? { ids, raw, message, origin, note: 'Choose the intended buddy.' } : { note: 'No matching buddy.' });
            return false;
        }
        return openAddressed(ids[0], message, origin === ids[0] ? raw : null);
    }

    function openAddressed(id, message, replaceCommand = null) {
        const data = thread(id);
        const existingDraft = data.draft && data.draft !== replaceCommand;
        const oversize = draft.maxLength > 0 && message.length > draft.maxLength;
        if (message && (existingDraft || data.busy || oversize)) {
            open(id);
            data.note = oversize ? 'The message is too long.' : 'Finish or clear the existing draft first.';
            controls();
            return false;
        }
        if (message) {
            data.draft = message;
            data.attempt = null;
            data.note = '';
        }
        return open(id);
    }

    function append(data, row) {
        data.rows.push(row);
        if (data.rows.length > 100) data.rows.shift();
    }

    function clearCommand(origin, raw) {
        if (!origin) {
            const input = document.getElementById('message-input');
            if (input?.value === raw) input.value = '';
            return;
        }
        const data = threads.get(origin);
        if (data?.draft !== raw) return;
        data.draft = '';
        data.attempt = null;
        if (selected === origin) render();
    }

    async function submit() {
        const peer = selected, data = threads.get(peer);
        if (!data || data.busy || !data.draft.trim()) return;
        const text = data.draft;
        if (whisperPrefix.test(text)) {
            if (command(text, peer)) clearCommand(peer, text);
            return;
        }
        if (!capable.has(peer)) return;
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
            data.note = '';
        } else {
            data.note = result === 'unavailable' ? 'Unavailable. Draft kept.' : 'Delivery unconfirmed. Draft kept.';
        }
        if (selected === peer) render();
        else refreshContacts();
    }

    nav.addEventListener('click', () => open());
    back.addEventListener('click', close);
    picker.addEventListener('change', () => {
        const id = picker.value, pending = chooser;
        if (!id || !pending || !threads.has(id) || pending.ids && !pending.ids.includes(id)) return;
        const consumed = openAddressed(id, pending.message || '', pending.origin === id ? pending.raw : null);
        if (pending.raw && consumed) clearCommand(pending.origin, pending.raw);
    });
    draft.addEventListener('input', () => {
        const data = threads.get(selected);
        if (!data) return;
        data.draft = draft.value;
        data.attempt = null;
        data.note = '';
        controls();
    });
    draft.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void submit();
        }
    });
    send.addEventListener('click', submit);
    api.onPeerName(({ peerId, name }) => {
        thread(peerId).name = name;
        if (selected) el('title').textContent = label(selected);
        refreshContacts();
    });
    api.onPeerJoined(({ peerId }) => { thread(peerId).online = true; refreshContacts(); controls(); });
    api.onPeerLeft(({ peerId }) => {
        const data = threads.get(peerId);
        if (data) {
            data.online = false;
            if (!retained(data) && selected !== peerId) threads.delete(peerId);
        }
        capabilityRevision++;
        capable.delete(peerId);
        refreshContacts();
        controls();
    });
    api.onWhisperCapability(({ peerId, available }) => {
        capabilityRevision++;
        if (available) { thread(peerId).online = true; capable.add(peerId); }
        else capable.delete(peerId);
        refreshContacts();
        controls();
    });
    api.onWhisper(({ peerId, text, id }) => {
        const data = thread(peerId);
        append(data, { id, text, mine: false });
        if (selected === peerId && !pane.hidden) render();
        else if (!window.idlePeer?.isIdle()) { data.unread++; refreshContacts(); }
        window.roomAttention?.incoming({ kind: 'whisper', peerId, id });
    });
    window.whispers = {
        open, close, command, isOpen: () => !pane.hidden, isViewing: id => !pane.hidden && selected === id,
        async refresh() {
            const revision = capabilityRevision;
            const peers = await api.getWhisperPeers();
            if (capabilityRevision !== revision || !Array.isArray(peers)) return;
            capable.clear();
            for (const id of peers) { thread(id).online = true; capable.add(id); }
            refreshContacts();
            controls();
        }
    };
})();
