# ASSCRACK

**Automated Server Switch in Case Relays Are Crashed or Killed**

A decentralized P2P voice and chat application with automatic failover. When your host goes down, ASSCRACK automatically switches to the next available node.

**⚠️ EARLY DEVELOPMENT - NOT READY FOR USE ⚠️**
This project is in active development. Nothing works yet. 
Don't try to use this for actual voice chat.

**Want to help build it?** Check out [CONTRIBUTING.md](CONTRIBUTING.md)
## Features

- **Decentralized P2P Architecture** - No single point of failure
- **Automatic Failover** - Primary host crashes? Next node takes over instantly
- **Zero Configuration** - No IP addresses, no port forwarding wizards
- **Built-in Voice** - Powered by Mumble (Opus codec, low latency)
- **Text Chat** - Full-featured P2P messaging
- **File Sharing** - P2P file transfers, no size limits
- **Self-Healing Network** - Mesh stays connected even when nodes drop

## Status

**Early Development** - Not ready for use.

Current Phase: Design phase

## Architecture

**Key Technologies:**
- libp2p - P2P mesh networking
- Mumble (Murmur) - Voice server
- Undecided (CRDT?) - State synchronization
- Undecided - Desktop application
- SQLite - Local storage

## Roadmap

- [ ] Phase 1: P2P mesh network with peer discovery
- [ ] Phase 2: Consensus & role management
- [ ] Phase 3: Mumble server integration
- [ ] Phase 4: Voice client with auto-reconnect
- [ ] Phase 5: P2P chat system
- [ ] Phase 6: File sharing
- [ ] Phase 7: UI/UX polish

## License

MIT License.

## Acknowledgments

- Mumble team for the excellent voice codec
- libp2p team for P2P networking
- Noveblue, Parker, Sunmanga, HBO Max Verstappen
- Discord ;)
