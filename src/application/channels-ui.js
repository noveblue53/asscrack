// Each public conversation keeps its own rows, draft and reading position. General also holds room file offers.
(() => {
    const picker = document.getElementById('channel-select');
    if (!picker) return;
    const add = document.getElementById('channel-add');
    const dialog = document.getElementById('channel-dialog');
    const nameInput = document.getElementById('channel-name');
    const note = document.getElementById('channel-note');
    const states = new Map();
    let selected = 'general';
    let catalog = [{ id: selected, name: 'General' }];
    let available = false;
    let revision = 0;
    function state(id) {
        if (!states.has(id)) states.set(id, { list: document.createElement('ul'), draft: '', quote: null, missed: 0 });
        return states.get(id);
    }
    function refresh() {
        const counts = new Map();
        for (const { name } of catalog) counts.set(name, (counts.get(name) || 0) + 1);
        picker.replaceChildren(...catalog.map(({ id, name }) => {
            const option = document.createElement('option');
            option.value = id;
            const suffix = counts.get(name) > 1 ? ' · ' + id.slice(-6) : '';
            const missed = state(id).missed;
            option.textContent = name + suffix + (missed ? ' (' + missed + ' unread)' : '');
            return option;
        }));
        picker.value = selected;
        add.disabled = !available;
        sendButton.disabled = selected !== 'general' && !available;
        note.hidden = !sendButton.disabled;
    }
    function update(snapshot) {
        if (!Array.isArray(snapshot?.channels)) return;
        available = snapshot.available;
        catalog = snapshot.channels;
        refresh();
    }
    function open(id = 'general') {
        if (!catalog.some(row => row.id === id)) return false;
        if (id === selected) return true;
        window.findBar?.close();
        const old = state(selected);
        old.draft = messageInput.value;
        old.quote = pendingQuote;
        old.file = pendingFile;
        old.fileRecipient = fileRecipient.value;
        old.reading = window.reading.leaveChannel();
        old.older = messageList.dataset.older;
        old.list.replaceChildren(...messageList.children);
        selected = id;
        const next = state(id);
        messageList.replaceChildren(...next.list.children);
        messageInput.value = next.draft;
        setQuote(next.quote);
        pendingFile = next.file ?? null;
        refreshFileRecipients(next.fileRecipient ?? 'room');
        updateFileDraft();
        next.missed = 0;
        messageList.dataset.older = next.older || 'none';
        window.reading.enterChannel(next.reading);
        window.savedRoomsUi?.channelOpened?.(id);
        window.typingUi?.channelChanged?.();
        window.chatHighlights?.updateCount?.();
        window.roomAttention?.viewChanged?.();
        refresh();
        return true;
    }
    picker.addEventListener('change', () => open(picker.value));
    add.addEventListener('click', () => { nameInput.value = ''; document.getElementById('channel-error').textContent = ''; dialog.showModal(); nameInput.focus(); });
    document.getElementById('channel-cancel').addEventListener('click', () => dialog.close());
    document.getElementById('channel-create-form').addEventListener('submit', async e => {
        e.preventDefault();
        try {
            const id = await window.asscrack.createChannel(nameInput.value);
            const version = revision;
            const snapshot = await window.asscrack.getChannels();
            if (version === revision) update(snapshot);
            dialog.close();
            open(id);
            messageInput.focus();
        } catch (err) {
            document.getElementById('channel-error').textContent = err.message;
            nameInput.focus();
        }
    });
    window.asscrack.onChannels(snapshot => { revision++; update(snapshot); });
    window.roomChannels = {
        open, active: () => selected, isViewing: (id = 'general') => selected === id,
        listFor: (id = 'general') => id === selected ? messageList : state(id).list,
        setOlder(id, value) {
            state(id).older = value;
            if (id === selected) messageList.dataset.older = value;
        },
        clearOlder() {
            for (const s of states.values()) s.older = 'none';
            messageList.dataset.older = 'none';
        },
        storedLists: () => [...states.values()].map(s => s.list),
        missed(id = 'general') { if (id !== selected) { state(id).missed++; refresh(); } },
        fileSent(id, file) {
            const s = state(id);
            if (s.file === file) s.file = null;
        },
        sent(id, draft, quote) {
            if (id === selected) return;
            const s = state(id);
            if (s.draft === draft) s.draft = '';
            if (s.quote === quote) s.quote = null;
        },
        async start() {
            const version = revision;
            const snapshot = await window.asscrack.getChannels();
            if (version === revision) update(snapshot);
        }
    };
})();
