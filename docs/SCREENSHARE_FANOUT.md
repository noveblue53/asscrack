# Peer-Assisted Screen Share Fanout (Design Spec)

## Problem Statement

Today, ASSCRACK screen sharing (`src/network/screen-share.mjs`, `src/network/screen-rate.mjs`, `src/network/screen-audio.mjs`) uses a star topology centered on the sharer:

- Each viewer opens `/asscrack/screen/1.0.0` (and optionally `/asscrack/screen-audio/1.0.0`) directly to the sharer.
- Total sharer upload scales linearly as `N_viewers * bitrate`.
- On a typical asymmetric home connection (for example, 20 Mbps up and 500 Mbps down):
  - 1 viewer at Max (12 Mbps) fits comfortably.
  - 2 viewers (24 Mbps) exceed the sharer uplink and throttle down.
  - 5 viewers drop below 4 Mbps each.
- Behind a circuit relay (`/p2p-circuit`), the sharer uploads `N` duplicate copies through the relay. This burns `N * bitrate` on the sharer uplink and the relay links (capped at `relayLimit = 6 Mbps` split across `N` viewers).

Meanwhile, each viewer uses a small fraction of download bandwidth (~12 Mbps out of 500 Mbps) while upload bandwidth (~15 to 20 Mbps) sits idle.

## Goals

1. Redistribute upload load across the room so no single peer hits its upload cap while delivering high-bitrate streams to multiple viewers.
2. Eliminate duplicate relay uploads by letting reachable full nodes act as fanout parents (1 upload from sharer -> parent -> `N` viewers).
3. Keep latency low for small friend groups while scaling to larger rooms (up to 24 viewers).
4. Forward raw VP8 video frames and Opus screen-audio packets without re-encoding (~0% CPU overhead).
5. Keep 100% backwards compatibility with 1.0.1 to 1.0.6 peers.
6. Keep the tree coordinator modular so other room streams can reuse it later.

---

## 1. Scope and Phased Rollout

- **Phase 1 (Sessions 2 to 6): Active viewers only.**
  A peer forwards a share only while it watches that share. This adds zero extra download bandwidth and zero background forwarding. A reachable full-node peer that watches a share gets priority as a depth-1 parent because it has `'mesh'` links to NAT peers.
- **Deferred to Session 7: Non-watching hubs.**
  Recruiting idle or non-watching full-node peers to pull and fan out a share is deferred to Session 7. Session 7 will require an opt-in Settings toggle for user consent, a `HUB_OFFER` / `HUB_ACCEPT` / `HUB_STOP` handshake on the room control channel, and shared global slot accounting across `maxShares = 3`. Phase 1 global slot accounting and `screen-fanout` report schemas remain forward-compatible with Session 7.
- **Phase 2 (Future): Direct NAT-to-NAT reachability.**
  Integrate libp2p DCUtR or hole-punching so NAT viewers can establish direct links to each other without a full-node parent.

---

## 2. Route-Aware Link Rules (Phase 1 Locked to `'mesh'` Only)

- **Link source:** The sharer reads direct link state from `topology()` in `src/network/node.mjs` (`{ self, links, kinds, selfIdle, idlePeers }`). Room `{ type: 'links', peers, kinds }` control messages update this map. `WATCH` never carries a `directPeers` list.
- **Phase 1 forwarding edge invariant:** A forwarding edge `parent -> child` (where `parent.hop >= 1`) is valid only when all four conditions hold:
  1. `topology.kinds[parent]?.[child] === 'mesh'` and `topology.kinds[child]?.[parent] === 'mesh'` (symmetric non-relay link).
  2. Neither `parent` nor `child` is in `topology.idlePeers`.
  3. `parent.hop < maxHop` (`maxHop = 3`, where depth `0` is sharer, `1` is direct child, `2` is grandchild, `3` is great-grandchild).
  4. `parent` has available forwarding slots, is not `congested`, and is not in `parentFailBackoffMs` for `child`.
- **Sharer to depth-1 edge:** This edge may be `'mesh'` or `'relay'`. A NAT sharer can send 1 relayed stream to a reachable full-node depth-1 viewer, which then fans out over `'mesh'` edges to other viewers.
- **No relay-to-relay forwarding:** A viewer with no symmetric `'mesh'` edge to an eligible forwarder stays directly attached to the sharer.
- **Transport enforcement:** `node.mjs` registers `/asscrack/screen-fanout/1.0.0` with `runOnTransientConnection: false`. The handler rejects any connection whose `remoteAddr` contains `/p2p-circuit` with `END(refused)`.

---

## 3. Wire Protocol and Exact Schemas

All records on `/asscrack/screen/1.0.0` and `/asscrack/screen-fanout/1.0.0` use existing length-prefixed framing: `[uint32be length][uint8 type][body]` where `length = 1 + body.length`.

### 3.1 `SCREEN_TYPE` (`src/network/screen-rate.mjs`)

- Existing: `WATCH: 1`, `CONFIG: 2`, `FRAME: 3`, `ACK: 4`, `KEYREQ: 5`, `END: 6`.
- New: `REDIRECT: 7` (sharer to viewer on `/asscrack/screen/1.0.0`, JSON body, `MAX_REDIRECT_JSON = 511`).

### 3.2 Slim `WATCH` (`type = 1`, viewer to sharer on `/asscrack/screen/1.0.0`, `MAX_WATCH_JSON = 255`)

- Fanout-capable viewer (~81 bytes, strictly `< 120` bytes, compatible with 1.0.1 to 1.0.6's 255-byte limit):

```json
{ "v": 1, "shareId": "<uuid>", "fanout": 1, "maxChildren": 2 }
```

- Direct-only fallback (after `maxRedirects` or opt-out) or 1.0.1 to 1.0.6 viewer (~51 bytes):

```json
{ "v": 1, "shareId": "<uuid>" }
```

- Validation: `v === 1` and `shareId === own.shareId`. `fanout === 1` marks the viewer as fanout-capable. `maxChildren` is an integer `0..8` (default `0` if omitted or invalid, where `0` means leaf-only). Omitting `fanout` (or `fanout !== 1`) forces direct attachment with `hop = 1` and `maxChildren = 0`.

### 3.3 `REDIRECT` (`type = 7`, sharer to viewer on `/asscrack/screen/1.0.0`, `MAX_REDIRECT_JSON = 511`)

```json
{
  "v": 1,
  "shareId": "<uuid>",
  "parentPeerId": "<libp2p peerId>",
  "hop": 2,
  "tokenSeq": 14,
  "sig": "<base64url Ed25519 signature, 86 chars>"
}
```

- The sharer sends `REDIRECT` only before `CONFIG` in response to `WATCH`, then immediately calls `closeStream` (no `CONFIG` or `END` sent). Mid-stream rebalancing via `REDIRECT` after `CONFIG` is deferred.
- **Verified token:** The sharer signs the UTF-8 bytes of `asscrack-fanout-v1\n${shareId}\n${sharerPeerId}\n${parentPeerId}\n${childPeerId}\n${hop}\n${tokenSeq}` with the node Ed25519 private key. The parent verifies offline using the `sharerPeerId` embedded Ed25519 public key (zero extra RTT, works in keyed and unkeyed rooms).
- `tokenSeq` is a strictly increasing positive integer per share (starts at 1). The parent tracks `lastTokenSeq.get(childPeerId)` per `shareId` and rejects `tokenSeq <= last` to stop replay without synchronized clocks.
- Viewer validation: `v === 1`, `shareId === w.shareId`, `parentPeerId` is a non-empty string `!== selfId` and `!== sharerPeerId`, `hop` is an integer `2..3`, `tokenSeq >= 1`, and `sig` length is `1..128`. An invalid `REDIRECT` aborts the stream and triggers direct fallback.

### 3.4 `/asscrack/screen-fanout/1.0.0` Open Record (`OPEN = 1`, child to parent)

Limits: `MAX_FANOUT_OPEN_JSON = 511`, `MAX_FANOUT_CHILD_RECORD = 512`, `openRecordMs = 5000`.

```json
{
  "v": 1,
  "shareId": "<uuid>",
  "sharerPeerId": "<libp2p peerId>",
  "hop": 2,
  "tokenSeq": 14,
  "sig": "<base64url Ed25519 signature>"
}
```

Parent verification checklist (all must pass, else send `END(refused)` or `END(full)` and close):

1. Direct `'mesh'` connection (`!remoteAddr.includes('/p2p-circuit')`), else `refused`.
2. `allowed(childPeerId)`, `!idle()`, and `allowOpen(childPeerId)` rate limit, else abort or `refused`.
3. Parent actively watches `shareId` owned by `sharerPeerId` and has cached `CONFIG` (`configured === true`), else `refused`.
4. `v === 1`, `hop === parent.hop + 1`, `hop <= 3`, and `tokenSeq > (lastTokenSeq.get(childPeerId) ?? 0)`, else `refused`.
5. Ed25519 `sig` verifies against `sharerPeerId` public key for `parentPeerId = selfId` and `childPeerId = remotePeerId`, else `refused`.
6. Not `congested`, global forwarded children `< globalMaxChildren`, and per-share children `< maxChildren` (unless replacing an existing stream from the same `childPeerId`, which closes the old stream with `END(replaced)`), else `full`.

After acceptance, the parent records `lastTokenSeq`, sends cached `CONFIG`, and forwards `KEYREQ` upstream (rate-limited at `keyRequestMs = 2000` ms per parent). It waits for the first keyframe before sending delta `FRAME` records verbatim, and sends `child-joined` to the sharer.

Subsequent records on `/asscrack/screen-fanout/1.0.0`:
- Parent to child: `CONFIG (2)`, `FRAME (3)`, `END (6)`.
- Child to parent: `ACK (4)` (4-byte `seq`), `KEYREQ (5)` (empty body).

### 3.5 Parent to Sharer Child and Shed Reports (`screen-fanout` control line)

The parent sends reports unicast to `sharerPeerId` over the existing room control session (`sendLine(sharerPeerId, msg)`). This works identically at hop 1, hop 2, and hop 3, even if the parent upstream video stream drops. The sharer rate-limits reports via `roomRateLimit` (`reportsPerPeer: 60`, `reportsPerRoom: 300` per minute). 1.0.1 to 1.0.6 peers ignore this line.

```json
{
  "type": "screen-fanout",
  "v": 1,
  "shareId": "<uuid>",
  "event": "child-joined" | "child-left" | "child-shed" | "capacity",
  "childPeerId": "<peerId>",
  "reason": "stopped" | "slow" | "congested" | "lost" | "error",
  "children": 2,
  "maxChildren": 2,
  "congested": false
}
```

- `child-joined`: `childPeerId` required. Sharer clears the `redirectConfirmMs` (8000 ms) pending-redirect timer and confirms the edge.
- `child-left`: `childPeerId` required, `reason` is `'stopped'` or `'lost'`. Sharer removes the edge and frees the slot.
- `child-shed`: `childPeerId` and `reason` (`'slow' | 'congested' | 'error'`) required. Sharer removes the edge and records `parentFailBackoffMs` for `(childPeerId, parentPeerId)`. If `reason === 'slow'`, sharer marks `childPeerId` for direct or `slow`-tier placement on next `WATCH`. If `reason === 'congested'`, sharer applies `congestedBackoffMs` to `parentPeerId`.
- `capacity`: `childPeerId` omitted. Reports changes to `maxChildren` or `congested` boolean.
- Every report includes current `children`, `maxChildren`, and `congested` so the sharer self-heals after any missed report.
- **Pending-redirect expiry:** The sharer reserves a slot on `parentPeerId` for `redirectConfirmMs = 8000` ms. If neither `child-joined` nor a retry `WATCH` arrives, the reservation expires and the slot releases.

---

## 4. Rate Control, Congestion Shedding, Backoff, and Failover Lifecycle

### 4.1 Timing and Retry Constants

- `maxHop = 3`
- `maxRedirects = 3` (per `watchScreen()` startup attempt)
- `fanoutOpenTimeoutMs = 5000` (per redirect hop waiting for `CONFIG`)
- `watchStartupMaxMs = 15000` (total startup cap across redirects and direct fallback)
- `redirectConfirmMs = 8000` (sharer pending-redirect slot reservation timeout)
- `parentFailBackoffMs = 30000` (30 s exclusion for a failed `(viewer, parent)` pair on both viewer and sharer)
- `congestedBackoffMs = 30000` (30 s cooldown before assigning new children to a previously congested parent)
- `reattachJitterMs = 250` (random `0..250` ms jitter when a parent drops mid-watch to prevent thundering herd)

### 4.2 Per-Child Pacing and Congestion Shedding

- Forwarders never re-encode. Each child gets a bounded send queue (max `queueSeconds = 1` s, dropping pending non-keyframes when congested). `slowMs = 10000` ms without delivery sheds the child with `END(slow)`.
- Each child sends `ACK` per `FRAME`. The parent tracks per-child lag (`excess`).
- If the parent uplink or voice queue shows sustained backpressure, the parent sets `congested = true` and sheds its newest child with `END(full)`. It reports `child-shed` (`reason: 'congested'`) and refuses new children until backpressure clears.

### 4.3 Failover State Machine (Viewer)

1. **On `REDIRECT`:** If `parentPeerId` is in `failedParents` (within `parentFailBackoffMs`) or `redirectCount >= maxRedirects`, skip dialing `parentPeerId` and send direct-only `WATCH` (`{ v: 1, shareId }`) to `sharerPeerId`.
2. **Dialing parent:** Increment `redirectCount`, dial `/asscrack/screen-fanout/1.0.0` to `parentPeerId`, and send `OPEN`. If dial fails, `END(refused|full|error|lost)` arrives before `CONFIG`, or `fanoutOpenTimeoutMs` expires: record `failedParents.set(parentPeerId, now + parentFailBackoffMs)` and retry `WATCH` to `sharerPeerId` (with `fanout: 1` if `redirectCount < maxRedirects`, else direct-only `{ v: 1, shareId }`).
3. **Sharer retry handling:** The sharer may receive a retry `WATCH` while a previous `REDIRECT` to `P` is unconfirmed (within `parentFailBackoffMs`). It then records `(viewer, P)` failed for `parentFailBackoffMs` and picks another eligible parent or serves directly.
4. **Mid-watch parent loss:** If `END` or stream close occurs mid-watch and `sharerPeerId` no longer advertises `shareId`, emit `screen-ended` and stop. Otherwise record `failedParents.set(parentPeerId, now + parentFailBackoffMs)`, reset `redirectCount = 0`, wait `0..250` ms jitter, and re-watch `sharerPeerId`.

---

## 5. Companion Screen Audio and Audio-Mute Rule

- **Decision:** A forwarder keeps pulling upstream `/asscrack/screen-audio/1.0.0` while it has `>= 1` active audio child.
- **Local mute, volume 0, or deafen behavior:**
  - With `0` active audio children, the forwarder closes its upstream `/asscrack/screen-audio/1.0.0` stream (existing bandwidth-saving behavior).
  - With `>= 1` active audio children, the forwarder keeps its upstream `/asscrack/screen-audio/1.0.0` stream open. It suppresses local playback to its renderer and forwards raw Opus `AUDIO` records verbatim to its audio children. When the last audio child leaves, the forwarder closes the upstream audio stream.
- **On-demand upstream open:** A locally muted forwarder (with upstream audio closed) may receive `LISTEN` from an active video child. It then opens `/asscrack/screen-audio/1.0.0` upstream (to its own parent or sharer) and forwards `AUDIO` packets. If upstream audio fails to open within `listenRecordMs` (5000 ms), it replies `END(error)` and the child may fall back to opening `/asscrack/screen-audio/1.0.0` directly to `sharerPeerId`.
- **Audio authorization on forwarders:** A forwarder accepts `/asscrack/screen-audio/1.0.0` `LISTEN` only from an active child on its `/asscrack/screen-fanout/1.0.0` stream for the same `shareId`. No separate audio token is needed.

---

## 6. 24-Viewer Limit Changes and Global Cross-Share Slot Accounting

| File | Parameter | Old | New | Notes |
|---|---|---|---|---|
| `src/network/screen-share.mjs` | `SCREEN_DEFAULTS.maxViewers` | `6` | `24` | Total tree viewers per share |
| `src/network/screen-share.mjs` | `SCREEN_DEFAULTS.opensPerRoom` | `48` | `192` | Per minute (`opensPerPeer` stays `12`) |
| `src/network/screen-share.mjs` | `reportsPerPeer` / `reportsPerRoom` | — | `60` / `300` | Per minute for `screen-fanout` lines |
| `src/network/screen-audio.mjs` | `SCREEN_AUDIO_DEFAULTS.maxListeners` | `6` | `24` | Audio listeners per share |
| `src/network/screen-audio.mjs` | `SCREEN_AUDIO_DEFAULTS.opensPerRoom` | `48` | `192` | Per minute (`opensPerPeer` stays `12`) |
| `src/network/node.mjs` | `SCREEN_PROTOCOL` streams | `8` in / `2` out | `32` in / `4` out | Inbound / outbound per peer |
| `src/network/node.mjs` | `SCREEN_AUDIO_PROTOCOL` streams | `8` in / `2` out | `32` in / `4` out | Inbound / outbound per peer |
| `src/network/node.mjs` | `SCREEN_FANOUT_PROTOCOL` streams | — | `16` in / `4` out | `runOnTransientConnection: false` |
| `src/network/node.mjs` | `circuitRelayServer` limits | `15` res / `16` in / `32` out | `25` res / `32` in / `64` out | Relay reservations and hop streams |

### Global Cross-Share Slot Accounting (`maxShares = 3`)

- Each node has one global forwarding cap `globalMaxChildren` (default `2`, user range `0..8`, where `0` disables forwarding).
- **Own-share priority rule:** While a peer shares its own screen (`own !== null`), it advertises `maxChildren: 0` in `WATCH` for other shares. Its uplink serves its own share first.
- **Global counter:** `activeForwardedChildren` sums active `/asscrack/screen-fanout/1.0.0` children across all shares. This is at most 1 watched share in Phase 1. It scales up to `maxShares = 3` once Session 7 adds non-watching hubs. `WATCH` advertises `available = own ? 0 : Math.max(0, globalMaxChildren - activeForwardedChildren)`. Incoming `OPEN` rejects with `END(full)` if `activeForwardedChildren >= globalMaxChildren`.

---

## 7. Implementation Roadmap (Sessions 1 to 7)

1. **Session 1 — Spec Contract (`docs/SCREENSHARE_FANOUT.md`):** Lock wire schemas, `'mesh'`-only Phase 1 links, audio-mute rule, 24-viewer limits, and global slot accounting.
2. **Session 2 — Tree Coordinator (`src/network/screen-fanout.mjs`):** Pure, unit-testable tree planner (breadth-first placement, `'mesh'` route awareness, loop prevention, slot/congestion shedding, reparenting).
3. **Session 3 — Network Forwarding Streams:** Wire `REDIRECT` and verified tokens into `screen-share.mjs`, add `/asscrack/screen-fanout/1.0.0` in `node.mjs`, and add multi-node `127.0.0.1` tests.
4. **Session 4 — 24-Viewer Limits and Failover:** Raise limits in `screen-share.mjs`, `screen-audio.mjs`, and `node.mjs`, and test failover and 1.0.6 backwards compatibility.
5. **Session 5 — Companion Audio Fanout:** Implement forwarder audio relay and on-demand upstream open in `screen-audio.mjs`.
6. **Session 6 — Settings and UI Visibility:** Forwarding cap/opt-out setting, Network Map forwarding edges, stage `"via <peer>"` indicator, and Peer Inspector stats.
7. **Session 7 — Non-Watching Hubs and User Consent:** Opt-in Settings toggle, `HUB_OFFER` / `HUB_ACCEPT` / `HUB_STOP` handshake, and cross-share slot sharing.
8. **Phase 2 — Direct NAT Traversal:** Integrate libp2p DCUtR or hole-punching so NAT viewers can form direct forwarding links without a hub.
