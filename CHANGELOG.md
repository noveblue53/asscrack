# Changelog

This file gives the progress of ASSCRACK, one entry for each feature or release. The newest entry is at the top.

Each result has one of these labels:
- **LAN**: a test on 2 or more computers on one real local network.
- **127.0.0.1**: a test on one PC only. It does not prove that the feature works on a LAN.
- **internet**: a test on 2 computers on different networks, for example a home router and a phone hotspot.

## 0.6.0: a host with no port forward, connection log lines and load spreading

- **Build:** `dist/ASSCRACK-0.6.0-portable.exe`, 97,233,105 bytes, SHA-256
  `2d6185dff99c6bc8a4a204d8524d4b97a412a88744976c4d276c47dcd5070216`.
- **UPnP host:** when the Public address field is empty in an internet room, the app asks the router for a TCP port
  (UPnP). The invite code then has the public address. The full-node state still comes only from the dial-back. A
  private or CGNAT address gives no port and one `upnp none` log line.
- **Connection log:** each session writes one line with the peer, the type (direct or relay), the direction, the relay
  and the address. Each failed dial writes one line with the reason.
- **One unpack folder:** each build unpacks to `%TEMP%\ASSCRACK`. Thus Windows asks the firewall question one time.
  Known fault: a second copy of the app on one computer deletes files of the first copy.
- **Relay spread:** a member selects the full node with the fewest relayed sessions for each relay dial. When a full
  node stops, the session opens again through another full node.
- **Direct voice:** two voice members with a direct connection send the frames directly. The host forwards a frame only
  to the members that do not get it directly. A 0.5.2 app still gets voice through the host.
- **Results (internet):** R0, the rejoin of 0.5.2 with the old invite code and an empty address field: pass.
- **Results (127.0.0.1):** UPnP with a fake router 10 of 10. The relay spread test 40 of 40 under CPU load. The direct
  voice test: the host forwards 0 frames between two direct members. `npm test` passes 89 of 89. The terminal demo and
  one app start pass.
- **Not known:** UPnP on a real router, and all of 0.6.0 on a LAN or on the internet. Test card 7 gives the test.

## 0.5.2: the host rejoins its room with only the invite code

- **Build:** `dist/ASSCRACK-0.5.2-portable.exe`, 96,502,816 bytes, SHA-256
  `961b8a47690fb4adf0dc851dd136cf0d541f3005b4c4d0f77d81c623594e6307`.
- **Saved public address:** the app saves the public address of each room that it hosts. When the host rejoins the
  room with the invite code and an empty Public address field, the app uses the saved address again. Then the app
  listens on the forwarded port, and the other members find the host again.
- **Results (127.0.0.1):** a two-window check: B has no listen port and no LAN discovery, A leaves and rejoins with the
  code and an empty field. B and A are in one room again. The same check on the 0.5.1 build fails. `npm test` passes
  70 of 70. The packaged build passes the same check.
- **Not known:** the rejoin on the internet.

## 0.5.1: rejoin an internet room, and the room name on the joiner

- **Build:** `dist/ASSCRACK-0.5.1-portable.exe`, 96,497,772 bytes, SHA-256 `8f1af4f9d1bfd3c450b25cc94972bf918935dec654dd3057e45d6ce99496a41d`.
- **Internet result of 0.5.0 (operator, 2026-11-18):** A on a PC with a forwarded TCP port made an internet room. A
  laptop on a phone hotspot joined with the invite code. Chat, voice and file sharing worked. This is the first
  internet result. Two faults were found.
- **Room name:** a user who joined with an invite code saw no room name. The window now shows the room name from the
  code.
- **Rejoin:** when the full node left and started again, the other member stayed alone. A member with no full node now
  dials the known full nodes again each 5 s. A full node that started again has a new peer ID. The member then dials
  the same address with no peer ID, so an old invite code is still good.
- **Public address:** the label now says that the host of the room must fill it in. With no public address, the
  window shows no invite code.
- **Results (127.0.0.1):** `npm test` passes 70 of 70. A new test stops the full node and starts a new one at the
  same port. The member has a session with it after less than 1 s. The start, join and room name window checks pass.
  The terminal demo works.
- **Not known:** the rejoin on the internet.

## 0.5.0: internet rooms with invite codes, full nodes and voice over libp2p

- **Build:** `dist/ASSCRACK-0.5.0-portable.exe`, 96,496,437 bytes, SHA-256
  `132480d93ebcecc0a0b38f44afdb6be26191b332afb938f0bf3885d21dff4c50`. Test card 6 is at the top of
  `src/network/chatreadme.md`. There is no internet result and no LAN result yet.

- **Internet room:** a user makes a room with a room key. The **Invite** button gives a code that starts with
  `asscrack1:`. The code has the room name, the room key and the addresses of the known full nodes. Other users join
  with the code. There is no fixed server.
- **Full node:** a member with a forwarded TCP port is a full node. A peer dials back to it to make sure that the port
  is open. A full node keeps relay slots for the room members. When two members cannot connect directly, their chat,
  history and files go through the full node (a relay link). A private or loopback address does not make a full node,
  so a LAN room has no full node.
- **Room key:** each new session sends a proof of the room key. A peer with a wrong key gets no session, no relay slot
  and no voice stream.
- **Host election:** a full node gets the host role first, then the lower peer ID. With no full node, the rule is the
  same as before.
- **Voice over libp2p:** voice is now Opus frames (48 kHz, 20 ms, 32 kbps) on a libp2p stream to the host. The host
  sends each frame to the other members. This replaces WebRTC, so voice also works through a relay link. The host drops
  a frame that has the name of a different sender.
- **Network map:** a relay link is a dashed line (`data-kind="relay"`). A direct link is a solid line
  (`data-kind="mesh"`). A full node has a FULL badge.
- **Mixed versions:** a 0.4.0 app cannot join an internet room. In a LAN room, a 0.4.0 app has no voice with a 0.5.0
  app.
- **Results of the 0.5.0 tree (127.0.0.1):** `npm test` passes 67 of 67. New tests send chat, history, voice frames
  and a 3 MiB file through a relay on one PC. Other new tests check the room key, the invite code and the relay access
  rule. The file rate through the relay was 5.2 to 5.7 MiB/s. A voice frame from A through the host to B took a
  median time of 1.0 to 1.3 ms (127.0.0.1). A window check with a fake microphone sent and decoded voice frames in 2 app windows. Seven
  window checks passed. They check the start, the map, the history (a and b), files with 3 windows, Cancel for one
  receiver and the relay map. The terminal demo works.
- **Known (127.0.0.1):** after Join voice, the stream to the host opens after about 2.5 s. The frames of that time
  are lost.
- **Not known:** all of this on the internet and on a LAN. Test card 6 gives this.

## 0.4.0: a new look, the network map and cancel for one receiver

- **Build:** `dist/ASSCRACK-0.4.0-portable.exe`, 96,412,548 bytes, SHA-256 `35d29b03…`. Test card 5 is at the top of
  `src/network/chatreadme.md`. There is no LAN result yet.

- **New look:** a 2000s style (Frutiger Aero, Windows XP, LimeWire and AOL) with a modern feel. The login screen is a
  glass card on a sky. The chat screen has a buddy list with voice lights, chat bubbles, and a transfer table with
  progress bars. Short animations (0.15 to 0.3 s) show changes. With "reduce motion" on, there is no animation.
- **Network map:** a panel shows each room member and the chat sessions between them. The host has a RELAY badge,
  because the host relays the voice. Green lines show the voice connections to the host. A green ring shows who
  speaks. Orange arrows show the file transfers of this computer only.
- **Map data:** each node sends the list of its sessions to its peers. A 0.3.1 node ignores the list.
- **Cancel for one receiver:** each sender row of one receiver has a Cancel button. The other receivers continue.
- **Fault fixed (127.0.0.1):** when a receiver cancelled, the sender could show "Failed" in place of "Cancelled".
  The window check failed 1 of 7 runs because of this. A new test reproduces the fault on the old code.
- **Fault fixed (127.0.0.1):** when the sender cancelled, the receiver could show "Failed" in place of "Cancelled".
  This is the same race on the receiver side. A new window check found it (1 of 1 runs before the fix).
- **Fault fixed (127.0.0.1):** the warning "Dial to discovered peer ... failed" in the test runs. The node dialed a
  peer again while the first chat stream was still in negotiation. It now waits for the negotiation.
- **Log:** each file line has the side of this computer and the side whose action caused the event. The log also has a line for each
  file action of the user. This shows which side cancelled a transfer, which test card 4 could not show.
- **Results of the 0.4.0 build (127.0.0.1):** `npm test` passes 44 of 44. The history test gave 0 dial warnings in 4
  of 4 runs. One app start has no error line. A window check of Cancel for one receiver passes: the other receiver gets the
  full file. With 2 app windows, the restarted window showed all earlier lines in 3
  of 3 runs, one with the .exe. With 3 app windows, the file check passed, also with the .exe as the sender. A 200 MB
  file went to 2 windows in 5.7 s, and the voice continued. The map check passed all 40 lines. Each map had 3 nodes,
  one host, 3 chat lines, 2 voice lines and one transfer arrow. The terminal demo works.
- **Not known:** the map, the new Cancel and the new look on a LAN. Test card 5 gives this.

## 0.3.1: history in the window after a restart, and a log file

- **Build:** `dist/ASSCRACK-0.3.1-portable.exe`, 96,396,035 bytes, SHA-256 `dbea27ef…`. Test card 4 is at the top of
  `src/network/chatreadme.md`.

- **Fault (LAN, test card 2, 2 computers):** after a restart, the app did not show the chat lines from before the
  restart.
- **Cause (127.0.0.1):** the network layer gets the history. In 12 of 12 runs, the restarted node got all earlier
  lines 1 to 3 ms after its session opened. But the main process of the app did not send the history to the window.
- **Fix:** the main process now sends the history to the window. The window puts the lines in time sequence.
- **Log file:** the app writes one log file at each start, in `%APPDATA%\asscrack\logs`. Each history send and
  receive gives a log line with the message IDs and the count. The log does not contain the chat text.
- **Results (127.0.0.1):** with 2 app windows, the restarted window showed 0 earlier lines in 4 of 4 runs before the
  fix. After the fix, it showed all 3 earlier lines in 4 of 4 runs. `npm test` passes 36 of 36.
- **Results of the 0.3.1 build (127.0.0.1):** `npm test` passes 36 of 36, and one app start has no error line.
  With the .exe as the restarted app, the window showed all earlier lines in 2 of 2 runs. With 3 app windows and the
  .exe as the sender, a 200 MB file arrived in 2 windows in 4.7 s. The voice continued during the transfer. The
  .exe writes its log file in `%APPDATA%\asscrack\logs`.
- **Results (LAN, test card 4, 2 computers, 2026-11-17):** pass for conditions 1 to 3 and 5 to 9. Pass for the names
  before the first chat message, and for the offer, accept, cancel and the " (1)" name of the file transfer. Pass for
  the voice during the transfer. Pass for the chat history after a restart (condition 8), and for the voice after the
  restart (condition 9). The operator also closed A, then B, and logged in again each time. The chat history showed
  each time.
- **Condition 4 (refuse):** pass with a changed procedure on 2 computers. The card asks for 3 computers, with Accept
  on B and Refuse on C at the same time. The operator did Accept, then Refuse, in sequence on the same receiver.
  Refuse by a third computer during a transfer to another receiver has no LAN test.
- **Log files (LAN, 2 computers):** each computer wrote 2 log files, one for each start (condition 11). The 4 logs
  have no warning or error line, and each window console line has the level info (condition 10, from the logs). After
  each restart, the history arrived 3 to 4 ms after the session opened, and the window showed it 1 ms later.
- **Not known:** the LAN transfer speed. The log has no file size and no line for Accept.

## 0.3.0: peer names and file sharing

- Each member sends its name when a session opens. The peer list shows the names before the first chat message.
- A member selects a file and offers it to the room. Each other member can accept or refuse it.
- The file goes direct from the sender to each receiver, in chunks on a libp2p stream. It does not go through the host.
- The receiver checks the SHA-256 of the file. It writes the file into the Downloads folder with a name that does not
  overwrite a file. A failed or cancelled transfer leaves no partial file.
- **Results (127.0.0.1):** `npm test` passes 31 of 31. A 50 MB file arrives in 1.3 s, and its SHA-256 agrees with the sent file. With 3
  app windows, a 200 MB file arrives in 2 windows in 4.6 s, and the voice continues during the transfer.
- **Results (LAN):** the 0.3.0 build had no LAN test. Test card 4 tested the same names and file sharing with the
  0.3.1 build, and they passed (see the 0.3.1 entry).
- **Known limits:** the sender can cancel only the full offer, not one receiver.

## 0.2.0: voice and host failover

- The members elect one host with terms and heartbeats. When the host stops, the other members elect a new host with
  no input from a user.
- The host sends the chat history to each new member.
- Voice goes through WebRTC, with the host as the relay. The window has Join voice, Leave voice and Mute.
- **Results (LAN, test card 2, 2 computers):** pass for discovery, the same host on each computer, voice and mute. Pass for
  the new host after the old host closes. Fail for the chat history after a restart (see the entry above). Not tested:
  voice after a restart, and the developer console.
- **Results (LAN):** the 0.2.0 peer list showed a name only after that user sent a chat message. Version 0.3.0 fixes
  this.
- **Results (127.0.0.1):** after a kill of the host, the voice came back in 4.1 s.

## 0.1.0: LAN chat test copy

- Two users on one local network find each other with mDNS, with no address input.
- They send text messages in the window of an Electron desktop app.
- The app is one portable Windows .exe.
- **Results (LAN, test 1, 2 computers):** pass. The users found each other and sent messages in both directions.
