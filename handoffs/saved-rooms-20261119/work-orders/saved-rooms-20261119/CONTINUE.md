# Continue: milestone 6 part 1, saved rooms (2026-11-19)

## State
- Branch `opus/saved-rooms`, commit `cd1e3de` (pushed, remote equals local). Base `598725f`.
- WP1 is done. The two WP1 lines of `GOAL_ACTIVE` are `[x]`.
- The operator approved the dependency (`DECISIONS.md`, S6). Commit `cd1e3de` adds `better-sqlite3-multiple-ciphers`
  13.2.0 and `"npmRebuild": false`. `npm test` after it: 198 of 198 pass, 62 s (127.0.0.1).
- WP2 and WP3 did not start. No builder runs. No session waits for an archive ("Not archived": none).
- The session stopped at the kit CONTEXT LIMIT (about 224,000 tokens). This cloud session has no `start_session`.

## Next step
Write the round 2 briefs (skill `work-order`, section 8), lint them, record the start tree, then start:
- Builder A (`agent-kit:builder-t1`): `src/application/room-archive.mjs` and `test/room-archive.test.mjs`.
- Builder B (`agent-kit:builder-t1`): `sendRecord()` in `src/network/node.mjs` and `test/send-record.test.mjs`.
- After A and B: builder C for WP3 (`main.js`, `preload.cjs`, `renderer.js`, `index.html`, `styles.css`, new modules).

## WP2 design (orchestrator, from the code)
- Node: `send(text)` returns a session count, and about 20 tests and `transceiver.mjs` use the number. Keep it. Add
  `sendRecord(text)`: it returns `{ id, from, text, time, accepted }`. `send(text)` returns `sendRecord(text).accepted`.
  The wire line does not change (`node.mjs` about line 1153).
- IPC `asscrack:send` (`main.js` line 361) returns the record. `sendMessage()` in `renderer.js` (lines 405 to 433)
  must use `record.time` and `record.id` in `addMessage()`, not `Date.now()` and `null`.
- Fingerprint: `v1-` and 64 hex digits. SHA-256 of `"asscrack-room-id"`, `0x00`, version byte 1, u32 BE key length,
  key bytes, u32 BE length of the UTF-8 name, name bytes. No normalization of the name.
- Files under `userData/saved-rooms/`: `archive.db` (SQLCipher), `archive.key` (JSON `{"v":1,"wrapped":"<base64>"}`),
  temp file `archive.key.tmp`. The store writes the key file (tmp, fsync, rename) before it makes the database.
- Store input: `protector = { available(), wrap(Buffer), unwrap(Buffer) }`. Tests use a fake with an ID prefix, so a
  different fake cannot unwrap.
- States: `open`, `locked` (reasons `key-missing`, `key-unreadable`, `key-unwrap-failed`, `database-unreadable`),
  `unavailable` (`protection-unavailable`: `safeStorage` on `basic_text`). `unlock()` tries again. No plaintext
  fallback. No new key when a database exists.
- Open sequence: `cipher='sqlcipher'`, `legacy=4`, `key='<64 hex of the random key>'`, then one read of
  `sqlite_master` (a wrong key fails only at the first read, S4). Then `temp_store=MEMORY`, `foreign_keys=ON`.
- Tables: `rooms(room_id PK, name, room_key, invite, user_name, keep_history, saved_at, opened_at)` and
  `messages(room_id, msg_id, sender, body, time, own, source, peer_id, PRIMARY KEY(room_id, msg_id))`.
  `INSERT OR IGNORE` for messages. `source` is `send` or `live`. Host replay (`history` event) is not saved.
- Saved own send: only when `accepted` is 1 or more. Saved received line: each `message` event (live).
- Login is one room for each app process (`loginStarted`, `main.js` line 260). "Reopen room" is on the login screen.
  The keyed room cache `userData/rooms/<tag>.json` gives the endpoint hints. It stays as it is.
- In a keyed room, `peer-joined` comes only after the proof check (S5).

## Test facts for this VM
- `safeStorage` with a real backend: `apt-get install -y gnome-keyring` (a new VM does not have it). Then run under
  `xvfb-run -a dbus-run-session -- bash -c "echo -n testpass | gnome-keyring-daemon --unlock --components=secrets;
  <electron> <args> --password-store=gnome-libsecret"`. Without it the backend is `basic_text` (S2).
- The app start check example: `analysis/app-start.cjs` on `origin/handoffs/manual-status-20261119`.

## Files to read
- `GOAL.md` and `WORK_ORDER.md` in this folder. `DECISIONS.md` sections S1 to S6 in the project folder.
- `evidence/wp1/binding-report.md` (the study), `evidence/wp1/check-orch.cjs`.

## Not archived
- none
