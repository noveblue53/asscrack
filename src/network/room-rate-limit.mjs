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
