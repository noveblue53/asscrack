// Goal easy-join part 1: Join of a friend invite (friend-invite.mjs). This module does not import electron.
// The friend chat window gives the line ID of an invite card. The main process keeps the code: the main window gets
// only a one-time token, and the login handler changes the token back to the code (the same path as a pasted code).
// In a room, Join first asks "Leave <room> and join?" (the result 'confirm'), then leaves the room and reloads the
// main window. The main window takes the waiting Join at its start (take()), or at the event 'asscrack:friend-join'.
// easy-join part 3: Join of a friend row (knock()). The same "Leave <room> and join?" step comes first. Then the knock
// goes over the friend link (friend-links.mjs knock()). The current room stays until the owner selects Allow; then the
// device invite of Allow takes the same path as the code of a friend invite.
import { randomUUID } from 'node:crypto';
import { roomCodeAccess } from '../network/room-membership.mjs';

// easy-join part 3: true when a saved protected room of savedRooms (saved-rooms.mjs) has this room ID. The room line
// of a friend has the room ID, not the key: the check computes the room ID of each saved protected room.
export function savedRoomHasId(savedRooms, roomId) {
    if (typeof roomId !== 'string') return false;
    for (const row of savedRooms.status().rooms) {
        if (!row.protected) continue;
        const saved = savedRooms.getRoom(row.roomId);
        let membership = saved?.membership;
        try {
            if (typeof membership === 'string') membership = JSON.parse(membership);
            if (membership && roomCodeAccess(saved.name, saved.roomKey, membership.owner, membership.lan).roomId === roomId) return true;
        } catch { /* a damaged row */ }
    }
    return false;
}

// links: friendLinks. room(): the name of the current room, or null on the login screen. busy(): a login or a Leave
// room runs now. leave(): Leave room, resolves true when the room ended (main.js leaveRoom()). reload(): reload the main
// window. show(): show the main window. notify(): tell the main window that a Join waits. name(): the name for friends.
// Part 3: knocking(on): a friend knock starts (true) or ends (false); main.js refuses a login and a reopen during it.
// savedRoom(roomId): true when the room is a saved protected room of this device.
export function createFriendJoins({ links, room, busy = () => false, leave, reload, show = () => {}, notify = () => {},
    name = () => '', log = () => {}, knocking = () => {}, savedRoom = () => false }) {
    let waiting = null; // { token, code, room }
    let knockBusy = false;

    // Keep the code for the main window. In a room: leave it, then reload the main window.
    async function start(code, roomName, current) {
        waiting = { token: randomUUID(), code, room: roomName };
        if (current !== null) {
            let left = false;
            try { left = await leave(); } catch (err) { log('WARN', `Leave room for a friend invite failed: ${err?.message ?? err}`); }
            if (!left) { waiting = null; return { result: 'failed', room: roomName }; }
            log('INFO', 'Friend invite: left the room, join now');
            reload();
        } else {
            notify();
        }
        show();
        return { result: 'joining', room: roomName };
    }

    return {
        // Join of the invite line id of a friend. leave: the user agreed to leave the current room.
        // Returns { result: 'joining' | 'confirm' | 'busy' | 'expired' | 'wrong-device' | 'wrong-owner' | 'invalid' |
        // 'gone' | 'failed', room, current }.
        async join(friendId, id, leaveFirst = false) {
            const found = links.inviteCode(friendId, id);
            if (found.state !== 'ok') return { result: found.state, room: found.room ?? '' };
            const current = room();
            if (current !== null && !leaveFirst) return { result: 'confirm', room: found.room, current };
            if (busy() || knockBusy) return { result: 'busy', room: found.room };
            return start(found.code, found.room, current);
        },
        // easy-join part 3: Join of a friend row. leave: the user agreed to leave the current room.
        // Returns { result: 'joining' | 'confirm' | 'busy' | 'ask' | 'gone' | 'saved' | 'failed', room, current } or
        // { result: 'knock', outcome: { result, reason? }, room } (no Allow: knockResultText of login-errors.mjs).
        // onState('waiting'): the owner sees the prompt.
        async knock(friendId, leaveFirst = false, { onState = () => {} } = {}) {
            const target = links.joinTarget(friendId);
            if (target.state !== 'ok') return { result: target.state, room: target.room ?? '' };
            if (savedRoom(target.roomId)) return { result: 'saved', room: target.room };
            const current = room();
            if (current !== null && !leaveFirst) return { result: 'confirm', room: target.room, current };
            if (busy() || knockBusy) return { result: 'busy', room: target.room };
            knockBusy = true;
            knocking(true);
            let answer;
            try {
                answer = await links.knock(friendId, { name: name() || '', onState });
            } catch (err) {
                log('WARN', `Friend knock failed: ${err?.message ?? err}`);
                answer = { result: 'offline', room: target.room };
            } finally {
                knockBusy = false;
                knocking(false);
            }
            if (answer.result !== 'allowed') {
                const { room: roomName, ...outcome } = answer;
                return { result: 'knock', outcome, room: roomName || target.room };
            }
            // The room can have ended during the wait (Leave room): then there is nothing to leave.
            return start(answer.invite, answer.room, room());
        },
        // easy-join part 3 (clipboard-join.mjs): the same Join for a code that the main process checked.
        async joinCode(code, codeRoom, leaveFirst = false) {
            const current = room();
            if (current !== null && !leaveFirst) return { result: 'confirm', room: codeRoom, current };
            if (busy() || knockBusy) return { result: 'busy', room: codeRoom };
            return start(code, codeRoom, current);
        },
        // The main window takes the waiting Join one time: { token, room, name }, or null.
        take() {
            if (!waiting || waiting.taken) return null;
            waiting.taken = true;
            return { token: waiting.token, room: waiting.room, name: name() || '' };
        },
        // The login handler: the code of a token, one time. null for an unknown token.
        code(token) {
            if (!waiting || typeof token !== 'string' || token !== waiting.token) return null;
            const code = waiting.code;
            waiting = null;
            return code;
        }
    };
}
