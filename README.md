# ASSCRACK

**Automated Server Switch in Case Relays Are Crashed or Killed**

A decentralized P2P voice and chat application with automatic failover. When your host goes down, ASSCRACK automatically switches to the next available node.

**⚠️ EARLY DEVELOPMENT - TEST COPY ONLY ⚠️**
This project is in active development. A test copy works on one local network (LAN).
Don't use it for real voice chat yet. See [CHANGELOG.md](CHANGELOG.md) for what works and what was tested.

**Want to help build it?** Check out [CONTRIBUTING.md](CONTRIBUTING.md)
## Features

- **Decentralized P2P Architecture** - No single point of failure
- **Automatic Failover** - Primary host crashes? Next node takes over instantly
- **Zero Configuration** - No IP addresses, no port forwarding wizards
- **Built-in Voice** - Opus frames on a libp2p stream, with the host as the relay.
- **Text Chat** - Full-featured P2P messaging
- **File Sharing** - P2P file transfers, no size limits
- **Network Map** - See who is connected, who relays the voice, who speaks and which files move
- **Internet Rooms** - Join with an invite code. Members with a forwarded port are full nodes and relay for the others
- **Self-Healing Network** - Mesh stays connected even when nodes drop

## Status

**Early Development** - Test copy on one LAN. Not ready for use.

Current Phase: Phase 8 (internet rooms). Version 0.6.0 lets a host with no port forward become a full node through
UPnP. It also adds connection log lines, spreads the relayed sessions across the full nodes, and sends voice directly
between two members with a direct connection. These passed the checks on one PC (127.0.0.1) only. Test card 7 gives
the internet test. The rejoin of 0.5.2 passed an internet test (R0). Version 0.5.0 has internet rooms with invite codes and a room key. Members
with a forwarded port are full nodes and relay the chat, history and files for the others. Voice now uses libp2p
streams in place of WebRTC. These passed the checks on one PC (127.0.0.1) and have no internet or LAN test yet. Test
card 6 gives the internet test. Version 0.4.0 has a new look and a network map of the room. These passed the checks on
one PC (127.0.0.1) and have no LAN test yet. Test card 5 gives the LAN test. Version 0.3.1 has peer
discovery, the host election and failover, voice, chat with the history after a restart, and file sharing. All of
these passed a LAN test. Each result in
[CHANGELOG.md](CHANGELOG.md) has a label: LAN (real computers on one network), internet (computers on different networks) or 127.0.0.1 (one PC
only).

## Architecture

**Key Technologies:**
- libp2p - P2P mesh networking
- Circuit relay v2 - Full nodes relay for members behind a NAT
- WebCodecs Opus on libp2p streams - Voice, with the host as the relay
- Host election with terms and heartbeats - Role management and failover
- Electron - Desktop application (one portable Windows .exe)
- SQLite - Local storage (not used yet: the chat history is in memory)

## Roadmap

- [x] Phase 1: P2P mesh network with peer discovery (LAN tested)
- [x] Phase 2: Consensus & role management (host election, LAN tested on 2 computers)
- [ ] Phase 3: Mumble server integration (deferred: voice uses WebRTC)
- [x] Phase 4: Voice client with auto-reconnect (WebRTC, LAN tested on 2 computers)
- [x] Phase 5: P2P chat system (LAN tested on 2 computers, with the history after a restart in 0.3.1)
- [x] Phase 6: File sharing (LAN tested on 2 computers with 0.3.1)
- [ ] Phase 7: UI/UX polish (0.4.0: new look and network map, 127.0.0.1 only, LAN test open)
- [ ] Phase 8: Internet rooms (0.5.0: invite codes, full nodes, relay links, voice over libp2p; 0.5.2 rejoin internet tested; 0.6.0: UPnP host, relay spread, direct voice, 127.0.0.1 only, internet test open)

## License

MIT License.

## Acknowledgments

- libp2p team for P2P networking
- Noveblue, Parker, Sunmanga, HBO Max Verstappen
- Discord ;)
