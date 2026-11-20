import { restoreRoomMembership } from '../network/room-membership.mjs';

export function restoreSavedAdmission(row, identity) {
    if (!row.membership) throw new Error('This protected room is missing its saved admission. Restore it from a protected profile backup.');
    let descriptor;
    try { descriptor = JSON.parse(row.membership); }
    catch { throw new Error('This protected room’s saved admission could not be read. Restore it from a protected profile backup.'); }
    return restoreRoomMembership({ identity, room: row.name, roomKey: row.roomKey, descriptor });
}

export function joinAdmission(code, identity, saved) {
    const proposed = restoreRoomMembership({ identity, room: code.room, roomKey: code.key, descriptor: code.membership });
    if (!saved?.protected) return proposed;
    const local = restoreSavedAdmission(saved, identity);
    if (local.ownerId !== proposed.ownerId || local.lan !== proposed.lan ||
        local.snapshot().grant?.signature !== proposed.snapshot().grant?.signature || !local.observe(proposed.revocations())) {
        throw new Error('This invite does not match the saved protected room’s owner or device grant.');
    }
    if (local.revoked(identity.id)) throw new Error('This device has been removed from the room.');
    return local;
}
