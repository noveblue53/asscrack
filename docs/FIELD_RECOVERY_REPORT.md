# Field-recovery review

The operator can review this branch against 0.7.0 main at `de54371`. The incident on three Windows computers belongs to the archived November 20 executable. The table below records new checks on one Linux computer. All network traffic in those checks used 127.0.0.1. The branch keeps version 0.7.0, the lockfile and the existing dependencies. The operator owns the merge.

## Candidate

- Source `c906a81714808ca5bde46e6494c7bb6f53dad5bf`, Windows x64 portable `ASSCRACK-0.7.0-review-c906a81.exe`.
- Executable size 106,748,791 bytes. SHA-256 `e0f9f9915e42bc6245c81a2bb21a70898d9f0ae19bc428d1e9d8b3f4f65eedfc`.
- Built on Linux x64 using the repository lockfile and `npm run dist -- --x64` with an output-directory override. The executable is unsigned. The regular portable launcher and Windows resource editing ran. The payload embedded in the executable passed its integrity check. 59 application and network files matched the source byte for byte. The encrypted SQLite and global keyboard hook binaries are both Windows x64 PE modules.
- Quit all running copies before comparing two builds. Both use the same display version and portable unpacking path. Use an old-profile copy for the upgrade and retain the original.

## 127.0.0.1 results

| Check | Observed result |
| --- | --- |
| Original incident regressions | All nine failed against `de54371` with the tests overlaid. All nine passed with the three fixes. The combined deduplication and fault-fix tree passed 279/279. The voice-direct tests passed 2/2 in each of three extra runs. |
| Recovery suite and final suite | The saved-room integration tree passed 291/291. The final frozen source passed **321/321**. Two full runs passed with the corrected transport observation at `2a5d14b`. The application and network files are identical to the packaged source. |
| Earlier development failure | One intermediate 308/309 run caught the desktop renderer while its offer summary handler was incomplete. The completed handler passed its focused regressions and the full run above. |
| Host and delivery compatibility | Actual 0.6.0 host, 0.7.0 member and updated member agreed on the incumbent after isolation. Updated and legacy nodes transferred bytes in both directions and exchanged subsequent chat. Capable receivers confirmed delivery. Legacy receivers showed an unconfirmed send. |
| Relay burst test correction | With the original observer the frozen source returned 320/321 and then 321/321. In the failed run 73 of 144 host-replayed rows reached B before their original live messages. The app emits the display event only for a new ID. The transport check now observes authenticated live frames and verifies all IDs, the original bodies and order, and one visible copy per ID. A controlled 127.0.0.1 run on both the candidate and the base delivered 200/200 source frames in order and displayed every ID once when replay won the race. The timeout, byte volume and message count are unchanged. |
| Returning routes | A saved full node retried when started alone. A changed identity retained a reachable endpoint. A stale address answering for a different keyed room advanced to the next hint. A reservation that became available after the ten fast attempts recovered chat. Both terminal demos exchanged messages in room `t`. |
| Alternate relay | Four libp2p nodes, two full and two restricted. After graceful host shutdown the first new synthetic voice frames arrived in both directions after 39/39, 39/39 and 42/42 ms. Each direction delivered 64, 64 and 50 distinct frames respectively across at least one second in the three runs. Forwarding counters identified both relays. Newly generated live chat arrived both ways. |
| Real 0.7.0 profile upgrade | Linux Electron 40.5.0, KWallet6 and native encrypted SQLite. All old processes exited. The first returning profile opened all 250 original IDs offline. The fresh peer received exactly IDs 51–250. A less complete host sent only its own three IDs. Room fingerprints separated same-name rooms. After Clear, replay stayed visible without rearchiving. Only newly eligible IDs 251 and 253 persisted across restart. Forget affected the selected profile and room. |
| Real 0.6.0 profile upgrade | A candidate opening the old profile preserved its address hints and found zero archived rooms. It used the original invite to rejoin an actual 0.6.0 peer, opted in and recovered exactly the two subsequent IDs offline. |
| Local protection | The tested KWallet6 profile used SQLite3 Multiple Ciphers 2.7.1, SQLCipher compatibility format 4 and DELETE journaling. Plain and wrong-key reads failed. A scan of 413 app-written files found zero copies of the unique test text or invite, in UTF-8 or UTF-16LE. Windows account protection requires a separate check. |
| File sharing through the actual window | The sender selected one of two identically named buddies. The selected peer saved the original bytes. The other saw no descriptor and received zero bytes even with the offer ID. Cards shared accept/refuse/reveal state with Transfers. A group displayed one delivered and one declined. The reading anchor moved 0 CSS px on incoming offers. Composer controls remained clickable with the map open at 560×480, 800×600 and 1280×720. |
| Topic, typing and highlights | Concurrent topic proposals converged through host change. Old hosts disabled editing. Current and actual legacy peers still chatted. Typing expiry, opt-out/restart and same-name typists passed. DND retained visual nick/keyword jumps. Replay and quoted text created no extra stops. |
| Listening and diagnostics | The local mixer muted one origin and halved another without affecting the other listener or forwarded traffic. The inspector distinguished same-name peers and marked the measured route. Room activity supported pause/resume and redacted copy. Speaking quality on physical devices is open. |
| Desktop start | `npm start` exited 0. Eight Electron launches produced zero renderer errors. Two frozen startup checks emitted four Linux environment diagnostics each in the terminal, from NETLINK, udev and socket permissions. An earlier working-tree start also reported a transient GPU command-buffer error. A terminal launch without error lines remains open. |

The Node test runner was 24.22.3. Electron 40.5.0 embeds Node 24.13.1 and Chromium 144.0.7559.177. Loopback runs supplied a network-interface descriptor because the sandbox denies interface enumeration. The UPnP tests used a fake router. Audio transfer tests used generated payloads or a synthetic decoder. The Windows executable was cross-built and inspected on Linux.

An updated sender splits history at 512 KiB per encoded frame and 200 rows. A legacy host can still send a single replay larger than that limit. The updated client discards that frame and accepts subsequent ordinary chat. A 0.6.0 or 0.7.0 member can still originate a higher election term while isolated. The candidate follows the existing wire rules when merging with it. To paste a refreshed invite while already waiting in a room, relaunch into Join. The local archive and protocol window have separate lifetimes. Clearing local data cannot revoke bytes already handed to transport or another member’s copies.

## Remaining gates

1. Run card 9 on the archived and candidate Windows executables. Establish the original three-PC topology. Isolate the restricted Laptop, rejoin after timeout, verify fresh inbound TCP after the original UPnP lease and interrupt a real transfer. Record timestamps and actual router and file outcomes.
2. Run the separate four-PC alternate-relay case and exchange new intelligible phrases both ways. Measure the gap. Exercise microphone release, push-to-talk, Windows account-protected upgrades, native file reveal and window/keyboard behavior on Windows 10.
3. Complete the first ordinary game night before starting the session-scoped Shared shelf. Continue the existing release order with public channels, online whispers, portable Idle Peer, sounds and notifications. Screenshare is a feasibility experiment. The installer sign-in action has its own acceptance criteria. Themes, media and other optional milestones remain in the plan.
4. The everyday room still has follow-up polish, including moving voice actions beside Buddies and moving the per-bubble archive mark to message details. The four-peer experiment used a graceful stop, and endpoint packet timing cannot measure audio intelligibility.
5. Complete three qualifying game nights and final artifact verification before a 1.0 tag or publication. No LAN or internet test ran for this branch.

## Commits and changed paths

| Commit | Change |
| --- | --- |
| [`dd212bc`](https://github.com/noveblue53/asscrack/commit/dd212bc38a96a18620d9d066f0d489f66d2709f7) | Keep an isolated member out of host elections |
| [`0c3589d`](https://github.com/noveblue53/asscrack/commit/0c3589dbf55dac8b41d283098fbed0104905e14d) | Renew the UPnP lease and retry failed refreshes |
| [`e2f431b`](https://github.com/noveblue53/asscrack/commit/e2f431b61d642c7a81b3bfdeb203253ac4c7fbca) | Wait for the receiver to verify and save an offered file |
| [`f1f267a`](https://github.com/noveblue53/asscrack/commit/f1f267a0988b588c1dbf5d5a8b5b6c6c6ae64630) | Record the 0.7.0 field faults and loopback verification |
| [`710a930`](https://github.com/noveblue53/asscrack/commit/710a9300babb5f244725cef29e2efcee64be49b5) | Open one chat stream for each peer when connect() and discovery dial at the same time |
| [`44b40b3`](https://github.com/noveblue53/asscrack/commit/44b40b314661940a051e880594689d6bb9d8ceb6) | Merge remote-tracking branch 'origin/opus/connect-dedup' into work/0.7-field-recovery |
| [`0b27024`](https://github.com/noveblue53/asscrack/commit/0b270248a6d4ed6738c462b9d29db47e5ee71c75) | Plan the room UI, six themes, typing, telemetry and inline chat media |
| [`95d852d`](https://github.com/noveblue53/asscrack/commit/95d852de85c245f2b07deaf63bc8f6d46c0aa481) | Plan tray-based Idle Peer, sign-in startup and notification behavior |
| [`3ddd813`](https://github.com/noveblue53/asscrack/commit/3ddd8136f6727e6f28ad50ede4737612d398cea3) | Merge remote-tracking branch 'origin/codex/work-plan-chat-experience' into work/0.7-field-recovery |
| [`e0ea1da`](https://github.com/noveblue53/asscrack/commit/e0ea1dae8e461802bb14c82e9e833fe508ccc5cd) | Apply field findings to release order and Windows retest card |
| [`bfdf9c8`](https://github.com/noveblue53/asscrack/commit/bfdf9c8a341b115e5f0227ad322d2439278b18e4) | Show the evidence for each chat route in the network map |
| [`ab90391`](https://github.com/noveblue53/asscrack/commit/ab90391adadc34be3f6231fd8964a2d7a4e14df9) | Restore eligible saved-room history and recover reachable endpoints on rejoin |
| [`792a0f2`](https://github.com/noveblue53/asscrack/commit/792a0f22a408ecd2dffb0cb013dc4416ca8b8a54) | Retry a returning full node and remember its verified endpoint after identity changes |
| [`ee607e6`](https://github.com/noveblue53/asscrack/commit/ee607e6375945408c0a27b05b155670112b70077) | Enforce the selected file recipient on offers and download streams |
| [`772e17b`](https://github.com/noveblue53/asscrack/commit/772e17bb1f24bd86154be55932805f2ad80a788b) | Order live room topics at the elected host and retain them across failover |
| [`e38a782`](https://github.com/noveblue53/asscrack/commit/e38a78237070a809e0f260232a121f9f81b21af8) | Scope typing indicators to current chat sessions and expire them after silence |
| [`f934724`](https://github.com/noveblue53/asscrack/commit/f9347243976a8a1579d34bd62a3af4bf5553774a) | Record local route evidence and exercise two-way traffic through an alternate relay |
| [`f7146b9`](https://github.com/noveblue53/asscrack/commit/f7146b906e181bdfe02ab4bf856ff1114712b62d) | Coalesce quick typing restarts without sending old edits to new sessions |
| [`1e6f7fc`](https://github.com/noveblue53/asscrack/commit/1e6f7fcbc20e2ef489c7c841febd56c1cad41eef) | Try the next saved endpoint when another keyed room answers |
| [`feaa1c8`](https://github.com/noveblue53/asscrack/commit/feaa1c8651972f53086710fb4c7d79abca23bdcd) | Invalidate queued replay rows before the transport takes its next frame |
| [`1ee3eb7`](https://github.com/noveblue53/asscrack/commit/1ee3eb7b78280d64472ffc3bacfe0d693a2be4d1) | Connect the room composer, topics, highlights, listening controls and peer details to the desktop |
| [`1a97627`](https://github.com/noveblue53/asscrack/commit/1a97627bf97f347975d96732fe47febff8c42954) | Keep the original ordering of live messages behind a slow replay |
| [`f682c59`](https://github.com/noveblue53/asscrack/commit/f682c59159717d65af57388796932c054cdc126f) | Filter room diagnostics by peer and local file transfer before copying |
| [`c906a81`](https://github.com/noveblue53/asscrack/commit/c906a81714808ca5bde46e6494c7bb6f53dad5bf) | Point the field card to the exact review executable |
| [`2a5d14b`](https://github.com/noveblue53/asscrack/commit/2a5d14b542e60079650ebc0e828a62350d58a5e2) | Measure the 200-message relay burst on the live stream and verify presentation separately |

The final documentation commit adds this report and records the results in the changelog, README and work plan. Its hash is available at the branch head.

**All 59 changed paths since 0.7.0 main**

- `CHANGELOG.md`
- `README.md`
- `docs/FIELD_RECOVERY_REPORT.md`
- `docs/WORK_PLAN_1.0.md`
- `src/application/activity-view.js`
- `src/application/activity.css`
- `src/application/highlights.js`
- `src/application/index.html`
- `src/application/layout.js`
- `src/application/main.js`
- `src/application/menu.css`
- `src/application/menu.js`
- `src/application/nodemap.js`
- `src/application/peer-inspector.js`
- `src/application/preload.cjs`
- `src/application/reading.css`
- `src/application/reading.js`
- `src/application/renderer.js`
- `src/application/room-activity.mjs`
- `src/application/room-archive.mjs`
- `src/application/saved-rooms-ui.js`
- `src/application/saved-rooms.mjs`
- `src/application/styles.css`
- `src/application/typing.js`
- `src/application/voice-worklet.js`
- `src/application/voice.js`
- `src/network/chat-session.mjs`
- `src/network/chatreadme.md`
- `src/network/election.mjs`
- `src/network/file-transfer.mjs`
- `src/network/history.mjs`
- `src/network/node.mjs`
- `src/network/room-topic.mjs`
- `src/network/transceiver.mjs`
- `src/network/typing.mjs`
- `test/app-events.test.mjs`
- `test/chat-session.test.mjs`
- `test/connect-race.test.mjs`
- `test/election.test.mjs`
- `test/file-transfer.test.mjs`
- `test/helpers/fake-igd.mjs`
- `test/helpers/renderer-fixture.mjs`
- `test/highlights.test.mjs`
- `test/history.test.mjs`
- `test/nodemap.test.mjs`
- `test/peer-inspector.test.mjs`
- `test/rejoin.test.mjs`
- `test/relay-spread.test.mjs`
- `test/relay.test.mjs`
- `test/room-activity.test.mjs`
- `test/room-topic-ui.test.mjs`
- `test/room-topic.test.mjs`
- `test/saved-room-replay.test.mjs`
- `test/saved-rooms-ui.test.mjs`
- `test/saved-rooms.test.mjs`
- `test/typing-ui.test.mjs`
- `test/typing.test.mjs`
- `test/upnp.test.mjs`
- `test/voice-listening.test.mjs`
