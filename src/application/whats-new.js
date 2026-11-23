// What's new: the release notes in the window (release-notes.json through the main process, release-notes.mjs).
// - The dialog "What's new" (View menu, the About button, the card button): all versions, newest first.
// - The card after an update: "What's new in <version>", one time for each version. It is not modal and takes no
//   focus. The main process saves the version at the start, thus the card does not come again after a restart.
// Plain text only (textContent). It works offline: the notes are in the app.
// API: window.whatsNew = { open() }.
(function () {
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const dialog = byId('whats-new-dialog');
    const card = byId('whats-new-card');
    if (!api?.getWhatsNew || !dialog) return;
    let state = null;

    async function load() {
        if (state) return state;
        try {
            const value = await api.getWhatsNew();
            state = { current: value?.current ?? '', entries: Array.isArray(value?.entries) ? value.entries : [],
                pending: typeof value?.pending === 'string' ? value.pending : null };
        } catch {
            state = null;
        }
        return state;
    }

    // The blocks of one entry: "- " blocks become one list, other blocks a paragraph.
    function notesNodes(entry) {
        const nodes = [];
        let list = null;
        for (const block of Array.isArray(entry?.notes) ? entry.notes : []) {
            if (typeof block !== 'string') continue;
            if (block.startsWith('- ')) {
                if (!list) { list = document.createElement('ul'); nodes.push(list); }
                const item = document.createElement('li');
                item.textContent = block.slice(2);
                list.appendChild(item);
            } else {
                list = null;
                const p = document.createElement('p');
                p.textContent = block;
                nodes.push(p);
            }
        }
        return nodes;
    }

    function renderList() {
        const box = byId('whats-new-list');
        const items = [];
        for (const entry of state?.entries ?? []) {
            const section = document.createElement('section');
            section.className = 'whats-new-entry';
            const heading = document.createElement('h3');
            heading.textContent = entry.version;
            const date = document.createElement('span');
            date.className = 'whats-new-date';
            date.textContent = entry.date ?? '';
            heading.append(' ', date);
            section.append(heading, ...notesNodes(entry));
            items.push(section);
        }
        box.replaceChildren(...items);
        byId('whats-new-empty').hidden = items.length > 0;
    }

    async function open() {
        if (dialog.open) return;
        await load();
        renderList();
        if (!dialog.open) dialog.showModal();
        byId('whats-new-list').scrollTop = 0;
    }

    function closeCard() {
        if (!card || card.hidden) return;
        card.hidden = true;
        if (state) state.pending = null;
        api.whatsNewDone?.().catch?.(() => {});
    }

    async function showCard() {
        await load();
        const entry = state?.pending ? state.entries.find(e => e?.version === state.pending) : null;
        if (!card || !entry) return;
        byId('whats-new-card-title').textContent = `What's new in ${entry.version}`;
        byId('whats-new-card-notes').replaceChildren(...notesNodes(entry));
        card.hidden = false;
    }

    byId('whats-new-card-all')?.addEventListener('click', () => { void open(); });
    byId('whats-new-card-close')?.addEventListener('click', closeCard);
    byId('about-whats-new')?.addEventListener('click', () => { void open(); });

    window.whatsNew = { open };
    void showCard();
})();
