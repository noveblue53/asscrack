// Goal easy-join part 1: Join of a friend invite (friend-invite.mjs). This module does not import electron.
// The friend chat window gives the line ID of an invite card. The main process keeps the code: the main window gets
// only a one-time token, and the login handler changes the token back to the code (the same path as a pasted code).
// In a room, Join first asks "Leave <room> and join?" (the result 'confirm'), then leaves the room and reloads the
// main window. The main window takes the waiting Join at its start (take()), or at the event 'asscrack:friend-join'.
import { randomUUID } from 'node:crypto';

// links: friendLinks. room(): the name of the current room, or null on the login screen. busy(): a login or a Leave
// room runs now. leave(): Leave room, resolves true when the room ended (main.js leaveRoom()). reload(): reload the main
// window. show(): show the main window. notify(): tell the main window that a Join waits. name(): the name for friends.
export function createFriendJoins({ links, room, busy = () => false, leave, reload, show = () => {}, notify = () => {},
    name = () => '', log = () => {} }) {
    let waiting = null; // { token, code, room }

    async function start(code, codeRoom, leaveFirst) {
        const current = room();
        if (current !== null && !leaveFirst) return { result: 'confirm', room: codeRoom, current };
        if (busy()) return { result: 'busy', room: codeRoom };
        waiting = { token: randomUUID(), code, room: codeRoom };
        if (current !== null) {
            let left = false;
            try { left = await leave(); } catch (err) { log('WARN', `Leave room for a friend invite failed: ${err?.message ?? err}`); }
            if (!left) { waiting = null; return { result: 'failed', room: codeRoom }; }
            log('INFO', 'Friend invite: left the room, join now');
            reload();
        } else {
            notify();
        }
        show();
        return { result: 'joining', room: codeRoom };
    }

    return {
        // Join of the invite line id of a friend. leave: the user agreed to leave the current room.
        // Returns { result: 'joining' | 'confirm' | 'busy' | 'expired' | 'wrong-device' | 'wrong-owner' | 'invalid' |
        // 'gone' | 'failed', room, current }.
        async join(friendId, id, leaveFirst = false) {
            const found = links.inviteCode(friendId, id);
            if (found.state !== 'ok') return { result: found.state, room: found.room ?? '' };
            return start(found.code, found.room, leaveFirst);
        },
        // easy-join part 3 (clipboard-join.mjs): the same Join for a code that the main process checked.
        joinCode: (code, codeRoom, leaveFirst = false) => start(code, codeRoom, leaveFirst),
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
