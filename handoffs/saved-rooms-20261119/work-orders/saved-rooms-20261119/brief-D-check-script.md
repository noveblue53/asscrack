# Brief D: the Electron check script for saved rooms (WP3, builder-t1)

## Goal
Write a script that runs the WP3 app checks in Electron under Xvfb with a real `safeStorage` backend. Reason: the
orchestrator must run the same check again after each change, and the result must be the same each time.

## Files
- You can edit only files in `work-orders/saved-rooms-20261119/evidence/wp3/` (new folder, not in Git).
- Do not edit any other file. Builder C changes the app files at the same time.

## Facts
- Project folder: `/home/user/asscrack`. Branch `opus/saved-rooms`. Node 24 is at `/opt/node24/bin`.
- The VM has Playwright: `require('playwright')` works from any folder. Use `_electron.launch()` with
  `executablePath: '<project>/node_modules/electron/dist/electron'` and the args `['<project>', '--profile', <dir>,
  '--password-store=gnome-libsecret']`.
- `--profile <dir>` gives each app copy its own user data folder (`src/application/main.js` line 18). Two copies can
  run on one computer.
- The real `safeStorage` backend needs a keyring. Run the script with this wrapper (`DECISIONS.md` S2):
  `xvfb-run -a dbus-run-session -- bash -c "echo -n testpass | gnome-keyring-daemon --unlock --components=secrets; node <script>"`.
  The orchestrator installed `gnome-keyring` in the VM.
- Existing element IDs (`src/application/index.html`): `#login-screen`, `#room-type` (a select), `#room`, `#invite-input`,
  `#login`, `#invite-toggle`, `#invite-panel`, `#invite-code` (the invite text of the room), `#messages`,
  `#message-input`, `#send`. Read `index.html` and `login()` in `src/application/renderer.js` for the name field and
  the room type values.
- New element IDs from builder C (not in the code yet):
  - `#save-room` (checkbox "Save room on this device"), `#keep-history` (checkbox "Keep local history").
  - `#saved-rooms` (list). Items `.saved-room` with `data-room-id`, button `.reopen-room` ("Reopen room").
  - `#archive-state` (text), `#archive-unlock` (button).
  - `#waiting-peer` (text "Waiting for a peer", visible while a reopened room has no peer).
- The main process writes a log line with the archive state and the `safeStorage` backend. Collect the terminal
  output (stdout and stderr of each Electron process) and the window console of each copy.

## The script: `evidence/wp3/check-saved-rooms.cjs`
Use new temporary profile folders for each run. Steps:
1. Copy H (profile PH), user name `hana`: make an internet room (keyed) with the room name `team`. Check `#save-room`
   and `#keep-history`. Log in. Read the invite text from `#invite-code`.
2. Copy M (profile PM), user name `mika`: join with the invite. Check `#save-room` and `#keep-history`. Log in.
3. Wait for a session. M sends `line-one from mika`. H sends `line-two from hana`. Each copy shows both lines.
4. Close both copies. Make sure that no Electron process of the run stays.
5. Start M alone (no peer). `#saved-rooms` has one `.saved-room`. Click its `.reopen-room`. Within 3 seconds, the
   chat shows both lines and `#waiting-peer` is visible.
6. Close M. Start M again. Make a second internet room with the same room name `team` and the user name `mika` (a new
   key). Check `#save-room` and `#keep-history`. Log in. Read the invite. Start H again. H joins with this invite, with
   no save. Wait for a session. M sends `line-three from mika`. Close both copies.
7. Start M alone. `#saved-rooms` has two items. Reopen each one in a new start of M. The first room shows lines one and
   two, and not line three. The second room shows line three, and not lines one and two.
8. Print one JSON result with these items:
   - each check with `pass` or `fail`
   - the archive log line of each copy (with the backend)
   - each terminal or console line that has `error` or `Error` in it
- Each wait has a timeout of 30 seconds or less. On a timeout, the check fails, and the script continues to the end and
  closes all copies.

## Done when
- The script exists and runs to the end under the wrapper. Before builder C stops, the new element IDs are not
  there, and those checks fail. The orchestrator tells you when builder C stops. Then run the full script again and
  fix only errors of the script.
- Report the JSON result of the last run, with the label 127.0.0.1.

## Rules
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Do not run `npm test`.
