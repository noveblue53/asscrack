// Only edit-driven updates go on the current sessions. A session opened during a pause gets no snapshot.
export function createTyping({ broadcast, snapshot, changed, now = () => performance.now(), setTimer = setTimeout, cancel = clearTimeout }) {
    let lastSent = -Infinity
    let active = false
    let stopped = false
    let pendingTimer = null
    let pendingAudience = null
    const remote = new Map()

    function cancelPending() {
        if (pendingTimer !== null) cancel(pendingTimer)
        pendingTimer = null
        pendingAudience = null
    }

    function announce(audience) {
        if (broadcast(true, audience)) {
            lastSent = now()
            active = true
        }
    }

    function edited(on) {
        if (stopped) return
        if (!on) {
            cancelPending()
            if (active) broadcast(false)
            active = false
            return
        }
        const remaining = 3000 - (now() - lastSent)
        if (remaining <= 0) {
            cancelPending()
            announce()
        } else if (!active) {
            // A short second draft may have only one edit. Coalesce it, keeping only sessions open at an edit.
            pendingAudience = snapshot()
            if (pendingTimer === null) {
                pendingTimer = setTimer(() => {
                    const audience = pendingAudience
                    cancelPending()
                    announce(audience)
                }, remaining)
            }
        }
    }

    function remove(peerId) {
        if (!remote.has(peerId)) return
        cancel(remote.get(peerId))
        remote.delete(peerId)
        changed(peerId, false)
    }

    function received(peerId, on) {
        if (stopped) return
        if (!on) return remove(peerId)
        if (remote.has(peerId)) cancel(remote.get(peerId))
        else changed(peerId, true)
        remote.set(peerId, setTimer(() => remove(peerId), 6000))
    }

    function disconnected() {
        cancelPending()
        active = false
        lastSent = -Infinity
    }

    function stop() {
        stopped = true
        disconnected()
        for (const timer of remote.values()) cancel(timer)
        remote.clear()
    }

    return { edited, received, remove, disconnected, stop }
}
