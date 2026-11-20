import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3-multiple-ciphers';
import { makeInvite, readInvite } from '../src/network/invite.mjs';
import { createSavedRooms } from '../src/application/saved-rooms.mjs';
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
    t.after(() => {
        rooms.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { rooms, logs, events, hints, dir };
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

test('forget continues when forgetHints throws', t => {
    const { rooms, logs } = setup(t, { forgetHints: () => { throw new Error('hint error'); } });
    const node = fakeNode(1);
    const idA = start(rooms, node, { key: KEY_A });
    start(rooms, fakeNode(1), { key: KEY_B });
    assert.deepEqual(rooms.forget(idA), { forgotten: true });
    assert.equal(rooms.getRoom(idA), null);
    assert.ok(logs.some(([l, x]) => l === 'WARN' && /hint error/.test(x)));
});


test('importing a refreshed invite for a saved room keeps its identity, messages and history preference on reopen', t => {
    const { rooms, dir } = setup(t);
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
    const reopened = createSavedRooms({ dir: path.join(dir, 'saved-rooms'), protector: fakeProtector });
    t.after(() => reopened.close());
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
