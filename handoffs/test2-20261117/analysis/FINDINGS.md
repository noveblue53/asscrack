# Test 2 findings (2026-11-17)

Source: `test2_analysis.py`, `TEST2_ANALYSIS.json`, the reproduction results `history-net.json` and
`history-app-*.json` in this folder, and the operator evidence in `../evidence/original/operator/`. (M) is a measured
value. (I) is an inference.

The field test is LAN test card 2 with `ASSCRACK-0.2.0-portable.exe` on 2 computers. The operator gave the result in
chat, through the session "Advisor Opus". All reproduction results are from one PC (127.0.0.1). They are not LAN
results.

## Conventions

- Case a: the host that closes sent `before voice`. Case b: the node that stays sent it.
- In `history-net.json`, `dt = 0` is the first `peer-joined` event of the restarted node, in ms.
- The reproduction kills the host process (TerminateProcess). The restarted node is a new process with a new peer ID.
- Network check: `.repro/checks/history-net.mjs` with `history-worker.mjs` (2 Node processes, mDNS, the default
  listen address of the app). Window check: `.repro/checks/history-app.mjs` (2 Electron windows, CDP, the real
  window controls).

## Q1. Which conditions failed on the LAN?

| # | Condition | Result | Source |
|---|---|---|---|
| 1 | Peer list within 20 s | PASS (M) | `report-20261117.txt` |
| 2 | Same host on all computers | PASS (M) | same |
| 3 | Each user hears each other user | PASS (M) | same |
| 4 | Mute | PASS (M) | same |
| 5 | (2 computers) the other computer becomes host within 15 s | PASS (M) | same |
| 6 | After the restart, the chat shows earlier lines | FAIL (M) | `report-20261117.txt`, `answers-20261117.txt` |
| 7 | Voice after the restart | Not tested (M) | `report-20261117.txt` |
| 8 | No red console error line | Not tested (M) | `report-20261117.txt` |

- (M) The operator did not send `before voice`. The operator sent other chat lines before the restart. After the
  restart, no earlier chat line showed in the window ("no history is passed on reconnect").
- (M) The operator saved no terminal or console output ("i didnt manually save anything").

## Q2. Does the network layer give the history to the restarted node?

Yes, on 127.0.0.1. Source: `history-net.json`.

| Item | Result |
|---|---|
| Runs (case a and b, restart 0 s and 8 s after the failover, 3 times each) | 12 |
| The restarted node has `before voice` in its history | 12 of 12 (M) |
| The restarted node made itself host | 0 of 12 (M) |
| The history line arrived after the host line | 12 of 12 (M) |
| The restarted node had the lower peer ID (it dials the host) | 4 of 12 (M) |
| Time from the session to the history | 1 to 3 ms (M) |
| Failover time of the remaining node after the kill | 3 to 4 ms (M) |

## Q3. Does the window show the history after the restart?

No. The window shows it only with the fix. Source: `history-app-*.json`.

| Build | Case | Lines in the restarted window | `before voice` shown |
|---|---|---|---|
| `main` `0ade5d9` (dev) | a | 0 (M) | no (M) |
| `main` `0ade5d9` (dev) | b | 0 (M) | no (M) |
| 0.2.0 .exe (the field build) | a | 0 (M) | no (M) |
| 0.2.0 .exe (the field build) | b | 0 (M) | no (M) |
| `opus/history-restart` `4752fd1` (dev) | a | 3 (M) | yes (M) |
| `opus/history-restart` `4752fd1` (dev) | b | 3 (M) | yes (M) |
| `opus/history-restart` `2a62b4d` (dev, with the log file) | a | 3 (M) | yes (M) |
| `opus/history-restart` `2a62b4d` (dev, with the log file) | b | 3 (M) | yes (M) |

- (M) The log files of the `2a62b4d` run, case b, are in `example-logs/`. The remaining host wrote
  `History sent to <restarted peer>: 3 messages`. The restarted node wrote `History applied: 3 of 3 messages are new`,
  and its window wrote `History shown: 3 lines`.
- (M) In all 8 runs, the restarted window sees its peer and accepts the remaining node as host. The remaining window
  has all 3 lines. No run has a console error line.
- (M) Cause, from the source: `src/application/main.js`, constant `EVENTS`, does not contain `history`. The node
  emits the history with the event `history` (`src/network/node.mjs`, `applyHistory`). The main process sends only
  the events in `EVENTS` to the window. The preload has no `onHistory`.
- (I) This is the cause of condition 6 on the LAN. The fault is in all builds since goal 2, and it is not a timing
  fault. It also agrees with the operator observation: no earlier line showed, not only `before voice`.

## Q4. The other causes that the session "Advisor Opus" asked about

| Cause | Evidence | Result |
|---|---|---|
| 1. The restarted node becomes host, or the pending-history path drops the line | 0 of 12 self-elections. The history came after the host line in 12 of 12 runs. On 127.0.0.1 the session opened within milliseconds, so a session after the 3 s election delay did not occur. (I) A late session cannot make the node host: a node with no session never elects itself (election rule 4) | Not seen (M, 127.0.0.1) |
| 2. The session with the host opens late, or the dial direction is wrong | The restarted node opened the session in 4 of 12 runs. The remaining node opened it in 8 of 12. All 12 pass | Not seen (M, 127.0.0.1) |
| 3. The window does not show `history` events | 0 lines in 4 of 4 runs before the fix, 3 lines in 4 of 4 runs after it | Seen. This is the cause (M) |
| 4. mDNS gives a second session, or a session that closes and opens again | `attachChat` stops a second session for one peer. One PC cannot show LAN mDNS behavior | Not known (I) |

## Q5. Peer names on 0.2.0

- (M) The operator: "at least on 0.2.0, the user names did not populate until that user sent a message"
  (`names-20261117.txt`).
- (I) This is the known 0.2.0 behavior (test card 2, step 2). Decision 26 fixed it in 0.3.0 with the `hello` line.
  Test card 3, condition 1, gives the LAN result of that fix.

## Decisions

- Fix the window, not the network layer (DECISIONS 37). Branch `opus/history-restart`, commit `4752fd1`.
- Give the app its own log file, because the operator does not save the output by hand (DECISIONS 38). Commit
  `2a62b4d`. (M) `Tee-Object` got no output from the 0.3.0 portable .exe in 12 s, in 2 trials. The dev build gave
  594 bytes in the same setup.
- Test cards 2 and 3 tell the operator to copy the log files. Test card 2 gives the known fault (commit `aeff7c7`).
- The orchestrator fixed two faults in the check scripts (DECISIONS 39). They do not change a result in this file.

## The tested build

- (M) `dist/ASSCRACK-0.2.0-portable.exe` in the repository: SHA-256
  `d02f70a77fa65837f16a05821d1cb747492f2b1a4e2b98f54b934a56e722297d`, 96,392,368 bytes. The window runs used this file.
- Not known: if the copies on the test computers are the same file. This handoff does not have the 96 MB file.

## Reproduction scripts

`history-net.mjs`, `history-worker.mjs` and `history-app.mjs` in `scripts/` are copies of the orchestrator scripts
in `.repro/checks/`. Usage is in the first lines of each file.

## Not known

- A session that opens after the 3 s election delay of the restarted node. 127.0.0.1 did not give this case.
- The LAN logs of the field test. The operator saved no files, so the network events on the LAN are not known.
- Cause 4 (mDNS on a LAN). The next LAN test with the app log file can show it.
- Condition 7 (voice after the restart) and condition 8 (console errors) on the LAN.
- This analysis has no plot, because there is no time history from the field.
