'use strict';
// WP1 trial: SQLCipher scheme with better-sqlite3-multiple-ciphers in the Electron runtime.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3-multiple-ciphers');

const out = {};
out.runtime = { electron: process.versions.electron || null, node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch };
out.bindingPath = require(path.join(__dirname, 'node_modules/better-sqlite3-multiple-ciphers/lib/binding.js')).getPrebuildPath();
const file = path.join(__dirname, 'archive-trial.db');
for (const f of [file, file + '-wal', file + '-shm', file + '-journal']) { try { fs.unlinkSync(f); } catch {} }

const KEY = 'trial-key-0123456789';
function step(name, fn) {
  try { out[name] = { ok: true, value: fn() }; }
  catch (e) { out[name] = { ok: false, error: `${e.name}: ${e.message}`, code: e.code }; }
}

function openSqlcipher(key) {
  const db = new Database(file);
  db.pragma("cipher='sqlcipher'");
  db.pragma('legacy=4');
  if (key !== undefined) db.pragma(`key='${key}'`);
  return db;
}

// 1. Create, write one row, close.
step('create', () => {
  const db = openSqlcipher(KEY);
  const r = {};
  r.cipher = db.pragma('cipher', { simple: true });
  r.legacy = db.pragma('legacy', { simple: true });
  r.kdf_iter = db.pragma('kdf_iter', { simple: true });
  r.cipher_page_size = db.pragma('legacy_page_size', { simple: true });
  r.hmac_algorithm = db.pragma('hmac_algorithm', { simple: true });
  r.kdf_algorithm = db.pragma('kdf_algorithm', { simple: true });
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, room TEXT, body TEXT)');
  db.prepare('INSERT INTO messages (room, body) VALUES (?, ?)').run('lan-room', 'hello archive');
  r.journal = db.pragma('journal_mode', { simple: true });
  r.sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;
  try { r.mcVersion = db.prepare('SELECT sqlite3mc_version() AS v').get().v; } catch (e) { r.mcVersion = `ERR ${e.message}`; }
  try { r.cipherVersionPragma = db.pragma('cipher_version', { simple: true }); } catch (e) { r.cipherVersionPragma = `ERR ${e.message}`; }
  db.close();
  return r;
});

// File header check: an SQLCipher file has no "SQLite format 3" header.
step('fileHeader', () => {
  const head = fs.readFileSync(file).subarray(0, 16);
  return { hex: head.toString('hex'), isPlainSqlite: head.toString('latin1').startsWith('SQLite format 3'), size: fs.statSync(file).size };
});

// 2. Open again with the key and read the row.
step('readWithKey', () => {
  const db = openSqlcipher(KEY);
  const rows = db.prepare('SELECT id, room, body FROM messages').all();
  db.close();
  return rows;
});

// 3. Wrong key.
step('readWrongKey', () => {
  const db = openSqlcipher('wrong-key');
  try { return db.prepare('SELECT count(*) AS n FROM messages').get(); } finally { db.close(); }
});

// 4. No key (SQLCipher scheme set, no key pragma).
step('readNoKeyCipherSet', () => {
  const db = openSqlcipher(undefined);
  try { return db.prepare('SELECT count(*) AS n FROM messages').get(); } finally { db.close(); }
});

// 5. No key, plain open (no pragma at all).
step('readNoKeyPlain', () => {
  const db = new Database(file);
  try { return db.prepare('SELECT count(*) AS n FROM messages').get(); } finally { db.close(); }
});

// 6. Wrong key: is the error at the pragma or at the first read?
step('wrongKeyPragmaResult', () => {
  const db = openSqlcipher(undefined);
  try {
    const r = db.pragma("key='wrong-key'");
    let first;
    try { first = db.prepare('SELECT count(*) FROM sqlite_master').pluck().get(); } catch (e) { first = `${e.name}: ${e.message} (${e.code})`; }
    return { pragmaKeyReturn: r, firstRead: first };
  } finally { db.close(); }
});

// 7. key() method API (Buffer).
step('keyMethod', () => {
  const db = new Database(file);
  db.pragma("cipher='sqlcipher'");
  db.pragma('legacy=4');
  const rc = typeof db.key === 'function' ? db.key(Buffer.from(KEY)) : 'no key() method';
  const n = db.prepare('SELECT count(*) AS n FROM messages').get().n;
  db.close();
  return { rc, n };
});

console.log(JSON.stringify(out, null, 2));
