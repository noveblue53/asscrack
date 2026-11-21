# Desktop review candidate

`work/room-desktop` builds on `work/0.7-field-recovery` at `7ada7bb`. The November 20 Windows field report concerned app version 0.7.0 on three networks. The new executable also reports version 0.7.0. Use the source and executable hashes below to distinguish the builds. The operator owns the merge and release decision.

## Windows x64 review executable

| Property | Value |
| --- | --- |
| Portable executable | `ASSCRACK-0.7.0-desktop-29d6dda.exe` |
| Built from | [`29d6dda`](https://github.com/noveblue53/asscrack/commit/29d6dda4e978521a38b6c8f807056537c826815d) |
| Size | 106,789,665 bytes |
| Executable SHA-256 | `221e6682531f4fe6049d9dca12a5105a49f76402352ebf4319bbb53fac106005` |
| Build | Linux x64, Node 24.22.3, Electron 40.5.0, electron-builder 26.18.0, version 0.7.0, unsigned |
| Payload check | Extracted the NSIS payload and verified all 87 packaged application/network files against the frozen sources. Verified Windows x64 PE binaries for SQLite and the global input hook. |

Extract the zip and fully quit any other ASSCRACK instance, including a copy in the tray. The 0.7.0 portable launchers share an unpacking directory and single-instance behavior. For the upgrade rehearsal, preserve the old executable and original closed profile and use a disposable profile copy. In PowerShell use `Get-FileHash -Algorithm SHA256 .\ASSCRACK-0.7.0-desktop-29d6dda.exe` to check the extracted executable.

## What you can try

- In **View → Theme**, choose Aero Classic, Aero Night, Aero Black, Aero Midnight, Pearl or Amber Terminal. Compact transcript mode keeps a single unread divider. Open a message’s details for its local archive status.
- Minimize the room to keep talking. **Enter Idle Peer** and the default Close action put the room in the tray, end capture and keep the node and established routes available. **Open Asscrack** restores the same room. **Quit Asscrack** releases the node. A close preference is available.
- Open the detached voice panel for speaker and mute controls while another window has focus. Both windows use the room’s existing capture session.
- A named public channel has its own draft, quote, unread count, Find results and saved lines. Everyone in the room can read it. The channel selector retains General for old clients. Named channels become read-only while a legacy host holds the role or the host is unknown. Legacy typing indicators remain scoped to General.
- Paste a screenshot, or attach a supported image, GIF or video, and add a caption. The original stays a separate download. Thumbnails can be turned off. A saved video has inline playback controls. A targeted file offer stays private to its recipient.
- Open **Whispers**, choose a connected buddy by identity, and send. The delivery acknowledgement comes from that peer. The receiver’s private message is transient. Room archive, public history and late-join replay exclude it. An unsupported peer, a lost route or a new identity requires an explicit new send.
- Enable native mention and whisper notifications in the attention settings. A visible conversation, DND and Idle Peer suppress the corresponding alerts. Voice cue volume and notification preferences are independent. Private banners omit the body.

## 127.0.0.1 verification

On the frozen executable source `29d6dda`, two consecutive `npm test` runs each passed **371/371**, with zero skips or failures (46.856 s and 46.830 s). The earlier desktop checkpoint passed 345/345. An intermediate media run passed 356/357: the positive PNG fixture had an invalid IDAT checksum. The corrected test uses a valid PNG and retains explicit rejection coverage for bad checksums and oversize images. The theme harness also needed to pace the sender’s pinned file handle after source verification stopped reopening filenames. With two real in-progress transfers, both final sizes passed again before and after process restart.

Plain `npm start` opened the room login and exited normally on Linux. A separate console-instrumented login reported zero DevTools errors. The plain terminal emitted two Chromium ERROR lines for Linux netlink and udev access. The requested zero-error terminal check therefore remains open on Windows. Both 127.0.0.1 terminal demos exchanged messages. The original failures tested against the archived main source are listed separately in the field report below.

All results here are single-computer results. Network exercises used loopback, controlled capability changes, local relays or a fake router as identified. Electron UI checks used Linux x64 and Electron 40.5.0. Node tests used 24.22.3.

| Feature | Observation |
| --- | --- |
| Original field-fault regressions | Election, fake UPnP and file transfer suites passed 41/41 on the desktop checkpoint. Both terminal demos exchanged chat. The [field report](FIELD_RECOVERY_REPORT.md) lists the original nine failing-on-main cases and passing fixes, UTC log evidence, and the distinct field build. |
| Theme and room window | With three peers, two in-progress transfers, an unsent draft and a scrolled transcript, every theme retained peer count, transfer state, caret focus, pane width, unread count and the same anchor/offset at both 1280×720 and 800×600. The selected skin persisted through a cold restart. Twenty sampled roles per theme passed the contrast checks. Minimum sampled ordinary text was 4.77:1. |
| Window controls | Real XFWM mouse drag, resize, maximize, restore, minimize, double-click title, keyboard controls and Alt+F4 worked. 150% device-scale checks covered 560×480 and 400×480 CSS pixels. |
| Compact transcript, transfers and audio | Compact view preserved focus, selection, the anchor and one unread divider. Two transfers retained independent progress and status. A real mute and held PTT input matched the remote state with synthetic microphone input. |
| Manual Idle Peer | The idle relay kept established routes and forwarded remote traffic. The tray restored the same room with capture off. Real 0.6.0 and 0.7.0 peers kept interoperating. |
| Voice panel | On XFWM above a separate windowed game, three Electron profiles with synthetic microphones showed active speakers. Either window could mute the same stream. Host loss, peer departure and close/reopen retained the correct state. Capture count stayed at one, window bounds persisted, and entering Idle Peer removed the panel. |
| Attention | Three hidden mentions generated one native Linux D-Bus notification. Its action selected the intended channel and message. Private notification text was generic. Four distinct Web Audio signals were measured for join, mute, unmute and leave. |
| Public channels | Three keyed peers converged on the same catalog, including empty channels and channels whose posts left the 200-message window. Equal display names created on separate peers kept separate IDs. With an actual 0.7.0 peer, a 200-record replay delivered all 120 General posts and zero of the 80 named posts to its General transcript. Follow-up live traffic delivered all 24 General posts and zero of the 16 named posts to it. |
| Cold archive | Two real Electron profiles used KWallet 6 and SQLCipher. After both exited, B reopened alone and displayed General (1), Paddock (2) and Empty channel (0). On a disposable profile, actual 0.7.0 reopened General (1). Upgrading again restored the same two named posts. No renderer errors occurred. Same-name rooms with different credentials, shared retention, paging, save-off, Clear and Forget also have automated checks. |
| Whispers | Direct and circuit-relayed messages reached the intended keypair. A same-name bystander serving as host/relay had no marker in its app events, logs, replay or archive. A replacement keypair with the same display name received zero messages for the former recipient. Chat with 0.6.0 and 0.7.0 peers continued both ways. |
| Screenshare feasibility only | The [generated-source experiment](SCREENSHARE_FEASIBILITY.md) encoded and decoded 1280×720 VP8 at about 15 fps. The direct and circuit paths each delivered 120/120 captured frames. It also records concurrent synthetic voice and measurement boundaries. |

## 127.0.0.1 attachments and large transfers

An actual clipboard paste at 800×600 followed by Cancel sent nothing. Pasting again with a caption produced one card. The receiver got a thumbnail with zero completed downloads, then saved the original **165,236-byte PNG**. Its SHA-256 matched the staged screenshot, `1cc3431365cd853f34fd1ac7eb252c94e463d583599d344cb918a47695b88017`. Offer-first and card-first delivery each produced one card. Manual thumbnail mode requested nothing until clicked. Malformed and oversized derivatives left the original action available. Actual 0.7.0 and 0.6.0 peers retained readable fallback text and ordinary file offers.

Two Electron profiles exercised a still GIF poster, play and pause with sampled pixels, and a **108,223,724-byte VP8/Opus WebM**. The saved video matched SHA-256 `66877c706736d31a14be46c126268ba62963de1ab441964651c0604adbc86dfe`. Seek, pause, volume and Idle Peer playback stop worked. With both profiles closed, KWallet 6 and SQLCipher preserved three General cards and one named card. A receiver alone reopened the verified photo and video, rejected a same-length changed original and retained its Downloads files through Clear and Forget. These checks cover the tested codecs. The 32 MiB thumbnail cache has its own Clear action.

The isolated test forced disk-full both before the receive stream opened and during a write. Both ends reported failure, zero partials remained, and a separate recipient could finish. Tests also covered a changed source before transfer, changed bytes during transfer, cancellation before a data stream existed and name collisions on a filesystem without hard links.

A **1 GiB** file on each route exposed a gap between bytes handed to the mux and bytes written at the receiver. The updated endpoints negotiate an 8 MiB window. Only forward progress reported by the authenticated receiver advances it. The sender still requires the separate delivery receipt after verification. Old endpoints retain their existing application protocol.

| 127.0.0.1 forced route | Original time for full retry | Final time for full retry | Original / final peak RSS | Original / final sender lead at the interruption |
| --- | ---: | ---: | ---: | ---: |
| Direct TCP | 24.902 s | 29.954 s | 746,336 / 194,308 KiB | 506,855,436 / 3,342,336 B |
| Circuit relay | 79.457 s | 75.181 s | 798,844 / 274,292 KiB | 433,848,320 / 6,488,076 B |

Each trial cut the first transfer after the receiver wrote about 40%. No partial remained. Each fresh retry transmitted all 1,073,741,824 original bytes, with matching receiver SHA-256 `0509dbcbccfd9afabdb43b2880160c6eb12d4ea747b4c9b8a14ec9db4cf0279c`. RSS is the high-water mark of one Linux process containing sender, receiver and optional relay. Times run from offer to sender confirmation and include preparation. The separate slow-disk regression measured a maximum sampled lead of 42,729,472 bytes before and 7,864,332 bytes after the change. A deployed friend's upstream speed and the frequency of interrupted large transfers still determine whether resumable downloads warrant implementation. The repeatable harness is `tools/measure-large-transfer.mjs`.

A separate real mixed-version test exchanged a 12 MiB original in both directions with each of the actual 0.6.0 and 0.7.0 sources. All four downloads matched byte for byte, subsequent chat succeeded, and the sender used the legacy completion label when a legacy receiver did not confirm.

The [Idle Peer measurements](IDLE_PEER_CHECKS.md) cover four 60-second windows on this Linux machine, including quiet and actively forwarding intervals. The [screenshare measurements](SCREENSHARE_FEASIBILITY.md) describe generated content, capture costs and timing measurements for the proposed Windows trial.

## Field and release gates

Windows 10 execution, real microphone and speaker quality, native Windows toast activation, Explorer tray interaction, Windows Snap and mixed-DPI monitors, game overlay behavior and upgrade under DPAPI remain open. A cross-built Windows binary was inspected on Linux. Linux Chromium emitted host-environment diagnostics concerning netlink and udev during startup. No LAN, internet or multi-person test was performed in this follow-on.

Use the original pinned build for the operator’s first Night 1 observation unless the operator selects and records a different candidate. A real router first-lease expiry, the isolated-Laptop reconnection, a newly arriving outside peer and alternate-relay conversational recovery require the operator’s networks. The Shared shelf follows this observation. A per-user installer and sign-in startup, production screenshare, transfer resume and the group ready check retain the prerequisites in the [work plan](WORK_PLAN_1.0.md). Three qualifying game nights and the final Windows candidate still gate 1.0.

## Commits and changed files

The base is [7ada7bb](https://github.com/noveblue53/asscrack/commit/7ada7bbf5c2776ac5d8601d6b96cbcb361099ecc). The earlier [field recovery report](FIELD_RECOVERY_REPORT.md) inventories that branch against main. The following commits are unique to the desktop follow-on.

| Source commit | Changes |
| --- | --- |
| [414f857](https://github.com/noveblue53/asscrack/commit/414f857b65d24f12e653ce35e27c19cb00b4f750) | Six themes and title bar, Idle Peer, attention, durable public channels, online whispers and regression coverage |
| [4ffa209](https://github.com/noveblue53/asscrack/commit/4ffa20959e458da515db9fdc6c3500cef7bef3b4) | Generated screenshare and separate direct/circuit feasibility measurements |
| [a00033a](https://github.com/noveblue53/asscrack/commit/a00033ad67c071fb3a58f5885c23e0e1100f0f91) | Detachable voice panel, screenshot staging, negotiated media cards, encrypted metadata and local playback |
| [29d6dda](https://github.com/noveblue53/asscrack/commit/29d6dda4e978521a38b6c8f807056537c826815d) | Verified cold media reopen, bounded application write-ahead, cancellation/path handling and large-transfer tests. This is the executable source. |
| This report’s documentation commit | Binary and loopback results, branch status and updated work plan |

All 78 changed paths relative to the pinned field branch are listed below. Package version, dependencies and lockfile match main.

**Repository root**

`CHANGELOG.md`, `README.md`.

**docs**

`DESKTOP_REVIEW.md`, `IDLE_PEER_CHECKS.md`, `SCREENSHARE_FEASIBILITY.md`, `WORK_PLAN_1.0.md`.

**src/application**

`attention.css`, `attention.js`, `attention.mjs`, `channels-ui.js`, `chat-attachments.js`, `chat-media.css`, `chat-media.js`, `clipboard-image.mjs`, `desktop-controls.css`, `highlights.js`, `index.html`, `layout.js`, `main.js`, `media-formats.mjs`, `menu.js`, `nodemap.js`, `peer-inspector.js`, `preload.cjs`, `reading.js`, `renderer.js`, `room-archive.mjs`, `room-media.mjs`, `saved-rooms-ui.js`, `saved-rooms.mjs`, `styles.css`, `themes.css`, `themes.js`, `typing.js`, `voice-cues.js`, `voice-monitor-preload.cjs`, `voice-monitor.css`, `voice-monitor.html`, `voice-monitor.js`, `voice-monitor.mjs`, `voice.js`, `whispers.css`, `whispers.js`, `window-frame.css`, `window-frame.js`, `window-frame.mjs`.

**src/application/img**

`logo.svg`, `tray.png`.

**src/network**

`attachment.mjs`, `channels.mjs`, `file-transfer.mjs`, `history.mjs`, `node.mjs`, `whispers.mjs`.

**test**

`app-events.test.mjs`, `attention.test.mjs`, `channel-media.test.mjs`, `channels.test.mjs`, `clipboard-image.test.mjs`, `file-credit.test.mjs`, `file-transfer.test.mjs`, `history.test.mjs`, `idle-peer.test.mjs`, `layout.test.mjs`, `presence-ui.test.mjs`, `room-archive.test.mjs`, `room-media.test.mjs`, `saved-rooms.test.mjs`, `themes.test.mjs`, `voice-monitor.test.mjs`, `whispers-ui.test.mjs`, `whispers.test.mjs`, `window-frame.test.mjs`.

**test/helpers**

`renderer-fixture.mjs`.

**tools**

`measure-large-transfer.mjs`.

**tools/screenshare-bench**

`bench.html`, `main.cjs`, `routes.mjs`.
