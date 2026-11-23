// 1.0.6: the status of a friend in the Friends list (friend-presence.mjs) with a fake clock, the texts of the drawer, the
// Friends window and the friend chat, the network change (network-watch.mjs), and the immediate tries of a network
// change (friend-links.mjs networkChanged, 127.0.0.1 on this PC; not a LAN result).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { CONNECT_GRACE_MS, UNREACHABLE_MS, createPresence } from '../src/application/friend-presence.mjs';
import { addressSignature, createNetworkWatch } from '../src/application/network-watch.mjs';
import { friendTestOptions } from '../src/application/friend-links.mjs';
import { chatState } from '../src/application/friend-windows.mjs';
import { createClock } from './helpers/fake-clock.mjs';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';
import { makeProfile, protectedRoomPair, startLinks, befriend, waitFor, randomBasePort } from './helpers/friends.mjs';

function machine() {
    const clock = createClock(0);
    const changes = [];
    const p = createPresence({ now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout,
        onChange: change => changes.push({ ...change, at: clock.now() }) });
    return { clock, changes, p };
}

test('presence: connecting at the start, can\'t reach after 60 s, offline after 5 more minutes', () => {
    const { clock, changes, p } = machine();
    assert.equal(CONNECT_GRACE_MS, 60000);
    assert.equal(UNREACHABLE_MS, 300000);
    assert.equal(p.status(), 'connecting', 'a node that did not start yet');
    p.started();
    assert.equal(p.status(), 'connecting');
    clock.advance(59999);
    assert.equal(p.status(), 'connecting');
    clock.advance(1);
    assert.equal(p.status(), 'unreachable');
    clock.advance(UNREACHABLE_MS - 1);
    assert.equal(p.status(), 'unreachable');
    clock.advance(1);
    assert.equal(p.status(), 'offline');
    assert.deepEqual(changes.map(c => [c.from, c.to, c.cause, c.ms, c.at]), [
        [null, 'connecting', 'start', 0, 0],
        ['connecting', 'unreachable', 'grace', 60000, 60000],
        ['unreachable', 'offline', 'timeout', 300000, 360000]]);
});

test('presence: a session gives online at once; a bye gives offline at once; a lost session gives connecting', () => {
    const { clock, changes, p } = machine();
    p.started();
    clock.advance(2000);
    p.sessionOpened();
    assert.equal(p.status(), 'online');
    clock.advance(600000);
    assert.equal(p.status(), 'online', 'no timer runs while online');
    p.sessionClosed(true);
    assert.equal(p.status(), 'offline');
    assert.equal(p.gone(), true);
    clock.advance(3600000);
    assert.equal(p.status(), 'offline');
    p.sessionOpened();
    p.sessionClosed(false);
    assert.equal(p.status(), 'connecting');
    clock.advance(CONNECT_GRACE_MS);
    assert.equal(p.status(), 'unreachable');
    assert.deepEqual(changes.map(c => `${c.to}:${c.cause}`),
        ['connecting:start', 'online:session', 'offline:bye', 'online:session', 'connecting:lost', 'unreachable:grace']);
});

test('presence: a network change gives connecting again; after a bye the grace time ends in offline', () => {
    const { clock, changes, p } = machine();
    p.started();
    p.sessionOpened();
    p.network();
    assert.equal(p.status(), 'online', 'a friend with a session does not change');
    p.sessionClosed(true);
    p.network();
    assert.equal(p.status(), 'connecting');
    clock.advance(CONNECT_GRACE_MS);
    assert.equal(p.status(), 'offline', 'the friend quit: no Can\'t reach');
    p.sessionOpened();
    p.sessionClosed(false);
    clock.advance(CONNECT_GRACE_MS + UNREACHABLE_MS);
    assert.equal(p.status(), 'offline');
    p.network();
    clock.advance(CONNECT_GRACE_MS);
    assert.equal(p.status(), 'unreachable', 'no bye: the tries failed');
    assert.deepEqual(changes.filter(c => c.cause === 'network').map(c => c.from), ['offline', 'offline']);
});

test('presence: a helper answer moves offline to can\'t reach and starts its time again; stop clears the timer', () => {
    const { clock, p } = machine();
    p.started();
    p.sessionClosed(true);
    p.answered();
    assert.equal(p.status(), 'unreachable', 'the friend runs (an answer came), but this device has no session');
    clock.advance(UNREACHABLE_MS - 1000);
    p.answered();
    clock.advance(UNREACHABLE_MS - 1000);
    assert.equal(p.status(), 'unreachable');
    p.stop();
    clock.advance(UNREACHABLE_MS * 2);
    assert.equal(p.status(), 'unreachable', 'no change after stop');
});

const panel = { id: 'friends-panel', children: [
    { id: 'friends-close', tag: 'button' }, { id: 'friends-locked', tag: 'p' }, { id: 'friends-retry', tag: 'button' },
    { id: 'friends-empty', tag: 'p' }, { id: 'friend-list', tag: 'ul' }, { id: 'friend-waiting', tag: 'ul' },
    { id: 'friends-settings', children: [{ id: 'friends-reach', tag: 'p' }, { id: 'friends-upnp', tag: 'button' },
        { id: 'friends-name', tag: 'span' }, { id: 'friends-name-change', tag: 'button' },
        { id: 'friends-blocked', children: [{ id: 'friend-blocked-list', tag: 'ul' }] }] },
    { id: 'friends-status', tag: 'p' }
] };
// The same elements as test/friends-ui.test.mjs.
const ELEMENTS = [panel, { id: 'friends-toggle', tag: 'button', children: [{ id: 'friends-unread', tag: 'span' }] },
    { id: 'friend-confirm', tag: 'dialog', children: [{ id: 'friend-confirm-text', tag: 'p' }, { id: 'friend-confirm-yes', tag: 'button' }] },
    { id: 'friend-name-dialog', tag: 'dialog', children: [{ id: 'friend-name-form', tag: 'form', children: [
        { id: 'friend-name-title' }, { id: 'friend-name-input', tag: 'input' }, { id: 'friend-name-error' },
        { id: 'friend-name-cancel', tag: 'button' }, { id: 'friend-name-save', tag: 'button' }] }] }];

test('Friends list: Connecting…, Can\'t reach with a tooltip of what to try, and Offline only with that status', async () => {
    let changed = null;
    const view = upnp => ({ state: 'open', cap: 32, count: 4, name: 'Ann', upnp, reach: 'local', waiting: [], blocked: [],
        friends: [
            { friendId: 'f1', name: 'Ben', state: 'offline', status: 'connecting', lastSeen: null, unread: 0 },
            { friendId: 'f2', name: 'Cat', state: 'offline', status: 'unreachable', lastSeen: null, unread: 0 },
            { friendId: 'f3', name: 'Dan', state: 'offline', status: 'offline', lastSeen: null, unread: 0 },
            { friendId: 'f4', name: 'Eve', state: 'online', status: 'online', lastSeen: 1, unread: 0 }] });
    const api = { list: async () => view(false), relations: async () => ({}), onChanged: fn => { changed = fn; }, onRequest() {} };
    const room = await loadRoomWindow({ elements: ELEMENTS, scripts: ['friends-ui.js'], window: { friends: api } });
    await settle();
    const rows = room.el('friend-list').children;
    assert.deepEqual(rows.map(r => r.querySelector('.friend-state').textContent), ['Connecting…', 'Can\'t reach', 'Offline', 'Online']);
    assert.deepEqual(rows.map(r => r.dataset.status), ['connecting', 'unreachable', 'offline', 'online']);
    assert.equal(rows[1].querySelector('.friend-state').title, 'Turn on Open port (UPnP), or join a room you share');
    assert.equal(rows[0].querySelector('.friend-state').title, '');
    changed(view(true));
    assert.equal(room.el('friend-list').children[1].querySelector('.friend-state').title,
        'Join a room you share, or ask them to turn on Open port (UPnP)');
    // A view of an older main process has no status: the old text.
    assert.equal(room.window.friendsCore.stateText({ state: 'offline', lastSeen: null }), 'Offline');
    // The Friends window runs the same file (friends-window.html).
    const html = await readFile(new URL('../src/application/friends-window.html', import.meta.url), 'utf8');
    assert.match(html, /friends-ui\.js/);
});

test('friend chat: the state line has the same statuses', async () => {
    const source = await readFile(new URL('../src/application/friend-chat.js', import.meta.url), 'utf8');
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(source, context);
    const { stateText } = context.window.friendChatCore;
    assert.equal(stateText({ name: 'Ben', state: 'offline', status: 'connecting' }), 'Connecting…');
    assert.equal(stateText({ name: 'Ben', state: 'offline', status: 'unreachable' }), 'Can\'t reach. Messages send when you connect.');
    assert.equal(stateText({ name: 'Ben', state: 'offline', status: 'offline' }), 'Offline. Messages send when you\'re both online.');
    // The chat window gets the status from the main process (friend-windows.mjs chatState).
    const links = { friend: () => ({ name: 'Ben', state: 'offline', status: 'unreachable', lastSeen: null }), list: () => ({ reach: 'local' }) };
    assert.equal(chatState(links, 'f1').status, 'unreachable');
    assert.equal(stateText(chatState(links, 'f1')), 'Can\'t reach. Messages send when you connect.');
});

test('network watch: online, a changed address set, the settle time and the gap; no call for offline', () => {
    const clock = createClock(0);
    let ifs = {};
    const calls = [];
    const watch = createNetworkWatch({ read: () => ifs, onChange: cause => calls.push([cause, clock.now()]),
        now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, setRepeat: clock.setInterval, clearRepeat: clock.clearInterval });
    watch.start();
    const nic = address => ({ eth: [{ address, internal: false }], lo: [{ address: '127.0.0.1', internal: true }] });
    assert.equal(addressSignature({ a: [{ address: '169.254.1.2', internal: false }, { address: 'fe80::1', internal: false }] }), '');
    ifs = nic('192.168.0.10');
    clock.advance(5000 + 3000);
    assert.deepEqual(calls, [['online', 8000]]);
    ifs = nic('192.168.0.11');
    clock.advance(5000 + 3000);
    assert.equal(calls.length, 1, 'the second change waits for the gap of 15 s');
    clock.advance(10000);
    assert.deepEqual(calls[1], ['changed', 23000]);
    ifs = {};
    clock.advance(60000);
    assert.equal(calls.length, 2, 'no call when the PC has no address');
    ifs = nic('10.0.0.5');
    clock.advance(8000);
    assert.equal(calls[2][0], 'online');
    watch.stop();
    ifs = nic('10.0.0.6');
    clock.advance(60000);
    assert.equal(calls.length, 3);
});

test('main.js: resume and the network watch call networkChanged; the test flag is for a dev start only', async () => {
    const main = await readFile(new URL('../src/application/main.js', import.meta.url), 'utf8');
    const resume = main.slice(main.indexOf("powerMonitor.on('resume'"));
    assert.match(resume.slice(0, resume.indexOf('});')), /friendLinks\.networkChanged\('resume'\)/);
    assert.match(main, /createNetworkWatch\(\{ onChange: cause => friendLinks\.networkChanged\(cause\) \}\)/);
    assert.match(main, /networkWatch\.start\(\)/);
    assert.match(main, /!app\.isPackaged && friendTestIndex !== -1/);
    assert.match(main, /friendLinks\.events\.on\('journal'/);
    assert.deepEqual(friendTestOptions('port=0,no-inbound,no-mdns,no-ask,bad'), { basePort: 0, listen: [], discovery: false, refresh: false });
    assert.deepEqual(friendTestOptions('port=65535'), {}, 'no port over the range of the 32 friend ports');
});

test('127.0.0.1 a network change: the friend goes back to Connecting… and its node dials at once (not at the next 30 s redial)', async t => {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b');
    t.after(() => { A.rooms.close(); B.rooms.close(); });
    const { roomA, roomB } = await protectedRoomPair(t, A, B);
    const port = randomBasePort();
    const linksA = await startLinks(t, A, { basePort: port, nodeOptions: { allowPrivateFullNode: true } });
    const linksB = await startLinks(t, B, { basePort: port + 50, nodeOptions: { allowPrivateFullNode: true } });
    linksA.attachRoom(roomA);
    linksB.attachRoom(roomB);
    const { friendA } = await befriend(linksA, linksB, roomA, roomB);
    await waitFor(() => linksA.friend(friendA).status === 'online', 'online');
    linksA.attachRoom(null);
    linksB.attachRoom(null);
    await Promise.all([roomA.stop(), roomB.stop()]);
    const events = [];
    linksA.events.on('journal', e => events.push({ ...e, at: Date.now() }));
    await linksB.stop();
    await waitFor(() => linksA.friend(friendA).status === 'offline', 'B quit: offline at once');
    assert.ok(events.some(e => e.event === 'session' && e.state === 'closed' && e.cause === 'bye'));
    // The first redial of the friend node is up to 30 s later. Wait 1 s, then the network change.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const before = events.filter(e => e.event === 'try').length;
    const at = Date.now();
    assert.equal(linksA.networkChanged('resume'), 1);
    assert.equal(linksA.friend(friendA).status, 'connecting');
    await waitFor(() => events.some(e => e.event === 'try' && e.at >= at), 'a try right after the network change', 5000);
    assert.ok(events.filter(e => e.event === 'try').length > before);
    assert.ok(events.some(e => e.event === 'network' && e.cause === 'resume' && e.count === 1));
    assert.ok(events.some(e => e.event === 'state' && e.from === 'offline' && e.to === 'connecting' && e.cause === 'network'));
    assert.equal(linksA.networkChanged('changed') >= 0, true);
});
