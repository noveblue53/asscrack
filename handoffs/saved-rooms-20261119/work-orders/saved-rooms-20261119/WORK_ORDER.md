# Work order: milestone 6 part 1, saved rooms (2026-11-19)

**Operator, 2026-11-19:** "Complete milestone 6 part 1 of ASSCRACK as GOAL.md gives it."
**Source of the packages:** `docs/WORK_PLAN_1.0.md`, section 6, part 1 and the first item of part 2. `GOAL.md` in this folder.
**Language:** ASD-STE100.
**Result label:** each result in this VM is a 127.0.0.1 result.

## WP1. Baseline and the choice of the encrypted store (study, no code)
- **What:** Record the baseline. Study the SQLCipher bindings for Electron 40. Record the `safeStorage` backend of this VM. Ask the operator to approve the new dependency.
- **Done when:**
  - `DECISIONS.md` records the baseline (SHA, Node and Electron versions, `npm test` count) and the binding choice with the reasons and the sources.
  - `GOAL_WAIT` asks the operator to approve the new dependency (name, version, license, size, native build path).
- **Then (operator):** approve or refuse the dependency.

## WP2. Encrypted store in the main process (after the approval)
- **What:** A store module in the main process. It has these parts:
  - a versioned full-width room fingerprint
  - a random profile key wrapped with `safeStorage`
  - a locked state with no plaintext fallback
  - one row for each (room ID, message ID)
- **What (node):** The node gives one canonical message record for each send.
- **Done when:**
  - `node --test` cases for the fingerprint: the same name with a different key, and an encoding with only one meaning.
  - `node --test` cases for the key: a missing key file, a key that does not unwrap, and an interrupted first start.
  - `node --test` cases for the rows: one row for each (room, message ID). A plain SQLite open and a wrong key cannot read a row.
  - `npm test` passes on the branch (127.0.0.1). For each failed test, the same test also ran on `main`, and the report says if the change caused it.

## WP3. The smallest usable slice in the app (Xvfb in this VM)
- **What:** "Save room on this device" with "Keep local history", "Reopen room" and "Waiting for a peer" in the app.
- **Done when:**
  - Electron under Xvfb, new profile (127.0.0.1): save a keyed room and send and receive one chat line. Close all processes. Start with no peer, reopen the room and read the line. `DECISIONS.md` records the `safeStorage` backend.
  - A second saved room with the same user name and a different key shows only its own chat.
  - One app start with no error line in the terminal or the developer console (Xvfb). `test/rejoin.test.mjs` passes.
  - `CHANGELOG.md` and `README.md` on the branch give the results with the label 127.0.0.1. They tell the difference between encrypted peer connections and encrypted local storage. They list the open packaged Windows checks.
- **Then (operator):** the packaged Windows checks in `GOAL.md`, "Open checks for the operator".

## Builders
| Builder | Tier | Task | Files |
|---|---|---|---|
| binding study | t1 (general-purpose, opus) | WP1 study of the SQLCipher bindings | scratchpad `wp1/` only |
| A (round 2) | t1 | WP2 store and tests (`brief-A-room-archive.md`) | `src/application/room-archive.mjs`, `test/room-archive.test.mjs` |
| B (round 2) | t1 | WP2 node record (`brief-B-send-record.md`) | `src/network/node.mjs` (`send`), `test/send-record.test.mjs` |
| C (round 3) | t1 | WP3 app integration (`brief-C-app.md`) | `main.js`, `preload.cjs`, `renderer.js`, `index.html`, `styles.css`, new `saved-rooms.mjs`, `saved-rooms-ui.js`, `test/saved-rooms.test.mjs` |
| D (round 3) | t1 | WP3 Electron check script (`brief-D-check-script.md`) | `evidence/wp3/` only |

## Rules given to the builders
- The builder-t1 rules of `/opt/agent-kit/agents/builder-t1.md`, in each brief.
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Do not change `src/application/voice.js` or `src/application/voice-worklet.js` (milestone 5C).
- Do not change `package.json` before the operator approves the dependency.
