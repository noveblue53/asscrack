// Host election with heartbeats. The rules are in
// work-orders/voice-failover-20261117/briefs/step1.md ("The election rules").
// Rule 6: A member that loses its last session clears its host and waits.
// After a session reopens, rule 4 gives the group time to announce its live
// host before a new election. An incumbent host keeps its role.
// This module has no network code. node.mjs gives it these functions:
//   sendTo(peerId, line)  send one control line on one session
//   broadcast(line)       send one control line on all sessions
//   openPeers()           the peer IDs with an open session
//   onChange({ peerId, term })  called when host or term changes
//   isFullNode(peerId)    true when that peer accepts incoming TCP; the rank puts full nodes first, then the lower peer ID
export function createElection({
    selfId,
    sendTo,
    broadcast,
    openPeers,
    onChange = () => {},
    isFullNode = () => false,
    heartbeatInterval = 1000,
    hostTimeout = 5000,
    electionDelay = 3000,
    now = () => Date.now()
}) {
    let host = null
    let term = 0
    let lastHeartbeat = 0
    let lost = false          // the current host is lost (rules 5 and 6)
    let candidate = null      // the peer that we wait for (rules 4 and 6)
    let candidateDeadline = 0
    let firstSessionTime = null // time when the first session opened (rule 4)
    let paused = false
    let stopped = false
    const suspected = new Set()
    let delayTimer = null
    let tickTimer = null

    const isHost = () => host === selfId
    const announcement = () => JSON.stringify({ type: 'host', host, term })

    function setHost(h, t) {
        const changed = h !== host || t !== term
        host = h
        term = t
        lastHeartbeat = now()
        lost = false
        candidate = null
        if (changed) onChange({ peerId: host, term })
    }

    function becomeHost() {
        setHost(selfId, term + 1)
        broadcast(announcement())
    }

    // Rank: a full node comes before a node that is not a full node.
    // Inside each group, the lower peer ID comes first.
    function lowest(ids) {
        let best = null
        let bestFull = false
        for (const id of ids) {
            const full = Boolean(isFullNode(id))
            if (best === null || (full && !bestFull) || (full === bestFull && id < best)) {
                best = id
                bestFull = full
            }
        }
        return best
    }

    // Rule 4. A node with no session never elects itself. The first election
    // waits electionDelay after the first session opens.
    function firstElection() {
        if (host !== null || firstSessionTime === null) return
        if (now() - firstSessionTime < electionDelay) return
        const target = lowest([selfId, ...openPeers()])
        if (target === selfId) becomeHost()
    }

    // Rule 6.
    function elect() {
        const target = lowest([selfId, ...openPeers()].filter(id => !suspected.has(id)))
        if (target === selfId) {
            becomeHost()
            return
        }
        candidate = target
        candidateDeadline = now() + hostTimeout
    }

    // Rule 5.
    function hostLost() {
        if (lost || isHost() || host === null) return
        lost = true
        suspected.add(host)
        elect()
    }

    function tick() {
        if (stopped) return
        if (isHost()) {
            // Rule 2.
            if (!paused) broadcast(announcement())
        } else if (host !== null) {
            if (lost) {
                if (candidate !== null && now() > candidateDeadline) {
                    suspected.add(candidate)
                    elect()
                }
            } else if (now() - lastHeartbeat > hostTimeout) {
                hostLost()
            }
        } else {
            firstElection()
        }
    }

    return {
        start() {
            if (stopped || tickTimer) return
            tickTimer = setInterval(tick, heartbeatInterval)
        },
        // A control line with type "host".
        handleAnnouncement(fromPeerId, message) {
            if (stopped) return
            const { host: h, term: t } = message
            if (typeof h !== 'string' || !Number.isInteger(t)) return
            // Rule 7.
            suspected.delete(fromPeerId)
            suspected.delete(h)
            // Rule 1. Rule 8: a host that accepts is no longer host, so tick() stops its heartbeats.
            if (h === host && t === term) {
                lastHeartbeat = now()
                lost = false
                candidate = null
                return
            }
            if (host === null || t > term || (t === term && h < host)) setHost(h, t)
        },
        sessionOpened(peerId) {
            if (stopped) return
            suspected.delete(peerId) // rule 7
            // Rule 3, extended: each member that knows a live host sends the
            // announcement of that host on the new session.
            if (host !== null && !lost) sendTo(peerId, announcement())
            if (firstSessionTime === null) {
                firstSessionTime = now()
                delayTimer = setTimeout(() => {
                    delayTimer = null
                    if (!stopped) firstElection()
                }, electionDelay)
            }
        },
        sessionClosed(peerId) {
            if (stopped) return
            if (!isHost() && openPeers().length === 0) {
                clearTimeout(delayTimer)
                delayTimer = null
                firstSessionTime = null
                setHost(null, term)
                return
            }
            if (peerId === host) hostLost() // rule 5
        },
        pauseHeartbeats(value) {
            paused = Boolean(value)
        },
        host: () => (host === null ? null : { peerId: host, term }),
        isHost,
        stop() {
            stopped = true
            if (tickTimer) clearInterval(tickTimer)
            if (delayTimer) clearTimeout(delayTimer)
            tickTimer = null
            delayTimer = null
        }
    }
}
