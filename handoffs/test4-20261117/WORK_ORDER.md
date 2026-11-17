# Work order: analysis of LAN test card 4 (2026-11-17)

**Operator, 2026-11-17 (through the session "Advisor Opus"):** the result of test card 4 with 0.3.1 on 2 computers,
and the 4 app log files. The operator texts are in `evidence/original/operator/`.
**Language:** ASD-STE100.

## Package
- **What:** copy the evidence without changes, and analyze the 4 logs with a read-only script. Record the result in
  the test card and the CHANGELOG (skill `field-analysis`).
- **Done when:**
  - Each condition of test card 4 has a result with its evidence in `analysis/FINDINGS.md`.
  - `python -I analysis/test4_analysis.py` writes `analysis/TEST4_ANALYSIS.json` with the SHA-256 of each input.
  - The CHANGELOG and the test card give the real log folder.

## Builders
| Builder | Tier | Task | Files |
|---|---|---|---|
| orchestrator | - | the analysis and the records | `analysis/`, `CHANGELOG.md`, `src/network/chatreadme.md` |

## Rules
- Do not change original evidence.
- A test on 127.0.0.1 is not a LAN result.
