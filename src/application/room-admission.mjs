import { restoreRoomMembership } from '../network/room-membership.mjs';

export function restoreSavedAdmission(row, identity) {
    if (!row.membership) throw new Error('This room\'s saved access is missing. Ask the owner for a new invite.');
    let descriptor;
    try { descriptor = JSON.parse(row.membership); }
    catch { throw new Error('Couldn\'t read this room\'s saved access. Ask the owner for a new invite.'); }
    return restoreRoomMembership({ identity, room: row.name, roomKey: row.roomKey, descriptor });
}

export function joinAdmission(code, identity, saved) {
    const proposed = restoreRoomMembership({ identity, room: code.room, roomKey: code.key, descriptor: code.membership });
    if (!saved?.protected) return proposed;
    const local = restoreSavedAdmission(saved, identity);
    if (local.ownerId !== proposed.ownerId || local.lan !== proposed.lan ||
        local.snapshot().grant?.signature !== proposed.snapshot().grant?.signature || !local.observe(proposed.revocations())) {
        throw new Error('This invite doesn\'t match your saved room.');
    }
    if (local.revoked(identity.id)) throw new Error('You were removed from this room.');
    return local;
}
