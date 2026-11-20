import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { roomFingerprint, openRoomArchive, ARCHIVE_LIMITS } from '../src/application/room-archive.mjs';

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

function openRoom(t, limits) {
  const dir = tmpDir();
  const a = openRoomArchive({ dir, protector: fakeProtector('k'), limits });
  // Close before the delete: Windows cannot delete an open database file.
  t.after(() => a.close());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { roomId } = a.saveRoom({ name: 'room', roomKey: KEY, userName: 'u' });
  return { dir, a, roomId };
}

const row = (id, time, text = 't', from = 'u') => ({ id, from, text, time, source: 'live' });

test('limits: default values', () => {
  assert.deepEqual({ ...ARCHIVE_LIMITS }, { maxRows: 10000, maxBytes: 8388608, maxRowBytes: 65536 });
});

test('paging with before gives older rows in ascending order, limit clamps to 1..500', (t) => {
  const { a, roomId } = openRoom(t);
  for (let i = 1; i <= 10; i++) a.addMessage(roomId, row(`m${String(i).padStart(2, '0')}`, i));
  a.addMessage(roomId, row('a', 5));
  a.addMessage(roomId, row('z', 5));
  // Order by (time, msg_id): ... m04(4), a(5), m05(5), z(5), m06(6) ...
  assert.deepEqual(a.listMessages(roomId, { limit: 3, before: { time: 5, id: 'z' } }).map((x) => x.id), ['m04', 'a', 'm05']);
  assert.deepEqual(a.listMessages(roomId, { limit: 2, before: { time: 5, id: 'a' } }).map((x) => x.id), ['m03', 'm04']);
  assert.deepEqual(a.listMessages(roomId, { before: { time: 1, id: 'm01' } }), []);
  assert.equal(a.listMessages(roomId, { limit: 0 }).length, 1);
  assert.equal(a.listMessages(roomId, { limit: -5 }).length, 1);
  for (let i = 0; i < 600; i++) a.addMessage(roomId, row(`n${i}`, 100 + i));
  assert.equal(a.listMessages(roomId, { limit: 9999 }).length, 500);
});

test('clearMessages deletes the rows of one room and gives the IDs', (t) => {
  const { a, roomId } = openRoom(t);
  const other = a.saveRoom({ name: 'other', roomKey: KEY, userName: 'u' }).roomId;
  a.addMessage(roomId, row('x', 1));
  a.addMessage(roomId, row('y', 2));
  a.addMessage(other, row('x', 1));
  assert.deepEqual(a.clearMessages(roomId).sort(), ['x', 'y']);
  assert.deepEqual(a.listMessages(roomId), []);
  assert.equal(a.listMessages(other).length, 1);
  assert.deepEqual(a.roomUsage(roomId), { rows: 0, bytes: 0 });
  assert.equal(a.getRoom(roomId).name, 'room');
  assert.deepEqual(a.clearMessages(roomId), []);
});

test('row limit: the oldest rows by (time, msg_id) go', (t) => {
  const { a, roomId } = openRoom(t, { maxRows: 3 });
  a.addMessage(roomId, row('b', 1));
  a.addMessage(roomId, row('a', 1));
  a.addMessage(roomId, row('c', 2));
  assert.equal(a.addMessage(roomId, row('d', 3)), true);
  assert.deepEqual(a.listMessages(roomId).map((x) => x.id), ['b', 'c', 'd']);
  // An older row than all others is inserted, then pruned at once.
  assert.equal(a.addMessage(roomId, row('old', 0)), true);
  assert.deepEqual(a.listMessages(roomId).map((x) => x.id), ['b', 'c', 'd']);
  assert.equal(a.roomUsage(roomId).rows, 3);
});

test('byte limit: body plus sender in UTF-8 bytes, the oldest rows go', (t) => {
  const { a, roomId } = openRoom(t, { maxBytes: 20 });
  a.addMessage(roomId, row('1', 1, 'ää', 'u')); // 4 + 1 = 5
  a.addMessage(roomId, row('2', 2, 'abcd', 'u')); // 5
  a.addMessage(roomId, row('3', 3, 'abcd', null)); // 4
  assert.deepEqual(a.roomUsage(roomId), { rows: 3, bytes: 14 });
  a.addMessage(roomId, row('4', 4, 'abcdefgh', 'u')); // 9, total 23 > 20
  assert.deepEqual(a.listMessages(roomId).map((x) => x.id), ['2', '3', '4']);
  assert.deepEqual(a.roomUsage(roomId), { rows: 3, bytes: 18 });
});

test('row size limit: a larger row throws row-too-large and adds nothing', (t) => {
  const { a, roomId } = openRoom(t, { maxRowBytes: 10 });
  assert.equal(a.addMessage(roomId, row('ok', 1, 'abcdefghi', 'u')), true); // 10
  assert.throws(() => a.addMessage(roomId, row('big', 2, 'äbcdefghi', 'u')), (err) => {
    assert.ok(err instanceof RangeError);
    assert.equal(err.code, 'row-too-large');
    return true;
  });
  assert.deepEqual(a.listMessages(roomId).map((x) => x.id), ['ok']);
});

test('a closed archive throws on addMessage', (t) => {
  const { a, roomId } = openRoom(t);
  a.close();
  assert.throws(() => a.addMessage(roomId, row('x', 1)), /locked/);
});

test('250 rows: after a reopen, 200 newest rows, then one page of 50 older rows, each ID one time', (t) => {
  const dir = tmpDir();
  const p = fakeProtector('k');
  let a = openRoomArchive({ dir, protector: p });
  const { roomId } = a.saveRoom({ name: 'room', roomKey: KEY, userName: 'u' });
  for (let i = 1; i <= 250; i++) a.addMessage(roomId, row(`m${String(i).padStart(3, '0')}`, 1000 + i, `line ${i}`));
  a.close();
  a = openRoomArchive({ dir, protector: p });
  t.after(() => a.close());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(a.state().state, 'open');
  const first = a.listMessages(roomId);
  assert.equal(first.length, 200);
  assert.equal(first[0].text, 'line 51');
  assert.equal(first[199].text, 'line 250');
  const page = a.listMessages(roomId, { limit: 100, before: { time: first[0].time, id: first[0].id } });
  assert.equal(page.length, 50);
  assert.equal(page[0].text, 'line 1');
  const ids = [...page, ...first].map((x) => x.id);
  assert.equal(new Set(ids).size, 250);
  assert.deepEqual(ids, Array.from({ length: 250 }, (_, i) => `m${String(i + 1).padStart(3, '0')}`));
});

test('a version 1 database opens and goes to version 2 with its rows', (t) => {
  const dir = tmpDir();
  const p = fakeProtector('k');
  const roomId = seed(dir, p);
  // Make the file a version 1 file: no index, user_version 1.
  const key = p.unwrap(Buffer.from(JSON.parse(fs.readFileSync(path.join(dir, 'archive.key'), 'utf8')).wrapped, 'base64'));
  const db = new Database(path.join(dir, 'archive.db'));
  db.pragma("cipher='sqlcipher'");
  db.pragma('legacy=4');
  db.pragma(`key='${key.toString('hex')}'`);
  db.exec('DROP INDEX IF EXISTS messages_order');
  db.pragma('user_version=1');
  db.close();
  const a = openRoomArchive({ dir, protector: p });
  t.after(() => a.close());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(a.state().state, 'open');
  assert.equal(a.listMessages(roomId)[0].text, 'secret-plaintext-xyz');
});
