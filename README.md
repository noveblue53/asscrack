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
- **Built-in Voice** - WebRTC (Opus codec), with the host as the relay.
- **Text Chat** - Full-featured P2P messaging
- **File Sharing** - P2P file transfers, no size limits
- **Self-Healing Network** - Mesh stays connected even when nodes drop

## Status

**Early Development** - Test copy on one LAN. Not ready for use.

Current Phase: Phase 7 (UI/UX polish) is next. Version 0.3.0 has peer discovery, the host election and failover,
voice, chat and file sharing. The fix for the chat history after a restart is in `main`, with no LAN test yet. Each result in
[CHANGELOG.md](CHANGELOG.md) has a label: LAN (real computers) or 127.0.0.1 (one PC only).

## Architecture

**Key Technologies:**
- libp2p - P2P mesh networking
- WebRTC - Voice, with the host as the relay
- Host election with terms and heartbeats - Role management and failover
- Electron - Desktop application (one portable Windows .exe)
- SQLite - Local storage (not used yet: the chat history is in memory)

## Roadmap

- [x] Phase 1: P2P mesh network with peer discovery (LAN tested)
- [x] Phase 2: Consensus & role management (host election, LAN tested on 2 computers)
- [ ] Phase 3: Mumble server integration (deferred: voice uses WebRTC)
- [x] Phase 4: Voice client with auto-reconnect (WebRTC, LAN tested on 2 computers)
- [x] Phase 5: P2P chat system (LAN tested; the fix for the history after a restart has no LAN test yet)
- [x] Phase 6: File sharing (0.3.0, tested on one PC only, LAN test next)
- [ ] Phase 7: UI/UX polish

## License

MIT License.

## Acknowledgments

- libp2p team for P2P networking
- Noveblue, Parker, Sunmanga, HBO Max Verstappen
- Discord ;)
