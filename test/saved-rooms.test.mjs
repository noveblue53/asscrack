import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3-multiple-ciphers';
import { makeInvite, readInvite } from '../src/network/invite.mjs';
import { createSavedRooms, makeProtector } from '../src/application/saved-rooms.mjs';
import { roomFingerprint } from '../src/application/room-archive.mjs';

const fakeProtector = {
    available: () => true,
    wrap: b => Buffer.concat([Buffer.from('p:'), b]),
    unwrap: b => Buffer.from(b.subarray(2))
};

const KEY_A = Buffer.alloc(32, 1).toString('base64url');
const KEY_B = Buffer.alloc(32, 2).toString('base64url');

function setup(t, extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-rooms-'));
    const logs = [];
    const events = [];
    const hints = [];
    const rooms = createSavedRooms({
        dir: path.join(dir, 'saved-rooms'), protector: fakeProtector, log: (l, x) => logs.push([l, x]),
        notify: (type, data) => events.push([type, data]), forgetHints: row => hints.push(row), ...extra
    });
    // Windows cannot delete an open database file: close each store of the test before the delete.
    const reopened = [];
    t.after(() => {
        rooms.close();
        for (const other of reopened) other.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const keep = store => { reopened.push(store); return store; };
    return { rooms, logs, events, hints, dir, keep };
}

function fakeNode(accepted) {
    let n = 0;
    return {
        events: new EventEmitter(),
        sendRecord: text => ({ id: `id-${++n}`, from: 'me', text, time: 1000 + n, accepted })
    };
}

function start(rooms, node, { room = 'room', key = KEY_A, keepHistory = true, userName = 'me' } = {}) {
    rooms.attachNode(node);
    const r = rooms.afterLogin({ room, roomKey: key, userName, save: true, keepHistory });
    assert.equal(r.saved, true);
    assert.equal(r.roomId, roomFingerprint(room, key));
    return r.roomId;
}

test('a send with accepted 1 adds one row, accepted 0 adds no row', t => {
    const { rooms } = setup(t);
    const node = fakeNode(1);
    const roomId = start(rooms, node);
    rooms.recordSend(node.sendRecord('hello'));
    rooms.recordSend({ ...node.sendRecord('nobody'), accepted: 0 });
    const lines = rooms.lines(roomId);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, 'hello');
    assert.equal(lines[0].own, true);
    assert.equal(lines[0].peerId, null);
});

test('a live message adds one row with source live, a history event adds no row', t => {
    const { rooms } = setup(t);
    const node = fakeNode(1);
    const roomId = start(rooms, node);
    // The archive listens to the node event live, not message (DECISIONS.md P4): live also comes for an ID that
    // a host replay gave first. Thus the fake node emits live.
    node.events.emit('live', { peerId: 'peer-1', id: 'm1', from: 'bob', text: 'hi', time: 5 });
    node.events.emit('history', { messages: [{ id: 'h1', from: 'old', text: 'old', time: 1 }] });
    const lines = rooms.lines(roomId);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], { id: 'm1', from: 'bob', text: 'hi', time: 5, own: false, peerId: 'peer-1' });
    const status = rooms.status();
    assert.equal(status.state, 'open');
    assert.equal(status.rooms.length, 1);
    assert.equal('roomKey' in status.rooms[0], false);
    assert.equal('invite' in status.rooms[0], false);
});

test('a room with keepHistory off adds no row', t => {
    const { rooms } = setup(t);
    const node = fakeNode(1);
    const roomId = start(rooms, node, { keepHistory: false });
    rooms.recordSend(node.sendRecord('hello'));
    node.events.emit('live', { peerId: 'peer-1', id: 'm1', from: 'bob', text: 'hi', time: 5 });
    assert.equal(rooms.lines(roomId).length, 0);
});

test('the encrypted archive preserves exact device identity and protected state across close and reopen', t => {
    const { rooms, dir } = setup(t);
    const identity = 'private-device-fixture';
    assert.equal(rooms.deviceIdentity(() => identity), identity);
    const { roomId } = rooms.afterLogin({ room: 'access', roomKey: KEY_A, save: true, membership: { role: 'owner' } });
    const signedState = { role: 'owner', revoked: 'signed-revocation-fixture' };
    assert.equal(rooms.persistMembership(signedState), true);
    rooms.close();
    const archiveDir = path.join(dir, 'saved-rooms');
    const reopened = createSavedRooms({ dir: archiveDir, protector: fakeProtector });
    try {
        assert.equal(reopened.deviceIdentity(() => assert.fail('The original identity must be reused')), identity);
        assert.equal(reopened.isProtectedRoom('access', KEY_A), true);
        assert.deepEqual(JSON.parse(reopened.getRoom(roomId).membership), signedState);
        const [publicRow] = reopened.status().rooms;
        assert.equal(publicRow.protected, true);
        assert.equal('membership' in publicRow, false);
        assert.equal('roomKey' in publicRow, false);
    } finally { reopened.close(); }
    const ciphertext = fs.readFileSync(path.join(archiveDir, 'archive.db'));
    assert.equal(ciphertext.includes(Buffer.from(identity)), false);
    assert.equal(ciphertext.includes(Buffer.from(signedState.revoked)), false);
});

test('a changed user name of a saved room stays after the archive closes and opens (gap A6)', t => {
    const { rooms, dir } = setup(t);
    const roomId = start(rooms, fakeNode(1), { userName: 'Old name' });
    assert.throws(() => rooms.setUserName(roomId, '   '), /up to 64 characters/);
    assert.throws(() => rooms.setUserName(roomId, 'x'.repeat(65)), /up to 64 characters/);
    assert.throws(() => rooms.setUserName('no-such-room', 'Ann'), /not saved/);
    assert.deepEqual(rooms.setUserName(roomId, '  New name  '), { roomId, userName: 'New name' });
    rooms.close();
    const reopened = createSavedRooms({ dir: path.join(dir, 'saved-rooms'), protector: fakeProtector });
    try {
        assert.equal(reopened.getRoom(roomId).userName, 'New name');
        assert.equal(reopened.status().rooms.find(r => r.roomId === roomId).userName, 'New name');
    } finally { reopened.close(); }
});

test('a profile with saved protected rooms does not replace a missing device identity', t => {
    const { rooms } = setup(t);
    const { saved } = rooms.afterLogin({ room: 'access', roomKey: KEY_A, save: true, membership: { role: 'owner' } });
    assert.equal(saved, true);
    assert.throws(() => rooms.deviceIdentity(() => assert.fail('Do not generate a replacement identity')), /identity is missing/);
});

test('two rooms with the same user name and different keys keep separate rows', t => {
    const { rooms } = setup(t);
    const nodeA = fakeNode(1);
    const idA = start(rooms, nodeA, { key: KEY_A });
    rooms.recordSend(nodeA.sendRecord('in A'));
    const nodeB = fakeNode(1);
    const idB = start(rooms, nodeB, { key: KEY_B });
    assert.notEqual(idA, idB);
    rooms.recordSend(nodeB.sendRecord('in B'));
    assert.deepEqual(rooms.lines(idA).map(l => l.text), ['in A']);
    assert.deepEqual(rooms.lines(idB).map(l => l.text), ['in B']);
});

test('recordSend gives the write result, the live event notifies line-saved', t => {
    const { rooms, events } = setup(t);
    const node = fakeNode(1);
    const roomId = start(rooms, node);
    assert.deepEqual(rooms.recordSend(node.sendRecord('a')), { saved: true, saveError: null });
    assert.deepEqual(rooms.recordSend({ ...node.sendRecord('b'), accepted: 0 }), { saved: false, saveError: null });
    node.events.emit('live', { peerId: 'p', id: 'L1', from: 'bob', text: 'x', time: 9 });
    // The same ID again (for example after a replay): one row, saved again true.
    node.events.emit('live', { peerId: 'p', id: 'L1', from: 'bob', text: 'x', time: 9 });
    assert.deepEqual(events, [['line-saved', { id: 'L1' }], ['line-saved', { id: 'L1' }]]);
    assert.equal(rooms.lines(roomId).length, 2);
});

test('afterLogin gives savedRoom and keepHistory, activeInfo follows', t => {
    const { rooms } = setup(t);
    const r0 = rooms.afterLogin({ room: 'r', roomKey: KEY_A, userName: 'me', save: false });
    assert.equal(r0.savedRoom, false);
    assert.equal(r0.keepHistory, null);
    assert.equal(rooms.activeInfo(), null);
    const r1 = rooms.afterLogin({ room: 'r', roomKey: KEY_A, userName: 'me', save: true, keepHistory: false });
    assert.equal(r1.savedRoom, true);
    assert.equal(r1.keepHistory, false);
    assert.deepEqual(rooms.activeInfo(), { roomId: r1.roomId, keepHistory: false });
});

test('keep history off and on applies at once to the active room', t => {
    const { rooms } = setup(t);
    const node = fakeNode(1);
    const roomId = start(rooms, node);
    assert.deepEqual(rooms.setKeepHistory(roomId, false), { roomId, keepHistory: false });
    assert.deepEqual(rooms.recordSend(node.sendRecord('off')), { saved: false, saveError: null });
    node.events.emit('live', { peerId: 'p', id: 'L-off', from: 'bob', text: 'x', time: 9 });
    assert.equal(rooms.lines(roomId).length, 0);
    assert.equal(rooms.getRoom(roomId).keepHistory, false);
    assert.deepEqual(rooms.setKeepHistory(roomId, true), { roomId, keepHistory: true });
    assert.equal(rooms.recordSend(node.sendRecord('on')).saved, true);
    assert.deepEqual(rooms.lines(roomId).map(l => l.text), ['on']);
    assert.equal(rooms.getRoom(roomId).keepHistory, true);
});

test('clear deletes the rows and tombstones the IDs for this run', t => {
    const { rooms } = setup(t);
    const node = fakeNode(1);
    const roomId = start(rooms, node);
    const rec = node.sendRecord('one');
    rooms.recordSend(rec);
    node.events.emit('live', { peerId: 'p', id: 'L1', from: 'bob', text: 'x', time: 9 });
    assert.deepEqual(rooms.clear(roomId), { cleared: 2 });
    assert.equal(rooms.lines(roomId).length, 0);
    assert.deepEqual(rooms.recordSend(rec), { saved: false, saveError: null });
    node.events.emit('live', { peerId: 'p', id: 'L1', from: 'bob', text: 'x', time: 9 });
    assert.equal(rooms.lines(roomId).length, 0);
    // A new ID is saved.
    assert.equal(rooms.recordSend(node.sendRecord('two')).saved, true);
    assert.deepEqual(rooms.lines(roomId).map(l => l.text), ['two']);
    assert.equal(rooms.getRoom(roomId).keepHistory, true);
});

test('a row that is too large gives saved false with the reason row-too-large', t => {
    const { rooms, events } = setup(t, { limits: { maxRowBytes: 10 } });
    const node = fakeNode(1);
    start(rooms, node);
    assert.deepEqual(rooms.recordSend(node.sendRecord('x'.repeat(20))), { saved: false, saveError: 'row-too-large' });
    node.events.emit('live', { peerId: 'p', id: 'big', from: 'bob', text: 'y'.repeat(20), time: 9 });
    assert.deepEqual(events, [['save-failed', { id: 'big', reason: 'row-too-large' }]]);
});

test('a failed write (database error) gives saved false with a reason and save-failed', t => {
    const { rooms, events, dir } = setup(t);
    const node = fakeNode(1);
    start(rooms, node);
    // A read-only file does not stop root (the test VM runs as root). Thus a second connection with the same key
    // drops the messages table. The next write of the module then gets a real database error.
    const folder = path.join(dir, 'saved-rooms');
    const wrapped = Buffer.from(JSON.parse(fs.readFileSync(path.join(folder, 'archive.key'), 'utf8')).wrapped, 'base64');
    const key = fakeProtector.unwrap(wrapped);
    const db = new Database(path.join(folder, 'archive.db'));
    db.pragma("cipher='sqlcipher'");
    db.pragma('legacy=4');
    db.pragma(`key='${key.toString('hex')}'`);
    db.exec('DROP TABLE messages');
    db.close();
    const res = rooms.recordSend(node.sendRecord('fail'));
    assert.equal(res.saved, false);
    assert.equal(typeof res.saveError, 'string');
    assert.ok(res.saveError.length > 0);
    node.events.emit('live', { peerId: 'p', id: 'Lf', from: 'bob', text: 'x', time: 9 });
    assert.equal(events.length, 1);
    assert.equal(events[0][0], 'save-failed');
    assert.equal(events[0][1].id, 'Lf');
    assert.ok(events[0][1].reason.length > 0);
});

test('forget calls forgetHints, deletes the rows, and fails for the open room', t => {
    const { rooms, hints } = setup(t);
    const nodeA = fakeNode(1);
    const idA = start(rooms, nodeA, { key: KEY_A });
    rooms.recordSend(nodeA.sendRecord('in A'));
    assert.throws(() => rooms.forget(idA), /room is open/);
    assert.equal(hints.length, 0);
    const nodeB = fakeNode(1);
    start(rooms, nodeB, { key: KEY_B });
    assert.deepEqual(rooms.forget(idA), { forgotten: true });
    assert.equal(hints.length, 1);
    assert.equal(hints[0].name, 'room');
    assert.equal(hints[0].roomKey, KEY_A);
    assert.equal(rooms.getRoom(idA), null);
    assert.deepEqual(rooms.lines(idA), []);
    assert.equal(rooms.status().rooms.length, 1);
});

// G5 (gap A7): Leave room. After leave() the room is not active: Forget of it works, and a second afterLogin works.
test('after leave(), forget of that room works and a second afterLogin works', t => {
    const { rooms, hints } = setup(t);
    const nodeA = fakeNode(1);
    const idA = start(rooms, nodeA, { key: KEY_A });
    rooms.recordSend(nodeA.sendRecord('in A'));
    assert.throws(() => rooms.forget(idA), /room is open/);
    rooms.leave();
    assert.equal(rooms.activeInfo(), null);
    // A live line of the old node after leave() adds no row.
    nodeA.events.emit('live', { id: 'late', from: 'peer', text: 'late line', time: 5000 });
    assert.deepEqual(rooms.lines(idA).map(row => row.text), ['in A']);
    // The same room again (a second login after Leave), then a different room.
    const nodeA2 = fakeNode(1);
    assert.equal(start(rooms, nodeA2, { key: KEY_A }), idA);
    // The fake node counts its IDs from 1 again: give the line its own ID.
    assert.equal(rooms.recordSend({ ...nodeA2.sendRecord('in A again'), id: 'second-run-1' }).saved, true);
    assert.equal(rooms.lines(idA).length, 2);
    rooms.leave();
    assert.deepEqual(rooms.forget(idA), { forgotten: true });
    assert.equal(hints.length, 1);
    const idB = start(rooms, fakeNode(1), { key: KEY_B });
    assert.equal(rooms.activeInfo()?.roomId, idB);
});

test('forget remains retryable if saved route hints cannot be removed', t => {
    let blocked = true;
    const { rooms, logs } = setup(t, { forgetHints: () => { if (blocked) throw new Error('hint error'); } });
    const node = fakeNode(1);
    const idA = start(rooms, node, { key: KEY_A });
    start(rooms, fakeNode(1), { key: KEY_B });
    assert.throws(() => rooms.forget(idA), /Try Forget again/);
    assert.ok(rooms.getRoom(idA));
    assert.ok(logs.some(([l, x]) => l === 'WARN' && /hint error/.test(x)));
    blocked = false;
    assert.deepEqual(rooms.forget(idA), { forgotten: true });
    assert.equal(rooms.getRoom(idA), null);
});


test('importing a refreshed invite for a saved room keeps its identity, messages and history preference on reopen', t => {
    const { rooms, dir, keep } = setup(t);
    const peerId = 'QmYwAPJzv5CZsnAzt8auVZRnGKYcmwZKKf7E1hgZ5tC6J8';
    const code = port => makeInvite({ room: 'room', key: KEY_A, nodes: [{ id: peerId, addrs: [`/ip4/127.0.0.1/tcp/${port}`] }] });
    const original = code(4001);
    const refreshed = code(4002);
    const join = invite => {
        const { room, key: roomKey } = readInvite(invite);
        return { room, roomKey, invite, userName: 'me' };
    };
    const { roomId } = rooms.afterLogin({ ...join(original), save: true });
    rooms.recordSend({ id: 'prior', from: 'me', text: 'before refresh', time: 1, accepted: 1 });
    rooms.setKeepHistory(roomId, false);
    const imported = rooms.afterLogin(join(refreshed));
    assert.equal(imported.roomId, roomId);
    assert.equal(imported.keepHistory, false);
    rooms.close();
    const reopened = keep(createSavedRooms({ dir: path.join(dir, 'saved-rooms'), protector: fakeProtector }));
    assert.equal(reopened.status().rooms.length, 1);
    assert.equal(reopened.getRoom(roomId).invite, refreshed);
    assert.deepEqual(reopened.lines(roomId).map(m => m.id), ['prior']);
    assert.equal(reopened.getRoom(roomId).keepHistory, false);
});

test('a saved room retains its empty channel catalog with saving off and after Clear', t => {
    const { rooms } = setup(t);
    const n = fakeNode(1);
    const roomId = start(rooms, n, { keepHistory: false });
    const channel = {id: 'ef165263-9724-47f6-81db-787f490ea255', name: 'Game night'};
    rooms.persistChannels([channel]);
    assert.deepEqual(rooms.loadChannels('room', KEY_A), [channel]);
    assert.deepEqual(rooms.loadChannels('room', KEY_B), []);
    const record = {id: 'named', from: 'me', text: 'test', time: 1, channelId: channel.id, accepted: 1};
    rooms.recordSend(record);
    assert.deepEqual(rooms.lines(roomId), []);
    rooms.setKeepHistory(roomId, true);
    rooms.recordSend(record);
    assert.deepEqual(rooms.lines(roomId, {channelId: channel.id}).map(m => m.channelId), [channel.id]);
    assert.deepEqual(rooms.lines(roomId, {channelId: 'general'}), []);
    rooms.clear(roomId);
    assert.deepEqual(rooms.loadChannels('room', KEY_A), [channel]);
    assert.deepEqual(rooms.lines(roomId), []);
});

test('cold attachment archive reopens live and own cards with just the projected metadata in their original channels', t => {
    const {rooms, dir, keep} = setup(t);
    const node = fakeNode(1);
    const roomId = start(rooms, node);
    const channelId = 'eeb5f87a-8f35-4dac-9aa2-5bb32953f93c';
    rooms.persistChannels([{id: channelId, name: 'Race photos'}]);
    const attachment = {
        id: '7d034c92-7730-4254-87ef-8b4116b6dc6a', source: '12D3KooWDESEF99R85j6RjTNo9RTboTu35bUNHKEY8NtQ5BY4hhF',
        sha256: 'e'.repeat(64), size: 4712, kind: 'image', name: 'harbor.png', expires: 2000000000000
    };
    const untrusted = {...attachment, filePath: '/private/screenshot.png', preview: 'never archive preview bytes'};
    const text = 'Braking point\nharbor.png (4712 bytes)';
    const own = {...node.sendRecord(text), attachment: untrusted};
    assert.equal(rooms.recordSend(own).saved, true);
    const live = {id: 'b', time: 2010, text, from: 'Bob', peerId: attachment.source, channelId,
        attachment: {...untrusted, id: '93a1701b-a6ad-41b0-8a22-d09612beae7b'}};
    node.events.emit('live', live);
    node.events.emit('live', {...live, attachment: {...attachment, name: 'overwrite.png'}});
    node.events.emit('live', {...live, id: 'malformed', attachment: {...attachment, name: '../private.png'}});
    node.events.emit('history', {messages: [{...live, id: 'catch-up'}]});
    rooms.close();
    const restarted = keep(createSavedRooms({dir: path.join(dir,'saved-rooms'), protector: fakeProtector}));
    const general = restarted.lines(roomId,{channelId:'general'});
    assert.deepEqual(general.map(r => r.id), [own.id]);
    assert.deepEqual(general[0].attachment, attachment);
    const named = restarted.lines(roomId,{channelId});
    assert.deepEqual(named.map(r => r.id), ['b','malformed']);
    assert.deepEqual(named[0].attachment, {...attachment, id: live.attachment.id});
    assert.equal(named[1].attachment, undefined);
    const replay = restarted.prepareReplay('room', KEY_A, () => {});
    assert.deepEqual(replay.map(m => m.attachment), [attachment, named[0].attachment, undefined]);
    assert.equal(replay[1].channelId, channelId);
    assert.ok(replay.every(m => !('peerId' in m) && !('own' in m)));
    restarted.clear(roomId);
    assert.deepEqual(restarted.lines(roomId), []);
    assert.deepEqual(restarted.prepareReplay('room', KEY_A, () => {}), []);
});

// A safeStorage fake with the Electron 45 API. The synchronous calls throw: makeProtector must not use them.
function fakeSafeStorage({ available = true, shouldReEncrypt = false } = {}) {
    const calls = [];
    const no = name => () => { throw new Error(`synchronous safeStorage.${name} called`); };
    return {
        calls,
        isEncryptionAvailable: no('isEncryptionAvailable'),
        encryptString: no('encryptString'),
        decryptString: no('decryptString'),
        getSelectedStorageBackend: () => 'gnome_libsecret',
        isAsyncEncryptionAvailable: async () => { calls.push('available'); return available; },
        encryptStringAsync: async text => { calls.push('encrypt'); return Buffer.from('e:' + text); },
        decryptStringAsync: async buf => {
            calls.push('decrypt');
            return { shouldReEncrypt, result: buf.subarray(2).toString() };
        }
    };
}

test('makeProtector uses only the asynchronous safeStorage calls', async () => {
    const ss = fakeSafeStorage({ shouldReEncrypt: true });
    const p = makeProtector(ss, 'win32');
    assert.equal(p.async, true);
    assert.equal(await p.available(), true);
    const key = Buffer.alloc(32, 9);
    const wrapped = await p.wrap(key);
    const r = await p.unwrap(wrapped);
    assert.ok(r.value.equals(key));
    assert.equal(r.reEncrypt, true);
    assert.deepEqual(ss.calls, ['available', 'encrypt', 'decrypt']);
    assert.equal(await makeProtector(fakeSafeStorage({ available: false }), 'win32').available(), false);
    const basic = { ...fakeSafeStorage(), getSelectedStorageBackend: () => 'basic_text' };
    assert.equal(await makeProtector(basic, 'linux').available(), false);
});

test('createSavedRooms with the async protector: open(), then the saved room and lines after a restart', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-rooms-'));
    const stores = [];
    // Windows cannot delete an open database file: close each store before the delete.
    t.after(() => { for (const s of stores) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const logs = [];
    const make = () => {
        const s = createSavedRooms({ dir: path.join(dir, 'saved-rooms'), protector: makeProtector(fakeSafeStorage(), 'win32'),
            log: (l, x) => logs.push([l, x]) });
        stores.push(s);
        return s;
    };
    const first = make();
    // Before open(): no archive and no crash.
    assert.equal(first.status().state, 'locked');
    await Promise.all([first.open(), first.open()]);
    assert.equal(first.status().state, 'open');
    assert.equal(logs.filter(([, x]) => x.startsWith('Saved rooms archive opened: state open')).length, 1);
    const r = first.afterLogin({ room: 'r', roomKey: KEY_A, userName: 'Ann', save: true });
    assert.equal(r.saved, true);
    assert.equal(first.recordSend({ id: 'm1', from: 'Ann', text: 'hello', time: 1, accepted: 1 }).saved, true);
    first.close();
    const second = make();
    await second.open();
    const st = second.status();
    assert.equal(st.state, 'open');
    assert.deepEqual(st.rooms.map(x => x.name), ['r']);
    assert.deepEqual(second.lines(st.rooms[0].roomId).map(l => l.text), ['hello']);
    assert.equal((await second.unlock()).state, 'open');
});

// The safeStorage key of Windows is on disk only when "Local State" has os_crypt.encrypted_key (Chromium writes the
// file about 10 s after the first start of a new data folder).
test('makeProtector durable(): reads os_crypt.encrypted_key of Local State on Windows only', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-rooms-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const localStateFile = path.join(dir, 'Local State');
    const p = makeProtector(fakeSafeStorage(), 'win32', { localStateFile });
    assert.equal(p.durable(), false, 'no file');
    fs.writeFileSync(localStateFile, '{"os_crypt":');
    assert.equal(p.durable(), false, 'not JSON');
    fs.writeFileSync(localStateFile, JSON.stringify({ uninstall_metrics: {} }));
    assert.equal(p.durable(), false, 'no os_crypt');
    fs.writeFileSync(localStateFile, JSON.stringify({ os_crypt: { encrypted_key: '' } }));
    assert.equal(p.durable(), false, 'empty key');
    fs.writeFileSync(localStateFile, JSON.stringify({ os_crypt: { audit_enabled: true, encrypted_key: 'RFBBUEkBAAAA' } }));
    assert.equal(p.durable(), true);
    assert.equal(makeProtector(fakeSafeStorage(), 'linux', { localStateFile: path.join(dir, 'none') }).durable(), true);
    assert.equal(makeProtector(fakeSafeStorage(), 'win32').durable(), true, 'no path: as before');
});

test('createSavedRooms: a kill before Local State has the key, then the next start opens and logs the kept files', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-rooms-'));
    const dir = path.join(root, 'saved-rooms');
    const stores = [];
    t.after(() => { for (const s of stores) s.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const localStateFile = path.join(root, 'Local State');
    // Each run of the fake safeStorage has its own key, like Chromium before the first write of Local State.
    const run = n => ({
        ...fakeSafeStorage(),
        encryptStringAsync: async text => Buffer.from(`${n}:${text}`),
        decryptStringAsync: async buf => {
            const text = buf.toString();
            if (!text.startsWith(`${n}:`)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
            return { shouldReEncrypt: false, result: text.slice(String(n).length + 1) };
        }
    });
    const logs = [];
    const make = n => {
        const s = createSavedRooms({ dir, protector: makeProtector(run(n), 'win32', { localStateFile }),
            log: (l, x) => logs.push([l, x]) });
        stores.push(s);
        return s;
    };
    const first = make(1);
    await first.open();
    assert.equal(first.afterLogin({ room: 'r', roomKey: KEY_A, userName: 'Ann', save: true }).saved, true);
    first.close();
    const second = make(2);
    await second.open();
    const st = second.status();
    assert.equal(st.state, 'open');
    assert.deepEqual(st.rooms, []);
    const lost = logs.filter(([l, x]) => l === 'WARN' && x.startsWith('Saved rooms archive: the key of an interrupted first start'));
    assert.equal(lost.length, 1);
    assert.match(lost[0][1], /archive\.lost-\S+\.db, archive\.lost-\S+\.key$/);
    assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('archive.lost-')).length, 2);
    assert.equal((await second.unlock()).state, 'open');
    assert.equal(logs.filter(([, x]) => x.startsWith('Saved rooms archive: the key')).length, 1, 'one line only');
});

// G6: the voice channel catalog comes back after a full restart (a new store on the same folder), and the node takes
// it as seedVoiceChannels. Only a higher seq replaces the saved catalog. Clear keeps it; Forget removes it.
test('the voice channel catalog of a saved room comes back after a full restart', async t => {
    const { createDeviceIdentity, createRoomMembership, restoreRoomMembership } = await import('../src/network/room-membership.mjs');
    const { createVoiceChannels } = await import('../src/network/voice-channels.mjs');
    const { rooms, dir, keep } = setup(t);
    const roomId = start(rooms, fakeNode(1));
    const owner = createRoomMembership({ identity: createDeviceIdentity(), room: 'room', roomKey: KEY_A, lan: true });
    const identity = createDeviceIdentity();
    const member = restoreRoomMembership({ identity, room: 'room', roomKey: KEY_A, descriptor: owner.issue(identity.id) });
    const edits = createVoiceChannels({ membership: owner });
    assert.equal(rooms.loadVoiceChannels('room', KEY_A), null);
    edits.create('Raid');
    const first = edits.catalog();
    edits.create('Lobby');
    const second = edits.catalog();
    rooms.persistVoiceChannels(second);
    rooms.persistVoiceChannels(first);
    assert.equal(rooms.loadVoiceChannels('room', KEY_A).seq, 2, 'a lower seq does not replace the catalog');
    assert.equal(rooms.loadVoiceChannels('room', KEY_B), null);
    rooms.clear(roomId);
    rooms.close();
    const reopened = keep(createSavedRooms({ dir: path.join(dir, 'saved-rooms'), protector: fakeProtector }));
    const saved = reopened.loadVoiceChannels('room', KEY_A);
    assert.deepEqual(saved, second);
    const restored = createVoiceChannels({ membership: member, seed: saved });
    assert.deepEqual(restored.view().channels.map(c => c.name), ['General', ...second.channels.map(c => c.name)]);
    assert.deepEqual(restored.view().channels.map(c => c.name).sort(), ['General', 'Lobby', 'Raid']);
    assert.equal(restored.seq(), 2);
    reopened.forget(roomId);
    assert.equal(reopened.loadVoiceChannels('room', KEY_A), null);
});
