// Encrypted room archive (SQLCipher 4 format) for the Electron main process.
// This module does not import electron. The app gives the directory and the protector.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
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
  user_name TEXT, keep_history INTEGER NOT NULL, saved_at INTEGER NOT NULL, opened_at INTEGER);
CREATE TABLE IF NOT EXISTS messages(room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  msg_id TEXT NOT NULL, sender TEXT, body TEXT NOT NULL, time INTEGER NOT NULL, own INTEGER NOT NULL,
  source TEXT NOT NULL, peer_id TEXT, PRIMARY KEY(room_id, msg_id));
CREATE INDEX IF NOT EXISTS messages_order ON messages(room_id, time, msg_id);
CREATE TABLE IF NOT EXISTS channels(room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(room_id,channel_id));
CREATE TABLE IF NOT EXISTS channel_messages(room_id TEXT NOT NULL, msg_id TEXT NOT NULL, sender TEXT, body TEXT NOT NULL,
  time INTEGER NOT NULL, own INTEGER NOT NULL, source TEXT NOT NULL, peer_id TEXT, channel_id TEXT NOT NULL,
  PRIMARY KEY(room_id,msg_id), FOREIGN KEY(room_id,channel_id) REFERENCES channels(room_id,channel_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS channel_message_order ON channel_messages(room_id,channel_id,time,msg_id);
CREATE VIEW IF NOT EXISTS public_messages AS
  SELECT room_id,msg_id,sender,body,time,own,source,peer_id,NULL AS channel_id FROM messages
  UNION ALL SELECT room_id,msg_id,sender,body,time,own,source,peer_id,channel_id FROM channel_messages;
CREATE TRIGGER IF NOT EXISTS remove_public_message INSTEAD OF DELETE ON public_messages BEGIN
  DELETE FROM messages WHERE room_id=OLD.room_id AND msg_id=OLD.msg_id AND OLD.channel_id IS NULL;
  DELETE FROM channel_messages WHERE room_id=OLD.room_id AND msg_id=OLD.msg_id AND OLD.channel_id IS NOT NULL;
END;
`;

// Limits of each room and of each row (DECISIONS.md P6).
export const ARCHIVE_LIMITS = Object.freeze({ maxRows: 10000, maxBytes: 8388608, maxRowBytes: MAX_MESSAGE_BYTES });

const ROW_BYTES_SQL = "length(CAST(body AS BLOB)) + length(CAST(coalesce(sender, '') AS BLOB))";

function mapRow(r) {
  return {
    id: r.msg_id, from: r.sender, text: r.body, time: r.time, own: r.own === 1, source: r.source,
    peerId: r.peer_id, ...(r.channel_id ? { channelId: r.channel_id } : {}),
  };
}

export function openRoomArchive({ dir, protector, limits = null }) {
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

  function openSequence() {
    if (!protector || !protector.available()) return setState('unavailable', 'protection-unavailable');
    fs.mkdirSync(dir, { recursive: true });
    let profileKey;
    if (fs.existsSync(keyFile)) {
      let wrapped;
      try {
        const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
        if (!j || j.v !== 1 || typeof j.wrapped !== 'string') throw new Error('bad');
        wrapped = Buffer.from(j.wrapped, 'base64');
      } catch {
        return setState('locked', 'key-unreadable');
      }
      try {
        profileKey = Buffer.from(protector.unwrap(wrapped));
      } catch {
        return setState('locked', 'key-unwrap-failed');
      }
      if (profileKey.length !== 32) return setState('locked', 'key-unwrap-failed');
    } else if (fs.existsSync(dbFile)) {
      return setState('locked', 'key-missing');
    } else {
      fs.rmSync(tmpFile, { force: true });
      profileKey = crypto.randomBytes(32);
      const wrapped = Buffer.from(protector.wrap(profileKey));
      writeFileSync600(tmpFile, JSON.stringify({ v: 1, wrapped: wrapped.toString('base64') }));
      fs.renameSync(tmpFile, keyFile);
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
        handle.pragma('user_version=3');
      })();
    } catch {
      try { handle.close(); } catch { /* ignore */ }
      return setState('locked', 'database-unreadable');
    }
    db = handle;
    return setState('open', null);
  }

  function need() {
    if (st.state !== 'open' || !db) throw new Error(`room archive is ${st.state} (${st.reason})`);
    return db;
  }

  openSequence();

  return {
    state: () => ({ ...st }),
    unlock() {
      if (st.state !== 'open') openSequence();
      return { ...st };
    },
    saveRoom({ name, roomKey, invite = null, userName = null, keepHistory = true }) {
      const d = need();
      const roomId = roomFingerprint(name, roomKey);
      const keyText = keyBytes(roomKey).toString('base64url');
      d.prepare(`INSERT INTO rooms(room_id, name, room_key, invite, user_name, keep_history, saved_at, opened_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(room_id) DO UPDATE SET name=excluded.name, room_key=excluded.room_key, invite=excluded.invite,
          user_name=excluded.user_name, keep_history=excluded.keep_history`)
        .run(roomId, name, keyText, invite ?? null, userName ?? null, keepHistory ? 1 : 0, Date.now());
      return { roomId };
    },
    getRoom(roomId) {
      const r = need().prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
      if (!r) return null;
      return {
        roomId: r.room_id, name: r.name, roomKey: r.room_key, invite: r.invite, userName: r.user_name,
        keepHistory: r.keep_history === 1, savedAt: r.saved_at, openedAt: r.opened_at,
      };
    },
    listRooms() {
      return need().prepare(`SELECT room_id, name, user_name, keep_history, saved_at, opened_at FROM rooms
        ORDER BY opened_at IS NULL, opened_at DESC, saved_at DESC`).all().map((r) => ({
        roomId: r.room_id, name: r.name, userName: r.user_name, keepHistory: r.keep_history === 1,
        savedAt: r.saved_at, openedAt: r.opened_at,
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
    removeRoom(roomId) {
      const d = need();
      d.transaction(() => {
        d.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId);
        d.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId);
      })();
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
    addMessage(roomId, { id, from = null, text, time, own = false, source, peerId = null, channelId = null }) {
      const d = need();
      if (source !== 'send' && source !== 'live') throw new Error(`addMessage: bad source ${source}`);
      const body = String(text);
      const size = Buffer.byteLength(body, 'utf8') + Buffer.byteLength(from ?? '', 'utf8');
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
        // Prune the oldest rows by (time, msg_id) until the room is in the limits.
        const usage = d.prepare(`SELECT count(*) AS n, coalesce(sum(${ROW_BYTES_SQL}), 0) AS b FROM public_messages
          WHERE room_id = ?`).get(roomId);
        let rows = usage.n;
        let bytes = usage.b;
        if (rows > lim.maxRows || bytes > lim.maxBytes) {
          const del = d.prepare('DELETE FROM public_messages WHERE room_id = ? AND msg_id = ?');
          const it = d.prepare(`SELECT msg_id, ${ROW_BYTES_SQL} AS sz FROM public_messages WHERE room_id = ?
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
      const rows = need().prepare(`SELECT msg_id AS id, sender AS "from", body AS text, time, channel_id AS channelId
        FROM public_messages WHERE room_id = ? AND ((source = 'live' AND own = 0) OR (source = 'send' AND own = 1))
        ORDER BY time DESC, msg_id DESC`).iterate(roomId);
      const messages = [];
      for (const row of rows) {
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
        rows = d.prepare(`SELECT * FROM (SELECT * FROM public_messages WHERE room_id = ?${filter}
          AND (time < ? OR (time = ? AND msg_id < ?))
          ORDER BY time DESC, msg_id DESC LIMIT ?) ORDER BY time ASC, msg_id ASC`)
          .all(...args, before.time, before.time, String(before.id), n);
      } else {
        rows = d.prepare(`SELECT * FROM (SELECT * FROM public_messages WHERE room_id = ?${filter}
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
      const r = need().prepare(`SELECT count(*) AS n, coalesce(sum(${ROW_BYTES_SQL}), 0) AS b FROM public_messages
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
