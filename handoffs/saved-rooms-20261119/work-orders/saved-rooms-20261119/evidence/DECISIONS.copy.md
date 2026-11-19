# Decisions: milestone 6 part 1, saved rooms (local file, not in Git)

This file is new in this cloud session (2026-11-19). The DECISIONS.md of the earlier sessions is not in this VM. The
decisions of milestone 3 are in `handoffs/manual-status-20261119/START_HERE.md` on branch
`origin/handoffs/manual-status-20261119`. All results here are 127.0.0.1 results on a Linux cloud VM. There is no LAN
result, no internet result and no packaged Windows result.

## S1. Baseline (2026-11-19)

- Branch `opus/saved-rooms` from `origin/main` at `598725fd96f7d3078f2db650fccdd8688178fca2`.
- Node v24.22.3 and npm 11.19.1 (`/opt/node24/bin`).
- Electron 40.5.0: Node 24.13.1, `NODE_MODULE_VERSION` 143, Chrome 144.0.7559.177. electron-builder 26.18.0.
- `npm ci`: exit 0. `npm test`: 198 of 198 pass, 0 fail, wall time 62 s (127.0.0.1).
- Evidence: `.repro/regress/baseline-npmci.txt`, `.repro/regress/baseline-598725f.console.txt`.

## S2. safeStorage in this VM (2026-11-19, measured)

- Electron 40.5.0 under `xvfb-run -a`, no keyring service: `getSelectedStorageBackend()` gives `basic_text`.
  `isEncryptionAvailable()` gives `false`. `encryptString()` throws "Encryption is not available".
- The same run in `dbus-run-session` with `gnome-keyring-daemon --unlock --components=secrets` and the switch
  `--password-store=gnome-libsecret`: the backend is `gnome_libsecret`. `isEncryptionAvailable()` gives `true`. The
  encrypted text starts with `v11`. The round trip gives the original text.
- The VM had no keyring service. I installed the Ubuntu package `gnome-keyring` in the VM with apt. It is a test tool
  of this VM only. It is not a package of the project and not in `package.json`.
- Decision: the app does not use `safeStorage.setUsePlainTextEncryption()`. On the backend `basic_text`, the app
  reports protected storage as not available and saves no room. Reason: the plan forbids a plaintext fallback.
- Windows: `safeStorage` uses DPAPI. See S4 for the sources.
- Evidence: `evidence/wp1/safestorage-main.cjs` and the two output lines in this section.

## S3. Local run logs (2026-11-19)

- `.git/info/exclude` has `/.repro/`. The folder holds the console files of local runs (skill `regression`,
  section 2). The handoff copies the necessary files into its `evidence/` folder. Reason: run logs are not feature
  work, and the stop hook of the session asked for a commit of each untracked file.

## S5. "Waiting for a peer" (2026-11-19, read in the code)

- In a keyed room, `openSession()` in `src/network/node.mjs` (about line 431) runs only after the `proof` line passes
  the `timingSafeEqual` check. `openSession()` emits `peer-joined`. Thus `peer-joined` marks an authenticated session.
- Decision: the app shows "Waiting for a peer" while a reopened room has no session. It removes the text at the first
  `peer-joined`, and shows it again when the last peer leaves.

## S4. The SQLCipher binding (2026-11-19, WP1 study)

Study report: `work-orders/saved-rooms-20261119/evidence/wp1/binding-report.md` (builder, general-purpose agent with the builder-t1 rules). Marks:
(M) measured in this VM on Linux x64, (D) from a document or source code. No result here is a Windows result.

Decision: `better-sqlite3-multiple-ciphers`, version 13.2.0, exact pin, in `dependencies`. It waits for the
approval of the operator (stop point of WP1).

Reasons:
1. License MIT. The bundled SQLite3 Multiple Ciphers code is MIT. SQLite is public domain (M, file headers).
2. The npm tarball has N-API prebuilds for 8 platforms, also `prebuilds/win32-x64.node` (2,458,624 B). npm install
   runs no script and downloads nothing (M). The only dependency is `node-addon-api` (M).
3. One binary loads in Node 24.22.3 (ABI 137) and in Electron 40.5.0 (ABI 143) (M, builder and orchestrator runs).
   Thus `node --test` can use the real cipher, and the app uses the same file.
4. It writes the SQLCipher 4 format with `PRAGMA cipher='sqlcipher'` and `PRAGMA legacy=4` (M). Signal SQLCipher
   4.18.0 opened the trial file with only `PRAGMA key` (M, cross-check).
5. Synchronous API. It fits the main process. Maintained: 13.2.0 on 2026-11-16, 1 open issue (D, shields.io).

Measured behavior (orchestrator run, `evidence/wp1/check-orch.cjs`, Node and Electron):
- With the key: the row reads. A wrong key and no key: `SQLITE_NOTADB file is not a database`.
- The database file does not contain the plaintext test text.
- `PRAGMA key` with a wrong key returns `ok`. The error comes at the first read. The store must read one time to check
  the key.
- The default cipher is `chacha20`. The store must set `cipher` and `legacy` before the key at each open.
- Version: `SELECT sqlite3mc_version()` gives `SQLite3 Multiple Ciphers 2.7.1`. `PRAGMA cipher_version` gives no
  row. The open Windows check "reports a SQLCipher version" uses `sqlite3mc_version()` and `PRAGMA cipher`.

Build path:
- electron-builder 26.18.0 runs `@electron/rebuild` 4.2.1. The module has a `binding.gyp`, thus `node-gyp rebuild`
  runs (M). On Linux it built nothing in 2.3 s, and the prebuild ships (M). On win32, node-gyp 12.4.0 finds Visual
  Studio and calls msbuild also for empty targets (D, `node-gyp/lib/configure.js` lines 95-113).
- Decision: add `"npmRebuild": false` to the `build` section of `package.json`. Reason: the prebuild is N-API, so a
  rebuild is not necessary. The project has no other native module (M). Thus the Windows build PC needs no Python and
  no Visual Studio tools. Not tested on Windows: an open check.
- asar: electron-builder 26 unpacks the module folder with no setting (M, `--linux dir` trial). It adds 35 MB before
  compression: 21 MB prebuilds of all platforms, 14 MB `deps/sqlite3.c`. A `files` exclusion can make it smaller.
  That is a later item, not tested.

Rejected:
- `@journeyapps/sqlcipher` 6.0.0: `"os": ["darwin","linux"]` gives `EBADPLATFORM` on win32 (M). No prebuilds, a
  source build with OpenSSL (D).
- `@signalapp/sqlcipher` 4.1.0: it works (M), but its license is AGPL-3.0-only. The project is MIT.
- `electron-better-sqlite3-sqlcipher` 0.3.0: a source build with Bash scripts, OpenSSL DLLs on Windows (D).
- `better-sqlite3-multiple-ciphers` 12.x: one binary for each ABI. Node tests and Electron need different files.

Risk: 13.2.0 is 3 days old (published 2026-11-16T21:19:49Z). 13.1.1 is from 2026-11-13.

Sources:
- `https://registry.npmjs.org/better-sqlite3-multiple-ciphers`, `https://github.com/m4heshd/better-sqlite3-multiple-ciphers`
- `https://github.com/utelle/SQLite3MultipleCiphers`
- `https://registry.npmjs.org/@journeyapps/sqlcipher`, `https://github.com/journeyapps/node-sqlcipher`
- `https://registry.npmjs.org/@signalapp/sqlcipher`, `https://github.com/signalapp/node-sqlcipher`
- `https://registry.npmjs.org/electron-better-sqlite3-sqlcipher`
- `safeStorage`: `https://raw.githubusercontent.com/electron/electron/v40.5.0/docs/api/safe-storage.md`. Windows:
  "Encryption keys are generated via DPAPI ... content is protected from other users on the same machine, but not
  from other apps running in the same userspace." Linux with `basic_text`: "items stored ... will be unprotected as
  they are encrypted via hardcoded plaintext password" (copy in `evidence/wp1/safe-storage-v40.5.0.md`).

## S6. Operator approval of the dependency (2026-11-19)

- Operator answer in chat (question form): "Approve both (Recommended)". The question named
  `better-sqlite3-multiple-ciphers` 13.2.0 in `dependencies` and `"npmRebuild": false` in the `build` section.
- The earlier operator message "continue" did not name the dependency. Thus I asked again with a question form.

## S7. Dependency commit and context limit (2026-11-19)

- Commit `cd1e3de` on `opus/saved-rooms` (pushed): the package and `"npmRebuild": false`. `npm test`: 198 of 198
  pass (127.0.0.1). Evidence: `.repro/regress/dep-added.console.txt`.
- The kit hook gave CONTEXT LIMIT (about 224,000 tokens). This cloud session has no `start_session` tool. The
  project rule for the cloud: stop at the context limit and report the state. The state is in `CONTINUE.md`.
- Operator answer (question form, 2026-11-19): "Push handoff, new session (Recommended)". Thus I push
  `handoffs/saved-rooms-20261119` with the goal folder and a copy of this file.
