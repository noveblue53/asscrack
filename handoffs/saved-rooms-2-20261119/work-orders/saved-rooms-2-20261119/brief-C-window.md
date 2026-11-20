# Brief C: the window and the main process (package C, builder-t1)

## Goal
Show the state of each line: local-only, saved or not saved. Give the room storage controls: keep history, Clear
and Forget. Each deletion has a confirmation. Load older saved rows at the top of the list and keep the reading
position. Reason: the plan section "2. Make live chat and the archive agree" and the table "What the first release
promises". A friend must see the difference between a local-only send and a saved message.

## Files
- You can edit only these files: `src/application/main.js`, `src/application/preload.cjs`,
  `src/application/renderer.js`, `src/application/saved-rooms-ui.js`, `src/application/reading.js`,
  `src/application/index.html`, `src/application/styles.css`, `test/app-events.test.mjs`, and a new file
  `test/saved-rooms-ui.test.mjs`.
- Do not edit any other file. Builder B changes `room-archive.mjs` and `saved-rooms.mjs` at the same time. The
  orchestrator changes `src/network/node.mjs`. Builder D writes a check script for your element IDs.

## Facts
- Project folder: `/home/user/asscrack`. Branch `opus/saved-rooms-2`. Base commit `5982914`. Use Node 24:
  `export PATH=/opt/node24/bin:$PATH`. `node_modules` is installed.
- Read these sections first:
  - `work-orders/saved-rooms-2-20261119/WORK_ORDER.md`: section "Interfaces", all parts, and "Texts". Use the
    element IDs, classes, IPC names and texts exactly as written there.
  - `DECISIONS.md` (project folder): P3, P5, P6 and P7.
- Builder B makes the interface of `saved-rooms.mjs` at the same time. Until B stops, the new functions
  (`setKeepHistory`, `clear`, `forget`, the `notify` and `forgetHints` options, paging in `lines`) can be missing.
  Write your code against the interface in `WORK_ORDER.md`. Do not edit `saved-rooms.mjs`.
- The orchestrator changes `sendRecord()` in the node: with `accepted: 0` the record is not in the host history.
- Existing code to read:
  - `src/application/main.js`: `startRoom()` (the room hint files under `userData/rooms/<tag>`, the function
    `keyedServiceTag`), `getSavedRooms()`, `afterRoomStart()`, the IPC handlers `asscrack:saved-room-lines`,
    `asscrack:reopen-room`, `asscrack:send`, and the list `EVENTS`.
  - `src/application/renderer.js`: `addMessage()`, `insertMessage()`, `shownMessageIds`, `NO_PEERS_TEXT`,
    `sendMessage()`, `onMessage`, `onHistory`, `makeMessageItem()`.
  - `src/application/saved-rooms-ui.js`: `reopen()`, `showRooms()`, `window.savedRoomsUi`.
  - `src/application/reading.js`: `beforeChange()`, `afterChange()`, `captureAnchor()`. Add a function for a
    prepend that keeps the first visible line at the same place, if the existing functions cannot do it.
- After a login into a room that is saved (`savedRoom: true` in the login result), also load the saved lines, the
  same as a reopen. Lines with an ID that is already shown do not come again.
- A saved ID can come in `asscrack:line-saved` before the window shows the line. Keep a set of saved IDs, and mark a
  line when it is added.
- Put all text in the DOM with `textContent`. The window gets no key, no invite and no file path.
- Electron runs as root in this VM, thus it needs `--no-sandbox` for a manual start.

## Done when
- C1: `npm test` passes, other than the known intermittent `test/voice-direct.test.mjs` failure. Tell the
  orchestrator each failure. The orchestrator compares it with the base.
- C2: the element IDs and classes of section "Interfaces" exist and work in the check script of builder D. The
  orchestrator runs that script after you stop.
- Add source-wiring tests in `test/saved-rooms-ui.test.mjs` (the same style as `test/app-events.test.mjs`) for the
  new IPC names, preload functions and window events.

## Rules
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Do not add a package to `package.json`.
- Keep `src/network/transceiver.mjs` in working condition. Do not change `src/application/voice.js` or
  `voice-worklet.js`.
- Keep message bodies, invites and keys out of log lines.
- Keep the milestone 6 code in its own functions and blocks in the shared files, with the comment "Saved rooms
  (milestone 6)".
