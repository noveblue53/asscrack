# Brief: WP1 binding study (read-only study, no product code)

## Goal
Find the best SQLCipher binding for the ASSCRACK Electron app. The app must keep an encrypted chat archive in the
main process. The orchestrator uses your report to choose one binding and to ask the operator for approval.

## Facts
- Repository: /home/user/asscrack. Base commit 598725f. Branch opus/saved-rooms. Read only. Do not edit any file in it.
- Use Node 24: run `export PATH=/opt/node24/bin:$PATH` first.
- Electron is 40.5.0 in /home/user/asscrack/node_modules/electron. Its ABI is NODE_MODULE_VERSION 143. Its Node is 24.13.1.
- To run code in the Electron runtime with no window, use: `ELECTRON_RUN_AS_NODE=1 /home/user/asscrack/node_modules/electron/dist/electron <script>`.
- electron-builder is 26.18.0. The build command is `npm run dist` (`electron-builder --win portable`). The operator builds the portable .exe on Windows 10 x64.
- The "build" section of /home/user/asscrack/package.json has no "asarUnpack" key and no "npmRebuild" key.
- The project license is MIT.

## Candidates
1. `better-sqlite3-multiple-ciphers`
2. `@journeyapps/sqlcipher`
3. Each other maintained SQLCipher binding for Node or Electron that you find. An example is `@signalapp/sqlcipher`. Give its license.

## Find these items for each candidate
1. The latest version and its release date. The date of the last commit. The open issue count, if you can find it.
2. The SQLCipher or SQLite3MultipleCiphers version in it. Does it support the SQLCipher 4 format?
3. Prebuilt binaries for Electron with ABI 143, for `win32-x64` and for `linux-x64`. Give the exact asset names and URLs. Use the GitHub releases page or the GitHub API.
4. The asar need: must the `.node` file go outside `app.asar`? Does electron-builder 26 unpack it with no setting?
5. The native build path in `npm run dist`: does electron-builder rebuild or download the binary for Electron? Which tool does it (`@electron/rebuild`, `prebuild-install`, `node-gyp`)? Which build tools does a source build need on Windows?
6. The license.
7. The size: the unpacked npm package size (`npm view <name> dist.unpackedSize`) and the size of the `.node` file.
8. The API: synchronous or asynchronous. How to set the key. How to read the cipher version.

## Trial for the first candidate
Do this trial in /tmp/claude-0/-home-user-asscrack/38300f29-2515-5dc9-b709-7376f963968a/scratchpad/wp1/trial only:
1. `npm init -y`, then install `better-sqlite3-multiple-ciphers` there.
2. Get the binary for Electron 40.5.0 (for example `npx prebuild-install --runtime electron --target 40.5.0 --arch x64 --platform linux`). Record if it downloads a prebuilt binary or builds from source.
3. Write a script for the Electron runtime. It makes a database with the SQLCipher scheme and a key, and writes one row. Then it closes the file, opens it again with the key and reads the row.
4. The script also opens the file with a wrong key and with no key. Record the error text of each.
5. The script reads the cipher version. Record the value.
6. Check that the release has a `win32-x64` asset for Electron ABI 143. Use an HTTP HEAD request or the GitHub API. Do not install it.

## Output
- Write the report to /tmp/claude-0/-home-user-asscrack/38300f29-2515-5dc9-b709-7376f963968a/scratchpad/wp1/binding-report.md.
- Give a table: one row for each candidate, one column for each item 1 to 8.
- Give a source URL for each fact.
- Mark each fact (M) measured in this VM, or (D) from a document or a web page.
- Write the report in ASD-STE100.

## Done when
- The report file exists. It has the table with items 1 to 8 for `better-sqlite3-multiple-ciphers` and `@journeyapps/sqlcipher`.
- The report gives the trial result: the read with the key, the error with a wrong key and the error with no key.
- The report gives the cipher version.
- The report gives the `win32-x64` asset URL for ABI 143, or says that it does not exist.

## Rules
- Do not install to the target.
- Do not edit tracked files while the orchestrator runs a timed regression.
- Do not edit any file in /home/user/asscrack. Do not run `npm install` in /home/user/asscrack.
- Do not edit /opt/agent-kit.
- Do not commit. Do not push. Do not change branches.
- If the task is harder than this brief shows, stop. Tell the orchestrator. Do not guess.
- Run each long command at low priority (`nice -n 19`).

## Report format
End with this report:
1. TIER: t1
2. Files changed, with one line on each change.
3. Commands you ran and their results.
4. Assumptions you made.
5. Points you are not sure about, and what the orchestrator must check.
