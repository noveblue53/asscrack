# ASSCRACK

**Automated Server Switch in Case Relays Are Crashed or Killed**

ASSCRACK is a peer-to-peer desktop app for small groups to chat, talk and share files.
The room owner invites individual devices and chooses which ones may take over as host.

> **Private test candidate.** Noise encrypts connections between peers. Room members can read public chat,
> and the host can hear the voice traffic it forwards. Whispers go to the selected peer.

## Status

| Item | State (2026-11-21) |
|---|---|
| Current candidate | 0.8.0, Windows x64 portable build `ASSCRACK-0.8.0-portable.exe`. It contains the release hardening of RC2: device admission, host permissions, revocation and bounded network operations. The 0.8.0 changes are a compact `asscrack3:` invite code (410 characters for one host, before 850), the asynchronous `safeStorage` calls and an update text for 0.7.0 peers. All 0.8.0 results are 127.0.0.1 results. [Changelog](CHANGELOG.md) |
| Compatibility | 0.7.0 cannot read an `asscrack3:` code and cannot find a 0.8.0 LAN room. Only a legacy shared-code room (`asscrack1:`) can have the two versions together. Each user must update to 0.8.0. |
| Earlier friend pilot | Windows x64 portable RC1 uses the 0.7.0 app version. The changelog records the exact executable SHA-256 and frozen source. [Draft download](https://github.com/noveblue53/asscrack/releases) · [Build and verification](CHANGELOG.md#unreleased--windows-friend-pilot-release-candidate) · [Field card](docs/FRIEND_PILOT.md) |
| Prior 0.7.0 field build | Three Windows peers used the build from `8dacddd` in the November 20 internet test. Its SHA-256 and observed faults are in the [changelog](CHANGELOG.md). |
| Earlier review builds | The [field recovery report](docs/FIELD_RECOVERY_REPORT.md) and [desktop review](docs/DESKTOP_REVIEW.md) list the earlier x64 executable identities and single-computer results. |
| Field acceptance | The friend pilot covers the open router-lease, reconnect, interrupted-file, alternate-relay and Windows profile checks. These checks and the game nights come after the 1.0 release (operator, 2026-11-21). [Release plan](docs/WORK_PLAN_1.0.md) |
| Phase | The 1.0 features. 1.0 is a full-featured release before the friends get it (operator, 2026-11-21). Next: screenshare, resume of large transfers, a ready check and an installer with start at sign-in. Then a security audit and the 1.0.0 build. The field checks with other users come after 1.0. See the roadmap below. |

### How to read the results

Each result in this file and in [`CHANGELOG.md`](CHANGELOG.md) has one of these labels:

- **LAN**: a test on 2 or more real computers on one local network.
- **Internet**: a test on 2 computers on different networks, for example a home router and a phone hotspot.
- **127.0.0.1**: a test on one computer only. It does not prove that the feature works on a LAN or on the internet.

## Features and evidence

| Feature | What it does | Best result so far |
|---|---|---|
| LAN discovery | The members of a room on one network find each other through mDNS. No address input. | LAN |
| Text chat | Chat lines go to each member of the room. Names show as soon as a member joins. | LAN, internet (0.5.0) |
| Host election and failover | Protected rooms elect an admitted device with hosting permission. An authorized alternate takes over if one is available. | LAN (0.2.0). Recovery time on the internet: not measured. |
| Chat history | The host sends up to 200 recent lines to each new or restarted member. | LAN (0.3.1) |
| Voice | Opus frames on a libp2p stream. The host forwards the frames. Two members with a direct connection send frames directly (0.6.0). | Voice through the host: LAN, internet (0.5.0). Direct voice: 127.0.0.1 |
| File sharing | Offer a file to the room. Each member can accept or refuse it. The receiver checks the SHA-256 and keeps no partial file. | LAN (0.3.1), internet (0.5.0) |
| Cancel for one receiver | The sender can stop the transfer to one receiver. The other receivers continue. | 127.0.0.1 |
| Room access | New rooms use invitations issued to a specific device. Earlier shared codes require explicit trust. | Device admission on loopback. Earlier shared codes tested over the internet (0.5.0). |
| Rejoin with the invite code | The host leaves and comes back with the same code. The members find the host again. | Internet (0.5.2) |
| UPnP host | Select the UPnP option to ask your router to forward a TCP port. | Port map on a real router: internet (0.6.0). A join through that code: not tested. |
| Full nodes and relays | A member with a reachable port is a full node. It relays chat, history, files and voice for members that cannot connect directly. The relays spread across the full nodes. | 127.0.0.1 |
| Network map | A panel shows the members, the host, the direct and relay links, the speakers and the file transfers. | 127.0.0.1 |
| Room window (not released) | Panels with saved sizes, a View menu, context menus, the reading position and an unread count. | 127.0.0.1 (same PC) |
| Quote and Find (not released) | Quote a line in a reply. Ctrl+F finds text in the loaded lines. | 127.0.0.1 (same PC) |
| Manual status (not released) | Set Available, Away or Do not disturb, with a note of at most 80 characters. Each buddy line shows the state. An old client shows "status unknown". | 127.0.0.1 |
| Saved rooms (not released) | Save an internet room on this computer, with an encrypted local history. Reopen it the next day. Keep local history on or off, Clear the saved lines, or Forget the room. A send that no peer got shows "Only on this computer". At most 10,000 saved lines and 8 MiB for each room. | 127.0.0.1 |
| Voice settings (not released) | Echo cancellation, noise suppression (RNNoise, Standard or Off) and gain control. Voice activity with a sensitivity slider, a live meter and a release delay. Push to talk with a key that the user sets, also while the window is in the back. Microphone and speaker selection. | 127.0.0.1 (same PC, virtual audio cables) |

## Known limits

- **Windows distribution.** The portable executable targets Windows. Automated and Electron checks on this review branch ran on Linux.
- **Saved history only for saved internet rooms.** Since milestone 6 part 1 (127.0.0.1 results only), the app
  saves the lines of a saved internet room in an encrypted local database. LAN rooms stay live sessions with no save.
  The packaged Windows checks of saved rooms are open.
- **A send with no peer stays local.** When no peer gets a message, it shows "Only on this computer". It is not saved,
  and a peer that joins later does not get it (milestone 6 part 2, 127.0.0.1).
- **Limits of the saved history.** At most 10,000 lines and 8 MiB of text for each saved room, and 64 KiB for each
  line. The app deletes the oldest lines first. The app saves only lines that it sent or received live. A host replay
  shows recent lines but does not make a saved copy.
- **Two kinds of encryption.** Noise encrypts each peer connection. Encrypted local storage (SQLCipher with a
  `safeStorage` key) protects the saved lines on the disk of this computer. It does not protect them from other apps
  of the same Windows user.
- **Internet rooms need one reachable member.** At least one member must have a forwarded TCP port or a router that
  allows UPnP. A member behind a carrier-grade NAT (CGNAT) cannot be a full node.
- **No fallback route, no connection.** Members that connect only through one relay lose the connection when that relay
  leaves. They dial the known full nodes again every 5 seconds.
- **Device access.** A device ID identifies an installation. Verify the ID with your friend before issuing their
  invite. The owner must be online for that device’s first admission. A saved room retains its access state in the
  encrypted archive. Revocation takes effect as connected peers receive the owner’s signed update. An isolated
  group can keep using its last known state until it reconnects. People can keep content they already received.
- **Voice and route privacy.** The host can decode the audio it forwards. A circuit relay sees who connects and
  when traffic flows. The Noise connection between whisper endpoints protects their message content through the relay.
- **Firewall question.** Windows asks one time for each build. Allow the app on private networks.
- **Push to talk in the back uses a key hook.** While you are in voice in push-to-talk mode, the app watches the
  keyboard and the mouse of the system for the one key. It does not keep or log other keys. Clear the option "Also
  when ASSCRACK is in the back" to use push to talk only in the app window.

## Get started

ASSCRACK has no public release yet. The test team copies a portable `.exe` to each computer.

### Build and run from source

Use Node 24 and the lockfile of the project.

```bash
npm ci
```

```bash
npm start
```

To start two copies on one computer, give each copy its own profile folder:

```bash
npm start -- --profile ./profile-a
```

```bash
npm start -- --profile ./profile-b
```

On Windows, `npm run dist` creates `dist/ASSCRACK-<version>-portable.exe`. For a verified Windows x64 candidate, install the locked dependencies with `npm ci --ignore-scripts`, run `npm test`, and choose a fresh output directory.

```powershell
./build/build-windows-candidate.ps1 -OutputDirectory 'C:\builds\asscrack-private'
```

The private candidate includes an executable digest and payload verification report. For signed staging, install the approved signing certificate in the signing account’s Windows certificate store and configure `ASSCRACK_WINDOWS_SIGNER_SHA1` and `ASSCRACK_WINDOWS_SIGNER_SHA256`. Run the same command with `-Mode TrustedSigned`, then verify both signatures and hashes independently before publishing. [Windows signing and verification](docs/WINDOWS_RELEASE.md)

### Run the tests

The tests start real libp2p nodes on 127.0.0.1.

```bash
npm test
```

### Terminal demo

The terminal demo listens on loopback by default. Its optional `--trusted-lan` mode uses the legacy shared LAN room. Use the desktop app for protected rooms.

```bash
node src/network/transceiver.mjs --room <name> --name <name>
```

### Host an internet room

1. Choose **Create protected internet room**, and enter your name and room name. Use **Save room on this device** to keep the room for a later session.
2. For an internet room, enter the public address of a TCP port forwarded to your computer before logging in, or select **Ask my router to open a TCP port (UPnP)**. Then select **Log In**. A protected LAN room uses local discovery.
3. Have your friend choose **Join with invite code** and **Copy my device ID**. Confirm that ID with them through a channel you trust.
4. In your room, open **Invite**, enter that device ID, and choose **Create device invite**. Grant hosting permission only to devices you trust with host duties. Send the resulting code to that friend and stay online for their first join.
5. Open **Invite** to see issued devices and revoke one. Other connected members enforce the signed update when they receive it.

## How it works

| Part | Technology |
|---|---|
| Peer-to-peer network | libp2p with TCP, Noise encryption and Yamux |
| LAN discovery | mDNS |
| Internet reachability | Circuit relay v2 through full nodes, a dial-back check, UPnP |
| Roles | Host election with terms and heartbeats |
| Voice | WebCodecs Opus (48 kHz, 20 ms, 32 kbps) on libp2p streams |
| Files | Chunks on a libp2p stream, direct from the sender to each receiver, with a SHA-256 check |
| Desktop app | Electron, packaged as one portable Windows `.exe` |
| Logs | One log file for each start in `%APPDATA%\asscrack\logs`, with no chat text |

The network code is in `src/network/`. The Electron app is in `src/application/`. The tests are in `test/`.

## Roadmap

| Phase | State |
|---|---|
| 1. Peer-to-peer mesh and LAN discovery | Done. LAN tested. |
| 2. Host election and failover | Done. LAN tested on 2 computers. |
| 3. Mumble server | Not planned. Voice uses Opus on libp2p streams. |
| 4. Voice with reconnect | Done. LAN tested (WebRTC, 0.2.0 and 0.3.1). Voice on libp2p streams internet tested (0.5.0). Echo and noise suppression, voice activity and push-to-talk (5C) are on `main` with 127.0.0.1 results. Next: the 5C test on 2 computers. |
| 5. Chat | Chat and history after a restart passed on LAN. Quote/Find, availability, saved rooms, topics, highlights, channels and online whispers have single-computer coverage. |
| 6. File sharing | Ordinary transfers passed on LAN (0.3.1) and the internet (0.5.0). Recipient-level delivery, inline media, fresh retry and the Shared shelf are part of the friend-pilot checks. |
| 7. Desktop experience | The room, themes, map, tray and detachable voice panel have single-computer evidence. A polish pass (2026-11-21) repaired 27 visual and keyboard faults of the room window (127.0.0.1). The app has its own icon in the .exe, the window, the taskbar and the tray (this PC). Windows shell and device checks are open. |
| 8. Internet rooms | In progress. Invite codes and rejoin are internet tested. Device admission and the compact `asscrack3:` invite (0.8.0) have 127.0.0.1 results. UPnP join, relays and failover on the internet are open. |

Release 1.0 is the full-featured release. It adds screenshare, resume of large transfers, the ready check and an
installer with start at sign-in. After the features come the security audit and the 1.0.0 build. The game nights with
friends come after 1.0. See [`docs/WORK_PLAN_1.0.md`](docs/WORK_PLAN_1.0.md).

## Documents

- Follow the short Windows rehearsal and game-night checks. [Friend-pilot field card](docs/FRIEND_PILOT.md)
- Find releases and unreleased changes with their evidence labels. [Changelog](CHANGELOG.md)
- Find the detailed LAN and internet test cards. [Network test cards](src/network/chatreadme.md)
- Follow the milestone acceptance criteria, the 1.0 ship decision and the game nights after 1.0. [Release plan](docs/WORK_PLAN_1.0.md)

## License

MIT License. See [`LICENSE`](LICENSE).

## Acknowledgments

- The libp2p team, for the peer-to-peer network stack
- Noveblue, Parker, Sunmanga, HBO Max Verstappen
- Discord ;)
