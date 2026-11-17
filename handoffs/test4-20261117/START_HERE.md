# Test 4 handoff: LAN test card 4 with 0.3.1 (2026-11-17)

- Work branch `opus/lan-results-0.3.1`, work commit `e5f8f4a` (also on `main`).
- Tested build: `ASSCRACK-0.3.1-portable.exe`, SHA-256 `dbea27ef`. Each test log starts with `ASSCRACK 0.3.1`.
- Language: ASD-STE100. (M) is a measured value. (I) is an inference.

## Result

| Condition | Result | Evidence |
|---|---|---|
| 1 to 3 and 5 to 9 (LAN, 2 computers) | PASS (M) | `evidence/original/operator/report-20261117.txt`, the 4 logs |
| 4: Refuse on a third computer | PASS with a changed procedure on 2 computers (M). Refuse during a transfer to another receiver has **no LAN test** | `computers-20261117.txt`, the `file-refused` line |
| 8: chat history after a restart | PASS (M). The history came 3 to 4 ms after the session, and the window showed it 1 ms later | `analysis/FINDINGS.md` Q2 |
| 10: no red console line | PASS from the log files (M): 0 `WARN` or `ERROR` lines | `analysis/FINDINGS.md` Q3 |
| 11: log files on each computer | PASS (M): 2 files from each computer | `evidence/original/this-pc/`, `other-pc/` |
| Which side cancelled offer `d36231ed` | **Not known.** The 0.3.1 log lines have no `direction` and no `by` field | `analysis/FINDINGS.md` Q4 |

## What changed

- No code changed in this work. Commits `39747be`, `52fa502` and `e5f8f4a` record the result in the test card and
  the CHANGELOG, and give the real log folder `%APPDATA%\asscrack\logs` (lower case).
- Later: version 0.4.0 adds the `direction` and `by` fields to each file log line (decisions 44 and 45).

## Points for the operator

1. Condition 4 is a pass with a changed procedure, not a pass on 3 computers (decision 41).
2. The log files of the other PC contain its Windows user name in paths. The operator approved the push in chat. The
   analysis output masks the user names.

## What did not change

- The tested build and the code. The analysis reads the logs only.

## Files

- `evidence/original/this-pc/`, `evidence/original/other-pc/`: the 4 app log files of the test, as given.
- `evidence/original/operator/`: the operator texts of the test.
- `evidence/original/not-test-evidence/`: one log of a check run on this PC. It is not test evidence (see its
  `README.txt`).
- `analysis/FINDINGS.md`: the findings, by question.
- `analysis/test4_analysis.py`, `analysis/TEST4_ANALYSIS.json`: the analysis script and its result.
- `WORK_ORDER.md`: the request and the work.
- `MANIFEST.json`: SHA-256 and size of each file.
