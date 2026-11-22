// Goal G1 (A3, N8): the login error texts. Real errors from readInvite and restoreRoomMembership go into
// loginErrorText. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemberInvite, newRoomKey, readInvite } from '../src/network/invite.mjs';
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs';
import { isAddressInUse, loginErrorText } from '../src/application/login-errors.mjs';

const NOT_INVITE = 'Not a valid invite code.';
const INCOMPLETE = 'Invite code is incomplete. Copy all of it.';
const OTHER_DEVICE = 'This invite is for another device. Send the owner your device ID.';

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
        'Port 47000 is in use. Close the other app or choose another port.');
});

test('the version, public address and other texts', () => {
    assert.equal(loginErrorText(new Error('The invite code has an unknown version')),
        'This invite is from another app version. Both of you need the latest update.');
    assert.equal(loginErrorText(new Error('The public address must be <IPv4>:<port>')),
        'Use IP:port, for example 203.0.113.5:47000.');
    assert.equal(loginErrorText(new Error('Enter a username of up to 64 characters.')), 'Enter a username of up to 64 characters.');
});

// OI1 (P10b): libp2p gives UnsupportedListenAddressesError with no code, no cause and no errors when the port is in
// use. The message has the text EADDRINUSE. The retry with port 0 of a saved UPnP port (main.js) needs true here.
test('OI1: the libp2p error of a node on a port in use makes isAddressInUse true', { timeout: 20000 }, async () => {
    const { createServer } = await import('node:net');
    const { createAsscrackNode } = await import('../src/network/node.mjs');
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    let err = null;
    try {
        const node = await createAsscrackNode({ room: 'oi1', listen: [`/ip4/127.0.0.1/tcp/${port}`], discovery: false });
        await node.stop();
    } catch (e) { err = e; } finally { await new Promise(resolve => server.close(resolve)); }
    assert.ok(err, 'the node must not start on a port in use');
    assert.equal(err.code, undefined, 'the libp2p error has no code (the case of OI1)');
    assert.equal(isAddressInUse(err), true, `${err.name}: ${err.message}`);
    assert.match(loginErrorText(err, { port }), new RegExp(`^Port ${port} is in use\\.`));
});

test('OI1: the libp2p name alone, with no EADDRINUSE in the message, is not a port in use', () => {
    const err = Object.assign(new Error('Some listen addresses are not supported'), { name: 'UnsupportedListenAddressesError' });
    assert.equal(isAddressInUse(err), false);
});
