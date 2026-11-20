// Saved rooms (milestone 6): the window part. A classic script. It loads after renderer.js and uses its functions
// (showChat, roomStarted, addMessage, insertMessage, status, loginButton, roomTypeSelect, peerItems, internetRoom,
// messageList, savedMessageIds, noteSaved, clearSavedMarks).
(function () {
    const api = window.asscrack;
    if (!api || typeof api.listSavedRooms !== 'function') return;

    const saveRoomBox = document.getElementById('save-room');
    const keepHistoryBox = document.getElementById('keep-history');
    const saveFields = document.getElementById('save-room-fields');
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
    const FORGET_TEXT = 'Forget this room on this computer? This deletes the saved invite, the saved messages, the saving '
        + 'choice and the saved addresses of this room. Peers keep their copies. To join again, you need an invite.';

    let archiveOpen = false;
    let reopenBusy = false;
    // The saved room that is open in the chat screen: its roomId, or null.
    let openRoomId = null;
    // The roomId whose saved lines are shown (reopen or login).
    let linesLoadedFor = null;
    const loadedPages = new Set();
    let olderBusy = false;
    const archiveChanges = new Map();

    async function deleteSavedData(roomId, action) {
        const change = { pending: true };
        archiveChanges.set(roomId, change);
        try {
            return await action(roomId);
        } finally {
            change.pending = false;
        }
    }

    function keyedType() {
        return roomTypeSelect.value !== 'lan';
    }

    function showSaveFields() {
        saveFields.hidden = !keyedType();
        saveRoomBox.disabled = !archiveOpen;
        if (!archiveOpen) saveRoomBox.checked = false;
    }
    roomTypeSelect.addEventListener('change', showSaveFields);

    function stateText(result) {
        if (result.state === 'unavailable') {
            return 'Protected storage is not available on this computer. Rooms cannot be saved.';
        }
        return `Saved rooms: locked (${result.reason ?? 'unknown'})`;
    }

    function showRooms(rooms) {
        savedList.replaceChildren();
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
            button.addEventListener('click', () => reopen(room));
            item.append(name, user, button, ...forgetControls(room, item));
            savedList.appendChild(item);
        }
        savedSection.hidden = rooms.length === 0;
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
                status.textContent = `Error: the room was not forgotten: ${err?.message ?? err}`;
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
        const empty = messageList.children.length === 0;
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
        historyState.textContent = keep === true ? 'Saving new messages on this device.' : 'Saving is off. Saved messages stay.';
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
            status.textContent = `Error: the saving choice did not change: ${err?.message ?? err}`;
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
            status.textContent = `Saved history deleted on this device (${Number(result?.cleared) || 0} messages).`;
        } catch (err) {
            status.textContent = `Error: the saved history was not deleted: ${err?.message ?? err}`;
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

    // Reopen: show the chat screen at once with the saved lines, then start the node.
    async function reopen(room) {
        if (reopenBusy) return;
        reopenBusy = true;
        loginButton.disabled = true;
        for (const b of savedList.querySelectorAll('.reopen-room')) b.disabled = true;
        const lines = await readLines(room.roomId);
        if (!lines && archiveChanges.get(room.roomId)?.pending) {
            reopenBusy = false;
            loginButton.disabled = false;
            for (const b of savedList.querySelectorAll('.reopen-room')) b.disabled = false;
            return;
        }
        internetRoom = true;
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
        try {
            const result = await api.reopenRoom(room.roomId);
            roomStarted(result);
            window.chatAttachments?.restoreSaved(lines);
        } catch (err) {
            status.textContent = `Error: the room did not start: ${err?.message ?? err}`;
        }
    }

    window.savedRoomsUi = {
        channelOpened(id) { if (openRoomId) void loadAfterLogin(openRoomId, id); },
        // The login fields of the save choice. Only a keyed room sends them.
        loginOptions(type) {
            if (type === 'lan') return {};
            return { save: saveRoomBox.checked && !saveRoomBox.disabled, keepHistory: keepHistoryBox.checked };
        },
        roomStarted(result) {
            if (result?.saveError) status.textContent = `The room was not saved: ${result.saveError}`;
            showStorage(result);
            if (openRoomId && linesLoadedFor !== openRoomId) loadAfterLogin(openRoomId);
        },
        saveFailed
    };

    refresh(() => api.listSavedRooms());
})();
