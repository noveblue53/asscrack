export function roomRateLimit(perPeer, perRoom, periodMs = 60000) {
    const peers = new Map()
    let start = Date.now()
    let total = 0
    return peer => {
        const now = Date.now()
        if (now < start || now - start >= periodMs) {
            start = now
            total = 0
            peers.clear()
        }
        const count = peers.get(peer) ?? 0
        if (count >= perPeer || total >= perRoom) return false
        peers.set(peer, count + 1)
        total++
        return true
    }
}

// L12 (P10b): a limit of the failed checks of each peer in one period. allowed(peer) does not count. failed(peer)
// counts one failure. A peer with no failure is never limited, thus a valid line always gets its check.
export function peerFailureLimit(perPeer, periodMs = 60000) {
    const peers = new Map()
    let start = Date.now()
    const window = () => {
        const now = Date.now()
        if (now < start || now - start >= periodMs) {
            start = now
            peers.clear()
        }
    }
    return {
        allowed(peer) {
            window()
            return (peers.get(peer) ?? 0) < perPeer
        },
        failed(peer) {
            window()
            peers.set(peer, (peers.get(peer) ?? 0) + 1)
        }
    }
}
