# Changelog

This file gives the progress of ASSCRACK, one entry for each feature or release. The newest entry is at the top.

Each result has one of these labels:
- **LAN**: a test on 2 or more computers on one real local network.
- **127.0.0.1**: a test on one PC only. It does not prove that the feature works on a LAN.
- **internet**: a test on 2 computers on different networks, for example a home router and a phone hotspot.

## 1.0.5 (2026-11-23): times for the join and leave lines, the music visualizer and the installs badge

Release 1.0.5 is the fifth update of 1.0.0. A 1.0.0, 1.0.1, 1.0.2, 1.0.3 or 1.0.4 app gets it with the signed update
(View, About ASSCRACK, Check now). The entries below this heading, down to the 1.0.4 entry, were "Unreleased"
entries. Each entry gives its changes and its checks. Since 1.0.4, the app has these new items:

- The lines "<name> joined the room." and "<name> left the room." show their time. A saved room that keeps history
  keeps these lines after a restart.
- Room music has a visualizer: an LED spectrum in the music bar, or a VU meter. The bar can collapse to a strip, and
  the player can open in its own window.
- The README badge "installs" counts only the downloads of the `-setup.exe` and `-portable.exe` files. The updater of
  1.0.5 downloads a copy of the file that has an other name.

Build:
- `npm run dist` makes `ASSCRACK-1.0.5-portable.exe` (product name "ASSCRACK Portable"). `npm run dist:installer`
  makes `ASSCRACK-1.0.5-setup.exe` (product name "ASSCRACK").
- The release has six files: the two files above, their download copies `ASSCRACK-1.0.5-update.exe` and
  `ASSCRACK-1.0.5-portable-update.exe` (the same bytes), `update.json` and `update.json.sig`. See
  `docs/RELEASE_UPDATES.md`.
- The source of the files is the commit of this entry. The signed `update.json` of the release gives the byte size
  and the SHA-256 of each file. The files have no code signature.
- No new dependency.

Results:
- **127.0.0.1 and this PC only.** Each entry below gives its results with their labels.
- `npm test` of the integrated source ran in a fresh worktree after `npm run install:clean`. Result: 1193 tests,
  1175 pass, 0 fail, 18 skipped (127.0.0.1).
- One earlier full run of the same source had 1 fail in `test/diag-knock.test.mjs`. The test took 1111 ms. It read
  the journal file before the timed journal write (each 1 s) was complete. This test file passed 5 of 5 times alone,
  and the next 2 full runs passed. The three branches do not change the journal or the network code.
- **this PC** (copies of `electron .` with `--profile`, rooms on 127.0.0.1 and the LAN address of this PC):
  - One start with a fake APPDATA: no error line.
  - The voice regression: 16 of 16 tests, and `voice-check.mjs` with the expected byte counts.
  - Three copies with a fake APPDATA. Priya became a friend of Mira. Then Priya knocked over the friend link, and
    Mira selected Allow. Jonas joined with a device invite. Each copy showed 3 people and got each of the 6 chat
    lines.
  - The join and leave lines: the copy of Mira showed 4 lines with their times. The lines were "Jonas joined the
    room.", "Jonas left the room.", "Jonas reconnected." and "Priya left the room.". Then Mira and Jonas did a quit
    and a reopen. Each copy showed its saved lines in the same order with the chat lines. No copy showed "Connection
    lost.".
  - Known limit, also in 1.0.4: a member that comes in after a knock over the friend link gives no "joined the room."
    line.
  - Room music with a local test file (no YouTube): the visualizer of the listener moved in the bar. It also moved as
    a VU meter in the collapsed strip, and in the pop-out window. Pop in closed the window.
  - The update path: a key of the check, two files of random bytes and `tools/update-test-server.mjs`. The updaters
    of 1.0.0 to 1.0.4 accepted the manifest with `download`. They downloaded the `-setup.exe` or `-portable.exe`
    file. The updater of 1.0.5 downloaded the `-update.exe` or `-portable-update.exe` copy. It kept the file with its
    normal name. Each file had the size and the SHA-256 of the manifest.
  - Before and after each run, the Start menu shortcut and the toast registration of the installed copy on this PC
    had the same values.
- No LAN test and no internet test occurred.

### The installs badge counts installs, not update checks (1.0.5)

The download badge of README.md counted each file of each release. Of 62 downloads on 2026-11-23, 46 were
`update.json` and `update.json.sig` (2 for each update check of a running app), and some were installer downloads of
the updater. The new badge "installs" counts only the `-setup.exe` and `-portable.exe` files.

- New workflow `.github/workflows/installs-badge.yml`: each day and after each published release, it adds the
  downloads of the `-setup.exe` and `-portable.exe` files of all releases that are not drafts
  (`tools/installs-count.mjs`). It writes `installs.json` (shields.io endpoint JSON) on the branch `badges`. The branch
  has only that file. The count job can only read. Only the publish job can write.
- `tools/sign-update.mjs` writes a download copy of each file: `ASSCRACK-<v>-update.exe` and
  `ASSCRACK-<v>-portable-update.exe` (the same bytes). The signed manifest gives the copy name in `download`. The
  updater downloads the copy and keeps the file with its normal name. A release has six files now
  (`docs/RELEASE_UPDATES.md`).
- The 1.0.1 to 1.0.4 clients ignore `download` and download the `-setup.exe` or `-portable.exe` file. Thus their
  first update still counts as an install. A change of `name` in the manifest is not possible: these clients refuse
  a manifest with an other `name`.
- **127.0.0.1**: the count of the real API on 2026-11-23 is 16 (12 installer, 4 portable). The released
  `update-manifest.mjs` of v1.0.1 and v1.0.4 accepts a manifest with `download` and gives the `-setup.exe` name.
  `npm test` on this PC: 1160 tests, 1142 pass, 0 fail, 18 skipped. No LAN or internet test.

### Times and saved history for the join and leave lines (1.0.5)

- Request (operator 2026-11-23): the lines "<name> joined the room." and "<name> left the room." must show a time and
  stay in the chat after a restart. Before this change, these lines of G2 had no time and the app did not save them.
  G2 gives a line for a join, a leave, a lost connection and the own reconnection.
- Each of these lines now shows its time in the same style and place as a chat line. The time is after the text, and
  in the time column of the compact transcript. The tooltip gives the full date and time. The own link lines are now
  "Connection lost." and "Reconnected." because the time column gives the time. The day rows do not change.
- A saved room that keeps history saves these lines in its encrypted archive, in the new table `room_notes`. They are
  local events of this PC. The app does not send them, and they are not in the host replay. A host replay cannot
  make a copy of them. On a reopen, the lines come back in time order with the chat lines, also with the paging of
  older lines.
- A leave or a lost connection, and a rejoin of the same person in 60 s, become one line "<name> reconnected.". In a
  protected room the person is the device mark (an app restart gives a new peer ID). In an old shared-code room the
  person is the name.
- Each room keeps at most 500 of these lines. The oldest line goes first. Clear history and Forget delete them.
- No own join line and no own leave line. Each start and quit would add two lines with no new fact. The day row and
  the times show when the own session started. The app saves the own "Connection lost." and "Reconnected." lines:
  they explain a gap. The app does not save "Connection lost." at a Quit or a Leave room.
- The archive keeps `user_version` 3. 1.0.4 opens an archive of this build and does not show the new lines. Known
  limit: Clear history in 1.0.4 does not delete these lines. Forget in 1.0.4 deletes them.

Results:
- `npm test` (127.0.0.1): 1165 tests, 1147 pass, 0 fail, 18 skipped. `test/presence-lines.test.mjs` (new, 15
  tests): 15 fail on 1.0.4 (`d664ef8`) and 15 pass with the change.
- Archive compatibility (this PC, `room-archive.mjs` of 1.0.4 and of this build): an archive of 1.0.4 opens with this
  build and takes new lines. An archive of this build with lines opens in 1.0.4. 1.0.4 shows and replays only the chat
  lines, and its Clear and Forget work.
- **this PC**, not a LAN result. Two copies of `electron .` ran with `--profile` and their own `APPDATA`, in a
  protected LAN room on this PC, with CDP on 127.0.0.1:
  - 1.0.4 made the room and the archives. This build reopened them with no problem.
  - A showed "Jonas left the room." with a time when B quit. B started again and reopened in 15 s: the line changed
    to "Jonas reconnected.". B showed "Mira left the room." when A quit.
  - Both quit and reopened: each copy showed its saved lines in time order with the chat lines. No "Connection
    lost." line from the own quit.
  - 1.0.4 reopened the archive of this build: the chat lines with no error. This build then reopened it again with
    its lines.
  - One start with a fresh profile: no error line. No ERROR line in the main logs of the runs. Before and after the
    runs, the Start menu shortcut and the toast registration of the installed copy on this PC had the same values.
- No LAN test and no internet test occurred.

### The music visualizer, and collapse, pop-out and hide for the music player (1.0.5)

Operator design of 2026-11-23. The changes are in `src/application/` only. There is no change in `src/network/` and
no new network traffic.

- Visualizer: an LED spectrum of 16 bands (bass to treble) with 14 LEDs each band. The LEDs are green, yellow, orange
  and red from the bottom up. A white peak cap holds for 0.3 s and then falls. The collapsed bar shows a stereo VU
  meter (two LED columns with the same colors and peak caps).
- The source is the music on this PC before the music volume: the DJ's local playback, or the stream of the DJ at a
  listener. Thus the bars move at each volume, also at 0 %. The analysers are in the audio graph of the room window
  (`music.js`). The pop-out window has no audio: for each frame it asks the room window for 18 bytes through the main
  process.
- The draw loop has a maximum of about 30 frames each second. It runs only while the canvas is on the screen and
  music plays on this PC. It stops when the bar is not shown, or when the window is not on the screen
  (minimized, hidden, or fully under other windows). It also stops with the setting Off and when the music pauses
  or stops. A deafened listener has no music, thus the pop-out window asks the room window again only one time
  each second.
- New setting in the bar and in the pop-out window: Visualizer Spectrum, VU or Off. The LED colors do not change. The
  dark panel has the accent color of the theme.
- Collapse (the button at the right of the bar) folds the bar to a strip: the VU meter, now playing, Pause and Skip.
- Pop out opens the player in its own window: the queue, the controls and the large visualizer. There is one window
  at most. The window keeps its size and position (`music-window.json`), follows the theme and closes at Leave room,
  with the room window and at Quit. While it is open, the bar of the room window is a strip.
- View > Music player hides the bar. A "Music: <track>" mark in the status bar shows it again.
- `music-settings.json` keeps the visualizer, collapse, hide and pop-out for each profile. A close of the pop-out
  window by the user clears the pop-out value. A close at Leave room or at Quit keeps it. The window then opens again
  at the next join of voice.

Results:
- New tests: `test/music-viz.test.mjs` has 15 tests. They check the band mapping, the peak caps, the LED colors, the
  VU level, the frame and the draw loop. They also check the room bar and the pop-out window in the fake DOM. `test/music-popout.test.mjs`
  has 3 tests: the window rules, the bridge and the settings. On the base `d664ef8` they fail (the modules and the
  settings fields are not there). The test of the pop-out window with no music on this PC came after the first
  commit of this branch. It fails on that commit (the pop-out window asked 30 times each second) and passes now. Two tests had a fixed list of the settings fields:
  `test/music-media.test.mjs` and `test/music-source.test.mjs` now include the new fields.
- `npm test` (127.0.0.1): 1168 tests, 1150 pass, 0 fail, 18 skipped.
- **this PC, 127.0.0.1**, two copies of `electron .` with `--profile`, a fake APPDATA and outputs on the Steam
  Streaming Speakers. A is the DJ with a local test file, B is a listener:
  - The bars move on both copies (16 bands, values of the analysers and lit pixels of the canvas). At a volume of 0 %
    the bars of B still move. When B is deafened, the pop-out loop and the room loop stop. They start again after
    the undeafen.
  - Collapse: the strip with the VU meter, saved in the settings. Pop out: one window with the large spectrum, the
    bar is a strip, Pause and Play from the window work. With the room window minimized, the room loop stops and the
    pop-out window still moves. Pop in closes the window and clears the setting. View > Music player hides the bar,
    the mark shows the track, and a click on the mark shows the bar again. After Stop, the loops of A and B stop.
  - CPU (all processes of one copy, % of one core, 10 s each): in voice with no music 4.1 (A) and 4.9 (B). Music
    with Spectrum in the bar 14.4 (A) and 13.5 (B). Music with Off 7.9 (A) and 6.7 (B). Thus the bar visualizer
    costs about 6 to 7 % of one core (about 3 % renderer and 3 to 4 % GPU). Values of B: the collapsed VU 13.2, the
    pop-out window open 18.9, the bar hidden 6.0, deafened with the pop-out window open 4.6. The room window
    minimized with the pop-out window open: 12.5.
  - The check starts the copies with `--disable-features=CalculateNativeWinOcclusion`: other windows of this PC can
    cover the test windows, and Chromium then stops the loop. A first run without this option showed that stop.
  - Console and terminal: no error line. One more start of `electron .` with a fresh `--profile` and a fake APPDATA
    (no other test option), a LAN room and voice: no error line.
  - The Start menu shortcut and the toast registration of the installed copy on this PC had the same values before
    and after the runs.
- No LAN test occurred.

## 1.0.4 (2026-11-23): room music, a full-screen share with no border, automatic Away and the history thumbnails

Release 1.0.4 is the fourth update of 1.0.0. A 1.0.0, 1.0.1, 1.0.2 or 1.0.3 app gets it with the signed update (View,
About ASSCRACK, Check now). The entries below this heading, down to the 1.0.3 entry, were "Unreleased" entries. Each
entry gives its changes and its checks. Since 1.0.3, the app has these new items:

- Room music: the DJ of a voice channel plays YouTube links and local files to the members of the channel. Each
  listener sets a music volume, and the music goes lower while someone talks.
- On Windows 10, the share of a window that fills a screen now shares the screen, with no yellow border. The viewers
  see "Paused" while that window is not in front.
- Automatic status: Away after 5, 10 or 15 minutes with no input, and an option for Do not disturb during a
  full-screen game.
- A fix: the history of a saved room shows its thumbnails again after a reopen.

Build:
- `npm run dist` makes `ASSCRACK-1.0.4-portable.exe` (product name "ASSCRACK Portable"). `npm run dist:installer`
  makes `ASSCRACK-1.0.4-setup.exe` (product name "ASSCRACK").
- The source of the two files is the commit of this entry. The signed `update.json` of the release gives the byte size
  and the SHA-256 of each file. The files have no code signature.
- New dependency: `youtubei.js` 18.3.0 (MIT).

Results:
- **127.0.0.1 and this PC only.** Each entry below gives its results with their labels.
- The integrated source (`npm test` in a fresh worktree after `npm run install:clean`): 1150 tests, 1132 pass, 0
  fail, 18 skipped (127.0.0.1).
- **this PC** (copies of `electron .` with `--profile` and a fake APPDATA, rooms on 127.0.0.1 and the LAN address of
  this PC):
  - One start with no error line.
  - The voice regression: 16 of 16 tests, and `voice-check.mjs` with the expected byte counts.
  - Three copies: knock and Allow two times, each copy shows 3 people and gets each of 6 chat lines.
  - Room music with three copies: a local file and one YouTube video (Big Buck Bunny, CC BY). Each listener got 128
    kbit/s. Voice from a listener came to the two other copies while the music played. Pause, Play, Skip and the
    chat commands worked.
  - The history thumbnails: after a quit and a reopen of the two copies, each copy showed the 3 thumbnails. While the
    sender was offline, its card said "Sender offline. Try again". When the sender came back, the card showed the
    thumbnail with no click.
  - The share of the full-screen test window started as a screen share and stayed paused. Windows did not give the
    foreground to the test window, thus the guard did not show the screen. The viewer got only the "Paused"
    picture. The return of the picture after a pause was not checked on this PC.
  - The automatic Away came 1.8 s after login with `--auto-away-ms 15000`.
  - Before and after each run, the Start menu shortcut and the toast registration of the installed copy on this PC
    had the same values.
- Changes in `src/network/`: `attachment.mjs` and `node.mjs` (the stored thumbnails; a thumbnail request has no
  30-minute limit), `music.mjs` (new), `node.mjs` and `voice-relay.mjs` (the music streams). New items on the
  network: the music line, the protocols `/asscrack/music/1.0.0` and `/asscrack/music-direct/1.0.0`, and the field
  `musicDirect` of the voice line.
- Known failures: the same as 1.0.3 (check 19 of P8b, check 18 of P8a, the timed screen check 16 of
  `test/screen-auto.test.mjs`). The runs of `npm test` for this release had 0 failures.
- No LAN test and no internet test of 1.0.4 occurred.

### Thumbnails of the history after a room reopen (1.0.4)

- Fault (operator report 2026-11-23, installed 1.0.3, real use): after a reopen of a saved protected room, the image
  cards of the history showed no thumbnail. A click on "Show thumbnail" did nothing that the user could see. This
  occurred for received images and for own images.
- Cause: the app kept each thumbnail only in memory (`src/application/room-media.mjs`, the cache of
  `createRoomMedia`). After a quit or a Leave room, the cache was empty and `asscrack:media-info` gave no thumbnail.
  The sender kept its preview source only in memory (`src/network/attachment.mjs`, `sources`). The source ended
  after the 30 minutes of the offer or at a quit. Also, the peer ID of the sender is new at each start. Thus no copy
  could give the thumbnail again. When the request failed, `paint` in `chat-media.js` did not change the card, thus
  the click was silent.
- Not a regression of 1.0.x: the same check on 1.0.0 (`af40267`), 1.0.1 (`cfa4e27`), 1.0.2 (`92b9f74`) and 1.0.3
  (`181f431`) gives the same result. Since the first media cards (`a00033a`), thumbnails were in memory only.
- Fix:
  - The encrypted room archive (`archive.db` in the data folder of 1.0.1) has a new table `message_thumbnails`. It
    keeps the checked preview PNG of each archived image card of a room that keeps history: own posts and received
    images. The limits are 512 KiB for each PNG and 32 MiB for each room. The oldest PNG goes first. The PNG goes
    with its card (Clear history, Forget, the room limits). "Clear thumbnail cache" also deletes the stored
    thumbnails of the room. The archive keeps `user_version` 3, thus 1.0.3 can still open it.
  - When the window asks for a card, the main process loads the stored PNG. It checks the PNG again with the wire
    rules (`inspectImage`). The history shows the thumbnail with no network request.
  - A sender gives the stored thumbnail of its own post after a restart or after the 30 minutes of the offer. The
    receiver sends the request to the session peer with the proved device ID of the line. In a protected room, the
    line ID starts with that device ID. The pair of line and card comes from the archive. The archive keeps only
    checked live lines and own lines.
  - The card tells the user why it has no thumbnail. "Loading thumbnail…": a request runs. "Sender offline. Try
    again": no session of the sender is open. "Thumbnail unavailable. Try again": the sender has no thumbnail, or the
    card is an own post with no stored thumbnail. When the device of an offline sender is back, the card asks again
    with no click.
  - Protocol change: the preview request has no 30-minute limit now. An old sender (1.0.3 or older) still refuses a
    request after the 30 minutes.
- "Original unavailable" on a received image while its sender is online is not a fault. The offer of an original is
  in the memory of the sender. It ends after 30 minutes or at a quit of the sender. No change.
- Known limits: images of a history from 1.0.3 or older have no stored thumbnail. They show "Thumbnail unavailable.
  Try again", or the thumbnail of a saved original. A room with no membership has no device ID in the line ID. In
  such a room, a request goes only to the peer ID of the post. Some lines are not in the archive: lines of a host
  replay, and lines of a room that does not keep history. Such a line does not use the device route. After a restart
  of its sender, its card says "Thumbnail unavailable. Try again".

Results:
- `npm test` (127.0.0.1): 1095 tests, 1077 pass, 0 fail, 18 skipped. `test/history-thumbnails.test.mjs` (new,
  10 tests): 9 fail on 1.0.3 and 10 pass with the fix.
- **this PC**, not a LAN result. Two copies of `electron .` ran with `--profile` and their own `APPDATA`, in a
  protected LAN room on this PC, with CDP on 127.0.0.1. Each side posted an image (a file and a pasted image). Both
  quit. Then:
  - Both reopen, both online: each copy shows the 3 thumbnails from its archive (3 of 3 `room-media` requests 200).
  - A reopens alone: A shows the 3 thumbnails. After "Clear thumbnail cache" and a click on each card, the card of B
    says "Sender offline. Try again". The own cards of A say "Thumbnail unavailable. Try again". B starts and
    reopens with a new peer ID. A then shows the thumbnail of B with no click.
  - The history of a 1.0.3 run, reopened with the fix: each card says "Thumbnail unavailable. Try again".
  - The same offline case 32 minutes after the posts (after the 30 minutes of the offers): the same result. B gives
    its stored thumbnail after the 30 minutes.
  - An archive with stored thumbnails opens in 1.0.3 (`room-archive.mjs` of `181f431`). Clear history and Forget in
    1.0.3 also delete the stored thumbnails.
  - One start with a fresh profile: no error line. The reopen runs: no ERROR line in the main logs. Before and after
    each run, the Start menu shortcut and the toast registration of the installed copy on this PC had the same values.
- No LAN test and no internet test occurred.

### Share of a full-screen window with no yellow border (1.0.4)

- Request (operator, 2026-11-23): the yellow capture border of Windows 10 on the share of a World of Warcraft window is
  "too much". Electron 45 captures a window of another program with Windows Graphics Capture. On Windows 10 that border
  cannot be turned off. A screen share uses DXGI and has no border (1.0.3 entry).
- Change: on Windows before build 20348, Share of a window that fills a screen now shares that screen. There is no
  extra click. The share bar shows the window name. The viewers see the same text as before ("<name>'s screen").
- The main process makes the decision. The thumbnail size gives only the aspect ratio: a 1280 x 720 window has the
  thumbnail of a 2560 x 1440 screen. Thus a helper process (below) gives the rectangle of the window and of its
  monitor in physical pixels. The share uses the screen only when the window covers all of one monitor, and the
  `display_id` of exactly one screen source agrees. Else the share is the window share, with the border.
- Guard: the viewers get a "Paused" picture, never the screen, in each of these conditions:
  - The chosen window is not in front.
  - The user minimized or closed the window, or the window is not visible.
  - The window moved to another monitor, or it does not cover its monitor.
  - The helper sent no state for 1.5 s, the helper ended, or the helper cannot start.
- The share starts paused. A pause starts at once. The screen shows again only after the window stays in front for
  300 milliseconds. The captured frames of a paused share do not go to the encoder. The kept frame of rule E5 is the "Paused"
  picture. Thus a keyframe request and a refresh tick also send "Paused".
- Helper: one `powershell.exe` (`-EncodedCommand`, no window), started only for such a share and stopped at its end.
  It compiles a few lines of C# with `Add-Type` and runs a loop in that code. A WinEvent hook starts the loop at each
  foreground change and at each minimize. A poll each 250 ms reads the other states (`GetForegroundWindow`,
  `IsIconic`, `IsWindowVisible`, DWM cloak, `GetWindowRect`, `GetMonitorInfo`). It ends by itself when the app process ends.
  No new dependency. The log has no window name and no window handle.
- The picker shows "No border. Paused when not in front." and a "Share with border" link. The link shares the window
  itself, with the border and with no guard.
- Known effect: with two monitors, a click in the app on the other monitor makes the app the foreground window. The
  viewers then see "Paused" until the shared window is in front again.
- Files: `src/application/win-helper.mjs` and `share-guard.mjs` (new), `screen-sources.mjs`, `screen-share.js`,
  `main.js`, `preload.cjs`, `index.html`, `screen.css`.
- **127.0.0.1**: `test/share-guard.test.mjs` has 11 new tests: the window to screen mapping, the pause rule, the
  guard lifecycle, the helper process and its end with the parent. `test/screen-sources.test.mjs` has 2 new tests.
  `test/screen-ui.test.mjs` has 3 new tests:
  - Share of the window gives the screen.
  - "Paused" goes out at the start and at each pause, as a keyframe.
  - No captured frame goes out while paused.
- These tests fail on 1.0.3. The tests of `pick` now use `await`, because
  `pick` is async (it waits for the helper). The test of the 1.0.3 "Share screen" button now checks the new behavior.
  The preload test checks the new third argument of `pickScreenSource`.
- **this PC** (two app copies with `--profile` and a fake `APPDATA`, a LAN room on this PC). The test window was a
  WebGL window of 2560 x 1440 of a separate test program. Share of the test window gave the log line
  `screen capture request granted kind=screen from=window` in 0.5 to 1.2 s. The viewer got frames. The test window
  could not become the foreground window: Windows refused the focus of the test program, because another program was
  in front. Thus the guard kept the share paused for the full run (reason `background`), and the "resume" part did not
  occur. The viewer got only the "Paused" picture: 96 of 96 sent frames were "Paused", and 0 of about 5 290 captured
  frames left the sharer. The capture ran at 58 frames/s. "Paused" went out at about 1 frame/s (the refresh
  ticks). The helper used 16 ms of CPU in 60 s (0.03 % of one core) and 70 MB of memory. It ended at the stop of the
  share. "Share with border" gave `kind=window` with no helper.
- **this PC**, the helper alone on the own small test window. A minimize was in the helper output after 2 to 4 ms
  (the hook, 10 of 10). A hide was in the output after 205 to 223 ms (the poll, 10 of 10). The foreground change
  uses the same kind of hook as the minimize. This check has no end-to-end pause time (see above).

### Automatic status (1.0.4)

- Request (operator, 2026-11-23): "detect desktop activity to set automatic status", non-invasive.
- Change: Away after no keyboard or mouse input for 5, 10 or 15 minutes (default 10), or Off. The app reads only
  `powerMonitor.getSystemIdleTime()`, each 20 s. While the automatic Away is on, it reads it each 2 s. Thus Available
  comes back soon after the next input. Away also on the lock screen and in sleep. Available again at unlock, or at the
  next input after a resume.
- No automatic Away in voice. A join of voice ends the automatic Away. Off also stops the Away on lock and sleep.
- The rule changes only Available to its own Away (or Do not disturb, below) and back. A status that the user sets
  (Away, Do not disturb, Idle Peer, or a new choice while the automatic status is on) stays. The status note stays.
  The automatic change goes the same way as a choice of the user: the room, the friends, and the status menu.
- Option, off by default: Do not disturb while a full-screen game or a presentation runs
  (`SHQueryUserNotificationState`: `QUNS_BUSY`, `QUNS_RUNNING_D3D_FULL_SCREEN`, `QUNS_PRESENTATION_MODE`). A helper
  process of the same kind polls each 2 s at below normal priority, only while the option is on.
- The settings are in the dialog "Your availability" and in `auto-status.json` of the profile. The journal gets one
  line of type `status` for each change: `auto-away`, `auto-dnd` or `auto-back`, with a reason code only (no input
  data, no time). A dev start can use `--auto-away-ms <ms>` for a check (not in a packaged build).
- Files: `src/application/auto-status.mjs` and `auto-status-ui.js` (new), `main.js`, `preload.cjs`, `renderer.js`,
  `journal.mjs`, `index.html`, `styles.css`.
- **127.0.0.1**: `test/auto-status.test.mjs` has 8 new tests:
  - the idle rule at 5, 10 and 15 min and Off
  - a status of the user wins, and voice stops Away
  - lock and unlock, sleep and resume
  - the full-screen option and its helper, and the journal line.
- `test/auto-status-ui.test.mjs` has 2 new tests. `test/presence-ui.test.mjs` and
  `test/preload-bridge.test.mjs` have 1 new test each. These tests fail on 1.0.3.
- **this PC** (one app copy with `--profile`, a fake `APPDATA` and `--auto-away-ms 15000`, a LAN room on this PC).
  The own status went to Away 1.8 s after login (the PC had no input for more than 15 s). The journal had one line
  `{"type":"status","event":"auto-away","reason":"idle"}`. The check sent no input, thus the return to Available was
  not checked on this PC (unit tests only). Lock, unlock, sleep and resume: unit tests only. The full-screen option
  started its helper (16 ms of CPU in 30 s, 0.05 % of one core). The helper ended when the option went off. A
  manual Do not disturb stayed.

Results of this branch:
- `npm test`: 1112 tests, 1094 pass, 0 fail, 18 skipped (127.0.0.1). 1.0.3 in the same worktree: 1085 tests, 1067
  pass, 0 fail, 18 skipped.
- One start of each test copy: no error line in the terminal and no error in the developer console.
- Before and after each run, the Start menu shortcut `ASSCRACK.lnk` and the toast registration of the installed copy
  on this PC had the same values.
- No LAN test and no internet test.

### Room music (1.0.4)

A music bot for the voice channel. The member who starts the music is the DJ. The DJ's computer plays each track and
sends one stereo Opus stream (128 kbit/s) to the members of its voice channel. Each listener sets an own music
volume, and the music goes lower while someone talks (Duck, on by default).

- Sources: a YouTube link (a video or a playlist), local files and a music folder of the DJ. The YouTube source is the
  new dependency `youtubei.js` 18.3.0 (MIT).
- Queue: any member in the channel adds a YouTube link. The DJ adds files. Now playing, Pause, Skip, Remove, and
  Move up and down for the DJ. Chat commands `/play <link>`, `/skip`, `/queue` and `/pause`.
- The DJ leaves voice: the member with the smallest peer ID in the channel continues with the YouTube items.
- Security: only YouTube video and playlist IDs cross the room. The YouTube player script runs in a hidden sandboxed
  window with no network. Local files come only from the DJ's own pick (the L8 path rules). The main process decodes
  no peer data.
- Diagnostics: the journal event `music` (start, end, skip, error kind, stop). No title, link or path.

Checks (all 127.0.0.1 on one PC, no LAN result):
- `npm test`: 1113 tests, 1095 passed, 18 skipped, 0 failed (base 1.0.3: 1085 tests, 1067 passed). The five new test
  files fail on 1.0.3: four stop at the import (the modules are not there), and `music-relay.test.mjs` fails 2 of 2.
- Three app copies (a DJ and two listeners): a local file and a YouTube video (Big Buck Bunny, CC BY 3.0) played. Each
  listener got 128 kbit/s and a music level above 0. Volume, Duck, Pause, Play, Skip, `/play`, `/queue` and `/skip`
  worked. Voice from a listener arrived at the two other copies while the music played. No error line in the
  terminal or the developer console.
- CPU of the DJ copy: 7.1 % of one core with a local file and 7.4 % with YouTube (3.7 % in voice with no music).
- Host relay cost (node test, a DJ and 3 listeners, no direct streams): 457 kbit/s of music payload at the host.
- The voice check (`voice-check.mjs` of the voice processing goal): each step gave its expected result. Voice
  activity and a key down sent voice. A threshold above the signal, no key, a key up and a blur sent 0 bytes.
- One start with a fresh `--profile` and a fake APPDATA: no error line.
- The sandbox of the YouTube player script in Electron: its own process, no network, a loop stopped after 3 s.

## 1.0.3 (2026-11-22): message alerts, the image menu and three members that see each other

Release 1.0.3 is the third update of 1.0.0. A 1.0.0, 1.0.1 or 1.0.2 app gets it with the signed update (View, About
ASSCRACK, Check now). The entries below this heading, down to the 1.0.2 entry, were "Unreleased" entries. Each entry
gives its changes and its checks. Since 1.0.2, the app has these new items:

- Message alerts: a sound and a desktop notification for each room line when the conversation is not in view, a grid
  in Sound & notifications, three message sounds, and mutes for a channel or the room.
- The image menu: Copy image, Save image as… and Open original on a chat image and in the image viewer.
- A small preview of the own screen share in the share bar.
- A hint against the yellow border of a window share on Windows 10, with a "Share screen" button.
- A fix: in a protected room, each member now gets a session with each other member after the first admission.
- A fix: each kind of build has its own Start menu shortcut and toast registration. A portable start no longer
  changes the shortcut of an installed copy.

Build:
- `npm run dist` makes `ASSCRACK-1.0.3-portable.exe` (product name "ASSCRACK Portable"). `npm run dist:installer`
  makes `ASSCRACK-1.0.3-setup.exe` (product name "ASSCRACK").
- The source of the two files is the commit of this entry. The signed `update.json` of the release gives the byte size
  and the SHA-256 of each file. The files have no code signature.

Results:
- **127.0.0.1 and this PC only.** Each entry below gives its results with their labels.
- The integrated source (`npm test` in a fresh worktree after `npm run install:clean`): 1085 tests, 1067 pass, 0
  fail, 18 skipped (127.0.0.1).
- **this PC** (copies of `electron .` with `--profile`, rooms on 127.0.0.1 and the LAN address of this PC): one start
  with no error line; the voice regression (16 of 16 tests and `voice-check.mjs` with the expected byte counts);
  three copies: knock and Allow two times, each copy shows 3 people and gets each of 6 chat lines; the image menu
  (Copy image, Save image as… with the same SHA-256, Zone.Identifier on the file of a peer) and the share preview
  (5.75 frames per second); the border hint and its "Share screen" button; message alerts 18 of 18 (one cue and one
  notification for a burst while minimized, none in view). Before and after each run, the Start menu shortcut and
  the toast registration of the installed copy on this PC had the same values.
- `src/network/` changes only in `node.mjs` (the dial after the first admission). No new line on the network.
- Known failures: the same as 1.0.2 (check 19 of P8b, check 18 of P8a, the timed screen check 16 of
  `test/screen-auto.test.mjs`). One case of `test/transfer-resume-restart.test.mjs` can fail under load and passes
  alone.
- No LAN test and no internet test of 1.0.3 occurred.

### One Start menu identity for each kind of build (1.0.3)

- Fault: a start of the portable .exe changed the Start menu shortcut `ASSCRACK.lnk` and the toast registration of the
  installed copy. Both then pointed to the unpack folder of the portable .exe, which Windows deletes at exit. A click
  on a toast or on the shortcut then did not start the app. On this PC this occurred to the installed copy during a
  test. A dev start (`electron .`) changed the toast registration in the same way.
- Cause: Electron 45 writes the shortcut `<product name of the exe>.lnk` and the toast registration
  (`HKCU\Software\Classes\CLSID\<toast CLSID>\LocalServer32`) with the path of the running exe when the app makes
  its first notification. All kinds of build had the same identity.
- Fix: each kind of build has its own identity. The installed build keeps `ASSCRACK.lnk` and `com.asscrack.app`. The
  portable build has the product name "ASSCRACK Portable" (`npm run dist`), the shortcut `ASSCRACK Portable.lnk`,
  `com.asscrack.portable` and its own toast CLSID. After Electron writes them, the app points them to the portable
  .exe, not to the unpack folder. A dev start uses `com.asscrack.dev` and its own CLSID (shortcut `Electron.lnk`). A
  packaged exe started with `--profile` shows no desktop notifications, because its product name can be the name of
  the installed copy.
- **127.0.0.1**: `test/windows-identity.test.mjs` has 7 tests. On the code before the fix, the file fails (no
  module). With only the new module added, 2 tests fail: the identity in `main.js` and the build script. After the
  fix, all 7 pass.

### The image menu and the preview of the own share (1.0.3)

- Image menu (operator request: "right click here and save/copy image"). A right-click on a chat image shows "Copy
  image", "Save image as…" and, when the original is on this computer, "Open original". These items are first in the
  menu. The image viewer has the same items. The menu is the menu of the app (`menu.js`), not the native menu. The
  items also work on an own image (for example a pasted screenshot), which has no "Download original" button.
- Copy image: the main process sends the checked preview PNG to the hidden sandboxed decoder window. That window
  shows the image, and the main process calls `copyImageAt`. Chromium then writes the formats PNG, CF_DIBV5, CF_DIB
  and CF_BITMAP. The main process does not decode the image (audit L7). The Electron 45 clipboard API (`image/png` in
  `clipboard.write`) decodes the PNG in the main process, thus the app does not use it.
- Save image as: a Save dialog with the original name. The main process checks the target path (`checkSaveTarget`,
  audit L8). It copies the local original to a temporary file and compares the SHA-256. Then it writes the
  Mark-of-the-Web on the file of a peer (audit M3) and renames the file. With no local original, the "Download
  original" path starts, and the copy occurs when the download is complete.
- **127.0.0.1**: `test/image-menu.test.mjs` has 8 tests. They fail before the change and pass after it.
- **this PC**: two app copies (a LAN room on this PC). B pasted an image. On A: "Copy image" put PNG (49348),
  CF_DIBV5 (17), CF_BITMAP (2), CF_DIB (8) and HTML Format on the clipboard. `Get-Clipboard -Format Image` and
  `Clipboard.GetImage()` read a 320x200 image. A paste in the message box of the app made an image draft. A paste in
  an editable field of another Chromium window showed the image: the HTML Format has a data: URL. Before this fix, it
  had a blob: URL of the decoder window, and the field showed a broken image.
  "Save image as…" downloaded the original and saved it: SHA-256 equal to the posted image, Zone.Identifier with
  ZoneId=3. "Open original" then opened the downloaded file. On B: "Save image as…" on the own image saved a file with
  the SHA-256 of the posted image. The viewer menu opened in the viewer, and "Copy image" worked there.
- Preview of the own share (operator: "i cant see my own preview"). The share bar shows the captured stream in a small
  muted video (128 x 72 px). The stream stays on this computer: no network and no encode. The video gets a clone of
  the captured track at 5 frames per second. "Hide preview" turns it off, and the app keeps this choice. When the
  window is hidden or the preview is off, the clone stops.
- **127.0.0.1**: a new test in `test/screen-ui.test.mjs`. It fails before the change and passes after it.
- **this PC**: copy A shared the window of copy B (Standard). B showed a canvas animation, thus each frame changed.
  The preview played at 5.75 frames per second (802 x 600 source in a 128 x 72 box). The CPU time of all the processes
  of A in 8 s: 406 ms with the preview, 250 ms without it. With the full frame rate of the track (17 frames per second
  in the preview), the values were 484 ms and 203 ms.

### Message alerts (1.0.3)

- Fault: a plain room line gave no cue and no desktop notification. Only a mention, a whisper or a friend line did.
  Desktop notifications were off by default, and a file of 1.0.x kept them off. The title of a notification was the
  product name, with no sender and no channel.
- Sound & notifications has a grid now. The rows are "All messages", "Mentions", "Whispers", "Friend messages" and
  "People joining or leaving voice". The columns are Sound and Notification. All boxes are on, but the notification
  for voice join and leave is off. "Show message text" is on. "Only when in the background" is on. When it is off,
  a line in view also gives a cue and a notification (not an own line). "Message sound" has 3 built-in tones (Soft,
  Chime, Pop).
- A remote room line in any channel plays the message cue when its conversation is not in view. Examples are no
  focus, a minimized window, the tray, or a different channel. No cue for own lines, in Idle Peer, in Do not disturb
  or for history (a replay or the lines after a reconnect). At most one message cue each 2 s.
- The row "All messages" sends a notification only in a room of 10 people or less (me included). A mention uses its
  own row in each room. The title tells who and where: "<name> in #<channel>", "<name> (whisper)" or "<name>" (friend,
  voice). The body is the text when previews are on. A whisper and a friend line never show their text. Each
  conversation has one toast. The new toast replaces the old one, also in the Action Center (the same Windows tag).
  A click opens the conversation.
- Mute: a right-click on the channel list or on the room name mutes a channel or the room. The Room menu has the same
  commands. The times are 1 hour, until tomorrow (08:00) and until I unmute. "Mentions still notify" is on by
  default. A muted channel or room has the mark "· muted".
- Settings version 2: the first start with a file of 1.0.x turns on the new defaults one time. These are the
  notifications, the previews and the cue of every message. The real choices of the file stay, and later choices stay.
  A file with the message cues off keeps the cue of every message off too.
- **127.0.0.1**: node tests of the rules. They test the cue, the 2 s gap, history, the room size, the titles, the
  replace rule, the mutes with their end and the migration. They fail on the code before the change and pass after it.
  `npm test`: 1067 tests, 1049 pass, 18 skipped, 0 fail.
- **this PC**: two copies on 127.0.0.1 (A: the portable .exe built from commit 92151f7, B: `electron .`). With A minimized, B sent 3 lines.
  A played one cue, and Windows fired one show event. The toast "<name> in #general" was in the notification history
  of `com.asscrack.app`. A later line replaced that toast in the history. With A in view: no cue, no notification.

### A hint against the yellow border of a window share (1.0.3)

- Fault (operator, 2026-11-22): a window share of a game in full screen has a thin yellow border. The app does not
  draw it. Windows draws it when a program captures a window with Windows Graphics Capture (WGC).
- Cause: Chromium always captures a window of another program with WGC. No switch and no feature changes this.
  Chromium asks WGC for no border (`IsBorderRequired(false)`), but only Windows 10.0.20348 and later have this
  function. Before Windows 11 24H2, Chromium captures a screen with DXGI duplication, which has no border. Thus the
  border shows only on a window share on Windows 10. On Windows 11 there is no border. Source: Chromium
  156.0.8078.100 of Electron 45.4.1, files `desktop_capture_device.cc` and `wgc_capture_session.cc`.
- Change: the selected window can fill a screen, that is, the thumbnails of the window and of one screen have the same
  size. Then the picker shows "Screen share has no border" and a "Share screen" button. The button shares that screen.
  The hint shows only on Windows before build 20348.
- **this PC** (Windows 10 19045, no game): the test window was a WebGL window of 2560 x 1440 in a different process.
  The Chromium log showed the capture options of each share. A window share used WGC and gave 10 to 12 frames/s at 42 to 45 % of one
  CPU core. A screen share used DXGI and gave 14 to 16 frames/s at 51 to 53 % of one core. Both gave a picture, not
  black. The border is not in the captured frames, and it has no window. Thus a check without a screenshot cannot
  find it on this PC.
- **127.0.0.1**: `test/screen-sources.test.mjs` and `test/screen-ui.test.mjs` have 3 new tests. They fail before the
  change and pass after the change. Two app copies did three shares: a screen, the test window (the hint shows), and
  the "Share screen" button (the share is of the screen). The viewer got frames each time.

### Sessions between members after the first admission (1.0.3)

- Fault: in a protected room with an owner and two members, the second member often had no session with the first
  member. The two members did not see each other. Their chat lines did not get to each other, because the host does
  not send the chat lines of a member to the other members. A new member refuses the proof of each member that is not
  the owner until the owner admits it ("first admission requires the owner"). Each member also refuses the device
  proof of a device with no admission ("device authorization unavailable"). In a LAN room, mDNS gives the addresses of
  the members and of the owner at the same time. In an internet room, the full nodes of the invite do the same. Thus
  these sessions often start before the admission. Only a full node of the invite was dialed again after the
  admission (internet room). Version 1.0.0 has the same fault.
- Fix (`src/network/node.mjs`): the new member records each chat stream that failed, or will fail, because it had no
  admission. After its first admission, it dials each of these peers again, also a peer with a higher peer ID. The
  terminal shows `conn admission-retry peer=<peer ID>`.
- **127.0.0.1**: `test/admission-mesh.test.mjs` has 5 tests. They use a LAN room and an internet room. The new member
  meets a member before the owner, or at the same time. In a LAN room with mDNS, one member uses a device invite
  and one member uses the room code (knock), in the two orders. Each node gets a session with each other node, and each
  chat line gets to each other node. The 5 tests fail before the fix and pass after the fix.
- **this PC**: three app copies (a LAN room, two members join with the room code). Before the fix, the refusal
  occurred in 1 of 2 runs, and the two members then had no session. After the fix, 4 runs: the refusal
  occurred in 3 runs, and each time the new member dialed again. In all 4 runs, each copy showed 3 people and got
  each chat line.

### README cover page (1.0.3)

- The README is a cover page for users: the app icon, release badges, download buttons, screenshots in a light and
  a dark theme, the features, the first steps and the privacy points.
- The technical text of the old README moved without change to `docs/STATUS.md` (status, phase, roadmap, known
  limits) and `docs/DEVELOPMENT.md` (build, tests, terminal demo).
- **this PC**: the screenshots come from the 1.0.2 app on 127.0.0.1 with test names. A check found each image, badge
  and link of the three files on GitHub (27, 16 and 2 items, each with status 200).

## 1.0.2 (2026-11-22): short texts and state marks

Release 1.0.2 is the second update of 1.0.0. A 1.0.0 or 1.0.1 app gets it with the signed update (View, About
ASSCRACK, Check now). It has one change: the UI copy pass below. The window shows short texts, and marks (the owner
badge, the reach dot, the voice icons) with tooltips replace the sentences that gave a state. `src/network/` has no
change.

Build:
- `npm run dist` makes `ASSCRACK-1.0.2-portable.exe`. `npm run dist:installer` makes `ASSCRACK-1.0.2-setup.exe`.
- The source of the two files is the commit of this entry. The signed `update.json` of the release gives the byte size
  and the SHA-256 of each file. The files have no code signature.

Results:
- **127.0.0.1 and this PC only.** The entry below gives the checks of the UI copy pass with their labels.
- Known failures: the same as 1.0.1 (check 19 of P8b, check 18 of P8a, the timed screen check 16 of
  `test/screen-auto.test.mjs`). One case of `test/transfer-resume-restart.test.mjs` can fail under load and passes
  alone.
- No LAN test and no internet test of 1.0.2 occurred.

### UI copy pass: short texts, and state marks in place of sentences (1.0.2)

The operator asked for a window that speaks for itself. The window, the dialogs of the main process, the tray and the
installer now show short labels, verbs on buttons and short error texts. A sentence that only gave a state is now a
control with a tooltip. The source of the texts is the proposal `work-orders/ui-copy-20261122/PROPOSAL.md` (local to
this PC). The panel name "Buddies" stays.

Changes:
- New state marks (`src/application/ui-state.css`, the icons `img/state-*.svg`). The colors come from the theme
  variables.
  - The Invite (Access) panel has a role badge: Owner, Member, Member · Host, Waiting for approval or Removed.
  - The Invite panel, the status bar and the Friends panel show the reach as a dot and a short label.
  - The Buddies lines show the voice state as an icon. The words are the tooltip, and they stay for screen readers.
  - A push-to-talk icon lights while the key is down.
  - New tags: "+N" in the knock bar, "Pending" for a friend request and "Unverified" after a name.
  - More tags: "No audio" in the screen picker and "Debug log on" in About. A queued friend message has a clock icon.
- The note about version 0.7.0 is gone. The paragraphs of the invite forms, the voice meter, the history panel, the
  start-at-sign-in dialog and About are gone or are tooltips.
- An error in the status line has no "Error:" prefix. The class `error` makes it red.
- The window shows short texts for the guard texts of the main process and for the known error texts of
  `src/network/`. The network modules keep their texts, thus the terminal demo does not change.

Checks:
- **127.0.0.1 and this PC only.** `npm test`: 1045 tests, 1027 pass, 0 fail, 18 skipped.
- The 3 tests less than at 1.0.1 come from `test/old-version-note.test.mjs`. It now checks only that the note is absent.
- One app start with a fresh profile: no error line in the terminal and no error in the developer console.
- Two copies on 127.0.0.1: knock, Allow, chat in both directions, voice with mute and deafen, Leave room. All steps
  passed. No console error.
- The voice check of the regression map (127.0.0.1, the virtual audio devices of this PC) passed. Voice activity
  sends, and push to talk sends only while the key is down.
- The contrast of the new marks in each of the 6 themes: text 4.5:1 or more, icons and dots 3:1 or more.
- No LAN test and no internet test occurred.

## 1.0.1 (2026-11-22): easy joins, one data folder and diagnostics

Release 1.0.1 is the first update of 1.0.0. A 1.0.0 app gets it with the signed update (View, About ASSCRACK, Check
now). The entries below this heading, down to the 1.0.0 entry, were "Unreleased" entries. Each entry gives its changes
and its checks. Since 1.0.0, the app has these new items:

- Easy joins: a friend invite from the friend row, a room code with knock and Allow, Join on a friend row, "Always
  allow my friends" and the prompt for a code in the clipboard (goal easy-join).
- One data folder next to the program: `ASSCRACK Data` next to the portable .exe, `data` in the install folder. At
  the first start, the app can move the data of `%APPDATA%ASSCRACK` into it.
- The installer asks for the install folder and has the look of the app.
- A diagnostics journal on each computer, and a request for diagnostics that the other person must accept with Send.
- A red Leave room button and a Friends window ("Pop out").
- A fix of the tiles of the screen-share picker.

Build:
- `npm run dist` makes `ASSCRACK-1.0.1-portable.exe`. `npm run dist:installer` makes `ASSCRACK-1.0.1-setup.exe`.
- The source of the two files is the commit of this entry. The signed `update.json` of the release gives the byte size
  and the SHA-256 of each file. The files have no code signature.

Results:
- **127.0.0.1 and this PC only.** Each entry below gives its results with their labels.
- A 1.0.0 app ignores the new lines of 1.0.1 with no error. A 1.0.0 app cannot use a room code, and a 1.0.0 friend has
  no Join on a friend row.
- Known failures: the same as 1.0.0 (check 19 of P8b, check 18 of P8a, the timed screen check 16 of
  `test/screen-auto.test.mjs`). One case of `test/transfer-resume-restart.test.mjs` can fail under load and passes
  alone.
- No LAN test and no internet test of 1.0.1 occurred.

### Diagnostics for the easy joins, the dials, the failover and the screen share (1.0.1 integration)

- The journal records each knock step with a cause code: the prompt, Allow, Deny, a friend that gets in with no
  prompt, a timeout, and each refusal by a check or a limit. It also records the result for the person that knocks,
  the friend invite (sent, received, Join) and the code in the clipboard (prompt, Join, Not now). No name, invite,
  room code, device ID or address goes in.
- Each dial and reach attempt goes in with its route, its result and its time in ms, also the successes. A dial-back
  with a negative answer goes only into the journal, not into the terminal or Room activity.
- Each loss of the host gives one line: the time to the next host, to the first voice frame and to the first chat line.
- The sharer of a screen records each tier change of the rate control with its reason, and the stats of each viewer
  each 10 s. There is no line for each frame. The rate rules do not change.
- Results (127.0.0.1 and this PC, no LAN result): `npm test` 1048 tests, 1030 pass, 0 fail, 18 skipped, in a fresh
  worktree. The new tests `diag-knock`, `diag-dial`, `diag-failover` and `diag-screen` fail before their change. A
  two-copy check: a room code in the clipboard, a knock, Allow, chat in both directions, then a diagnostics request
  with Send. The zip has the knock events of the owner and no canary text. 21 of 21 steps pass.

### Diagnostics from friends with one click

- ASSCRACK keeps a diagnostics journal in the data folder (`diagnostics`). It records what went right and what went
  wrong. Examples are room starts, sessions with the route and the close cause, failed dials, UPnP and host changes.
  Also the voice quality each minute, the voice devices, file transfers, screen shares, errors, crashes and hangs. The
  journal stays on the computer. `docs/DIAGNOSTICS.md` gives the format.
- The journal is always on. This changes the rule of `42cf3b4` ("persist raw diagnostics only in an explicit run").
  Reason: the friends of the operator must not need a start option to give a useful report. The writer removes the
  private data when it writes a line. Each event has a fixed field list, and no line has text of a peer. An address
  class replaces each IP address, and an error text has no path. A test sends canary strings through two real nodes
  and finds none of them in the journal or in the bundle (127.0.0.1). The raw log of `--log-dir` does not change.
- "Ask for diagnostics…" on a buddy line, and "Ask everyone for diagnostics" in the Room options. Only a member device
  of a protected room can ask. The other person sees "<name> asks for diagnostics" with Send and Not now. The
  prompt shows what is in the bundle and its summary. Nothing goes out without Send. Limits: one pending request for
  each person, 1 hour of quiet after Not now, at most 3 prompts each hour.
- The bundle is a zip file. It has a manifest with the hash of each file and of the program file, and a plain
  summary. It also has the journal, the system and reach data, and the crash list. The crash memory files go into it
  only with a second checkbox. The asker gets it in `diagnostics\received`.
- "Mark a problem…" (Room options and voice controls) writes the time and a category in the journal.
- "Save diagnostics…" in the About dialog makes the same zip in a folder that the user selects.
- The crash reporter of Electron writes crash dumps to the data folder. It uploads nothing.
- Each side of a session sends a session ID and a clock line. Thus the bundles of two computers can go on one
  timeline. A 1.0.0 peer ignores these lines and cannot get a request.
- Results: `npm test` and a two-copy check on this PC (127.0.0.1). B asks, and A selects Send. B gets the zip with
  the expected files and no canary text. Not now sends nothing. No LAN result yet.

### One data folder next to the program

- ASSCRACK keeps all its data in one folder. This includes the settings, the history, the saved rooms and the friends.
  It also includes the device identity, the window data of Chromium, the logs and the clipboard staging. The portable
  build uses the folder `ASSCRACK Data` next to the .exe. The installed build uses the folder `data` in the install
  folder. `npm start` keeps the Electron default. `--profile <folder>` overrides each case.
- The folder can move on the same PC: move the folder of the .exe, then start the .exe again. The installed build
  writes the new path into the "Start as Idle Peer when I sign in" entry at the start. The state that the user set in
  Task Manager does not change.
- At the first start with an empty data folder, when `%APPDATA%\ASSCRACK` has data, the app asks "Move your rooms and
  history to <folder>?". Move copies the data, checks each file, then removes the old folder. Keep there does not
  change the old folder. When an other copy uses the old folder, nothing changes, and the app tells the user.
- When the app cannot write to the data folder, it shows the path and the reason, and it stops.
- The paused downloads (in the download folder) stay with a moved data folder. The file `download-owner.json` in the
  data folder keeps the owner text of the download scratch.
- The uninstaller of the installer keeps the folder `data` at an update and at an uninstall.
- Saved rooms from an other Windows user account or an other computer show a plain text. They cannot open there.
- Some files stay outside the folder. The received files and their download scratch stay in the download folder.
  The reason: the last step of a received file is a rename on the same drive. The start menu shortcut for
  notifications stays in the Windows folder for it. The update setup file and the unpack folder of the portable build
  stay in `%TEMP%`. The start entry stays in the registry.
- Checks (this PC): `npm test` 936 tests, 918 pass, 0 fail, 18 skipped. New tests: `test/data-folder.test.mjs`, and
  the entry repair in `test/start-at-sign-in.test.mjs`. On the base, these tests fail. The portable build in a folder
  `a`: a LAN room on this PC with a second copy, a line, Quit. Then the folder `a` moved to `b`: the saved room and the
  line are there. `%APPDATA%\ASSCRACK` did not change (names, sizes and times). The move question with a fake
  `APPDATA`: Move gives the saved room and the line in the new folder. Keep there does not change the old folder. When
  an other copy uses the old folder, Move does not move the old folder, and the new folder stays empty. A data folder
  with no write access gives the error box with the path, and the app stops. The installer build passes, and a small
  NSIS test program keeps the folder `data`. No real install test: this PC has an installed copy of the operator.
  These are not LAN results.

### Interface polish: the installer look, a red Leave room button and a Friends window

- The installer has the font, the colors and the art of the app, as far as NSIS allows. All pages use Segoe UI. The
  header and the Welcome and Finish pages use the Aero Classic colors. A new Welcome page shows the logo and the name
  at the side, with the title in the title font of the app. The page bodies, the buttons and the fields stay standard
  Windows controls. NSIS cannot give them the glass, the gradients or the dark themes of the app.
- In each theme, the Leave room button of the Room menu and of its confirmation has a red fill. The
  contrast of the text is 4.87:1 or more in each theme, also at hover (WCAG AA: 4.5:1).
- In a room, the Friends drawer has a "Pop out" button. It opens the Friends list in its own window. The window shows
  the same live data as the drawer, and a click on a friend opens the friend chat. There is one Friends window at
  most. It keeps its size and position, follows the theme, and closes with the app. Rename, Remove and Block stay in
  the drawer.
- Checks (this PC, 127.0.0.1): `npm test` 926 tests, 908 pass, 0 fail, 18 skipped. The 9 new tests fail on the build
  before the change and pass after it. A CDP check of one app copy with a fresh profile: 20 of 20 checks pass, with
  no error line. The check covers the Leave room colors in the 6 themes. It also covers the Friends window: open, one
  window, live update, theme, close, saved position and Quit. A capture of the first installer page. No real install: this PC has an
  installed copy of the operator.

### The installer asks for the install folder

- The Windows installer (`npm run dist:installer`) is now an assisted installer. It shows a folder page. The user can
  select the install folder. The install stays per user: the installer does not show the "for all users" choice and
  does not use administrator rights.
- The folder page does not accept a folder in Program Files or in the Windows folder: the Next button stays off, and
  the page text gives the reason. The user must be able to write to the install folder.
- An upgrade reads the folder of the last install. The silent update installs into the folder of the running app. The
  "Start as Idle Peer when I sign in" entry uses the path of the running app.
- Checks (this PC): `npm test` 917 tests, 899 pass, 0 fail, 18 skipped. The installer build passes. A small NSIS test
  program on this PC refuses Program Files, Program Files (x86) and the Windows folder, and accepts other folders.
  No real install test: this PC has an installed copy of the operator.

### Fix: the tiles of the screen-share picker

In the "Share your screen" dialog, the thumbnails went out of their tiles and covered the names, the headings and the
next tiles. Cause: each tile is a button, and the global button rule gives each button a height of 30 px. The tile
rule in `screen.css` now sets `height: auto` and `white-space: normal`.

Checks (this PC, one copy of the app):
- New test `test/screen-picker-layout.test.mjs`: Electron loads `index.html`, fills the picker and measures each
  tile in each theme. It fails on 1.0.0 and passes with the fix.
- The dev app with a fresh profile, picker opened through CDP, 7 tiles, 7 themes: before, each tile was 30 px high
  and its 90 px canvas went out of it; after, each tile is 118 px high (116 px in Amber Terminal) and contains its
  canvas and its name. No tile overlaps a tile or a heading. No error line in the console.
- `npm test`: 917 tests, 899 pass, 0 fail, 18 skipped.

### Code in the clipboard (goal easy-join, part 3, item 3, 2026-11-22)

When the main window opens or gets the focus, the app reads the clipboard text one time.

- **Prompt.** If the text is a room code or a device invite for this computer, the window shows "Join <room>?" with
  Join and Not now. The app parses the text only. It uses no network before Join. It asks one time for each code, also
  after a restart.
- **No prompt.** The app does not ask for an expired code, a damaged text, an invite for a different device, a room
  code of a room that this computer owns, or the room that is open now. The log and the window never get the text.
- **Join.** Join of a room code sends a knock to the owner, the same as a pasted room code. Join of a device invite
  uses the invite with no paste. In a room, Join asks "Leave <room> and join <room>?" first.
- **Shorter texts.** The new texts of easy-join (friend invite, knock, room code, friend Join, clipboard) are now short
  labels and short error texts, by the new UI text rule of the operator. Example: "Waiting for the owner of <room>…".

Checks (127.0.0.1 and pure logic on this PC, not LAN, not internet): `test/clipboard-join.test.mjs` has 7 tests. Two app
copies on this PC: A copies the room code, B shows the prompt and selects Join, A selects Allow, then chat in both
directions. The same check with a device invite: B shows the prompt, selects Join, and is in the room of A.

### "Always allow my friends" (goal easy-join, part 3, 2026-11-22)

The owner of a protected room can let friends in with no request.

- **Setting.** The Invite panel of the owner has the checkbox "Always allow my friends". It is off by default. The
  setting is for each room, and the saved room of the owner keeps it. A member that is not the owner does not see it.
- **Allow with no request.** When the setting is on, a knock gets Allow at once if the device is on the Friends list of
  the owner. The owner checks the device key first, then the device ID. The other checks and limits do not change. A
  stranger with the room code gets the request as before. A blocked device never gets this Allow.
- **Room line.** The room of the owner shows "<name> #<mark> joined, friend auto-allowed." The name comes from the
  Friends list of the owner.

Checks (127.0.0.1 on this PC, not LAN, not internet): `test/friend-auto-allow.test.mjs` has 6 tests. They do the
setting off and on, a friend with no request, a stranger with the request, and a blocked device with no admission. Two
app copies on this PC: A sets the checkbox, B selects Join, B gets in with no request, and A sees the room line.

### Join on a friend row (goal easy-join, part 3, 2026-11-22)

A friend row shows Join when the friend is in a protected room that you are not in. Join asks the owner to let you in.

- **Room line on the friend link.** Each app tells its friends the name of its current protected room. The line also has
  the room ID and the owner device ID. It has no room key, no code and no address. The row then shows "Online · in
  <room>" and Join.
- **Join.** Join sends a knock on the friend link, with the same proofs and limits as a room code. If the friend owns
  the room, the friend sees the normal request "<name> #<mark> wants to join." If the friend is an admitted member,
  the app of the friend sends the knock to the owner with no change. The owner checks the device key of the person
  that asks. Allow gives a device invite with no host rights. Then the normal join starts, with no paste.
- **In a room.** Join first asks "Leave <room> and join <room>?". The current room stays until the owner selects Allow.
- **Texts.** Deny gives "The owner did not let you in." No owner gives "The owner is not online. Try again later." A
  friend that cannot send the knock (not admitted yet) shows "Ask <name> for an invite" on the row.
- **1.0.0 apps.** A 1.0.0 app ignores the new lines with no error, and it never sends a room line. Thus a 1.0.0 friend
  has no Join.

Checks (127.0.0.1 on this PC, not LAN, not internet): `test/friend-knock.test.mjs` has 8 tests.
`test/friend-knock-node.test.mjs` has 7 tests. They do Allow and Deny of a friend that is the owner, and Allow
through a member that is not the owner. They also do "Ask", owner offline, and the friend code on a room code knock.
Two tests check the room line on a new friend link session and a room in the saved rooms.
Two app copies on this PC:
B selects Join on the row of A, A selects Allow, then chat in both directions.

### Knock and approve (goal easy-join, part 2, 2026-11-22)

A person with a room code asks the owner to join. The owner sees the request and selects Allow or Deny.

- **Room code.** The owner of a protected room selects "Copy room code" in the Invite panel. The code names the room,
  the owner and the addresses of the owner. It is not for one device. It works for 7 days. "New room code" makes a new
  code, and the old code stops at once. A member that is not the owner does not see the two buttons.
- **Knock.** The person pastes the room code in the same field as a device invite. The app proves the device key to the
  owner, and the owner proves the owner key to the app. The owner sees "<name> #<mark> wants to join." with Allow and
  Deny above the composer. Allow gives a device invite with no host rights, and the normal join starts. Deny gives
  "The owner did not let you in." No owner or no answer in 2 minutes gives "The owner is not online. Try again later."
- **Limits.** At most 5 requests wait at one time. A knock has a size cap and rate limits. After Deny, the same device
  gets no new request for 10 minutes. A knock over a limit gets a clear answer and no request.
- **Relay.** A relay lets a device that is not admitted connect only to the owner, for 150 s and 64 KiB. Each other
  connection of that device stays refused. A LAN room uses no relay.
- **1.0.0 apps.** A 1.0.0 app shows "This invite comes from a different ASSCRACK version" for a room code.

Checks (127.0.0.1 on this PC, not LAN, not internet): `test/knock.test.mjs` has 15 tests. `test/knock-node.test.mjs`
has 8 tests: Allow through a relaying member, Deny, owner offline, flood (direct and through the relay), old code, LAN
room, restart of the owner.
`test/knock-relay.test.mjs` has 2 tests: the relay rule and the circuit limits. `test/knock-ui.test.mjs` has 4 tests.
Three app copies on this PC: B knocks and A selects Allow, then chat in both directions. C knocks with an old code,
then with the new code, and A selects Deny.

### Friend invite (goal easy-join, part 1, 2026-11-22)

The owner of a running protected room can invite a friend with no device ID and no paste.

- **Invite to room.** The menu of a friend row has "Invite to room" when you own the protected room that is open now.
  A member that is not the owner does not see the item. The app makes a device invite with no host rights for the
  saved device of the friend. The invite goes on the friend link, or it waits in the offline queue of the friend.
- **Invite card.** The friend sees "<name> invites you to <room>." with Join and Not now in the friend chat. When the
  window is in the tray, a tray balloon also tells the friend. Join uses the invite with no paste. In a room, Join
  asks "Leave <room> and join <room>?" first. The chat window and the room window never get the invite code.
- **Checks of the receiver.** The card has no Join for an invite to a different device. It also has no Join when the
  owner of the room is not the friend that sent it. An expired invite has no Join. The expiry stays at 7 days.
- **Friend link line.** A new "invite" line in the private messages, with the same ID, receipt and queue as a message.
  A 1.0.0 app ignores this line with no error. It does not send a receipt, thus the invite stays in the queue of the
  sender until the sender deletes it.

Checks (127.0.0.1 on this PC, not LAN): `test/friend-invite.test.mjs` passes 11 of 11. It has these cases: online
friend, offline friend, wrong device, forwarded invite, expired invite, member that is not the owner. Two app copies on
this PC: A invites B from the friend row, B selects Join, then chat in both directions.

## 1.0.0 (2026-11-22): the full-featured release

Release 1.0.0 is the full-featured release before the friends get the app (operator, 2026-11-21). The entries below
this heading, down to the 0.8.0 entry, were "Unreleased" entries. Each entry gives its changes and its checks. Since
0.8.0, the app has these new items:

- Screenshare: the picker with Auto and five presets, the share bar and the viewer stage (P8a, P8b). The share has no
  sound.
- Pause and resume of large downloads, also after a restart of the app (P7a, P7b, P7c).
- The ready check (P9A).
- A per-user installer and the start as Idle Peer at Windows sign-in (P9B).
- Signed updates that the operator publishes on GitHub Releases (P9C).
- Sound cues for other people and for messages (P11).
- Voice channels, Deafen, listen with no microphone and a volume for each person (G4, G6).
- Friends, a private chat for each friend, and messages to an offline friend (G7a, G7b).
- Room reach, login texts, transcript notes, chat links, the Windows app shell and the app icon (G1, G2, G3, G5).
- The fixes of the accepted rows of the security audits P10a and P10b (goal AF, parts A and B).

Build:
- `npm run dist` makes `ASSCRACK-1.0.0-portable.exe`. `npm run dist:installer` makes `ASSCRACK-1.0.0-setup.exe`.
- The source of the two files is the commit of this entry. The signed `update.json` of the release gives the byte size
  and the SHA-256 of each file. The files have no code signature.

Results:
- **127.0.0.1 and this PC only.** Each entry below gives its results with their labels.
- Known failures: check 19 of P8b (decision P8b-14) and check 18 of P8a (decision P8a-31). Check 18 measures the
  return of the screen quality to Balanced after a link drop. The timed screen check 16 of `test/screen-auto.test.mjs`
  does not always pass, also on the build before goal AF.
- No LAN test and no internet test of 1.0.0 occurred. The game nights and the field checks with the friends come
  after 1.0. A fault from a field check gives a 1.0.x build.

### Audit fixes for the network and the protocol (goal AF, part A, 2026-11-22)

These changes fix the accepted rows of the security audits P10a and P10b for the network and the protocol. Each row
has its own commit and test.

- **M1. History and voice of the host (partial fix, items 1 to 3).** In a protected room, a history item needs the
  device prefix of its message ID. A line of a known device shows the name that this computer knows for that device.
  A line of an unknown device keeps the name of the host and shows "(not verified)". A voice frame from the host needs
  the origin of a voice peer with a session. Signatures (item 4) come after 1.0.
- **M2. Text channels.** A room has at most 64 named channels. A member keeps new channels only from the host. The host
  accepts at most 30 add lines a minute from each member.
- **M4. Hidden listeners.** The host sends its voice roster to each session. The window shows a member of the roster
  with no voice line as "listening (not in voice for you)". The host forwards no frame to a deafened member.
- **L1. Peer addresses.** A node line keeps only public TCP addresses with an IP (no DNS name, no private or loopback
  address). A friend address can also be a LAN address. The hint file, the friend row and the invite code get an
  address only after a connection to that peer ID reached it.
- **L3. Device marks.** The window shows a 6-character device mark after each name, in the peer list, in the chat and
  in the friend request bar. The peer list shows "(same name)" when two people use one name.
- **L4. Invite expiry.** A new device invite expires after 7 days. The owner refuses an expired invite at the first
  admission. An admitted device keeps its access.
- **L5. LAN rooms.** A LAN room listens only on 127.0.0.1 and on the private IPv4 addresses of the PC, not on 0.0.0.0.
- **L6. Legacy rooms.** The host rules of protected rooms apply: a peer announces only itself, with a safe-integer term.
  A live line shows the name of the session, not its own sender field.
- **L9. Signal line.** The unused signal line is gone. A voice stream ID has at most 64 characters.
- **L11. Screen lines.** A share line stops the own share for a conflict only in the first 3 s. A Watch with no CONFIG
  in 10 s removes that share. At most 30 screen lines a minute from each peer.
- **L12. Voice channel catalogs.** The seq check comes before the signature check. After 30 failed checks in a minute,
  a peer gets no more checks in that minute.
- **OI1.** The libp2p error of a port in use now starts the retry with a new port for a saved UPnP port. The user
  sees the plain text.

Changes for old clients and old data (features-first rule):
- An `asscrack3:` code of an older version gives the text of a different version (L4). An old unused device invite has
  no expiry time and the owner refuses it. An old owner cannot admit a device with a new code.
- An old client cannot add text channels through a member that is not the host (M2). Its signal lines and its host
  lines for another peer have no effect (L9, L6). It ignores the voice roster (M4).
- A full node of an old version on a private address is no longer a saved hint (L1).

**Results: 127.0.0.1 and this PC.** No LAN test and no internet test.
- Each row has a test that fails on `origin/main` and passes on the branch.
- `npm test` on the branch with `origin/main` merged: 916 tests, 898 pass, 0 fail, 18 skipped (the timed checks).
- One start of the app with a LAN room and Quit (this PC). The terminal, the log and the console of the window have no
  error line.
- The voice check of two app copies (127.0.0.1, the Steam Streaming devices, the fixed script of part B). B joins the
  LAN room of A with a device invite. B gets the voice bytes of A: 7891 bytes in 3 s with voice activity, and 9589
  bytes in 3 s with push to talk.

### Audit fixes for the application, files and tools (goal AF, part B, 2026-11-22)

These changes fix the accepted rows of the security audits P10a and P10b for the application, the files and the
tools. Each row has its own commit and test.

- **M3. Mark-of-the-Web.** On Windows, each received file gets the stream `Zone.Identifier` with `ZoneId=3`
  before it gets its final name. Windows then warns before it opens a program from a peer. Attachments, Shared
  downloads and resumed files use the same path. A volume with no alternate data streams gets no mark.
- **L2. Hidden format characters.** File names lose each Unicode format character (for example U+202E). Ready
  texts and friend request names lose the bidi controls, U+200B and U+FEFF. U+200D stays for emoji. A chat link
  ends at such a character. The window shows the extension of a received file apart from its name, and a warning
  for a program file type (`.exe`, `.scr`, `.lnk` and others).
- **L7. Peer images.** A hidden sandboxed window decodes the image previews. The main process only checks the PNG
  that comes back.
- **L8. Chosen files (partial fix).** The main process refuses a path that is not a regular file, and a device path.
  It also refuses each file in the profile, in the default profile and in the folder of the release key. A drop and a paste
  still give the path from the window. The full fix removes these 1.0 features, so it is not in this change.
- **L10. Terminal demo.** The demo replaces control characters in the peer text before it prints the text.
- **I4. App scheme.** The room window, the friend chat window, the voice panel and the image decoder load from
  `asscrack-app://app/`, not from `file://`. The fuse `grantFileProtocolExtraPrivileges` is off in the build.
- **OI2.** A call of `asscrack:invite` from a window that closes at Quit gets no error line in the terminal.
- **OI4. Clean install.** `npm run install:clean` installs on a PC with no VC++ build tools. See the README.

Changes for old data (features-first rule):
- The pages have a new origin. Thus the window does not find the saved user name, theme, layout and highlight
  words of an earlier version. It starts one time with the default values.
- A history item or a Shared entry from an older version with a format character in its file name is not valid.

**Results: 127.0.0.1 and this PC.** No LAN test and no internet test.
- `npm test`: 883 tests, 865 pass, 0 fail, 18 skipped (the timed checks).
- One start of the app with a LAN room and Quit: no error line in the terminal or the log. The developer console
  has only the two CSP lines of one check. In that check, script in the window cannot read a local `file:` URL.
  On the base, it read `C:/Windows/win.ini`.
- The image decoder window (this PC): a 1500 x 900 JPEG and PNG give a preview in a sandboxed renderer.
- Two app copies (127.0.0.1): A posts a 1500 x 900 PNG, and B shows a 1024 x 614 preview from its decoder window.
  The voice panel of A opens from the app scheme. Both copies quit with no error line in the terminal or the log.
- `npm run install:clean` (this PC, no VC++ build tools): exit 0, then the tests and the app start work.
- The voice check of two app copies (127.0.0.1, the Steam Streaming devices) with the fixed script (OI3): B
  gets the voice bytes of A. The old script made two LAN rooms, because each "Create LAN room" makes a new key.

### Screenshare in the app (package P8b, 2026-11-22)

A member can share a screen or a window with the room. Design: `work-orders/astra/P8/DESIGN.md`, W3 to W7 (local).

- **Share.** Share screen is in the voice controls. A share does not need voice. The picker shows the screens and
  the windows with a small picture, and a Quality select. Auto is the default. The fixed presets are Standard
  (720p, 15 fps), Smooth (720p, 30 fps), Balanced (1080p, 30 fps), High (1080p, 60 fps) and Max (1440p, 60 fps).
  The share bar shows the source, the viewers and the quality of each viewer group. Stop sharing stops the capture at once.
- **No sound.** The share has no audio. A viewer hears the sharer in voice, and only in the same voice channel.
- **Who can watch.** Only a member with an open, permitted session of the room. No member watches automatically: a
  member clicks Watch on the banner or Watch screen in the buddy menu. A share has at most 6 viewers.
- **Bitrate for each viewer.** At most 1.5 Mbit/s (Standard) to 12 Mbit/s (Max). The rate control can give less.
  The sum of all viewers behind a relay is at most 6 Mbit/s.
- **The viewer.** A stage above the transcript with the picture, the size and the frame rate, Fill window and Stop
  watching. The viewer checks each CONFIG and each VP8 keyframe header before the decoder.
- **Signs outside the window.** The buddy line shows "sharing screen". The detached voice panel shows the line
  "Sharing your screen" and Stop sharing. The taskbar button has a red overlay while the share is on. A pending
  mention dot comes back after the stop.
- **Result: 127.0.0.1, this PC.** No LAN test and no internet test.
  - `npm test`: 862 tests, 844 pass, 0 fail, 18 skipped (the timed checks).
  - The app check has three app copies (`work-orders/astra/P8/checks/screen-check.mjs`, local). 15 of 15 checks
    pass: W3 check 6, W4 checks 4 to 10, W5 checks 5, 6 and 8 to 11. It found two faults that are now fixed: the
    tier ID type in the bridge, and Fill window inside an animated panel.
  - Timed checks with the real capture and encoder (`checks/timed.mjs`, load 15 % to 38 %). Standard: 14.9 fps
    direct and 15.0 fps on a circuit, about 1.5 Mbit/s. Latency p95: 200 and 201 ms. Sharer CPU: 20 % and 22 % of a
    core. Smooth: 29.6 fps. High and Max (the screen of this PC): 57.7 and 57.8 fps, CPU 121 % and 169 %.
  - Auto: Max at 21 s on a direct route, Balanced on a circuit (the relay part). The minimized sharer gave 15.3 fps.
  - **Check 19 fails: 2 of 2 valid runs.** Two circuit viewers, the link of viewer 2 at 6 and 2 Mbit/s in turn.
    Viewer 1 had 15 and 14 frames in its lowest second after 15 s (limit 28). It reaches Smooth at 27 to 30 fps only
    from about 22 s, after the start split at about 20 s. This is a known failure (decision P8b-14). The time of the
    split is a 1.0.x item.
  - Report only: check 17 passes 3 of 3, check 24 passes 3 of 3 (Max at 21.3 s, then 57 fps). Check 21 fails 3 of 3:
    a text share on a 1.5 Mbit/s link stays at Standard.
  - Known gaps: the return from Idle Peer was not driven (it needs the tray). The two-copy voice check did not
    connect its copies on this PC, on this branch and on `origin/main`.

### Updates that the operator pushes to the clients (goal P9C, 2026-11-22)

The operator publishes a release one time. Each client finds it, downloads it, checks it and installs it with one click.
- The app reads the latest GitHub release of `noveblue53/asscrack` at the start and each 6 hours. The setting
  "Check for updates" in About ASSCRACK controls this (default on). The request has no user data and a generic
  User-Agent.
- The app accepts `update.json` only with a good Ed25519 signature (`update.json.sig`) of the operator key and a higher
  version. It accepts a file only when the size and the SHA-256 agree with the signed manifest.
- A quiet bar shows "ASSCRACK <v> is ready." with "Restart to update", "What's new" (plain text) and "Later". In a
  voice call or during a file transfer, Restart asks first.
- The installed build runs the new installer silently for the current user. The portable build starts the new
  portable file next to the old one, and the new copy deletes the old file. The profile does not change.
- Peers spread the news: each session gets the app version. A node with a newer signed manifest sends it one time to
  an older peer, and the peer checks the signature. The file comes only from GitHub.
- `tools/update-key.mjs` makes the key pair, `tools/sign-update.mjs` signs a release, and
  `tools/update-test-server.mjs` is a local test release. The steps are in `docs/RELEASE_UPDATES.md`.
- The public key in `src/application/update-key.mjs` is a test key. The release check
  (`node tools/sign-update.mjs --check-release`) fails until the operator key replaces it.

Results (127.0.0.1 and this PC, no LAN, no GitHub upload):
- `npm test` passes (127.0.0.1). New tests: the manifest rules, the updater with a fake server, the peer lines on real
  nodes, the busy rule, the key and sign scripts.
- Packaged test builds 1.0.0-test and 1.0.1-test with a local test release on 127.0.0.1: 30 checks pass. The portable
  and the installed build update themselves. A second client gets the news only from a peer. Each refused case (a
  changed byte, an other key, a wrong SHA-256, a wrong size, an equal version) gives no bar and no file. In voice,
  Restart asks first. No ERROR line. The install state of this PC is the same after the checks.

### Screenshare, network part (package P8a, 2026-11-22)

The network layer can now share a screen in a room. The window part (the picker, the share bar and the stage) is
package P8b. It comes later. Design: `work-orders/astra/P8/DESIGN.md`, revisions 2 and 3 to 3f (local).

- **Protocol.** A `screen` control line tells each member that a member shares. A viewer opens the stream
  `/asscrack/screen/1.0.0` to the sharer on its session connection (direct TCP or a circuit). The records have a
  length prefix: WATCH, CONFIG, FRAME, ACK, KEYREQ and END. Only a peer with an open, permitted session can watch.
  A share has at most 6 viewers. A room has one share at a time: when two members start at the same time, the lower
  peer ID continues. A share stops at Stop, in Idle Peer, at Quit, and after 10 s with no session.
- **Rate control and voice first.** The sharer paces its writes, measures the ack delay of each viewer, drops frames
  for a late viewer and changes the bitrate. Voice keeps its own streams and does not change.
- **Auto quality.** Five presets from 720p at 15 fps to 1440p at 60 fps. Each viewer has its own rate. There are at
  most two encoder tiers, thus a slow viewer does not lower the picture of the others. Each step up is a probe that
  goes back at once when the ack delay rises. A long queue steps a tier down at once.
- **Result: 127.0.0.1, this PC (revision 3f).** No LAN test and no window test (P8b).
  - `node --test test/screen-share.test.mjs test/screen-rate.test.mjs`: 42 of 42 pass. `npm test` on the merge
    result: 788 of 805 pass, 0 fail, 17 skipped. The timed checks skip in `npm test`. Each timed file runs with
    `node --test` on its file.
  - Voice: no voice limit failed in run 11 and in the study of 25 runs (load 5 % to 40 %). Voice delay p95 in the
    judged windows: 17 to 48 ms.
  - **Failures (screen quality speed, not voice).** Check 18: 2 of 3 runs pass in run 11, 0 of 5 in the study.
    After a drop of the link, the tier is at Balanced again only at 66.7 to 73.2 s. The limit is 65 s. Check 16: 4 of 5
    (viewer 1 did not reach Max in one run). Check 20: 4 of 5 (the sum of the tier ceilings was above 5 Mbit/s in
    one run). Check 19: 2 of 3 runs pass with revision 3d (1 frame missed in 1 s). The study did not measure it.
  - Checks 17, 19, 21 and 24 (the speed of the quality) are not measured in the merge gate of P8a. P8b measures
    them with the real encoder. The speed of the return after a drop of the link is a 1.0.x item (field data).

### Per-user installer and start at sign-in (goal P9B, 2026-11-22)

A per-user installer comes next to the portable build. The installed build can start in the tray when you sign in.
- `npm run dist:installer` makes `dist/ASSCRACK-<version>-setup.exe`. The installer needs no administrator rights.
  It installs to `%LOCALAPPDATA%\Programs\asscrack`, and it adds a Start Menu shortcut, a desktop shortcut and an
  uninstaller. The installer, the uninstaller and the shortcuts use the app icon. `npm run dist` does not change. It
  makes only `dist/ASSCRACK-<version>-portable.exe`.
- In the installed build only: View, "Start at sign-in…". The setting "Start as Idle Peer when I sign in" opens one
  protected saved room or "Friends only (no room)". The portable build does not show the setting.
- At sign-in, ASSCRACK starts in the tray. It opens the room with the normal reopen of a saved room, then it goes to
  Idle Peer. If the protected storage stays locked, or the start fails, it tries again each 30 s and after a wake.
- The start entry is the Run value "ASSCRACK" of the user. Its arguments are `--start-idle` and, for a test profile,
  `--profile <folder>`. They have no room key, no invite and no name. You can turn off ASSCRACK in Task Manager
  (Startup apps). The app does not turn it on again. The dialog then tells you that the start is off in Windows.
- Forget of the selected room removes the start entry. A Forget in the portable build clears the choice, and the
  installed build then removes the start entry. The uninstaller removes the start entry and its Startup apps
  value. An upgrade keeps them.

Results (this PC, no real sign-in):
- `npm test` passes, 744 tests (127.0.0.1). 13 new tests for the start choice, the arguments, the installed build
  check, the Forget rule, the retry, the uninstall include and the bridge.
- `npm run dist` makes `ASSCRACK-0.8.0-portable.exe` with the custom launcher, as before.
- Install, start with the arguments of the start entry, Startup apps off, upgrade to a test version 0.8.1, Forget,
  uninstall: each step passes. The checks used a test profile, not the profile of the operator. The start with the start
  entry arguments opened the saved room with no visible window, in Idle Peer.
- The portable build gave a native notification request after the uninstall (two copies on 127.0.0.1).
- The installer has no code signature. A copy with Mark-of-the-Web gives "The publisher could not be verified" and
  "Unknown Publisher" when PowerShell starts it.
- Known Electron behavior, not from P9B: each packaged copy that starts writes the Start Menu shortcut ASSCRACK.lnk
  with its own path. Thus the shortcut points to the copy that started last. The uninstaller removes it, and the
  next start of the portable build writes it again.

### Friends offline (goal G7b, 2026-11-21)

A message to a friend that is not connected waits on this computer. It goes out when both apps run and connect.
- The chat window shows a waiting line with "Waiting: ASSCRACK sends it when you are both online" and "Delete".
  When the friend gets the line, the mark changes to "Delivered".
- At most 200 lines wait for each friend. The next line gets "200 messages wait for Sam. Wait until Sam is online."
  A waiting line has no expiry.
- The receiver sees the lines with their original times. One note comes before each batch: "Sam sent 3 messages
  while you were away." Each line of the batch has the mark "sent while you were away". One notification comes for
  each batch, by the attention rules. There is no notification in Do not disturb, in Idle Peer, or when that chat
  window has the focus. A live friend line uses the same rules for the notification and the message sound.
- Two friends in one protected room can send private messages through the room, also when the friend link has no
  connection. The panel then shows "Online · in <room name>". The room also gives the current addresses of the friend
  link, and the friend link connects at once when it can.
- Friends see "Online · Away", "Online · Do not disturb" or "Online · Idle Peer".
- When the clock of the sender is ahead of the clock of the receiver, the waiting lines keep their order.
- With 1 or more friends and "Close to Idle Peer" on, Close on the login screen puts ASSCRACK in the tray. The tray
  tooltip is "ASSCRACK – online for friends". The first time, a note tells the user how to open and quit it.
- When a friend ends the friendship, each waiting line shows "Not delivered" and the reason.

Results:
- `npm test` passes, 731 tests after the merge with P7c (127.0.0.1).
- 14 new tests. 7 use real friend nodes and a real archive in a temp folder (127.0.0.1 on this PC). 6 test the
  window part with a stub bridge or the room window fixture. 1 tests the order of the lines when the clock of the
  sender is ahead.
- One `npm start` gives no error line in the terminal or the developer console (this PC).
- Two copies (this PC, 127.0.0.1), 5 runs: B quits, A writes 3 lines ("Waiting"). B starts: A shows "Delivered" for
  the 3 lines, B shows the note and the 3 lines once, and B logs one notification. A closes the window on the login
  screen: A stays in the tray as "online for friends", and B still shows A as "Online". All G7b steps pass in the
  5 runs.
- Known older fault, not from G7b: at the Quit of the room part, A logged the `asscrack:invite` "Unknown room window"
  line in 3 of 5 runs. The G7a check on `main` gave the same line in 2 of 3 runs. One run on each tree also gave a
  Chromium GPU error line in the terminal.

### Resume of a kept download after a restart of the app (package P7c, 2026-11-21)

Resume of a paused download now works after a restart of the app, on both ends. Before, a kept part continued only
when the sender offered the same file again.
- The receiver keeps the retry state of each kept part next to it: the last offer, the sender name, the peer ID
  and the room device ID of the sender. After a restart, the kept row has "Resume".
- In a protected room the sender keeps its grant for the paused file in its profile (one file for each room), for the
  same 72 hours as the kept part. Only the receiver device can use the grant, and only while the source file is
  unchanged.
- Each restart gives a new peer ID. The node finds the other end by its device ID. When the sender is not in the room,
  the row shows "Waiting for <name>", and the download continues when the sender comes back.
- Fix (the open point of P7b): on the sender, the "Paused by" row continues as the resumed send after a restart of the
  receiver, and it ends when the grant expires.
- Not changed: the final SHA-256 check of the full file, a changed source deletes the kept part, Discard and expiry
  delete the part and its retry state. A room with no membership has no device ID: it behaves as before (a new offer
  of the same file continues the part).
- A resumed download that stops again (a quit of the receiver or a lost link) keeps the grant of the sender. Thus
  Resume works also after the next restart.
- Known limit: the sender has no Pause. When the sender quits during a send, the receiver row shows "Cancelled". The
  part stays, and a new offer of the same file continues it.

Results:
- `npm test` passes, 717 of 717 after the merge with G7a (127.0.0.1).
- One `npm start` gives no error line in the terminal or the developer console (this PC).
- Two copies (127.0.0.1): A offers a 600 MiB file (629,145,600 bytes) to B. B pauses at 258,605,056 bytes (41.1 %),
  quits and starts again, and selects Resume on the kept row. B got no new offer. A sent 370,540,544 bytes after the
  resume: the remainder exactly. The SHA-256 of the saved file and of the source agree. The one row of A went from
  "Paused by Bob" to "Delivered".
- Two copies (127.0.0.1), the sender offline: B pauses at 258,277,376 bytes, then B and A quit. B starts alone, and
  Resume shows "Waiting for Alice". A starts again, and the download continues with no action: A sent 370,868,224
  bytes (the remainder), and the SHA-256 agrees.
- The two checks again after the merge with G7a (127.0.0.1): A sent 373,948,416 and 375,062,528 bytes, each the
  remainder exactly, and the SHA-256 agrees in both.

### Friends (goal G7a, 2026-11-21)

Two people in a protected room can agree to be friends. Friends send private messages outside of rooms, from the
login screen and from inside a room.
- In a protected room, the buddy menu has "Add friend…". The other person sees a bar above the composer with
  "Accept" and "Decline". The bar says that a friend knows the internet address of this computer.
- Each friend is a saved private 2-person room with its own background link. The links start when the protected
  storage opens and stop at Quit. Leave room and a new login do not stop them.
- The Friends panel is at the side of the login card. In a room, the titlebar button "Friends" opens it. Each row
  shows "Online" only when a link is open. The row menu has "Open chat", "Rename…", "Remove friend…" and "Block…".
- One chat window for each friend, with the marks "Sending", "Delivered" and "Not confirmed". A message to a friend
  that is not connected is not sent, and the draft stays.
- Remove and Block remove the friend room and its messages from this computer. The other side shows "Removed you as a
  friend". A blocked person cannot send a new friend request.
- At most 32 friends, on the TCP ports 47200 to 47231. When a port is in use, the link uses a free port.
- Two friends with no open port (UPnP or a forwarded port) and not on the same network cannot connect. The chat
  window tells the user why.
- Not in this goal (G7b): messages to a friend that is offline, and Close to the tray on the login screen.

Results:
- `npm test` passes, 702 tests (127.0.0.1).
- 20 tests in three new files test the friend requests, the grant, the private messages and the friend links.
  Most of them use real nodes and a real archive (127.0.0.1 and mDNS on this PC). 5 window tests use a stub bridge.
- Two copies (this PC): B adds A, A accepts. After a quit and a start with no room, both panels show "Online" in
  2 s. A message goes each way and shows "Delivered". B makes its own room and the link stays "Online". B removes
  A and A shows "Removed you as a friend". No error line in the terminal or the developer console.
- The cost of idle friend links on this PC, in 60 s, more than the run with no link. With no cache, each link used
  about 1.2 ms of CPU for each mDNS query of the network. 16 links used 2.2 % of one CPU and 32 links used 4.2 %.
  The cause: for each query, the mDNS library reads the network interfaces before it compares the room tag. The app
  now keeps one read of the network interfaces for 2 s (interface-cache.mjs). With the cache: 0.37 % for 16 links
  and 0.47 % for 32 links. The memory of 32 links is about 16 MB.
- The node, relay and election tests pass with the cache (64 tests, 127.0.0.1).

### Pause and resume of large downloads: the window (package P7b, 2026-11-21)

The window now shows the pause and the resume of a received file (P7a made the network part).
- A receive row has "Pause". A paused row shows "Paused · <bytes> of <size> · kept until <local date and time>"
  and the actions "Resume" and "Discard".
- Resume asks the sender again. When the sender is not in the room, the row shows "Waiting for <name>". The
  download starts when the sender comes back.
- Discard asks first: "Discard the partial file of <name>? The download starts again from the beginning next time."
- When the sender cannot continue from the kept part, the row says "The download started again from the beginning."
- An expired kept part shows "The kept part expired." and only Retry.
- After a restart, a kept part has its own row with Discard. When the sender offers the same file again, the
  download continues from the kept part.
- The sender row shows "Paused by <name>" and the bytes that it sent after the resume.
- The Quit and Leave room dialogs count only transfers that send or receive, not a paused one.
- Leave room keeps the paused parts. The next room of the same run shows them.

Fix: each received file failed at its end with "stream ended" in the app on origin/main (`daf2c56`). A listener in
`main.js` used a name of a different block. The fix is in this package.

Results:
- `npm test` passes (127.0.0.1).
- One `npm start` gives no error line (this PC).
- Two copies (127.0.0.1): A offers a 600 MiB file (629,145,600 bytes) to B. B pauses at 259,260,416 bytes
  (41.2 %), quits and starts again. A offers the file again, and B continues from the kept part. The SHA-256 of the
  saved file and of the source agree. A sent 369,885,184 bytes after the resume: the remainder exactly. Discard of a
  second paused transfer deleted its kept part of 111,804,416 bytes.
- Two copies (127.0.0.1): Resume in the same run continues on the same row (A sent 370,278,400 bytes, the
  remainder). A kept part stays after Leave room, and the next room shows it.
- A Shared download has no Pause: the Shared panel has no paused state.

### Windows app shell (goal G5, 2026-11-21)

ASSCRACK now acts like a Windows app.
- The window keeps its size, its position and its maximized state. A window on a display that is gone comes back
  into view. The minimum size is 560 x 480.
- A mention or a whisper outside your view flashes the taskbar button and puts a dot on it, until you open the
  window. A new box in Sound & notifications turns the flash off.
- The window title shows the room and the count of unread highlights and whispers, for example "(2) Room – ASSCRACK".
- View has "About ASSCRACK…" (version, Copy version info, Open data folder) and "Keyboard shortcuts…" (also F1).
  On the login screen View shows only the lines that work there.
- "Leave room…" in the Room menu leaves the room with no restart. The dialog says what you lose and how many
  file transfers stop. View, Quit asks first when file transfers are active.
- The tray menu has "Close to Idle Peer". A balloon tells you at the first close to the tray, and when the close
  ended voice.
- Recent events in the peer inspector show the local time and the buddy names.

Results:
- `npm test` passes (127.0.0.1).
- The window bounds are the same after a quit and a start (this PC).
- Two copies (127.0.0.1): B leaves the room and joins again with the same invite. A line goes in each direction.
  Then B leaves again and makes a room of its own. The change gives no ERROR line.
- About shows 0.8.0 (this PC).
- A minimized copy writes the log lines of the taskbar flash "on" and "off" (127.0.0.1).
- Windows sent the event of a shown tray balloon (this PC). The look of the flash and the balloon is for the
  operator.

### Voice channels (goal G6, 2026-11-21)

A protected room gets named voice channels, like Discord. Each person is in one channel at a time. The room window
shows each channel with its people, and one click joins a channel or moves to it.

- **Channels.** The Buddies panel has the section "Voice channels". General is always there. Each row shows the name,
  the number of people and the people in it, with "muted" or "deafened". The own channel shows "(you)". A click or
  Enter on a row joins (not in voice) or moves (in voice). "Join voice" joins the last channel of this run.
- **Only the room owner edits.** The owner sees Create. The row menu of the owner has Rename and Delete. At most 16
  channels, each name 1 to 40 characters and unique with no case. The owner device signs the list. Each member keeps
  the newest valid list, sends it to the other members and saves it with the room. A legacy shared-code room has
  only General.
- **Delete.** Delete asks first and gives the number of people in the channel. These people move to General, and
  each one sees a text about the move to General.
- **Routing.** The host sends the voice of a person only to the people in the same channel. Two people get a direct
  voice stream only in the same channel. After a move, a person sends no voice for 250 milliseconds. A move does
  not open the microphone again, and the mute and Deafen state stay.
- **Other parts.** With 2 or more channels, the buddy line shows the channel ("in voice (muted) · Raid · 40%"). The
  detached voice panel starts with the channel name. The network map shows "in voice · Raid". The cue for a
  different person plays when that person comes into my channel or goes out of it.
- **Limits.** A channel is a routing filter, not a lock: each member can join each channel, and the host gets the
  voice of each channel. The speaking ring shows only in my own channel. On a slow relay route, the first voice
  after a move can still go to the old channel.
- **Result: 127.0.0.1, this PC.** `npm test`: 605 of 605 pass (15 new G6 tests: 2 with real protected-room nodes on
  127.0.0.1, 13 with no network). Measured move hold on 127.0.0.1: 16 frames held, the first frame out 254 ms after the
  move. `node --test test/voice-gate.test.mjs test/voice-settings.test.mjs`: 16 of 16 pass. The two-copy voice
  check gives the same result as for G4. An app check with two copies on this PC: 18 of 18 checks pass. B in
  General gets no audio of A in Raid. After the move, B gets it with no new microphone. The delete moves both to
  General. No LAN result: the operator tests voice channels on a real relay route.

### Ready check (package P9A, milestone 9, 2026-11-21)

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

### Voice (goal G4, 2026-11-21)

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

### Resume of large transfers, network part (package P7a, 2026-11-21)

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

### Chat links, files with text, and keys of the message box (goal G3, 2026-11-21)

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

### Sound cues for other people and for messages (goal P11, 2026-11-21)

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

### Room link and transcript notes (goal G2, 2026-11-21)

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

### Behavior tests for the room window (goal P3, 2026-11-21)

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

### Getting in: room reach and clear login texts (goal G1, 2026-11-21)

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

### Find keeps the unread marker (2026-11-21)

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

### The 1.0 release order (2026-11-21)

The operator decided that 1.0 is a full-featured release that comes before the friends get it.
`docs/WORK_PLAN_1.0.md` and the README roadmap give the new order:

1. All 1.0 features: screenshare (7B), resume of large transfers (8), the ready check (9) and a per-user installer
   with start at Windows sign-in. These items have no field gate before 1.0. Each exit before 1.0 is a 127.0.0.1
   check or a check on this PC.
2. The security audit and the fixes that the operator accepts.
3. The 1.0.0 freeze and its checks on this PC.
4. After 1.0: the game nights and card 9 are field checks of 1.0. A field fault gives a 1.0.x build.

The upgrade checks from 0.7.0 and 0.6.0 and the mixed-version checks move after 1.0.

### App icon in Windows (2026-11-21)

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

### Polish pass on the room window (2026-11-21)

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
