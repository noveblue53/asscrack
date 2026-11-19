# ASSCRACK

**Automated Server Switch in Case Relays Are Crashed or Killed**

ASSCRACK is a peer-to-peer desktop app for a small group: text chat, voice and file sharing with no central server.
On a local network, the members find each other with no address input. When the host of a room closes, the other
members elect a new host with no user action.

> **Test copy only.** ASSCRACK is in early development. Use it with friends who want to help test it. Do not use it
> for private or important conversations. The chat history and the voice are not end-to-end encrypted.

## Status

| Item | State (2026-11-19) |
|---|---|
| Latest build | **0.6.0**, a portable Windows `.exe`. There is no public download yet. |
| `main` | 0.6.0 plus fixes for faults F1 to F6, the stale "No peers" status line, room window milestone 1 and Quote and Find (milestone 2). Also manual status (milestone 3). Not released. |
| Open field checks | The packaged Windows check of Quote and Find on a LAN, with a 0.6.0 client and a host change. Manual status on a LAN and in an internet room, with a 0.6.0 client. The internet test card 7. |
| Current phase | Phase 8 (internet rooms) and Phase 7 (desktop experience), toward release 1.0. Steps 1 and 2 of the 1.0 plan are on `main`. Step 4 started: milestone 6 part 1 (saved rooms with an encrypted local history) is on branch `opus/saved-rooms` with 127.0.0.1 results only. The step 3 field tests wait for the operator. |
| Plan | [`docs/WORK_PLAN_1.0.md`](docs/WORK_PLAN_1.0.md) gives the release order, the scope and the exit checks of 1.0. |

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
| Host election and failover | The members elect one host with terms and heartbeats. When the host closes, a new host takes the role. | LAN (0.2.0). Recovery time on the internet: not measured. |
| Chat history | The host sends up to 200 recent lines to each new or restarted member. | LAN (0.3.1) |
| Voice | Opus frames on a libp2p stream. The host forwards the frames. Two members with a direct connection send frames directly (0.6.0). | Voice through the host: LAN, internet (0.5.0). Direct voice: 127.0.0.1 |
| File sharing | Offer a file to the room. Each member can accept or refuse it. The receiver checks the SHA-256 and keeps no partial file. | LAN (0.3.1), internet (0.5.0) |
| Cancel for one receiver | The sender can stop the transfer to one receiver. The other receivers continue. | 127.0.0.1 |
| Internet rooms | Make a room with a room key and share an invite code (`asscrack1:…`). Other people join with the code. | Internet (0.5.0, forwarded port) |
| Rejoin with the invite code | The host leaves and comes back with the same code. The members find the host again. | Internet (0.5.2) |
| UPnP host | With an empty Public address field, the app asks the router for a port. | Port map on a real router: internet (0.6.0). A join through that code: not tested. |
| Full nodes and relays | A member with a reachable port is a full node. It relays chat, history, files and voice for members that cannot connect directly. The relays spread across the full nodes. | 127.0.0.1 |
| Network map | A panel shows the members, the host, the direct and relay links, the speakers and the file transfers. | 127.0.0.1 |
| Room window (not released) | Panels with saved sizes, a View menu, context menus, the reading position and an unread count. | 127.0.0.1 (same PC) |
| Quote and Find (not released) | Quote a line in a reply. Ctrl+F finds text in the loaded lines. | 127.0.0.1 (same PC) |
| Manual status (not released) | Set Available, Away or Do not disturb, with a note of at most 80 characters. Each buddy line shows the state. An old client shows "status unknown". | 127.0.0.1 |

## Known limits

- **Windows only.** The build target is a portable Windows `.exe`. Other operating systems have no test.
- **Saved history only for saved internet rooms.** Branch `opus/saved-rooms` (not on `main`, 127.0.0.1 results only)
  saves the lines of a saved internet room in an encrypted local database. LAN rooms stay live sessions with no save.
  The packaged Windows checks of saved rooms are open.
- **Two kinds of encryption.** Noise encrypts each peer connection. Encrypted local storage (SQLCipher with a
  `safeStorage` key) protects the saved lines on the disk of this computer. It does not protect them from other apps
  of the same Windows user.
- **Internet rooms need one reachable member.** At least one member must have a forwarded TCP port or a router that
  allows UPnP. A member behind a carrier-grade NAT (CGNAT) cannot be a full node.
- **No fallback route, no connection.** Members that connect only through one relay lose the connection when that relay
  leaves. They dial the known full nodes again every 5 seconds.
- **Privacy.** Noise encrypts each peer connection, and a room key keeps other people out of an internet room. But the
  host that forwards voice can access the audio, and a relay can see connection metadata.
- **Firewall question.** Windows asks one time for each build. Allow the app on private networks.

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

To make the portable Windows build (`dist/ASSCRACK-<version>-portable.exe`), run this command on Windows:

```bash
npm run dist
```

### Run the tests

The tests start real libp2p nodes on 127.0.0.1.

```bash
npm test
```

### Terminal demo

The terminal demo sends chat lines with no window. The team uses it to test the network layer.

```bash
node src/network/transceiver.mjs --room <name> --name <name>
```

### Host an internet room

1. Select **New internet room** and type a room name.
2. If you forwarded a TCP port to this computer, type your public IP and that port in **Public address**. Else, keep
   the field empty: the app then asks the router for a port (UPnP).
3. Select **Invite**, then **Copy**. Send the code to your friends through a different app.
4. Your friends select **Join with invite code** and paste the code.

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
| 4. Voice with reconnect | Done. LAN tested (WebRTC, 0.2.0 and 0.3.1). Voice on libp2p streams internet tested (0.5.0). Next: echo and noise suppression, voice activity and push-to-talk (5C, in progress). |
| 5. Chat | Done: chat and history after a restart (LAN). Quote and Find (127.0.0.1). Manual status (127.0.0.1). Saved rooms with encrypted local history (milestone 6 part 1, branch `opus/saved-rooms`, 127.0.0.1). Next: a room topic and unread highlights. |
| 6. File sharing | Done. LAN tested (0.3.1), internet tested (0.5.0). Next: a Shared shelf for the room. |
| 7. Desktop experience | In progress. The new look and the map (0.4.0), room window milestone 1 and Quote and Find have 127.0.0.1 results only. |
| 8. Internet rooms | In progress. Invite codes and rejoin are internet tested. UPnP join, relays and failover on the internet are open. |

Release 1.0 is a portable messenger for a game night. A friend joins from a different network. The group can continue to
talk when a host closes. People reopen the same room the next day. See [`docs/WORK_PLAN_1.0.md`](docs/WORK_PLAN_1.0.md).

## Documents

- [`CHANGELOG.md`](CHANGELOG.md): each release and each unreleased change, with its results and labels.
- [`src/network/chatreadme.md`](src/network/chatreadme.md): the LAN and internet test cards.
- [`docs/WORK_PLAN_1.0.md`](docs/WORK_PLAN_1.0.md): the 1.0 release plan.

## License

MIT License. See [`LICENSE`](LICENSE).

## Acknowledgments

- The libp2p team, for the peer-to-peer network stack
- Noveblue, Parker, Sunmanga, HBO Max Verstappen
- Discord ;)
