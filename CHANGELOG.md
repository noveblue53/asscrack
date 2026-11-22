# Changelog

This file gives the progress of ASSCRACK, one entry for each feature or release. The newest entry is at the top.

Each result has one of these labels:
- **LAN**: a test on 2 or more computers on one real local network.
- **127.0.0.1**: a test on one PC only. It does not prove that the feature works on a LAN.
- **internet**: a test on 2 computers on different networks, for example a home router and a phone hotspot.

## Unreleased — ready check (package P9A, milestone 9, 2026-11-21)

One command asks the room if each person is ready. A check is for the session only: no history, no archive.

- **Open a check.** Type `/ready Race in five?` in the message box, or select "Ready check" in the Room menu. A
  check has a text of 0 to 120 characters on one line. With no text, the check asks "Ready?".
- **The bar.** Each person sees one bar above the message box: "Ann asks: Race in five?", with "Ready" and "Give me
  a minute". The bar shows three lists of names: Ready, Give me a minute, Not answered yet. A changed vote replaces
  the previous vote.
- **One person, one vote.** ASSCRACK counts each vote by the peer session, not by the name. Two people with the same
  name count two times. The bar then adds the end of the peer ID to each of the two names.
- **Close and expiry.** The initiator has "Close". A closed check shows its result for 10 seconds, then the bar goes
  away. The check ends at once when the initiator quits. After a lost connection, the check ends when the
  initiator does not come back in 10 seconds. A closed check never shows again: not after a reconnect, and not
  after a history replay.
- **One check for each person.** A new check of the same person replaces the previous check. When two people
  each open a check, the bar shows one block for each check. The open checks come first.
- **Late joiners.** A person who joins later gets the open check from the initiator and the votes from each voter.
- **Availability.** In Do not disturb the bar shows with no sound. In Idle Peer there is no bar, and the vote stays
  "Not answered yet". A new check of a different person plays the message cue only when the conversation is not in
  view.
- **Old clients.** A client that does not know the new `ready` line ignores it.
- **Result: 127.0.0.1, this PC.** `npm test`: 621 of 621 pass. New tests: 16 of the state (fake clock), 2 on
  three and two nodes on 127.0.0.1, 12 of the window, 1 of the bridge. One start of the app: no error line. An app
  check with three profiles on this PC (127.0.0.1): 19 of 19 checks pass, also two checks at the same time. Three people respond, one changes the
  vote, and two have the name "Sam". Each person counts one time. After the close, one copy quits, starts again and
  joins again. The history replay comes, and the closed check does not show again.

## Unreleased — voice (goal G4, 2026-11-21)

Voice tells the user when the microphone or the speakers fail. A user with no microphone can listen. Deafen is new,
and the volume of each person stays. Gap IDs C1, N1, C2, C5, C6, C7, C8, C3, C4 of `work-orders/gaps-1.0-20261121`.

- **No microphone.** A microphone error does not stop Join voice. The user stays in voice and hears the others. The
  others see "in voice (muted)", and the own line shows "in voice (no microphone)". When a microphone comes,
  ASSCRACK uses it.
- **A device goes away.** When the track of the microphone ends, ASSCRACK opens the capture again. A device change
  opens a missing capture, and the selected microphone when it comes back. The selected speakers have the same
  rule. A text under the voice buttons tells each fault, and it goes away when its cause goes away.
- **Microphone errors.** Each error name has its own text: the Windows privacy setting, a microphone that a
  different app uses, no microphone. The Voice settings panel uses the same texts.
- **Deafen.** A new button next to Mute, and Ctrl+Shift+D, while in voice. The voice of the others does not play,
  and Deafen mutes the microphone. Deafen off gives back the mute state from before. The others see "in voice
  (deafened)". The detached voice panel shows "Deafened".
- **Mute.** Mute shows also before Join voice, and Ctrl+Shift+M changes it. The mute state stays through Leave voice
  and Join voice while the app runs. A new start of the app and Idle Peer set it to off.
- **Volume of each person.** The line of a person shows "muted for you" and the volume when it is not 100%, also in
  its tooltip. The volume goes from 0% to 200%, with a mark at 100%. Above 100%, a limiter stops the clipping. A
  double-click on the label of the slider sets 100%, and "Reset" removes the choice. ASSCRACK keeps the choice of
  each person in the profile, for each room. The key is the device ID of the room membership (never the name). A
  room with no membership keeps the choice only while that person stays in the room: its libp2p peer ID is new at
  each start. Forget of a saved room removes its choices.
- **Cues.** A cue of my own action (join, leave, mute, unmute, deafen) plays also in Do not disturb. It is silent in
  Idle Peer. The cues play on the output device of the voice settings.
- **Result: 127.0.0.1, this PC.** `npm test`: 545 of 545 pass (18 new G4 tests, in node:vm with fake
  devices and on 127.0.0.1). `node --test test/voice-gate.test.mjs test/voice-settings.test.mjs`: 16 of 16 pass. The
  two-copy voice check (its room setup repaired for the protected rooms) gives the same result as on `main`. An app
  check with two copies: 21 of 21 checks pass (no microphone, a device change, an ended track, the speakers text,
  Deafen, the keys). A second app check: 8 of 8 pass (the volume of a person stays after a restart, Reset removes
  it). One start of the app: no error line. The removal of a real device is not tested: Windows needs an
  administrator to turn off a device. No LAN test. A test with real speakers and a real microphone is for the
  operator.

## Unreleased — resume of large transfers, network part (package P7a, 2026-11-21)

The receiver can pause a large download and continue it later from the same byte, on the same route or on a
different route. This is the network part. The window part (Pause, Resume and Discard buttons) is package P7b.

- **Pause.** A paused download keeps its partial file. The key of a partial is the SHA-256 and the size of the
  offer. Thus a later offer of the same content also continues it, also after a restart of the app. Cancel deletes
  the partial as before. A failed download that the user did not pause deletes its partial as before.
- **Offset negotiation.** A new protocol version `/asscrack/file/1.1.0` next to 1.0.0. The receiver sends the
  offset and the SHA-256 of its partial bytes. The sender checks its source file and the partial hash, and sends
  only the remainder. A corrupted partial starts again from byte 0. A changed source fails with "the source file
  changed". A peer with only 1.0.0 gives a fresh full transfer and a "restarted" indication. One SHA-256 check of
  the full output comes before the file is final.
- **Limits.** All kept partials together have a budget of 8 GiB. Each partial expires 72 hours after its last byte.
  The expiry and Discard delete the file and free the disk space.
- **127.0.0.1 result (this PC).** A 64 MiB file paused at 39.9 % on direct TCP and continued over a relay circuit.
  The sender sent 40,304,640 file bytes, the exact remainder, plus a 20-byte reply line. The wire overhead on the
  sender upload was 0.2 %. These cases also pass on 127.0.0.1: a corrupted partial, a changed source, no offset
  negotiation, the budget, the expiry, Discard, Cancel, a receiver restart. No LAN or internet result
  yet: the 1 GiB measurement on two networks is a field check after 1.0.

## Unreleased — chat links, files with text, and keys of the message box (goal G3, 2026-11-21)

Links in the chat open in the system browser. A file and the text of the message box go to the correct people. Gap
IDs D1, D2, D3, D4, D5, D7, N5, N7 of `work-orders/gaps-1.0-20261121`.

- **Links (D2).** Each `http://` or `https://` URL in a chat line or a whisper line is a link. The punctuation at the
  end of the URL is not part of the link. A highlight in a URL does not cut the link. A click sends the URL to the
  main process. The main process opens it in the system browser only if it is `http:` or `https:` with a host and
  no user name or password. The URL has 2048 characters or less. It opens at most one link each 500 ms. The window
  itself never goes to the link. A chat link is not a tab stop: the row menu has "Open link".
- **A file and the text (D1).** The message box always belongs to the room. A media file for the room takes the text
  as its caption. An ordinary file for the room goes first, then the text goes as a line. A file for one person and
  a text: only the text goes to the room, and the file stays attached with a status text. The draft shows the size
  of the file and a small picture of an image.
- **Offer note (N5).** An offer with no chat line gives a note row: "You offered notes.txt (27 B) to the room."
- **Paste of a file (N7).** Copy a file in Explorer, then press Ctrl+V in the message box: the file attaches.
- **Keys (D3, D4).** Up and Down in the message box recall the last 50 sent texts of this run. Tab completes a buddy
  name at the end of a word. All other Tabs move the focus.
- **Channels (D5).** A count next to the channel menu shows the unread lines of the other channels.
- **Image viewer (D7).** A click on a chat image, or "View image" in the row menu, shows the image at full size.
  Escape closes it.
- **Result: 127.0.0.1, this PC.** `npm test`: 555 of 555 pass (28 new tests). One start of the app: no error line.
  App check with two copies on this PC: 9 of 9 checks pass. They check these items: the paste of a copied file,
  the offer note, the link and its click, and a link with a highlight. They also check the draft picture and the
  image viewer with Escape. The check
  used `Set-Clipboard -Path` in place of a copy in Explorer (the same clipboard format). No LAN test.

## Unreleased — sound cues for other people and for messages (goal P11, 2026-11-21)

ASSCRACK plays a short local cue when a different person joins or leaves voice, and for a mention or a whisper to
me. The cues are oscillator tones (no sound file). Only the local user hears them: the voice capture does not get
them.

- **Voice cues of other people.** "Other person joins voice" and "Other person leaves voice" play only while I am in
  voice. They play only for a real change of the voice state of that peer. These give no cue:
  - the first voice state in 3 s after the session of a peer opens
  - the states at my own Join
  - a reconnect in the 10 s of G2.

  A peer in voice that goes gives the leave cue at once after a bye. With no bye, the cue comes after 10 s if the
  peer does not come back. When I have 0 peers after the event (my own loss), no leave cue plays.
- **Message cues.** A mention of my name or keyword plays a cue, and a whisper to me plays a cue. The cue plays only
  when the conversation is not in view or the window does not have the focus. The cue plays also when desktop notifications are off. My own lines and
  the history replay give no cue.
- **Rules.** No cue of other people and no message cue in Idle Peer or in Do not disturb. The own cues do not change.
  At most one message cue each 2 s and one voice cue of other people each 0.5 s. ASSCRACK drops a cue in that time.
- **Settings.** "Sound & notifications" has 2 new switches: "Other people join or leave voice" and "Mentions and
  whispers" (both on by default). The cue volume controls all cues. The preview list has the 4 new cues.
- **Result: 127.0.0.1, this PC.** `npm test`: 527 of 527 pass (12 new cue tests with the fake clock).
  `node --test test/voice-gate.test.mjs test/voice-settings.test.mjs`: 16 of 16 pass. App check with two copies (a
  stub records each cue): 9 of 9 checks pass. The cues play for a join, a leave, a mention and a whisper. No cue
  plays for the replay of saved lines. One start of the app: no error line. No LAN test. The sound of the cues
  on real speakers is not tested.

## Unreleased — room link and transcript notes (goal G2, 2026-11-21)

The room tells what the connection does, and the chat shows who came and who went. Gap IDs A2, A4, B1, B2, B3, D6,
N4 of `work-orders/gaps-1.0-20261121`.

- **Bye line.** A node that stops sends `{"type":"bye"}` on each open session, waits 200 ms, then closes the
  sessions. The `peer-left` event gets `left: true` after a bye, else `left: false`.
- **Who came and who went.** The chat gets note rows: "Alice joined the room.", "Alice left the room." and
  "Alice lost the connection.". A peer that goes with no bye stays as a grey buddy line for 10 s. When this
  computer loses all its peers, one note "Connection lost at 21:04." comes, and "Reconnected at 21:05." at the return.
- **Room link.** The text above the chat tells the state. Examples: "Connecting to the room…", "Connection lost at
  21:04. Reconnecting…" and "Everyone left the room. Waiting for a peer.". After 20 s with no connection, a longer
  text and a "Details" button come. The status bar says "Connecting…", "Reconnecting…" or, for 5 s, "Reconnected".
- **Send again.** A line with "Only on this computer" gets "Send again". When the first peer comes, the status tells
  how many lines were not sent. ASSCRACK does not send them automatically.
- **Day rows.** "Today", "Yesterday" or the date comes before the first line of each day. Each time has the full
  date in its tooltip.
- **Status notices.** "Message copied." and "Name copied." go away after 6 s.
- **Result: 127.0.0.1, this PC.** `npm test`: 515 of 515 pass. App check with two copies: a quit gives "Bob left
  the room." and "Everyone left the room.". An ended process gives the grey line, "Connection lost at …" and
  "Reconnecting…" (11 of 11 checks pass). One start of the app: no error line. No LAN test.

## Unreleased — behavior tests for the room window (goal P3, 2026-11-21)

Some tests of the room window only read the source text. A change of the code text made them fail, and a broken
behavior with the same text did not. P3 replaces the most important of these checks with tests that run the real
scripts in the fake DOM. No change in `src/`.

- **Escape (`test/room-escape.test.mjs`).** All the layers are open. Each Escape closes only the top layer, in the
  sequence of the dispatcher. The quote chip goes only with the focus in the composer. An open dialog stops Escape.
- **Bridge (`test/preload-bridge.test.mjs`).** `preload.cjs` runs with a fake electron module. The tests check the
  IPC channel and the arguments of each call. `revealFile` sends only a text key. The bridge does not use `shell`.
- **Saved rooms (`test/saved-rooms-window.test.mjs`).** The local-only mark, the line-saved and save-failed events,
  Forget with a confirmation, and the paging of older lines.
- **Removed.** 12 text checks in `test/app-events.test.mjs` and `test/saved-rooms-ui.test.mjs`. A behavior test now
  covers each one. The three code rules stay: one Escape listener in `renderer.js`, no inline style, and the debug
  log text of `main.js`. The checks of `main.js` stay, because `main.js` does not load with no Electron.
- **Result: 127.0.0.1, this PC.** `npm test`: 476 of 476 pass. 30 breaks in a copy of the code: each break makes a
  test fail. One start of the app: no error line. No LAN test.

## Unreleased — getting in: room reach and clear login texts (goal G1, 2026-11-21)

A room owner can see if friends on the internet can join, and can repair it in the room. A friend gets plain texts
for a bad invite. Gap IDs A1, B4, A3, A5, A6, A8, N2, N3, N8, N9 of `work-orders/gaps-1.0-20261121`.

- **Reach of the room.** The Invite panel of the owner tells if the room has an address. It also tells when the app
  asks the router for a port, or why the router did not open one. A button asks the router for a port (UPnP) in a running room,
  and a saved room keeps that choice for each reopen. "Create device invite" is disabled while the room has no
  address. The login card warns an owner with no public address and no UPnP, but does not stop the login.
- **Status bar.** The texts are "Open to the internet", "Open through Alice", "Address not tested yet", "Asking the
  router…", "No open port" and "Friends cannot join yet". Only the last text has the warning color. Before, each new owner saw a
  red "No full node".
- **Login errors.** These errors give a text that tells the repair:
  - a bad invite
  - an invite for a different device, or from a different version
  - a port in use, or a bad public address
- **Login card.** The button says "Create room", "Join room" or "Create LAN room", and "Starting the room…" while
  the room starts. Enter in the invite box logs in. "Copy my device ID" is below the button for each room type and
  goes to the join type after the copy. The window keeps the last user name. Each saved room has "Change name".
- **Saved rooms.** "Save room on this device" is on by default for the two Create types (operator decision
  2026-11-21). With the box off, a note tells that the room is gone at quit. Create with the name of a saved room
  starts only at the second click.
- **Texts.** A device invite has the label "Invite for this device". The note for old clients says "Ask them to get
  the newest ASSCRACK."

Results (**127.0.0.1**, this PC):
- `npm test`: 468 of 468 pass (431 before). New: 3 UPnP cases with the fake router, 7 login error cases, 1 saved
  room case, 26 window cases. One earlier full run had `test/send-record.test.mjs` fail one time as a file. The
  file passes 20 of 20 alone, and G1 does not change the send path.
- One `npm start`: no error line in the terminal, the developer console or the app log.
- Two app copies: an owner with no address sees "Friends cannot join yet". "Create device invite" is off.
  With the address 127.0.0.1:<port>, the owner invites the second copy. After the join, the owner sees "Open to
  the internet" and the friend sees "Open through Alice". The quit of the friend gives 2 "Unknown room window"
  error lines. `origin/main` gives the same 2 lines (older code, not in this goal).
- No LAN result and no internet result. UPnP with a real router is not tested.

## Unreleased — Find keeps the unread marker (2026-11-21)

Fault: open Find while the list is at the end. A new line comes. Press Escape. Before, the list went to the new end,
and the late scroll event of Chromium counted the new line as read. The marker went away.

- **Fix (`src/application/reading.js`).** `savePosition()` also keeps the anchor of a following list.
  `restorePosition()` follows again only when no line is unread. Else it goes back to the old last line. When the
  find hold ends with unread lines, a late scroll event at the restored position does not clear the count and the
  marker. This is the same guard as for a highlight reveal and the return from a whisper.
- **Tests.** `test/find-unread.test.mjs` loads the real room window scripts. It opens Find, adds a line, presses
  Escape, and then sends the late scroll event. It has a case for 20 px lines: there the old end is in the 24 px end
  band. `test/reading-hold.test.mjs`: the old test expected the new end after a line came during Find. That is the
  fault, thus it is now two tests. With no new line, the list follows. With a new line, the list shows the old last
  line and 1 line is unread.
- **Result: 127.0.0.1.** The new tests fail on the code of `main` and pass with the fix. No LAN test.

## Unreleased — the 1.0 release order (2026-11-21)

The operator decided that 1.0 is a full-featured release that comes before the friends get it.
`docs/WORK_PLAN_1.0.md` and the README roadmap give the new order:

1. All 1.0 features: screenshare (7B), resume of large transfers (8), the ready check (9) and a per-user installer
   with start at Windows sign-in. These items have no field gate before 1.0. Each exit before 1.0 is a 127.0.0.1
   check or a check on this PC.
2. The security audit and the fixes that the operator accepts.
3. The 1.0.0 freeze and its checks on this PC.
4. After 1.0: the game nights and card 9 are field checks of 1.0. A field fault gives a 1.0.x build.

The upgrade checks from 0.7.0 and 0.6.0 and the mixed-version checks move after 1.0.

## Unreleased — app icon in Windows (2026-11-21)

The app has its own icon. Before, the portable .exe, the taskbar button and the window showed the default Electron
icon, and the tray used a 32 x 32 PNG.

- **One icon file.** `build/make-icon.cjs` renders `src/application/img/logo.svg` with Electron and writes
  `src/application/img/app.ico` with 7 images: 16, 24, 32, 48, 64, 128 and 256 px. It adds no dependency. Run it
  again with `npm run icon`.
- **Use.** `build.win.icon`, the window and the tray use `app.ico`. Windows selects the tray size for each screen
  scale. `tray.png` is removed.
- **Known limit.** At 16 px the lightning bolt of the logo is hard to see. The circle is clear.

Results (**this PC**, 127.0.0.1 for the network part):
- `npm test`: 431 of 431 pass (426 before, plus 5 icon tests).
- The icon of `ASSCRACK-0.8.0-portable.exe` and of the unpacked `ASSCRACK.exe` (shell icon, 32 px) is equal to the
  32 px image of `app.ico`. The control, `electron.exe`, is different in 856 of 1024 pixels.
- The window icon (16 px and 32 px) is equal to `app.ico` in the built .exe and in `npm start`. The taskbar button
  shows the icon.
- One `npm start` and one start of the built .exe (temporary `--profile` and `--log-dir`): 0 ERROR lines. One start
  in a LAN room on 127.0.0.1 that went into Idle Peer mode made the tray with 0 ERROR lines.
- The test build is not a release: it keeps the version 0.8.0 (123647234 bytes, SHA-256 `ac118adb...`). It does not
  replace the 0.8.0 build in the shared `dist/`.

## Unreleased — polish pass on the room window (2026-11-21)

A review of the window found 37 visual and keyboard faults. This change repairs 27 of them in the renderer files only.
It has no new feature, no protocol change and no new dependency.

- **Login card at 800 x 600.** Log In and the error text are now in the window. The check boxes are small, with
  usual labels. Saved rooms are in a second column when the window is 760 px or wider.
- **Contrast.** Find with no result is readable in the dark themes. The message box placeholder has a contrast of 5.1:1
  or more (before: 2.6:1). The focus ring of the list rows and the Log In arrow on Pearl now use the colors of the
  theme. Before, the ring was gold (1.5:1 on white) and the arrow was white.
- **Same look for the same function.** All dialogs have one frame. The selects and text fields have the look of the
  theme. The voice settings use the colors of the theme. Amber Terminal has square corners on all controls.
- **Error texts.** The user does not see "Error invoking remote method ..." before an error. A Join with no name asks
  for an invite code, not for a room.
- **Keyboard.** Tab into the chat list goes to the newest line, not to the oldest line (rooms with file cards: see the
  open item N01). The View menu has five groups, and Quit is the last line.
- **Smaller items.** These items have small repairs: the Quote control of the compact transcript, the head buttons of
  the map and of Buddies, and the topic editor. Also the "(you)" mark of a long name and the tooltip of a long status
  text.

Open items (not repaired): N01 to N10 in the report of the pass. Examples: the card buttons of older lines are tab
stops, and the History popover covers the Room options popover.

Results (**127.0.0.1**, this PC):
- `npm test`: 426 of 426 pass.
- One start with two profiles in one room: chat, file, image, voice, dialogs, whisper and Quit. Result: 0 ERROR
  lines in the terminal, 0 errors in the developer console.
- Contrast audit of 39 window states in each of the 6 themes: 75 findings before, 0 real findings after.

## 0.8.0 (2026-11-21): candidate build

This build contains the protected-room hardening of RC2: device admission, host permissions, revocation and bounded
network operations. The entries "Unreleased — protected-room Windows candidate" and "Unreleased — Windows
friend-pilot release candidate" below give the details. This build adds these changes:

- **Version 0.8.0.** The build name is `ASSCRACK-0.8.0-portable.exe` (before: `ASSCRACK-<version>-private-dev.exe`).
- **Compact invite code (`asscrack3:`).** A protected room makes a binary code with the same contents and the same
  signatures. It holds the room name, the room key, the host peer IDs, the addresses and the signed membership. A 4-byte
  checksum refuses a damaged code. The app continues to read `asscrack1:` and `asscrack2:` codes. A legacy
  shared-code room continues to make an `asscrack1:` code for 0.7.0 peers. Measured lengths (20-character room name,
  1 IPv4 address for each host node):

  | Code | 1 host node | 3 host nodes |
  |---|---|---|
  | `asscrack3:` (0.8.0) | 410 | 536 |
  | `asscrack2:` (RC2) | 850 | 1116 |
  | `asscrack1:` (no membership) | 276 | 541 |

  With a 64-character room name, `asscrack3:` has 469 (1 node) and 594 (3 nodes) characters.
- **Asynchronous `safeStorage` calls.** The saved-rooms key uses `isAsyncEncryptionAvailable`, `encryptStringAsync`
  and `decryptStringAsync`. The Electron 45 deprecation warnings are gone. The archive opens before the window.
  At the first start, the app makes the key file with an exclusive create. Thus two processes on one new profile use one key.
- **Update text for 0.7.0 users.** The invite panel of a protected internet room and of a LAN room shows a text.
  It tells that people with 0.7.0 or older cannot join and must update to 0.8.0.

Results:
- **127.0.0.1:** invite unit tests give a round trip for 1 and 3 host nodes with IPv4, IPv6 and DNS addresses. They
  refuse a damaged code and a code with a wrong signature. Two 0.8.0 profiles joined one internet room with an
  `asscrack3:` code. They sent a chat line in each direction.
- **127.0.0.1:** a profile from `main` at `de9baa0` and a profile from the 0.7.0 build opened with their saved room
  and 3 lines. One `npm start` showed no `safeStorage` warning and "Saved rooms archive opened: state open".
- **127.0.0.1, 0.7.0 build and 0.8.0 together:**

  | Case | Connect | Chat | 0.7.0 window | 0.8.0 window |
  |---|---|---|---|---|
  | Legacy internet room: 0.7.0 makes, 0.8.0 joins with `asscrack1:` | yes | both directions | "Internet room", 2 peers | "Legacy shared-code room", 2 peers, no update text |
  | Legacy internet room: a second 0.7.0 joins through the 0.8.0 node | yes | both directions | "Internet room", 2 peers | "Legacy shared-code room", 2 peers, no update text |
  | Protected internet room: 0.8.0 makes, 0.7.0 joins with `asscrack3:` | no | no | "The invite code has a wrong prefix" | "Waiting for a peer", update text |
  | LAN room, same name, 0.7.0 first | no | no | "Waiting for a peer" | "Waiting for a peer", update text |
  | LAN room, same name, 0.8.0 first | no | no | "Waiting for a peer" | "Waiting for a peer", update text |

  The 0.8.0 room copies wrote no ERROR line. The 0.7.0 copy wrote one ERROR line for the refused code. In the
  protected internet case, a third 0.8.0 copy only gave its device ID and quit about 1 second after its start. Its
  terminal has 2 Chromium lines "GPU state invalid after WaitForGetOffsetInRange" at that quit. The same quick quit
  gave 0 such lines in 3 runs of `de9baa0` and 0 lines in 3 runs of 0.8.0. Thus the cause is not known, and this
  change did not cause the lines.
- **127.0.0.1, build check (2026-11-21):** `npm test` 426 of 426 pass on `30bb0d2`. The source app and the built .exe started one
  time each, with a temporary `--profile` and `--log-dir`. Each start gave no ERROR line and no console error. Each
  log has "Saved rooms archive opened: state open".
- **Build:** `dist/ASSCRACK-0.8.0-portable.exe`, 123318931 bytes, SHA-256
  `93a0f755b8029db8a293e4c22b5ca2cd74ca22be0744d12a428b2fa590a23373`, made by `npm run dist` from `30bb0d2`. The
  build has no code signature. It replaces the first 0.8.0 build from `5127a48` (SHA-256 `1a964f4c...7e78c`), which
  did not have the key-file fix.
- No LAN or internet test of 0.8.0 occurred. The operator deferred the tests with other users (2026-11-20).

## Unreleased — protected-room Windows candidate

- New internet and LAN rooms use owner-signed device invitations. The first admission requires a live owner. The owner grants hosting separately and can revoke a device. An isolated peer enforces an update when it receives the signed revocation.
- Legacy shared-code rooms require explicit consent. New internet rooms ask the router to forward a port only when the owner selects UPnP.
- Relay reservations and connections require room admission. Chat queues, inbound file requests, transfers and media previews have bounded resource use. The app restricts native desktop actions to the packaged main frame and grants microphone access to the room.
- Upgraded to Electron 45.4.1 and libp2p 3.5.1. The Windows release tools verify the embedded application and provide a separate timestamped signing path.
- **127.0.0.1** — Two independent desktop profiles completed device enrollment, chat and revocation in both internet and LAN modes. A four-peer circuit workload delivered 360 expected public copies and 60 addressed whispers. A legacy RC1 peer exchanged messages with the updated stack.
- **127.0.0.1, Windows 10 PC (merge check, 2026-11-21):** the operator accepted the merge of RC2 source `344a8b23` into `main`. `npm test`: the first run had 3 failures in `test/room-archive.test.mjs` and `test/saved-rooms.test.mjs`. The cause was the test cleanup: it deleted the temp folder before it closed a second database store, and Windows cannot delete an open file. The tests now close each store first. After the fix, 404 of 404 pass. One `npm start`: no error line. The terminal and the log show 2 Electron 45 deprecation warnings for the synchronous `safeStorage` calls. There is no LAN result and no internet result for this source.

## Unreleased — Windows friend-pilot release candidate

The friend pilot integrates the field recovery, desktop review and center-pane whisper branches at `09ee774`. The frozen runtime source is `42cf3c64dc17e6bc86df21e8e66c16301e151ea6`. It keeps the 0.7.0 app version. Use the executable name and SHA-256 in the handoff to identify the portable. [Work-plan closeout](docs/WORK_PLAN_1.0.md#friend-pilot-closeout) · [Windows field card](docs/FRIEND_PILOT.md)

**Windows x64 portable RC1.** `ASSCRACK-0.7.0-friend-pilot-rc1-42cf3c6-windows-runner-x64.exe` is 109,230,103 bytes with SHA-256 `567507aafaf63c209732b8144abd65a396d4570a339dab616b66e3d2b815048d`. The unsigned build used Windows Server 2025, Node 24.22.1, Electron 40.5.0 and electron-builder 26.18.0. The portable opened its window on Windows. A second launch exited in 55 ms and preserved all 187 unpacked files and the first window. Quit cleaned up the unpack folder. The draft download passed the SHA-256, NSIS and embedded archive checks. All 90 packaged application and network files matched the frozen source after Windows line-ending normalization. Both native x64 addons matched the locked package bytes. [Native build and launcher check](https://github.com/noveblue53/asscrack/actions/runs/44710271972) · [Draft download](https://github.com/noveblue53/asscrack/releases)

The extracted x64 app from the same draft download exchanged two-way keyed loopback chat, handled a second start, quit cleanly and reopened both archived lines exactly once with the other peer offline under Wine 11.22. The renderer reported zero errors.

**Native Windows packaged room.** A Windows Server 2025 runner downloaded and verified the exact RC1 executable before extracting the app. Two fresh profiles joined by invite, exchanged named-channel chat and whispers, verified a 2 MiB file and an inline PNG original, and exercised join, mute and focused push-to-talk with synthetic audio. Windows CurrentUser DPAPI unwrapped the profile key, and ordinary read-only SQLite rejected the encrypted archive. A cold reopen showed both public messages once and excluded private chat. Removing the wrapper from a disposable copy left its database intact. Restoring the wrapper recovered both message identities and preserved the original profile. No renderer errors occurred. [Packaged Windows verification](https://github.com/noveblue53/asscrack/actions/runs/44764956047)

**Native Windows retry and 0.7.0 migration.** A controlled TCP disconnect stopped an actual loopback transfer after Laptop wrote 983,040 bytes of a 16 MiB original. Retry stayed disabled while the source was offline. The same peer rejoined automatically. Three activations on the original card produced one transfer row and one SHA-256-verified file. The failed attempt cleaned up its partial and left a separately placed partial intact. A Windows profile created with the earlier `8dacddd` source and matching Electron and dependency payload also passed a cold upgrade to the exact RC1 app. Room identity, history, voice preference and message IDs survived. The saved credential rejoined the room and new channel messages survived another cold reopen. The original closed profile stayed byte-identical for the files checked. [Windows retry and upgrade run](https://github.com/noveblue53/asscrack/actions/runs/44766734239)

**Windows account isolation.** The unprivileged Windows Local Service identity read and hash-verified copies of the encrypted archive and its protected key material. Its own DPAPI round trip passed. Windows denied its attempt to unwrap the original account's profile key. The original account reopened its saved history and recovered a disposable copy after restoring its wrapper. The original protected files stayed intact and the temporary task was removed. [Native Windows account-isolation run](https://github.com/noveblue53/asscrack/actions/runs/44768810298)

**Earlier Linux cross-build.** `ASSCRACK-0.7.0-friend-pilot-rc1-42cf3c6-win-x64.exe` is 109,478,949 bytes with SHA-256 `d3241c136d43353b8c2c185a72e906f77718ae8fc47d3bcae2177722d49a4da3`. Its extracted x64 payload passed a fresh login, two-way keyed chat, second start and cold archive reopen under Wine 11.22. The outer PE32 launcher and a 32-bit control executable failed to start in Wine. The draft distributes the later Windows-built executable.

**Frozen-source checks.** `npm test` passed 384/384 with zero skips in 115.105 s. `npm start` opened the Linux login window and exited 0 with host D-Bus diagnostics. In a separate loopback check the frozen source exchanged chat and eight byte-identical 1 MiB files with actual 0.6.0 (`d5ad3af`) and 0.7.0 (`de54371`) sources across both host directions. Older peers received no unsolicited shelf entries or chat from publishing.

**Room and telemetry.** The six themes share the new room layout. The frame holds Transfers and View, the conversation header holds the room, channel and Invite, and the buddy pane carries voice. The selected buddy stays marked in the roster and on the map. Wide windows show connection facts and recent events alongside the map. Full events remain one action away.

**127.0.0.1 visual review.** Linux Electron 40.5.0 rendered solo and three-peer keyed rooms at 1672 × 941 CSS px to match the concept and also checked 1492 × 815 and 800 × 600 at 1×. The wide room devoted 48.3% of its panel area to chat and 29.0% to the map and inspector. The populated room used synthetic microphones, John's live route and audio reading, two real events and an 83,968-byte verified file. The independent review found clipped window controls caused by scrolling into hidden login geometry. The rerender kept the frame at the origin, preserved John's map and roster selection for more than five seconds across activity, and allowed keyboard selection and details on the compact view. The renderer reported zero errors.

**127.0.0.1 file retry.** In the running Linux Electron 40.5.0 app, Laptop lost its direct connection after receiving 6,684,660 bytes of a 128 MiB original. The original card disabled retry while the source was offline. After reconnect, **Retry** on that card restarted the transfer without a sender repost. Repeated activation started one attempt, the other recipient finished independently, and each receiver saved one full file with SHA-256 `ae6981ec27114548cfb8700b33c933a176c6a4a71f841b2dcf173d289dd85a7c`. The 16 MiB integration checks exercise both direct TCP and circuit relay.

A separate Linux Electron check cut Laptop's only circuit externally during a 24 MiB transfer. The interrupted attempt cleaned its own partial and preserved a seeded stale file. The original card and Transfers row shared the retry state. Each of the two receivers saved one file with SHA-256 `1d40cf3b9660d6802bd529a2fadee57e23e3f857cdacbbd03f535afa2b0902d6`. The renderer reported zero errors.

**127.0.0.1 Shared shelf.** Two running Electron profiles joined the same keyed room. The late profile downloaded a 1 MiB file from **Shared** with SHA-256 `a3f1b4f1e7ccf5ebb174809fdb35de6026d1ab93b1e33ba2b08e2e85a913bee1`. Publishing created no chat card and preserved the draft. Removing the listing left the saved copy, and the renderer reported zero page errors.

**127.0.0.1 conversations and attention.** Two keyed Electron profiles exercised visible public typing, private draft isolation and real Linux D-Bus notifications. Opening a notification selected the right whisper or named channel and cleared its unread state. The private banner omitted message text. In Do Not Disturb, public highlights and private unread activity stayed visible, both native alerts stayed quiet, and mute still worked. The check exercised Web Audio for preview, join, mute and unmute. Windows notification activation and acoustic behavior remain field checks.

**127.0.0.1 game-night rehearsal.** Fresh Linux Electron profiles joined by invite, replayed a named channel to a late arrival and used both whisper entry points. Equal names required a recipient choice. Disconnect and rejoin retained the private draft and the public draft and reading position. Synthetic microphone input exercised join and mute. An X11 key event exercised the global push-to-talk hook. The room rendered a PNG and separately saved its verified 5,574-byte original. Closing to Idle Peer released capture while two-way chat continued over the existing circuit. After all processes quit, a cold reopen through KWallet 6 and SQLCipher restored public history and the verified original. The restored transcript contained neither private test message.

When the sole relay vanishes, a member with no sessions clears its temporary host term so it can join the returning full node. In an independent 127.0.0.1 exercise on the frozen source, a new full-node identity at the same endpoint brought fresh two-way chat back in about 4.08 s and fresh synthetic audio in about 4.09 s. The earlier baseline reached the new circuit but failed to agree on a host within 20 s. Real separate-network and intelligible-speech checks are open.

## Unreleased — desktop review branch

The **work/room-desktop** follow-on adds six persistent room themes, themed window controls, compact chat, a detachable voice panel and manual Idle Peer in the portable app. Public channels keep separate transcripts, drafts, unread counts and encrypted history. Captioned screenshots, GIFs and videos preserve a separate original download. Current senders bound file data ahead of receiver disk writes. Private whispers require a capable online recipient. Voice cues and native mention or whisper notifications have separate preferences.

**127.0.0.1** Electron checks used isolated Linux profiles. Three peers and two active transfers remained in place through all six theme switches at 1280×720 and 800×600. The full-host, restricted-peer and mixed-version checks covered current code with real 0.7.0 and 0.6.0 peers. The [desktop review report](docs/DESKTOP_REVIEW.md) lists the binary, commits, test totals, attachments, benchmarks and outstanding Windows checks.

**127.0.0.1** Two frozen-source Node runs each passed **371/371**. Direct and relayed 1 GiB retries were byte-identical. The frozen Windows x64 review executable `ASSCRACK-0.7.0-desktop-29d6dda.exe` is 106,789,665 bytes, SHA-256 `221e6682531f4fe6049d9dca12a5105a49f76402352ebf4319bbb53fac106005`, built from [`29d6dda`](https://github.com/noveblue53/asscrack/commit/29d6dda4e978521a38b6c8f807056537c826815d). Windows execution and qualifying game nights await the operator.

## Unreleased — field recovery and everyday room controls

The `work/0.7-field-recovery` review branch combines the three November 20 fixes with single-session dialing. A returning saved full node retries its verified endpoints, including when another room answers an old address. A cold host seeds its newest 200 eligible local rows. Clear and Forget remove deleted rows from pending replay while preserving later live traffic.

The room has a named file draft and explicit room or buddy send actions. A verified receipt marks a recipient Delivered. Older receivers show an unconfirmed send. The same room window offers live topics, typing preferences, nick and keyword highlights, per-buddy listening, peer details and a redacted activity feed.

**127.0.0.1.** All nine original fault checks failed on main and passed with the fixes. Two final Node 24.22.3 runs passed 321/321 with the corrected relay observer. The original observer returned 320/321 then 321/321. A Linux Electron upgrade from 0.7.0 reopened all 250 saved IDs and a late peer received exactly 51–250. The 0.6.0 upgrade preserved working hints and recovered only newly opted-in messages. A four-node alternate-relay experiment delivered fresh synthetic frames both ways in 39–42 ms across three runs. The terminal demos exchanged chat. Plain `npm start` exited 0 with zero app or renderer errors and four Linux environment diagnostics.

**Windows x64 review binary.** `ASSCRACK-0.7.0-review-c906a81.exe`, 106,748,791 bytes, SHA-256 `e0f9f9915e42bc6245c81a2bb21a70898d9f0ae19bc428d1e9d8b3f4f65eedfc`. The package was built on Linux from [`c906a81`](https://github.com/noveblue53/asscrack/commit/c906a81714808ca5bde46e6494c7bb6f53dad5bf). It retains app version 0.7.0. Windows 10 execution, the physical router lease and multi-computer voice checks await the operator. [Full results and changed files](docs/FIELD_RECOVERY_REPORT.md) · [Operator card 9](src/network/chatreadme.md)

## Unreleased — three fixes from the 0.7.0 internet test

The November 20 field test used the packaged 0.7.0 executable on three Windows computers. PC accepted
incoming TCP through UPnP. Brother and Laptop each connected directly to PC and used PC as their relay
to reach one another. Times below are UTC. The fixes are on `fix/0.7.0-internet-faults`, based on `de54371`.

| Fault | Evidence from the 0.7.0 field test | Change for review |
|---|---|---|
| Host election | Laptop lost its last session at 02:18:17 and claimed host at 02:18:20.874. Brother accepted at 02:18:22.795 and PC at 02:18:22.930. PC regained the role at 02:19:01.688. | A member that loses its last session clears its host and waits. After reconnect it gives the group time to announce its incumbent. Host ranking, term comparison and the three-field host message stay compatible with 0.6.0 and 0.7.0. An isolated legacy member can still originate a higher term. |
| UPnP lease | PC logged the initial mapping on port 55247 at 02:01:46. The field log gives no lease-expiry measurement. The low-level mapper defaults to 1,800 seconds, but the locked 0.7.0 wrapper supplied 7,200 seconds and scheduled its own refresh after 6,600 seconds. | The app requests 1,800 seconds, refreshes the same TCP mapping after 900 seconds, logs one `upnp renew-failed` line per failed attempt and retries. It disables the library timer, stops its own timer on shutdown and unmaps the port. |
| File delivery | For offer `bee7169b…`, PC logged sender `file-done` at 02:18:12.509. Laptop logged receiver `file-failed` with “stream ended” at 02:18:17.631. | An upgraded receiver advertises receipt support with `ack: 1` and confirms on chat after size and SHA-256 checks and the final save. Only then does the sender display **Delivered**. A failed transfer, lost session or 30-second receipt timeout displays **Failed**. An old receiver still gets the file and the sender displays **Sent (delivery unconfirmed)**. |

**127.0.0.1 results** on one Linux computer with Node 24.22.3. The test harness supplied loopback interface metadata
because the environment denies netlink enumeration. The fake-router suite also modeled a non-internal IPv4 interface
on that same loopback address. TCP, mDNS and fake-router HTTP traffic stayed on the computer.

- Against `de54371`, all seven new tests and both strengthened file-transfer checks failed. The same nine passed on the branch.
  The three-node regression cut Laptop's TCP and relay connections, waited past the host timeout and verified that it rejoined
  PC at the original term. The fake IGD saw the same ports and lease on retry after a failure, an unmap, and zero later map calls.
  Cutting the receiver's connection with unread bytes buffered produced sender failure. The tests also cover hash rejection,
  a missing receipt, a verified 50 MiB transfer, a legacy request and the window labels.
- A mixed room with 0.6.0 as full host, a 0.7.0 member and an updated member kept the host at term 1 across the updated member's
  disconnect and rejoin. File contents and subsequent chat were verified in both directions against both legacy source versions.
- The two terminal demos started with `--room t` and names `a` and `b`, discovered each other on loopback and exchanged one
  line in each direction.
- Four full `npm test` runs each passed 274 of 275 checks, including one run from a clean checkout. Each failure was
  `ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS` in `test/voice-direct.test.mjs`. Rerunning that file alone after each run
  gave 1/2, 2/2, 2/2 and 2/2, in order. Its test and stream limits are unchanged.
- `npm start` opened the login window with Electron 40.5.0 and exited normally after it closed. The developer console and app
  log had zero errors. The terminal showed four Linux environment errors involving the netlink socket, the udev monitor and two
  denied socket calls. The clean-terminal check remains open.

Windows 10 startup and the packaged executable remain unverified for this branch. The operator deferred LAN and internet
retesting, including failover on separate networks and renewal on a physical router.

## 0.7.0 (2026-11-20): portable build for a field test

File: `dist/ASSCRACK-0.7.0-portable.exe`, SHA-256 `ffae5423607ef2271c89719059742147ae064007ca22fa71d00632efaeb02034`. The test card is "Internet test card 8 (0.7.0)" in
`src/network/chatreadme.md`. All results of the features in this build are 127.0.0.1 results. This build has no field
result yet (no LAN result and no internet result).

Windows build (2026-11-20, this SHA-256): `npm run dist` on the Windows 10 PC of the operator (Node 24.13.1) from
commit `8dacddd` on `main`, 107,264,323 bytes. The source code is the same as the cloud build below. Use this file for
test card 8. The cloud build was not copied off its VM, thus it is not available. The two builds have different
SHA-256 values because a build is not byte-identical on a different machine.
- Install: `npm ci --ignore-scripts`, then `node node_modules/electron/install.js`. A usual `npm ci` stops with a
  `node-gyp` error for `better-sqlite3-multiple-ciphers`, because this PC has no Visual Studio. The package has its
  own `win32-x64` binary, thus it does not need a compiler.
- Full check (127.0.0.1): `npm test` 268 of 268 pass. The first run had 7 failures in `test/room-archive.test.mjs`.
  The cause was the test cleanup: it deleted the temp folder before it closed the database, and Windows cannot
  delete an open file. The test now closes first. The app code did not change.
- One app start with `npm start` and one start of the portable .exe: no error line in the terminal or the app log.
  The .exe log has "Saved rooms archive opened: state open".

Cloud build (replaced): `npm run dist` on a Linux cloud VM (no Wine) from commit `03679f7`, 106,728,631 bytes,
SHA-256 `327a7f71f644e3dbfde6b37bd6aac2ce7328a8d94061aab27e613d862f5cab3a`. The package has the
`win32-x64` native files of `better-sqlite3-multiple-ciphers` and `uiohook-napi` in `app.asar.unpacked`. Full check
(127.0.0.1): `npm test` 267 of 268 pass. The failure is the known intermittent test in `test/voice-direct.test.mjs`.
The branch changes no source code against `main`. One app start: no error line in the app log.

This release contains these "Unreleased" entries:
- **Live chat and the archive agree, milestone 6 part 2:** local-only sends, saved marks, Clear, Forget and older lines.
- **Saved rooms, milestone 6 part 1:** saved internet rooms with an encrypted local history and Reopen room.
- **Voice processing and push-to-talk, milestone 5C:** noise suppression, voice activity, push to talk and Voice settings.
- **Manual status, milestone 3:** Available, Away or Do not disturb, with a note.
- **Voice processing added to the 1.0 plan:** the plan section 5C. No code change.
- **Quote and Find on main, the 1.0 work plan and a new README:** the merge of Quote and Find, and the plan.
- **Milestone 2 fixes, quote boundary and Quote button:** the quote header with a line count, and the Quote button.
- **Milestone 2, Quote and Find:** Quote a line, and Find with Ctrl+F.
- **Room window, milestone 1:** saved panel sizes, the reading position and context menus.
- **Faults of 0.6.0:** the invite panel, the second start, voice start, history, direct voice, dial warnings and the
  status line.

## Unreleased: live chat and the archive agree, milestone 6 part 2 (on main)

The operator accepted branch `opus/saved-rooms-2` on 2026-11-20 without the LAN checks. Base: `main` at `5982914`. All results in this entry are 127.0.0.1 results on a Linux cloud VM (Node 24.22.3,
Electron 40.5.0 under Xvfb, `safeStorage` backend `gnome_libsecret`). There is no LAN result, no internet result and
no packaged .exe result yet.
- **Local-only send:** when no peer accepts a send, the line has the text "Only on this computer". The node does not
  put it in its history, thus a host replay does not send it to a peer that joins later. The app does not save it.
  Before this change, a host replay sent such a line later.
- **Saved mark:** each line that the archive of this computer has gets a small check mark with the title "Saved on
  this device". A write that fails (for example a full disk) gives no mark and the text "Not saved: <reason>".
- **Live lines after a replay:** a live line that a host replay showed first is now saved one time. A new node event
  `live` comes for each valid live line. The `message` event did not change.
- **Room storage controls:** a saved room has the box **Keep local history** and the button **Clear saved history
  on this device**. Saving off keeps the saved lines and stops new saves, also after a restart. Clear deletes the
  saved lines of the room and keeps the room and its saving choice. On the login screen, **Forget room** deletes the
  saved invite, the lines, the saving choice and the saved addresses of the room. Clear and Forget explain the local
  effects and ask before they delete.
- **Older lines:** a reopen shows the newest 200 saved lines. A scroll to the top loads 100 older lines each time.
  The line that you read stays at its place.
- **Limits for each room:** at most 10,000 saved lines and 8 MiB of text. Each line can have at most 64 KiB. The app
  deletes the oldest lines first.
- **Node option `seedHistory`:** records that the node puts in its history at start. Two tests use it now, because a
  send with no peer stays local. The app does not use it yet (part 3, the replay seed).
- Results (127.0.0.1):
  - `npm test`: 267 of 268 pass. The failure is the known intermittent `test/voice-direct.test.mjs` failure
    (`ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS`). The same file failed 1 of 5 runs on the base and 1 of 5 on the
    branch.
  - Electron check script, 2 profiles, 18 of 18 checks pass:
    - 250 numbered lines, each one time on each copy, and 250 saved marks
    - a reopen with 200 lines, then 50 older lines
    - a local-only line, saving off and on, and Clear
    - Forget on one computer, while the other computer keeps its room
  - One app start: no error line in the app log, the terminal or the developer console. `test/rejoin.test.mjs`: 3 of
    3 pass.
  - Terminal demo: one line in each direction through mDNS. With a typed address, mDNS can find the peer at the
    same time. Then the explicit dial can fail. Base: 2 of 6 pass. Branch: 2 of 6 pass. This is not new.
- Open checks: the packaged Windows checks of part 1, and the release checks of part 4 (two Windows PCs on different
  networks). Part 3 (replay seed, refreshed invites, frame bounds) is the next goal.

## Unreleased: saved rooms, milestone 6 part 1 (on main)

Base: `main` at `598725f`. All results in this entry are 127.0.0.1 results on a Linux cloud VM (Node 24.22.3,
Electron 40.5.0 under Xvfb, `safeStorage` backend `gnome_libsecret`). There is no LAN result, no internet result and
no packaged .exe result yet.
- **Save room on this device:** for an internet room (invite or new room), with a visible **Keep local history**
  choice. The login screen lists the saved rooms. **Reopen room** shows the saved lines at once, then connects in the
  background. **Waiting for a peer** shows until an authenticated session opens.
- **Encrypted local storage (new):** the saved rooms and lines are in a SQLCipher 4 database under the profile
  (`saved-rooms/archive.db`). A random profile key opens it. Electron `safeStorage` protects that key (DPAPI on
  Windows). A missing key or a key that does not unwrap gives a locked state with **Try again**. There is no
  plaintext fallback. With no protected storage, the app saves no room.
- **Encrypted peer connections (not new):** Noise encrypts each peer connection, as before. Encrypted local storage is
  a different thing: it protects the saved lines on the disk of this computer only.
- The app saves each own line that a peer accepted and each live received line, one time for each (room, message ID).
  It does not save host replay. The node gives one ID and time for each send, and the window and the archive use it.
  The wire format did not change.
- New dependency: `better-sqlite3-multiple-ciphers` 13.2.0 (MIT, N-API prebuilds). `"npmRebuild": false`.
- Results (127.0.0.1):
  - `npm test`: 218 of 218 pass. `test/rejoin.test.mjs`: 3 of 3 pass.
  - Electron check script, 2 profiles: save a room, send and receive, close all processes, reopen with no peer and
    read the lines. A second saved room with the same room name and user name and a different key shows only its
    own line. 11 of 11 checks pass. The hosts typed `127.0.0.1:<port>`, thus the check does not cover UPnP.
  - One app start: no error line in the app log or the developer console. The terminal has 5 VM lines (D-Bus,
    `NODE_OPTIONS`). The base commit has the same 5 lines.
  - `test/voice-direct.test.mjs` fails some of the time on the base commit too (4 of 5 runs). Not caused by this work.
- Open checks (packaged Windows, not done): the .exe reports a SQLCipher version (`sqlite3mc_version()`). A restart
  with no network reads the saved line. The profile stays after the .exe moves. A different Windows account cannot
  read the archive. The build on a Windows PC with `"npmRebuild": false`.

## Unreleased: voice processing and push-to-talk, milestone 5C (on main)

The operator asked for the merge of branch `opus/voice-processing` on 2026-11-19, before the test on 2 computers.
Base: `main` at `c42baf5`, then `main` at `598725f` (manual status) merged in. All results in this entry are
127.0.0.1 results on one Windows 10 PC (Electron 40.5.0). There is no LAN result and no internet result yet.
- **Echo cancellation:** the capture asks for echo cancellation, noise suppression and automatic gain control
  explicitly, and logs the values of `track.getSettings()`. A measurement with 2 virtual audio cables showed that
  the echo canceller of Chromium uses the playback worklet as its reference. On a 48 kHz cable the echo was about
  64 dB lower. A control from a second process gave 0.4 dB less. Thus no fix was necessary. This is a digital
  loopback, not an acoustic echo through speakers.
- **Noise suppression:** RNNoise (`@sapphi-red/web-noise-suppressor` 0.4.1, new dependency, operator approval)
  works in an AudioWorklet after the noise suppression of Chromium. The panel has RNNoise (default), Standard
  (Chromium only) and Off. Measured on a steady white hiss: Off -33 dBFS, Standard -50 dBFS, RNNoise -70 dBFS.
  Speech loses 1 to 2 dB. A synthetic keyboard click test showed only 2 to 4 dB less. The CSP of the window now has
  `'wasm-unsafe-eval'` for the RNNoise WASM.
- **Voice activity:** a send gate after the noise suppressor. Default: voice activity at -50 dBFS with a 300 ms
  release delay. Before, the microphone sent all the time. A closed gate sends no frames, the same as Mute, thus the
  relay and 0.6.0 peers need no change. The own buddy line shows "speaking" while the gate is open.
- **Push to talk:** a key or a side mouse button that the user sets, with a release delay. The option "Also when
  ASSCRACK is in the back" is on by default. Then a key hook of the system gives the key also while the window is
  not in front. The hook is `uiohook-napi` 1.5.5, a new dependency with operator approval. The hook runs only while
  the user is in voice in push-to-talk mode. It sends only the state of the one key, and it logs no key.
- **Voice settings panel:** a "Voice settings" button opens the panel. It has the mode, a live input meter with the
  threshold line, the release delays and the key. It also has echo cancellation, noise suppression, gain control,
  microphone and speakers. The settings are in `voice-settings.json` in the profile and stay after a restart.
- **Build:** `npmRebuild` is false. `uiohook-napi` has N-API binaries, and the build PC has no compiler for a
  rebuild. The packaged app loads the Windows binary.
- **Checks (127.0.0.1):**
  - `npm test`: 221 of 221 pass (198 on `main` and 23 new tests for the gate, the settings store and the key hook).
  - Two app copies in one LAN room on one PC. Voice activity sends about 8,000 bytes in 3 s above the threshold
    and nothing below it. Push to talk sends only while the key is down, and nothing after a window blur in
    window-only mode. Push to talk through the key hook sends only while a synthetic F24 key is down. Do not disturb
    does not change mute, voice activity or push to talk.
  - Packaged build and the 0.6.0 build (`d5ad3af`) in one room: frames go in both directions. While the new client
    has a closed gate, it sends 0 bytes and the 0.6.0 window shows it as "in voice". A normal close with the key
    hook on: the process exits in 0.3 s.
- **Open checks:** the test card on 2 Windows computers with speakers: echo, noise, push to talk in the back, and a
  0.6.0 client. A known limit: after a join with a synthetic hiss, RNNoise removed more than the standard
  suppressor in 2 of 3 joins only.

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
