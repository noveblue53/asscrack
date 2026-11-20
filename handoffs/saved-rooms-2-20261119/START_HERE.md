# Handoff: milestone 6 part 2, live chat and the archive agree, goal complete (2026-11-19)

- **Main:** `b2ac72f` (pushed). It merges `opus/saved-rooms-2` (`e29d53e`) into `main` (`5982914`). The operator
  accepted the merge on 2026-11-20 ("Merge and push"). The operator approved this handoff push on 2026-11-20.
- **Generated files:** none. This goal made no `npm run dist` build.
- **Result labels:** all results are 127.0.0.1 results on a Linux cloud VM (Node 24.22.3, Electron 40.5.0 under
  Xvfb, `safeStorage` backend `gnome_libsecret`). No LAN, internet or Windows result.
- **Language:** ASD-STE100.

## Result

| Condition | Result | Evidence |
|---|---|---|
| A1: a send with `accepted: 0` is not in `history()` and not in a later replay | Pass | `test/send-record.test.mjs`, `DECISIONS.md` P8 |
| A2: a `live` event for a line whose ID came first in a host replay | Pass | same file, P8 |
| B1: `test/room-archive.test.mjs` and `test/saved-rooms.test.mjs` | Pass. 34 of 34 | P9 |
| B2: paging, Clear with tombstones, three limits, failed write, keep history off and on, Forget | Pass | P9 |
| B3: 250 rows: 200 rows, then one page of 50, each ID one time | Pass | `test/room-archive.test.mjs` |
| C1: `npm test`, other than the known intermittent `test/voice-direct.test.mjs` failure | Pass | `evidence/orch/e1-npmtest.txt` |
| D1, D2: Electron check script, 2 profiles | Pass. 18 of 18 | `evidence/check/check-part2.cjs`, `evidence/check/d2-out.json` |
| E1: `npm test` | 267 of 268. The 1 failure is `test/voice-direct.test.mjs`. The base also fails it: 1 of 5 runs on the base, 1 of 5 on the branch. Not caused by this change | `evidence/orch/e1-npmtest.txt`, `evidence/orch/voice-direct-compare.txt` |
| E2: one app start with no error line, and `test/rejoin.test.mjs` | Pass. 0 error lines. 3 of 3 | `evidence/orch/e2-appstart.out`, `evidence/orch/app-start-logs/`, `evidence/orch/e2-rejoin.txt` |
| E3: terminal demo, one line in each direction | Pass through mDNS. With a typed address: base 2 of 6 pass, branch 2 of 6 pass. Not caused by this change | `evidence/orch/e3-compare.txt` |
| E4: `CHANGELOG.md` and `README.md` notes | Pass | commits `e29d53e`, `b2ac72f` |
| Packaged Windows, LAN and internet checks | **Not done.** The operator does them later | `CHANGELOG.md` |

(All paths in the Evidence column are under `work-orders/saved-rooms-2-20261119/`, except `DECISIONS.md` and the
test files.)

## What changed
- `src/network/node.mjs`: a send that no session accepted does not go in the history. A new event `live` comes for
  each valid live line. A new option `seedHistory` puts records in the history at start.
- `src/application/room-archive.mjs`: paging with a `(time, msg_id)` cursor, `clearMessages`, `roomUsage`, limits of
  10,000 rows and 8 MiB for each room and 64 KiB for each row, and an index. `user_version` is 2.
- `src/application/saved-rooms.mjs`: the write result, `notify`, tombstones after Clear, `setKeepHistory`, `clear`,
  `forget` with `forgetHints`, and `activeInfo`. The archive listens to `live`.
- `src/application/main.js`, `preload.cjs`: IPC for paging, keep history, Clear and Forget. The send result has
  `saved` and `saveError`. Window events `line-saved` and `save-failed`.
- `src/application/renderer.js`, `saved-rooms-ui.js`, `reading.js`, `index.html`, `styles.css`:
  - the local-only and saved marks
  - the room storage controls, and Forget on the login screen
  - older lines at the top, with the reading position kept
  - the saved lines after a login into a saved room
- Tests: new `test/saved-rooms-ui.test.mjs`. New and changed cases in `test/send-record.test.mjs`,
  `test/room-archive.test.mjs`, `test/saved-rooms.test.mjs`, `test/history.test.mjs` and
  `test/quote-history.test.mjs`.

## Points for the operator
1. A send that no peer got now stays only in that window. It is not saved, and a host replay does not send it
   later. Reason: the plan says "Keep that entry local and exclude it from future host replay" (P3).
2. Two tests used such a send to fill the host history before a replay. They now use the node option
   `seedHistory`. Their replay checks did not change (P8).
3. Limits: 10,000 lines and 8 MiB for each room, 64 KiB for each line. The oldest lines go first (P6).
4. Clear keeps the cleared IDs in memory until the app closes. Then a late copy of a cleared line cannot come back
   into the archive (P7).
5. Forget is only on the login screen. It also deletes the room hint files under `userData/rooms/` (P7).
6. A separate finding for a later goal: the terminal demo with a typed address can fail when mDNS finds the peer at
   the same time. The base has the same failure rate (P9, E3).

## What did not change
- The wire format, the room key, the invite format, the archive key file and the room fingerprint.
- LAN rooms stay live sessions with no save. Host replay is still not saved.
- Part 3 (replay seed in the app, merged endpoints, refreshed invites, frame bounds) and part 4 (release checks).

## Files
- `START_HERE.md`: this file.
- `WORK_ORDER.md`: the work order (a copy of the one in the goal folder).
- `DECISIONS.md`: decisions P1 to P10 of this goal.
- `work-orders/saved-rooms-2-20261119/`: `GOAL.md`, `GOAL_ACTIVE`, `CONTINUE.md`, `WORK_ORDER.md` and the briefs B, C and D.
- `work-orders/saved-rooms-2-20261119/evidence/check/`: the check script of part 2, the part 1 script and the D2
  output.
- `work-orders/saved-rooms-2-20261119/evidence/orch/`: the baseline and final `npm test` logs, the comparisons, the
  app start script, output, logs and screenshots, and the terminal demo logs.
- `MANIFEST.json`: SHA-256 and size of each file.
