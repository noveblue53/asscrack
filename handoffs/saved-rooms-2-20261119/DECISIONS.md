# Decisions: milestone 6 part 2, live chat and the archive agree (local file, not in Git)

Goal folder: `work-orders/saved-rooms-2-20261119/`. Plan: `docs/WORK_PLAN_1.0.md`, section 6, part "2. Make live
chat and the archive agree". The operator gave the goal on 2026-11-19: "The next goal is milestone 6 part 2 in
docs/WORK_PLAN_1.0.md, section 6." Part 1 decisions S1 to S12 are in `DECISIONS.md` on branch
`origin/handoffs/saved-rooms-20261119`.

## P1. Baseline (2026-11-19)

- Branch `opus/saved-rooms-2` from `origin/main` at `5982914`. Linux cloud VM. Node 24.22.3. Electron 40.5.0.
- `npm ci`: exit 0. `npm test`: 241 of 241 pass (127.0.0.1). Evidence: `evidence/orch/baseline-npmtest.txt`.
- `gnome-keyring` installed again with apt (VM test tool only, part 1 S2).

## P2. Scope of part 2 (read in the plan and in the code)

Part 1 did the first item (one canonical ID and time for each send) and the save of accepted sends and live lines.
Part 2 does the other items:
1. A send that no session accepted: show it as local-only, keep it out of host replay, do not save it.
2. A live line that host replay showed first must still be saved one time.
3. Page older saved rows into the window and keep the reading position.
4. Serialize save toggle, Clear, Forget and writes. A write before Clear must never restore a deleted row.
5. A failed write (for example a full disk) must not show the line as saved.
6. Concrete retention and byte limits for each room.
The "What the first release promises" table also needs the UI for saving off and on, Clear and Forget. A text
explains the local effects before a deletion. Not in scope: part 3 (replay seed, refreshed invites, frame
bounds) and part 4 (release checks).

## P3. Local-only send (decision)

- `sendRecord(text)` with 0 accepting sessions does not add the record to the node history. Reason: the plan says
  "exclude it from future host replay". The record still has `accepted: 0`.
- The archive does not save it. Reason: the plan archives "this device's own accepted sends".
- The window marks the line as local-only with a visible text. After a restart the line is gone. This is the
  promised behavior ("Keep that entry local").
- This changes a behavior that `test/send-record.test.mjs` checks ("adds the record to history"). The test changes
  with this reason. It is not a change to make a run pass.

## P4. Live lines after replay (decision)

- `node.mjs` emits `message` only for an ID that is new in the history buffer (no change). Thus a live line that
  replay gave first has no `message` event, and part 1 did not save it.
- New node event `live`: one event for each valid live chat line, also when the ID is already in the history. Data:
  `{ peerId, id, from, text, time }`. The node emits `message` first, then `live`. The archive listens to `live`.
  `INSERT OR IGNORE` on `(room_id, msg_id)` keeps one row. The terminal demo and the window do not use `live`.

## P5. Saved state in the window (decision)

- The main process tells the window the result of each archive write: event `asscrack:line-saved` `{ id }` and
  event `asscrack:save-failed` `{ id, reason }`. The send IPC returns `saved` and `saveError` with the record.
- The window keeps a set of saved IDs. A line with a saved ID has the class `saved` and the title "Saved on this
  device". A failed write gives a status text. The line then has no saved mark.

## P6. Limits (decision)

- For each room: at most 10,000 rows and at most 8 MiB (8,388,608 bytes) of UTF-8 text (body plus sender name).
- For each row: at most 65,536 bytes of UTF-8 text. A longer line is not saved, and the window says so.
- Pruning deletes the oldest rows by `(time, msg_id)` in the same transaction as the insert. The newest rows stay.
  10,000 rows is 40 times the 250-message acceptance case. 8 MiB with 250 rows allows 33 KiB for each row.
- Paging: the first read gives the newest 200 rows. Each page of older rows has 100 rows. A read has at most 500.

## P7. Serialization (decision)

- All archive calls are synchronous `better-sqlite3` calls in the Electron main process. The event loop runs them one
  at a time. There is no write queue. Thus a write that the main process accepted before Clear is complete before
  Clear starts.
- A risk stays: the same line can come again after Clear, through a second route. The `live` event (P4) then writes
  the row again. Decision: Clear records the deleted IDs of the room as tombstones in memory for the run of the app.
  A write of a tombstoned ID does nothing. After a restart, the node history is empty, thus a late copy is not
  probable. Part 3 (replay seed) must also respect Clear (plan).
- Forget is possible only on the login screen, when the room is not open. It deletes the room row, its messages,
  and the room hint files `userData/rooms/<tag>.json` and `<tag>.host.json`.

## P8. Package A result and the node option `seedHistory` (2026-11-19, orchestrator)

- `node.mjs`: `sendRecord()` adds the record to the history only when 1 or more sessions accepted it. The `live`
  event comes after `message` for each valid live line.
- Two tests used a send with no session to put a line in the history before a replay:
  `test/history.test.mjs` "e" and `test/quote-history.test.mjs` (zero-peer quote). P3 makes that send local-only.
  Thus these tests now put the line in the history with a new node option `seedHistory`. It is an array of records
  that the node adds to its history at start. The replay checks of the tests did not change. The quote test now also
  checks that a local-only quote is not in a replay. Reason: the tests were correct for the old behavior, and P3
  changes the behavior on purpose.
- `seedHistory` is also the input that part 3 needs for the replay seed. The app does not use it yet.
- Result (127.0.0.1): `node --test test/send-record.test.mjs test/history.test.mjs test/quote-history.test.mjs`:
  12 of 12 pass. A1 and A2: pass.

## P9. Results of packages B, C, D and E (2026-11-19, 127.0.0.1)

- B: 34 of 34 tests in `test/room-archive.test.mjs` and `test/saved-rooms.test.mjs`. The VM runs as root, thus a
  read-only file does not stop a write. The failed-write test drops the `messages` table from a second connection.
- C: the orchestrator examined the full diff. No fault found. Fast checks: 71 of 71 in the changed test files.
- D2: `evidence/check/check-part2.cjs`, 18 of 18 checks pass. Evidence: `evidence/check/d2-out.json`. Items: 250
  numbered lines, each one time on each copy, and 250 saved marks. A reopen gives 200 lines, then 50 older lines.
  The first visible line moved 9 px. A local-only line has no saved mark. Saving off and on: `off-1` is not saved and
  `on-1` is saved. Clear: 0 lines after a reopen. Forget on M: H keeps its room.
- E1: `npm test` 267 of 268. The failure is `test/voice-direct.test.mjs`, `ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS`.
  Compare, 5 runs of that file: base 1 of 5 fail, branch 1 of 5 fail. Not caused by this change.
  Evidence: `evidence/orch/e1-npmtest.txt`, `evidence/orch/voice-direct-compare.txt`.
- E2: `test/rejoin.test.mjs` 3 of 3. One app start with two windows (script `evidence/orch/app-start.cjs`, with the
  switch `--password-store=gnome-libsecret`): no error line in the app logs, the terminal or the console. The archive
  opens with the backend `gnome_libsecret`. Without the switch, the app logs the designed WARN line
  `protection-unavailable` (`basic_text`).
- E3: the terminal demo sends and receives one line in each direction through mDNS. With a typed address, the second
  copy also finds the first through mDNS. Then the explicit dial can fail with `ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS`
  or a closed chat. Compare, 6 runs each: base 2 of 6 pass, branch 2 of 6 pass. Not caused by this change. This is a
  separate finding for a later goal. Evidence: `evidence/orch/e3-compare.txt`.

## P10. Merge into main (2026-11-20)

- Operator, 2026-11-20: "Merge and push".
- Merge commit `b2ac72f` on `main` (parents `5982914` and `e29d53e`), pushed. The code tree is the same as the tested
  branch commit. Only the notes in `CHANGELOG.md` and `README.md` changed to "on main".
- The merge was in a separate worktree. The shared checkout stays on `opus/saved-rooms-2`.
- Open: the push of the handoff branch `handoffs/saved-rooms-2-20261119`. The words "Merge and push" do not name it,
  thus it waits for a clear answer.
