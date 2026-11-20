# Work order: milestone 6 part 2, live chat and the archive agree (2026-11-19)

**Operator, 2026-11-19:** "The next goal is milestone 6 part 2 in docs/WORK_PLAN_1.0.md, section 6".
**Source of the packages:** `docs/WORK_PLAN_1.0.md`, section 6, part 2, and the table "What the first release
promises". Decisions P1 to P7 in `DECISIONS.md`.
**Language:** ASD-STE100.
**Base:** branch `opus/saved-rooms-2`, commit `5982914`. Baseline `npm test`: 241 of 241 pass (127.0.0.1).

## A. Node: local-only send and the live event (orchestrator)
- **What:** `sendRecord()` with 0 accepting sessions does not add the record to the history. A new `live` event
  comes for each valid live chat line, also when the ID is already in the history (P3, P4).
- **Done when:**
  - [ ] A1: `node --test test/send-record.test.mjs` passes. A test shows that a record with `accepted: 0` is not in
    `history()`. A test shows that a peer that connects later does not get it in a replay.
  - [ ] A2: a test shows a `live` event for a line whose ID came first in a host replay.

## B. Archive and saved-rooms module (builder B)
- **What:** paging, Clear, retention limits, tombstones, keep-history toggle, Forget, and the write result in
  `room-archive.mjs` and `saved-rooms.mjs` (P5, P6, P7). The interface is in section "Interfaces" below.
- **Done when:**
  - [ ] B1: `node --test test/room-archive.test.mjs test/saved-rooms.test.mjs` passes.
  - [ ] B2: tests for these items pass:
    - paging with `before`
    - Clear with tombstones
    - the row limit, the byte limit and the row size limit
    - a failed write (a closed or read-only database) gives `saved: false` with a reason
    - keep history off and on
    - Forget calls `forgetHints` and deletes the rows
    - Forget of the open room fails
  - [ ] B3: a test with 250 numbered rows: after a reopen of the archive, `lines()` gives 200 rows, and one page
    with `before` gives the other 50. Each ID one time.

## C. Window and main process (builder C)
- **What:** these items in the window and the main process:
  - local-only and saved marks on the lines, and the save failure text
  - the room storage controls: keep history, and Clear with a confirmation
  - Forget on the login screen with a confirmation
  - older rows at the top of the list, with the reading position kept
  - saved lines after a login into a saved room
- **Done when:**
  - [ ] C1: `npm test` passes, other than the known intermittent `test/voice-direct.test.mjs` failure (the
    orchestrator compares it with the base).
  - [ ] C2: the element IDs and classes of section "Interfaces" exist and work in the check script of D.

## D. Electron check script (builder D)
- **What:** a Playwright Electron script for the part 2 checks, under Xvfb with a real `safeStorage` backend.
- **Done when:**
  - [ ] D1: the script runs to the end and prints one JSON result, with each check `pass` or `fail`.
  - [ ] D2: all checks pass after builder C stops (127.0.0.1).

## E. Integration (orchestrator)
- [ ] E1: `npm test` passes on the branch (127.0.0.1). For each failed test, the same test also ran on the base, and
  the report says if the change caused it.
- [ ] E2: one app start with no error line in the terminal or the developer console (Xvfb). `test/rejoin.test.mjs`
  passes.
- [ ] E3: the terminal demo `src/network/transceiver.mjs` sends and receives one line between two copies.
- [ ] E4: `CHANGELOG.md` and `README.md` give the results with the label 127.0.0.1, the limits of P6, and the open
  checks.

**Then (operator):** the packaged Windows checks of part 1, and the release checks of part 4 later. Not in this goal.

## Interfaces

### Node (`src/network/node.mjs`, package A)
- Event `live`: `{ peerId, id, from, text, time }`, after `message`, for each valid live chat line.
- `sendRecord(text)` returns `{ id, from, text, time, accepted }`. With `accepted: 0` the history does not have it.

### `src/application/room-archive.mjs` (package B)
- `export const ARCHIVE_LIMITS = { maxRows: 10000, maxBytes: 8388608, maxRowBytes: 65536 }`.
- `openRoomArchive({ dir, protector, limits })`. `limits` is optional and replaces values of `ARCHIVE_LIMITS`
  (tests use small values).
- `addMessage(roomId, row)`: returns `true` for a new row, `false` for a duplicate. It throws a `RangeError` with
  `code: 'row-too-large'` when the UTF-8 size of `text` and `from` is more than `maxRowBytes`. After the insert,
  in the same transaction, it deletes the oldest rows of the room by `(time, msg_id)`. It stops when the room has
  at most `maxRows` rows and at most `maxBytes` bytes. It throws on a database error.
- `listMessages(roomId, { limit = 200, before = null })`: `before` is `{ time, id }` or `null`. With `before`, it
  gives only rows with `(time, msg_id)` lower than `(before.time, before.id)`. It gives the newest `limit` rows of
  that set, in ascending order. The function clamps `limit` to 1 to 500.
- `clearMessages(roomId)`: deletes all message rows of the room in one transaction. Returns the array of deleted
  message IDs.
- `roomUsage(roomId)`: returns `{ rows, bytes }`.
- No other change to the existing functions or to the file and key format. `user_version` can go to 2 if the
  schema gets an index. The open of a version 1 database must still work.

### `src/application/saved-rooms.mjs` (package B)
- `createSavedRooms({ dir, protector, log, backend, notify, forgetHints, limits })`:
  - `notify(type, data)`: optional. Types: `'line-saved'` with `{ id }`, `'save-failed'` with `{ id, reason }`.
  - `forgetHints(row)`: optional. `row` is the `getRoom()` row (with `name` and `roomKey`). Forget calls it before
    it deletes the room. Forget logs an error in it and continues.
- `afterLogin(...)` returns `{ roomId, saved, saveError, savedRoom, keepHistory }`. `savedRoom` is `true` when the
  room has a saved row after the login. `keepHistory` is the saved value, or `null` when `savedRoom` is false.
- `recordSend(record)` returns `{ saved, saveError }`. `saved: true` when the row is new or a duplicate. `saved:
  false, saveError: null` when no room is active, keep history is off, or `accepted` is 0. `saved: false, saveError:
  '<reason>'` when the write failed. Reasons: `'row-too-large'`, or the error message.
- `attachNode(node)`: listens to `live` (not `message`). For each line it writes when a room is active and keep
  history is on. Then it calls `notify('line-saved', { id })` or `notify('save-failed', { id, reason })`.
- `lines(roomId, { before = null, limit = 200 } = {})`: the rows for the window, as now, with paging.
- `setKeepHistory(roomId, on)`: saves the value. When `roomId` is the active room, the next write uses the new value
  at once. Returns `{ roomId, keepHistory }`.
- `clear(roomId)`: `clearMessages()`, then adds the deleted IDs to the tombstones of that room. Returns
  `{ cleared: <count> }`. A later write of a tombstoned ID in the same run does nothing and gives `saved: false,
  saveError: null`.
- `forget(roomId)`: throws `Error('room is open')` when `roomId` is the active room. Otherwise it calls
  `forgetHints(row)`, then `removeRoom(roomId)`. Returns `{ forgotten: true }`.
- `activeInfo()`: `{ roomId, keepHistory }` or `null`.

### Main process and preload (package C)
- New IPC (all `ipcMain.handle`, all check `roomId` as a string of at most 128 characters):
  - `asscrack:saved-room-lines` `(roomId, { before })`: paging.
  - `asscrack:set-keep-history` `(roomId, on)`, `asscrack:clear-history` `(roomId)`, `asscrack:forget-room`
    `(roomId)`. Forget gives `forgetHints`, which deletes `userData/rooms/<tag>.json` and `<tag>.host.json`, with
    `tag = keyedServiceTag(row.name, row.roomKey)`.
- `asscrack:send` returns `{ ...record, saved, saveError }`.
- Login and reopen results add `savedRoom` and `keepHistory` (from `afterLogin`).
- Window events `asscrack:line-saved` and `asscrack:save-failed` (from `notify`).
- Preload: `savedRoomLines(roomId, opts)`, `setKeepHistory(roomId, on)`, `clearHistory(roomId)`,
  `forgetRoom(roomId)`, `onLineSaved(cb)`, `onSaveFailed(cb)`.

### Window (package C), element IDs and classes for the check script
- Chat line `li` with class `local-only` for an own send with `accepted: 0`. It has a visible child
  `.local-only-mark` with the text "Only on this computer".
- Chat line `li` with class `saved` when its ID is saved. Title of the mark: "Saved on this device".
- `#room-storage`: a group in the chat screen, visible only in a saved room. It has:
  - `#room-keep-history`: checkbox "Keep local history".
  - `#history-state`: text. "Saving new messages on this device." or "Saving is off. Saved messages stay." or
    "Not saved: <reason>".
  - `#clear-history`: button "Clear saved history on this device".
  - `#clear-confirm`: hidden group with the explanation text, `#clear-confirm-yes` ("Delete saved messages") and
    `#clear-confirm-no` ("Cancel").
- Login screen: each `.saved-room` has `.forget-room` ("Forget room"). It shows `.forget-confirm` with the
  explanation text, `.forget-yes` ("Forget room") and `.forget-no` ("Cancel").
- Paging: the message list of a saved room can scroll to the top. Then the window loads 100 older rows. It puts them
  above the first line. The first visible line stays at the same place on the screen.
- `#messages` keeps `data-older` = `"more"` while older rows can exist, and `"none"` after a page with fewer than 100
  rows.

### Texts
- Clear explanation: "Delete the saved messages of this room from this computer? The room and its saving choice
  stay. Peers that are online can still show recent messages."
- Forget explanation: "Forget this room on this computer? This deletes the saved invite, the saved messages, the
  saving choice and the saved addresses of this room. Peers keep their copies. To join again, you need an invite."
- No-peer status (replaces `NO_PEERS_TEXT`): "No peer got this message. It is only in this window. It is not saved,
  and a peer that joins later does not get it."

## Builders
| Builder | Tier | Task | Files |
|---|---|---|---|
| orchestrator | - | A | `src/network/node.mjs`, `test/send-record.test.mjs` |
| B | builder-t1 | B | `src/application/room-archive.mjs`, `src/application/saved-rooms.mjs`, `test/room-archive.test.mjs`, `test/saved-rooms.test.mjs` |
| C | builder-t1 | C | `src/application/main.js`, `preload.cjs`, `renderer.js`, `saved-rooms-ui.js`, `reading.js`, `index.html`, `styles.css`, `test/app-events.test.mjs`, new `test/saved-rooms-ui.test.mjs` |
| D | builder-t1 | D | `work-orders/saved-rooms-2-20261119/evidence/check/` only |

## Rules given to the builders
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Do not edit a file outside your list. Other builders change the other files at the same time.
- Do not add a package to `package.json`.
- Keep `src/network/transceiver.mjs` in working condition. Do not change `src/application/voice.js` or
  `voice-worklet.js`.
- Keep message bodies, invites and keys out of log lines.
