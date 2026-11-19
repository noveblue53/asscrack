# Continue: milestone 6 part 1, saved rooms (2026-11-19)

## State (session 2, 2026-11-19)
- Branch `opus/saved-rooms`, HEAD `ec546d0` (WP2, pushed). WP2 is done: `GOAL_ACTIVE` WP2 lines are `[x]`.
  `DECISIONS.md` S8 has the WP2 result (`npm test` 214 of 214 pass, 127.0.0.1).
- New VM setup done: `.git/info/exclude` lines, `npm ci` with Node 24 (`PATH=/opt/node24/bin:$PATH`), exit 0.
  `gnome-keyring` installed with apt (VM test tool only).
- Round 3 (WP3) started. Start tree `87b78ac` (clean tree, HEAD `ec546d0`). Briefs (linted, 0 findings):
  - Builder C (builder-t1): `brief-C-app.md`, the app integration.
  - Builder D (builder-t1): `brief-D-check-script.md`, the Playwright Electron check script in `evidence/wp3/`.
    D runs the script one time, then waits for a message that C stopped.

- Builder C stopped. Its changes are in the tree (not committed at this line). The orchestrator examined
  `src/application/saved-rooms.mjs` and the `main.js` diff: no fault found. Not examined yet: the diffs of
  `renderer.js`, `preload.cjs`, `index.html`, `styles.css`, and the new `saved-rooms-ui.js` and
  `test/saved-rooms.test.mjs`. C reported: `test/saved-rooms.test.mjs` 4 of 4, `npm test` 216 of 218 (2 fails in
  `test/voice-direct.test.mjs`, "Too many outbound protocol streams", the known open item of `GOAL.md`).
- Commit `5f5dc2c` (pushed) holds the work of builder C. The examination is not complete (`DECISIONS.md` S9).
- Compare done: `test/voice-direct.test.mjs` failed 4 of 5 runs on base `ec546d0` and 1 of 5 on the branch
  (127.0.0.1). The change did not cause it (S9).
- Builder D runs the full check script (`evidence/wp3/check-saved-rooms.cjs`). A new session must run it again.
- Electron in this VM runs as root, thus it needs `--no-sandbox`.

## Goal state (end of session 2)
- WP3 done. All 10 lines of `GOAL_ACTIVE` are `[x]`. Commits `5f5dc2c` and `4d30b77` (pushed). `DECISIONS.md` S9
  and S10 have the results. Evidence: `evidence/wp3/` and `evidence/wp3/orch/`.
- Merged: `main` at `5982914` (pushed). Goal complete. Open: the packaged Windows checks (`GOAL.md`).

## Old next step (done)
Examine the rest of the diff of C (skill `work-order`, section 9, start tree `87b78ac`). Tell D that C stopped. Run the script of
D under the keyring wrapper. Then `npm test`, `test/rejoin.test.mjs`, one app start, commit, push. Then the
`CHANGELOG.md` and `README.md` notes. A new session that continues this step must start C and D again from the briefs
when their changes are not in the tree.

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

## Merge state (end of session 2)
- The operator approved the merge and the handoff push (`DECISIONS.md` S11).
- `origin/main` is at `5e33f5d` (5C merged first). A merge of `origin/main` into `opus/saved-rooms` is in progress
  (no commit). 6 conflicts: `CHANGELOG.md`, `README.md`, `package.json`, `package-lock.json`, `index.html`,
  `main.js`. A builder-t2 resolves them. Next: examine, `npm test`, one app start, the check script of builder D,
  commit the merge, push the branch, merge into `main`, push `main`, then the handoff push.
