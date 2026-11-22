// Saved rooms (milestone 6): the window part. A classic script. It loads after renderer.js and uses its functions
// (showChat, roomStarted, addMessage, insertMessage, status, loginButton, roomTypeSelect, peerItems, internetRoom,
// messageList, savedMessageIds, noteSaved, clearSavedMarks, hasContentRows, roomRole).
(function () {
    const api = window.asscrack;
    if (!api || typeof api.listSavedRooms !== 'function') return;

    const saveRoomBox = document.getElementById('save-room');
    const keepHistoryBox = document.getElementById('keep-history');
    const saveFields = document.getElementById('save-room-fields');
    const saveOffNote = document.getElementById('save-off-note');
    const savedList = document.getElementById('saved-rooms');
    const savedSection = document.getElementById('saved-rooms-section');
    const archiveState = document.getElementById('archive-state');
    const archiveUnlock = document.getElementById('archive-unlock');
    const roomStorage = document.getElementById('room-storage');
    const historyToggle = document.getElementById('history-toggle');
    const roomKeepHistory = document.getElementById('room-keep-history');
    const historyState = document.getElementById('history-state');
    const clearButton = document.getElementById('clear-history');
    const clearConfirm = document.getElementById('clear-confirm');
    const clearYes = document.getElementById('clear-confirm-yes');
    const clearNo = document.getElementById('clear-confirm-no');

    const FIRST_PAGE = 200;
    const OLDER_PAGE = 100;
    const FORGET_TEXT = 'Forget this room? Its messages and invite are deleted from this PC. You\'ll need a new invite to rejoin.';

    let archiveOpen = false;
    let reopenBusy = false;
    // The names of the saved rooms, in lower case (gap N9: Create with the name of a saved room).
    let savedNames = new Set();
    const STARTING_TEXT = 'Starting the room\u2026';
    // The saved room that is open in the chat screen: its roomId, or null.
    let openRoomId = null;
    // The roomId whose saved lines are shown (reopen or login).
    let linesLoadedFor = null;
    const loadedPages = new Set();
    let olderBusy = false;
    const archiveChanges = new Map();
    // The error text for the user (errorText of renderer.js). A test can load this file without renderer.js.
    const errText = err => (typeof errorText === 'function' ? errorText(err) : String(err?.message ?? err));

    async function deleteSavedData(roomId, action) {
        const change = { pending: true };
        archiveChanges.set(roomId, change);
        try {
            return await action(roomId);
        } finally {
            change.pending = false;
        }
    }

    // "Save room on this device" is on by default for the two Create types and off for Join (operator decision
    // 2026-11-21). The default applies when the kind of type changes or the archive opens, so a list refresh does
    // not tick a box again that the user unticked.
    let saveDefaultFor = null;
    function showSaveFields() {
        saveFields.hidden = false;
        saveRoomBox.disabled = !archiveOpen;
        const kind = roomTypeSelect.value === 'join' ? 'join' : 'create';
        if (!archiveOpen) {
            saveRoomBox.checked = false;
            saveDefaultFor = null;
        } else if (saveDefaultFor !== kind) {
            saveRoomBox.checked = kind === 'create';
            saveDefaultFor = kind;
        }
        showSaveNote();
    }
    // Gap N9: a created room that is not saved is gone at quit.
    function showSaveNote() {
        if (saveOffNote) saveOffNote.hidden = roomTypeSelect.value === 'join' || saveRoomBox.checked;
    }
    roomTypeSelect.addEventListener('change', showSaveFields);
    saveRoomBox.addEventListener('change', showSaveNote);

    function stateText(result) {
        if (result.state === 'unavailable') {
            return 'Can\'t save rooms: secure storage is unavailable.';
        }
        // One data folder: a copy of the folder on an other computer or for an other Windows user cannot open the
        // protected key (safeStorage).
        if (result.reason === 'key-unwrap-failed') {
            return 'Saved rooms are locked. This data folder belongs to another Windows account or PC.';
        }
        return `Saved rooms are locked (${result.reason ?? 'unknown'})`;
    }

    function showRooms(rooms) {
        savedList.replaceChildren();
        savedNames = new Set(rooms.map(room => String(room.name ?? '').trim().toLowerCase()).filter(Boolean));
        for (const room of rooms) {
            const item = document.createElement('li');
            item.className = 'saved-room';
            item.dataset.roomId = String(room.roomId);
            const name = document.createElement('span');
            name.className = 'saved-room-name';
            name.textContent = String(room.name ?? '');
            const user = document.createElement('span');
            user.className = 'saved-room-user';
            user.textContent = String(room.userName ?? '');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'reopen-room';
            button.textContent = 'Reopen room';
            if (room.protected) button.addEventListener('click', () => reopen(room, false, button));
            // UI copy pass: an old shared-code room has a tag, not the word "legacy" on the button.
            const tag = document.createElement('span');
            tag.className = 'state-tag old-code-tag';
            tag.textContent = 'Old code';
            tag.title = 'Anyone with the code can join';
            if (!room.protected) name.append(' ', tag);
            item.append(name, user, button, ...(room.protected ? [] : legacyControls(room, button)),
                ...nameControls(room, user), ...forgetControls(room, item));
            savedList.appendChild(item);
        }
        savedSection.hidden = rooms.length === 0;
    }

    function legacyControls(room, button) {
        const row = document.createElement('div');
        row.className = 'forget-confirm legacy-reopen';
        row.hidden = true;
        const text = document.createElement('p');
        text.textContent = 'Anyone with this code can join. Open anyway?';
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.textContent = 'Open';
        const no = document.createElement('button');
        no.type = 'button';
        no.textContent = 'Cancel';
        row.append(text, yes, no);
        button.addEventListener('click', () => { row.hidden = false; no.focus(); });
        no.addEventListener('click', () => { row.hidden = true; button.focus(); });
        yes.addEventListener('click', () => { row.hidden = true; void reopen(room, true, button); });
        return [row];
    }

    // Gap A6: change the user name of a saved room. The next reopen uses the new name.
    function nameControls(room, user) {
        const change = document.createElement('button');
        change.type = 'button';
        change.className = 'rename-room';
        change.textContent = 'Change name';
        const form = document.createElement('div');
        form.className = 'rename-form';
        form.hidden = true;
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 64;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', `Your name in ${String(room.name ?? 'this room')}`);
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'rename-save';
        save.textContent = 'Save';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'rename-cancel';
        cancel.textContent = 'Cancel';
        form.append(input, save, cancel);
        const close = () => {
            form.hidden = true;
            change.hidden = false;
            change.focus();
        };
        change.addEventListener('click', () => {
            input.value = String(room.userName ?? '');
            form.hidden = false;
            change.hidden = true;
            input.focus();
        });
        cancel.addEventListener('click', close);
        const submit = async () => {
            const value = input.value.trim();
            if (!value || value.length > 64) {
                showStatusError('Enter a name (up to 64 characters).');
                input.focus();
                return;
            }
            save.disabled = cancel.disabled = true;
            try {
                const result = await api.setSavedRoomName(room.roomId, value);
                room.userName = typeof result?.userName === 'string' ? result.userName : value;
                user.textContent = room.userName;
                status.textContent = '';
                close();
            } catch (err) {
                showStatusError(`Name not changed: ${errText(err)}`);
            } finally {
                save.disabled = cancel.disabled = false;
            }
        };
        save.addEventListener('click', submit);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                void submit();
            }
        });
        return [change, form];
    }

    // Forget (decision P7): only on the login screen, with a confirmation.
    function forgetControls(room, item) {
        const forget = document.createElement('button');
        forget.type = 'button';
        forget.className = 'forget-room';
        forget.textContent = 'Forget room';
        const confirm = document.createElement('div');
        confirm.className = 'forget-confirm';
        confirm.setAttribute('role', 'alertdialog');
        confirm.hidden = true;
        const text = document.createElement('p');
        text.textContent = FORGET_TEXT;
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.className = 'forget-yes';
        yes.textContent = 'Forget room';
        const no = document.createElement('button');
        no.type = 'button';
        no.className = 'forget-no';
        no.textContent = 'Cancel';
        confirm.append(text, yes, no);
        forget.addEventListener('click', () => {
            confirm.hidden = false;
            no.focus();
        });
        no.addEventListener('click', () => {
            confirm.hidden = true;
            forget.focus();
        });
        yes.addEventListener('click', async () => {
            yes.disabled = true;
            no.disabled = true;
            try {
                await deleteSavedData(room.roomId, api.forgetRoom);
                item.remove();
                await refresh(() => api.listSavedRooms());
            } catch (err) {
                showStatusError(`Couldn't forget the room: ${errText(err)}`);
                yes.disabled = false;
                no.disabled = false;
            }
        });
        return [forget, confirm];
    }

    function showState(result) {
        archiveOpen = result?.state === 'open';
        archiveState.hidden = archiveOpen;
        archiveUnlock.hidden = archiveOpen;
        if (!archiveOpen) archiveState.textContent = stateText(result ?? { state: 'locked', reason: 'unknown' });
        showRooms(Array.isArray(result?.rooms) ? result.rooms : []);
        showSaveFields();
    }

    async function refresh(call) {
        try {
            showState(await call());
        } catch (err) {
            showState({ state: 'locked', reason: err?.message ?? String(err), rooms: [] });
        }
    }

    archiveUnlock.addEventListener('click', () => refresh(() => api.unlockArchive()));

    // A concurrent Clear or Forget invalidates any page the main process already read.
    async function readLines(roomId, before = null, channelId = 'general') {
        const change = archiveChanges.get(roomId);
        if (change?.pending) return null;
        try {
            const lines = await api.savedRoomLines(roomId, channelId === 'general' && !before ? undefined : { ...(before ? {before} : {}), ...(channelId !== 'general' ? {channelId} : {}) });
            if (change !== archiveChanges.get(roomId)) return null;
            return Array.isArray(lines) ? lines : [];
        } catch (err) {
            console.warn(`Saved lines not read: ${err?.message ?? err}`);
            return null;
        }
    }

    function setOlder(value) {
        messageList.dataset.older = value;
    }

    // Saved lines after a login into a saved room. Lines with an ID that is shown do not come again.
    async function loadAfterLogin(roomId, channelId = 'general') {
        const pageKey = roomId + '/' + channelId;
        if (loadedPages.has(pageKey)) return;
        loadedPages.add(pageKey);
        const lines = await readLines(roomId, null, channelId);
        if (!lines || openRoomId !== roomId) {
            loadedPages.delete(pageKey);
            return;
        }
        linesLoadedFor = roomId;
        for (const line of lines) if (line.id) savedMessageIds.add(String(line.id));
        const fresh = window.readingCore.newHistoryLines(lines, id => {
            if (!shownMessageIds.has(id)) return false;
            noteSaved(id);
            return true;
        });
        // Note rows (transcript-notes.js) do not count: a list with only note rows is empty.
        const empty = !hasContentRows(messageList);
        const insertPage = () => {
            for (const line of fresh) insertMessage(line.from, line.text, line.time, line.id, line.own === true, line.channelId, line.attachment);
        };
        const visible = !window.roomChannels || window.roomChannels.isViewing(channelId);
        if (visible) window.reading.keepPosition(insertPage);
        else insertPage();
        window.chatAttachments?.restoreSaved(lines);
        if (visible && empty) window.reading.followLatest();
        const older = lines.length >= FIRST_PAGE ? 'more' : 'none';
        if (window.roomChannels) window.roomChannels.setOlder(channelId, older);
        else setOlder(older);
    }

    // Paging: at the top of the list, load the older page and put it above the first line.
    async function loadOlder() {
        if (olderBusy || !openRoomId || messageList.dataset.older !== 'more') return;
        let first = null;
        for (const li of messageList.children) {
            if (li.dataset.id) {
                first = li;
                break;
            }
        }
        if (!first) return;
        olderBusy = true;
        try {
            const roomId = openRoomId;
            const channelId = window.roomChannels?.active() ?? 'general';
            const lines = await readLines(roomId, { time: Number(first.dataset.time) || 0, id: first.dataset.id }, channelId);
            if (!lines || roomId !== openRoomId) return;
            for (const line of lines) if (line.id) savedMessageIds.add(String(line.id));
            const insertPage = () => {
                for (const line of lines) insertMessage(line.from, line.text, line.time, line.id, line.own === true, line.channelId, line.attachment);
            };
            if (!window.roomChannels || window.roomChannels.isViewing(channelId)) window.reading.keepPosition(insertPage);
            else insertPage();
            window.chatAttachments?.restoreSaved(lines);
            const older = lines.length >= OLDER_PAGE ? 'more' : 'none';
            if (window.roomChannels) window.roomChannels.setOlder(channelId, older);
            else setOlder(older);
        } finally {
            olderBusy = false;
        }
    }

    messageList.addEventListener('scroll', () => {
        if (messageList.scrollTop <= 4) loadOlder();
    }, { passive: true });

    // ---- Room storage controls (chat screen) ----

    function showKeepState(keep) {
        roomKeepHistory.checked = keep === true;
        // U12: the checkbox shows the state. #history-state shows only a save failure.
        historyState.textContent = '';
    }

    function showStorage(result) {
        const saved = typeof result?.roomId === 'string' && result.roomId !== '' && result.savedRoom === true;
        openRoomId = saved ? result.roomId : null;
        roomStorage.hidden = !saved;
        historyToggle.hidden = !saved;
        clearConfirm.hidden = true;
        if (!saved) return;
        showKeepState(result.keepHistory !== false);
        if (!messageList.dataset.older) setOlder('more');
    }

    roomStorage.addEventListener('toggle', event => {
        if (event.newState === 'closed') clearConfirm.hidden = true;
    });
    roomKeepHistory.addEventListener('change', async () => {
        if (!openRoomId) return;
        const want = roomKeepHistory.checked;
        roomKeepHistory.disabled = true;
        try {
            const result = await api.setKeepHistory(openRoomId, want);
            showKeepState(result?.keepHistory === true);
        } catch (err) {
            showKeepState(!want);
            showStatusError(`Couldn't change this: ${errText(err)}`);
        } finally {
            roomKeepHistory.disabled = false;
        }
    });

    clearButton.addEventListener('click', () => {
        clearConfirm.hidden = false;
        clearNo.focus();
    });
    clearNo.addEventListener('click', () => {
        clearConfirm.hidden = true;
        clearButton.focus();
    });
    clearYes.addEventListener('click', async () => {
        if (!openRoomId) return;
        clearYes.disabled = true;
        try {
            const result = await deleteSavedData(openRoomId, api.clearHistory);
            clearSavedMarks();
            window.chatAttachments?.clearedSaved();
            window.roomChannels?.clearOlder();
            setOlder('none');
            clearConfirm.hidden = true;
            status.textContent = `Deleted ${Number(result?.cleared) || 0} messages.`;
        } catch (err) {
            showStatusError(`Couldn't delete history: ${errText(err)}`);
        } finally {
            clearYes.disabled = false;
        }
    });

    // The result of each archive write (decision P5).
    function saveFailed(data) {
        const reason = String(data?.reason ?? 'unknown');
        const text = `Not saved: ${reason}`;
        historyState.textContent = text;
        status.textContent = text;
    }
    api.onLineSaved(data => noteSaved(data?.id));
    api.onSaveFailed(data => saveFailed(data));

    async function reopen(room, allowLegacy = false, button = null) {
        if (reopenBusy) return;
        reopenBusy = true;
        loginButton.disabled = true;
        for (const b of savedList.querySelectorAll('.reopen-room')) b.disabled = true;
        // Gap A5: the button of this room says that the room starts.
        const label = button?.textContent ?? '';
        if (button) button.textContent = STARTING_TEXT;
        let started = false;
        try {
            const lines = await readLines(room.roomId);
            if (!lines && archiveChanges.get(room.roomId)?.pending) return;
            // Gap A2: the room-link texts of a reopened room (renderer.js).
            roomRole = 'reopen';
            const result = await api.reopenRoom(room.roomId, allowLegacy);
            started = true;
            internetRoom = result?.internet === true;
            showChat(String(room.userName ?? ''), String(room.name ?? ''));
            for (const line of lines ?? []) {
                if (line.id) savedMessageIds.add(String(line.id));
                addMessage(line.from, line.text, line.time, line.own === true, line.id, line.peerId ?? null, line.channelId, line.attachment);
            }
            if (lines) {
                linesLoadedFor = String(room.roomId);
                loadedPages.add(linesLoadedFor + '/general');
            }
            setOlder((lines?.length ?? 0) >= FIRST_PAGE ? 'more' : 'none');
            window.reading.followLatest();
            roomStarted(result);
            window.chatAttachments?.restoreSaved(lines);
        } catch (err) {
            showStatusError(`Room didn't start: ${errText(err)}`);
        } finally {
            if (!started) {
                reopenBusy = false;
                loginButton.disabled = false;
                for (const b of savedList.querySelectorAll('.reopen-room')) b.disabled = false;
                if (button) button.textContent = label;
            }
        }
    }

    // P9B: the start at sign-in asks for the reopen of one protected saved room (the same path as the button).
    api.onStartRoom?.(async roomId => {
        let result = null;
        try { result = await api.listSavedRooms(); showState(result); } catch { return; }
        const room = (result?.rooms ?? []).find(row => row.roomId === String(roomId) && row.protected === true);
        if (!room) return;
        const row = Array.from(savedList.querySelectorAll('.saved-room')).find(item => item.dataset.roomId === room.roomId);
        void reopen(room, false, row?.querySelector('.reopen-room') ?? null);
    });

    window.savedRoomsUi = {
        channelOpened(id) { if (openRoomId) void loadAfterLogin(openRoomId, id); },
        // The login fields of the save choice. Only a keyed room sends them.
        loginOptions() {
            return { save: saveRoomBox.checked && !saveRoomBox.disabled, keepHistory: keepHistoryBox.checked };
        },
        roomStarted(result) {
            if (result?.saveError) showStatusError(`Room not saved: ${result.saveError}`);
            showStorage(result);
            if (openRoomId && linesLoadedFor !== openRoomId) loadAfterLogin(openRoomId);
        },
        saveFailed,
        // Gap N9: true when a saved room has this name (no difference for upper and lower case).
        hasRoomNamed(name) {
            return savedNames.has(String(name ?? '').trim().toLowerCase());
        }
    };

    refresh(() => api.listSavedRooms());
})();
