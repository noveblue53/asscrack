// A descriptor card is one chat message. Transfer progress and user actions stay keyed by the actual offer and peer.
(() => {
    const api = window.asscrack;
    const cards = new Map();
    const offers = new Map();
    const key = (source, id) => source + '|' + id;
    // Only archive rows ask the main process about a saved copy. Verify visible
    // files one at a time so reopening a long conversation never starts a batch of hashes.
    let verification = Promise.resolve();
    let savedRevision = 0;
    const observed = new WeakMap();
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        for (const item of entries) if (item.isIntersecting) {
            observer.unobserve(item.target);
            const card = observed.get(item.target);
            if (card) verifySaved(card);
        }
    }) : null;

    function verifySaved(card) {
        const revision = savedRevision;
        verification = verification.then(async () => {
            if (revision !== savedRevision) return;
            const saved = await api.savedOriginalAvailable(card.row.dataset.id, card.descriptor.id);
            if (revision === savedRevision) {
                card.local = saved === true;
                render(card);
            }
        }).catch(() => {});
    }

    function restoreSaved(lines) {
        for (const line of lines ?? []) {
            const d = line.attachment;
            if (!d) continue;
            const card = cards.get(key(d.source, d.id));
            if (!card || card.own || card.row.dataset.id !== line.id || observed.has(card.row)) continue;
            observed.set(card.row, card);
            if (observer) observer.observe(card.row);
            else verifySaved(card);
        }
    }

    function render(card) {
        const { descriptor: d, button } = card;
        const entry = offers.get(key(d.source, d.id));
        const match = entry?.data.sha256 === d.sha256 && entry.data.size === d.size && entry.data.name === d.name;
        const state = match ? entry.transfer.state : null;
        const saved = card.local || card.revealKey || (state === 'done' && entry.transfer.revealable);
        button.hidden = card.own;
        button.disabled = !saved && (Boolean(card.waiting) || d.expires <= Date.now() || !(state === 'offered' || card.available) || state === 'receiving');
        button.textContent = saved ? 'Show saved original' : state === 'receiving' ? 'Receiving original…' :
            card.waiting ? 'Requesting original…' : button.disabled ? 'Original unavailable' :
                state === 'failed' ? 'Retry original' : 'Download original';
    }
    function offer(data, transfer) {
        if (!data.attachmentId) return;
        const k = key(data.peerId, data.attachmentId);
        const card = cards.get(k);
        if (card && (card.descriptor.sha256 !== data.sha256 || card.descriptor.size !== data.size || card.descriptor.name !== data.name)) return;
        offers.set(k, { data, transfer });
        if (!card) return;
        const requested = card.waiting;
        card.waiting = null;
        render(card);
        if (requested && !card.button.disabled) card.button.click();
    }
    function decorate(row, descriptor, own) {
        if (!row || !descriptor || typeof descriptor.id !== 'string') return;
        const k = key(descriptor.source, descriptor.id);
        row.dataset.attachmentId = descriptor.id;
        const controls = document.createElement('span');
        controls.className = 'attachment-actions';
        const button = document.createElement('button');
        button.type = 'button';
        controls.append(button);
        row.append(controls);
        const card = { descriptor, row, button, own, available: false, waiting: null };
        cards.set(k, card);
        render(card);
        api.attachmentAvailable(descriptor).then(value => { card.available = value; render(card); }).catch(() => {});
        const remaining = descriptor.expires - Date.now();
        if (remaining > 0 && remaining <= 2147483647) setTimeout(() => render(card), remaining + 1);
        button.addEventListener('click', async () => {
            if (button.disabled) return;
            if (card.local) {
                const result = await api.revealSavedOriginal(row.dataset.id, descriptor.id).catch(() => ({ ok: false }));
                if (!result?.ok) {
                    card.local = false;
                    render(card);
                }
                return;
            }
            if (card.revealKey) {
                const result = await api.revealFile(card.revealKey).catch(() => null);
                if (!result?.ok) { card.revealKey = null; render(card); }
                return;
            }
            const entry = offers.get(k);
            if (entry && entry.data.sha256 === descriptor.sha256 && entry.data.size === descriptor.size && entry.data.name === descriptor.name) {
                const t = entry.transfer;
                const offerKey = key(entry.data.offerId, descriptor.source);
                if (t.state === 'done' && t.revealable) { await api.revealFile(offerKey); return; }
                if (t.state === 'offered') { await acceptTransfer(offerKey); render(card); return; }
            }
            const request = {};
            card.waiting = request;
            render(card);
            try {
                if (await api.requestOriginal(descriptor)) {
                    setTimeout(() => {
                        if (card.waiting !== request) return;
                        card.waiting = null;
                        render(card);
                    }, 10000);
                    return;
                }
            } catch {}
            if (card.waiting !== request) return;
            card.waiting = null;
            card.available = false;
            render(card);
        });
        window.chatMedia?.decorate(row, descriptor);
    }
    api.onAttachmentStatus(({ id, available, descriptor }) => {
        for (const card of cards.values()) if (card.descriptor.id === id && card.descriptor.source === descriptor?.source && card.descriptor.sha256 === descriptor.sha256) {
            card.available = available;
            if (!available) card.waiting = null;
            render(card);
        }
    });
    window.chatAttachments = {
        decorate, offer, restoreSaved,
        forgetOffer(data, transfer) {
            const k = key(data.peerId, data.attachmentId);
            if (offers.get(k)?.transfer !== transfer) return;
            offers.delete(k);
            const card = cards.get(k);
            if (card) {
                if (transfer.state === 'done' && transfer.revealable) card.revealKey = key(data.offerId, data.peerId);
                render(card);
            }
        },
        clearedSaved() {
            savedRevision++;
            observer?.disconnect();
            for (const card of cards.values()) {
                observed.delete(card.row);
                card.local = false;
                render(card);
            }
        },
        changed(data) {
            const card = data.attachmentId && cards.get(key(data.peerId, data.attachmentId));
            if (card) render(card);
        }
    };
})();
