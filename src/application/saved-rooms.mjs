// Saved rooms (milestone 6): the main-process part. This module does not import electron.
// main.js gives the safeStorage object, the archive folder and the log function.
import { openRoomArchive, openRoomArchiveAsync, roomFingerprint } from './room-archive.mjs';

// The protector of the archive key, from Electron safeStorage (DECISIONS.md S2).
// The app never calls safeStorage.setUsePlainTextEncryption(). On Linux, the backend basic_text is not protection.
// Only the asynchronous safeStorage calls (Electron 45 deprecates the synchronous calls). decryptStringAsync also reads
// a key that an older version wrote with encryptString (Electron 45 test, candidate 0.8.0 B2).
// unwrap() gives { value, reEncrypt }: reEncrypt is shouldReEncrypt of safeStorage.
export function makeProtector(safeStorage, platform = process.platform) {
    return {
        async: true,
        async available() {
            if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
            if (platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
            return true;
        },
        wrap: b => safeStorage.encryptStringAsync(b.toString('base64')),
        async unwrap(b) {
            const r = await safeStorage.decryptStringAsync(b);
            return { value: Buffer.from(r.result, 'base64'), reEncrypt: r.shouldReEncrypt === true };
        }
    };
}

function errText(err) {
    return err?.message ?? String(err);
}

// dir: the archive folder. protector: { available(), wrap(), unwrap() }. log(level, text).
// A protector with async: true has asynchronous calls: call and await open() before the first other call.
// backend(): optional, the safeStorage backend name for the log line (Linux only).
// notify(type, data): optional, 'line-saved' { id } or 'save-failed' { id, reason }.
// forgetHints(row): optional, Forget calls it with the getRoom() row before it deletes the room.
// limits: optional, replaces values of ARCHIVE_LIMITS (tests).
export function createSavedRooms({ dir, protector, log = () => {}, backend = null, notify = null, forgetHints = null,
    limits = null }) {
    let archive = null;
    // The active room: { roomId, keepHistory } or null.
    let active = null;
    let replay = null;
    let attachedNode = null;
    // Tombstones for the run of the app (DECISIONS.md P7): room ID -> Set of cleared message IDs.
    const tombstones = new Map();

    function logState(what) {
        const st = archive.state();
        let line = `Saved rooms archive ${what}: state ${st.state}, reason ${st.reason ?? 'none'}`;
        if (backend) {
            let name;
            try { name = backend(); } catch (err) { name = `unknown (${errText(err)})`; }
            line += `, safeStorage backend ${name}`;
        }
        log(st.state === 'open' ? 'INFO' : 'WARN', line);
    }

    let opening = null;

    function ensure() {
        if (!archive) {
            if (protector?.async) {
                // The asynchronous protector opens only in open().
                if (!opening) log('WARN', 'Saved rooms archive not opened: open() was not called');
                return null;
            }
            try {
                archive = openRoomArchive({ dir, protector, limits });
            } catch (err) {
                // An unexpected error (for example a folder that cannot be made): no archive, no crash.
                log('WARN', `Saved rooms archive not opened: ${errText(err)}`);
                return null;
            }
            logState('opened');
        }
        return archive;
    }

    function status() {
        const a = ensure();
        if (!a) return { state: 'locked', reason: 'open-failed', rooms: [] };
        const st = a.state();
        let rooms = [];
        if (st.state === 'open') {
            try {
                // listRooms() gives no key and no invite.
                rooms = a.listRooms().map(r => ({
                    roomId: r.roomId, name: r.name, userName: r.userName, keepHistory: r.keepHistory,
                    savedAt: r.savedAt, openedAt: r.openedAt, ...(r.protected ? { protected: true } : {})
                }));
            } catch (err) {
                log('WARN', `Saved rooms not listed: ${errText(err)}`);
            }
        }
        return { state: st.state, reason: st.reason, rooms };
    }

    // Opens the archive one time. A second call during the open waits for the same open. Never rejects.
    function open() {
        if (archive) return Promise.resolve();
        if (!opening) {
            opening = (async () => {
                try {
                    archive = await openRoomArchiveAsync({ dir, protector, limits });
                } catch (err) {
                    log('WARN', `Saved rooms archive not opened: ${errText(err)}`);
                    return;
                } finally {
                    opening = null;
                }
                logState('opened');
            })();
        }
        return opening;
    }

    async function unlock() {
        if (!archive) await open();
        if (archive) {
            await archive.unlockAsync();
            logState('unlock');
        }
        return status();
    }

    function lines(roomId, { before = null, limit = 200, channelId = null } = {}) {
        const a = ensure();
        if (!a || a.state().state !== 'open' || typeof roomId !== 'string') return [];
        return a.listMessages(roomId, { before, limit, channelId }).map(m => ({
            id: m.id, from: m.from, text: m.text, time: m.time, own: m.own, peerId: m.peerId,
            ...(m.channelId ? { channelId: m.channelId } : {}), ...(m.attachment ? { attachment: m.attachment } : {})
        }));
    }

    // The presence lines of a saved room with from <= time < to (null: no limit), in time order.
    function notes(roomId, { from = null, to = null } = {}) {
        const a = ensure();
        if (!a || a.state().state !== 'open' || typeof roomId !== 'string') return [];
        return a.listNotes(roomId, { from, to });
    }

    // A presence line of the open room (joins, leaves, a lost link, the reconnect). Only a room that keeps history
    // saves it. It is a local event of this PC: it does not go to the node. Returns { saved }.
    function saveNote(note) {
        if (!active?.keepHistory || !archive) return { saved: false };
        try {
            return { saved: archive.addNote(active.roomId, note) };
        } catch (err) {
            log('WARN', `Presence line not saved: ${errText(err)}`);
            return { saved: false };
        }
    }

    // The saved row with the key, for the main process only. Never give it to the window.
    function getRoom(roomId) {
        const a = ensure();
        if (!a || a.state().state !== 'open' || typeof roomId !== 'string') return null;
        return a.getRoom(roomId);
    }

    function deviceIdentity(make) {
        const a = ensure();
        if (a?.state().state !== 'open') throw new Error('Unlock protected storage to use this device’s admission identity.');
        const existing = a.getDeviceIdentity();
        if (existing !== null) return existing;
        if (a.hasProtectedRooms()) throw new Error('The protected device identity is missing. Restore it from your profile backup.');
        return a.rememberDeviceIdentity(make());
    }

    const isProtectedRoom = (room, roomKey) => getRoom(roomFingerprint(room, roomKey))?.protected === true;

    function persistMembership(membership) {
        if (!active) return true;
        return archive.updateMembership(active.roomId, membership);
    }

    // Called synchronously before network start, including the retry on another port.
    function prepareReplay(room, roomKey, removeHistory) {
        const roomId = roomFingerprint(room, roomKey);
        replay = { roomId, removeHistory, seedIds: [] };
        try {
            const a = ensure();
            if (!a || a.state().state !== 'open' || !a.getRoom(roomId)) return [];
            const rows = a.replayMessages(roomId);
            replay.seedIds = rows.map(m => m.id);
            return rows;
        } catch (err) {
            log('WARN', `Saved replay unavailable: ${errText(err)}`);
            return [];
        }
    }

    function loadChannels(room, key) {
        const a = ensure();
        if (!a || a.state().state !== 'open') return [];
        try { return a.channels(roomFingerprint(room, key)); }
        catch (err) {
            log('WARN', 'Saved channel catalog unavailable: ' + errText(err));
            return [];
        }
    }
    function persistChannels(rows) {
        if (!active || !rows?.length) return;
        try { archive.saveChannels(active.roomId, rows); }
        catch (err) { log('WARN', 'Could not save the room channel catalog: ' + errText(err)); }
    }
    // G6: the saved voice channel catalog of a room, or null.
    function loadVoiceChannels(room, key) {
        const a = ensure();
        if (!a || a.state().state !== 'open') return null;
        try { return a.voiceChannels(roomFingerprint(room, key)); }
        catch (err) {
            log('WARN', 'Saved voice channels unavailable: ' + errText(err));
            return null;
        }
    }
    function persistVoiceChannels(catalog) {
        if (!active || !catalog) return;
        try { archive.saveVoiceChannels(active.roomId, catalog); }
        catch (err) { log('WARN', 'Could not save the voice channels: ' + errText(err)); }
    }
    function releaseReplay() {
        replay = null;
    }

    function invalidateReplay(roomId, removed) {
        if (replay?.roomId !== roomId) return;
        // A seed row may have been pruned from the archive while retained by the live node.
        for (const id of replay.seedIds) removed.add(id);
        replay.removeHistory(removed);
        replay.seedIds = [];
    }

    // After the node of a keyed room starts. Returns { roomId, saved, saveError }. A save failure does not throw.
    function afterLogin({ room, roomKey, invite = null, userName, save = false, keepHistory = true, membership = null }) {
        active = null;
        if (!roomKey) return { roomId: null, saved: false, saveError: null, savedRoom: false, keepHistory: null };
        const roomId = roomFingerprint(room, roomKey);
        const a = ensure();
        const open = a !== null && a.state().state === 'open';
        let saved = false;
        let saveError = null;
        if (save) {
            if (!open) {
                saveError = a ? a.state().reason : 'open-failed';
            } else {
                try {
                    a.saveRoom({ name: room, roomKey, invite: invite || null, userName, keepHistory: keepHistory !== false, membership });
                    saved = true;
                } catch (err) {
                    saveError = errText(err);
                }
            }
            if (saveError) log('WARN', `Room not saved: ${saveError}`);
        }
        if (open) {
            try {
                const row = a.getRoom(roomId);
                if (row) {
                    a.markOpened(roomId);
                    active = { roomId, keepHistory: row.keepHistory };
                    if (!saved && membership !== null) {
                        try {
                            if (!a.updateMembership(roomId, membership)) throw new Error('Room access was not saved');
                        } catch (err) {
                            saveError = errText(err);
                            log('WARN', 'Room access was not saved');
                        }
                    }
                    log('INFO', `Saved room active, keep history ${row.keepHistory ? 'on' : 'off'}`);
                    // A refreshed invite for an existing room only updates its connection hints.
                    if (!save && invite && invite !== row.invite) {
                        try { a.setInvite(roomId, invite); }
                        catch (err) { saveError = errText(err); log('WARN', `Refreshed invite not saved: ${saveError}`); }
                    }
                }
            } catch (err) {
                log('WARN', `Saved room not marked: ${errText(err)}`);
            }
        }
        return { roomId, saved, saveError, savedRoom: active !== null, keepHistory: active ? active.keepHistory : null };
    }

    // Returns { saved, saveError }. saved is true for a new row or a duplicate.
    function add(row) {
        if (!active || !active.keepHistory || !archive || row.id === undefined || row.id === null) {
            return { saved: false, saveError: null };
        }
        const dead = tombstones.get(active.roomId);
        if (dead && dead.has(String(row.id))) return { saved: false, saveError: null };
        try {
            archive.addMessage(active.roomId, row);
            return { saved: true, saveError: null };
        } catch (err) {
            const reason = err?.code === 'row-too-large' ? 'row-too-large' : (errText(err) || 'unknown error');
            log('WARN', `Saved line not written: ${reason}`);
            return { saved: false, saveError: reason };
        }
    }

    // An own send: only a record that a session accepted.
    function recordSend(record) {
        if (!record || !(record.accepted >= 1)) return { saved: false, saveError: null };
        return add({ id: record.id, from: record.from, text: record.text, time: record.time, own: true,
            source: 'send', peerId: null, channelId: record.channelId, attachment: record.attachment });
    }

    function emit(type, data) {
        if (!notify) return;
        try { notify(type, data); } catch (err) { log('WARN', `Saved rooms notify failed: ${errText(err)}`); }
    }

    // Live lines only (event live, DECISIONS.md P4). The history event (host replay) is not saved.
    function attachNode(node) {
        attachedNode = node;
        node.events.on('live', data => {
            if (!data || node !== attachedNode) return;
            const r = add({ id: data.id, from: data.from, text: data.text, time: data.time, own: false,
                source: 'live', peerId: data.peerId ?? null, channelId: data.channelId, attachment: data.attachment });
            if (r.saved) emit('line-saved', { id: data.id });
            else if (r.saveError) emit('save-failed', { id: data.id, reason: r.saveError });
        });
    }

    function setKeepHistory(roomId, on) {
        const a = ensure();
        if (!a || a.state().state !== 'open') throw new Error('room archive is not open');
        if (typeof roomId !== 'string' || !a.getRoom(roomId)) throw new Error('room is not saved');
        a.setKeepHistory(roomId, on === true);
        if (active && active.roomId === roomId) active = { roomId, keepHistory: on === true };
        log('INFO', `Saved room keep history ${on === true ? 'on' : 'off'}`);
        return { roomId, keepHistory: on === true };
    }

    // The user name of a saved room (gap A6): 1 to 64 characters. The next reopen uses it.
    function setUserName(roomId, name) {
        const a = ensure();
        if (!a || a.state().state !== 'open') throw new Error('room archive is not open');
        if (typeof roomId !== 'string' || !a.getRoom(roomId)) throw new Error('room is not saved');
        const userName = typeof name === 'string' ? name.trim() : '';
        if (userName.length < 1 || userName.length > 64) throw new Error('Enter a username of up to 64 characters.');
        a.setUserName(roomId, userName);
        log('INFO', 'Saved room user name changed');
        return { roomId, userName };
    }

    function clear(roomId) {
        const a = ensure();
        if (!a || a.state().state !== 'open') throw new Error('room archive is not open');
        if (typeof roomId !== 'string') throw new Error('bad room ID');
        const ids = a.clearMessages(roomId);
        const removed = new Set(ids);
        invalidateReplay(roomId, removed);
        let set = tombstones.get(roomId);
        if (!set) { set = new Set(); tombstones.set(roomId, set); }
        for (const id of removed) set.add(String(id));
        log('INFO', `Saved room history cleared: ${ids.length} rows`);
        return { cleared: ids.length };
    }

    function forget(roomId) {
        if (active && active.roomId === roomId) throw new Error('room is open');
        const a = ensure();
        if (!a || a.state().state !== 'open') throw new Error('room archive is not open');
        if (typeof roomId !== 'string') throw new Error('bad room ID');
        const row = a.getRoom(roomId);
        if (row && forgetHints) {
            try { forgetHints(row); }
            catch (err) {
                log('WARN', `Room hints not deleted: ${errText(err)}`);
                throw new Error('Couldn\'t forget all of the room. Try Forget again.');
            }
        }
        a.removeRoom(roomId);
        invalidateReplay(roomId, new Set());
        tombstones.delete(roomId);
        log('INFO', 'Saved room forgotten');
        return { forgotten: true };
    }

    // Local, user-accepted downloads only. The canonical card's presence in the
    // encrypted archive determines whether a durable file association exists.
    function rememberDownload(descriptor, file) {
        if (!active?.keepHistory || !archive) return;
        try { archive.rememberDownload(active.roomId, descriptor, file); }
        catch { log('WARN', 'Local download association could not be saved'); }
    }

    function getDownload(messageId, descriptorId) {
        if (!active || !archive) return null;
        try { return archive.getDownload(active.roomId, messageId, descriptorId); }
        catch { return null; }
    }

    // 1.0.4: the checked thumbnail of an archived image card of the open room (room-media.mjs gives it). Only a room
    // that keeps history stores it, as rememberDownload. Gives true when a card took it.
    function rememberThumbnail(descriptor, png) {
        if (!active?.keepHistory || !archive) return false;
        try { return archive.rememberThumbnail(active.roomId, descriptor, png); }
        catch { log('WARN', 'Thumbnail could not be saved'); return false; }
    }

    function getThumbnail(descriptor) {
        if (!active?.keepHistory || !archive) return null;
        try { return archive.getThumbnail(active.roomId, descriptor); }
        catch { return null; }
    }

    // The checked card of an archived line of the open room ({ descriptor, own }), or null.
    function messageCard(messageId) {
        if (!active || !archive || typeof messageId !== 'string' || !messageId || messageId.length > 128) return null;
        try { return archive.messageCard(active.roomId, messageId); }
        catch { return null; }
    }

    function ownCard(descriptorId) {
        if (!active || !archive || typeof descriptorId !== 'string' || descriptorId.length !== 36) return null;
        try { return archive.ownCard(active.roomId, descriptorId); }
        catch { return null; }
    }

    function clearThumbnails() {
        if (!active || !archive) return;
        try { archive.clearThumbnails(active.roomId); }
        catch { log('WARN', 'Stored thumbnails could not be deleted'); }
    }

    function activeInfo() {
        return active ? { roomId: active.roomId, keepHistory: active.keepHistory } : null;
    }

    // Gap A7: Leave room. The archive stays open. The room is no longer active, thus Forget of it works, and a
    // second afterLogin starts from a clean state.
    function leave() {
        active = null;
        attachedNode = null;
        releaseReplay();
    }

    // G7a: the friend part of the archive for friend-links.mjs, or null when the archive is not open. Each call
    // gives the room ID: the friend lines do not use the one active room.
    function friendArchive() {
        const a = ensure();
        if (!a || a.state().state !== 'open') return null;
        return {
            isOpen: () => a.state().state === 'open',
            listFriends: () => a.listFriends(),
            saveFriendRoom: value => a.saveFriendRoom(value),
            getRoom: roomId => a.getRoom(roomId),
            updateFriend: (roomId, fields) => a.updateFriend(roomId, fields),
            updateMembership: (roomId, membership) => a.updateMembership(roomId, membership),
            // Forget the friend room: the hint files, the rooms row (the friends row and the lines go with it).
            removeFriendRoom(roomId) {
                const row = a.getRoom(roomId);
                if (row && forgetHints) forgetHints(row);
                a.removeRoom(roomId);
                tombstones.delete(roomId);
            },
            blocks: () => a.friendBlocks(),
            block: (deviceId, name) => a.addFriendBlock(deviceId, name),
            unblock: deviceId => a.removeFriendBlock(deviceId),
            settings: () => a.friendSettings(),
            saveSettings: value => a.saveFriendSettings(value),
            addLine: (roomId, row) => a.addMessage(roomId, row),
            hasLine: (roomId, id) => a.hasMessage(roomId, id),
            // G7b: the outbox and the away marks.
            addOutbox: (roomId, row, cap) => a.addOutbox(roomId, row, cap),
            listOutbox: roomId => a.listOutbox(roomId),
            hasOutbox: (roomId, id) => a.hasOutbox(roomId, id),
            deleteOutbox: (roomId, id) => a.deleteOutbox(roomId, id),
            deliverOutbox: (roomId, id, from) => a.deliverOutbox(roomId, id, from),
            addAwayMark: (roomId, id, batch) => a.addAwayMark(roomId, id, batch),
            awayMarks: (roomId, ids) => a.awayMarks(roomId, ids),
            lines: (roomId, opts) => lines(roomId, opts)
        };
    }

    function isFriendRoom(roomId) {
        const a = ensure();
        if (!a || a.state().state !== 'open' || typeof roomId !== 'string') return false;
        return a.isFriendRoom(roomId);
    }

    function close() {
        active = null;
        attachedNode = null;
        releaseReplay();
        if (archive) archive.close();
    }

    return {
        open, notes, saveNote, rememberDownload, getDownload, rememberThumbnail, getThumbnail, clearThumbnails, messageCard, ownCard, status, unlock, lines, getRoom, loadChannels, persistChannels, loadVoiceChannels, persistVoiceChannels, prepareReplay, releaseReplay, afterLogin, recordSend, attachNode, setKeepHistory, setUserName, clear, forget, activeInfo,
        deviceIdentity, isProtectedRoom, persistMembership, leave, close, active: () => active, friendArchive, isFriendRoom
    };
}
