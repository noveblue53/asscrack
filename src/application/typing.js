// Transient state is keyed by the authenticated peer ID, including buddies with the same name.
(() => {
    const api = window.asscrack;
    const line = document.getElementById('typing-status');
    const option = document.getElementById('view-typing');
    const active = new Set();
    let enabled = false;
    let busy = true;

    function render() {
        const ids = !window.roomChannels || window.roomChannels.isViewing('general') ? [...active] : [];
        const names = ids.map(id => peerNames.get(id) || id.slice(-8));
        let text = '';
        if (ids.length === 1) text = names[0] + ' is typing…';
        if (ids.length === 2) {
            const labels = names[0] === names[1] ? names.map((name, i) => name + ' (' + ids[i].slice(-6) + ')') : names;
            text = labels.join(' and ') + ' are typing…';
        }
        if (ids.length > 2) text = ids.length + ' people are typing…';
        if (line.textContent !== text) line.textContent = text;
    }

    function setEnabled(value) {
        enabled = value === true;
        option.setAttribute('aria-checked', String(enabled));
    }

    window.typingUi = {
        channelChanged() {
            if (enabled) api.typingEdit(false);
            render();
        },
        async toggleShare() {
            if (busy) return;
            busy = true;
            const next = !enabled;
            setEnabled(next);
            try {
                setEnabled(await api.setShareTyping(next));
            } catch {
                setEnabled(false);
                status.textContent = 'Couldn\'t save. Typing status is off.';
            } finally {
                busy = false;
            }
        }
    };

    api.getShareTyping().then(setEnabled).catch(() => setEnabled(false)).finally(() => { busy = false; });
    messageInput.addEventListener('input', () => {
        if (!enabled || !peerItems.size || (window.roomChannels && !window.roomChannels.isViewing('general'))) return;
        const draft = messageInput.value.trimStart();
        api.typingEdit(draft.length > 0 && !draft.startsWith('/'));
    });
    api.onTyping(({ peerId, active: on }) => {
        if (on && peerItems.has(peerId)) active.add(peerId);
        else active.delete(peerId);
        render();
    });
    api.onPeerName(({ peerId }) => { if (active.has(peerId)) render(); });
    api.onPeerLeft(({ peerId }) => { if (active.delete(peerId)) render(); });
})();
