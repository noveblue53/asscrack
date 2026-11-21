# ASSCRACK Windows friend-pilot field card

Use the **same hardening candidate** on every computer. Match the SHA-256 in the candidate handoff with `Get-FileHash -Algorithm SHA256 -LiteralPath <path-to-exe>`. Quit older copies from the tray. Use fresh profiles for initial pairing and back up closed profiles for upgrade checks. The earlier RC1 used source `42cf3c6` and shared bearer invites.

For a new protected room, each friend selects **Join with invite code**, copies their device ID and gives it to the owner. In **Invite**, the owner issues a code for that device. Keep the owner online for first admission. Give the backup host the hosting permission before testing failover. The host can hear forwarded voice. For the router-mapping check, explicitly select **Ask my router to open a TCP port (UPnP)**.

## Three Windows PCs, separate networks

Use PC as reachable host and Brother and Laptop as restricted members. Verify routes in the map. Test fresh external joins using a forwarded port and a UPnP mapping after its original lease would have elapsed. [Incident details and topology](../src/network/chatreadme.md#internet-test-card-9--070-field-retest)

1. **Join and talk.** Give a friend the executable and invite. Have them join unaided, catch up in a public channel, whisper via `/w Name` and the buddy menu, mute and use push-to-talk with physical audio devices. Check native notification click-through while minimized and suppression in Do Not Disturb.
2. **Retry a file.** Send a large original to Laptop and Brother. Isolate Laptop mid-download and check per-recipient status. After reconnect, click **Retry** repeatedly on the original card or Transfers row. Brother should finish independently. Each receiver should save one copy with the original size and SHA-256, and Explorer should select it. Check the action with the source offline and back online. Repeat over an established relay. Send a screenshot, play and pause a GIF, and seek in a supported video of at least 100 MiB.
3. **Find a Shared file.** Publish before Laptop joins, then have Laptop find and download it. Remove the listing and check that the saved copy and one-off chat attachments still work.
4. **Recover chat and voice.** Remove and return the only route, then exchange fresh chat and intelligible speech both ways. For alternate-relay recovery use two reachable full nodes plus Brother and Laptop. Verify the old path, remove its relay and record the new path and gap in each direction. Enter Idle Peer while forwarding and check capture stops and traffic continues. Test tray reopen, explicit Quit, a second launch and sleep/wake.

## Return tomorrow

Reopen a saved room offline, compare its transcript, then reconnect. Rehearse upgrades on disposable 0.7.0 and 0.6.0 profiles. Verify that the original account can recover a protected 0.7.0 backup after a missing-key trial on a copy. Pair the candidate with both legacy binaries. At 800 × 600 try keyboard controls, John’s map details, window drag and resize, Snap and mixed DPI where supported. [Upgrade and release criteria](WORK_PLAN_1.0.md#build-and-upgrade-the-10-candidate)

Record the executable filename and SHA-256, Windows version, devices, networks, routes, timestamps, outcomes and manual rescues. Keep invite data, addresses and chat text out of shared records.
