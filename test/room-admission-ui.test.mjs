import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs';
import { joinAdmission, restoreSavedAdmission } from '../src/application/room-admission.mjs';

const loginControls = [
    { id: 'upnp-field' }, { id: 'allow-upnp', tag: 'input' }, { id: 'legacy-consent' }, { id: 'allow-legacy', tag: 'input' }
];
const accessControls = [
    { id: 'copy-device-id', tag: 'button' }, { id: 'device-id-note' }, { id: 'room-access-status' },
    { id: 'member-invite-form', tag: 'form' }, { id: 'member-device-id', tag: 'input' },
    { id: 'member-can-host', tag: 'input' }, { id: 'member-invite-create', tag: 'button' },
    { id: 'invite-code-label' }, { id: 'room-members-section' }, { id: 'room-members', tag: 'ul' }, { id: 'waiting-peer' }
];

function choose(room, type) {
    room.el('room-type').value = type;
    room.el('room-type').dispatchEvent(new room.Event('change'));
}

test('login starts with protected internet, asks for explicit UPnP on create and join, and suppresses it for LAN and a typed address', async () => {
    const options = [];
    for (const [type, typedAddress, checked] of [['new', '', false], ['new', '', true], ['new', '127.0.0.1:9000', true], ['join', '', false], ['join', '', true], ['join', '127.0.0.1:9000', true], ['lan', '', true]]) {
        const room = await loadRoomWindow({ elements: loginControls });
        room.window.asscrack.login = async value => { options.push(value); return { room: 'test', internet: type !== 'lan' }; };
        assert.equal(room.el('room-type').value, 'new');
        choose(room, type);
        if (type === 'join') {
            room.el('invite-input').value = 'asscrack2:device-bound';
            room.el('invite-input').dispatchEvent(new room.Event('input'));
        }
        room.el('public-address').value = typedAddress;
        room.el('public-address').dispatchEvent(new room.Event('input'));
        room.el('allow-upnp').checked = checked;
        assert.equal(room.el('upnp-field').hidden, type === 'lan');
        assert.equal(room.el('allow-upnp').disabled, Boolean(typedAddress));
        await room.login('John');
    }
    assert.deepEqual(options.map(value => [value.type, value.allowUpnp, value.publicAddress]), [
        ['new', false, undefined], ['new', true, undefined], ['new', false, '127.0.0.1:9000'],
        ['join', false, undefined], ['join', true, undefined], ['join', false, '127.0.0.1:9000'],
        ['lan', undefined, undefined]
    ]);
});

test('a modified legacy code requires fresh affirmative trust and protected invites omit that consent', async () => {
    const room = await loadRoomWindow({ elements: loginControls });
    choose(room, 'join');
    const invite = room.el('invite-input');
    const consent = room.el('allow-legacy');
    let loggedIn;
    room.window.asscrack.login = async data => { loggedIn = data; return { room: 'test', internet: true }; };
    invite.value = 'asscrack1:legacy-one';
    invite.dispatchEvent(new room.Event('input'));
    assert.equal(room.el('legacy-consent').hidden, false);
    await room.login('Laptop');
    assert.equal(loggedIn, undefined);
    assert.match(room.el('status').textContent, /I trust everyone with this code/);
    consent.checked = true;
    invite.value = 'asscrack1:legacy-two';
    invite.dispatchEvent(new room.Event('input'));
    assert.equal(consent.checked, false);
    invite.value = 'asscrack2:device-bound';
    invite.dispatchEvent(new room.Event('input'));
    assert.equal(room.el('legacy-consent').hidden, true);
    await room.login('Laptop');
    assert.equal(loggedIn.invite, invite.value);
    assert.equal(loggedIn.allowLegacy, false);
});

test('an owner creates a device invite and must confirm revocation of its exact recipient', async () => {
    const room = await loadRoomWindow({ scripts: ['room-membership-ui.js'], elements: accessControls });
    const id = 'a'.repeat(43);
    const base = { protected: true, owner: true, admitted: true, lan: true, members: [] };
    const invites = [], revocations = [];
    room.window.asscrack.createMemberInvite = async (...args) => {
        invites.push(args);
        room.handlers.onMembership({ ...base, members: [{ deviceId: id, canHost: true, revoked: false }] });
        return 'asscrack2:grant';
    };
    room.window.asscrack.revokeMember = async deviceId => {
        revocations.push(deviceId);
        room.handlers.onMembership({ ...base, members: [{ deviceId: id, canHost: true, revoked: true }] });
        return true;
    };
    room.window.roomMembership.start(base);
    assert.equal(room.el('invite-code').hidden, true);
    const field = room.el('member-device-id');
    field.value = id;
    room.el('member-can-host').checked = true;
    room.el('member-invite-form').dispatchEvent(new room.Event('submit'));
    await settle();
    assert.deepEqual(invites, [[id, true]]);
    assert.equal(room.el('invite-code').value, 'asscrack2:grant');
    room.el('room-members').querySelector('button').click();
    assert.deepEqual(revocations, []);
    const confirmation = room.el('room-members').querySelector('button');
    assert.equal(confirmation.textContent, 'Remove');
    assert.equal(confirmation.className, 'btn-danger');
    confirmation.click();
    await settle();
    assert.deepEqual(revocations, [id]);
    assert.equal(room.el('invite-code').value, '');
    assert.match(room.el('room-members').textContent, /Removed/);
});

test('a saved admission survives a stale invite and rejects conflicts or a missing protected snapshot', () => {
    const room = 'test';
    const key = Buffer.alloc(32, 1).toString('base64url');
    const device = createDeviceIdentity();
    const owner = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey: key, lan: true });
    const stale = owner.issue(device.id);
    const member = restoreRoomMembership({ identity: device, room, roomKey: key, descriptor: stale });
    const signedReceipt = owner.admit({ deviceId: device.id, grant: stale.grant });
    assert.equal(member.acceptAdmission(signedReceipt), true);
    const other = createDeviceIdentity();
    owner.issue(other.id);
    assert.equal(owner.revoke(other.id), true);
    assert.equal(member.observe(owner.revocations()), true);
    const saved = { protected: true, name: room, roomKey: key, membership: JSON.stringify(member.snapshot()) };
    const code = { room, key, membership: stale };
    const joined = joinAdmission(code, device, saved);
    assert.equal(joined.admitted(), true);
    assert.equal(joined.revoked(other.id), true);
    assert.deepEqual(joined.revocations(), owner.revocations());
    const differentOwner = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey: key, lan: true });
    assert.throws(() => joinAdmission({ ...code, membership: differentOwner.issue(device.id) }, device, saved), /doesn't match/);
    assert.throws(() => restoreSavedAdmission({ ...saved, membership: null }, device), /saved access is missing/);
    assert.equal(owner.revoke(device.id), true);
    const revoked = { ...stale, revocations: owner.revocations() };
    assert.throws(() => joinAdmission({ ...code, membership: revoked }, device, saved), /removed from (this|the) room/);
});
