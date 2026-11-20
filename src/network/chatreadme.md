## Internet test card 8 (0.7.0): saved rooms, Quote and Find, manual status and voice settings on 2 computers

This test checks the 0.7.0 changes on two Windows computers. Each change in 0.7.0 has 127.0.0.1 results only. An internet room can now be saved on the computer, with an encrypted local history. A saved room opens again with no invite code and shows its old lines at once. Also new: the room window, Quote and Find, a manual status, and voice settings with noise suppression and push to talk.

- Computer 1 (**A**) is the host. Computer 2 (**B**) is the computer of the second person. A and B can be on different networks.
- **dist/ASSCRACK-0.7.0-portable.exe** (SHA-256 in `CHANGELOG.md`, entry 0.7.0, last test: 0.6.0): saved rooms, Quote and Find, manual status and voice settings. New controls: **Save room on this device**, **Keep local history**, **Reopen room**, **Voice settings** and **Push to talk**.
- **Not changed:** the known intermittent `test/voice-direct.test.mjs` failure (127.0.0.1). A typed address in the terminal demo can fail when mDNS finds the peer at the same time.
- **Mixed versions:** use 0.7.0 on both computers.

### Install

1. Copy the same `dist/ASSCRACK-0.7.0-portable.exe` to each computer. Do not use an older .exe.
2. On each computer, run this command in PowerShell, in the folder of the .exe:
   ```powershell
   Get-FileHash .\ASSCRACK-0.7.0-portable.exe -Algorithm SHA256
   ```
   Expect: the same value as the SHA-256 in `CHANGELOG.md`, entry 0.7.0. If the value is different, stop. Do not use that file.

### Setup

1. **Close all copies of an older ASSCRACK on each computer before you start 0.7.0.** A new build that starts while an old copy runs shows the old copy.
2. Disconnect a VPN on both computers.
3. Use headphones or speakers on both computers. Write down which.
4. The profile folder of the app is `$env:APPDATA\asscrack`. The saved rooms are in its sub folder `saved-rooms` (`archive.db`, `archive.key`). Do not edit or delete these files during the test.

### Start commands

Run each command in PowerShell, in the folder of the .exe. `--dev` opens the developer console.

- A and B: `.\ASSCRACK-0.7.0-portable.exe --dev`

### Procedure

1. **Firewall question.** Start the app on A and on B. Write down if Windows shows the firewall question. Allow the app on private networks.
2. **Saved room on A.** On A, type a name. Set **Room type** to "New internet room". Type the room name `room8`. Keep **Public address** empty. Put a check in "Save room on this device" and in "Keep local history". Select **Log In**. Expect: the chat window, and "Waiting for a peer" until B joins. Select **Invite**, then **Copy**. Send the code to B.
   - If the check box "Save room on this device" is not available, write down the text below **Log In**. Expect one of: "Saved rooms: locked (<reason>)" with a **Try again** button, or "Protected storage is not available on this computer. Rooms cannot be saved."
3. **Saved room on B.** On B, type a name. Set **Room type** to "Join with invite code". Paste the code. Put a check in "Save room on this device" and in "Keep local history". Select **Log In**. Expect within 60 seconds: A and B show each other in the Buddies list. "Waiting for a peer" goes away.
4. **Chat.** On A and B, send 3 chat lines each. Expect: each line shows on the other computer one time. Each line gets a small check mark. Move the mouse on the mark. Expect the title "Saved on this device".
5. **Quote.** On B, move the mouse on a line of A and select **Quote**. Type a reply and press Enter. Expect on A: the reply with the quoted line of A above it.
6. **Find.** On A, press Ctrl+F. Type a word from a chat line. Expect: the app marks the word and the bar shows "1 of <n>". Press Escape.
7. **Manual status.** On A, set the status to "Away" with the note `back at 9`, then select **Set**. Expect on B: the badge of A shows "Away: back at 9". On B, set "Do not disturb" and select **Set**. Expect on A: the badge of B shows "Do not disturb".
8. **Voice.** On A and B, select **Join voice**. Speak in turn. Expect: each user hears the other.
   - Select **Voice settings**. Under **Noise suppression**, try "RNNoise (strong)", "Standard (light, steady noise only)" and "Off". Make a steady noise (for example a fan) and write down which setting stops it best.
   - Set **Input mode** to "Push to talk". Select **Set key** and press a key. Keep "Also when ASSCRACK is in the back" on. Put a different window in front. Hold the key and speak. Expect: the other user hears you only while you hold the key.
9. **Reopen with no network.** Close the app on A and on B. On A, turn off the network (Wi-Fi off or cable out). Start the app on A. Expect: the login screen lists `room8` with a **Reopen room** button. Select **Reopen room**. Expect at once: the chat lines of steps 4 and 5, and "Waiting for a peer".
10. **Reopen on both computers.** Close the app on A. Turn on the network of A. Start the app on A and on B. On each computer, select **Reopen room** for `room8`. Expect within 60 seconds: A and B show each other again, and "Waiting for a peer" goes away. Expect: each old line shows one time only (not two times). Send one new line in each direction.
11. **Optional: a different folder.** Close the app on A. Move the .exe on A to a different folder and start it there with the same command. Expect: `room8` is still in the list of saved rooms.
12. **Optional: a different Windows user.** On A, log in to Windows as a different user. Start the .exe. Expect: no saved room in the list.
13. Keep the logs (see **Report**).

### Expected (127.0.0.1 simulation, not field)

| Item | Expected |
|---|---|
| Save a room, send and receive, close, reopen with no peer | the saved lines show at once, and "Waiting for a peer" |
| 250 lines through 2 copies | each line one time on each copy, with a saved mark |
| Away with a note | the other window shows "Away: back at 9" |
| Push to talk | frames go out only while the key is down |

### If it goes wrong

- `Get-FileHash .\ASSCRACK-0.7.0-portable.exe -Algorithm SHA256` gives a different value: copy the .exe again. Do not test with that file.
- `Select-String -Path "$env:APPDATA\asscrack\logs\asscrack-*.log" -Pattern 'error|saved|archive' | Select-Object -Last 20`: run this when "Saved rooms: locked (<reason>)" shows, or when a reopen shows no lines. Copy the output into a text file. Select **Try again** one time and write down the result.
- `explorer "$env:APPDATA\asscrack\saved-rooms"`: when a saved room is not in the list, write down if `archive.db` and `archive.key` are in the folder. Do not edit or delete them.
- `Select-String -Path "$env:APPDATA\asscrack\logs\asscrack-*.log" -Pattern 'event (upnp|connection|dial-failed)'`: run this when A and B do not find each other within 60 seconds. Copy the output into a text file with the name of the computer.
- A line shows two times after step 10: make a screenshot of each window. Write down the text and the time of the line.

### Report

Tell Claude the result of each step (PASS or FAIL), with the text that you saw when it was different. Keep these items from each computer (A and B), in a folder with the name of the computer:
- the log files: run `explorer "$env:APPDATA\asscrack\logs"` and copy each `asscrack-*.log` file. Do not edit the files.
- the developer console output of each app (`--dev`), with each red line
- the terminal output of PowerShell, if it has lines
- the text files of "If it goes wrong"
- the SHA-256 of the tested .exe: `Get-FileHash .\ASSCRACK-0.7.0-portable.exe -Algorithm SHA256`
- the firewall result of step 1, headphones or speakers, and the best noise setting of step 8

### Not known

- This build is from a Linux VM. It is the first build of this kind. The packaged Windows .exe has no result yet.
- No feature of 0.7.0 has a LAN result, an internet result or a packaged .exe result. All results are 127.0.0.1 results.
- UPnP on a real router.

## Internet test card 7 (0.6.0): a host with no port forward (UPnP), connection log lines and the firewall question on 2 computers

This test checks the 0.6.0 changes across the internet. The host does not need a port forward now. When the Public address field is empty, the app asks the router for a port (UPnP). If the router agrees, the host becomes a full node, and the invite code has the public address. Each app also writes one log line for each connection and for each failed dial. All builds now unpack to one folder, so Windows asks the firewall question one time only.

- Computer 1 (**A**) is at home, on your router. A is the host.
- Computer 2 (**L**, the laptop) is on a phone hotspot (mobile data), not on the network of A.
- **dist/ASSCRACK-0.6.0-portable.exe** (SHA-256 in `CHANGELOG.md`): UPnP for the host, connection log lines and one unpack folder. Also: the relay sessions spread across the full nodes, and two members with a direct connection send voice directly.
- **Not known:** UPnP on a real router, and all of 0.6.0 on the internet. The UPnP tests used a fake router on 127.0.0.1. The relay spread and the direct voice need 3 or more computers, so this card does not test them.
- **Mixed versions:** use 0.6.0 on both computers.

### Before the test

1. Copy `dist/ASSCRACK-0.6.0-portable.exe` to each computer. Do not use an older .exe.
2. **Router record.** Open the admin page of the router of A. Write down the router model. Find the UPnP setting and write down if it is on or off. Do not change it.
3. **No port forward.** On the router of A, turn off the forward of TCP port 4001 to A (from test card 6 and R0). This test must show that A works with no forward. Write down that you turned it off.
4. Connect L to the phone hotspot. Disconnect a VPN on both computers, for example TunnelBear.
5. **Start only one copy of the app on each computer.** Known fault: a second copy deletes files of the first copy, and the second copy hangs.
6. Use headphones on both computers. On A, prepare a file of about 5 MB.

### Start commands

Run each command in PowerShell, in the folder of the .exe. `--dev` opens the developer console.

- A and L: `.\ASSCRACK-0.6.0-portable.exe --dev`

### The test

1. **Firewall question.** Start the app on A and on L. On each computer, write down if Windows shows the firewall question ("Windows Defender Firewall has blocked some features"). Write down the program path in the question if it shows one. Allow the app on private networks. If Windows shows the network as a public network, also allow it on public networks.
2. **UPnP host.** On A, type a name. Set **Room type** to "New internet room". Type the room name `room7`. Keep **Public address** empty. Select Log In. Wait 70 seconds. Then run this command in PowerShell on A:
   ```powershell
   Select-String -Path "$env:APPDATA\asscrack\logs\asscrack-*.log" -Pattern 'event upnp' | Select-Object -Last 3
   ```
   Expect: a line with `event upnp state "mapped"`, the public IP of A and a port. Write down the full line. If the line has `state "none"`, write down the line, then go to step 9. A cannot be a host with no forward on this router.
3. On A, select **Invite**, then **Copy**. Send the code to L.
4. **Join.** On L, type a name. Set **Room type** to "Join with invite code". Paste the code. Select Log In. Expect within 30 seconds: A and L show each other in the Buddies list. The status bar of A shows "This computer is a full node". The status bar of L shows "Full node: <name of A>".
5. On A and L, send chat lines. Expect: each line shows on the other computer.
6. **Voice.** On A and L, select Join voice. Speak in turn. Expect: each user hears the other. The sound has no long gaps.
7. **File.** On A, select the 5 MB file, then select **Send file**. On L, select Accept. Expect: "Saved as <file name>" on L.
8. **Rejoin.** Close the app on A. Start it again with the same command. If Windows shows the firewall question again, write it down. Type the name. Set **Room type** to "Join with invite code". Paste the invite code of step 3. Keep **Public address** empty. Select Log In. Expect within 60 seconds: A and L show each other again, and chat works both ways. Run the command of step 2 again. Expect: a second `mapped` line with the same port as the first line.
9. **Connection lines.** On each computer, run this command in PowerShell:
   ```powershell
   Select-String -Path "$env:APPDATA\asscrack\logs\asscrack-*.log" -Pattern 'event (upnp|connection|dial-failed)'
   ```
   Copy all output lines into a text file with the name of the computer (A or L). Expect on L: one or more `event connection` lines with `type "direct"`.
10. **Firewall, second start.** Close the app on A and on L. Start it again on each computer. Expect: no firewall question. Write down the result. Close the apps.
11. Keep the logs. In PowerShell, run `explorer "$env:APPDATA\asscrack\logs"` on each computer. Copy each `asscrack-*.log` file into a folder with the name of the computer (A or L). Do not edit the files. Also keep the developer console output of each app if it has a red line.
12. Turn on the port forward of step 3 again if you want it.

### Done when

Write PASS or FAIL for each condition. Write down the values for conditions 1 to 3.

| # | Condition | Result |
|---|---|---|
| 1 | Router record: the model, UPnP on or off. | |
| 2 | The `event upnp` line of step 2 (copy the full line). | |
| 3 | The firewall question: on the first start (step 1), on the rejoin (step 8) and on the second start (step 10), on each computer. Write "yes" or "no" for each. Expect: yes, no, no. | |
| 4 | With no port forward, A and L show each other within 30 seconds (step 4). | |
| 5 | A shows "This computer is a full node". L shows "Full node: <name of A>". | |
| 6 | Chat lines go both ways. | |
| 7 | In voice, each user hears the other. Write the time of a gap or an echo if you hear one. | |
| 8 | The 5 MB file arrives on L. Write the time of the transfer. | |
| 9 | After the rejoin, A and L are in one room again, and the port is the same. | |
| 10 | Each computer has `event connection` lines (step 9). | |
| 11 | The developer consoles show no red error line. | |

### If a condition fails

Keep these items for the analysis:
- the number of the condition that failed, and the computer (A or L)
- what you saw, and a screenshot of the window if possible
- the text files of step 9 and the log files of step 11
- the router model and the UPnP setting
- the developer console output of each app with a red line

---

## Internet test card 6 (0.5.0): an internet room with an invite code, a full node and a relay on 2 computers

This test checks the 0.5.0 changes across the internet. A user makes an internet room and gives an invite code to the other users. A computer with a forwarded TCP port is a **full node**. The other members connect to it. When two members cannot connect directly, their chat goes through the full node (a **relay link**). Voice now goes through the host on a libp2p stream, not WebRTC. A LAN room with no invite code works as before.

- Computer 1 (**A**) is at home, on a router where you can forward a TCP port. A is the full node.
- Computer 2 is on a phone hotspot (mobile data), not on the network of A. Computer 2 runs two apps: **B** and **C**. B and C use the test flag `--relay-only`, so they cannot connect directly to each other. Their chat must go through A.
- **dist/ASSCRACK-0.5.0-portable.exe** (SHA-256 in `CHANGELOG.md`): internet rooms, invite codes, full nodes, relay links, the room key, and voice over libp2p.
- **Not known:** all of this. On one PC (127.0.0.1), the relay path, the room key, history, files and voice frames passed. These are not internet results.
- **Mixed versions:** a 0.4.0 app cannot join an internet room. In a LAN room, a 0.4.0 app has no voice with a 0.5.0 app. Do not use a 0.4.0 app in this test.

### Before the test

1. Copy `dist/ASSCRACK-0.5.0-portable.exe` to each computer. Do not use an older .exe.
2. **Find out if A is behind a CGNAT.** A CGNAT is a second NAT at the internet provider. A port forward on your router cannot pass a CGNAT.
   1. On A, open a web page that shows your public IP address, for example a search for "what is my IP". Write it down.
   2. Open the admin page of your router. Find the WAN IP address (or "Internet IP").
   3. If the WAN IP is the same as the public IP, there is no CGNAT. Continue.
   4. A is behind a CGNAT if the WAN IP is not the same as the public IP. A WAN IP in these ranges is also a CGNAT: `100.64.0.0` to `100.127.255.255`, `10.x.x.x`, `172.16.x.x` to `172.31.x.x`, `192.168.x.x`. Stop. A cannot be a full node on this network. Write down both IP addresses and tell the engineer.
3. On the router of A, forward TCP port **4001** to the LAN IP address of A (find it with `ipconfig` in PowerShell, line "IPv4 Address").
4. **Windows Firewall:** when the .exe of A starts the first time, allow it on private networks. If Windows shows the network of A as a public network, also allow it on public networks. Else the firewall blocks the forwarded port.
5. Connect computer 2 to the phone hotspot. Disconnect a VPN on both computers, for example TunnelBear.
6. **The .exe has no code signature.** Windows SmartScreen can show "Windows protected your PC". The user of that computer decides if the .exe can run.
7. Use headphones on A and on computer 2.
8. On computer 2, make two folders: `C:\asscrack-b` and `C:\asscrack-c`. Each app on computer 2 keeps its profile and its logs in its own folder.
9. On A, prepare a file of about 50 MB. On computer 2, prepare a file of about 5 MB (mobile data is slow and can cost money).

### Start commands

Run each command in PowerShell, in the folder of the .exe. `--dev` opens the developer console.

- A: `.\ASSCRACK-0.5.0-portable.exe --dev`
- B: `.\ASSCRACK-0.5.0-portable.exe --dev --relay-only --profile C:\asscrack-b --log-dir C:\asscrack-b\logs`
- C: `.\ASSCRACK-0.5.0-portable.exe --dev --relay-only --profile C:\asscrack-c --log-dir C:\asscrack-c\logs`

### The test

1. On A, start the app. Type a name. Set **Room type** to "New internet room". Type the room name `room6`. In **Public address**, type `<public IP>:4001` (the public IP from step 2 of "Before the test"). Select Log In.
2. On A, select **Invite** (top right). Expect: a long code that starts with `asscrack1:`. Select **Copy**. Send the code to computer 2 (for example in an e-mail or a chat message to yourself). Expect in the status bar of A: "No full node" at this time. A is a full node only after a peer can connect back to it.
3. **Wrong key first.** On computer 2, copy the invite code. Then run this script in PowerShell. It replaces the room key in the code on the clipboard with a random key:
   ```powershell
   $c = (Get-Clipboard -Raw).Trim(); $b = $c.Substring(10).Replace('-','+').Replace('_','/'); $b += '=' * ((4 - $b.Length % 4) % 4)
   $o = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) | ConvertFrom-Json
   $k = New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($k)
   $o.key = [Convert]::ToBase64String($k).TrimEnd('=').Replace('+','-').Replace('/','_')
   $e = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress -Depth 5))).TrimEnd('=').Replace('+','-').Replace('/','_')
   Set-Clipboard ('asscrack1:' + $e)
   ```
   Start C. Type the name `wrongkey`. Set **Room type** to "Join with invite code". Paste the code from the clipboard. Select Log In. Wait 30 seconds. Expect: C shows no other user. A shows no user `wrongkey`. Close C.
4. **Join.** On computer 2, copy the real invite code again. Start B. Type a name. Set **Room type** to "Join with invite code". Paste the code. Select Log In. Expect within 30 seconds: A and B show each other in the Buddies list. The status bar of A shows "This computer is a full node". The status bar of B shows "Full node: <name of A>". The HOST mark is on A.
5. On A and B, send chat lines. Expect: each line shows on the other computer.
6. **History.** Start C again (same command as before). Type a new name. Join with the real invite code. Expect: C shows the chat lines of step 5, in the correct order.
7. **Map.** On each app, select **Network map**. Expect: A has the FULL badge. The line between B and C is a dashed line (relay link). The lines from A to B and from A to C are solid lines.
8. On B and C, send chat lines. Expect: each line shows on all three apps. The B to C lines go through A.
9. **Voice.** On C, select Join voice, then **Mute**. On A and B, select Join voice. Speak in turn. Expect: A hears B, and B hears A. The sound has no long gaps.
10. **Files.** On A, select the 50 MB file, then select **Send file**. On B and C, select Accept. Expect: "Saved as <file name>" on B and C. Then on B, send the 5 MB file. On C, select Accept. Expect: "Saved as" on C. This transfer goes from B to A and from A to C over mobile data.
11. Close C, then B, then A.
12. **LAN room.** Connect computer 2 to the same network as A (not the hotspot). Start A with `.\ASSCRACK-0.5.0-portable.exe --dev` and B with the start command of B **without** `--relay-only`. On both, set **Room type** to "LAN room" and type the room `lan6`. Select Log In. Expect: A and B find each other with no invite code. The **Invite** button is not visible. Send a chat line in each direction. Join voice on both, and speak. Expect: each user hears the other.
13. Keep the logs. Close each app first.
    - A: in PowerShell, run `explorer "$env:APPDATA\asscrack\logs"`.
    - B and C: `C:\asscrack-b\logs` and `C:\asscrack-c\logs`.
    - Copy each `asscrack-*.log` file into a folder with the name of the app (A, B, C). Do not edit the files. Also keep the developer console output of each app if it has a red line.

### Done when

Write PASS or FAIL for each condition:

| # | Condition | Result |
|---|---|---|
| 1 | Step 2 of "Before the test": the router WAN IP is the same as the public IP (no CGNAT). Write both IP addresses. | |
| 2 | A shows an invite code that starts with `asscrack1:`, and Copy puts it on the clipboard. | |
| 3 | With the wrong key (step 3), C shows no other user, and A shows no user `wrongkey`, after 30 seconds. | |
| 4 | With the real code, A and B show each other within 30 seconds. | |
| 5 | A shows "This computer is a full node". B shows "Full node: <name of A>". | |
| 6 | Chat lines go both ways between A and B. | |
| 7 | C shows the earlier chat lines in the correct order (history). | |
| 8 | The map shows the FULL badge on A, a dashed line between B and C, and solid lines from A to B and C. | |
| 9 | Chat lines from B show on C, and lines from C show on B. | |
| 10 | In voice, A hears B and B hears A. Write the time of a gap or an echo if you hear one. | |
| 11 | The 50 MB file arrives on B and C. The 5 MB file arrives on C. Write the time of each transfer. | |
| 12 | In the LAN room (step 12), A and B find each other with no invite code, and the Invite button is not visible. | |
| 13 | In the LAN room, chat and voice work both ways. | |
| 14 | The developer consoles show no red error line. | |
| 15 | Each app has at least one `asscrack-*.log` file from this test. | |

### If a condition fails

Keep these items for the analysis:
- the number of the condition that failed, and the app (A, B or C)
- what you saw, and a screenshot of the window if possible
- the log files of each app, and the public IP and the router WAN IP of A
- the developer console output of each app with a red line

---

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
