# Goal: milestone 6 part 1, a saved room with an encrypted local line (step 4 of the 1.0 plan)

## Operator words
- 2026-11-19: "I think we should defer the lan testing until later."
- 2026-11-19 (after milestone 3): "yes to both. please write a goal for the next milestone so i can start another
  session manually". ("Both": merge `opus/manual-status` into `main`, and push the handoff branch.)

## Why this goal
Step 2 of the 1.0 plan (milestone 3) is on `main` (`598725f`). Step 3 is the field tests, and the operator deferred
them. The plan says: when the field test must wait, do the step 4 work. Step 4 starts with milestone 6, section 1:
one encrypted saved line that a restart can read with no peer.

## Read first
1. `docs/WORK_PLAN_1.0.md`: "Release order" steps 3 and 4, all of section 6, and the overlap rules of section 5C.
   Read all of section 6, because its later parts set rules for part 1.
2. `handoffs/manual-status-20261119/START_HERE.md` on branch `origin/handoffs/manual-status-20261119`. It gives the
   decisions of milestone 3 and the open items.
3. The top entries of `CHANGELOG.md`, and the "Status" and "Known limits" sections of `README.md`.
4. `src/application/main.js` (the login handler at about line 259 and the room cache under `userData/rooms`),
   `src/application/preload.cjs`, `login()` in `src/application/renderer.js`, `send()` and the history in
   `src/network/node.mjs`, `src/network/history.mjs`, `src/network/invite.mjs`, `test/rejoin.test.mjs`.

## Branch
`opus/saved-rooms`, from `origin/main` (`598725f` or newer). Push it after each feature commit.

## Scope of part 1
- In scope: plan section 6, part 1 ("Prove offline reopen").
- In scope: the first item of part 2. The node gives one canonical message ID and time for each send, and returns them
  through IPC.
- Not in scope: the other items of part 2, all of part 3 (replay seed, refreshed invites, frame bounds) and part 4
  (release checks). They are the next goals.
- Keep: manual invite entry, profile settings, the existing rejoin tests, and LAN rooms as live sessions with no save.
- Do not put field-test credentials or chats in commits or reports.

## Work packages

### WP1. Baseline and the choice of the encrypted store (study, no code)
Record the baseline. Then study the SQLCipher bindings for Electron 40 (for example
`better-sqlite3-multiple-ciphers` and `@journeyapps/sqlcipher`). For each, find these items:
- the maintenance state and the support of the Electron 40 ABI
- prebuilt `win32-x64` binaries for Electron, and the asar unpack need
- the native build path in `npm run dist`
- the license and the size

 Also find what `safeStorage` does on Windows (DPAPI) and in this Linux VM
(`safeStorage.getSelectedStorageBackend()` under Xvfb).
- [ ] WP1: `DECISIONS.md` records the baseline (SHA, Node and Electron versions, `npm test` count) and the binding choice with the reasons and the sources.
- [ ] WP1: `GOAL_WAIT` asks the operator to approve the new dependency (name, version, license, size, native build path). Stop until the operator replies.

### WP2. Encrypted store in the main process (after the approval)
- A room fingerprint: versioned and full width. Make it from the decoded room key bytes and the exact room name bytes.
  Use an encoding that has only one meaning, for example length-prefixed fields. Do not use the user name, the invite
  text, the peer ID or the 8 hex digit discovery tag.
- A random profile database key, wrapped with `safeStorage`, beside the database under `userData`. The room credential
  is in protected storage. The keys stay in the main process. The preload gives only narrow room operations.
- A missing key or a key that does not unwrap: keep the archive, report it as locked, and let the user try again. No
  plaintext fallback. No silent replacement. A safe recovery from an interrupted first start.
- Messages are unique for each `(room ID, message ID)`.
- The node gives one canonical message ID and time for each send, and returns the record through IPC. The renderer
  and the archive use that record. The wire format does not change.
- Make the store take the wrap and unwrap functions as inputs, so that `node --test` can use a fake. One Electron run
  checks the real `safeStorage`.
- [ ] WP2: `node --test` cases for the fingerprint: the same name with a different key, and an encoding with only one meaning.
- [ ] WP2: `node --test` cases for the key: a missing key file, a key that does not unwrap, and an interrupted first start.
- [ ] WP2: `node --test` cases for the rows: one row for each (room, message ID). A plain SQLite open and a wrong key cannot read a row.
- [ ] WP2: `npm test` passes on the branch (127.0.0.1). For each failed test, the same test also ran on `main`, and the report says if the change caused it.

### WP3. The smallest usable slice in the app (Xvfb in this VM)
- "Save room on this device" for invite-keyed rooms, with a visible "Keep local history" choice. "Reopen room" shows the
  local lines at once, then connects in the background. "Waiting for a peer" shows until an authenticated session
  opens.
- With history on, the app saves each accepted own send and each live received line one time.
- [ ] WP3: Electron under Xvfb, new profile (127.0.0.1): save a keyed room and send and receive one chat line. Close all processes. Start with no peer, reopen the room and read the line. `DECISIONS.md` records the `safeStorage` backend.
- [ ] WP3: a second saved room with the same user name and a different key shows only its own chat.
- [ ] WP3: one app start with no error line in the terminal or the developer console (Xvfb). `test/rejoin.test.mjs` passes.
- [ ] WP3: `CHANGELOG.md` and `README.md` on the branch give the results with the label 127.0.0.1. They tell the difference between encrypted peer connections and encrypted local storage (only what this goal built). They list the open packaged Windows checks.

## Open checks for the operator (do not wait for them)
- The packaged portable .exe with the binding reports a SQLCipher version.
- A restart of the .exe with no network reads the saved line. The profile stays after the .exe moves.
- A different Windows account cannot read the archive.
- LAN and internet checks of milestones 2, 3 and 6.

## Known open item from milestone 3
`test/voice-direct.test.mjs` fails sometimes with `ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS` (2 of 5 runs on
`c42baf5`, 0 of 5 on `598725f`). It is not a part of this goal. Report it again if it occurs.

## Coordination with milestone 5C (a different session, branch `opus/voice-processing`)
- Do not change `src/application/voice.js` or `src/application/voice-worklet.js`.
- 5C also changes `renderer.js`, `main.js`, `preload.cjs`, `index.html` and `styles.css`. Put the milestone 6 code in
  new modules where possible, and keep the changes in those files in their own functions and blocks.
- The branch that merges second merges `main` first, then runs the fast check and one app start.

## Stop points (write `GOAL_WAIT` with the question, then stop)
- Each new package in `package.json`, also a dev dependency or a native build tool (end of WP1).
- A merge into `main`.
- The use of `agent-kit:builder-t6`.
- The push of a handoff branch.
- Packaged Windows, LAN and internet checks: the operator deferred them. List them as open. Do not wait for them.
