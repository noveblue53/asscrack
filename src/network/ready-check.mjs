// Ready check (milestone 9). One live check for the room: "<name> asks: <text>" with the votes 'ready' and 'minute'.
// The line on the chat session: { type: 'ready', v: 1, op: 'open' | 'vote' | 'close', id, text, vote }.
// - The voter of a 'vote' line and the initiator of an 'open' or 'close' line is the peer of the session, never a
//   field of the line. Two people with the same name are two peer IDs, thus two votes.
// - Each node sends its own lines to each new session: the initiator its open check (or the close line of its last
//   closed check), each voter its own votes. A late joiner thus gets the check and the votes.
// - The state is for the session only: no history, no archive, no disk.
// - The IDs of closed, replaced and expired checks stay for the life of the node: such a check never shows again.
// Pure: the clock, the timers, the rate limit and the send functions are parameters.
export const READY_TEXT_MAX = 120
export const READY_DEFAULT_TEXT = 'Ready?'
export const READY_VOTES = Object.freeze(['ready', 'minute'])
// A closed check shows its result for this time, then it goes away.
export const READY_RESULT_MS = 10000
// The grey time of G2: an initiator that went with no bye line and does not come back in this time ends its check.
// The same time starts when a new session of the initiator opens: its open line must come again in this time.
export const READY_GRACE_MS = 10000
// Votes for a check that is not known yet (the vote came before the open line): kept for this time, at most
// PENDING_MAX of them.
export const READY_PENDING_MS = 30000
const PENDING_MAX = 256
const CLOSED_MAX = 20000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f' + String.fromCharCode(0x2028, 0x2029) + ']', 'u')

// The text of an open line: trimmed, 0 to 120 code points, no control characters. Empty gives "Ready?".
// Returns null when the text is not valid.
export function readyText(text) {
    if (text === undefined || text === null) return READY_DEFAULT_TEXT
    if (typeof text !== 'string' || text.length > READY_TEXT_MAX * 4) return null
    const trimmed = text.trim()
    if ([...trimmed].length > READY_TEXT_MAX || CONTROL.test(trimmed)) return null
    return trimmed || READY_DEFAULT_TEXT
}

// Returns the valid line as { op, id, text?, vote? }, or null for a line that is not valid.
export function parseReadyLine(m) {
    if (!m || m.type !== 'ready' || m.v !== 1 || typeof m.id !== 'string' || !UUID.test(m.id)) return null
    const id = m.id.toLowerCase()
    if (m.op === 'open') {
        const text = readyText(m.text ?? '')
        return text === null ? null : { op: 'open', id, text }
    }
    if (m.op === 'vote') return READY_VOTES.includes(m.vote) ? { op: 'vote', id, vote: m.vote } : null
    if (m.op === 'close') return { op: 'close', id }
    return null
}

// options: selfId; peers() gives the peer IDs with an open session; send(peerId, line) and broadcast(line) send an
// object line; changed(view) gets each new view; allow(peerId) is the rate limit of one peer (false: drop the line);
// newId() gives a UUID; now(), setTimer(fn, ms) and clearTimer(handle) are the clock.
export function createReadyCheck({ selfId, peers = () => [], send, broadcast, changed = () => {},
    allow = () => true, newId = () => globalThis.crypto.randomUUID(),
    now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    // initiator peer ID -> { id, from, text, open, votes: Map(peerId -> vote), openedAt, closedAt }
    // One check for each initiator: an open one, or a closed one that shows its result.
    const checks = new Map()
    const closed = new Set() // `${initiator}|${id}`
    const pending = new Map() // `${voter}|${id}` -> { voter, id, vote, at }
    const resultTimers = new Map() // initiator -> timer of the result time
    const graceTimers = new Map() // initiator -> timer of the grace time
    let lastClosedId = null // the last own check that closed: the close line goes to each new session
    let stopped = false

    const key = (from, id) => `${from}|${id}`
    const line = (op, id, extra = {}) => ({ type: 'ready', v: 1, op, id, ...extra })

    function view() {
        const list = [...checks.values()].map(c => ({
            id: c.id, from: c.from, text: c.text, open: c.open, mine: c.from === selfId,
            votes: Object.fromEntries(c.votes), openedAt: c.openedAt, closedAt: c.closedAt
        }))
        list.sort((a, b) => a.openedAt - b.openedAt)
        return { self: selfId, people: [selfId, ...peers().filter(p => p !== selfId)], checks: list }
    }

    const emit = () => { if (!stopped) changed(view()) }

    function markClosed(from, id) {
        closed.add(key(from, id))
        if (closed.size > CLOSED_MAX) closed.delete(closed.values().next().value)
    }

    function clearTimers(from) {
        clearTimer(resultTimers.get(from))
        resultTimers.delete(from)
        clearTimer(graceTimers.get(from))
        graceTimers.delete(from)
    }

    // Remove the check of this initiator now (replaced or expired). Returns true when there was one.
    function drop(from) {
        const check = checks.get(from)
        if (!check) return false
        markClosed(from, check.id)
        clearTimers(from)
        checks.delete(from)
        return true
    }

    function closeCheck(check) {
        check.open = false
        check.closedAt = now()
        markClosed(check.from, check.id)
        clearTimers(check.from)
        resultTimers.set(check.from, setTimer(() => {
            resultTimers.delete(check.from)
            if (checks.get(check.from) === check) {
                checks.delete(check.from)
                emit()
            }
        }, READY_RESULT_MS))
    }

    function prunePending() {
        const limit = now() - READY_PENDING_MS
        for (const [k, p] of pending) if (p.at < limit) pending.delete(k)
    }

    function startCheck(from, id, text) {
        drop(from)
        const check = { id, from, text, open: true, votes: new Map(), openedAt: now(), closedAt: null }
        prunePending()
        for (const [k, p] of pending) {
            if (p.id === id) {
                check.votes.set(p.voter, p.vote)
                pending.delete(k)
            }
        }
        checks.set(from, check)
        return check
    }

    function graceTimer(from) {
        clearTimer(graceTimers.get(from))
        graceTimers.set(from, setTimer(() => {
            graceTimers.delete(from)
            if (checks.get(from)?.open && drop(from)) emit()
        }, READY_GRACE_MS))
    }

    function findOpen(id) {
        for (const check of checks.values()) if (check.open && check.id === id) return check
        return null
    }

    // A valid ready line from the peer of an open session.
    function handle(peerId, control) {
        if (stopped || typeof peerId !== 'string' || peerId === selfId) return
        const m = parseReadyLine(control)
        if (!m || !allow(peerId)) return
        if (m.op === 'open') {
            if (closed.has(key(peerId, m.id))) return
            const current = checks.get(peerId)
            if (current?.id === m.id) {
                // The same check again (a new session): it is confirmed. The text does not change.
                clearTimer(graceTimers.get(peerId))
                graceTimers.delete(peerId)
                return
            }
            startCheck(peerId, m.id, m.text)
            emit()
        } else if (m.op === 'close') {
            const current = checks.get(peerId)
            if (current?.id === m.id && current.open) {
                closeCheck(current)
                emit()
            } else if (current?.id !== m.id) markClosed(peerId, m.id)
        } else {
            const check = findOpen(m.id)
            if (check) {
                if (check.votes.get(peerId) === m.vote) return
                check.votes.set(peerId, m.vote)
                emit()
            } else if (![...checks.values()].some(c => c.id === m.id)) {
                prunePending()
                pending.set(key(peerId, m.id), { voter: peerId, id: m.id, vote: m.vote, at: now() })
                if (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value)
            }
        }
    }

    // A new session to this peer. Send the own lines. An open check of this peer must come again in the grace time.
    function opened(peerId) {
        if (stopped) return
        const own = checks.get(selfId)
        if (own?.open) send(peerId, line('open', own.id, { text: own.text }))
        else if (lastClosedId) send(peerId, line('close', lastClosedId))
        for (const check of checks.values()) {
            const vote = check.open ? check.votes.get(selfId) : undefined
            if (vote) send(peerId, line('vote', check.id, { vote }))
        }
        if (checks.get(peerId)?.open) graceTimer(peerId)
        if (checks.size) emit()
    }

    // The session of this peer closed. bye: true when the peer sent a bye line (it quit).
    function left(peerId, bye) {
        if (stopped) return
        let change = false
        for (const check of checks.values()) if (check.votes.delete(peerId)) change = true
        const check = checks.get(peerId)
        if (check?.open) {
            if (bye) change = drop(peerId) || change
            else graceTimer(peerId)
        }
        if (change || checks.size) emit()
    }

    function open(text) {
        if (stopped) throw new Error('The node is stopped')
        const value = readyText(text ?? '')
        if (value === null) throw new TypeError(`The text of a ready check has 0 to ${READY_TEXT_MAX} characters`)
        const id = String(newId()).toLowerCase()
        if (!UUID.test(id)) throw new Error('No check ID')
        startCheck(selfId, id, value)
        broadcast(line('open', id, { text: value }))
        emit()
        return view()
    }

    function vote(id, value) {
        if (!READY_VOTES.includes(value)) throw new TypeError('The vote is "ready" or "minute"')
        const check = typeof id === 'string' ? findOpen(id.toLowerCase()) : null
        if (!check) throw new Error('This ready check is not open')
        if (check.votes.get(selfId) !== value) {
            check.votes.set(selfId, value)
            broadcast(line('vote', check.id, { vote: value }))
            emit()
        }
        return view()
    }

    function close(id) {
        const check = checks.get(selfId)
        if (!check || !check.open || (id !== undefined && check.id !== String(id).toLowerCase())) {
            throw new Error('You have no open ready check')
        }
        closeCheck(check)
        lastClosedId = check.id
        broadcast(line('close', check.id))
        emit()
        return view()
    }

    // Remove all checks and votes (the closed IDs stay). G5 leaveRoom() and stop() call it.
    function reset() {
        for (const from of new Set([...checks.keys(), ...resultTimers.keys(), ...graceTimers.keys()])) clearTimers(from)
        for (const check of checks.values()) markClosed(check.from, check.id)
        checks.clear()
        pending.clear()
        emit()
    }

    function stop() {
        reset()
        stopped = true
    }

    return { handle, opened, left, open, vote, close, state: view, reset, stop }
}
