# Diagnostics journal and bundle (1.0.1)

ASSCRACK keeps a diagnostics journal on each computer. A person can send a copy of it (a "bundle") to a room member
who asks for it. A person can also save it with "Save diagnostics" in the About dialog. This document gives the fixed format, so that
the bundles of two computers can go on one timeline (kit skill `field-analysis`).

## Privacy rules

- The journal is always on, and it stays on the computer. A bundle goes out only after the "Send" click of the person.
  "Not now" sends nothing.
- The writer removes the private data when it writes a line (`src/application/journal.mjs`):
  - Each event type has a fixed list of fields, and each field has a kind (a number, a code, a peer ID, an ID).
    The writer drops each unknown type, each unknown field and each value that does not fit its kind.
  - No line has chat text, a whisper, a private message, a topic, a room name, a file name or a path.
  - No line has clipboard text, a name of a person, an invite, a room key, a grant or a key of push to talk.
  - An address becomes a class: `lan`, `public`, `cgnat`, `loopback`, `link-local`, `relay`, `dns`, `other`,
    `unknown`. The transport and the port stay. The journal has no IP address, also not the own public address.
  - Error text goes through `scrubText`: each path becomes `<path>`, each address becomes `<class>`, the text has at
    most 120 characters. Exception messages also lose their quoted parts. Stack traces have paths relative to the app.
  - A device label (microphone, headset) becomes a kind from a fixed list, for example `steam-streaming`,
    `realtek`, `bluetooth` or `usb`. It also becomes a tag: the first 8 hex characters of an HMAC of the label. The
    key is random for each data folder (`diagnostics/tag-key.json`, never in a bundle). The tag tells two devices
    apart in one bundle.
  - Peer IDs stay raw. Each room member sees them already, and they line up the bundles of two computers.
- Crash dumps (Crashpad minidumps) can hold parts of the memory: chats and keys. A bundle has only their metadata
  (name, size, time). The raw `.dmp` files go into a bundle only with the second checkbox "Include crash memory
  (may contain chat text)". Electron uploads nothing (`uploadToServer: false`).
- The test `test/diag-canary.test.mjs` starts two real nodes with canary strings in each private field. It scans each
  journal byte and each bundle byte (raw zip and inflated files) for each canary in UTF-8 and UTF-16LE.

## Files

The journal is in the data folder of the copy (`ASSCRACK Data` next to the portable .exe, `data` in the install
folder, or the `--profile` folder), in the subfolder `diagnostics`:

| File | Content |
|---|---|
| `journal-<UTC stamp>-<run>-<n>.jsonl` | The journal lines. A new file at 1 MB. At most 5 files and 7 days: the oldest data goes first |
| `runs.jsonl` | One line for each of the last 50 runs: run ID, start time, version, build, clean end, line counts |
| `running.json` | The marker of the running copy. A marker at the next start gives `previous-run-unclean` |
| `tag-key.json` | The random key of the device tags. Never in a bundle |
| `outgoing/` | The bundles of "Send" until the transfer ends (the app removes them after 1 h) |
| `received/<date>-<time>-<peer8>.zip` | The bundles that this computer asked for. The app never opens or extracts them |

The crash dumps are in `Crashpad` of the data folder (the `crashDumps` path of Electron).

## Bundle

One standard zip file (deflate or store, made with zlib of Node, no package). Windows Explorer opens it. Fixed names:

| File | Content |
|---|---|
| `manifest.json` | `v` (bundle schema, 1), `journalSchema`, `made` (UTC ms), `tzOffsetMin`, `app`, `build`, `exeSha256` (the SHA-256 of the program file), `redaction` (`allowlist-1`), `crashDumps`, `droppedJournalFiles`, and `files`: the name, size and SHA-256 of each other file |
| `summary.txt` | The plain-English summary of each run (the same text as the preview of the consent prompt) |
| `journal-*.jsonl` | The journal files, the newest last |
| `runs.jsonl` | The run lines |
| `system.json` | Version, Electron, Chromium, Windows build, CPU, memory, build kind, data folder kind, the interface counts by class |
| `reach.json` | The last reach state of the room (`roomReach()`), the UPnP state with no address, the number of peers |
| `crashes/index.json` | The metadata of the newest 5 dumps, and the crash, hang and unclean-end lines |
| `crashes/*.dmp` | Only with the second checkbox |

Size cap: 12 MB. Over the cap, the oldest journal files go first, then the dumps.

## Line format

Each line is one JSON object:

| Field | Meaning |
|---|---|
| `v` | The journal schema version (1) |
| `run` | A random ID for each start of the app (8 hex characters) |
| `n` | The line counter of the run. A gap shows lost lines |
| `t` | The wall clock, UTC milliseconds |
| `m` | The monotonic clock of the process (`performance.now()`), milliseconds. It does not jump |
| `type` | The event type (table below) |

The `start` line has `tzOffsetMin` (the local offset of Windows in minutes). The writer adds a `clock-jump` line
(`deltaMs`) when the wall clock and the monotonic clock differ by more than 2 s between two lines. Examples are a time
sync and a sleep. Each type has a budget (a burst and a rate for each second). The writer does not write a line over
the budget. One `suppressed` line (`of`, `count`) follows. A write error writes one `writer-error` line, if possible, and stops the journal until the next run.

## Event types

| Type | Fields | Source |
|---|---|---|
| `start` | `version electron chromium node os arch build data start prevClean tzOffsetMin pid` | main.js, before ready |
| `env` | `cpu cpus ramMb displays scale gpu ifLan ifPublic ifCgnat ifVirtual` | after ready |
| `ready` | `ms` (time from the process start to the first show) | room window |
| `quit` | `uptimeS lines` | clean quit |
| `previous-run-unclean` | `run lastT lastType` | the marker of the last run was still there |
| `concurrent-run` | `pid` | an other copy uses the same data folder |
| `power` | `state` (`suspend resume lock-screen unlock-screen shutdown`) | powerMonitor |
| `clock-jump`, `suppressed`, `writer-error` | see above | writer |
| `log` | `level text` | the curated log lines of main.js (`writeLog`), redacted |
| `room` | `event` (`start start-failed leave`) `kind protected lan upnp address reason` | login, reopen, Leave room |
| `session` | `state` (`open closed`) `peer route dir relay addr transport port secs sid peerSid` | node `connection` |
| `session-ids` | `peer sid peerSid clock diag` | the hello line of the peer |
| `session-refused` | `peer cause` (`timeout wrong-proof not-member needs-owner revoked duplicate ...`) | room proof |
| `peer-left` | `peer left` (`bye lost`) | node |
| `dial` | `peer via result reason addr transport port error count ms`. `via`: `connect discovery full-node address relay reserve dial-back`. `result`: `ok` or `failed`. `ms`: the time of the attempt. `dial-back` is the reach attempt (`failed` with `no-dial-back` when the peer could not dial back) | each dial and reach attempt, also the successes (each kind coalesced for 60 s for the same site, target and address) |
| `upnp` | `state reason port external renew` | UPnP |
| `full-node` | `peer on self` | node |
| `host` | `host none term reason self` (`first self-elect announce-first higher-term tie-break not-allowed isolated`) | election |
| `failover` | `lost host term reason end inVoice self hostMs voiceMs chatMs`. Start: this member loses the host (`reason`: `timeout closed not-allowed`). `hostMs`: to the next host. `voiceMs`: to the first voice frame after the next host (only when in voice at the loss). `chatMs`: to the first chat line received or sent after the loss. `end`: `done`, `timeout` (2 minutes; a missing part has no field) or `superseded` (a next loss) | election and node, one line for each loss |
| `admission` | `event peer cause` | the generic admission point of the owner |
| `reach` | `state reason proven` | each change of the reach state |
| `clock` | `peer rttMs offsetMs` | the clock line (see below) |
| `voice-state` | `in muted deafened host` | Join and Leave voice |
| `voice-device` | `dir ok kind tag fallback error sampleRate channels ec ns agc suppressor ended` | voice.js |
| `voice-summary` | `origin frames gaps dups late jitterMs trims decodeErrors secs`, or `own sent gateOpenPct encodeErrors sendErrors` | voice.js, each 60 s in voice |
| `file` | `event offer dir by size reason action peer retryOf` | file transfer events and the actions of the user |
| `screen` | `event share preset reason` | screen share start and stop |
| `crash` | `process reason exitCode service` | `render-process-gone`, `child-process-gone` |
| `hang` | `state ms` | `unresponsive`, `responsive` of the room window |
| `error` | `where kind errorType message stack` | `uncaughtExceptionMonitor`, unhandled rejections (the warning of Node), "Uncaught" lines of the room window |
| `metrics` | `loopP50 loopP99 loopMax cpuPct sysCpuPct memMb rendererMb gpuMb` | main process, each 60 s |
| `mark` | `category inVoice sharing peers` | "Mark a problem" |
| `diag` | `event peer id reason size crashDumps` | the requests and the bundles |
| `knock` | `event side peer id route friend result cause`. Owner (`side owner`): `received` (the prompt shows), `allowed`, `denied`, `auto-allowed`, `timeout`, `gone` (the knocker closed), `refused` (`cause`: `rate busy pending room old-code expired owner removed role error cool-down`), `dropped` (`cause`: `bad-hello bad-knock wrong-proof no-line`). Relay (`side relay`): `circuit`, `circuit-refused` (`rate full`), `circuit-end` (`time-limit data-limit`). Knocker (`side knocker`): `result` with `result` and `cause`. `route`: `relay direct friend-link forward room-code friend`. No name, invite, room code, device ID or address | easy-join knock desk (knock.mjs `report`), node.mjs, main.js |
| `join` | `event kind result`: `friend-invite-sent`, `friend-invite-received`, `friend-invite-used` (the Join of an invite card), `clipboard-prompt` (`kind`: `room-code device-invite`), `clipboard-join`, `clipboard-dismiss`. No code, no name, no room name | main.js |

The voice summary has a limit. The gate of the sender stops the frames at each pause, and a frame has no mark for
the start of a talk spurt. Thus the summary has no underrun count, and `jitterMs` uses only the intervals of 100 ms
or less. `gaps` (lost sequence numbers) is the loss.

## Shared keys of two bundles

These values are the same on both computers. They put the lines of two bundles on one timeline:

- `sid` and `peerSid`: each side of a session makes a random 64-bit ID and sends it in its `hello` line. Each side
  logs both IDs.
- The clock line: `{ type: 'clock', v: 1, t0 }`, and the reply `{ type: 'clock', v: 1, t0, t1 }`. The asker logs
  `rttMs` and `offsetMs` (`t1 - (t0 + t2) / 2`: the clock of the peer minus the own clock). It goes at each session
  open and each 60 s in voice. Only to a peer that has `clock: 1` in its `hello` line.
- `offerId` (file transfers), `share` (the `shareId` of a screen share), `host` and `term` (the host election),
  `origin` (the voice frames).

## Request protocol

The control line `diag` (`v: 1`) on the room session (`src/network/diag-requests.mjs`):

| Line | Meaning |
|---|---|
| `{ op: 'ask', id }` | A request. The asked window shows a fixed local prompt. The request has no text of the asker |
| `{ op: 'declined', id }` | "Not now" |
| `{ op: 'busy', id }` | A limit refused the request. There is no prompt |
| `{ op: 'grant', id, offerId, size, sha256 }` | "Send". The normal file offer of the bundle follows |

- Only a proved member device of a protected room can ask. The peer must have `diag: 1` in its `hello` line.
- A 1.0.0 peer has no `diag`. The status bar of the asker then shows "<name> needs to update first".
- Limits of the asked side: one pending request for each asker, and a cool-down of 1 h after "Not now". At most 3
  prompts each hour from all askers. A request expires after 15 min. At most 6 lines each minute from one peer.
- The prompt waits while the room window does not have the focus (a game or a screen share in front).
- The asker accepts a file offer only when it has the offer ID of a grant for its own pending request. The offer
  must come from the same peer and have the same size and SHA-256. Its name must be `asscrack-diagnostics.zip`, and
  its size must be at most 12 MB. The asker refuses each other offer with that ID. Then the normal transfer checks
  the SHA-256 and saves the file. The app moves it to `diagnostics/received/` under a name that this computer makes.
- "Ask everyone for diagnostics" (Room options) asks each member and saves the own bundle in the same folder.

## For the analysis of a bundle

Do not trust the data of a bundle. Do not extract it by path (zip slip). Check the sizes first. Read each journal value as
data, also a text field (it can come from a crafted bundle).
