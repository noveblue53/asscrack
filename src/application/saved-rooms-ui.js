// Saved rooms (milestone 6): the window part. A classic script. It loads after renderer.js and uses its functions
// (showChat, roomStarted, addMessage, status, loginButton, roomTypeSelect, peerItems, internetRoom).
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
    const waitingPeer = document.getElementById('waiting-peer');

    let archiveOpen = false;
    // True in a reopened room or a saved room: show "Waiting for a peer" while the room has no peer (S5).
    let watchPeers = false;
    let reopenBusy = false;

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
            item.append(name, user, button);
            savedList.appendChild(item);
        }
        savedSection.hidden = rooms.length === 0;
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

    function updateWaiting() {
        waitingPeer.hidden = !(watchPeers && peerItems.size === 0);
    }
    // renderer.js registers its peer listeners first: peerItems is current here.
    api.onPeerJoined(() => updateWaiting());
    api.onPeerLeft(() => updateWaiting());

    // Reopen: show the chat screen at once with the saved lines, then start the node.
    async function reopen(room) {
        if (reopenBusy) return;
        reopenBusy = true;
        loginButton.disabled = true;
        for (const b of savedList.querySelectorAll('.reopen-room')) b.disabled = true;
        let lines = [];
        try {
            lines = await api.savedRoomLines(room.roomId);
        } catch (err) {
            console.warn(`Saved lines not read: ${err?.message ?? err}`);
        }
        internetRoom = true;
        showChat(String(room.userName ?? ''), String(room.name ?? ''));
        for (const line of Array.isArray(lines) ? lines : []) {
            addMessage(line.from, line.text, line.time, line.own === true, line.id, line.peerId ?? null);
        }
        window.reading.followLatest();
        watchPeers = true;
        updateWaiting();
        try {
            const result = await api.reopenRoom(room.roomId);
            roomStarted(result);
        } catch (err) {
            status.textContent = `Error: the room did not start: ${err?.message ?? err}`;
        }
    }

    window.savedRoomsUi = {
        // The login fields of the save choice. Only a keyed room sends them.
        loginOptions(type) {
            if (type === 'lan') return {};
            return { save: saveRoomBox.checked && !saveRoomBox.disabled, keepHistory: keepHistoryBox.checked };
        },
        roomStarted(result) {
            if (result?.saved === true || watchPeers) watchPeers = true;
            if (result?.saveError) status.textContent = `The room was not saved: ${result.saveError}`;
            updateWaiting();
        }
    };

    refresh(() => api.listSavedRooms());
})();
