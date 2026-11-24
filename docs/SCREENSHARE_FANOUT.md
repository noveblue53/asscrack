# Peer-Assisted Screen Share Fanout (Design Spec)

## Problem Statement

Today, ASSCRACK screen sharing (`src/network/screen-share.mjs`, `src/network/screen-rate.mjs`, `src/network/screen-audio.mjs`) uses a **star topology** centered on the sharer:

- Every viewer opens `/asscrack/screen/1.0.0` (and optionally `/asscrack/screen-audio/1.0.0`) directly to the sharer.
- Total sharer upload scales linearly as `N_viewers × bitrate`.
- On a typical asymmetric home connection (e.g. **20 Mbps up / 500 Mbps down**):
  - 1 viewer at Max (12 Mbps) fits comfortably.
  - 2 viewers (24 Mbps) exceed the sharer's uplink and throttle down.
  - 5 viewers drop below 4 Mbps each.
- Behind a circuit relay (`/p2p-circuit`), the sharer currently uploads `N` duplicate copies *through* the relay, burning `N × bitrate` on both the sharer's uplink and the relay's down/up links (capped at `relayLimit = 6 Mbps` split across `N` viewers).

Meanwhile, every viewer only uses a small fraction of their download bandwidth (~12 Mbps out of 500 Mbps) while their **upload** bandwidth (~15–20 Mbps) sits completely idle.

## Goals

1. **Redistribute upload load across the room** so no single peer hits their upload cap while delivering high-bitrate streams to multiple viewers.
2. **Eliminate duplicate relay uploads** by letting reachable full nodes act as fanout hubs (1 upload from sharer → hub → `N` viewers).
3. **Keep latency low** for small friend groups while scaling gracefully to larger rooms (up to **24 viewers**).
4. **Zero re-encoding on forwarders:** Forward raw, already-encoded VP8 video frames and Opus screen-audio packets (~0% CPU overhead).
5. **100% backwards-compatible** with 1.0.1–1.0.6 peers.
6. **Modular tree coordinator:** Focus on screen share (video + screen audio) first, while keeping the tree/capacity coordinator modular so other room streams could reuse it later.

---

## Architecture: Hybrid Route-Aware Fanout Tree

### 1. Topology & Dynamic Breadth-First Depth

- **Hybrid Hub + Viewer Tree:**
  - **High-upload / full-node peers** can act as **fanout hubs** even when they are not actively watching the screen (e.g. a friend with symmetric fiber or the reachable room host). When a NAT'd sharer has relayed viewers, sending 1 copy to the hub immediately eliminates `N`-way relay duplication.
  - **Active viewers** automatically forward raw frames to other viewers by default (zero extra download cost, zero extra privacy exposure since all admitted room members can already view room shares).
- **Breadth-First Adaptive Depth:**
  - Fill **depth 1** up to the sharer's comfortable upload budget.
  - Distribute **depth 2** evenly across all depth-1 nodes (round-robin / least-loaded first so every node plays an equal role rather than overloading one peer).
  - Expand to **depth 3–4** only when earlier layers are saturated.
  - Result: 2–6 viewer rooms stay at **1–2 hops** (~20–50 ms added latency), while 10–24 viewer rooms scale smoothly without hitting a wall.

### 2. Route-Aware Placement (Phased Rollout)

- **Phase 1 — Route-Aware Tree over Existing Direct Links & Full-Node Hubs:**
  - Never assign a forwarding parent whose link to the child bounces back through the same circuit relay (which would waste both peers' upload and the relay's bandwidth).
  - Prefer direct (`circuit === false`) parent→child links; when viewers are NAT'd behind a shared full node, place the full node as a depth-1 hub.
  - Zero new transport dependencies or NAT-traversal risk.
- **Phase 2 — Direct NAT-to-NAT Reachability:**
  - Plug in libp2p **DCUtR / hole-punching** (and/or optional viewer UPnP) so NAT'd viewers can establish direct peer-to-peer links to each other, unlocking viewer-to-viewer cascading even when no high-upload hub is present.

### 3. Sharer-Coordinated Control & Wire Protocol

- **Sharer owns the tree:**
  - Viewers advertise capabilities in `WATCH`: `{ v: 1, shareId, fanout: true, maxChildren, directPeers: [...] }`.
  - The sharer assigns each viewer either:
    - **Direct:** sends `CONFIG` + `FRAME` as today, OR
    - **Redirected:** sends a `REDIRECT` control record `{ v: 1, shareId, parentPeerId, hop, token }` and closes the direct data stream.
  - Strictly increasing `hop` (`0 = sharer, 1 = direct child, 2 = grandchild, ...`) mathematically guarantees **zero forwarding loops**.
- **Forwarding stream (`/asscrack/screen-fanout/1.0.0` + audio fanout):**
  - Child opens `/asscrack/screen-fanout/1.0.0` to `parentPeerId` with `{ v: 1, shareId, hop }`.
  - Parent verifies `allowed(childPeerId)`, `shareId`, and available slot, caches the latest `CONFIG` + forwards incoming `FRAME` records verbatim.
  - When a child joins or needs recovery, `KEYREQ` propagates up the tree to the sharer (rate-limited at each hop).
  - Companion screen audio (`/asscrack/screen-audio/1.0.0`) follows the same parent assignment (and still closes when the viewer is muted, volume = 0, or deafened to save bandwidth).
- **Backwards Compatibility:**
  - 1.0.1–1.0.6 viewers omit `fanout: true` in `WATCH` and are served directly by the sharer with zero protocol changes.

### 4. Quality Tiers, Capacity Protection & Failover

- **Quality Tiers (`screen-rate.mjs`):**
  - Forwarders forward only the tier they receive (zero transcoding).
  - Slow grandchildren are moved to the sharer's `slow` tier (or a slow-tier parent) so they never drag down `fast`-tier viewers.
- **Auto-Adaptive Forwarding Capacity & Voice Protection:**
  - Each peer starts with a safe default forwarding budget (e.g. 1–2 children for typical viewers, higher for high-upload hubs).
  - If a forwarder detects sustained send-queue backpressure or voice-queue growth, it signals `CONGESTED` / sheds a child back to the sharer so forwarding **never degrades the peer's own voice or gameplay**.
  - Users can configure a custom forwarding upload cap or disable forwarding entirely in **Settings** (e.g. for metered/hotspot connections).
- **Seamless Failover:**
  - If a forwarding parent stops watching, disconnects, or sheds a child, the child immediately contacts the sharer for a new parent assignment (or direct fallback) and requests a keyframe for fast recovery.

### 5. Viewer Limit & UI Visibility

- **Viewer limit:** Raise `maxViewers` from `6` to `24` (bounded by aggregate tree capacity).
- **Network Map (`src/application/nodemap.js`):** Render active screen-share forwarding edges (`Sharer → Hub/Viewer → Viewer`).
- **Stage & Peer Inspector (`screen-view.js`, `peer-inspector.js`):**
  - Show `"via <peer>"` in `#screen-stage-info` when watching through a forwarder.
  - Show forwarded child count (e.g. `"Forwarding to 2"`) in the Peer Inspector.

---

## Implementation Phases

1. **Phase 1a — Tree Coordinator (`src/network/screen-fanout.mjs`):** Pure, unit-testable tree planner (breadth-first placement, route awareness, loop prevention, slot/congestion shedding, reparenting).
2. **Phase 1b — Network Forwarding Streams:** Wire `REDIRECT` into `screen-share.mjs`, add `/asscrack/screen-fanout/1.0.0` (and screen-audio forwarding), raise `maxViewers` to 24, and add multi-node 127.0.0.1 tests (including failover and 1.0.6 backwards compatibility).
3. **Phase 1c — Settings & UI Visibility:** Forwarding cap/opt-out setting, Network Map forwarding links, stage `"via <peer>"` indicator, and Peer Inspector stats.
4. **Phase 2 — Direct NAT Traversal:** Integrate libp2p DCUtR / hole-punching so NAT'd viewers can form direct forwarding links without a hub.
