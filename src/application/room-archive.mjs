// Encrypted room archive (SQLCipher 4 format) for the Electron main process.
// This module does not import electron. The app gives the directory and the protector.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { normalizeAttachment } from '../network/attachment.mjs';
import { validChannelId, validChannelName } from '../network/channels.mjs';
import { HISTORY_LIMIT, MAX_MESSAGE_BYTES, validHistoryItem } from '../network/history.mjs';

const ID_TAG = Buffer.from('asscrack-room-id', 'ascii');

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function keyBytes(roomKey) {
  let buf;
  if (typeof roomKey === 'string') {
    if (!/^[A-Za-z0-9_-]+$/.test(roomKey)) throw new TypeError('roomKey: not base64url');
    buf = Buffer.from(roomKey, 'base64url');
  } else if (roomKey instanceof Uint8Array) {
    buf = Buffer.from(roomKey.buffer, roomKey.byteOffset, roomKey.byteLength);
  } else {
    throw new TypeError('roomKey: must be a Buffer, a Uint8Array or a base64url string');
  }
  if (buf.length < 1) throw new TypeError('roomKey: empty');
  return buf;
}

export function roomFingerprint(roomName, roomKey) {
  if (typeof roomName !== 'string') throw new TypeError('roomName: must be a string');
  const key = keyBytes(roomKey);
  const name = Buffer.from(roomName, 'utf8');
  const h = crypto.createHash('sha256');
  h.update(ID_TAG);
  h.update(Buffer.from([0x00, 0x01]));
  h.update(u32be(key.length));
  h.update(key);
  h.update(u32be(name.length));
  h.update(name);
  return 'v1-' + h.digest('hex');
}

function writeFileSync600(file, data) {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function openDb(file, profileKey) {
  if (!fs.existsSync(file)) {
    // Make the file with mode 0o600 before SQLite opens it.
    fs.closeSync(fs.openSync(file, 'a', 0o600));
  }
  const db = new Database(file);
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma('legacy=4');
    db.pragma(`key='${profileKey.toString('hex')}'`);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    throw err;
  }
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms(room_id TEXT PRIMARY KEY, name TEXT NOT NULL, room_key TEXT NOT NULL, invite TEXT,
  user_name TEXT, keep_history INTEGER NOT NULL, saved_at INTEGER NOT NULL, opened_at INTEGER,
  admission TEXT NOT NULL DEFAULT 'legacy');
CREATE TABLE IF NOT EXISTS protected_room_memberships(room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS device_identity(slot INTEGER PRIMARY KEY CHECK(slot=1), identity TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  msg_id TEXT NOT NULL, sender TEXT, body TEXT NOT NULL, time INTEGER NOT NULL, own INTEGER NOT NULL,
  source TEXT NOT NULL, peer_id TEXT, PRIMARY KEY(room_id, msg_id));
CREATE INDEX IF NOT EXISTS messages_order ON messages(room_id, time, msg_id);
CREATE TABLE IF NOT EXISTS channels(room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(room_id,channel_id));
-- G6: the owner-signed voice channel catalog of a protected room (JSON). The node checks it again at each start.
CREATE TABLE IF NOT EXISTS voice_channels(room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
  catalog TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channel_messages(room_id TEXT NOT NULL, msg_id TEXT NOT NULL, sender TEXT, body TEXT NOT NULL,
  time INTEGER NOT NULL, own INTEGER NOT NULL, source TEXT NOT NULL, peer_id TEXT, channel_id TEXT NOT NULL,
  PRIMARY KEY(room_id,msg_id), FOREIGN KEY(room_id,channel_id) REFERENCES channels(room_id,channel_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS channel_message_order ON channel_messages(room_id,channel_id,time,msg_id);
CREATE VIEW IF NOT EXISTS public_messages AS
  SELECT room_id,msg_id,sender,body,time,own,source,peer_id,NULL AS channel_id FROM messages
  UNION ALL SELECT room_id,msg_id,sender,body,time,own,source,peer_id,channel_id FROM channel_messages;
-- Optional rich metadata sits beside the immutable text row. A 0.7.0 reader can
-- still read/delete General through its original messages table and queries.
CREATE TABLE IF NOT EXISTS message_attachments(room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  msg_id TEXT NOT NULL, descriptor TEXT NOT NULL, PRIMARY KEY(room_id, msg_id));
-- A local file association exists only while its opted-in archived card exists.
-- This table is never joined into public history, network replay or renderer rows.
CREATE TABLE IF NOT EXISTS verified_downloads(room_id TEXT NOT NULL,msg_id TEXT NOT NULL,path TEXT NOT NULL,
  PRIMARY KEY(room_id,msg_id), FOREIGN KEY(room_id,msg_id) REFERENCES message_attachments(room_id,msg_id) ON DELETE CASCADE);
-- 1.0.4: the checked preview PNG of an archived image card (room-media.mjs). It is local to this PC, like
-- verified_downloads, and goes when its card goes. The table needs no new user_version: 1.0.3 opens the file.
CREATE TABLE IF NOT EXISTS message_thumbnails(room_id TEXT NOT NULL,msg_id TEXT NOT NULL,png BLOB NOT NULL,
  saved_at INTEGER NOT NULL, PRIMARY KEY(room_id,msg_id),
  FOREIGN KEY(room_id,msg_id) REFERENCES message_attachments(room_id,msg_id) ON DELETE CASCADE);
CREATE TRIGGER IF NOT EXISTS remove_general_attachment AFTER DELETE ON messages BEGIN
  DELETE FROM message_attachments WHERE room_id=OLD.room_id AND msg_id=OLD.msg_id;
END;
CREATE TRIGGER IF NOT EXISTS remove_channel_attachment AFTER DELETE ON channel_messages BEGIN
  DELETE FROM message_attachments WHERE room_id=OLD.room_id AND msg_id=OLD.msg_id;
END;
CREATE VIEW IF NOT EXISTS archived_messages AS
  SELECT p.*, a.descriptor FROM public_messages p LEFT JOIN message_attachments a USING(room_id,msg_id);
-- G7a: the friends. Each friend is a saved protected 2-person room (rooms row) with one row here. The private
-- messages are in messages under the room ID of the friend room. state: 'active' or 'removed-you'.
CREATE TABLE IF NOT EXISTS friends(room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
  device_id TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL, slot INTEGER NOT NULL, added_at INTEGER NOT NULL,
  last_seen INTEGER, addrs TEXT, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS friend_blocks(device_id TEXT PRIMARY KEY, name TEXT, blocked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS friend_settings(slot INTEGER PRIMARY KEY CHECK(slot=1), name TEXT, upnp INTEGER NOT NULL);
-- G7b: the offline outbox of each friend (design F10). A row waits until the friend acknowledges it. Then the own line
-- goes into messages with its original time, in the same transaction.
CREATE TABLE IF NOT EXISTS friend_outbox(room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  msg_id TEXT NOT NULL, body TEXT NOT NULL, time INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(room_id, msg_id));
-- G7b: the received friend lines that were sent while this device was away, and the batch of each.
CREATE TABLE IF NOT EXISTS friend_away(room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  msg_id TEXT NOT NULL, batch TEXT NOT NULL, PRIMARY KEY(room_id, msg_id));
CREATE TRIGGER IF NOT EXISTS remove_friend_away AFTER DELETE ON messages BEGIN
  DELETE FROM friend_away WHERE room_id=OLD.room_id AND msg_id=OLD.msg_id;
END;
CREATE TRIGGER IF NOT EXISTS remove_public_message INSTEAD OF DELETE ON public_messages BEGIN
  DELETE FROM messages WHERE room_id=OLD.room_id AND msg_id=OLD.msg_id AND OLD.channel_id IS NULL;
  DELETE FROM channel_messages WHERE room_id=OLD.room_id AND msg_id=OLD.msg_id AND OLD.channel_id IS NOT NULL;
END;
`;

// Limits of each room and of each row (DECISIONS.md P6).
export const ARCHIVE_LIMITS = Object.freeze({ maxRows: 10000, maxBytes: 8388608, maxRowBytes: MAX_MESSAGE_BYTES });
// The stored thumbnails of each room (message_thumbnails): one PNG of at most 512 KiB (PREVIEW_LIMIT of
// media-formats.mjs), at most 32 MiB for each room (the size of the memory cache of room-media.mjs). The oldest go first.
export const THUMBNAIL_LIMITS = Object.freeze({ maxPng: 512 * 1024, maxRoomBytes: 32 * 1024 * 1024 });

const ROW_BYTES_SQL = "length(CAST(body AS BLOB)) + length(CAST(coalesce(sender, '') AS BLOB)) + length(CAST(coalesce(descriptor, '') AS BLOB))";

function readAttachment(json) {
  if (!json) return {};
  try {
    const attachment = normalizeAttachment(JSON.parse(json));
    return attachment ? { attachment } : {};
  } catch {
    return {};
  }
}

function mapFriend(r) {
  let addrs = [];
  try { const value = JSON.parse(r.addrs ?? '[]'); if (Array.isArray(value)) addrs = value; } catch { /* a bad row has no addresses */ }
  return {
    roomId: r.room_id, room: r.name, roomKey: r.room_key, userName: r.user_name, deviceId: r.device_id,
    nickname: r.nickname, slot: r.slot, addedAt: r.added_at, lastSeen: r.last_seen, addrs,
    state: r.state === 'removed-you' ? 'removed-you' : 'active',
  };
}

function mapRow(r) {
  return {
    id: r.msg_id, from: r.sender, text: r.body, time: r.time, own: r.own === 1, source: r.source,
    peerId: r.peer_id, ...(r.channel_id ? { channelId: r.channel_id } : {}), ...readAttachment(r.descriptor),
  };
}

// The result of protector.unwrap(): a Buffer, or { value: Buffer, reEncrypt: boolean } (the async protector).
function unwrapResult(r) {
  if (r && !(r instanceof Uint8Array) && typeof r === 'object' && 'value' in r) {
    return { value: Buffer.from(r.value), reEncrypt: r.reEncrypt === true };
  }
  return { value: Buffer.from(r), reEncrypt: false };
}

const isThenable = v => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';

// Runs the open steps. Each yield gives a protector result (a value or a promise).
function runSync(gen) {
  let step = gen.next();
  while (!step.done) {
    if (isThenable(step.value)) throw new Error('the protector is asynchronous: use openRoomArchiveAsync');
    step = gen.next(step.value);
  }
  return step.value;
}

async function runAsync(gen) {
  let step = gen.next();
  while (!step.done) {
    let v;
    try { v = await step.value; } catch (err) { step = gen.throw(err); continue; }
    step = gen.next(v);
  }
  return step.value;
}

// The protector can be synchronous (tests) or asynchronous (Electron safeStorage, makeProtector).
// openRoomArchive() needs a synchronous protector. openRoomArchiveAsync() accepts both.
export function openRoomArchive({ dir, protector, limits = null }) {
  const a = makeRoomArchive({ dir, protector, limits });
  a.unlock();
  return a;
}

export async function openRoomArchiveAsync({ dir, protector, limits = null }) {
  const a = makeRoomArchive({ dir, protector, limits });
  await a.unlockAsync();
  return a;
}

function makeRoomArchive({ dir, protector, limits = null }) {
  const lim = { ...ARCHIVE_LIMITS, ...(limits || {}) };
  const dbFile = path.join(dir, 'archive.db');
  const keyFile = path.join(dir, 'archive.key');
  const tmpFile = path.join(dir, 'archive.key.tmp');
  let db = null;
  let st = { state: 'locked', reason: 'not-opened' };

  function setState(state, reason) {
    st = { state, reason };
    return st;
  }

  // Each write has its own tmp file, so that two processes do not share one tmp file.
  function ownTmpFile() {
    return path.join(dir, `archive.key.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  }

  function keyText(wrapped) {
    return JSON.stringify({ v: 1, wrapped: Buffer.from(wrapped).toString('base64') });
  }

  // Replaces the key file (reEncrypt).
  function writeKey(wrapped) {
    const tmp = ownTmpFile();
    try {
      writeFileSync600(tmp, keyText(wrapped));
      fs.renameSync(tmp, keyFile);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // Creates the key file only if it does not exist. Gives false when an other process created it first (EEXIST).
  function createKeyExclusive(wrapped) {
    const tmp = ownTmpFile();
    try {
      writeFileSync600(tmp, keyText(wrapped));
      try {
        fs.linkSync(tmp, keyFile);
        return true;
      } catch (err) {
        if (err && err.code === 'EEXIST') return false;
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    // The file system refused the hard link: use an exclusive create of the key file.
    try {
      fs.writeFileSync(keyFile, keyText(wrapped), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') return false;
      throw err;
    }
  }

  // Reads and unwraps the existing key file. Gives { profileKey, reEncrypt } or { fail: reason }.
  function* readExistingKey() {
    let wrapped;
    try {
      const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      if (!j || j.v !== 1 || typeof j.wrapped !== 'string') throw new Error('bad');
      wrapped = Buffer.from(j.wrapped, 'base64');
    } catch {
      return { fail: 'key-unreadable' };
    }
    let profileKey;
    let reEncrypt;
    try {
      ({ value: profileKey, reEncrypt } = unwrapResult(yield protector.unwrap(wrapped)));
    } catch {
      return { fail: 'key-unwrap-failed' };
    }
    if (profileKey.length !== 32) return { fail: 'key-unwrap-failed' };
    return { profileKey, reEncrypt };
  }

  function* openSequence() {
    if (!protector || !(yield protector.available())) return setState('unavailable', 'protection-unavailable');
    fs.mkdirSync(dir, { recursive: true });
    let profileKey;
    let reEncrypt = false;
    let useExisting = fs.existsSync(keyFile);
    // An other process can create the key file and the database between the two checks: check the key file again.
    if (!useExisting && fs.existsSync(dbFile)) {
      useExisting = fs.existsSync(keyFile);
      if (!useExisting) return setState('locked', 'key-missing');
    }
    if (!useExisting) {
      // Remove the tmp file of an interrupted first start of an older version.
      fs.rmSync(tmpFile, { force: true });
      profileKey = crypto.randomBytes(32);
      let created;
      try {
        created = createKeyExclusive(yield protector.wrap(profileKey));
      } catch {
        return setState('locked', 'key-write-failed');
      }
      // An other process created the key file first: use its key.
      if (!created) useExisting = true;
    }
    if (useExisting) {
      const r = yield* readExistingKey();
      if (r.fail) return setState('locked', r.fail);
      ({ profileKey, reEncrypt } = r);
    }
    let handle;
    try {
      handle = openDb(dbFile, profileKey);
    } catch {
      return setState('locked', 'database-unreadable');
    }
    try {
      handle.pragma('temp_store=MEMORY');
      handle.pragma('foreign_keys=ON');
      const version = handle.pragma('user_version', { simple: true });
      if (version > 3) throw new Error('Archive written by a newer version');
      handle.transaction(() => {
        handle.exec(SCHEMA);
        const roomColumns = handle.pragma('table_info(rooms)');
        if (!roomColumns.some(column => column.name === 'admission')) {
          handle.exec("ALTER TABLE rooms ADD COLUMN admission TEXT NOT NULL DEFAULT 'legacy'");
        }
        handle.pragma('user_version=3');
      })();
    } catch {
      try { handle.close(); } catch { /* ignore */ }
      return setState('locked', 'database-unreadable');
    }
    db = handle;
    // safeStorage asked for a new encryption of the key (shouldReEncrypt). Only after the database opened with the key.
    // A failure keeps the old key file, which still opens.
    if (reEncrypt) {
      try { writeKey(yield protector.wrap(profileKey)); } catch { /* writeKey removed its own tmp file */ }
    }
    return setState('open', null);
  }

  function need() {
    if (st.state !== 'open' || !db) throw new Error(`room archive is ${st.state} (${st.reason})`);
    return db;
  }

  let pending = null;

  return {
    state: () => ({ ...st }),
    unlock() {
      if (st.state !== 'open') runSync(openSequence());
      return { ...st };
    },
    // One open at a time: a second call during an open waits for the same open.
    async unlockAsync() {
      if (st.state !== 'open') {
        if (!pending) pending = runAsync(openSequence()).finally(() => { pending = null; });
        await pending;
      }
      return { ...st };
    },
    saveRoom({ name, roomKey, invite = null, userName = null, keepHistory = true, membership = null }) {
      const d = need();
      const roomId = roomFingerprint(name, roomKey);
      const keyText = keyBytes(roomKey).toString('base64url');
      d.transaction(() => {
        d.prepare(`INSERT INTO rooms(room_id, name, room_key, invite, user_name, keep_history, saved_at, opened_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(room_id) DO UPDATE SET name=excluded.name, room_key=excluded.room_key, invite=excluded.invite,
          user_name=excluded.user_name, keep_history=excluded.keep_history`)
          .run(roomId, name, keyText, invite ?? null, userName ?? null, keepHistory ? 1 : 0, Date.now());
        if (membership !== null) {
          d.prepare("UPDATE rooms SET admission='protected' WHERE room_id=?").run(roomId);
          d.prepare(`INSERT INTO protected_room_memberships(room_id,snapshot) VALUES(?,?)
            ON CONFLICT(room_id) DO UPDATE SET snapshot=excluded.snapshot`).run(roomId, JSON.stringify(membership));
        }
      })();
      return { roomId };
    },
    getDeviceIdentity() {
      return need().prepare('SELECT identity FROM device_identity WHERE slot=1').get()?.identity ?? null;
    },
    hasProtectedRooms() {
      return Boolean(need().prepare("SELECT 1 FROM rooms WHERE admission<>'legacy' LIMIT 1").get());
    },
    rememberDeviceIdentity(value) {
      const d = need();
      d.prepare('INSERT INTO device_identity(slot,identity) VALUES(1,?) ON CONFLICT(slot) DO NOTHING').run(value);
      return d.prepare('SELECT identity FROM device_identity WHERE slot=1').get().identity;
    },
    updateMembership(roomId, membership) {
      const d = need();
      return d.transaction(() => {
        if (d.prepare("UPDATE rooms SET admission='protected' WHERE room_id=?").run(roomId).changes !== 1) return false;
        d.prepare(`INSERT INTO protected_room_memberships(room_id,snapshot) VALUES(?,?)
          ON CONFLICT(room_id) DO UPDATE SET snapshot=excluded.snapshot`).run(roomId, JSON.stringify(membership));
        return true;
      })();
    },
    getRoom(roomId) {
      const r = need().prepare(`SELECT rooms.*, protected_room_memberships.snapshot FROM rooms
        LEFT JOIN protected_room_memberships USING(room_id) WHERE room_id = ?`).get(roomId);
      if (!r) return null;
      return {
        roomId: r.room_id, name: r.name, roomKey: r.room_key, invite: r.invite, userName: r.user_name,
        keepHistory: r.keep_history === 1, savedAt: r.saved_at, openedAt: r.opened_at,
        ...(r.admission === 'legacy' ? {} : { protected: true, membership: r.snapshot ?? null }),
      };
    },
    listRooms() {
      // G7a: a friend room is not a saved room of the list.
      return need().prepare(`SELECT room_id, name, user_name, keep_history, saved_at, opened_at, admission FROM rooms
        WHERE room_id NOT IN (SELECT room_id FROM friends) ORDER BY opened_at IS NULL, opened_at DESC, saved_at DESC`).all().map((r) => ({
        roomId: r.room_id, name: r.name, userName: r.user_name, keepHistory: r.keep_history === 1,
        savedAt: r.saved_at, openedAt: r.opened_at,
        ...(r.admission === 'legacy' ? {} : { protected: true }),
      }));
    },
    setInvite(roomId, invite) {
      need().prepare('UPDATE rooms SET invite = ? WHERE room_id = ?').run(invite, roomId);
    },
    markOpened(roomId, time = Date.now()) {
      need().prepare('UPDATE rooms SET opened_at = ? WHERE room_id = ?').run(time, roomId);
    },
    setKeepHistory(roomId, on) {
      need().prepare('UPDATE rooms SET keep_history = ? WHERE room_id = ?').run(on ? 1 : 0, roomId);
    },
    setUserName(roomId, userName) {
      need().prepare('UPDATE rooms SET user_name = ? WHERE room_id = ?').run(userName, roomId);
    },
    removeRoom(roomId) {
      const d = need();
      d.transaction(() => {
        d.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId);
        d.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId);
      })();
    },
    // G7a: the friends, the block list and the friend settings.
    isFriendRoom(roomId) {
      return Boolean(need().prepare('SELECT 1 FROM friends WHERE room_id=?').get(roomId));
    },
    listFriends() {
      return need().prepare(`SELECT f.*, r.name, r.room_key, r.user_name FROM friends f JOIN rooms r USING(room_id)
        ORDER BY f.slot`).all().map(mapFriend);
    },
    // The friend room (rooms and protected_room_memberships) and its friends row, in one transaction.
    saveFriendRoom({ name, roomKey, userName, membership, friend }) {
      const d = need();
      const roomId = roomFingerprint(name, roomKey);
      d.transaction(() => {
        this.saveRoom({ name, roomKey, invite: null, userName, keepHistory: true, membership });
        d.prepare(`INSERT INTO friends(room_id,device_id,nickname,slot,added_at,last_seen,addrs,state)
          VALUES(?,?,?,?,?,NULL,?,'active')`).run(roomId, friend.deviceId, friend.nickname, friend.slot,
          friend.addedAt ?? Date.now(), JSON.stringify(friend.addrs ?? []));
      })();
      return { roomId };
    },
    // fields: nickname, lastSeen, addrs (array), state. Returns true for a changed row.
    updateFriend(roomId, fields) {
      const d = need();
      const sets = [];
      const args = [];
      if (fields.nickname !== undefined) { sets.push('nickname=?'); args.push(String(fields.nickname)); }
      if (fields.lastSeen !== undefined) { sets.push('last_seen=?'); args.push(fields.lastSeen); }
      if (fields.addrs !== undefined) { sets.push('addrs=?'); args.push(JSON.stringify(fields.addrs)); }
      if (fields.state !== undefined) { sets.push('state=?'); args.push(fields.state === 'removed-you' ? 'removed-you' : 'active'); }
      if (!sets.length) return false;
      return d.prepare(`UPDATE friends SET ${sets.join(',')} WHERE room_id=?`).run(...args, roomId).changes === 1;
    },
    friendBlocks() {
      return need().prepare('SELECT device_id, name, blocked_at FROM friend_blocks ORDER BY blocked_at').all()
        .map(r => ({ deviceId: r.device_id, name: r.name, blockedAt: r.blocked_at }));
    },
    addFriendBlock(deviceId, name) {
      need().prepare(`INSERT INTO friend_blocks(device_id,name,blocked_at) VALUES(?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET name=excluded.name`).run(deviceId, name ?? null, Date.now());
    },
    removeFriendBlock(deviceId) {
      return need().prepare('DELETE FROM friend_blocks WHERE device_id=?').run(deviceId).changes === 1;
    },
    friendSettings() {
      const r = need().prepare('SELECT name, upnp FROM friend_settings WHERE slot=1').get();
      return { name: r?.name ?? null, upnp: r?.upnp === 1 };
    },
    saveFriendSettings({ name, upnp }) {
      need().prepare(`INSERT INTO friend_settings(slot,name,upnp) VALUES(1,?,?)
        ON CONFLICT(slot) DO UPDATE SET name=excluded.name, upnp=excluded.upnp`).run(name ?? null, upnp ? 1 : 0);
    },
    // G7b: the outbox of one friend. addOutbox returns the seq of the new row, or null when cap rows wait.
    addOutbox(roomId, { id, text, time }, cap) {
      const d = need();
      return d.transaction(() => {
        const { n, top } = d.prepare('SELECT count(*) AS n, max(seq) AS top FROM friend_outbox WHERE room_id=?').get(roomId);
        if (n >= cap) return null;
        const seq = (top ?? 0) + 1;
        d.prepare('INSERT INTO friend_outbox(room_id,msg_id,body,time,seq) VALUES(?,?,?,?,?)')
          .run(roomId, String(id), String(text), time, seq);
        return seq;
      })();
    },
    listOutbox(roomId) {
      return need().prepare('SELECT msg_id, body, time, seq FROM friend_outbox WHERE room_id=? ORDER BY seq')
        .all(roomId).map(r => ({ id: r.msg_id, text: r.body, time: r.time, seq: r.seq }));
    },
    hasOutbox(roomId, id) {
      return Boolean(need().prepare('SELECT 1 FROM friend_outbox WHERE room_id=? AND msg_id=?').get(roomId, String(id)));
    },
    deleteOutbox(roomId, id) {
      return need().prepare('DELETE FROM friend_outbox WHERE room_id=? AND msg_id=?').run(roomId, String(id)).changes === 1;
    },
    // The friend acknowledged a waiting line: in one transaction, save the own line with its original time and delete
    // the outbox row. Returns the line, or null when no row waits (a repeated ack).
    deliverOutbox(roomId, id, from) {
      const d = need();
      return d.transaction(() => {
        const r = d.prepare('SELECT msg_id, body, time FROM friend_outbox WHERE room_id=? AND msg_id=?').get(roomId, String(id));
        if (!r) return null;
        const line = { id: r.msg_id, from, text: r.body, time: r.time, own: true };
        this.addMessage(roomId, { ...line, source: 'send', peerId: null });
        d.prepare('DELETE FROM friend_outbox WHERE room_id=? AND msg_id=?').run(roomId, r.msg_id);
        return line;
      })();
    },
    // G7b: a received line that was sent while this device was away, and its batch.
    addAwayMark(roomId, id, batch) {
      need().prepare('INSERT INTO friend_away(room_id,msg_id,batch) VALUES(?,?,?) ON CONFLICT DO NOTHING')
        .run(roomId, String(id), String(batch));
    },
    // The away marks of some lines: Map msg_id -> { batch, count } (count: the lines of that batch in the archive).
    awayMarks(roomId, ids) {
      const d = need();
      const rows = d.prepare(`SELECT msg_id, batch FROM friend_away WHERE room_id=? AND msg_id IN
        (SELECT value FROM json_each(?))`).all(roomId, JSON.stringify(ids.map(String)));
      const counts = new Map();
      const count = d.prepare('SELECT count(*) AS n FROM friend_away WHERE room_id=? AND batch=?');
      for (const r of rows) if (!counts.has(r.batch)) counts.set(r.batch, count.get(roomId, r.batch).n);
      return new Map(rows.map(r => [r.msg_id, { batch: r.batch, count: counts.get(r.batch) }]));
    },
    hasMessage(roomId, id) {
      return Boolean(need().prepare('SELECT 1 FROM public_messages WHERE room_id=? AND msg_id=?').get(roomId, String(id)));
    },
    rememberDownload(roomId, descriptor, file) {
      const valid = normalizeAttachment(descriptor);
      if (!valid || !path.isAbsolute(file)) return;
      need().prepare(`INSERT INTO verified_downloads(room_id,msg_id,path)
        SELECT room_id,msg_id,? FROM message_attachments WHERE room_id=? AND descriptor=?
        ON CONFLICT(room_id,msg_id) DO UPDATE SET path=excluded.path`).run(file, roomId, JSON.stringify(valid));
    },
    getDownload(roomId, messageId, descriptorId) {
      const row = need().prepare(`SELECT d.path,a.descriptor FROM verified_downloads d
        JOIN message_attachments a USING(room_id,msg_id) WHERE d.room_id=? AND d.msg_id=?`).get(roomId,messageId);
      if (!row) return null;
      const descriptor = normalizeAttachment(JSON.parse(row.descriptor));
      return descriptor?.id === descriptorId ? { descriptor, path: row.path } : null;
    },
    // The thumbnail of an archived image card, keyed by the exact descriptor (as rememberDownload). The caller
    // gives only PNG bytes that room-media.mjs checked. Gives true when a card took the PNG.
    rememberThumbnail(roomId, descriptor, png) {
      const valid = normalizeAttachment(descriptor);
      if (!valid || valid.kind !== 'image' || !Buffer.isBuffer(png) || png.length < 1 || png.length > THUMBNAIL_LIMITS.maxPng) return false;
      const d = need();
      const roomBytes = lim.maxThumbnailRoomBytes ?? THUMBNAIL_LIMITS.maxRoomBytes;
      return d.transaction(() => {
        const stored = d.prepare(`INSERT INTO message_thumbnails(room_id,msg_id,png,saved_at)
          SELECT room_id,msg_id,?,? FROM message_attachments WHERE room_id=? AND descriptor=?
          ON CONFLICT(room_id,msg_id) DO UPDATE SET png=excluded.png,saved_at=excluded.saved_at`)
          .run(png, Date.now(), roomId, JSON.stringify(valid)).changes > 0;
        if (!stored) return false;
        let bytes = d.prepare('SELECT coalesce(sum(length(png)),0) AS b FROM message_thumbnails WHERE room_id=?').get(roomId).b;
        if (bytes > roomBytes) {
          const del = d.prepare('DELETE FROM message_thumbnails WHERE room_id=? AND msg_id=?');
          const victims = [];
          for (const r of d.prepare(`SELECT msg_id, length(png) AS sz FROM message_thumbnails WHERE room_id=?
            ORDER BY saved_at ASC, rowid ASC`).iterate(roomId)) {
            if (bytes <= roomBytes) break;
            victims.push(r.msg_id); bytes -= r.sz;
          }
          for (const m of victims) del.run(roomId, m);
        }
        return true;
      })();
    },
    getThumbnail(roomId, descriptor) {
      const valid = normalizeAttachment(descriptor);
      if (!valid || valid.kind !== 'image') return null;
      const row = need().prepare(`SELECT t.png FROM message_thumbnails t JOIN message_attachments a USING(room_id,msg_id)
        WHERE t.room_id=? AND a.descriptor=?`).get(roomId, JSON.stringify(valid));
      return row ? Buffer.from(row.png) : null;
    },
    // The card of one archived line: { descriptor, own } or null. The archive keeps only live lines (the node checked
    // the device prefix of the ID and the source of the descriptor) and own lines, thus the pair is a checked pair.
    messageCard(roomId, messageId) {
      const row = need().prepare(`SELECT a.descriptor, p.own FROM message_attachments a JOIN public_messages p
        USING(room_id,msg_id) WHERE a.room_id=? AND a.msg_id=?`).get(roomId, String(messageId));
      const descriptor = row && normalizeAttachment(JSON.parse(row.descriptor));
      return descriptor ? { descriptor, own: row.own === 1 } : null;
    },
    // The descriptor of an own card with this descriptor ID, or null (a preview request of a peer names only the ID).
    ownCard(roomId, descriptorId) {
      const row = need().prepare(`SELECT a.descriptor FROM message_attachments a JOIN public_messages p USING(room_id,msg_id)
        WHERE a.room_id=? AND p.own=1 AND json_extract(a.descriptor,'$.id')=?`).get(roomId, String(descriptorId));
      const descriptor = row && normalizeAttachment(JSON.parse(row.descriptor));
      return descriptor?.id === descriptorId ? descriptor : null;
    },
    // Clear thumbnail cache (View menu): the stored thumbnails of one room. The cards stay.
    clearThumbnails(roomId) {
      return need().prepare('DELETE FROM message_thumbnails WHERE room_id=?').run(roomId).changes;
    },
    channels(roomId) {
      return need().prepare('SELECT channel_id AS id, name FROM channels WHERE room_id=? ORDER BY channel_id').all(roomId);
    },
    saveChannels(roomId, rows) {
      const d = need();
      const put = d.prepare(`INSERT INTO channels(room_id,channel_id,name) VALUES(?,?,?)
        ON CONFLICT(room_id,channel_id) DO UPDATE SET name=excluded.name WHERE excluded.name < channels.name`);
      d.transaction(() => { for (const row of rows) {
        if (validChannelId(row?.id) && validChannelName(row.name)) put.run(roomId, row.id, row.name);
      } })();
    },
    // G6: the saved voice channel catalog, or null. A row that does not read gives null.
    voiceChannels(roomId) {
      const row = need().prepare('SELECT catalog FROM voice_channels WHERE room_id=?').get(roomId);
      if (!row) return null;
      try { return JSON.parse(row.catalog); } catch { return null; }
    },
    // Keeps the catalog with the higher seq. The caller gives only a catalog that the node accepted.
    saveVoiceChannels(roomId, catalog) {
      if (!catalog || !Number.isSafeInteger(catalog.seq)) return false;
      const d = need();
      return d.transaction(() => {
        const old = d.prepare('SELECT catalog FROM voice_channels WHERE room_id=?').get(roomId);
        let oldSeq = -1;
        try { oldSeq = old ? JSON.parse(old.catalog).seq : -1; } catch { /* a bad row is replaced */ }
        if (Number.isSafeInteger(oldSeq) && oldSeq >= catalog.seq) return false;
        d.prepare(`INSERT INTO voice_channels(room_id,catalog) VALUES(?,?)
          ON CONFLICT(room_id) DO UPDATE SET catalog=excluded.catalog`).run(roomId, JSON.stringify(catalog));
        return true;
      })();
    },
    addMessage(roomId, { id, from = null, text, time, own = false, source, peerId = null, channelId = null, attachment = null }) {
      const d = need();
      if (source !== 'send' && source !== 'live') throw new Error(`addMessage: bad source ${source}`);
      const body = String(text);
      const normalized = normalizeAttachment(attachment);
      const descriptor = normalized ? JSON.stringify(normalized) : '';
      const size = Buffer.byteLength(body) + Buffer.byteLength(from ?? '') + Buffer.byteLength(descriptor);
      if (size > lim.maxRowBytes) {
        const err = new RangeError(`addMessage: row is ${size} bytes, limit ${lim.maxRowBytes}`);
        err.code = 'row-too-large';
        throw err;
      }
      return d.transaction(() => {
        // Legacy readers can reopen General without treating named messages as General posts.
        if (d.prepare('SELECT 1 FROM public_messages WHERE room_id=? AND msg_id=?').get(roomId,String(id))) return false;
        const values = [roomId, String(id), from, body, time, own ? 1 : 0, source, peerId];
        if (channelId !== null) {
          if (!validChannelId(channelId)) throw new Error('Invalid channel');
          d.prepare('INSERT INTO channel_messages(room_id,msg_id,sender,body,time,own,source,peer_id,channel_id) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(...values, channelId);
        } else {
          d.prepare('INSERT INTO messages(room_id,msg_id,sender,body,time,own,source,peer_id) VALUES(?,?,?,?,?,?,?,?)').run(...values);
        }
        if (descriptor) {
          d.prepare('INSERT INTO message_attachments(room_id,msg_id,descriptor) VALUES(?,?,?)')
            .run(roomId, String(id), descriptor);
        }
        // Prune the oldest rows by (time, msg_id) until the room is in the limits.
        const usage = d.prepare(`SELECT count(*) AS n, coalesce(sum(${ROW_BYTES_SQL}), 0) AS b FROM archived_messages
          WHERE room_id = ?`).get(roomId);
        let rows = usage.n;
        let bytes = usage.b;
        if (rows > lim.maxRows || bytes > lim.maxBytes) {
          const del = d.prepare('DELETE FROM public_messages WHERE room_id = ? AND msg_id = ?');
          const it = d.prepare(`SELECT msg_id, ${ROW_BYTES_SQL} AS sz FROM archived_messages WHERE room_id = ?
            ORDER BY time ASC, msg_id ASC`).iterate(roomId);
          const victims = [];
          for (const r of it) {
            if (rows <= lim.maxRows && bytes <= lim.maxBytes) break;
            victims.push(r.msg_id);
            rows -= 1;
            bytes -= r.sz;
          }
          for (const m of victims) del.run(roomId, m);
        }
        return true;
      })();
    },
    replayMessages(roomId) {
      // Only the public live/send rows in the v2 archive can go on the wire. Read newest first so an
      // older installation's non-shareable record cannot displace one of the newest eligible 200.
      const rows = need().prepare(`SELECT msg_id AS id, sender AS "from", body AS text, time, channel_id AS channelId, descriptor
        FROM archived_messages WHERE room_id = ? AND ((source = 'live' AND own = 0) OR (source = 'send' AND own = 1))
        ORDER BY time DESC, msg_id DESC`).iterate(roomId);
      const messages = [];
      for (const { descriptor, ...row } of rows) {
        Object.assign(row, readAttachment(descriptor));
        if (row.channelId === null) delete row.channelId;
        if (validHistoryItem(row)) messages.push(row);
        if (messages.length === HISTORY_LIMIT) break;
      }
      return messages.reverse();
    },
    listMessages(roomId, { limit = 200, before = null, channelId = null } = {}) {
      const d = need();
      let n = Math.trunc(Number(limit));
      if (!Number.isFinite(n) || n < 1) n = 1;
      if (n > 500) n = 500;
      const filter = channelId === null ? '' : " AND coalesce(channel_id,'general')=?";
      const args = channelId === null ? [roomId] : [roomId, channelId];
      let rows;
      if (before) {
        rows = d.prepare(`SELECT * FROM (SELECT * FROM archived_messages WHERE room_id = ?${filter}
          AND (time < ? OR (time = ? AND msg_id < ?))
          ORDER BY time DESC, msg_id DESC LIMIT ?) ORDER BY time ASC, msg_id ASC`)
          .all(...args, before.time, before.time, String(before.id), n);
      } else {
        rows = d.prepare(`SELECT * FROM (SELECT * FROM archived_messages WHERE room_id = ?${filter}
          ORDER BY time DESC, msg_id DESC LIMIT ?) ORDER BY time ASC, msg_id ASC`).all(...args, n);
      }
      return rows.map(mapRow);
    },
    clearMessages(roomId) {
      const d = need();
      return d.transaction(() => {
        const ids = d.prepare('SELECT msg_id FROM public_messages WHERE room_id = ?').all(roomId).map((r) => r.msg_id);
        d.prepare('DELETE FROM public_messages WHERE room_id = ?').run(roomId);
        return ids;
      })();
    },
    roomUsage(roomId) {
      const r = need().prepare(`SELECT count(*) AS n, coalesce(sum(${ROW_BYTES_SQL}), 0) AS b FROM archived_messages
        WHERE room_id = ?`).get(roomId);
      return { rows: r.n, bytes: r.b };
    },
    close() {
      if (db) { try { db.close(); } catch { /* ignore */ } }
      db = null;
      if (st.state === 'open') setState('locked', 'closed');
    },
  };
}
