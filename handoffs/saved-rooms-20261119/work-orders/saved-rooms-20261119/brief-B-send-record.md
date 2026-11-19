# Brief B: one canonical record for each send (WP2, builder-t1)

## Goal
The node must give one message record for each send: ID, sender, text, time and the number of sessions that accepted
the line. Reason: the app shows this record and saves it in the archive. Thus the screen and the archive use the same
ID and time.

## Files
- You can edit only these files:
  - `src/network/node.mjs` (only the `send(text)` method of the returned node object, about line 1153)
  - `test/send-record.test.mjs` (new)
- Do not edit any other file.
- Do not change `src/application/voice.js` or `src/application/voice-worklet.js`.

## Facts
- Project folder: `/home/user/asscrack`. Base commit: `cd1e3de` on branch `opus/saved-rooms`.
- Node 24 is at `/opt/node24/bin`. Put it first on `PATH` for each command. The default `node` in this VM is Node 22.
- Today `send(text)` makes `{ id: randomUUID(), from: senderName, text, time: Date.now() }`, adds it to `history`,
  sends `JSON.stringify(message)` to each session and returns the number of sessions where `session.send(line)` was
  true.
- About 20 tests and `src/network/transceiver.mjs` (line 41) use the number that `send(text)` returns. Keep it.
- A received line gives the event `message` with `{ peerId, id, from, text, time }` (`node.mjs` about line 508).
- Test patterns: `test/node.test.mjs` starts real nodes on 127.0.0.1 (`createAsscrackNode`, a `waitFor` helper, a
  `record()` helper for events). Copy the patterns that you need into the new test file.

## The change
- Add the method `sendRecord(text)`. It does the work of the old `send(text)`. It returns
  `{ id, from, text, time, accepted }`. `accepted` is the session count.
- `send(text)` returns `sendRecord(text).accepted`.
- The wire line does not change. It is `JSON.stringify({ id, from, text, time })`, with no `accepted` field.
- The history item does not change.

## Tests in `test/send-record.test.mjs`
- Two nodes on 127.0.0.1 with a session: `sendRecord('x')` returns a record. `accepted` is 1. The `message` event on the
  other node has the same `id`, `from`, `text` and `time`. The event has no `accepted` field.
- A node with no session: `sendRecord` returns `accepted` 0. `history()` has the record (same `id` and `time`).
- `send(text)` still returns a number (1 with one session).
- Stop each node at the end of each test.

## Done when
- `node --test test/<file>.test.mjs` passes for `test/send-record.test.mjs` and for `test/node.test.mjs` (Node 24,
  127.0.0.1).
- The terminal demo `src/network/transceiver.mjs` is not changed.

## Rules
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Builder A writes new files in `src/application/` and `test/` at the same time. Do not run `npm test`. Run only the two
  test files above.
