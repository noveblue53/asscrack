// Goal easy-join part 1: the friend invite. The owner of a running protected room sends a device invite to a friend on
// the friend link (or the offline queue of G7b). The friend selects Join, and the app uses the code with no paste.
// Wire line (private-messages.mjs): { type: 'pm', v: 1, op: 'invite', id, code, time, away }. The id has the same form
// as a message id ('<device ID>.<uuid>'), thus the ack, the repeat check and the outbox work as for a message.
// The archive keeps an invite line (messages and friend_outbox) as a text with INVITE_MARK + code. Only this module and
// friend-links.mjs read that text. A window never gets the code: it gets inviteView() (the room name and a state).
// This module does not import electron.
import { readInvite, COMPACT_INVITE_PREFIX } from '../network/invite.mjs';
import { INVITE_EXPIRED } from '../network/room-membership.mjs';
import { PM_MAX_TEXT } from '../network/private-messages.mjs';

// A control character starts the stored text. The composer of the friend chat never sends it (friend-links.mjs refuses
// a typed text with the mark), and a received 'msg' text with the mark loses the mark (plainText()).
export const INVITE_MARK = '\u0001invite:';
export const MAX_INVITE_CODE = PM_MAX_TEXT - INVITE_MARK.length;

export const isInviteText = text => typeof text === 'string' && text.startsWith(INVITE_MARK);
export const inviteText = code => INVITE_MARK + code;
export const inviteCodeOf = text => (isInviteText(text) ? text.slice(INVITE_MARK.length) : null);
// A received 'msg' text that starts with the mark is a plain message: remove the control character.
export const plainText = text => (isInviteText(text) ? text.slice(1) : text);

// The form of a code on the wire: only a compact protected room code ("asscrack3:"), at most MAX_INVITE_CODE characters.
export function validInviteCode(code) {
    return typeof code === 'string' && code.length > COMPACT_INVITE_PREFIX.length && code.length <= MAX_INVITE_CODE &&
        code.startsWith(COMPACT_INVITE_PREFIX) && /^[A-Za-z0-9_-]+$/.test(code.slice(COMPACT_INVITE_PREFIX.length));
}

// The check of the receiver. selfId: the device ID of this device (identity.id). friendDevice: the device ID of the
// friend that sent the invite. Returns { state, room }:
//   'ok'           the invite is for this device, from the owner device of the friend, and not expired
//   'expired'      the L4 expiry (with the grace time of readInvite) is past
//   'wrong-device' the grant is for a different device
//   'wrong-owner'  the owner of the room is not the friend that sent it (a forwarded invite of a third person)
//   'invalid'      the code is damaged, or it is not a protected room code
export function checkInvite(code, { selfId, friendDevice }) {
    if (!validInviteCode(code)) return { state: 'invalid', room: '' };
    let invite;
    try {
        invite = readInvite(code);
    } catch (err) {
        return { state: err?.message === INVITE_EXPIRED ? 'expired' : 'invalid', room: '' };
    }
    const room = invite.room;
    const membership = invite.membership;
    if (!membership?.grant) return { state: 'invalid', room };
    if (membership.grant.deviceId !== selfId) return { state: 'wrong-device', room };
    if (membership.owner !== friendDevice) return { state: 'wrong-owner', room };
    return { state: 'ok', room, lan: membership.lan === true, expires: membership.grant.expires };
}

// The view of a sent invite (the own line): the room name and 'sent' or 'expired'. The code was made on this device.
export function ownInviteView(code) {
    if (!validInviteCode(code)) return { state: 'invalid', room: '' };
    try {
        return { state: 'sent', room: readInvite(code).room };
    } catch (err) {
        return { state: err?.message === INVITE_EXPIRED ? 'expired' : 'invalid', room: '' };
    }
}

// The line for a window: the text of an invite line is replaced by the view. Other lines do not change.
export function windowLine(line, check) {
    const code = inviteCodeOf(line?.text);
    if (code === null) return line;
    const view = line.own ? ownInviteView(code) : check(code);
    return { ...line, text: '', invite: { state: view.state, room: view.room } };
}
