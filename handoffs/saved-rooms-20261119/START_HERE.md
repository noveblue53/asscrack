# Handoff: saved rooms, milestone 6 part 1, goal complete (2026-11-19)

- **Purpose:** keep the local goal files and the evidence of the complete goal.
- **Main:** `5982914` (pushed). It merges `opus/saved-rooms` (`b5b5228`) into `main`. The operator accepted the merge
  (question form, `DECISIONS.md` S11).
- **Result labels:** all results are 127.0.0.1 results on a Linux cloud VM. No LAN, internet or Windows result.
- **Language:** ASD-STE100.

## Result

| Condition | Result | Evidence |
|---|---|---|
| WP1: baseline and binding choice | Pass | `DECISIONS.md` S1, S4, S6 |
| WP2: fingerprint, key and row tests | Pass. `test/room-archive.test.mjs` 13 of 13 | S8 |
| WP2: `npm test` | Pass. 214 of 214 | S8, `evidence/wp3/orch/wp2-npmtest.console.txt` |
| WP3: save, close, reopen with no peer, read the line (Electron, Xvfb, `gnome_libsecret`) | Pass | S10, `evidence/wp3/orch/wp3-e2e-orch.txt` |
| WP3: second saved room, same user name, other key, only its own chat | Pass | same file |
| WP3: one app start, no error line; `test/rejoin.test.mjs` | Pass. 0 error lines in the app log. 3 of 3 | S10, `evidence/wp3/orch/` |
| WP3: `CHANGELOG.md` and `README.md` notes | Pass | commit `4d30b77` |
| Merged tree (after 5C): check script 11 of 11, `npm test` 241 of 241 | Pass | S12, `.repro` copies in `evidence/wp3/orch/` |

## Known items
- The app start terminal has 5 VM lines (D-Bus, `NODE_OPTIONS`). The base commit has the same lines.
- `test/voice-direct.test.mjs` fails some of the time on the base too (4 of 5 runs on `ec546d0`). S9.
- The check script types `127.0.0.1:<port>` as the public address. It does not cover UPnP. S10.

## Open checks for the operator (packaged Windows)
- The .exe reports a SQLCipher version (`sqlite3mc_version()`).
- A restart with no network reads the saved line. The profile stays after the .exe moves.
- A different Windows account cannot read the archive.
- The Windows build with `"npmRebuild": false` (two N-API modules: `better-sqlite3-multiple-ciphers`, `uiohook-napi`).
- LAN and internet checks of milestones 2, 3, 5C and 6.

## Next goal
Milestone 6 part 2 and later (`docs/WORK_PLAN_1.0.md`, section 6): the other items of part 2, the replay seed,
refreshed invites and frame bounds.
