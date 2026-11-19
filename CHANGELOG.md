# Changelog

This file gives the progress of ASSCRACK, one entry for each feature or release. The newest entry is at the top.

Each result has one of these labels:
- **LAN**: a test on 2 or more computers on one real local network.
- **127.0.0.1**: a test on one PC only. It does not prove that the feature works on a LAN.
- **internet**: a test on 2 computers on different networks, for example a home router and a phone hotspot.

## Unreleased: manual status, milestone 3 (on main)

The operator accepted branch `opus/manual-status` on 2026-11-19 without the LAN checks. Base: `main` at `c42baf5`.
All results in this entry are 127.0.0.1 results on a Linux cloud VM (Node 24.22.3, Electron 40.5.0 under Xvfb). There is no LAN result, no internet result and no packaged .exe result yet.
- **Status:** each user sets Available, Away or Do not disturb, and a note of at most 80 Unicode code points. A menu,
  a note field and a Set button are above the buddy list. Each buddy line has a text badge: "Available", "Away",
  "Do not disturb" or "status unknown". The note follows the badge text, for example "Away: back at 9".
- **Network:** a typed control line `{"type":"presence","v":1,"state","note"}` on the open chat session. The node
  sends its state when a session opens and on each change. The node keeps its state while the app runs, thus a
  reconnect keeps the state. A new app start has the state Available. The state has no history entry.
- **Old clients:** the 0.6.0 release (`d5ad3af`) ignores the new control with no line, no event and no history
  entry. Chat continues in both dial directions (127.0.0.1). The new window shows "status unknown" for a 0.6.0 buddy.
- **Checks (127.0.0.1):**
  - `npm test`: 198 of 198 pass (182 old tests and 16 new tests). In one earlier run, `test/voice-direct.test.mjs`
    failed one time with `ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS`. The same test on `main` (`c42baf5`) failed in 2 of
    5 runs with the same error. Thus this intermittent failure was there before the change.
  - Exit checks of milestone 3 with real nodes: Away with a note to B, and C joins late and sees it at once (105 ms).
    A session drop and reopen keeps the state. A restart with a new peer ID removes the old row and shows Available.
    DND gives no voice state event. Two buddies with the same name keep their own states. A current node and a
    `d5ad3af` node chat in both dial directions.
  - Two app windows in one LAN room (mDNS on 127.0.0.1): A sets Away with a note. The badge of A on window B shows
    "Away: back at 9". No developer console message and no error line, other than the D-Bus lines of the VM.
  - The terminal demo (`src/network/transceiver.mjs`) shows chat from a peer that sends a status, and no status line.
- **Open checks:** two packaged Windows .exe files on one real LAN, with a 0.6.0 client in both directions, a host
  change and a reconnect. The same check in an internet room. The operator deferred the LAN tests.
## Unreleased: voice processing added to the 1.0 plan

- **Plan:** `docs/WORK_PLAN_1.0.md` has a new section 5C: echo and noise suppression, voice activity and
  push-to-talk. The operator asked for it on 2026-11-19. It runs beside steps 2 to 4, on branch
  `opus/voice-processing`. The required part is in the 1.0 scope. An open noise suppressor and push-to-talk without
  the window focus need operator approval, because they are new dependencies.
- **Results:** none yet. The voice code does not change in this entry.

## Unreleased: Quote and Find on main, the 1.0 work plan and a new README

All results in this entry are 127.0.0.1 results. There is no LAN result and no packaged .exe result yet.
- **Integration (step 1 of the 1.0 plan):** the operator accepted `opus/quote-fix` (`d324f7d`) on 2026-11-19 without
  the LAN checks. Merge commit `8feb5e8` puts Quote and Find on `main`. The packaged Windows LAN check moves to step 3
  of the plan.
- **Checks at `8feb5e8` (Linux cloud VM, Node 24.22.3, Electron 40.5.0):** `npm ci` passes. `npm test` passes 182 of
  182. One app start under Xvfb logs in to a LAN room. It gives 0 developer console messages and 0 error or warning
  lines in the app log. The app closes normally.
- **Work plan:** `docs/WORK_PLAN_1.0.md` gives the release order, the scope, the field procedure and the exit checks
  of release 1.0. It is the text of the operator, with one private link removed.
- **README:** the README now gives the status of each build and the known limits and the start commands. Each
  feature has its best result label (LAN, internet or 127.0.0.1). The README has no claim without a test result.
- **Open field checks:** Quote and Find on the packaged .exe, on two Windows computers in one LAN room. Use a 0.6.0
  client and a host change. The internet test card 7. The operator deferred the LAN test.

## Unreleased: milestone 2 fixes, quote boundary and Quote button (branch `opus/quote-fix`)

Base: `opus/quote` at `a099d88` (the reviewed commit). All results in this entry are same-computer results
(127.0.0.1) on Windows 10, Node 24.13.1. There is no LAN result yet.
- **Quote boundary:** the header of a new quote gives the number of excerpt lines, for example
  `> Sam at 14:05, 1 line:` / `> old line` / `> these are my words` / `and this is my second line`. The reply can
  start with "> ": the window shows those lines as words of the replier, outside the quotation. Before this fix, a
  reply line that started with "> " showed as a line of the quoted user. The message is still one plain text message.
  The limits (4 lines, 280 characters), the network format and the history format do not change. A 0.6.0 window shows
  the text as plain lines.
- **Old quotes in the history:** a quote from before this fix has no number in its header. When one "> " line follows
  the header, the window shows the quotation block as before. When more "> " lines follow, the boundary is not known,
  thus the window shows the text as plain text. No line goes to an author.
- **Quote button:** the visible Quote button runs the row action `quote` (`runRowAction`), as the message menu does.
- **Checks (127.0.0.1):** `npm test`, 2 full runs with one test file at a time: 182 of 182 pass in each run (168 on
  `a099d88`). The new tests load the real scripts of the window in a small fake DOM (`test/helpers/fake-dom.mjs`,
  `test/helpers/renderer-fixture.mjs`):
  - `test/quote-boundary.test.mjs`: the formatter, the parser and the rendered line. The cases are a reply that starts
    with "> ", two "> " reply lines, a quote of that reply and old stored text.
  - `test/quote-actions.test.mjs`: the Quote button and the row menu on one line with a draft, and Remove and Escape.
    Other cases are a history line with no peer ID, and a failed send that waits while the user types.
  - 6 of the 12 new tests fail on `a099d88`: the boundary and format tests. The other 6 tests pass on `a099d88` too.
    They test behavior that had no test before.
  - 5 expected texts in the earlier tests changed for the new header.
- **Open field checks:** the packaged .exe on two Windows computers in one LAN room, with a 0.6.0 client and a host
  change.

## Unreleased: milestone 2, Quote and Find (branch `opus/quote`)

All results in this entry are same-computer results (127.0.0.1). There is no LAN result and no packaged .exe result
yet. Environment: a Linux cloud container, Node 22.23.5, Electron 40.5.0 (Chromium 144) under Xvfb. Base `ad31372`.
- **Quote (commit `cada0a2`):** the message menu has Quote, and each chat line has a Quote button (mouse hover or line
  focus shows it). Both call the same function. A chip above the message box shows the author, the time and the
  excerpt. Remove, or Escape with the focus in the composer, removes the quote. The send makes one ordinary text
  message: a header line, at most 4 excerpt lines (280 characters in all, "…" when cut), then the reply. Example:
  `> Sam (a1b2c3) at 14:05:` / `> the old line` / `my reply`. The network format and the history format do not
  change. The quotation is a snapshot, thus a quote stays readable when the original line leaves the history.
- **Same names:** when two users in the buddy list have the name, the header gets a peer tag (the last 6 characters
  of the peer ID of the quoted line). A history line that this window did not get live has no peer ID, thus no tag.
- **Message box:** it is a textarea now. A pasted text keeps its lines (CR LF becomes LF). Enter sends, Shift+Enter
  makes a new line. A failed send keeps the text and the quote. A send with no peers shows "No peers in this room yet.
  The message is in the local history. A peer that joins later can get it in a history replay."
- **Find (commit `01be12b`):** Ctrl+F opens a find bar. It searches the text of the lines in the list now (not the
  names, not the times). Enter, F3 or Next: next result. Shift+Enter, Shift+F3 or Previous: previous result. The bar
  shows "n of m". The results use the CSS Custom Highlight API: the lines do not change. While the bar is open, the
  unread count and the "New messages" marker stay, and a new line counts as unread. Escape or Close puts the list back
  at the old position. Escape order: menu, View menu and drawer, find bar, quote chip, invite panel, map.
- **Checks (127.0.0.1):** `npm test` on `opus/quote`, 2 full runs: 168 of 168 pass, then 167 of 168 (one failure in
  `test/voice-direct.test.mjs`). On `main` (`ad31372`) in the same container: 137 of 139 pass, the 2 failures are in
  the same file. The cause is the same in each case: `ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS` in `connect()` (a race
  of the chat stream). Repeated runs of that file: 3 of 5 fail on `main`, 1 of 3 fail on `opus/quote`. Milestone 2
  does not change `src/network`.
  New tests: the quote format and its limits, the find matcher with 200 lines, the find hold of reading.js, and quotes
  through the chat and history code: live, after a host change, after a replay with the original evicted, and after a
  send with zero peers.
- **0.6.0 check (127.0.0.1, script not in the repo):** the network code of 0.6.0 (`d5ad3af`) and the current code in
  one room. A 0.6.0 node got the quote live with the same text. A late 0.6.0 node and a late current node got it in a
  history replay. After the host stopped, a late node got it from the new host. 6 of 6 runs pass, with each
  combination of old and new hosts. The 0.6.0 window shows the quote as plain lines (its chat text has
  `white-space: pre-wrap`).
- **Window checks (127.0.0.1):** a browser drive of `index.html` with a fake bridge, 40 of 40 checks pass, 0 console
  errors. Three Electron copies (Sam, Sam, Ann) in one LAN room on one container: 10 of 10 checks pass, 0 console
  errors, 0 ERROR or WARN lines in the 3 logs.
- **Known, not changed:** the body of the window can scroll by 15 px when a focused chat line goes into view (also on
  `main`).
- **Open field checks:** the packaged .exe on Windows, a LAN room with a 0.6.0 client, and a replay after a host change
  on 2 or 3 computers.
- **Next milestone:** not started.

## Unreleased: room window, milestone 1 (branch `opus/room-window`)

All results in this entry are same-PC results (127.0.0.1 tests, and app instances on one PC). There is no LAN
result and no packaged .exe result yet. Environment: Windows 10, Node 24.13.1, Electron 40.5.0. Base `82fc32f`.
- **Saved panel sizes (commit `5759649`):** separators beside Buddies, beside the docked map and above Transfers.
  Drag them, or focus them and use the arrow keys. A View menu shows and hides Buddies and Transfers, moves Buddies
  left or right, and resets the layout. The sizes stay after a restart. A narrow window does not change the saved
  wide sizes. Bad preference data gives the defaults.
- **Reading position (commit `310b74c`):** the chat list keeps the line that you read while new lines, history lines
  and resize events come. It counts the new lines, marks the first unread line and shows "Jump to latest". A history
  replay of shown lines adds no line. An own send goes to the newest line.
- **Context menus (commit `fb86088`):** right-click, the Menu key or Shift+F10 on a buddy, a message or a transfer
  row opens a menu (arrows, Enter, Escape). Actions: copy a name, show a buddy on the map, copy a message, accept,
  refuse or cancel a transfer, show a received file in Explorer (also a renamed file). Escape closes only the top
  layer: menu, then drawer, then invite panel, then map. Selected text and input fields keep the native Copy.
- **Fixes (commits `e2eabd3`, `eefb254`):** the Transfers separator gives the visible height to screen readers, and
  "Show on map" from the narrow drawer gives the focus back to the Buddies button.
- **Checks:** `npm test` 139 of 139 pass (127.0.0.1). One `npm start` with no error line. A CDP drive script ran
  each "Done when" check of the work order in the running app, 2 full runs, all items pass, 0 console errors.
- **Open field checks:** on the packaged .exe, one row action by mouse and one by keyboard with the real Menu key
  and Shift+F10. Show in Explorer of a renamed file selects that file. Cancel to one receiver while a second
  receiver downloads, on 2 or 3 computers (LAN).
- **Next milestone:** 2, Quote a line and find it again (not started).

## Unreleased: faults of 0.6.0 (branch `opus/faults`)

All results in this entry are 127.0.0.1 results (one PC). There is no LAN or internet result yet.
- **Invite panel (commit `2a55770`):** the panel waits for the UPnP result and then shows the invite code. Copy
  goes through the main process. The operator saw these faults in an internet test of 0.6.0 (2026-11-19). The fix
  has 127.0.0.1 checks only, and the panel has no window test.
- **Second start (F1):** the portable launcher does not delete or unpack when a copy of the app runs from
  `%TEMP%\ASSCRACK`. It starts the running exe again, and the single instance lock of the packaged app shows the
  first window. The unpack folder stays the same, thus the firewall question stays one time for each build.
  `tools/second-start-check.mjs`: same build twice PASS, build A then build B PASS, stock 0.6.0 launcher FAIL.
  To change the build, close all copies first: a new build that starts while an old copy runs shows the old copy.
- **Voice start (F2):** a member opens one voice stream to the host and keeps the frames of the open time. Join voice
  to the first frame at the other member: median 32.2 ms with frame 0 lost before, 6.4 ms with no lost frame after.
  With a 100 ms stream open: 0 of 96 frames before, 96 of 96 after.
- **History for early members (F3):** a new host sends the history to each member with a session. A member whose
  session opened before the first election now gets the history (history test e, 10 of 10 runs).
- **Direct voice (F4):** a closed direct voice stream opens again after 1 s, with no host change (at most 5 times in
  a row). The host counts forwarded frames for at most 64 peers. `sendFrame` returns false when it sent no frame.
- **Dial warnings (F5):** a relay dial or a discovery dial does not open a second chat stream. 20 runs before the fix:
  the relay warning in 6 runs, the discovery warning in 12 runs. 25 runs after the fix: 0 and 0.
- **Status line (merge `60588aa`):** the line "No peers in this room yet." goes away when a peer joins. Before, it
  stayed until the next send, also with the peer in the list (operator check of 0.6.0 on 2 computers, 2026-11-19).
  `npm test` 96 of 96 pass and one app start with no error (127.0.0.1). No LAN result yet.
- **Election test (F6):** test f does not depend on random peer IDs (10 of 10 runs).
- **File speed (F7):** no change. The receiver log has the size, the Accept line and the done line, thus it gives
  the speed. Example: 200 MiB in 5.04 s.

## 0.6.0: a host with no port forward, connection log lines and load spreading

- **Build:** `dist/ASSCRACK-0.6.0-portable.exe`, 97,233,105 bytes, SHA-256
  `2d6185dff99c6bc8a4a204d8524d4b97a412a88744976c4d276c47dcd5070216`.
- **UPnP host:** when the Public address field is empty in an internet room, the app asks the router for a TCP port
  (UPnP). The invite code then has the public address. The full-node state still comes only from the dial-back. A
  private or CGNAT address gives no port and one `upnp none` log line.
- **Connection log:** each session writes one line with the peer, the type (direct or relay), the direction, the relay
  and the address. Each failed dial writes one line with the reason.
- **One unpack folder:** each build unpacks to `%TEMP%\ASSCRACK`. Thus Windows asks the firewall question one time.
  Known fault: a second copy of the app on one computer deletes files of the first copy.
- **Relay spread:** a member selects the full node with the fewest relayed sessions for each relay dial. When a full
  node stops, the session opens again through another full node.
- **Direct voice:** two voice members with a direct connection send the frames directly. The host forwards a frame only
  to the members that do not get it directly. A 0.5.2 app still gets voice through the host.
- **Results (internet):** R0, the rejoin of 0.5.2 with the old invite code and an empty address field: pass.
- **Results (127.0.0.1):** UPnP with a fake router 10 of 10. The relay spread test 40 of 40 under CPU load. The direct
  voice test: the host forwards 0 frames between two direct members. `npm test` passes 89 of 89. The terminal demo and
  one app start pass.
- **Not known:** UPnP on a real router, and all of 0.6.0 on a LAN or on the internet. Test card 7 gives the test.

## 0.5.2: the host rejoins its room with only the invite code

- **Build:** `dist/ASSCRACK-0.5.2-portable.exe`, 96,502,816 bytes, SHA-256
  `961b8a47690fb4adf0dc851dd136cf0d541f3005b4c4d0f77d81c623594e6307`.
- **Saved public address:** the app saves the public address of each room that it hosts. When the host rejoins the
  room with the invite code and an empty Public address field, the app uses the saved address again. Then the app
  listens on the forwarded port, and the other members find the host again.
- **Results (127.0.0.1):** a two-window check: B has no listen port and no LAN discovery, A leaves and rejoins with the
  code and an empty field. B and A are in one room again. The same check on the 0.5.1 build fails. `npm test` passes
  70 of 70. The packaged build passes the same check.
- **Not known:** the rejoin on the internet.

## 0.5.1: rejoin an internet room, and the room name on the joiner

- **Build:** `dist/ASSCRACK-0.5.1-portable.exe`, 96,497,772 bytes, SHA-256 `8f1af4f9d1bfd3c450b25cc94972bf918935dec654dd3057e45d6ce99496a41d`.
- **Internet result of 0.5.0 (operator, 2026-11-18):** A on a PC with a forwarded TCP port made an internet room. A
  laptop on a phone hotspot joined with the invite code. Chat, voice and file sharing worked. This is the first
  internet result. Two faults were found.
- **Room name:** a user who joined with an invite code saw no room name. The window now shows the room name from the
  code.
- **Rejoin:** when the full node left and started again, the other member stayed alone. A member with no full node now
  dials the known full nodes again each 5 s. A full node that started again has a new peer ID. The member then dials
  the same address with no peer ID, so an old invite code is still good.
- **Public address:** the label now says that the host of the room must fill it in. With no public address, the
  window shows no invite code.
- **Results (127.0.0.1):** `npm test` passes 70 of 70. A new test stops the full node and starts a new one at the
  same port. The member has a session with it after less than 1 s. The start, join and room name window checks pass.
  The terminal demo works.
- **Not known:** the rejoin on the internet.

## 0.5.0: internet rooms with invite codes, full nodes and voice over libp2p

- **Build:** `dist/ASSCRACK-0.5.0-portable.exe`, 96,496,437 bytes, SHA-256
  `132480d93ebcecc0a0b38f44afdb6be26191b332afb938f0bf3885d21dff4c50`. Test card 6 is at the top of
  `src/network/chatreadme.md`. There is no internet result and no LAN result yet.

- **Internet room:** a user makes a room with a room key. The **Invite** button gives a code that starts with
  `asscrack1:`. The code has the room name, the room key and the addresses of the known full nodes. Other users join
  with the code. There is no fixed server.
- **Full node:** a member with a forwarded TCP port is a full node. A peer dials back to it to make sure that the port
  is open. A full node keeps relay slots for the room members. When two members cannot connect directly, their chat,
  history and files go through the full node (a relay link). A private or loopback address does not make a full node,
  so a LAN room has no full node.
- **Room key:** each new session sends a proof of the room key. A peer with a wrong key gets no session, no relay slot
  and no voice stream.
- **Host election:** a full node gets the host role first, then the lower peer ID. With no full node, the rule is the
  same as before.
- **Voice over libp2p:** voice is now Opus frames (48 kHz, 20 ms, 32 kbps) on a libp2p stream to the host. The host
  sends each frame to the other members. This replaces WebRTC, so voice also works through a relay link. The host drops
  a frame that has the name of a different sender.
- **Network map:** a relay link is a dashed line (`data-kind="relay"`). A direct link is a solid line
  (`data-kind="mesh"`). A full node has a FULL badge.
- **Mixed versions:** a 0.4.0 app cannot join an internet room. In a LAN room, a 0.4.0 app has no voice with a 0.5.0
  app.
- **Results of the 0.5.0 tree (127.0.0.1):** `npm test` passes 67 of 67. New tests send chat, history, voice frames
  and a 3 MiB file through a relay on one PC. Other new tests check the room key, the invite code and the relay access
  rule. The file rate through the relay was 5.2 to 5.7 MiB/s. A voice frame from A through the host to B took a
  median time of 1.0 to 1.3 ms (127.0.0.1). A window check with a fake microphone sent and decoded voice frames in 2 app windows. Seven
  window checks passed. They check the start, the map, the history (a and b), files with 3 windows, Cancel for one
  receiver and the relay map. The terminal demo works.
- **Known (127.0.0.1):** after Join voice, the stream to the host opens after about 2.5 s. The frames of that time
  are lost.
- **Not known:** all of this on the internet and on a LAN. Test card 6 gives this.

## 0.4.0: a new look, the network map and cancel for one receiver

- **Build:** `dist/ASSCRACK-0.4.0-portable.exe`, 96,412,548 bytes, SHA-256 `35d29b03…`. Test card 5 is at the top of
  `src/network/chatreadme.md`. There is no LAN result yet.

- **New look:** a 2000s style (Frutiger Aero, Windows XP, LimeWire and AOL) with a modern feel. The login screen is a
  glass card on a sky. The chat screen has a buddy list with voice lights, chat bubbles, and a transfer table with
  progress bars. Short animations (0.15 to 0.3 s) show changes. With "reduce motion" on, there is no animation.
- **Network map:** a panel shows each room member and the chat sessions between them. The host has a RELAY badge,
  because the host relays the voice. Green lines show the voice connections to the host. A green ring shows who
  speaks. Orange arrows show the file transfers of this computer only.
- **Map data:** each node sends the list of its sessions to its peers. A 0.3.1 node ignores the list.
- **Cancel for one receiver:** each sender row of one receiver has a Cancel button. The other receivers continue.
- **Fault fixed (127.0.0.1):** when a receiver cancelled, the sender could show "Failed" in place of "Cancelled".
  The window check failed 1 of 7 runs because of this. A new test reproduces the fault on the old code.
- **Fault fixed (127.0.0.1):** when the sender cancelled, the receiver could show "Failed" in place of "Cancelled".
  This is the same race on the receiver side. A new window check found it (1 of 1 runs before the fix).
- **Fault fixed (127.0.0.1):** the warning "Dial to discovered peer ... failed" in the test runs. The node dialed a
  peer again while the first chat stream was still in negotiation. It now waits for the negotiation.
- **Log:** each file line has the side of this computer and the side whose action caused the event. The log also has a line for each
  file action of the user. This shows which side cancelled a transfer, which test card 4 could not show.
- **Results of the 0.4.0 build (127.0.0.1):** `npm test` passes 44 of 44. The history test gave 0 dial warnings in 4
  of 4 runs. One app start has no error line. A window check of Cancel for one receiver passes: the other receiver gets the
  full file. With 2 app windows, the restarted window showed all earlier lines in 3
  of 3 runs, one with the .exe. With 3 app windows, the file check passed, also with the .exe as the sender. A 200 MB
  file went to 2 windows in 5.7 s, and the voice continued. The map check passed all 40 lines. Each map had 3 nodes,
  one host, 3 chat lines, 2 voice lines and one transfer arrow. The terminal demo works.
- **Not known:** the map, the new Cancel and the new look on a LAN. Test card 5 gives this.

## 0.3.1: history in the window after a restart, and a log file

- **Build:** `dist/ASSCRACK-0.3.1-portable.exe`, 96,396,035 bytes, SHA-256 `dbea27ef…`. Test card 4 is at the top of
  `src/network/chatreadme.md`.

- **Fault (LAN, test card 2, 2 computers):** after a restart, the app did not show the chat lines from before the
  restart.
- **Cause (127.0.0.1):** the network layer gets the history. In 12 of 12 runs, the restarted node got all earlier
  lines 1 to 3 ms after its session opened. But the main process of the app did not send the history to the window.
- **Fix:** the main process now sends the history to the window. The window puts the lines in time sequence.
- **Log file:** the app writes one log file at each start, in `%APPDATA%\asscrack\logs`. Each history send and
  receive gives a log line with the message IDs and the count. The log does not contain the chat text.
- **Results (127.0.0.1):** with 2 app windows, the restarted window showed 0 earlier lines in 4 of 4 runs before the
  fix. After the fix, it showed all 3 earlier lines in 4 of 4 runs. `npm test` passes 36 of 36.
- **Results of the 0.3.1 build (127.0.0.1):** `npm test` passes 36 of 36, and one app start has no error line.
  With the .exe as the restarted app, the window showed all earlier lines in 2 of 2 runs. With 3 app windows and the
  .exe as the sender, a 200 MB file arrived in 2 windows in 4.7 s. The voice continued during the transfer. The
  .exe writes its log file in `%APPDATA%\asscrack\logs`.
- **Results (LAN, test card 4, 2 computers, 2026-11-17):** pass for conditions 1 to 3 and 5 to 9. Pass for the names
  before the first chat message, and for the offer, accept, cancel and the " (1)" name of the file transfer. Pass for
  the voice during the transfer. Pass for the chat history after a restart (condition 8), and for the voice after the
  restart (condition 9). The operator also closed A, then B, and logged in again each time. The chat history showed
  each time.
- **Condition 4 (refuse):** pass with a changed procedure on 2 computers. The card asks for 3 computers, with Accept
  on B and Refuse on C at the same time. The operator did Accept, then Refuse, in sequence on the same receiver.
  Refuse by a third computer during a transfer to another receiver has no LAN test.
- **Log files (LAN, 2 computers):** each computer wrote 2 log files, one for each start (condition 11). The 4 logs
  have no warning or error line, and each window console line has the level info (condition 10, from the logs). After
  each restart, the history arrived 3 to 4 ms after the session opened, and the window showed it 1 ms later.
- **Not known:** the LAN transfer speed. The log has no file size and no line for Accept.

## 0.3.0: peer names and file sharing

- Each member sends its name when a session opens. The peer list shows the names before the first chat message.
- A member selects a file and offers it to the room. Each other member can accept or refuse it.
- The file goes direct from the sender to each receiver, in chunks on a libp2p stream. It does not go through the host.
- The receiver checks the SHA-256 of the file. It writes the file into the Downloads folder with a name that does not
  overwrite a file. A failed or cancelled transfer leaves no partial file.
- **Results (127.0.0.1):** `npm test` passes 31 of 31. A 50 MB file arrives in 1.3 s, and its SHA-256 agrees with the sent file. With 3
  app windows, a 200 MB file arrives in 2 windows in 4.6 s, and the voice continues during the transfer.
- **Results (LAN):** the 0.3.0 build had no LAN test. Test card 4 tested the same names and file sharing with the
  0.3.1 build, and they passed (see the 0.3.1 entry).
- **Known limits:** the sender can cancel only the full offer, not one receiver.

## 0.2.0: voice and host failover

- The members elect one host with terms and heartbeats. When the host stops, the other members elect a new host with
  no input from a user.
- The host sends the chat history to each new member.
- Voice goes through WebRTC, with the host as the relay. The window has Join voice, Leave voice and Mute.
- **Results (LAN, test card 2, 2 computers):** pass for discovery, the same host on each computer, voice and mute. Pass for
  the new host after the old host closes. Fail for the chat history after a restart (see the entry above). Not tested:
  voice after a restart, and the developer console.
- **Results (LAN):** the 0.2.0 peer list showed a name only after that user sent a chat message. Version 0.3.0 fixes
  this.
- **Results (127.0.0.1):** after a kill of the host, the voice came back in 4.1 s.

## 0.1.0: LAN chat test copy

- Two users on one local network find each other with mDNS, with no address input.
- They send text messages in the window of an Electron desktop app.
- The app is one portable Windows .exe.
- **Results (LAN, test 1, 2 computers):** pass. The users found each other and sent messages in both directions.
