# Test 2 handoff: chat history after a restart (2026-11-17)

- Work branch `opus/history-restart`, work commit `aeff7c7`. The fix is in `4752fd1` (window) and `2a62b4d` (log file).
- Tested field build: `ASSCRACK-0.2.0-portable.exe`, SHA-256 `d02f70a7`. Fix build: 0.3.1 (`dbea27ef`, decision 40).
- Language: ASD-STE100. (M) is a measured value. (I) is an inference. All reproduction results are 127.0.0.1 results.

## Result

| Condition | Result | Evidence |
|---|---|---|
| Test card 2, conditions 1 to 5 (LAN, 2 computers) | PASS (M) | `evidence/original/operator/report-20261117.txt` |
| Condition 6: the chat shows earlier lines after a restart (LAN) | FAIL on 0.2.0 (M) | `report-20261117.txt`, `answers-20261117.txt` |
| Cause of condition 6 | The window did not show the `history` event. The network layer had the history in 12 of 12 runs (M, 127.0.0.1) | `analysis/FINDINGS.md` Q2 and Q3 |
| Fix (127.0.0.1) | Before the fix, the restarted window showed 0 earlier lines in 4 of 4 runs. After it, 3 lines in 4 of 4 runs (M) | `analysis/history-app-*.json` |
| Fix on the LAN | PASS on 0.3.1, test card 4, condition 8, 2 computers (M) | handoff `test4-20261117` |
| Conditions 7 and 8 on 0.2.0 | **Not done** on 0.2.0. Test card 4 tested them on 0.3.1 | `report-20261117.txt` |

## What changed

- `src/application/main.js` sends the `history` event to the window (`4752fd1`).
- `src/application/renderer.js` shows each history line in the sequence of its time (`4752fd1`).
- The app writes one log file at each start (`2a62b4d`).
- Test cards 2 and 3 tell the operator how to keep the log files (`aeff7c7`).

## Points for the operator

1. The fix is in the window, not in the network layer (decision 37). The network layer gave the history to the
   restarted node 1 to 3 ms after the session opened, in 12 of 12 runs.
2. The app writes its own log file, because `Tee-Object` got no output from the portable .exe (decision 38).

## What did not change

- The network layer, the host election, the voice and the file transfer.

## Files

- `WORK_ORDER.md`: the work order of the fix.
- `evidence/original/operator/`: the operator texts of the field test, as given.
- `analysis/FINDINGS.md`: the findings, by question.
- `analysis/test2_analysis.py`, `analysis/TEST2_ANALYSIS.json`: the analysis script and its result.
- `analysis/history-net.json`, `analysis/history-app-*.json`: the reproduction results (127.0.0.1).
- `analysis/example-logs/`: 2 app log files from a check run on one PC. They are not field evidence.
- `scripts/`: copies of the reproduction scripts.
- `MANIFEST.json`: SHA-256 and size of each file.
