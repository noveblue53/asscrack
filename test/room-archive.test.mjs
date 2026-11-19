import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { roomFingerprint, openRoomArchive } from '../src/application/room-archive.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'room-archive-'));
}

function fakeProtector(id, { available = true } = {}) {
  const p = {
    id,
    on: available,
    available: () => p.on,
    wrap: (buf) => Buffer.concat([Buffer.from(`${p.id}:`), buf]),
    unwrap: (buf) => {
      const pre = Buffer.from(`${p.id}:`);
      if (!buf.subarray(0, pre.length).equals(pre)) throw new Error('cannot unwrap');
      return Buffer.from(buf.subarray(pre.length));
    },
  };
  return p;
}

function snapshot(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).sort()) out[f] = fs.readFileSync(path.join(dir, f)).toString('hex');
  return out;
}

const KEY = Buffer.alloc(32, 7);

function seed(dir, protector) {
  const a = openRoomArchive({ dir, protector });
  assert.equal(a.state().state, 'open');
  const { roomId } = a.saveRoom({ name: 'room', roomKey: KEY, invite: 'inv', userName: 'u', keepHistory: true });
  a.addMessage(roomId, { id: 'm1', from: 'u', text: 'secret-plaintext-xyz', time: 1, own: true, source: 'send' });
  a.close();
  return roomId;
}

test('fingerprint: format and known value', () => {
  const name = 'Räum';
  const key = Buffer.from([1, 2, 3]);
  const nb = Buffer.from(name, 'utf8');
  const lenK = Buffer.alloc(4); lenK.writeUInt32BE(3);
  const lenN = Buffer.alloc(4); lenN.writeUInt32BE(nb.length);
  const bytes = Buffer.concat([Buffer.from('asscrack-room-id'), Buffer.from([0, 1]), lenK, key, lenN, nb]);
  const expect = 'v1-' + crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(roomFingerprint(name, key), expect);
  assert.equal(roomFingerprint(name, new Uint8Array(key)), expect);
  assert.equal(roomFingerprint(name, key.toString('base64url')), expect);
  assert.match(expect, /^v1-[0-9a-f]{64}$/);
});

test('fingerprint: name and key change the result, encoding has one meaning', () => {
  const k1 = Buffer.alloc(32, 1);
  const k2 = Buffer.alloc(32, 2);
  assert.notEqual(roomFingerprint('a', k1), roomFingerprint('a', k2));
  assert.notEqual(roomFingerprint('a', k1), roomFingerprint('b', k1));
  assert.notEqual(roomFingerprint('bc', Buffer.from([0x61])), roomFingerprint('c', Buffer.from([0x61, 0x62])));
  const nfc = 'café';
  const nfd = 'café';
  assert.notEqual(roomFingerprint(nfc, k1), roomFingerprint(nfd, k1));
});

test('fingerprint: bad inputs throw TypeError', () => {
  assert.throws(() => roomFingerprint(1, KEY), TypeError);
  assert.throws(() => roomFingerprint('a', Buffer.alloc(0)), TypeError);
  assert.throws(() => roomFingerprint('a', ''), TypeError);
  assert.throws(() => roomFingerprint('a', 5), TypeError);
  assert.throws(() => roomFingerprint('a', null), TypeError);
});

test('key: missing key file with existing database', () => {
  const dir = tmpDir();
  seed(dir, fakeProtector('A'));
  fs.rmSync(path.join(dir, 'archive.key'));
  const before = snapshot(dir);
  const a = openRoomArchive({ dir, protector: fakeProtector('A') });
  assert.deepEqual(a.state(), { state: 'locked', reason: 'key-missing' });
  assert.throws(() => a.listRooms(), Error);
  a.close();
  assert.deepEqual(snapshot(dir), before);
  assert.equal(fs.existsSync(path.join(dir, 'archive.key')), false);
});

test('key: a key that does not unwrap, then unlock', () => {
  const dir = tmpDir();
  const roomId = seed(dir, fakeProtector('A'));
  const before = snapshot(dir);
  const b = fakeProtector('B');
  const a = openRoomArchive({ dir, protector: b });
  assert.deepEqual(a.state(), { state: 'locked', reason: 'key-unwrap-failed' });
  assert.deepEqual(snapshot(dir), before);
  b.id = 'A'; // stop the cause
  assert.deepEqual(a.unlock(), { state: 'open', reason: null });
  assert.equal(a.listMessages(roomId)[0].text, 'secret-plaintext-xyz');
  a.close();
  const c = openRoomArchive({ dir, protector: fakeProtector('A') });
  assert.equal(c.getRoom(roomId).name, 'room');
  c.close();
});

test('key: key file is not JSON', () => {
  const dir = tmpDir();
  seed(dir, fakeProtector('A'));
  fs.writeFileSync(path.join(dir, 'archive.key'), 'not json');
  const before = snapshot(dir);
  const a = openRoomArchive({ dir, protector: fakeProtector('A') });
  assert.deepEqual(a.state(), { state: 'locked', reason: 'key-unreadable' });
  a.close();
  assert.deepEqual(snapshot(dir), before);
});

test('key: protection not available makes no file', () => {
  const dir = path.join(tmpDir(), 'saved-rooms');
  const a = openRoomArchive({ dir, protector: fakeProtector('A', { available: false }) });
  assert.deepEqual(a.state(), { state: 'unavailable', reason: 'protection-unavailable' });
  a.close();
  assert.equal(fs.existsSync(dir), false);
});

test('interrupted first start: only archive.key.tmp exists', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'archive.key.tmp'), 'partial');
  const a = openRoomArchive({ dir, protector: fakeProtector('A') });
  assert.equal(a.state().state, 'open');
  a.close();
  assert.equal(fs.existsSync(path.join(dir, 'archive.key.tmp')), false);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'archive.key'), 'utf8'));
  assert.equal(j.v, 1);
  assert.equal(typeof j.wrapped, 'string');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'archive.key')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'archive.db')).mode & 0o777, 0o600);
  }
});

test('interrupted first start: key exists, no database', () => {
  const dir = tmpDir();
  seed(dir, fakeProtector('A'));
  fs.rmSync(path.join(dir, 'archive.db'));
  const key = fs.readFileSync(path.join(dir, 'archive.key'));
  const a = openRoomArchive({ dir, protector: fakeProtector('A') });
  assert.equal(a.state().state, 'open');
  assert.deepEqual(a.listRooms(), []);
  a.close();
  assert.ok(fs.existsSync(path.join(dir, 'archive.db')));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'archive.key')), key);
});

test('rooms: save, update, list, remove', () => {
  const dir = tmpDir();
  const a = openRoomArchive({ dir, protector: fakeProtector('A') });
  const { roomId } = a.saveRoom({ name: 'r1', roomKey: KEY, invite: 'i1', userName: 'u', keepHistory: true });
  assert.equal(roomId, roomFingerprint('r1', KEY));
  const first = a.getRoom(roomId);
  assert.equal(first.roomKey, KEY.toString('base64url'));
  a.saveRoom({ name: 'r1', roomKey: KEY, invite: 'i2', userName: 'v', keepHistory: false });
  const second = a.getRoom(roomId);
  assert.equal(second.invite, 'i2');
  assert.equal(second.keepHistory, false);
  assert.equal(second.savedAt, first.savedAt);
  const { roomId: r2 } = a.saveRoom({ name: 'r2', roomKey: KEY, keepHistory: true });
  a.markOpened(roomId, 100);
  a.markOpened(r2, 200);
  const list = a.listRooms();
  assert.deepEqual(list.map((r) => r.roomId), [r2, roomId]);
  assert.equal('roomKey' in list[0], false);
  assert.equal('invite' in list[0], false);
  a.setKeepHistory(r2, false);
  assert.equal(a.getRoom(r2).keepHistory, false);
  a.addMessage(roomId, { id: 'x', text: 't', time: 1, source: 'live', peerId: 'p' });
  a.removeRoom(roomId);
  assert.equal(a.getRoom(roomId), null);
  assert.deepEqual(a.listMessages(roomId), []);
  a.close();
});

test('rows: one row per (room, message ID), order and limit', () => {
  const dir = tmpDir();
  const a = openRoomArchive({ dir, protector: fakeProtector('A') });
  const { roomId: r1 } = a.saveRoom({ name: 'r1', roomKey: KEY, keepHistory: true });
  const { roomId: r2 } = a.saveRoom({ name: 'r2', roomKey: KEY, keepHistory: true });
  const m = { id: 'm1', from: 'u', text: 'hi', time: 5, own: false, source: 'live', peerId: null };
  assert.equal(a.addMessage(r1, m), true);
  assert.equal(a.addMessage(r1, m), false);
  assert.equal(a.addMessage(r2, m), true);
  assert.equal(a.listMessages(r1).length, 1);
  assert.equal(a.listMessages(r2).length, 1);
  assert.throws(() => a.addMessage(r1, { ...m, id: 'm2', source: 'other' }));
  a.addMessage(r1, { ...m, id: 'b', time: 3 });
  a.addMessage(r1, { ...m, id: 'a', time: 3 });
  a.addMessage(r1, { ...m, id: 'z', time: 9 });
  assert.deepEqual(a.listMessages(r1).map((x) => x.id), ['a', 'b', 'm1', 'z']);
  assert.deepEqual(a.listMessages(r1, { limit: 2 }).map((x) => x.id), ['m1', 'z']);
  assert.deepEqual(a.listMessages(r1)[0], { id: 'a', from: 'u', text: 'hi', time: 3, own: false, source: 'live', peerId: null });
  a.close();
  assert.throws(() => a.listMessages(r1), Error);
});

test('rows: plain open and wrong key cannot read, file has no plaintext', () => {
  const dir = tmpDir();
  seed(dir, fakeProtector('A'));
  const file = path.join(dir, 'archive.db');
  assert.equal(fs.readFileSync(file).includes(Buffer.from('secret-plaintext-xyz')), false);
  const plain = new Database(file);
  try {
    assert.throws(() => plain.prepare('SELECT body FROM messages').all(), /not a database/);
  } finally { plain.close(); }
  const wrong = new Database(file);
  try {
    wrong.pragma("cipher='sqlcipher'");
    wrong.pragma('legacy=4');
    wrong.pragma(`key='${'00'.repeat(32)}'`);
    assert.throws(() => wrong.prepare('SELECT body FROM messages').all(), /not a database/);
  } finally { wrong.close(); }
});

test('key: key unwraps but does not open the database (database-unreadable)', () => {
  const x = tmpDir();
  seed(x, fakeProtector('A'));
  const y = tmpDir();
  const b = openRoomArchive({ dir: y, protector: fakeProtector('A') });
  assert.equal(b.state().state, 'open');
  b.close();
  fs.copyFileSync(path.join(y, 'archive.key'), path.join(x, 'archive.key'));
  const before = snapshot(x);
  const a = openRoomArchive({ dir: x, protector: fakeProtector('A') });
  assert.deepEqual(a.state(), { state: 'locked', reason: 'database-unreadable' });
  a.close();
  assert.deepEqual(snapshot(x), before);
});
