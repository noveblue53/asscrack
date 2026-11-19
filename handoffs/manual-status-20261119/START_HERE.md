# Handoff: manual status, milestone 3 (2026-11-19)

- **Work branch:** `opus/manual-status`, work commit `6c64b0a`. Feature commit `85ef46e`.
- **On `main`:** merge commit `598725f`. The operator accepted the package on 2026-11-19 without the LAN checks.
- **Generated files:** none. This goal made no portable .exe.
- **Language:** ASD-STE100.
- **Result labels:** all results are 127.0.0.1 results on a Linux cloud VM (Node 24.22.3, Electron 40.5.0 under
  Xvfb). There is no LAN result, no internet result and no packaged Windows result.

## Result

| Condition | Result | Evidence |
|---|---|---|
| WP1: a record of the 0.6.0 revision and its receive path for an unknown `type` | Pass. 0.6.0 is `d5ad3af`. An unknown `type` matches no branch in `onMessage` and returns. It never gets to `history.add()` | Point 1 below |
| WP1: mixed-version check, a harmless unknown control between chat lines | Pass in both dial directions. Chat continues. The 0.6.0 node shows no line and keeps no history entry | `evidence/runs/exit-checks/wp1-mixed.out` |
| WP2: `node --test` cases for the presence control | Pass, 7 of 7: 80 code point limit, snapshot at open, late joiner, replaced peer, second stream close, no history entry, bad line | `test/presence.test.mjs` |
| WP2: renderer cases for the status UI | Pass, 9 of 9 | `test/presence-ui.test.mjs` |
| WP2: `npm test` on the branch | Pass, 198 of 198 (182 old, 16 new). One earlier run failed in `test/voice-direct.test.mjs`. The change did not cause it (point 3) | `evidence/runs/npm-test/` |
| WP3: A sets Away with a note, B sees it, C joins later and sees it at once | Pass. C saw it 105 ms after the connect | `evidence/runs/exit-checks/wp3-exit.out` |
| WP3: drop and reopen A-B, then restart A with the same name and a new peer ID | Pass. The reopen keeps the state. The old peer ID has no row. The new A shows Available | `wp3-exit.out` |
| WP3: DND does not change the mic mute or the speaking mark | Pass. No voice state event after DND. The status code calls no voice function | `wp3-exit.out`, `test/presence-ui.test.mjs` |
| WP3: current node and `d5ad3af` node, both directions | Pass. The current node has no state for the old buddy ("status unknown"). The old node continues chat | `wp3-exit.out` |
| WP3: two buddies with the same name | Pass. Each keeps its own state | `wp3-exit.out` |
| WP3: one app start with no error line | Pass. Two app windows. Window B showed "Away: back at 9" for A. Only the D-Bus lines of the VM | `evidence/runs/app-start/`, `plots/` |
| WP3: `CHANGELOG.md` and `README.md` give the 127.0.0.1 results and the open checks | Pass | `CHANGELOG.md`, `README.md` at `598725f` |
| Packaged Windows check on a real LAN, with a 0.6.0 client, a host change and a reconnect | **Not done.** The operator deferred it. Operator, two Windows PCs | none |
| The same check in an internet room | **Not done.** The operator deferred it. Operator | none |

## What changed

- `src/network/node.mjs`: the control line `{"type":"presence","v":1,"state","note"}` on the open chat session.
  The node sends it when a session opens and to all sessions on each change. New API: `setPresence()`,
  `presence()`, `peerPresence()` and the event `presence`.
- `src/application/main.js`, `preload.cjs`: the IPC `asscrack:set-presence`, `asscrack:presence` and the forwarded
  event `presence`.
- `src/application/renderer.js`: one block "Manual status (milestone 3)". A menu, a note field and a Set button above
  the buddy list. A badge `.presence-mark` on each buddy line. One state read after login.
- `src/application/styles.css`: the badge colors and the control row.
- `test/presence.test.mjs`, `test/presence-ui.test.mjs`: new tests.
- `CHANGELOG.md`, `README.md`: the results and the open checks.

## Points for the operator

1. **0.6.0 compatibility (decision D1).** In `src/network/node.mjs` at `d5ad3af`, `controlMessage()` makes each JSON
   object with a `type` field a control line. Before the session opens, only `hello` and `proof` have an effect. After
   it opens, an unknown type matches no branch, and the function returns. Thus no compatible path was necessary.
2. **State rules (decision D2).** The note has a maximum of 80 code points. The sender and the receiver cut it. The
   receiver accepts a line only from the current session of that peer. The node deletes the state on leave. The node
   keeps its own state while the app runs, thus a reconnect keeps it. A new app start has the state Available.
   Nothing about the status goes into the history or the saved files. The app log has only "event presence peer
   <id>", with no note.
3. **Intermittent test failure, not caused by this change.** `test/voice-direct.test.mjs` failed 2 of 5 runs on
   `c42baf5` (`main` before this work) with `ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS`. On `598725f` it passed 5 of 5.
   The log of the one failed branch run is not kept. It showed the same error trace. This is an open item for a
   later goal.
4. **Delayed close.** The node cannot open a second session for a peer while the first is open. Only the close handler
   of the same session deletes it. The guard `sessions.get(peerId) === session` protects the state, and the delete is
   inside it. The test covers the nearest real path: a refused second stream of the same peer.
5. **UI fix by the orchestrator.** In the first app start, the note field was a small circle in the narrow buddy
   panel. It now has its own row. The screenshot of the fault was overwritten by a later run. `plots/` has the
   screenshots after the fix.
6. **Menu acts at once.** A change of the state menu sets the state at once, with the current note. Set and Enter
   also set it.
7. **Kit in this session.** I installed the kit plugin during the session. Its skills and agents did not load. The
   builders were `general-purpose` agents with the builder-t1 rules in the brief.

## What did not change

- `src/application/voice.js`, `src/application/voice-worklet.js` and the voice relay (milestone 5C owns them).
- The chat wire format, the history format and its limit of 200 lines.
- The terminal demo `src/network/transceiver.mjs`. It shows chat from a peer that sends a status, and no status line
  (`evidence/runs/exit-checks/demo.out`).
- `package.json`: no new dependency.

## Files

- `WORK_ORDER.md`: the work order of this goal.
- `analysis/wp1-mixed.mjs`: the WP1 mixed-version check. It needs the 0.6.0 code in `./old060`:
  `git archive d5ad3af src/network package.json | tar -x -C old060`, and a `node_modules` link.
- `analysis/wp3-exit.mjs`: the WP3 network exit checks. It needs `./old060` too.
- `analysis/app-start.cjs`: two app windows under Xvfb with Playwright `_electron`. A sets Away with a note.
- `analysis/demo-peer.mjs`: a peer that sends a status and a chat line to the terminal demo.
- `evidence/runs/npm-test/`: `npm test` before the CSS fix and at `ba39918`.
- `evidence/runs/voice-direct/`: 5 runs on `c42baf5` and 5 runs on `598725f`.
- `evidence/runs/exit-checks/`: the output of the WP1 check, the WP3 checks and the demo check.
- `evidence/runs/app-start/`: the script output and the app log of each window.
- `plots/app-A.png`, `plots/app-B.png`: the two windows after the fix.
- `MANIFEST.json`: SHA-256 and size of each file.
