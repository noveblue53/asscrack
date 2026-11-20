# Manual Idle Peer on 127.0.0.1

The portable window’s Close in a joined room defaults to **Enter Idle Peer**. View exposes both the preference and the explicit action. **Open Asscrack** and **Quit Asscrack** are available in the native tray. Minimize preserves the call. Open restores the same running node with local capture off. A capable buddy hides the idle person from the active count and shows **Idle peer** in the network map. Pinned 0.7.0 and 0.6.0 peers ignore the extra participation flag, retain the connected buddy and show the ordinary voice-leave transition.

## Local functional checks

| Check | 127.0.0.1 result |
| --- | --- |
| Full node and two restricted endpoints | A second endpoint joined the already-idle host. The endpoints acquired relay reservations, formed a circuit session, exchanged chat, and passed synthetic voice through the same full node. Its identity and host election stayed stable. Open restored participation with voice off. |
| Separate Linux Electron window and one peer | Exercised real BrowserWindow Close, a native Electron Tray’s Open and Quit callbacks, explicit Enter, close preference, Minimize while joined to voice, and capture release with a synthetic microphone preview. A chat line delivered while hidden. Open preserved the peer session, and Quit released it. No renderer errors. Native stderr reported the Linux sandbox’s unavailable netlink, udev and video-provider facilities. |
| Mixed-version pairs | Against each of 0.7.0 at `de54371` and 0.6.0 at `d5ad3af`, both peers exchanged messages across Idle and Open. The legacy node retained the full-node identity, received the voice-leave announcement, and displayed ordinary messages in history. |

## Visible versus idle on the same full node

Four consecutive one-minute windows used the same Linux x64 Electron 40.5.0 process, profile, room, window layout and settings on an AMD EPYC 9V74 VM. Local mic and voice playback stayed off. Two restricted libp2p peers generated one 120-byte voice payload each every nominal 20 ms. The host received and forwarded both directions. The two-peer circuit used only 127.0.0.1. Counters exclude initial connection and teardown.

| State in sample order | Seconds | CPU, % of one core | Sum of working sets, MiB, min–max | Room TCP bytes read / written | Voice payloads arrived / sent | App log growth |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Visible, no peers | 60.0 | 1.2 | 426.1–531.7 | 0 / 0 | 0 / 0 | 0 bytes |
| Idle, no peers | 60.1 | 0.6 | 417.6–427.3 | 0 / 0 | 0 / 0 | 0 bytes |
| Idle, forwarding | 60.0 | 8.0 | 423.2–429.0 | 1,444,412 / 1,455,272 | 5,872 / 5,872 | 0 bytes |
| Visible, forwarding | 60.1 | 15.9 | 434.6–444.0 | 1,427,198 / 1,437,848 | 5,800 / 5,800 | 0 bytes |

CPU is the sum of the change in cumulative Electron process CPU seconds divided by wall seconds. Working sets were sampled every ten seconds and may count shared pages more than once. The first visible interval includes process warm-up. Room TCP counts use the host’s accepted node sockets and exclude the test driver, display server and UI debugger connections. Pseudorandom node identities and timer scheduling vary on each run.

These four minutes characterize short-run Linux overhead. Overnight memory and log growth, real Windows tray placement and second-launch activation, physical sleep/wake, acoustic voice continuity and Internet routes await their field checks. Installer sign-in startup has a separate gate.
