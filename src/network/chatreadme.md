## LAN test card: the desktop app on two computers

This test shows if the test copy works on a real local network. Do it on two computers, A and B, on the same network.

### Before the test

1. On each computer, get the branch `opus/lan-chat-test-copy` and run `npm install`. The branch is on GitHub only after the operator approves a push. Without a push, copy the repository folder to the second computer.
2. Make sure that each computer can use multicast on the network. Guest Wi-Fi, client isolation, a VPN or a container network can block mDNS.
3. On Windows, Windows Firewall can ask for access when Electron starts the first time. Allow Electron on private networks.

### The test

1. On computer A, run `npm start`. To see the developer console, run `npm run dev`. It is `npm start` with the developer tools open.
2. On computer B, do the same.
3. On each computer, type a name and the same room name, for example `test1`. Then select Log In.
4. Record the time. Wait for the other user in the peer list.
5. On A, send `hello from A`. On B, send `hello from B`.
6. Close the app on A. Look at the peer list on B.
7. On each computer, save the terminal output and the developer console output to a text file. Keep the original files. Do not edit them.

### Done when

Write PASS or FAIL for each condition:

| # | Condition | Result |
|---|---|---|
| 1 | A user runs `npm start` on computer A and on computer B. The 2 computers are on the same local network. | |
| 2 | Both users log in with the same room name. | |
| 3 | Each app shows the other user in its peer list within 20 seconds. | |
| 4 | A message from A appears on B, and a message from B appears on A. | |
| 5 | When user A closes the app, user A is no longer in the peer list on B. | |
| 6 | `npm test` passes. | |

### If a condition fails

Keep these items for the analysis:
- the number of the condition that failed
- what you saw
- the saved terminal and console files from both computers

---

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

**Update, 2026-11-17:** the transceiver now opens the chat connection when it discovers a peer in the same room.
The address argument is optional. Use `--room <name>` to select a room and `--name <name>` to set your name.
Messages print as `> <name>: <text>`. The paragraph below describes the older behavior.

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
