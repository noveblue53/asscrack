// Goal easy-join part 3, item 3: a code in the clipboard. This module does not import electron.
// The main process reads the clipboard text only when the main window opens or gets the focus (main.js). This module
// parses the text with no network. For a valid code it asks "Join <room>?" one time. The window gets { id, room }, never
// the code. Join uses the Join of a friend invite (friend-join.mjs joinCode()): a one-time token for the login. The
// login of a room code token knocks (main.js knockForInvite, the path of a pasted room code).
// The log never gets the text, a part of it, or a code.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRoomCode, readInvite, readRoomCode, COMPACT_INVITE_PREFIX, PROTECTED_INVITE_PREFIX } from '../network/invite.mjs';

// A longer clipboard text is not a code (a device invite with 16 nodes of 16 addresses stays below this size).
export const MAX_CLIPBOARD_TEXT = 16 * 1024;
// The number of asked codes that the store keeps (the last ones).
export const ASKED_CAP = 50;
export const ASKED_FILE = 'clipboard-asked.json';

const DEVICE_INVITE_PREFIXES = [COMPACT_INVITE_PREFIX, PROTECTED_INVITE_PREFIX];

// The kind of a clipboard text. selfId: the device ID of this device.
// Returns null (no prompt) or { kind, code, room, roomKey }. code is the normalized text (no white space).
//   'room-code'      a room code of part 2 (EJ-14) that readRoomCode accepts. It also starts with "asscrack3:", thus
//                    this check comes first. A room code of this device (the owner) gives null.
//   'device-invite'  a protected room invite that readInvite accepts, with a device grant for selfId.
// readInvite and readRoomCode refuse a damaged code and an expired code (with the grace time of L4). A code for a
// different device gives null. No error and no log line for each null.
export function clipboardKind(text, { selfId } = {}) {
    if (typeof text !== 'string' || !text || text.length > MAX_CLIPBOARD_TEXT) return null;
    if (typeof selfId !== 'string' || !selfId) return null;
    const code = text.replace(/\s+/g, '');
    if (isRoomCode(code)) {
        let roomCode;
        try { roomCode = readRoomCode(code); } catch { return null; }
        // The owner cannot knock on its own room.
        if (roomCode.owner === selfId) return null;
        return { kind: 'room-code', code, room: roomCode.room, roomKey: roomCode.key };
    }
    if (DEVICE_INVITE_PREFIXES.some(prefix => code.startsWith(prefix))) {
        let invite;
        try { invite = readInvite(code); } catch { return null; }
        const grant = invite.membership?.grant;
        if (!grant || grant.deviceId !== selfId) return null;
        return { kind: 'device-invite', code, room: invite.room, roomKey: invite.key };
    }
    return null;
}

// The SHA-256 of a normalized code (hex). The store keeps only this value.
export const codeHash = code => createHash('sha256').update(code, 'utf8').digest('hex');

const HASH = /^[0-9a-f]{64}$/;

// The asked codes: the last ASKED_CAP hashes, in memory and in the file of the profile.
export function createAskedStore(file, { cap = ASKED_CAP, log = () => {} } = {}) {
    let hashes = [];
    try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        if (value?.v === 1 && Array.isArray(value.hashes)) hashes = value.hashes.filter(h => typeof h === 'string' && HASH.test(h)).slice(-cap);
    } catch (err) {
        if (err?.code !== 'ENOENT') log('WARN', 'Clipboard join: the list of asked codes was not read');
    }
    function save() {
        try {
            mkdirSync(path.dirname(file), { recursive: true });
            const temp = `${file}.tmp`;
            writeFileSync(temp, JSON.stringify({ v: 1, hashes }));
            renameSync(temp, file);
        } catch {
            log('WARN', 'Clipboard join: the list of asked codes was not saved');
        }
    }
    return {
        has: hash => hashes.includes(hash),
        add(hash) {
            if (hashes.includes(hash)) return;
            hashes.push(hash);
            if (hashes.length > cap) hashes = hashes.slice(-cap);
            save();
        },
        size: () => hashes.length
    };
}

// readText(): the clipboard text, or a promise of it (Electron 45: clipboard.readText() gives a promise). selfId(): the
// device ID, or null when the protected
// storage is locked or has no identity. currentRoom(): { room, roomKey } of the running room, or null. busy(): a login
// or a Leave room runs now. store: createAskedStore(). notify(kind): tell the window that a prompt waits (kind:
// 'room-code' or 'device-invite', for the diagnostics journal).
// join(code, room, leave): friend-join.mjs joinCode().
export function createClipboardJoin({ readText, selfId, currentRoom = () => null, busy = () => false, store,
    notify = () => {}, join, log = () => {} }) {
    let pending = null; // { id, code, room }

    return {
        // The main window opened or got the focus. Resolves true when a new prompt waits. After the read, the checks
        // run with no wait: thus two checks at the same time (focus and load) give one prompt.
        async check() {
            let self = null;
            try { self = selfId(); } catch { self = null; }
            if (!self) return false;
            let text = '';
            try { text = await readText(); } catch { return false; }
            const found = clipboardKind(text, { selfId: self });
            if (!found) return false;
            const hash = codeHash(found.code);
            if (store.has(hash)) return false;
            // The room of now: no prompt. The code is not recorded, thus it can ask after Leave room.
            const current = currentRoom();
            if (current && current.room === found.room && current.roomKey === found.roomKey) return false;
            // A login or a Leave room runs: ask at the next focus.
            if (busy()) return false;
            store.add(hash);
            pending = { id: randomUUID(), code: found.code, room: found.room };
            log('INFO', found.kind === 'room-code' ? 'Clipboard join: a room code, prompt shown'
                : 'Clipboard join: a room invite for this device, prompt shown');
            notify(found.kind);
            return true;
        },
        // The prompt for the window: { id, room }, or null. It stays until Join or Not now.
        take: () => (pending ? { id: pending.id, room: pending.room } : null),
        // Join of the prompt id. leave: the user agreed to leave the current room. The answer of joinCode(), or
        // { result: 'gone' } for an unknown id.
        async join(id, leave = false) {
            if (!pending || typeof id !== 'string' || id !== pending.id) return { result: 'gone', room: '' };
            const { code, room } = pending;
            const answer = await join(code, room, leave === true);
            if (answer?.result !== 'confirm' && answer?.result !== 'busy' && answer?.result !== 'failed') pending = null;
            return answer;
        },
        // Not now.
        dismiss(id) {
            if (pending && id === pending.id) pending = null;
        }
    };
}
