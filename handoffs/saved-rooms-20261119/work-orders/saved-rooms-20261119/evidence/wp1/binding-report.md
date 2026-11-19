# WP1 binding study: SQLCipher binding for the ASSCRACK Electron app

Date: 2026-11-19. Builder tier: t1. Base commit 598725f (branch `opus/saved-rooms`). The repository was not changed
(`git status --short` gives 0 lines).

Marks: (M) = measured in this VM. (D) = from a document, a web page or source code that I read.
All runtime results are from Linux x64 in this VM. No result is from Windows. No result is a LAN result.

## 1. Summary

1. `better-sqlite3-multiple-ciphers` 13.2.0 is the best candidate. It is MIT. It is synchronous. It has
   SQLite3 Multiple Ciphers 2.7.1 (SQLite 3.54.1). It writes and reads the SQLCipher 4 format. The npm package
   contains N-API prebuilt binaries for `win32-x64` and `linux-x64`. The same binary loads in Node 24 (ABI 137) and
   in Electron 40.5.0 (ABI 143). (M)
2. Version 13.x has NO GitHub release asset for Electron ABI 143. The binary is in the npm tarball, not in a release
   asset. `prebuild-install` gets HTTP 404. (M)
3. A file that `better-sqlite3-multiple-ciphers` wrote with the SQLCipher scheme opens in Signal's SQLCipher 4.18.0
   with only `PRAGMA key`. This shows real SQLCipher 4 format compatibility. (M)
4. Risk for `npm run dist` on Windows: electron-builder 26.18.0 runs `@electron/rebuild`. It sees `binding.gyp` in
   the package and runs `node-gyp rebuild`. The `binding.gyp` builds nothing when a prebuild exists (measured on
   Linux: no `.node` file is made). But on Windows, `node-gyp configure` looks for Python and Visual Studio before it
   reads the targets (D, code). Thus a Windows build PC with no Visual Studio C++ build tools can fail. Two
   solutions: (a) the operator installs the VS C++ build tools and Python, or (b) the orchestrator sets
   `"npmRebuild": false` in the `build` section. The project has no other native module today (M: no `binding.gyp`
   in `node_modules` except in `node-gyp` itself), so (b) has no other effect. Neither solution is tested on Windows.
5. `@journeyapps/sqlcipher` 6.0.0 is not usable. Its `package.json` has `"os": ["darwin","linux"]`. On win32, npm
   stops the install with `EBADPLATFORM` (M, npm check function). It has no prebuilt binary. It always builds from
   source and needs OpenSSL.
6. `@signalapp/sqlcipher` 4.1.0 works technically (M), but its license is AGPL-3.0-only. Do not use it in an MIT
   app without a license decision.

## 2. Table: items 1 to 8 for each candidate

| Candidate | 1. Latest version, date, last commit, open issues | 2. Cipher library, SQLCipher 4 format | 3. Prebuilt for Electron ABI 143 (win32-x64, linux-x64) | 4. asar | 5. Native build path in `npm run dist` | 6. License | 7. Size | 8. API, key, cipher version |
|---|---|---|---|---|---|---|---|---|
| `better-sqlite3-multiple-ciphers` | 13.2.0, published 2026-11-16T21:19:49Z (M, npm). Last commit: "last monday" = 2026-11-16 (D, shields.io). Open issues: 1 (D, shields.io). | SQLite3 Multiple Ciphers 2.7.1, SQLite 3.54.1 (M). SQLCipher 4 format: yes, with `cipher='sqlcipher'` and `legacy=4` (M, cross-check with Signal SQLCipher 4.18.0). The default cipher is `chacha20`, NOT SQLCipher (M). | No release asset for 13.x (M, HTTP 404). N-API binaries are in the npm tarball: `prebuilds/win32-x64.node`, `prebuilds/linux-x64.node` (M). They load in Electron 40.5.0 ABI 143 (M, Linux). The Windows file is PE32+ x86-64 with a delay import of `node.exe` (M, objdump); runtime on Windows not tested. Last version with per-ABI assets: 12.11.1 (M, HTTP 200). | The `.node` file must be outside `app.asar`. electron-builder 26.18.0 unpacks the full module folder with no setting (M): 35 MB in `app.asar.unpacked`. The packed app loads it (M). | `@electron/rebuild` 4.2.1 runs `node-gyp rebuild --runtime=electron --target=40.5.0` (M). It builds nothing when a prebuild exists (M, Linux, 2.3 s). It downloads Electron headers (M). On Windows, node-gyp needs Python and Visual Studio C++ tools for this step (D, code). A full source build needs the same tools (D). | MIT. Bundled SQLite3MC code: MIT. SQLite: public domain (M, file headers). | `dist.unpackedSize` 35,495,685 B (M). `win32-x64.node` 2,458,624 B, `linux-x64.node` 2,889,664 B (M). | Synchronous (better-sqlite3 API). Key: `db.pragma("cipher='sqlcipher'")`, `db.pragma('legacy=4')`, `db.pragma("key='…'")`, or `db.key(Buffer)` (M). Version: `SELECT sqlite3mc_version()` gives `SQLite3 Multiple Ciphers 2.7.1` (M). `PRAGMA cipher_version` gives no row (M). |
| `@journeyapps/sqlcipher` | 6.0.0, published 2026-04-29T11:30:14Z (M, npm). Last commit: "april" 2026 (D, shields.io). Open issues: 23 (D, shields.io). | SQLCipher 4.14.0 community, SQLite 3.51.3 (M, source defines). SQLCipher 4 format: yes, `cipher_compatibility = 4` is the default (D, README). | None. 6.0.0 has no binary and no prebuild host (M, tarball). `"os": ["darwin","linux"]`: npm gives `EBADPLATFORM` on win32 (M, npm-install-checks). Old 5.3.1 (2021) has `napi-v6-win32-x64.tar.gz` on S3 (M, HTTP 200), not maintained. | `.node` must be outside `app.asar`. The same detector unpacks it (D, code). Not packed in this VM. | Install script `node-gyp rebuild` always builds from source. `@electron/rebuild` builds again for Electron (D, README). Needs a C/C++ toolchain, Python and OpenSSL `libcrypto`. Windows: "not supported" (D, README). | BSD-3-Clause (M, package.json). SQLCipher: BSD-style (D, README). | `dist.unpackedSize` 10,460,488 B (M). No `.node` file in the package (M). Not built in this VM. | Asynchronous (node-sqlite3 callback API). Key: `db.run("PRAGMA key = '…'")` (D, README). Version: `PRAGMA cipher_version` (D, SQLCipher API). Not run. |
| `@signalapp/sqlcipher` | 4.1.0, published 2026-08-20T17:36:26Z (M, npm). Last commit: "august" 2026 (D, shields.io). Open issues: 0 (D, shields.io). | SQLCipher `4.18.0 community` (M, `PRAGMA cipher_version`). SQLCipher 4 format: yes (M, default settings opened the trial file). | No per-ABI asset needed. N-API prebuilds are in the npm tarball: `prebuilds/win32-x64/@signalapp+sqlcipher.node`, `prebuilds/linux-x64/@signalapp+sqlcipher.node` (M). Loads in Electron 40.5.0 ABI 143 (M, Linux). | `.node` must be outside `app.asar`. The same detector unpacks it (D, code). Not packed in this VM. | No `binding.gyp` in the package, so `@electron/rebuild` does nothing (M, 6 ms). Install script `node-gyp-build` only finds the prebuild. No source in the package, so no source build from npm (M). | AGPL-3.0-only (M, package.json and LICENSE). | `dist.unpackedSize` 12,245,799 B (M). `win32-x64` 2,027,520 B, `linux-x64` 2,183,480 B (M). | Synchronous. Key: `db.pragma("key = '…'")` (M). Version: `PRAGMA cipher_version` gives `4.18.0 community` (M). |
| `electron-better-sqlite3-sqlcipher` | 0.3.0, published 2026-11-03T11:35:29Z (M, npm). First version 2026-10-30 (M). Issues: not found. | SQLCipher v4.20.0, SQLite 3.54.1 (M, VERSION.txt and source define). | None. A `postinstall` Bash script builds from source (M, package.json). Windows: "the host app runs its own build" and must ship OpenSSL DLLs (D, README). | Not checked. | Source build with `node-gyp`, Bash scripts, OpenSSL 3 headers (D, README). | MIT. SQLCipher: BSD-style (D, README). | `dist.unpackedSize` 10,606,009 B (M). | Peer dependency `better-sqlite3` ^13.0.3, synchronous (D, README). Not run. |

Other npm packages that I found are not maintained or are not for Node: `sqlcipher` 1.1.1 (2017),
`better-sqlite3-sqlcipher` (2020), `@fork-anyone/sqlcipher` 5.3.8 (fork of journeyapps 5.3.1, install script
`node-gyp rebuild`), `@indutny/sqlcipher` (alpha, 2025), React Native, Cordova and WASM packages (M, `npm search`).

## 3. Trial for `better-sqlite3-multiple-ciphers` 13.2.0

Folder: `/tmp/claude-0/-home-user-asscrack/38300f29-2515-5dc9-b709-7376f963968a/scratchpad/wp1/trial`.
Script: `trial.cjs`. Output: `trial-electron-output.json`.

### 3.1 Install and binary (step 1 and 2)

- `npm install better-sqlite3-multiple-ciphers@13.2.0`: 2 packages (`node-addon-api` is the other). No install
  script ran. No download. No build. `gypfile` is `false` (M).
- The binary that loads: `node_modules/better-sqlite3-multiple-ciphers/prebuilds/linux-x64.node` (M).
- `npx prebuild-install@7.1.3 --runtime electron --target 40.5.0 --arch x64 --platform linux` gives:
  `http 404 .../v13.2.0/better-sqlite3-multiple-ciphers-v13.2.0-electron-v143-linux-x64.tar.gz` and
  `No prebuilt binaries found (target=40.5.0 runtime=electron arch=x64 libc= platform=linux)`, exit 1 (M).
  This is correct: version 13 does not use `prebuild-install`. It has no dependency on it.

### 3.2 Runtime

`ELECTRON_RUN_AS_NODE=1 /home/user/asscrack/node_modules/electron/dist/electron trial.cjs` (M):
- `process.versions`: electron 40.5.0, node 24.13.1, modules 143, napi 10, linux x64.

### 3.3 Results (step 3, 4 and 5)

Open sequence for each open: `new Database(file)`, `pragma("cipher='sqlcipher'")`, `pragma('legacy=4')`,
`pragma("key='…'")`.

| Step | Result (M) |
|---|---|
| Create, write one row, close | OK. Settings: cipher `sqlcipher`, legacy `4`, kdf_iter `256000`, page size `4096`, HMAC algorithm `2` (SHA512), KDF algorithm `2` (SHA512). These are the SQLCipher 4 defaults. |
| File header | First 16 bytes `2ab62fff01ab0c497d105e5732844933`. No `SQLite format 3` text. The file is encrypted. |
| Open again with the key, read | `[{"id":1,"room":"lan-room","body":"hello archive"}]` |
| Wrong key | `SqliteError: file is not a database`, code `SQLITE_NOTADB` |
| No key, SQLCipher scheme set | `SqliteError: file is not a database`, code `SQLITE_NOTADB` |
| No key, no pragma | `SqliteError: file is not a database`, code `SQLITE_NOTADB` |
| When the wrong key error comes | `PRAGMA key='wrong-key'` returns `[{"ok":"ok"}]`. The error comes at the first read. The app must do one read after the key to check it. |
| `db.key(Buffer)` | Returns 0. The read gives 1 row. |
| Cipher version | `SELECT sqlite3mc_version()` = `SQLite3 Multiple Ciphers 2.7.1`. `SELECT sqlite_version()` = `3.54.1`. `PRAGMA cipher_version` = no row (`[]`). |
| Default cipher with no pragma | `PRAGMA cipher` = `chacha20`, `PRAGMA legacy` = `0`. The app must set `cipher` and `legacy` on each open. |

The same script under plain Node 24.22.3 (ABI 137) gives the same results with the same `.node` file (M,
`trial-node-output.json`). Thus `npm test` can use the module with no rebuild.

### 3.4 Cross-check with a second SQLCipher build

Folder `.../wp1/trial-sig`, script `xcheck.cjs`, output `xcheck-output.json`. `@signalapp/sqlcipher` 4.1.0 in
Electron 40.5.0 opened the trial file with only `PRAGMA key` and default settings (M):
- With the key: `cipher_version` `4.18.0 community`, row `{"id":1,"room":"lan-room","body":"hello archive"}`.
- Wrong key: `sqlite error(SQLITE_NOTADB): file is not a database`. Log line:
  `sqlcipher_page_cipher: hmac check failed for pgno=1`.
- No key: `sqlite error(SQLITE_NOTADB): file is not a database`.

### 3.5 `win32-x64` asset for ABI 143 (step 6)

- `https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/download/v13.2.0/better-sqlite3-multiple-ciphers-v13.2.0-electron-v143-win32-x64.tar.gz`:
  HTTP 404 (M). The same for v13.1.1 and v13.0.3, and for the `linux-x64` names (M).
- This asset does not exist for 13.x. The Windows binary for 13.2.0 is in the npm tarball:
  `https://registry.npmjs.org/better-sqlite3-multiple-ciphers/-/better-sqlite3-multiple-ciphers-13.2.0.tgz`,
  path `package/prebuilds/win32-x64.node`, 2,458,624 B (M). It is N-API, so it does not depend on ABI 143.
- If a per-ABI asset is necessary, version 12.11.1 has it (M, HTTP 200 after redirect):
  - `https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/download/v12.11.1/better-sqlite3-multiple-ciphers-v12.11.1-electron-v143-win32-x64.tar.gz`
  - `https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/download/v12.11.1/better-sqlite3-multiple-ciphers-v12.11.1-electron-v143-linux-x64.tar.gz`
  - 12.x uses `prebuild-install || node-gyp rebuild --release` (M, npm metadata).
- I did not download or install any Windows asset.

### 3.6 Packaging trial with electron-builder 26.18.0

Folder `.../wp1/eb-trial` (minimal app: `main.cjs` + the module, `electronDist` = the repo Electron). Command:
`/home/user/asscrack/node_modules/.bin/electron-builder --linux dir --x64 --projectDir <eb-trial>`. Log:
`.../wp1/eb-trial.log`. Results (M, Linux):
- electron-builder ran `executing @electron/rebuild`, then `preparing moduleName=better-sqlite3-multiple-ciphers`
  and `finished`. Exit 0.
- `resources/app.asar` = 420 KB. `resources/app.asar.unpacked/node_modules/better-sqlite3-multiple-ciphers` =
  35 MB: `prebuilds` 21 MB (all 8 platforms), `deps` 14 MB (`sqlite3.c`), `src` 216 KB, `lib` 108 KB. No setting
  was necessary.
- The packed app loaded the module from `resources/app.asar/node_modules/...` and the `.node` file from
  `app.asar.unpacked`. It wrote and read an SQLCipher row: `{"row":"packed ok","mc":"SQLite3 Multiple Ciphers 2.7.1"}`.
  This is true in Electron node mode and in the real Electron main process (under `xvfb-run`).
- The `build/Release` folder from the rebuild had only `.deps`, `.forge-meta`, `obj.target`. No `.node` file was
  made. The shipped binary is the prebuild.

## 4. Native build path in `npm run dist` (item 5, details)

Source code that I read in `/home/user/asscrack/node_modules` (D):
- `app-builder-lib/out/packager.js` lines 460-495: `installAppDependencies` calls `installOrRebuild` unless
  `npmRebuild === false`.
- `app-builder-lib/out/util/yarn.js` `rebuild()`: calls `@electron/rebuild` with `mode: "sequential"`,
  `buildFromSource: false`, `disablePreGypCopy: true`.
- `@electron/rebuild/lib/rebuild.js` line 98: a module is native when it has `binding.gyp`.
- `@electron/rebuild/lib/module-rebuilder.js` lines 122-130: it tries prebuildify, then prebuild-install, then
  node-pre-gyp. `better-sqlite3-multiple-ciphers` 13 uses none of these, so it runs `node-gyp rebuild`.
- `node-gyp/lib/configure.js` (node-gyp 12.4.0) lines 95-113: on win32 it calls `findVisualStudio` before gyp runs.
  The `build` step uses `msbuild`. Thus the Windows build PC needs Python and Visual Studio C++ build tools, also
  when the targets are empty.
- `better-sqlite3-multiple-ciphers/binding.gyp`: `prebuild_exists` comes from `node lib/binding.js`. When it is 1
  and `force_build` is 0, both targets are `type: none`.

Windows tools for a full source build of `better-sqlite3-multiple-ciphers` (D, `binding.gyp` and
`docs/troubleshooting.md`): Python, Visual Studio C++ build tools with C++20 (`/std:c++20`), node-gyp. No OpenSSL
is necessary: the gyp files have no SSL library, `linux-x64.node` needs only libstdc++, libm, libc and ld-linux,
and `win32-x64.node` imports only `KERNEL32.dll` plus the delay import of `node.exe` (M, objdump).

## 5. Sources

- npm metadata (M, `npm view`, `npm pack`): `https://registry.npmjs.org/better-sqlite3-multiple-ciphers`,
  `https://registry.npmjs.org/@journeyapps/sqlcipher`, `https://registry.npmjs.org/@signalapp/sqlcipher`,
  `https://registry.npmjs.org/electron-better-sqlite3-sqlcipher`.
- Repositories: `https://github.com/m4heshd/better-sqlite3-multiple-ciphers`,
  `https://github.com/journeyapps/node-sqlcipher`, `https://github.com/signalapp/node-sqlcipher`,
  `https://github.com/seedcaseio/electron-better-sqlite3-sqlcipher`, `https://github.com/utelle/SQLite3MultipleCiphers`.
- Open issues and last commit (D): `https://img.shields.io/github/issues-raw/<owner>/<repo>.json` and
  `https://img.shields.io/github/last-commit/<owner>/<repo>.json` for each repository above.
- Upstream CI and docs (D): `https://raw.githubusercontent.com/m4heshd/better-sqlite3-multiple-ciphers/master/.github/workflows/test.yml`,
  `https://raw.githubusercontent.com/m4heshd/better-sqlite3-multiple-ciphers/master/docs/troubleshooting.md`.
- READMEs and `package.json` files: in the npm tarballs, extracted to `.../wp1/pkgs/{bsmc,jas,sig,ebs}/package/`.
- journeyapps 5.3.1 binary: `https://journeyapps-node-binary.s3.amazonaws.com/@journeyapps/sqlcipher/v5.3.1/napi-v6-win32-x64.tar.gz` (M, HTTP 200).

## 6. Limits of this study

- The GitHub API and the GitHub release pages give HTTP 403 in this VM ("GitHub access to this repository is not
  enabled for this session"). Thus I could not list the release assets or read the release dates on GitHub. I
  used HEAD requests on the predicted asset names, npm publish dates and shields.io.
- No result is from Windows. The Windows binary was inspected only (PE format, imports). It was not run.
- The `npm run dist` failure on a Windows PC with no Visual Studio is from source code, not from a test.
