// Goal G1 (A3, N8): the login error texts. Real errors from readInvite and restoreRoomMembership go into
// loginErrorText. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemberInvite, newRoomKey, readInvite } from '../src/network/invite.mjs';
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs';
import { isAddressInUse, loginErrorText } from '../src/application/login-errors.mjs';

const NOT_INVITE = 'This is not an ASSCRACK invite. Copy the whole code from the person who invited you.';
const INCOMPLETE = 'The invite code is not complete. Copy the whole code again from the person who invited you.';
const OTHER_DEVICE = 'This invite is for a different device. Select “Copy my device ID”, send the ID to the room owner, and ask for a new invite.';

const room = 'Garage';
const roomKey = newRoomKey();
const owner = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey });
const friend = createDeviceIdentity();
const code = makeMemberInvite({ room, key: Buffer.from(roomKey, 'base64url'), nodes: [{ id: '12D3KooWGpponMzJoSX1usSBzTdUmp9iaNvRFkvtJh75io6goVuA', addrs: ['/ip4/203.0.113.5/tcp/47000'] }], membership: owner.issue(friend.id) });

function errorOf(fn) {
    try { fn(); } catch (err) { return err; }
    assert.fail('an error was expected');
}

test('the invite is valid before the changes of the next cases', () => {
    assert.equal(readInvite(code).room, room);
});

test('a cut code gives the incomplete text', () => {
    const err = errorOf(() => readInvite(code.slice(0, Math.floor(code.length / 2))));
    assert.equal(loginErrorText(err), INCOMPLETE, err.message);
});

test('a code with one changed character gives the incomplete text', () => {
    const at = code.length - 10;
    const changed = code.slice(0, at) + (code[at] === 'A' ? 'B' : 'A') + code.slice(at + 1);
    const err = errorOf(() => readInvite(changed));
    assert.equal(loginErrorText(err), INCOMPLETE, err.message);
});

test('a text with no prefix gives the not-an-invite text', () => {
    const err = errorOf(() => readInvite('hello, here is my room'));
    assert.equal(loginErrorText(err), NOT_INVITE, err.message);
});

test('a grant for a different device gives the different-device text', () => {
    const other = createDeviceIdentity();
    const { membership } = readInvite(code);
    const err = errorOf(() => restoreRoomMembership({ identity: other, room, roomKey, descriptor: membership }));
    assert.equal(loginErrorText(err), OTHER_DEVICE, err.message);
});

test('EADDRINUSE in a cause gives the port text', () => {
    const err = new Error('listen failed', { cause: { code: 'EADDRINUSE' } });
    assert.equal(isAddressInUse(err), true);
    assert.equal(loginErrorText(err, { port: 47000 }),
        'Port 47000 is in use on this computer. Close the other program or the other ASSCRACK, or use a different port.');
});

test('the version, public address and other texts', () => {
    assert.equal(loginErrorText(new Error('The invite code has an unknown version')),
        'This invite comes from a different ASSCRACK version. You and the room owner must use the same version.');
    assert.equal(loginErrorText(new Error('The public address must be <IPv4>:<port>')),
        'Write the public address as IP:port, for example 203.0.113.5:47000.');
    assert.equal(loginErrorText(new Error('Enter a username of up to 64 characters.')), 'Enter a username of up to 64 characters.');
});
