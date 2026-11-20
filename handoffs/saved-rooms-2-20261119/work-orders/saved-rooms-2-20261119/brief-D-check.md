# Brief D: the Electron check script for part 2 (package D, builder-t1)

## Goal
Write a script that runs the part 2 app checks in Electron under Xvfb with a real `safeStorage` backend. Reason: the
orchestrator must run the same check again after each change, and the result must be the same each time.

## Files
- You can edit only files in `work-orders/saved-rooms-2-20261119/evidence/check/` (not in Git).
- Do not edit any other file. Builder C changes the app files at the same time.

## Facts
- Project folder: `/home/user/asscrack`. Branch `opus/saved-rooms-2`. Use Node 24:
  `export PATH=/opt/node24/bin:$PATH`.
- Start from the part 1 script: `work-orders/saved-rooms-2-20261119/evidence/check/check-saved-rooms-part1.cjs`. It
  shows the start of two app copies, the login, the invite, the wait for a session and the close. Copy what you
  need into a new script `check-part2.cjs`. Do not change the part 1 script.
- The VM has Playwright: `require('playwright')` works from any folder. Electron runs as root, thus give
  `--no-sandbox`.
- The real `safeStorage` backend needs a keyring. Run the script with this wrapper:
  `xvfb-run -a dbus-run-session -- bash -c "echo -n testpass | gnome-keyring-daemon --unlock --components=secrets; node <script>"`.
  `gnome-keyring` is installed.
- Element IDs and classes: `work-orders/saved-rooms-2-20261119/WORK_ORDER.md`, section "Interfaces", part "Window",
  and section "Texts". Builder C makes them at the same time. They are not in the code yet.
- Part 1 element IDs (in the code): `#save-room`, `#keep-history`, `#saved-rooms`, `.saved-room`, `.reopen-room`,
  `#waiting-peer`, `#archive-state`, `#invite-code`, `#messages`, `#message-input`, `#send`.
- Use numbered message texts, for example `m001 from mika`. Count the lines in `#messages` with each text. A
  duplicate line is a failure.

## The script: `evidence/check/check-part2.cjs`
Use new temporary profile folders for each run. Copies H (user `hana`) and M (user `mika`).
1. H makes an internet room `team` with `#save-room` and `#keep-history` checked. M joins with the invite with the
   same two boxes checked. Wait for a session.
2. M and H send 250 numbered lines together: M sends `m001` to `m125`, H sends `h001` to `h125`, one after the
   other. Each copy shows each text one time.
3. On M: each own line and each received line gets the class `saved` (wait at most 30 s). Record the count of
   `li.saved`.
4. Close both copies. Start M alone. Reopen the room. The list shows 200 lines and `#messages` has
   `data-older="more"`. Scroll `#messages` to the top. 50 older lines come. Record the text of the first visible
   line before and after the load. The first visible line before the load must be visible after it, at almost the
   same place (difference of 30 pixels or less). After all pages, the list has 250 lines, each text one time, and
   `data-older="none"` comes after a scroll to the top.
5. M alone: send `alone-1`. Its line has the class `local-only` and the text "Only on this computer". It does not
   have the class `saved`.
6. M alone: uncheck `#room-keep-history`. `#history-state` shows "Saving is off. Saved messages stay." Close M.
   Start M, reopen: `#room-keep-history` is not checked. Start H, H reopens too. Wait for a session. H sends
   `off-1`. Then M checks `#room-keep-history`. H sends `on-1`. Close both. Start M alone and reopen: `on-1` shows,
   and `off-1` does not show.
7. M: click `#clear-history`. `#clear-confirm` is visible with the Clear explanation text. Click
   `#clear-confirm-no`: nothing is deleted. Click `#clear-history`, then `#clear-confirm-yes`. Close M. Start M
   alone and reopen: 0 lines. `#room-keep-history` is checked.
8. M on the login screen: click `.forget-room`, then `.forget-no`: the room stays. Click `.forget-room`, then
   `.forget-yes`: `#saved-rooms` has no item. Close M. Start H alone. H still has the room, and its reopen shows
   lines.
9. Print one JSON result: each check with `pass` or `fail` and a short detail, and each terminal or console line
   that has `error` or `Error` in it.
- Each wait has a timeout of 30 seconds or less. On a timeout, the check fails, and the script continues to the end
  and closes all copies.

## Done when
- D1: the script runs to the end and prints one JSON result, with each check `pass` or `fail`. Before builder C
  stops, the new element IDs are not there, and those checks fail. That is correct.
- D2: the orchestrator tells you when builder C stops. Then run the full script again. Correct only errors of the
  script. Report each check that still fails, with the detail. Do not change app files.
- Report the JSON result of the last run, with the label 127.0.0.1.

## Rules
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Do not add a package to `package.json`.
- Make sure that no Electron process of the run stays after the script ends.
