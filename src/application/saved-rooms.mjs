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
export function createSavedRooms({ dir, protector, log = () => {}, backend = null }) {
    let archive = null;
    // The active room: { roomId, keepHistory } or null.
    let active = null;

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
                archive = openRoomArchive({ dir, protector });
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

    function lines(roomId) {
        const a = ensure();
        if (!a || a.state().state !== 'open' || typeof roomId !== 'string') return [];
        return a.listMessages(roomId).map(m => ({
            id: m.id, from: m.from, text: m.text, time: m.time, own: m.own, peerId: m.peerId
        }));
    }

    // The saved row with the key, for the main process only. Never give it to the window.
    function getRoom(roomId) {
        const a = ensure();
        if (!a || a.state().state !== 'open' || typeof roomId !== 'string') return null;
        return a.getRoom(roomId);
    }

    // After the node of a keyed room starts. Returns { roomId, saved, saveError }. A save failure does not throw.
    function afterLogin({ room, roomKey, invite = null, userName, save = false, keepHistory = true }) {
        active = null;
        if (!roomKey) return { roomId: null, saved: false, saveError: null };
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
                }
            } catch (err) {
                log('WARN', `Saved room not marked: ${errText(err)}`);
            }
        }
        return { roomId, saved, saveError };
    }

    function add(row) {
        if (!active || !active.keepHistory || !archive || row.id === undefined || row.id === null) return;
        try {
            archive.addMessage(active.roomId, row);
        } catch (err) {
            log('WARN', `Saved line not written: ${errText(err)}`);
        }
    }

    // An own send: only a record that a session accepted.
    function recordSend(record) {
        if (!record || !(record.accepted >= 1)) return;
        add({ id: record.id, from: record.from, text: record.text, time: record.time, own: true, source: 'send', peerId: null });
    }

    // Live lines only. The history event (host replay) is not saved.
    function attachNode(node) {
        node.events.on('message', data => {
            if (!data) return;
            add({ id: data.id, from: data.from, text: data.text, time: data.time, own: false, source: 'live', peerId: data.peerId ?? null });
        });
    }

    function close() {
        active = null;
        if (archive) archive.close();
    }

    return { status, unlock, lines, getRoom, afterLogin, recordSend, attachNode, close, active: () => active };
}
