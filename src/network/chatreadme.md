## LAN peer discovery (transceiver)

Run this on two machines on the same local network, without an address argument:

```sh
node src/network/transceiver.mjs
```

Each terminal should print `Discovered peer:` followed by the other instance's
peer ID and its addresses. Allow about 10–20 seconds for discovery. Repeated
announcements from the same peer are printed only once per process.

Discovery uses mDNS on UDP port 5353 and multicast address 224.0.0.251, with an
ASSCRACK-specific service tag. Both machines must permit local multicast;
guest Wi-Fi/client isolation, firewalls, VPNs, or container networks can block it.
This discovers peers on the LAN, not across the internet.

This step only discovers peers; it does not automatically open a chat connection.
To chat, start the second transceiver with a full address printed by the first:

```sh
node src/network/transceiver.mjs '<peer-multiaddr>'
```

Both peers send and receive over one bidirectional chat stream. Terminal lines
are sent to each active peer, with newline framing to preserve message boundaries.
Use the updated transceiver on both machines. Closing a chat removes its session;
the remaining process keeps running and can accept a new connection.

Run `npm test` for the automated two-peer regression check. It verifies two-way
messages, Unicode and empty lines, one idle stream per peer, and disconnect cleanup.

## Older one-way demo

// On one terminal, start the receiver with

node src/network/receiver.mjs

// You will see something like 
Receiver started with id: 12D3KooWP7p1YhKxxu96U9tm2kfvxe9T2gNdTzR3tNDuic8FWM5E
Listening on addresses:
/ip4/127.0.0.1/tcp/62139/p2p/12D3KooWP7p1YhKxxu96U9tm2kfvxe9T2gNdTzR3tNDuic8FWM5E

// Copy the full address that appears above.
// Open a second terminal and start the transmitter with

node src/network/transmitter.mjs (the address you copied earlier)

// You should be able to type a message into the transmitter terminaL and see it appear
// on the receiver terminal.
// Next step: two way comms
