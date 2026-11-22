// G6: the voice channels of the room in the Buddies panel (#voice-channels). Classic script, after renderer.js.
// window.voiceChannelsCore: pure functions with no DOM (node:vm loads them in the tests).
// window.voiceChannels: the DOM part. renderer.js calls render() from updateVoiceView(), label() for the buddy line,
// and has() before a join. A click (or Enter) on a row joins or moves; menu.js gives the owner row menu.
(function () {
    'use strict';

    const GENERAL = 'general';
    const UNKNOWN = 'Unknown channel';

    // General first, then by name (with no case), then by ID.
    function sorted(channels) {
        const list = Array.isArray(channels) ? channels.filter(c => c && typeof c.id === 'string' && typeof c.name === 'string') : [];
        const general = list.find(c => c.id === GENERAL) ?? { id: GENERAL, name: 'General' };
        const named = list.filter(c => c.id !== GENERAL).sort((a, b) => {
            const x = a.name.toLowerCase();
            const y = b.name.toLowerCase();
            return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        return [general, ...named];
    }

    // The text after the voice state of a buddy line: '' when the room has only General.
    function label(channels, id) {
        if (!Array.isArray(channels) || channels.length < 2) return '';
        return channels.find(c => c.id === (id || GENERAL))?.name ?? UNKNOWN;
    }

    // people: [{ peerId, name, inVoice, channel, muted, deafened, speaking, self }]. own: the own channel in voice, or
    // null. Returns the rows: [{ id, name, mine, people }]. A channel ID that is not in the catalog gets its own row.
    function rows(channels, people, own) {
        const list = sorted(channels).map(c => ({ id: c.id, name: c.name, mine: c.id === own, people: [] }));
        for (const person of Array.isArray(people) ? people : []) {
            if (!person?.inVoice) continue;
            const id = person.channel || GENERAL;
            let row = list.find(r => r.id === id);
            if (!row) {
                row = { id, name: UNKNOWN, mine: id === own, people: [], unknown: true };
                list.push(row);
            }
            row.people.push({
                peerId: person.peerId, name: String(person.name ?? ''), self: person.self === true,
                state: person.deafened ? 'deafened' : person.muted ? 'muted' : '',
                // The speaking ring only in the own channel: this window gets no frames of a different channel.
                speaking: row.mine && person.speaking === true && !person.muted
            });
        }
        return list;
    }

    // The action of a click on a row: 'join' (not in voice), 'move' (a different channel) or 'none'.
    function action(inVoice, own, id) {
        if (!inVoice) return 'join';
        return own === id ? 'none' : 'move';
    }

    function deleteText(name, count) {
        const first = `Delete ${name}?`;
        if (count === 0) return first;
        if (count === 1) return `${first} 1 person moves to General.`;
        return `${first} ${count} people move to General.`;
    }

    const movedText = name => `${name} was deleted. You're in General.`;

    window.voiceChannelsCore = Object.freeze({ GENERAL, UNKNOWN, sorted, label, rows, action, deleteText, movedText });

    // ---- DOM part ----

    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const list = document.getElementById('voice-channel-list');
    if (!list) return;
    const api = window.asscrack;
    const createButton = document.getElementById('voice-channel-create');
    const dialog = document.getElementById('voice-channel-dialog');
    const form = document.getElementById('voice-channel-form');
    const nameInput = document.getElementById('voice-channel-name');
    const dialogTitle = document.getElementById('voice-channel-title');
    const dialogSubmit = document.getElementById('voice-channel-submit');
    const dialogError = document.getElementById('voice-channel-error');
    const deleteDialog = document.getElementById('voice-channel-delete-dialog');
    const deleteQuestion = document.getElementById('voice-channel-delete-text');
    const deleteError = document.getElementById('voice-channel-delete-error');

    let view = { owner: false, editable: false, seq: 0, channels: [{ id: GENERAL, name: 'General' }] };
    // The last input of render(): { inVoice, channel, people }.
    let model = { inVoice: false, channel: GENERAL, people: [] };
    let last = [];
    let revision = 0;
    // The channel of the open dialog (null: Create).
    let editing = null;
    let deleting = null;
    const items = new Map();

    const text = value => (value instanceof Error ? value.message : String(value?.message ?? value ?? ''));
    function errorOf(err) {
        // The IPC error has the form "Error invoking remote method '...': Error: <text>".
        return text(err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
    }

    function makeItem(id) {
        const li = document.createElement('li');
        li.className = 'voice-channel';
        li.dataset.channelId = id;
        const head = document.createElement('div');
        head.className = 'vc-row';
        const mark = document.createElement('span');
        mark.className = 'vc-mark';
        mark.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'vc-name';
        const you = document.createElement('span');
        you.className = 'vc-you';
        you.textContent = '(you)';
        you.hidden = true;
        const count = document.createElement('span');
        count.className = 'vc-count';
        head.append(mark, name, you, count);
        const people = document.createElement('ul');
        people.className = 'vc-people';
        li.append(head, people);
        const item = { li, name, you, count, people, key: '' };
        items.set(id, item);
        return item;
    }

    function setText(el, value) {
        if (el.textContent !== value) el.textContent = value;
    }

    function drawPeople(item, row) {
        const key = JSON.stringify(row.people);
        if (item.key === key) return;
        item.key = key;
        item.people.replaceChildren(...row.people.map(person => {
            const li = document.createElement('li');
            li.className = person.speaking ? 'vc-person speaking' : 'vc-person';
            li.dataset.peerId = String(person.peerId ?? '');
            const name = document.createElement('span');
            name.className = 'vc-person-name';
            name.textContent = person.self ? `${person.name} (you)` : person.name;
            li.append(name);
            if (person.state) {
                const state = document.createElement('span');
                state.className = 'vc-person-state';
                state.textContent = person.state;
                li.append(state);
            }
            return li;
        }));
    }

    function draw() {
        const own = model.inVoice ? model.channel : null;
        last = rows(view.channels, model.people, own);
        const wanted = new Set(last.map(r => r.id));
        for (const [id, item] of items) {
            if (wanted.has(id)) continue;
            item.li.remove();
            items.delete(id);
        }
        let before = list.firstElementChild ?? list.children[0] ?? null;
        for (const row of last) {
            const item = items.get(row.id) ?? makeItem(row.id);
            setText(item.name, row.name);
            setText(item.count, String(row.people.length));
            item.you.hidden = !row.mine;
            if (row.mine) {
                if (item.li.getAttribute('aria-current') !== 'true') item.li.setAttribute('aria-current', 'true');
            } else if (item.li.hasAttribute('aria-current')) item.li.removeAttribute('aria-current');
            const tip = `${row.name}: ${row.people.length === 1 ? '1 person' : `${row.people.length} people`}`;
            if (item.li.title !== tip) item.li.title = tip;
            drawPeople(item, row);
            // Keep the order with no new insert when the row is in its place (an open row menu stays open).
            if (item.li !== before) list.insertBefore(item.li, before);
            before = item.li.nextElementSibling ?? null;
        }
        if (createButton) createButton.hidden = !view.editable;
    }

    function update(next) {
        if (!Array.isArray(next?.channels)) return;
        view = { owner: next.owner === true, editable: next.editable === true, seq: Number(next.seq) || 0,
            channels: next.channels.map(c => ({ id: String(c.id), name: String(c.name) })) };
        draw();
        if (deleting && !view.channels.some(c => c.id === deleting)) deleteDialog?.close();
        if (editing && !view.channels.some(c => c.id === editing)) dialog?.close();
    }

    async function refresh() {
        const version = revision;
        try {
            const next = await api.getVoiceChannels?.();
            if (version === revision) update(next);
        } catch (err) {
            console.warn('Voice channels not read:', errorOf(err));
        }
    }

    function rowOf(target) {
        const li = target?.closest?.('li.voice-channel');
        return li && li.parentElement === list ? li : null;
    }

    function choose(id) {
        const kind = action(model.inVoice, model.channel, id);
        if (kind === 'join') return joinVoice(id);
        if (kind === 'move') return moveVoice(id);
        return undefined;
    }

    list.addEventListener('click', event => {
        const li = rowOf(event.target);
        if (li) void choose(li.dataset.channelId);
    });
    list.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const li = rowOf(event.target);
        if (!li || event.target !== li) return;
        event.preventDefault();
        void choose(li.dataset.channelId);
    });

    function openDialog(id) {
        editing = id;
        const row = id ? view.channels.find(c => c.id === id) : null;
        dialogTitle.textContent = row ? 'Rename voice channel' : 'Create voice channel';
        dialogSubmit.textContent = row ? 'Rename' : 'Create';
        nameInput.value = row ? row.name : '';
        dialogError.textContent = '';
        dialog.showModal();
        nameInput.focus();
    }

    createButton?.addEventListener('click', () => openDialog(null));
    document.getElementById('voice-channel-cancel')?.addEventListener('click', () => dialog.close());
    dialog?.addEventListener('close', () => {
        editing = null;
        if (document.activeElement === document.body || !document.activeElement) createButton?.focus?.();
    });
    form?.addEventListener('submit', async event => {
        event.preventDefault();
        const id = editing;
        try {
            if (id) await api.renameVoiceChannel(id, nameInput.value);
            else await api.createVoiceChannel(nameInput.value);
            dialog.close();
            await refresh();
        } catch (err) {
            dialogError.textContent = errorOf(err);
            nameInput.focus();
        }
    });

    function openDelete(id) {
        const row = last.find(r => r.id === id);
        if (!row || id === GENERAL) return false;
        deleting = id;
        deleteQuestion.textContent = deleteText(row.name, row.people.length);
        deleteError.textContent = '';
        deleteDialog.showModal();
        document.getElementById('voice-channel-delete-cancel')?.focus();
        return true;
    }
    document.getElementById('voice-channel-delete-cancel')?.addEventListener('click', () => deleteDialog.close());
    deleteDialog?.addEventListener('close', () => { deleting = null; });
    document.getElementById('voice-channel-delete-confirm')?.addEventListener('click', async () => {
        const id = deleting;
        if (!id) return;
        try {
            await api.deleteVoiceChannel(id);
            deleteDialog.close();
            await refresh();
        } catch (err) {
            deleteError.textContent = errorOf(err);
        }
    });

    api.onVoiceChannels?.(next => {
        revision++;
        update(next);
        if (next?.movedFrom) voiceChannelMoved(next.movedFrom);
    });

    window.voiceChannels = Object.freeze({
        start: refresh,
        // From updateVoiceView(): { inVoice, channel, people }.
        render(next) {
            model = { inVoice: next?.inVoice === true, channel: next?.channel || GENERAL,
                people: Array.isArray(next?.people) ? next.people : [] };
            draw();
        },
        label: id => label(view.channels, id),
        has: id => view.channels.some(c => c.id === id),
        name: id => view.channels.find(c => c.id === id)?.name ?? UNKNOWN,
        count: () => view.channels.length,
        movedText,
        // For menu.js (through roomActions): the data of a row, and the two owner actions.
        rowInfo: li => (li?.parentElement === list
            ? { kind: 'voice-channel', id: li.dataset.channelId, owner: view.editable && li.dataset.channelId !== GENERAL
                && view.channels.some(c => c.id === li.dataset.channelId) }
            : null),
        rename: li => {
            const id = li?.dataset.channelId;
            if (!id || id === GENERAL || !view.editable) return false;
            openDialog(id);
            return true;
        },
        remove: li => view.editable && openDelete(li?.dataset.channelId)
    });
})();
