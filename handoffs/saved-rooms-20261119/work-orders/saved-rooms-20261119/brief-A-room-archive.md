# Brief A: the encrypted room archive (WP2, builder-t1)

## Goal
Write a store module for the Electron main process. It keeps saved rooms and chat lines in a SQLCipher database
under the profile. Reason: milestone 6 part 1 must reopen a room and read its lines with no peer.

## Files
- You can edit only these files. Both are new:
  - `src/application/room-archive.mjs`
  - `test/room-archive.test.mjs`
- Do not edit any other file.
- Do not change `src/application/voice.js` or `src/application/voice-worklet.js`.
- Do not change `package.json` or `package-lock.json`.

## Facts
- Project folder: `/home/user/asscrack`. Base commit: `cd1e3de` on branch `opus/saved-rooms`.
- Node 24 is at `/opt/node24/bin`. Put it first on `PATH` for each command. The default `node` in this VM is Node 22.
- Binding: `better-sqlite3-multiple-ciphers` 13.2.0 (installed). Use `import Database from 'better-sqlite3-multiple-ciphers'`.
  The API is the `better-sqlite3` API (`new Database(file)`, `db.pragma()`, `db.prepare()`, `db.close()`).
- The module must not import `electron`. The app gives the inputs. Thus `node --test` can load the module.
- Measured binding facts (`DECISIONS.md` S4):
  - The default cipher is `chacha20`. At each open, set these pragmas in this order: `cipher='sqlcipher'`, `legacy=4`,
    then `key`.
  - `PRAGMA key` with a wrong key returns `ok`. The error `SQLITE_NOTADB` comes at the first read.
- Room key: the app has it as a base64url string of 32 bytes (`readInvite()` in `src/network/invite.mjs`).

## Required API of `src/application/room-archive.mjs`
1. `roomFingerprint(roomName, roomKey)`:
   - `roomName` is a string. `roomKey` is a `Buffer`, a `Uint8Array` or a base64url string. The key has 1 byte or more.
     Throw a `TypeError` for other inputs.
   - Return `"v1-"` and 64 lowercase hex digits.
   - The digits are SHA-256 of these bytes, in this order:
     1. the ASCII text `asscrack-room-id`
     2. one byte `0x00`
     3. one byte `0x01` (the version)
     4. the key length as u32 big-endian
     5. the key bytes
     6. the byte length of the UTF-8 name as u32 big-endian
     7. the UTF-8 name bytes
   - Do not normalize the name. Do not use the user name, the invite text, a peer ID or the discovery tag.
2. `openRoomArchive({ dir, protector })` returns an archive object. It does not throw for a locked state.
   - `dir` is the folder of the archive. The app gives `<userData>/saved-rooms`. Make the folder when it is necessary.
   - `protector` is `{ available(): boolean, wrap(Buffer): Buffer, unwrap(Buffer): Buffer }`. `unwrap` throws when it
     cannot unwrap.
3. The archive object:
   - `state()` returns `{ state, reason }`. `state` is `open`, `locked` or `unavailable`. `reason` is `null` for `open`.
   - `unlock()` does the open sequence again when the state is not `open`. It returns `state()`.
   - `saveRoom({ name, roomKey, invite, userName, keepHistory })` returns `{ roomId }`. `roomId` is
     `roomFingerprint(name, roomKey)`. Store `roomKey` as the base64url text. A second save of the same room updates the
     fields and keeps `saved_at`.
   - `getRoom(roomId)` returns `{ roomId, name, roomKey, invite, userName, keepHistory, savedAt, openedAt }` or `null`.
   - `listRooms()` returns `[{ roomId, name, userName, keepHistory, savedAt, openedAt }]`, newest `opened_at` first. No
     key and no invite in this list.
   - `markOpened(roomId, time)`, `setKeepHistory(roomId, on)`, `removeRoom(roomId)`. `removeRoom` also deletes the
     messages of the room.
   - `addMessage(roomId, { id, from, text, time, own, source, peerId })` returns `true` for a new row and `false` for a
     row that exists. Use `INSERT OR IGNORE`. `source` is `send` or `live`. Throw for other values. `peerId` can be
     `null`.
   - `listMessages(roomId, { limit = 200 } = {})` returns the newest `limit` rows of the room as
     `[{ id, from, text, time, own, source, peerId }]`, sorted by `time`, then by `id`.
   - `close()`.
   - Each data method throws an `Error` when the state is not `open`.

## Files in `dir`
- `archive.db`: the SQLCipher database. `archive.key`: JSON `{"v":1,"wrapped":"<base64 of wrap(key)>"}`. Temporary
  file: `archive.key.tmp`. Write each file with mode `0o600`.
- The profile key: 32 random bytes (`crypto.randomBytes`). The database key is the pragma text `key='<64 hex digits of
  the profile key>'`.

## Open sequence
1. `protector.available()` is false: state `unavailable`, reason `protection-unavailable`. Make no file. Change no file.
2. `archive.key` exists:
   - The file is not valid JSON, or `v` is not 1, or `wrapped` is not a string: `locked`, `key-unreadable`.
   - `unwrap` throws, or the result is not 32 bytes: `locked`, `key-unwrap-failed`.
   - Open `archive.db` with the key (make it when it does not exist). Then read `sqlite_master` one time. A failure:
     `locked`, `database-unreadable`. Close the handle.
3. `archive.key` does not exist and `archive.db` exists: `locked`, `key-missing`. Do not make a new key.
4. Neither file exists (first start): delete `archive.key.tmp` if it exists. Make the key. Write `archive.key.tmp`,
   `fsync` it, rename it to `archive.key`. Then make `archive.db`.
5. After a good open: `PRAGMA temp_store=MEMORY`, `PRAGMA foreign_keys=ON`. Make the tables when they do not exist.
   Set `PRAGMA user_version=1`.
- A locked or unavailable state never deletes, moves or writes `archive.db` or `archive.key`. There is no plaintext
  fallback.

## Tables
- `rooms(room_id TEXT PRIMARY KEY, name TEXT NOT NULL, room_key TEXT NOT NULL, invite TEXT, user_name TEXT,
  keep_history INTEGER NOT NULL, saved_at INTEGER NOT NULL, opened_at INTEGER)`
- `messages(room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE, msg_id TEXT NOT NULL, sender TEXT,
  body TEXT NOT NULL, time INTEGER NOT NULL, own INTEGER NOT NULL, source TEXT NOT NULL, peer_id TEXT,
  PRIMARY KEY(room_id, msg_id))`

## Tests in `test/room-archive.test.mjs`
- Use `node:test` and `node:assert/strict`. Make each archive in a new folder from `fs.mkdtempSync(os.tmpdir() ...)`.
- Use a fake protector: `wrap` puts a fixed ID prefix before the bytes. `unwrap` throws when the prefix is not there. A
  fake with a different ID cannot unwrap.
- Fingerprint: the same name with a different key gives a different result. The same key with a different name gives a
  different result. Key `[0x61]` with name `bc`, and key `[0x61, 0x62]` with name `c`, give different results. NFC and
  NFD forms of one name give different results. One known value: build the bytes in the test, then compare the SHA-256.
- Key: a missing key file with an existing database (`key-missing`, the database bytes do not change, no new key file).
  A key that does not unwrap (`key-unwrap-failed`, no file changes). Then an open with the first fake reads the rows.
  `unlock()` gives `open` after the test stops the cause. A key file that is not JSON (`key-unreadable`). Protection not
  available (`unavailable`, the store makes no file).
- Interrupted first start: only `archive.key.tmp` exists (open, a new key, no tmp file). `archive.key` exists and no
  database (open, the store makes the database).
- Rows: two adds of one (room, message ID) give one row, and the second add returns `false`. One message ID in two rooms
  gives two rows. A plain SQLite open (the binding with no key pragma) cannot read a row. A wrong key cannot read a row.
  The bytes of `archive.db` do not contain the message text.
- Close each database handle in each test.

## Done when
- `node --test test/<file>.test.mjs` passes for `test/room-archive.test.mjs` (Node 24, 127.0.0.1).
- `node --test` cases for the fingerprint: the same name with a different key, and an encoding with only one meaning.
- `node --test` cases for the key: a missing key file, a key that does not unwrap, and an interrupted first start.
- `node --test` cases for the rows: one row for each (room, message ID). A plain SQLite open and a wrong key cannot read a row.

## Rules
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Builder B edits `src/network/node.mjs` at the same time. Do not run `npm test`. Run only your test file.
