# Test 4 findings (2026-11-17)

Source: `test4_analysis.py`, `TEST4_ANALYSIS.json`, the 4 test log files in `../evidence/original/this-pc/` and
`../evidence/original/other-pc/`, and the operator texts in `../evidence/original/operator/`. (M) is a measured value.
(I) is an inference.

The field test is LAN test card 4 with `ASSCRACK-0.3.1-portable.exe` on 2 computers. The operator gave the result in
chat, through the session "Advisor Opus". `../evidence/original/not-test-evidence/` has one log of a check run by
Claude. It is not test evidence.

## Conventions

- A is this PC (the computer of the operator). B is the other PC. This file gives a peer ID by its last 6 characters.
- Each time in a log is the clock of the computer that wrote it. The clocks are not synchronized. (M) A is 1047 ms
  ahead of B: B wrote `History sent` at 19:58:15.779, and A wrote `peer-joined` for the same session at 19:58:16.826.
  A time difference in this file is inside one log, unless the text says "across computers".
- Each computer has 2 log files: one for the first start, one for the restart.

## Q1. Which conditions passed on the LAN?

| # | Condition | Result | Source |
|---|---|---|---|
| 1 | Names before any chat message | PASS (M) | `report-20261117.txt` |
| 2 | The offer shows on the other computer | PASS (M) | same, and the `file-offer` lines |
| 3 | Accept, "Saved as", same size | PASS (M) | same, and the `file-done` lines |
| 4 | Refuse on C (3 computers) | PASS with a changed procedure, 2 computers (M) | `computers-20261117.txt`, `file-refused` line |
| 5 | Voice during the transfer | PASS (M) | `report-20261117.txt` |
| 6 | Cancel, no partial file | PASS (M), see Q4 | same |
| 7 | " (1)" name for the second copy | PASS (M) | same, and 2 `file-done` lines |
| 8 | Chat history after a restart | PASS (M) | same, and Q2 |
| 9 | Voice after the restart | PASS (M) | same, and the `voice-state` lines |
| 10 | No red console line | PASS (M) from the log files, with a limit | Q3 |
| 11 | Log files on each computer | PASS (M) | 2 files from A and 2 files from B |

- (M) Conditions 10 and 11 were not checked during the test. The log files that the operator sent after the test
  give the result.
- (M) For condition 4, the operator did Accept, then Refuse, in sequence on the same receiver. The card asks for a
  Refuse on C while B receives the file. Thus that case has no LAN test.
- (M) A sent the first 2 offers to B. B sent the last 3 offers to A. The card asks for all offers from A. Each
  computer was a sender and a receiver one or more times.

## Q2. Does the window show the chat history after a restart?

Yes. Both computers restarted one time each.

| Restart | Session to `host-changed` | Session to `History applied: 3 of 3` | Session to `History shown: 3 lines` | Host that sent it |
|---|---|---|---|---|
| A (new peer ID), log `asscrack-20261117-145811.log` | 3 ms (M) | 4 ms (M) | 5 ms (M) | B: `History sent ...: 3 messages` (M) |
| B (new peer ID), log `asscrack-20261117-145913.log` | 2 ms (M) | 3 ms (M) | 4 ms (M) | A: `History sent ...: 3 messages` (M) |

- (M) The restarted node accepted the other computer as host before the history arrived, in both restarts.
- (M) The 3 history IDs are the 3 chat lines of the first session: 1 line from A and 2 lines from B.
- (M) After B closed, A showed itself as host 1 ms after the session to B closed (`peer-left` 19:59:05.273,
  `host-changed` 19:59:05.274).
- (M) After the restart of A, B received 2 `voice-state` lines from A (19:58:29 and 19:58:32, B clock). This agrees
  with condition 9.
- (I) The LAN test closes the fault of test 2 (condition 6). Condition 8 of card 4 is the same check, and it passed
  2 times.

## Q3. Is there a console error?

- (M) The 4 test logs have 0 lines with the level `WARN` or `ERROR`. Each `WINDOW` line has the level `info`.
- Limit: the log records the console messages of the window after the app starts it. It does not record the
  developer tools of Chromium itself. Thus condition 10 is a pass from the log files, not from a look at the
  developer console.

## Q4. What do the file transfer lines show?

| Offer | Receiver | Receiver: offer to end | Sender end event |
|---|---|---|---|
| `63133016` | B | refused (A has `file-refused`) (M) | `file-refused` (M) |
| `77b5e2ba` | B | 38.2 s to `file-done` (M) | `file-done` (M) |
| `d36231ed` | A | 2.7 s to `file-cancelled` (M) | none (M) |
| `77f4d79b` | A | 15.5 s to `file-done` (M) | `file-done` (M) |
| `000a1bf9` | A | 6.5 s to `file-done` (M) | `file-done` (M) |

- (M) Each time from the offer to the end includes the time until the user selected Accept. The log has no line for
  Accept and no file size. Thus the LAN transfer speed is not known. The operator did not give the time of step 8.
- (M) For `d36231ed`, the sender B wrote no end event (no `file-cancelled`, `file-done` or `file-failed`) before
  its session closed 85 s later.
- (I) The code (`src/network/file-transfer.mjs`) explains this if B selected Cancel on its own offer before the
  transfer started. Then the sender emits no event, and the receiver emits `file-cancelled`. If A cancelled
  during the transfer, B would emit `file-cancelled` or `file-failed`. The log lines have no `direction` and no
  `by` field, so the logs cannot show which side cancelled.

## Q5. Did both computers use the same build?

- (M) Each test log starts with `ASSCRACK 0.3.1 Electron 40.5.0`.
- (M) Both computers unpacked the .exe into a folder with the same name (`3MFRiB0y...`). The 0.3.1 check run on the
  build PC used the same folder name.
- (I) Both computers used the same .exe as `dbea27ef`. The portable launcher gives the folder name. This is not a
  SHA-256 check of the copies.

## Q6. Where is the log folder?

- (M) On both computers, the log path in the first line is `%APPDATA%\asscrack\logs`, in lower case.
- (M) DECISIONS 38 and 40, test cards 2 to 4 and the CHANGELOG give `ASSCRACK` in upper case. The packaged app uses
  the name `asscrack` from `package.json`. Windows paths are not case-sensitive, so the card command works, but the
  text must agree with the real folder.

## Decisions

- Condition 4 is a pass with a changed procedure on 2 computers, not a pass on 3 computers (DECISIONS 41).
- The test cards and the CHANGELOG change to `%APPDATA%\asscrack\logs` (DECISIONS 41).
- Deferred: give the `direction` and the `by` field in the log line of each file event. Then a log can show which
  side cancelled.

## Not known

- Which side cancelled offer `d36231ed`.
- The LAN transfer speed. The log has no file size and no Accept time.
- A Refuse by a third computer while another computer receives the file, on a LAN.
- If the copies of the .exe are byte for byte the same as `dbea27ef`.
