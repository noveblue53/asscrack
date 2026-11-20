// Only edit-driven updates go on the current sessions. A session opened during a pause gets no snapshot.
export function createTyping({ broadcast, changed, now = () => performance.now(), setTimer = setTimeout, cancel = clearTimeout }) {
    let lastSent = -Infinity
    let active = false
    const remote = new Map()

    function edited(on) {
        if (on) {
            if (now() - lastSent < 3000) return
            if (broadcast(true)) {
                lastSent = now()
                active = true
            }
        } else if (active) {
            active = false
            broadcast(false)
        }
    }

    function remove(peerId) {
        if (!remote.has(peerId)) return
        cancel(remote.get(peerId))
        remote.delete(peerId)
        changed(peerId, false)
    }

    function received(peerId, on) {
        if (!on) return remove(peerId)
        if (remote.has(peerId)) cancel(remote.get(peerId))
        else changed(peerId, true)
        remote.set(peerId, setTimer(() => remove(peerId), 6000))
    }

    function disconnected() {
        active = false
        lastSent = -Infinity
    }

    function stop() {
        disconnected()
        for (const timer of remote.values()) cancel(timer)
        remote.clear()
    }

    return { edited, received, remove, disconnected, stop }
}
