# Work order: chat history in the window after a restart (2026-11-17)

**Operator, 2026-11-17 (through the session "Advisor Opus"):** test card 2, condition 6: "i didnt see anything that
said "before voice"".
**Source of the package:** `handoffs/test2-20261117/analysis/FINDINGS.md`.
**Language:** ASD-STE100.

## Step 1: show the history lines in the window

- **What:** The network layer gets the chat history from the host and emits the event `history`. The Electron main
  process does not send this event to the window. Thus the window does not show the history. Send the event to the
  window, and show each history line in the message list in the sequence of its time.
- **Done when:**
  1. `node --test test/app-events.test.mjs` fails on `main` (`0ade5d9`) and passes after the change.
  2. `npm test` exits with 0.
  3. The orchestrator check `.repro/checks/history-app.mjs` (2 Electron instances on 127.0.0.1) gives
     `restartedWindowHasBeforeVoice: true` in case a and in case b.
  4. One start of the app (`npm start`) has no error line.
- **Then (operator):** test card 2, step 8 and conditions 6 to 8, on a new build.

## Step 2: a log file and history log lines

- **What:** The app writes its own log file. The node writes a line when it sends, applies, keeps or drops history.
  Reason: the operator saved no logs in the LAN test of test card 2.
- **Done when:**
  1. `node --test test/node.test.mjs` and `node --test test/app-events.test.mjs` pass.
  2. `npm test` exits with 0.
  3. In the window check, the log files show `History sent`, `History applied` and `History shown`.
- **Then (operator):** copy the log files after the next LAN test.

## Step 3: the log step in test cards 2 and 3 (orchestrator)

- **What:** Tell the operator to copy the log files. Give the known fault of condition 6 in test card 2.
- **Done when:** the new card lines lint with 0 findings.

## Results

| Step | Commit | Result |
|---|---|---|
| 1 | `4752fd1` | PASS. Test fails 3 of 3 before, passes 3 of 3 after. Window check 2 of 2 |
| 2 | `2a62b4d` | PASS. `npm test` 36 of 36. Window check 2 of 2, with the 3 history lines in the logs. App start and terminal demo pass |
| 3 | `aeff7c7` | PASS. 0 lint findings |

All results are from one PC (127.0.0.1). They are not LAN results.

## Builders

| Builder | Tier | Task | Files |
|---|---|---|---|
| step 1 | `agent-kit:builder-t1` | Send `history` to the window and show it | `src/application/main.js`, `src/application/preload.cjs`, `src/application/renderer.js`, `test/app-events.test.mjs` (new) |
| step 2 | `agent-kit:builder-t1` (same agent) | A log file and history log lines | `src/network/node.mjs`, `src/application/main.js`, `src/application/renderer.js`, `test/node.test.mjs`, `test/app-events.test.mjs` |
| step 3 | orchestrator | The log step in the test cards | `src/network/chatreadme.md` |

The work is in the worktree `D:/wt/hr` on the branch `opus/history-restart` from `main` (`0ade5d9`).

## Rules given to the builders

- Do not change an acceptance limit.
- Do not change original evidence.
- Use all CPUs at low priority. Do not start the full regression.
- Do not commit, push or change branches. Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
