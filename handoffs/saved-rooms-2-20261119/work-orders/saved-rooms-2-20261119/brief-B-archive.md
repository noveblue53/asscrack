# Brief B: the archive and the saved-rooms module (package B, builder-t1)

## Goal
Add paging, Clear, retention limits, tombstones, the keep-history toggle, Forget and the write result to the
main-process modules of saved rooms. Reason: the plan section "2. Make live chat and the archive agree" needs them,
and builder C uses this interface in the window and the main process.

## Files
- You can edit only these files: `src/application/room-archive.mjs`, `src/application/saved-rooms.mjs`,
  `test/room-archive.test.mjs`, `test/saved-rooms.test.mjs`.
- Do not edit any other file. Builder C changes `main.js` and the window files at the same time. The orchestrator
  changes `src/network/node.mjs`.

## Facts
- Project folder: `/home/user/asscrack`. Branch `opus/saved-rooms-2`. Base commit `5982914`. Use Node 24:
  `export PATH=/opt/node24/bin:$PATH`. `node_modules` is installed.
- Read these sections first:
  - `work-orders/saved-rooms-2-20261119/WORK_ORDER.md`: section "Interfaces", the parts
    "`src/application/room-archive.mjs`" and "`src/application/saved-rooms.mjs`". Make the interface exactly as
    written there.
  - `DECISIONS.md` (project folder): P4, P6 and P7.
- `room-archive.mjs` uses `better-sqlite3-multiple-ciphers` (synchronous). Use `db.transaction()` for the insert and
  the prune together, and for Clear.
- The node event `live` has the data `{ peerId, id, from, text, time }`. It comes for each valid live line, also for
  a line with an ID that is already in the node history. Thus the same ID can come more than one time.
  `attachNode()` must listen to `live` and not to `message`. The existing tests in `test/saved-rooms.test.mjs` use a
  fake node that emits `message`. Change the fake node to emit `live`, and give the reason in a test comment.
- The byte count of a row: `Buffer.byteLength(text, 'utf8') + Buffer.byteLength(from ?? '', 'utf8')`. In SQL:
  `length(CAST(body AS BLOB)) + length(CAST(coalesce(sender, '') AS BLOB))`.
- Tombstones are in memory only: a `Map` from room ID to a `Set` of message IDs. Clear adds to it. Forget deletes
  the entry of the room.
- A failed write: make a test that closes the archive or makes the database file read-only, then calls
  `recordSend()`. The result must be `saved: false` with a reason that is not empty. `notify('save-failed', ...)`
  must come for a live line in the same condition.
- The existing tests use a fake protector. Look at the start of `test/room-archive.test.mjs`.

## Done when
- B1: `node --test test/room-archive.test.mjs test/saved-rooms.test.mjs` passes.
- B2: tests for these items pass:
  - paging with `before`
  - Clear with tombstones
  - the row limit, the byte limit and the row size limit
  - a failed write (a closed or read-only database) gives `saved: false` with a reason
  - keep history off and on
  - Forget calls `forgetHints` and deletes the rows
  - Forget of the open room fails
- B3: a test with 250 numbered rows: after a reopen of the archive, `lines()` gives 200 rows, and one page with
  `before` gives the other 50. Each ID one time.

## Rules
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Do not add a package to `package.json`.
- Keep message bodies, invites and keys out of log lines.
- Do not change the key file format or the fingerprint. A version 1 database from part 1 must still open.
