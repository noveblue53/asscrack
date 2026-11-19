import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSavedRooms } from '../src/application/saved-rooms.mjs';
import { roomFingerprint } from '../src/application/room-archive.mjs';

const fakeProtector = {
    available: () => true,
    wrap: b => Buffer.concat([Buffer.from('p:'), b]),
    unwrap: b => Buffer.from(b.subarray(2))
};

const KEY_A = Buffer.alloc(32, 1).toString('base64url');
const KEY_B = Buffer.alloc(32, 2).toString('base64url');

function setup(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-rooms-'));
    const logs = [];
    const rooms = createSavedRooms({ dir: path.join(dir, 'saved-rooms'), protector: fakeProtector, log: (l, x) => logs.push([l, x]) });
    t.after(() => {
        rooms.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { rooms, logs };
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
    node.events.emit('message', { peerId: 'peer-1', id: 'm1', from: 'bob', text: 'hi', time: 5 });
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
    node.events.emit('message', { peerId: 'peer-1', id: 'm1', from: 'bob', text: 'hi', time: 5 });
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
