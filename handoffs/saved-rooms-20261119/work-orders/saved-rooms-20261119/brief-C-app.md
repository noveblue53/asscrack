# Brief C: saved rooms in the app (WP3, builder-t1)

## Goal
Connect the room archive to the Electron app. A user saves an invite-keyed room, and later reopens it with no peer
and reads its saved lines. Reason: milestone 6 part 1, "the smallest usable slice".

## Files
- You can edit only these files:
  - `src/application/main.js`
  - `src/application/preload.cjs`
  - `src/application/renderer.js`
  - `src/application/index.html`
  - `src/application/styles.css`
  - new: `src/application/saved-rooms.mjs` (main process part)
  - new: `src/application/saved-rooms-ui.js` (window part, a classic script like `find.js`), if necessary
  - new: `test/saved-rooms.test.mjs`
- Do not edit any other file. Do not edit `src/application/room-archive.mjs` or `src/network/node.mjs`.
- Do not change `src/application/voice.js` or `src/application/voice-worklet.js`.
- A different session (milestone 5C) also changes `main.js`, `preload.cjs`, `renderer.js`, `index.html` and
  `styles.css`. Put the new code in the new modules where possible. Keep each change in those files in its own
  function or block, with a short comment `// Saved rooms (milestone 6).`

## Facts
- Project folder: `/home/user/asscrack`. Base commit: `ec546d0` on branch `opus/saved-rooms`.
- Node 24 is at `/opt/node24/bin`. Put it first on `PATH` for each command.
- Store API: read `src/application/room-archive.mjs` (`openRoomArchive`, `roomFingerprint`). The store does not
  import `electron`. It takes `protector = { available(), wrap(Buffer), unwrap(Buffer) }`.
- Node API: `node.sendRecord(text)` returns `{ id, from, text, time, accepted }` (`src/network/node.mjs`). A received
  live line gives the event `message` with `{ peerId, id, from, text, time }`. The event `history` is host replay.
- `main.js`: the login handler is at line 259. It makes keyed room options from an invite (`readInvite()`) or a new
  key (`internet === true`). The room cache under `userData/rooms/<tag>.json` stays as it is. The IPC `asscrack:send`
  is at line 361. The quit code (`before-quit`) is at line 452. `writeLog(level, text)` writes the log.
- `renderer.js`: `login()` at line 291, `sendMessage()` at line 406 (it uses the count from `send`),
  `addMessage(from, text, time, own, id, peerId)` at line 143, `insertMessage()` at line 156, the `history` listener
  at line 259, `showRoomType()` at line 280. Peer events at lines 239 and 240.
- `index.html`: the login screen is `#login-screen` (line 26). Room type select `#room-type`, invite field
  `#invite-input`, login button `#login`.
- `DECISIONS.md` S2, S5 and S8 in the project folder give the decisions for `safeStorage` and "Waiting for a peer".

## Required behavior
1. Protector in the main process, from Electron `safeStorage`:
   - `available()`: `safeStorage.isEncryptionAvailable()` is true. On Linux, also
     `safeStorage.getSelectedStorageBackend()` is not `basic_text`.
   - `wrap(b)`: `safeStorage.encryptString(b.toString('base64'))`. `unwrap(b)`: `Buffer.from(safeStorage.decryptString(b), 'base64')`.
   - Do not call `safeStorage.setUsePlainTextEncryption()`.
2. The archive: `openRoomArchive({ dir: <userData>/saved-rooms, protector })`. Open it after `app` is ready, at the
   first saved-rooms IPC call or login. Write one log line with the state and the reason. On Linux, the line also
   gives the `safeStorage` backend. Close it in the quit code.
3. Login with a save: `login()` sends two new fields, `save` and `keepHistory`. After the node starts, and only for a
   keyed room (invite or new internet room): `saveRoom({ name: <room name>, roomKey, invite: <typed invite or null>,
   userName: <name>, keepHistory })` and `markOpened`. The login result adds `roomId` (or `null`), `saved` (boolean)
   and `saveError` (the archive reason, or `null`). A save that fails does not stop the login.
4. The active room: after each login of a keyed room, compute `roomFingerprint(room, roomKey)`. When the archive has
   that room, the room is active for the archive. Use its `keepHistory` value.
5. Saved lines, only when the active room has `keepHistory` on:
   - IPC `asscrack:send` calls `node.sendRecord(text)`. When `accepted` is 1 or more, add the row with `own: true`,
     `source: 'send'`, `peerId: null`. Return the record to the window.
   - Each node `message` event: add the row with `own: false`, `source: 'live'` and its `peerId`.
   - Do not save `history` events.
   - An archive error writes one `WARN` log line. It does not stop the send or the event.
6. Reopen: IPC calls give the room from the archive. The main process builds the keyed room options from the saved
   row: `name`, `roomKey`, and the nodes of the saved invite when there is one. It uses the same start code as the
   login handler. Move the shared code into one function. Do not copy it. The name is the saved `userName`.
7. New preload functions (window API):
   - `listSavedRooms()` returns `{ state, reason, rooms }`. `rooms` has no key and no invite.
   - `unlockArchive()` returns the same shape.
   - `savedRoomLines(roomId)` returns `[{ id, from, text, time, own, peerId }]`.
   - `reopenRoom(roomId)` returns the login result.
   - `send(text)` now returns the record. `login()` sends `save` and `keepHistory`.
   - Do not give a key, an invite or a file path to the window through these functions.
8. Window, login screen (use these element IDs):
   - `#save-room`: checkbox "Save room on this device". `#keep-history`: checkbox "Keep local history", checked by
     default. Show both only for a keyed room (internet room or invite). Disable `#save-room` when the archive state is
     not `open`.
   - `#saved-rooms`: a list. Each item has the class `saved-room`, the attribute `data-room-id`, the room name, the user
     name, and a button with the class `reopen-room` and the text "Reopen room".
   - `#archive-state`: a text line. It shows the state when it is not `open`: "Saved rooms: locked (<reason>)" or
     "Protected storage is not available on this computer. Rooms cannot be saved." `#archive-unlock`: a button "Try
     again" that calls `unlockArchive()`. Hide both when the state is `open`.
9. Window, reopen: a click on "Reopen room" shows the chat screen at once with the saved lines
   (`savedRoomLines`, then `addMessage` with the saved `id`, `time`, `own` and `peerId`). Then it calls `reopenRoom`.
10. Window, chat screen: `#waiting-peer` with the text "Waiting for a peer". Show it in a reopened or saved room while
    the room has no peer. Hide it at the first `peer-joined`. Show it again when the last peer leaves (S5).
11. Window, send: `sendMessage()` uses the record (`record.accepted` in place of the count, `record.time` and
    `record.id` in `addMessage()`).
12. A replayed or saved line with an `id` that the window already shows must not show two times. Read `insertMessage()`
    and keep or add this check.

## Tests in `test/saved-rooms.test.mjs`
Test the main-process logic of `saved-rooms.mjs` with a fake node (an `EventEmitter` and a `sendRecord` stub), a fake
protector and a real archive in a temporary folder. Do not start Electron in this test. Cases:
- A send with `accepted` 1 adds one row. A send with `accepted` 0 adds no row.
- A live `message` event adds one row with `source` `live`. A `history` event adds no row.
- A room with `keepHistory` off adds no row.
- Two rooms with the same user name and different keys keep separate rows.

## Done when
- `node --test test/<file>.test.mjs` passes for `test/saved-rooms.test.mjs` (Node 24, 127.0.0.1).
- `npm test` passes (127.0.0.1). No other builder runs `npm test` at this time.
- One start of the app under Xvfb shows the login screen with no error line in the terminal:
  `xvfb-run -a node_modules/.bin/electron . --profile <new temp folder>`. Stop it after 10 seconds.

## Rules
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Builder D writes a check script in `work-orders/saved-rooms-20261119/evidence/wp3/` at the same time. Do not edit it.
