## LAN test card 5 (0.4.0): the new look, the network map and cancel for one receiver on 2 or 3 computers

This test checks the 0.4.0 changes on a real local network. The window has a new look. A Network map panel shows the room. It shows who has a chat session with whom, which node is the voice relay, and who speaks. It also shows the file transfers of this computer. The sender can cancel the transfer to one receiver only. Use 3 computers (A, B and C) if possible. With 2 computers, do the conditions with "2 or 3" in the Computers column.

- **dist/ASSCRACK-0.4.0-portable.exe** (SHA-256 in `CHANGELOG.md`, last LAN test: `dbea27ef`, version 0.3.1): a new look and the Network map. Each sender row has a Cancel button. The log lines of the file transfer have more fields.
- **Not changed:** discovery, the host election, the failover, voice, mute, the names, the chat history and the file transfer itself.
- **Mixed versions:** a 0.3.1 app in the same room works, but it sends no map data. Do not use a 0.3.1 app in this test.
- **Not known:** the map on a LAN, and the speed of a file transfer on a LAN.

### Before the test

1. Copy `dist/ASSCRACK-0.4.0-portable.exe` to each computer. Do not use an older .exe.
2. Connect each computer to the same network. Make sure that each computer can use multicast. Disconnect a VPN, for example TunnelBear.
3. **Windows Firewall can ask again for this version.** When the .exe starts the first time, allow it on private networks.
4. **The .exe has no code signature.** Windows SmartScreen can show "Windows protected your PC". The user of that computer decides if the .exe can run.
5. On A, prepare a large file (1 GB or more). Use headphones on each computer.
6. Start the .exe from a terminal with the argument `--dev` to see the developer console. Example: `.\ASSCRACK-0.4.0-portable.exe --dev`.

### The test

1. On each computer, start the .exe. Expect: a blue sky with bubbles and a glass card with the fields Username and Room. Type a name and the same room name, for example `room5`. Then select Log In.
2. Look at the Buddies list on each computer. Expect: the names of all users. One user has the gold mark HOST. Write down the host.
3. On each computer, select **Network map** (top right). Expect: one ball for each user, with the name. Your own ball has "(you)". A blue line connects each pair of balls. The ball of the host has the gold badge RELAY.
4. On each computer, send one chat line. Expect: your own lines in green on the right, the lines of the others in white on the left.
5. On each computer, select **Join voice**. Expect in each map: a green line from each other user in voice to the RELAY ball. Speak in turn. Expect: each user hears each other user. In the maps of the other computers, a green ring pulses around the ball of the user who speaks.
6. On A, select **Choose File**, select the large file, then select **Send file**. On B and C, select **Accept**. Expect in the map of A: an orange arrow from A to B and from A to C. Expect in the map of B: an orange arrow from A to B only.
7. While B and C receive the file, on A select **Cancel** in the row of B (not in the row "Offered ... to 2 users"). Expect on B: "Cancelled". Expect on A: "Cancelled" in the row of B. Expect on C: the transfer continues to "Saved as <file name>". With 2 computers, cancel the row of B and look only at A and B.
8. On A, send the large file again. On B, select Accept. While the progress bar moves, select **Cancel** on B. Expect on A: "Cancelled" in the row of B, not "Failed".
9. Close the app on a computer that is not the host. Expect on the other computers within 20 seconds: its ball and its lines go away from the map. Its name goes away from the Buddies list.
10. On each computer, keep the logs. Close the app first. In PowerShell, run `explorer "$env:APPDATA\asscrack\logs"`. Copy each `asscrack-*.log` file into a folder with the name of the computer. Do not edit the files.

### Done when

Write PASS or FAIL for each condition:

| # | Computers | Condition | Result |
|---|---|---|---|
| 1 | 2 or 3 | The login screen and the chat screen show the new look. All buttons are visible at the start size of the window. | |
| 2 | 2 or 3 | The map shows one ball for each user and a blue line for each pair of users within 20 seconds of the last Log In. | |
| 3 | 2 or 3 | The RELAY badge in the map is on the same user as the HOST mark in the Buddies list, on each computer. | |
| 4 | 2 or 3 | After Join voice, each map shows a green line from each other user in voice to the RELAY ball. | |
| 5 | 2 or 3 | A green ring pulses around the ball of a user who speaks. | |
| 6 | 2 or 3 | During the transfer, the map of the sender shows an orange arrow to each receiver. | |
| 7 | 3 | After Cancel in the row of B on A, B shows "Cancelled", and C shows "Saved as". | |
| 8 | 2 or 3 | After Cancel on B (step 8), A shows "Cancelled" for B, not "Failed". | |
| 9 | 2 or 3 | After a non-host user closes the app, the other maps remove that ball within 20 seconds. | |
| 10 | 2 or 3 | The developer consoles show no red error line. | |
| 11 | 2 or 3 | Each computer has at least one `asscrack-*.log` file from this test. | |

### If a condition fails

Keep these items for the analysis:
- the number of the condition that failed, and the computer
- what you saw, and a screenshot of the window if possible
- the log files (`asscrack-*.log`) from each computer. A file line in the log now has the side of this computer (`direction send` or `direction receive`) and the side that cancelled (`by self` or `by peer`).

---

## LAN test card 4 (0.3.1): history after a restart, names, file sharing and log files on 2 or 3 computers

This test does 2 things on a real local network. It does all of test card 3 (names and file sharing), because 0.3.0 had no LAN test. It also does test card 2, conditions 6 to 8, again: the chat history and the voice after a restart. These conditions failed or were not tested on 0.2.0. Use 3 computers (A, B and C) if possible. With 2 computers, do the conditions with "2 or 3" in the Computers column.

- **dist/ASSCRACK-0.3.1-portable.exe** (`dbea27ef`, last LAN test: `d02f70a7`, version 0.2.0): after a restart and Log In, the window shows the chat lines from before the restart. The app writes one log file at each start.
- **Not changed:** discovery, the host election, the failover, voice, mute, the names and the file transfer.
- **Not known:** the speed of a file transfer on a LAN. On one PC (127.0.0.1), a 200 MB file went to 2 receivers in 4.1 to 4.7 s (0.3.0 and 0.3.1).

### Before the test

1. Copy `dist/ASSCRACK-0.3.1-portable.exe` to each computer. The .exe does not need Node.js. Do not use an older .exe: 0.3.0 and older do not show the history after a restart, and they write no log file.
2. Connect each computer to the same network. Make sure that each computer can use multicast. Guest Wi-Fi, client isolation and a VPN can block mDNS. Disconnect a VPN, for example TunnelBear.
3. **Windows Firewall can ask again for this version.** When the .exe starts the first time, allow it on private networks. The chat, the voice and the file transfer use TCP and UDP between the computers.
4. **The .exe has no code signature.** Windows SmartScreen can show "Windows protected your PC". The user of that computer decides if the .exe can run.
5. Windows can block the microphone for desktop apps. Open Settings > Privacy > Microphone. Make sure that "Allow desktop apps to access your microphone" is on. The user of each computer decides this setting.
6. On A, prepare 2 files: a large file (1 GB or more, for example a video) and a small text file. Write down the size of the large file.
7. Use headphones on each computer.
8. Start the .exe from a terminal with the argument `--dev` to see the developer console. Example: `.\ASSCRACK-0.3.1-portable.exe --dev`.

### The test

1. On each computer, start the .exe. Type a name and the same room name, for example `room4`. Then select Log In.
2. Do not send a chat message. Look at the peer list on each computer. Expect: the names of the other users, not text that starts with `12D3KooW`. Write down which user the peer list marks as the host.
3. **Do not skip this step: step 13 needs these lines.** On each computer, send one chat line, for example the name of the computer. Then, on A, type `before voice` and select Send.
4. On each computer, select Join voice. Speak in turn. Each user must hear each other user. Stay in voice until step 12.
5. On A, select the file control (Chromium shows "Choose File"). Select the large file. Then select **Send file**. Expect on A: "Offered <file name> to <n> users". Expect on B and C: a line with the file name, the size, "from <name of A>", "Offered", and the buttons Accept and Refuse.
6. On B, select **Accept**. On C, select **Refuse**. Expect on C: "Refused". Expect on A: "Refused" in the line for C.
7. While the progress bar on B moves, speak in turn. Each user must continue to hear each other user.
8. Wait until B shows "Saved as <file name>". Record the time from Accept to "Saved as". Expect on A: "Sent" in the line for B.
9. On B, open the Downloads folder. The file must be there with the same size as on A. Optional: on A and on B, run `Get-FileHash "<path of the file>"` in PowerShell. The 2 hash values must be the same.
10. On A, send the large file again. On B, select Accept. While the progress bar moves, select **Cancel** on B. Expect on B: "Cancelled". Expect on A: "Cancelled" in the line for B. On B, look in the Downloads folder: no new file, and no file with a name that starts with `.asscrack-`. If the transfer ends before you can select Cancel, use a larger file and do this step again.
11. On A, send the small text file. On B, select Accept. Then send the same small file again, and accept it again on B. Expect on B: "Saved as <name>" the first time, and "Saved as <name> (1).<extension>" the second time. The first file has no change.
12. Close the app on the computer of the host (the host from step 2, or the host that the peer list shows now). Record the time. On the other computers, wait until the peer list shows a new host.
13. Start the .exe on the closed computer again. Log in with the same name and the same room. Do not send a chat message. Look at the chat: the lines from step 3, with `before voice`, must be there.
14. On the restarted computer, select Join voice. Speak in turn. Each user must hear each other user again.
15. On each computer, keep the logs. Close the app first. In PowerShell, run `explorer "$env:APPDATA\asscrack\logs"`. Copy each `asscrack-*.log` file into a folder with the name of the computer. The restarted computer has 2 log files, one for each start. Do not edit the files.

### Done when

Write PASS or FAIL for each condition:

| # | Computers | Condition | Result |
|---|---|---|---|
| 1 | 2 or 3 | Before any chat message, each peer list shows the names of the other users within 20 seconds. | |
| 2 | 2 or 3 | After Send file on A, the offer shows on each other computer within 5 seconds. | |
| 3 | 2 or 3 | After Accept on B, B shows "Saved as", and the file in the Downloads folder of B has the same size as on A. | |
| 4 | 3 | After Refuse on C, A shows "Refused" for C, and the Downloads folder of C has no new file. | |
| 5 | 2 or 3 | During the transfer, the users hear each other in voice. | |
| 6 | 2 or 3 | After Cancel on B, A and B show "Cancelled", and the Downloads folder of B has no new file. | |
| 7 | 2 or 3 | The second copy of the small file gets a name with " (1)". The first copy has no change. | |
| 8 | 2 or 3 | After the restart and Log In, the restarted computer shows the chat lines from step 3, with `before voice`. | |
| 9 | 2 or 3 | After the restart and Join voice, each user hears each other user again within 15 seconds. | |
| 10 | 2 or 3 | The developer consoles show no red error line. | |
| 11 | 2 or 3 | Each computer has at least one `asscrack-*.log` file from this test. | |

Also write down the size of the large file and the time of step 8. These give the speed on the LAN.

### If a condition fails

Keep these items for the analysis:
- the number of the condition that failed, and the computer
- what you saw and heard, and the times that you recorded
- the log files (`asscrack-*.log`) from each computer
- the text in the line of the transfer, for example "Failed: hash mismatch"

---

## LAN test card 3 (0.3.0): peer names and file sharing on 2 or 3 computers

This test shows if a file goes from one computer to the others on a real local network. It also shows the names in the peer list before the first chat message. Use 3 computers (A, B and C) if possible. With 2 computers, do the conditions with "2 or 3" in the Computers column.

- **dist/ASSCRACK-0.3.0-portable.exe** (`6251b15e`, last test: `d02f70a7`, version 0.2.0): the peer list shows the names at once. The window has a file control, a Send file button and a list of transfers.
- **Not changed:** voice, mute, the host election, the failover and the chat history. Test card 2 covers them.
- **Not known:** the speed on a LAN. On one PC (127.0.0.1), a 200 MB file went to 2 receivers in 4.1 to 4.6 s.

### Before the test

1. Copy `dist/ASSCRACK-0.3.0-portable.exe` to each computer. The .exe does not need Node.js. Do not use an older .exe: it has no file sharing.
2. Connect each computer to the same network. Make sure that each computer can use multicast. Guest Wi-Fi, client isolation and a VPN can block mDNS. Disconnect a VPN, for example TunnelBear.
3. **Windows Firewall asks again for this version.** Version 0.3.0 unpacks to a new folder, so the firewall rule of 0.2.0 does not apply. When the .exe starts the first time, allow it on private networks. The file transfer uses TCP between the computers.
4. **The .exe has no code signature.** Windows SmartScreen can show "Windows protected your PC". The user of that computer decides if the .exe can run.
5. On A, prepare 2 files: a large file (1 GB or more, for example a video) and a small text file. Write down the size of the large file. On a fast LAN, a smaller file can arrive before you can select Cancel.
6. On each computer, find the Downloads folder (File Explorer, "Downloads"). The app writes the received files there.
7. Use headphones on each computer, for steps 3 and 6 of the test.
8. Start the .exe from a terminal with the argument `--dev` to see the developer console. Example: `.\ASSCRACK-0.3.0-portable.exe --dev`.

### The test

1. On each computer, start the .exe. Type a name and the same room name, for example `files1`. Then select Log In.
2. Do not send a chat message. Look at the peer list on each computer. Expect: the names of the other users, not text that starts with `12D3KooW`.
3. On each computer, select Join voice. Speak in turn. Each user must hear each other user. Stay in voice until step 7.
4. On A, select the file control (Chromium shows "Choose File"). Select the large file. Then select **Send file**. Expect on A: "Offered <file name> to <n> users". Expect on B and C: a line with the file name, the size, "from <name of A>", "Offered", and the buttons Accept and Refuse.
5. On B, select **Accept**. On C, select **Refuse**. Expect on C: "Refused". Expect on A: "Refused" in the line for C.
6. While the progress bar on B moves, speak in turn. Each user must continue to hear each other user.
7. Wait until B shows "Saved as <file name>". Record the time from Accept to "Saved as". Expect on A: "Sent" in the line for B.
8. On B, open the Downloads folder. The file must be there with the same size as on A. Optional: on A and on B, run `Get-FileHash "<path of the file>"` in PowerShell. The 2 hash values must be the same.
9. On A, send the large file again. On B, select Accept. While the progress bar moves, select **Cancel** on B. Expect on B: "Cancelled". Expect on A: "Cancelled" in the line for B. On B, look in the Downloads folder: no new file, and no file with a name that starts with `.asscrack-`. If the transfer ends before you can select Cancel, use a larger file and do this step again.
10. On A, send the small text file. On B, select Accept. Then send the same small file again, and accept it again on B. Expect on B: "Saved as <name>" the first time, and "Saved as <name> (1).<extension>" the second time. The first file has no change.
11. On each computer, keep the logs. Close the app first. A build after 0.3.0 writes one log file at each start. In PowerShell, run `explorer "$env:APPDATA\asscrack\logs"`. Copy each `asscrack-*.log` file into a folder with the name of the computer. Do not edit the files. The 0.2.0 and 0.3.0 builds write no log file, and a terminal pipe (`Tee-Object`) does not get their output. With these builds, write down each red line of the developer console, with the time.

### Done when

Write PASS or FAIL for each condition:

| # | Computers | Condition | Result |
|---|---|---|---|
| 1 | 2 or 3 | Before any chat message, each peer list shows the names of the other users within 20 seconds. | |
| 2 | 2 or 3 | After Send file on A, the offer shows on each other computer within 5 seconds. | |
| 3 | 2 or 3 | After Accept on B, B shows "Saved as", and the file in the Downloads folder of B has the same size as on A. | |
| 4 | 3 | After Refuse on C, A shows "Refused" for C, and the Downloads folder of C has no new file. | |
| 5 | 2 or 3 | During the transfer, the users hear each other in voice. | |
| 6 | 2 or 3 | After Cancel on B, A and B show "Cancelled", and the Downloads folder of B has no new file. | |
| 7 | 2 or 3 | The second copy of the small file gets a name with " (1)". The first copy has no change. | |
| 8 | 2 or 3 | The developer consoles show no red error line. | |

Also write down the size of the large file and the time of step 6. These give the speed on the LAN.

### If a condition fails

Keep these items for the analysis:
- the number of the condition that failed, and the computer
- what you saw and heard, and the times that you recorded
- the log files (`asscrack-*.log`) from each computer, or your notes of the red console lines
- the text in the line of the transfer, for example "Failed: hash mismatch"

---

## LAN test card 2: voice and host failover on 2 or 3 computers

This test shows if the voice and the automatic host failover work on a real local network. Use 3 computers (A, B and C) if possible. With 2 computers, do the conditions with "2" or "2 or 3" in the Computers column.

### Before the test

1. Copy `dist/ASSCRACK-0.2.0-portable.exe` to each computer. The .exe does not need Node.js. Do not use the 0.1.0 .exe: it has no voice.
2. Connect each computer to the same network. Make sure that each computer can use multicast. Guest Wi-Fi, client isolation and a VPN can block mDNS. Disconnect a VPN, for example TunnelBear.
3. Use headphones on each computer. Without headphones, the speaker of one computer can go into the microphone of another computer in the same room.
4. Windows Firewall can ask for access when the .exe starts the first time. Allow it on private networks. Voice uses UDP between the computers.
5. Windows can block the microphone for desktop apps. Open Settings > Privacy > Microphone. Make sure that "Allow desktop apps to access your microphone" is on. The user of each computer decides this setting.
6. The .exe has no code signature. Windows SmartScreen can show "Windows protected your PC". The user of that computer decides if the .exe can run.
7. Start the .exe from a terminal with the argument `--dev` to see the developer console. Example: `.\ASSCRACK-0.2.0-portable.exe --dev`.

### The test

1. On each computer, start the .exe. Type a name and the same room name, for example `voice1`. Then select Log In.
2. Wait until each peer list shows all other users. On each computer, send one chat line, for example the name of the computer. The peer list shows a name after the first message of that user.
3. Write down which user the peer list marks as the host. All computers must show the same host. **Do not skip this step: step 8 needs the line.** On A, type `before voice` in the chat and select Send.
4. On each computer, select Join voice. Speak in turn. Each user must hear each other user.
5. On one computer that is not the host, select Mute. Speak on that computer. The other users must not hear it. Select Unmute.
6. Close the app on the computer of the host. Record the time.
7. On the other computers, look at the peer list. Wait for a new host. Speak in turn. Record the time when the users hear each other again. Do not select a button.
8. Start the app on the closed computer again. Log in to the same room. Look at the chat: `before voice` must be there. Select Join voice. Speak in turn.
9. On each computer, keep the logs. Close the app first. A build after 0.3.0 writes one log file at each start. In PowerShell, run `explorer "$env:APPDATA\asscrack\logs"`. Copy each `asscrack-*.log` file into a folder with the name of the computer. Do not edit the files. The 0.2.0 and 0.3.0 builds write no log file, and a terminal pipe (`Tee-Object`) does not get their output. With these builds, write down each red line of the developer console, with the time.

**Known fault in 0.2.0 and 0.3.0:** condition 6 fails. The window of these builds does not show the chat history (`handoffs/test2-20261117`). Do conditions 6 to 8 again with a build after 0.3.0.

### Done when

Write PASS or FAIL for each condition:

| # | Computers | Condition | Result |
|---|---|---|---|
| 1 | 2 or 3 | All computers show the other users in the peer list within 20 seconds. | |
| 2 | 2 or 3 | All computers mark the same user as the host. | |
| 3 | 2 or 3 | After Join voice, each user hears each other user. | |
| 4 | 2 or 3 | When a user selects Mute, the other users do not hear that user. The peer list shows that user as "in voice", not "speaking". | |
| 5 | 3 | After the app of the host closes, the 2 other users hear each other again within 15 seconds, with no button. | |
| 5 | 2 | After the app of the host closes, the other computer shows itself as the host within 15 seconds. | |
| 6 | 2 or 3 | After a restart and Log In, the closed computer shows the message `before voice` in the chat. | |
| 7 | 2 or 3 | After the restart and Join voice, each user hears each other user again within 15 seconds. | |
| 8 | 2 or 3 | The developer consoles show no red error line. | |

### If a condition fails

Keep these items for the analysis:
- the number of the condition that failed, and the computer
- what you saw and heard, and the times that you recorded
- the log files (`asscrack-*.log`) from each computer, or your notes of the red console lines

---

## LAN test card: the desktop app on two computers

This test shows if the test copy works on a real local network. Do it on two computers, A and B, on the same network.

### Before the test

1. Get the app on each computer. Use one of these two methods:
   - **Portable .exe (no install):** run `npm run dist` on one computer. Copy `dist/ASSCRACK-0.1.0-portable.exe` to the other computer. The .exe does not need Node.js.
   - **Source:** get the branch `opus/lan-chat-test-copy` and run `npm install`.
2. Make sure that each computer can use multicast on the network. Guest Wi-Fi, client isolation, a VPN or a container network can block mDNS.
3. On Windows, Windows Firewall can ask for access when the app starts the first time. Allow the app on private networks.
4. The .exe has no code signature. Windows SmartScreen can show "Windows protected your PC". The user of that computer decides if the .exe can run.

### The test

1. On computer A, start the app: run `npm start`, or start the .exe. To see the developer console, run `npm run dev`, or start the .exe from a terminal with the argument `--dev`.
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

With the portable .exe, condition 1 means: the user starts the .exe. Do condition 6 on a computer with the source.

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
