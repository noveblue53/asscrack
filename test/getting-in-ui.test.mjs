// Goal G1 (getting in): behavior of the login card, the Invite panel of the owner and the status bar item.
// The real window scripts run in the fake DOM of renderer-fixture.mjs. No network, no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const loginControls = [
    { id: 'upnp-field' }, { id: 'allow-upnp', tag: 'input' }, { id: 'upnp-off-note', tag: 'p' },
    { id: 'legacy-consent' }, { id: 'allow-legacy', tag: 'input' }
];
const accessControls = [
    { id: 'copy-device-id', tag: 'button' }, { id: 'device-id-note' }, { id: 'room-access-status' },
    { id: 'reach-box', children: [{ id: 'reach-note', tag: 'p' }, { id: 'reach-upnp', tag: 'button' }, { id: 'reach-reason', tag: 'p' }] },
    { id: 'member-invite-form', tag: 'form' }, { id: 'member-device-id', tag: 'input' },
    { id: 'member-can-host', tag: 'input' }, { id: 'member-invite-create', tag: 'button' },
    { id: 'invite-code-label' }, { id: 'room-members-section' }, { id: 'room-members', tag: 'ul' }, { id: 'waiting-peer' },
    { id: 'map-upnp-box', children: [{ id: 'map-upnp', tag: 'button' }, { id: 'map-upnp-note', tag: 'span' }] }
];
const savedControls = [
    { id: 'save-room-fields', children: [
        { id: 'save-room', tag: 'input' }, { id: 'keep-history', tag: 'input' }, { id: 'save-off-note', tag: 'p' }
    ] },
    { id: 'saved-rooms-section', children: [{ id: 'saved-rooms', tag: 'ul' }] },
    { id: 'archive-state', tag: 'p' }, { id: 'archive-unlock', tag: 'button' },
    { id: 'room-storage', children: [
        { id: 'room-keep-history', tag: 'input' }, { id: 'history-state' }, { id: 'clear-history', tag: 'button' },
        { id: 'clear-confirm', children: [{ id: 'clear-confirm-yes', tag: 'button' }, { id: 'clear-confirm-no', tag: 'button' }] }
    ] },
    { id: 'history-toggle', tag: 'button' }
];

const STARTING = 'Starting the room…';

function choose(room, type) {
    room.el('room-type').value = type;
    room.el('room-type').dispatchEvent(new room.Event('change'));
}

// A protected internet room after the login. reach: the answer of asscrack:invite. owner: this device owns it.
async function startRoom({ reach, owner = true, lan = false, fullNode = { self: false, peers: [] } } = {}) {
    const room = await loadRoomWindow({ scripts: ['room-membership-ui.js'], elements: [...loginControls, ...accessControls] });
    const membership = { protected: true, owner, admitted: true, lan, members: [] };
    const state = { reach };
    room.window.asscrack.login = async () => ({ room: 'test', internet: !lan, membership });
    room.window.asscrack.getInvite = async () => ({ membership, reach: state.reach });
    room.window.asscrack.getFullNode = async () => fullNode;
    await room.login('Ann');
    await settle();
    return { room, state };
}

// UI copy pass (U2): the reach is a dot (data-reach) and a short label; a router failure gives one line under the
// UPnP button (#reach-reason).
const NONE = 'Not reachable';
for (const [name, reach, text, button, canInvite, dot = '', reason = ''] of [
    ['ready and proven', { state: 'ready', reason: null, proven: true }, '', '', true],
    ['ready, not proven', { state: 'ready', reason: null, proven: false }, 'Not tested', '', true, 'none'],
    ['upnp-wait', { state: 'upnp-wait', reason: null, proven: false }, 'Opening port…', '', false, 'busy'],
    ['upnp-failed, no-gateway', { state: 'upnp-failed', reason: 'no-gateway', proven: false }, NONE, 'Try UPnP again', false, 'bad',
        'Router didn\'t respond. Turn on UPnP in your router or forward a TCP port.'],
    ['upnp-failed, private-ip', { state: 'upnp-failed', reason: 'private-ip', proven: false }, NONE, 'Try UPnP again', false, 'bad',
        'Your router has no public IP. Ask a friend with an open port to create the room.'],
    ['upnp-failed, timeout', { state: 'upnp-failed', reason: 'timeout', proven: false }, NONE, 'Try UPnP again', false, 'bad',
        'Router refused to open a port.'],
    ['none', { state: 'none', reason: null, proven: false }, NONE, 'Open port (UPnP)', false, 'bad']
]) {
    test(`the Invite panel of the owner for the reach state ${name}`, async () => {
        const { room } = await startRoom({ reach });
        assert.equal(room.el('reach-box').hidden, text === '');
        assert.equal(room.el('reach-note').textContent, text);
        assert.equal(room.el('reach-note').dataset.reach, dot);
        assert.equal(room.el('reach-reason').textContent, reason);
        assert.equal(room.el('reach-reason').hidden, reason === '');
        assert.equal(room.el('reach-upnp').hidden, button === '');
        assert.equal(room.el('reach-upnp').textContent, button);
        assert.equal(room.el('member-invite-create').disabled, !canInvite);
        assert.deepEqual(room.errors, []);
    });
}

test('a LAN room has no reach note and permits a device invite', async () => {
    const { room } = await startRoom({ reach: { state: 'lan', reason: null, proven: false }, lan: true });
    assert.equal(room.el('reach-box').hidden, true);
    assert.equal(room.el('member-invite-create').disabled, false);
});

test('a member that is not the owner gets no reach note', async () => {
    const { room } = await startRoom({ reach: { state: 'none', reason: null, proven: false }, owner: false });
    assert.equal(room.el('reach-box').hidden, true);
});

test('a member in an internet room can open a port with UPnP from the Network map panel', async () => {
    const { room, state } = await startRoom({
        reach: { state: 'none', reason: null, proven: false },
        owner: false
    });
    assert.equal(room.el('map-upnp-box').hidden, false);
    assert.equal(room.el('map-upnp').textContent, 'Open port (UPnP)');
    assert.equal(room.el('map-upnp-note').hidden, true);
    let calls = 0;
    room.window.asscrack.enableUpnp = async () => {
        calls++;
        state.reach = { state: 'upnp-wait', reason: null, proven: false };
        return { started: true, reach: state.reach };
    };
    room.el('map-upnp').click();
    await settle();
    assert.equal(calls, 1);
    assert.equal(room.el('map-upnp').textContent, 'Opening port…');
    assert.equal(room.el('map-upnp').disabled, true);
    state.reach = { state: 'upnp-failed', reason: 'no-gateway', proven: false };
    room.handlers.onUpnp({ state: 'none', reason: 'no-gateway' });
    await settle();
    assert.equal(room.el('map-upnp').disabled, false);
    assert.equal(room.el('map-upnp').textContent, 'Try UPnP again');
    assert.equal(room.el('map-upnp-note').hidden, false);
    assert.equal(room.el('map-upnp-note').textContent, 'Router didn\'t respond.');
    state.reach = { state: 'ready', reason: null, proven: false, dialback: 'idle', dialbackReason: null };
    room.handlers.onUpnp({ state: 'mapped' });
    await settle();
    assert.equal(room.el('map-upnp-box').hidden, false);
    assert.equal(room.el('map-upnp').hidden, true);
    assert.equal(room.el('map-upnp-note').hidden, false);
    assert.equal(room.el('map-upnp-note').textContent, 'Port opened. Checks when a peer joins.');
});

test('the Network map UPnP box stays hidden when already reachable without clicking Open port', async () => {
    const readyRoom = await startRoom({
        reach: { state: 'ready', reason: null, proven: false, dialback: 'idle', dialbackReason: null },
        owner: false
    });
    assert.equal(readyRoom.room.el('map-upnp-box').hidden, true);

    const fullRoom = await startRoom({
        reach: { state: 'ready', reason: null, proven: true, dialback: 'ok', dialbackReason: null },
        fullNode: { self: true, peers: [] },
        owner: false
    });
    assert.equal(fullRoom.room.el('map-upnp-box').hidden, true);
});

test('the Network map panel shows dial-back checking, failure with Check again, and full node confirmation', async () => {
    const { room, state } = await startRoom({
        reach: { state: 'none', reason: null, proven: false, dialback: 'idle', dialbackReason: null },
        owner: false
    });
    let calls = 0;
    room.window.asscrack.enableUpnp = async () => {
        calls++;
        state.reach = state.reach.state === 'ready'
            ? { state: 'ready', reason: null, proven: false, dialback: 'checking', dialbackReason: null }
            : { state: 'upnp-wait', reason: null, proven: false, dialback: 'idle', dialbackReason: null };
        return { started: true, reach: state.reach };
    };
    room.el('map-upnp').click();
    await settle();
    assert.equal(calls, 1);

    state.reach = { state: 'ready', reason: null, proven: false, dialback: 'checking', dialbackReason: null };
    room.handlers.onUpnp({ state: 'mapped' });
    await settle();
    assert.equal(room.el('map-upnp-box').hidden, false);
    assert.equal(room.el('map-upnp').hidden, true);
    assert.equal(room.el('map-upnp-note').textContent, 'Port opened. Checking full node…');

    state.reach = { state: 'ready', reason: null, proven: false, dialback: 'failed', dialbackReason: 'unreachable' };
    room.handlers.onDialback({ state: 'failed', reason: 'unreachable' });
    await settle();
    assert.equal(room.el('map-upnp').hidden, false);
    assert.equal(room.el('map-upnp').textContent, 'Check again');
    assert.equal(room.el('map-upnp-note').dataset.state, 'warn');
    assert.equal(room.el('map-upnp-note').textContent, 'Port opened, but peers couldn\'t reach it. Not a full node.');

    state.reach = { state: 'ready', reason: null, proven: false, dialback: 'failed', dialbackReason: 'private-ip' };
    room.handlers.onDialback({ state: 'failed', reason: 'private-ip' });
    await settle();
    assert.equal(room.el('map-upnp-note').textContent, 'Port opened, but public IP couldn\'t be verified. Not a full node.');

    room.el('map-upnp').click();
    await settle();
    assert.equal(calls, 2);
    assert.equal(room.el('map-upnp-note').textContent, 'Port opened. Checking full node…');

    state.reach = { state: 'ready', reason: null, proven: true, dialback: 'ok', dialbackReason: null };
    room.window.asscrack.getFullNode = async () => ({ self: true, peers: [] });
    room.handlers.onFullNode({ peerId: 'self-peer-id', fullNode: true });
    await settle();
    assert.equal(room.el('map-upnp-box').hidden, false);
    assert.equal(room.el('map-upnp').hidden, true);
    assert.equal(room.el('map-upnp-note').dataset.state, 'ok');
    assert.equal(room.el('map-upnp-note').textContent, 'Port open — full node active.');
});

test('the Network map panel shows waiting for a direct peer when mapped with peers present', async () => {
    const { room, state } = await startRoom({
        reach: { state: 'none', reason: null, proven: false, dialback: 'idle', dialbackReason: null },
        owner: false
    });
    room.handlers.onPeerName({ peerId: PEER, name: 'Bob' });
    room.handlers.onPeerJoined({ peerId: PEER });
    room.window.asscrack.enableUpnp = async () => {
        state.reach = { state: 'ready', reason: null, proven: false, dialback: 'idle', dialbackReason: null };
        return { started: true, reach: state.reach };
    };
    room.el('map-upnp').click();
    await settle();
    assert.equal(room.el('map-upnp-box').hidden, false);
    assert.equal(room.el('map-upnp').hidden, true);
    assert.equal(room.el('map-upnp-note').textContent, 'Port opened. Waiting for a direct peer to check.');
});

test('background UPnP failure stays silent in the Network map panel until the user clicks Open port (UPnP)', async () => {
    const { room, state } = await startRoom({
        reach: { state: 'upnp-failed', reason: 'no-gateway', proven: false },
        owner: false
    });
    assert.equal(room.el('map-upnp-box').hidden, false);
    assert.equal(room.el('map-upnp').textContent, 'Open port (UPnP)');
    assert.equal(room.el('map-upnp-note').hidden, true);
    let calls = 0;
    room.window.asscrack.enableUpnp = async () => {
        calls++;
        state.reach = { state: 'upnp-failed', reason: 'no-gateway', proven: false };
        return { started: true, reach: state.reach };
    };
    room.el('map-upnp').click();
    await settle();
    assert.equal(calls, 1);
    assert.equal(room.el('map-upnp').textContent, 'Try UPnP again');
    assert.equal(room.el('map-upnp-note').hidden, false);
    assert.equal(room.el('map-upnp-note').textContent, 'Router didn\'t respond.');
});

test('the UPnP button calls enableUpnp and the panel shows the wait text', async () => {
    const { room, state } = await startRoom({ reach: { state: 'none', reason: null, proven: false } });
    let calls = 0;
    room.window.asscrack.enableUpnp = async () => {
        calls++;
        state.reach = { state: 'upnp-wait', reason: null, proven: false };
        return { started: true, reach: state.reach };
    };
    room.el('reach-upnp').click();
    await settle();
    assert.equal(calls, 1);
    assert.equal(room.el('reach-note').textContent, 'Opening port…');
    assert.equal(room.el('reach-upnp').hidden, true);
    assert.equal(room.el('member-invite-create').disabled, true);
    assert.equal(room.el('full-node-state').textContent, 'Opening port…');
    // The mapping comes: the upnp event refreshes the panel.
    state.reach = { state: 'ready', reason: null, proven: false };
    room.handlers.onUpnp({ state: 'mapped' });
    await settle();
    assert.equal(room.el('member-invite-create').disabled, false);
    assert.equal(room.el('full-node-state').textContent, 'Not tested');
});

test('a device invite shows the label "Invite code", and the button keeps the reach rule', async () => {
    const { room } = await startRoom({ reach: { state: 'ready', reason: null, proven: true } });
    room.window.asscrack.createMemberInvite = async () => 'asscrack2:grant';
    room.el('member-device-id').value = 'a'.repeat(43);
    room.el('member-invite-form').dispatchEvent(new room.Event('submit'));
    await settle();
    assert.equal(room.el('invite-code-label').textContent, 'Invite code');
    assert.equal(room.el('invite-code').value, 'asscrack2:grant');
    assert.equal(room.el('member-invite-create').disabled, false);
});

const PEER = '12D3KooWGpponMzJoSX1usSBzTdUmp9iaNvRFkvtJh75io6goVuA';
const OTHER = '12D3KooWLMoahvBGRgYnC9FQ3WNKLUzGYaRfMkArribPUzxrxE8t';
for (const [name, options, peers, text, tip, warn, dot] of [
    ['this computer is a full node', { reach: { state: 'ready', reason: null, proven: true }, fullNode: { self: true, peers: [] } }, [],
        'Reachable', 'Others connect to this PC directly. It can relay.', false, 'ok'],
    ['a connected peer is a full node', { reach: { state: 'none', reason: null, proven: false }, fullNode: { self: false, peers: [PEER] } }, [PEER],
        'Via Bob', 'New members connect through Bob', false, 'ok'],
    ['the address is ready and not proven', { reach: { state: 'ready', reason: null, proven: false } }, [],
        'Not tested', 'Checked when the first friend joins', false, 'none'],
    ['the router is asked', { reach: { state: 'upnp-wait', reason: null, proven: false } }, [], 'Opening port…', '', false, 'busy'],
    ['no address and 1 peer', { reach: { state: 'upnp-failed', reason: 'no-gateway', proven: false } }, [OTHER], 'No open port',
        'New members from the internet can\'t join', false, 'warn'],
    ['no address, no peer, owner', { reach: { state: 'none', reason: null, proven: false } }, [],
        'Not reachable', 'See Invite', true, 'bad']
]) {
    test(`the status bar item when ${name}`, async () => {
        const { room } = await startRoom(options);
        for (const peerId of peers) {
            room.handlers.onPeerName({ peerId, name: 'Bob' });
            room.handlers.onPeerJoined({ peerId });
        }
        await settle();
        const item = room.el('full-node-state');
        assert.equal(item.hidden, false);
        assert.equal(item.textContent, text);
        assert.equal(item.title, tip);
        assert.equal(item.dataset.state === 'warn', warn);
        assert.equal(item.dataset.reach, dot);
    });
}

test('the status bar item is hidden for a member with no address and no peer, and in a LAN room', async () => {
    const member = await startRoom({ reach: { state: 'none', reason: null, proven: false }, owner: false });
    assert.equal(member.room.el('full-node-state').hidden, true);
    const lan = await startRoom({ reach: { state: 'lan', reason: null, proven: false }, lan: true });
    assert.equal(lan.room.el('full-node-state').hidden, true);
});

test('the login button names the room type and says that the room starts while the login runs', async () => {
    const room = await loadRoomWindow({ elements: loginControls });
    const labels = [];
    for (const type of ['new', 'join', 'lan']) {
        choose(room, type);
        labels.push(room.el('login').textContent);
    }
    assert.deepEqual(labels, ['Create room', 'Join room', 'Create LAN room']);
    let fail;
    room.window.asscrack.login = () => new Promise((_resolve, reject) => { fail = reject; });
    choose(room, 'new');
    room.el('username').value = 'Ann';
    room.el('room').value = 'Garage';
    room.el('login').click();
    await settle();
    assert.equal(room.el('login').textContent, STARTING);
    assert.equal(room.el('login').disabled, true);
    fail(new Error("Error invoking remote method 'asscrack:login': Error: Port 47000 is in use on this computer."));
    await settle();
    assert.equal(room.el('login').textContent, 'Create room');
    assert.equal(room.el('login').disabled, false);
    assert.equal(room.el('status').textContent, 'Port 47000 is in use on this computer.');
    assert.equal(room.el('status').classList.contains('error'), true, 'the error class makes the text red');
});

test('Enter with no Shift in the invite box logs in', async () => {
    const room = await loadRoomWindow({ elements: loginControls });
    const logins = [];
    room.window.asscrack.login = async options => { logins.push(options); throw new Error('stop'); };
    choose(room, 'join');
    room.el('username').value = 'Ann';
    const box = room.el('invite-input');
    box.value = 'asscrack2:code';
    assert.equal(room.key(box, 'Enter', { shiftKey: true }).defaultPrevented, false);
    await settle();
    assert.equal(logins.length, 0);
    assert.equal(room.key(box, 'Enter').defaultPrevented, true);
    await settle();
    assert.equal(logins.length, 1);
    assert.equal(logins[0].invite, 'asscrack2:code');
});

test('the device ID button copies the ID, selects the join type and puts the focus in the invite box', async () => {
    const room = await loadRoomWindow({ scripts: ['room-membership-ui.js'], elements: [...loginControls, ...accessControls] });
    room.window.asscrack.getDeviceId = async () => 'device-id-1';
    assert.equal(room.el('room-type').value, 'new');
    room.el('copy-device-id').click();
    await settle();
    assert.deepEqual(room.calls.filter(c => c.name === 'copyText').map(c => c.args[0]), ['device-id-1']);
    assert.equal(room.el('room-type').value, 'join');
    assert.equal(room.el('invite-field').hidden, false);
    assert.equal(room.el('login').textContent, 'Join room');
    assert.equal(room.document.activeElement, room.el('invite-input'));
    assert.equal(room.el('device-id-note').textContent, 'Copied. Send it to the room owner.');
});

test('the user name of the last successful login comes back from localStorage', async () => {
    const store = new Map([['asscrack.userName.v1', 'Ann']]);
    const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
    const room = await loadRoomWindow({ elements: loginControls, localStorage });
    assert.equal(room.el('username').value, 'Ann');
    room.window.asscrack.login = async () => { throw new Error('no'); };
    await room.login('Bea');
    assert.equal(store.get('asscrack.userName.v1'), 'Ann', 'a failed login does not save the name');
    room.window.asscrack.login = async () => ({ room: 'test', internet: false });
    await room.login('Cid');
    assert.equal(store.get('asscrack.userName.v1'), 'Cid');
    const next = await loadRoomWindow({ elements: loginControls, localStorage: { getItem() { throw new Error('denied'); } } });
    assert.equal(next.el('username').value, '');
});

test('the UPnP note of the login card shows only for an internet room with no address and no UPnP', async () => {
    const room = await loadRoomWindow({ elements: loginControls });
    const note = room.el('upnp-off-note');
    assert.equal(room.el('allow-upnp').checked, true);
    assert.equal(note.hidden, true);
    room.el('allow-upnp').checked = false;
    room.el('allow-upnp').dispatchEvent(new room.Event('change'));
    assert.equal(note.hidden, false);
    room.el('allow-upnp').checked = true;
    room.el('allow-upnp').dispatchEvent(new room.Event('change'));
    assert.equal(note.hidden, true);
    room.el('allow-upnp').checked = false;
    room.el('allow-upnp').dispatchEvent(new room.Event('change'));
    room.el('public-address').value = '203.0.113.5:47000';
    room.el('public-address').dispatchEvent(new room.Event('input'));
    assert.equal(note.hidden, true);
    room.el('public-address').value = '';
    room.el('public-address').dispatchEvent(new room.Event('input'));
    assert.equal(note.hidden, false);
    choose(room, 'lan');
    assert.equal(note.hidden, true);
});

test('window.autoUpnp syncs Open port automatically with the login checkbox and Settings menu', async () => {
    let saved = false;
    const setCalls = [];
    const room = await loadRoomWindow({
        elements: [...loginControls, { id: 'view-auto-upnp' }],
        api: {
            getAutoUpnp: async () => ({ enabled: saved }),
            setAutoUpnp: async value => {
                setCalls.push(value);
                saved = value;
                return { enabled: saved };
            }
        }
    });
    await settle();
    assert.equal(room.window.autoUpnp.state().enabled, false);
    assert.equal(room.el('view-auto-upnp').getAttribute('aria-checked'), 'false');
    assert.equal(room.el('allow-upnp').checked, false);
    // Manual edit on the login checkbox is preserved against background events.
    room.el('allow-upnp').checked = true;
    room.el('allow-upnp').dispatchEvent(new room.Event('change'));
    room.handlers.onAutoUpnp({ enabled: false });
    assert.equal(room.el('allow-upnp').checked, true);
    // Explicit toggle resets touched state and syncs both controls.
    await room.window.autoUpnp.toggle();
    assert.deepEqual(setCalls, [true]);
    assert.equal(room.window.autoUpnp.state().enabled, true);
    assert.equal(room.el('view-auto-upnp').getAttribute('aria-checked'), 'true');
    assert.equal(room.el('allow-upnp').checked, true);
});

async function savedRoomsWindow() {
    const rooms = [{ roomId: 'r1', name: 'Garage', userName: 'Ann', protected: true, keepHistory: true }];
    const room = await loadRoomWindow({
        scripts: ['saved-rooms-ui.js'], elements: [...loginControls, ...savedControls],
        api: { listSavedRooms: async () => ({ state: 'open', rooms }) }
    });
    await settle();
    return room;
}

test('"Save room" is on for the Create types and off for Join, with the note when it is off', async () => {
    const room = await savedRoomsWindow();
    const box = room.el('save-room');
    const note = room.el('save-off-note');
    assert.equal(box.checked, true);
    assert.equal(note.hidden, true);
    box.checked = false;
    box.dispatchEvent(new room.Event('change'));
    assert.equal(note.hidden, false);
    choose(room, 'lan');
    assert.equal(box.checked, false, 'a change between the two Create types keeps the choice');
    choose(room, 'join');
    assert.equal(box.checked, false);
    assert.equal(note.hidden, true);
    choose(room, 'new');
    assert.equal(box.checked, true);
    assert.equal(note.hidden, true);
});

test('Create with the name of a saved room starts the room only at the second click', async () => {
    const room = await savedRoomsWindow();
    const logins = [];
    room.window.asscrack.login = async options => { logins.push(options.room); throw new Error('stop'); };
    room.el('username').value = 'Ann';
    room.el('room').value = 'garage';
    room.el('login').click();
    await settle();
    assert.deepEqual(logins, []);
    assert.equal(room.el('status').textContent,
        'You have a saved room with this name. Use Reopen to open it.');
    room.el('login').click();
    await settle();
    assert.deepEqual(logins, ['garage']);
    // A change of the name resets the rule.
    room.el('room').value = 'Garage';
    room.el('room').dispatchEvent(new room.Event('input'));
    room.el('login').click();
    await settle();
    assert.deepEqual(logins, ['garage']);
    room.el('login').click();
    await settle();
    assert.deepEqual(logins, ['garage', 'Garage']);
    // A change of the type resets the rule too.
    choose(room, 'lan');
    room.el('login').click();
    await settle();
    assert.deepEqual(logins, ['garage', 'Garage']);
    // Another name starts at once.
    room.el('room').value = 'Kitchen';
    room.el('room').dispatchEvent(new room.Event('input'));
    room.el('login').click();
    await settle();
    assert.deepEqual(logins, ['garage', 'Garage', 'Kitchen']);
});

test('"Change name" saves the user name of a saved room, and Reopen says that the room starts', async () => {
    const room = await savedRoomsWindow();
    const row = room.el('saved-rooms').querySelector('.saved-room');
    const renames = [];
    room.window.asscrack.setSavedRoomName = async (roomId, name) => { renames.push([roomId, name]); return { roomId, userName: name }; };
    row.querySelector('.rename-room').click();
    const form = row.querySelector('.rename-form');
    const input = form.querySelector('input');
    assert.equal(form.hidden, false);
    assert.equal(input.value, 'Ann');
    input.value = 'Bea';
    form.querySelector('.rename-cancel').click();
    assert.equal(form.hidden, true);
    assert.deepEqual(renames, []);
    row.querySelector('.rename-room').click();
    assert.equal(input.value, 'Ann');
    input.value = '  Bea ';
    form.querySelector('.rename-save').click();
    await settle();
    assert.deepEqual(renames, [['r1', 'Bea']]);
    assert.equal(row.querySelector('.saved-room-user').textContent, 'Bea');
    assert.equal(form.hidden, true);
    let fail;
    const reopens = [];
    room.window.asscrack.reopenRoom = roomId => { reopens.push(roomId); return new Promise((_resolve, reject) => { fail = reject; }); };
    const reopen = row.querySelector('.reopen-room');
    reopen.click();
    await settle();
    assert.deepEqual(reopens, ['r1']);
    assert.equal(reopen.textContent, STARTING);
    fail(new Error('no'));
    await settle();
    assert.equal(reopen.textContent, 'Reopen room');
});
