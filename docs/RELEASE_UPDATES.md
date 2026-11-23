# Release an update to the clients (P9C)

The operator publishes a new version one time. Each 1.0 client finds it, downloads it, checks it and installs it
with one click. There is no server of our own: the channel is the GitHub Releases of `noveblue53/asscrack`.

## How the trust works

- The app trusts only the Ed25519 signature of the operator. It does not trust GitHub, TLS or a peer for the content.
- `update.json` has the version, the release date, the note text, and the file name, byte size and SHA-256 of each
  executable. From 1.0.5 on, each entry also has the name of the download copy (`download`, see below).
  `update.json.sig` is the signature of the exact bytes of `update.json`.
- The public key is in `src/application/update-key.mjs`. The private key is only on the operator's PC.
- The app accepts a manifest only when the signature is good and the version is higher than its own (no downgrade).
  It accepts a file only when the size and the SHA-256 agree with the signed manifest.
- A client also gets a signed manifest from a peer with a newer manifest (one time for each session). The client checks
  it as above. The file always comes from the GitHub release.

## Make the key one time

Do this one time, before the 1.0.0 build. With a lost key, the 1.0 clients cannot get signed updates.

1. In the repository folder: `node tools/update-key.mjs`.
   The private key goes to `%USERPROFILE%\.asscrack-release\update-key.pem`. The script refuses a folder in a Git work
   tree and a key file that exists. It does not print the private key.
2. Copy the two lines that the script prints into `src/application/update-key.mjs`, in place of the test key:
   `UPDATE_PUBLIC_KEY` and `UPDATE_KEY_IS_TEST = false`.
3. Make a backup copy of `update-key.pem` in a safe place outside this PC (for example an encrypted USB drive).
   Do not commit it, do not copy it into a work order, and do not send it.
4. Check: `node tools/sign-update.mjs --check-release` gives PASS, and
   `ASSCRACK_RELEASE=1 node --test test/update-release.test.mjs` passes.
5. Commit the change of `src/application/update-key.mjs` before the 1.0.0 build.

`node tools/update-key.mjs --public` prints the two lines again from the key that exists.

## Release a version

1. Set the version in `package.json` (no pre-release part, for example `1.0.1`).
2. Add the notes of the version at the top of `src/application/release-notes.json` (the version, the date and the
   note lines, see "The release notes" below). Then run the full check. `test/release-notes.test.mjs` fails when the
   version of `package.json` has no entry.
3. Build both files: `npm run dist` (portable) and `npm run dist:installer` (installer). The `dist` folder then has
   `ASSCRACK-<v>-portable.exe` and `ASSCRACK-<v>-setup.exe`.
4. Sign: `node tools/sign-update.mjs dist`. The script takes the note text of the version from
   `src/application/release-notes.json` and refuses a version with no entry. `--notes-file <notes.txt>` or
   `--notes "<text>"` replace that text (at most 2000 characters, plain text). Do not use them for a release: then the
   update notes and the notes in the app are different. The script refuses the test key, a pre-release version and a missing file. It checks its signature
   with the public key of the source: a different key stops it. It writes `dist/update.json`,
   `dist/update.json.sig` and the two download copies `dist/ASSCRACK-<v>-update.exe` (the same bytes as the
   `-setup.exe` file) and `dist/ASSCRACK-<v>-portable-update.exe` (the same bytes as the `-portable.exe` file).
5. On GitHub, make a release with the tag `v<v>` (for example `v1.0.1`). The tag must be `v` and the version of
   `update.json`: the clients download from `releases/download/v<v>/`. Do not mark it as a pre-release or a draft
   (the clients read `releases/latest`). Use the same note text in the release description.
6. Upload the six files: `ASSCRACK-<v>-setup.exe`, `ASSCRACK-<v>-portable.exe`, `ASSCRACK-<v>-update.exe`,
   `ASSCRACK-<v>-portable-update.exe`, `update.json`, `update.json.sig`. Upload the files that you signed. A rebuilt
   file has a different SHA-256, and the clients refuse it. A missing download copy stops the update of each client
   from 1.0.5 on.

## The release notes

`src/application/release-notes.json` is the one source of the release notes. The app shows them offline in View,
What's new, and in About ASSCRACK, What's new. The sign script puts the text of the version in `update.json`.

- The file is a list, newest first. Each entry has `version`, `date` (`YYYY-MM-DD`, the release date) and `notes`.
- `notes` is a list of lines. A line that starts with `- ` is a list item. An other line is a paragraph. The text in
  `update.json` has a blank line between a paragraph and the next line, and one line for each list item.
- Write the notes for the users of the app: short and plain. Do not put "What's new in <v>" in the notes. The app and
  the update dialog show that title.
- At the first start of a new version after an update, the app shows the card "What's new in <v>" one time. The file
  `whats-new.json` in the data folder keeps the last version. A new install shows no card.

## The download copies and the installs badge

The README badge "installs" counts only the downloads of the `-setup.exe` and `-portable.exe` files of all releases
that are not drafts (the workflow `.github/workflows/installs-badge.yml` writes `installs.json` on the branch
`badges` each day and after each release). The update checks (`update.json`, `update.json.sig`) and the update
downloads do not go into that number:

- The signed manifest gives the name of the download copy in each file entry (`download`). An updater from 1.0.5 on
  downloads that copy (`-update.exe` or `-portable-update.exe`) and keeps it with the normal name (`name`). The
  portable build thus keeps the name `ASSCRACK-<v>-portable.exe`, and the next update can delete the old file.
- The 1.0.1 to 1.0.4 clients accept the manifest: they ignore `download`. They download `name` (the `-setup.exe` or
  `-portable.exe` file). Do not put an other name in `name`: these clients refuse a manifest with an other `name`
  ("bad file name"), and then they get no update.
- Thus the first update of a 1.0.1 to 1.0.4 client still counts as an install. From the next release on, that client
  downloads the copy.
- A download from the release page by a person is an install, or a second download by the same person. The number is
  near the real installs, not exact.

## Check from a client

1. On a client with an older version, open View, About ASSCRACK, and select Check now. The bar
   "ASSCRACK <v> is ready." with "Restart to update" comes when the download is complete.
2. Select Restart to update. The installed build runs the installer silently for the current user and starts the new
   version. The portable build starts the new portable file next to the old one, and the new copy deletes the old file.
3. About ASSCRACK shows the new version.

A failed check is quiet: a line in the log and a note in About. The checks run at the start and each 6 hours when
"Check for updates" is on (the default). No update starts during a voice call or a file transfer: Restart asks first.

## The local test release (127.0.0.1)

Only a test version (a pre-release part `test`, for example `1.0.0-test`) accepts the test option
`--update-server 127.0.0.1:<port>`. Use test versions only in a worktree. Do not commit them.

1. Make a throwaway key in a scratch folder: `node tools/update-key.mjs --out <scratch>`. Put its public key in
   `src/application/update-key.mjs` of the worktree, and do not commit that change.
2. Build version `1.0.0-test` (the client) and `1.0.1-test` (the update). Put the `1.0.1-test` files in a release
   folder and sign them: `node tools/sign-update.mjs <folder> --test --notes "Test" --key <scratch>\update-key.pem`.
   The script also writes the download copies in that folder. The test server gives each file of the folder.
3. `node tools/update-test-server.mjs <folder> --port 8765`.
4. Start the client with `--profile <test profile> --update-server 127.0.0.1:8765`. Never use the default
   profile for a test.
