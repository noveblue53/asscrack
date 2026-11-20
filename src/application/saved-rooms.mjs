// Saved rooms (milestone 6): the main-process part. This module does not import electron.
// main.js gives the safeStorage object, the archive folder and the log function.
import { openRoomArchive, roomFingerprint } from './room-archive.mjs';

// The protector of the archive key, from Electron safeStorage (DECISIONS.md S2).
// The app never calls safeStorage.setUsePlainTextEncryption(). On Linux, the backend basic_text is not protection.
export function makeProtector(safeStorage, platform = process.platform) {
    return {
        available() {
            if (!safeStorage.isEncryptionAvailable()) return false;
            if (platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
            return true;
        },
        wrap: b => safeStorage.encryptString(b.toString('base64')),
        unwrap: b => Buffer.from(safeStorage.decryptString(b), 'base64')
    };
}

function errText(err) {
    return err?.message ?? String(err);
}

// dir: the archive folder. protector: { available(), wrap(), unwrap() }. log(level, text).
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

    function ensure() {
        if (!archive) {
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
                    savedAt: r.savedAt, openedAt: r.openedAt
                }));
            } catch (err) {
                log('WARN', `Saved rooms not listed: ${errText(err)}`);
            }
        }
        return { state: st.state, reason: st.reason, rooms };
    }

    function unlock() {
        const a = ensure();
        if (a) {
            a.unlock();
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

    // The saved row with the key, for the main process only. Never give it to the window.
    function getRoom(roomId) {
        const a = ensure();
        if (!a || a.state().state !== 'open' || typeof roomId !== 'string') return null;
        return a.getRoom(roomId);
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
    function afterLogin({ room, roomKey, invite = null, userName, save = false, keepHistory = true }) {
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
                    a.saveRoom({ name: room, roomKey, invite: invite || null, userName, keepHistory: keepHistory !== false });
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
            try { forgetHints(row); } catch (err) { log('WARN', `Room hints not deleted: ${errText(err)}`); }
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

    function activeInfo() {
        return active ? { roomId: active.roomId, keepHistory: active.keepHistory } : null;
    }

    function close() {
        active = null;
        attachedNode = null;
        releaseReplay();
        if (archive) archive.close();
    }

    return {
        rememberDownload, getDownload, status, unlock, lines, getRoom, loadChannels, persistChannels, prepareReplay, releaseReplay, afterLogin, recordSend, attachNode, setKeepHistory, clear, forget, activeInfo,
        close, active: () => active
    };
}
