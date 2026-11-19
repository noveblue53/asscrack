# Work order: milestone 3, manual status (2026-11-19)

**Operator, 2026-11-19:** "if it is possible to continue without conflicting changes, then continue with your proposal as intended." Then `/goal complete milestone 3`.
**Source of the packages:** `docs/WORK_PLAN_1.0.md`, section 3. `GOAL.md` in this folder.
**Language:** ASD-STE100.
**Branch:** `opus/manual-status`, base `c42baf5`.

## Protocol (decision D2 in DECISIONS.md)
- Wire line on the open chat session: `{"type":"presence","v":1,"state":"available"|"away"|"dnd","note":"<text>"}`.
- The node sends its current state on each session open, after `hello`, and to all sessions on each change.
- The node keeps its own state for the life of the node. A new node starts with `available` and an empty note.
- The note has a maximum of 80 Unicode code points. The sender and the receiver cut a longer note to 80 code points. The receiver ignores a line with an unknown `state` or a `note` that is not a string.
- The receiver accepts a line only from the current session of that peer (`sessions.get(peerId) === session`).
- On peer leave, the node deletes the state of that peer. A close event of a replaced session changes nothing.
- A peer with no presence line has the state "unknown" (an old client). The node keeps no history entry for presence.

## WP2-N. Network: presence control
- **What:** add the presence control to `src/network/node.mjs` and the API below. Add `test/presence.test.mjs`.
- **API:**
  - `setPresence({ state, note })` returns the stored `{ state, note }`.
  - `presence()` returns the own state.
  - `peerPresence()` returns `{ [peerId]: { state, note } }` for open sessions with a known state.
  - Event `presence` with `{ peerId, state, note }`.
  - The `peer-left` event also means "state gone".
- **Done when:**
  - `node --test test/presence.test.mjs` passes. It has one case for each item:
    - the 80 code point limit
    - the snapshot at session open
    - a late joiner
    - a replaced session (same name, new peer ID)
    - a delayed close event
    - no history entry
    - a bad line
  - `node --test test/node.test.mjs` passes.

## WP2-A. App: status UI
- **What:** carry the presence through `main.js`, `preload.cjs` and `renderer.js`. Add a state menu and a note field for the self line. Add a text badge beside the host and voice marks of each buddy line.
- **Done when:**
  - The renderer test of the status UI passes (`node --test test/presence-ui.test.mjs`).
  - The badge texts are "Available", "Away", "Do not disturb" and "status unknown".
  - DND does not call any voice function. `voice.js` and `voice-worklet.js` have no change.
  - `npm test` passes.

## WP3. Exit checks (orchestrator)
- The checks of `GOAL_ACTIVE`, WP3 lines.

## Builders
| Builder | Tier | Task | Files |
|---|---|---|---|
| net | builder-t1 rules, `general-purpose` agent, model opus | WP2-N | `src/network/node.mjs`, `test/presence.test.mjs` |
| app | builder-t1 rules, `general-purpose` agent, model opus | WP2-A | `src/application/main.js`, `src/application/preload.cjs`, `src/application/renderer.js`, `src/application/index.html`, `src/application/styles.css`, `test/presence-ui.test.mjs` |

The kit agent `agent-kit:builder-t1` is not in this session: I installed the plugin after the session start. The brief gives the builder-t1 rules.

## Rules given to the builders
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Do not commit, push or change branches.
