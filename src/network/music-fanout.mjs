// Pure tree coordinator and Opus frame forwarder for peer-assisted room music fanout.
// Zero libp2p dependencies and zero timers: callers supply `now` and `getTopology`.

export const MUSIC_FANOUT_DEFAULTS = Object.freeze({
    maxHop: 3, // 0 = DJ, 1 = direct child, 2 = grandchild, 3 = great-grandchild
    maxListeners: 24,
    maxDirectListeners: 2,
    maxRedirects: 3,
    maxChildrenPerNode: 6,
    defaultMaxChildren: 2,
    redirectConfirmMs: 8000,
    parentFailBackoffMs: 30000,
    maxChildQueueFrames: 50,
    dedupWindow: 64
})

function clampInt(value, min, max, fallback = min) {
    if (!Number.isInteger(value)) return fallback
    return Math.max(min, Math.min(max, value))
}

function isIdlePeer(topo, peerId) {
    const idle = topo?.idlePeers
    if (!idle) return false
    if (typeof idle.has === 'function') return idle.has(peerId)
    if (Array.isArray(idle)) return idle.includes(peerId)
    return false
}

function hasSymmetricMesh(topo, parentId, childId) {
    if (!topo || parentId === childId) return true
    if (isIdlePeer(topo, parentId) || isIdlePeer(topo, childId)) return false
    const kinds = topo.kinds ?? topo.linkKinds
    if (kinds) {
        if (kinds?.[parentId]?.[childId] !== 'mesh' || kinds?.[childId]?.[parentId] !== 'mesh') return false
    }
    if (Array.isArray(topo.links?.[parentId]) && !topo.links[parentId].includes(childId)) return false
    if (Array.isArray(topo.links?.[childId]) && !topo.links[childId].includes(parentId)) return false
    return true
}

function meshDegree(topo, peerId) {
    const kinds = topo?.kinds ?? topo?.linkKinds
    const row = kinds?.[peerId]
    if (!row || typeof row !== 'object') return 0
    let count = 0
    for (const otherId of Object.keys(row)) {
        if (hasSymmetricMesh(topo, peerId, otherId)) count++
    }
    return count
}

/**
 * Create a DJ-side pure tree coordinator for room music fanout.
 */
export function createMusicFanout({
    djPeerId,
    channelId = 'general',
    now = Date.now,
    getTopology = () => null,
    ...options
} = {}) {
    if (typeof djPeerId !== 'string' || !djPeerId) {
        throw new TypeError('djPeerId must be a non-empty string')
    }
    if (typeof now !== 'function') {
        throw new TypeError('now must be a function')
    }

    const nestedOptions = options.options && typeof options.options === 'object' ? options.options : {}
    const restOptions = { ...options }
    delete restOptions.options
    const O = { ...MUSIC_FANOUT_DEFAULTS, ...nestedOptions, ...restOptions }

    // Active listener nodes: peerId -> { peerId, parentPeerId, hop, capable, maxChildren, children, pendingChildren }
    const nodes = new Map()
    // Pending redirects: childPeerId -> { childPeerId, parentPeerId, hop, tokenSeq, capable, maxChildren, expiresAt }
    const pending = new Map()
    // Failed (child, parent) pairs: `${childId}\n${parentId}` -> expiresAt
    const probation = new Map()
    // Consecutive redirect attempts per listener during join
    const redirectAttempts = new Map()
    // Explicit per-peer forwarding cap overrides (e.g. opt-out or Idle Peer cap = 0)
    const explicitCaps = new Map()
    let tokenSeq = 0

    const probationKey = (childId, parentId) => `${childId}\n${parentId}`

    function pruneExpired() {
        const t = now()
        for (const [childId, entry] of pending) {
            if (t >= entry.expiresAt) {
                pending.delete(childId)
                const parent = nodes.get(entry.parentPeerId)
                parent?.pendingChildren.delete(childId)
            }
        }
        for (const [key, until] of probation) {
            if (t >= until) probation.delete(key)
        }
    }

    function isProbation(childId, parentId) {
        const until = probation.get(probationKey(childId, parentId))
        return until !== undefined && now() < until
    }

    function setProbation(childId, parentId, durationMs = O.parentFailBackoffMs) {
        if (!childId || !parentId || parentId === djPeerId) return
        probation.set(probationKey(childId, parentId), now() + durationMs)
    }

    function isDescendant(candidateId, ancestorId) {
        if (candidateId === ancestorId) return true
        const visited = new Set()
        let cur = candidateId
        while (cur && cur !== djPeerId) {
            if (visited.has(cur)) return true
            visited.add(cur)
            const node = nodes.get(cur)
            if (!node) break
            if (node.parentPeerId === ancestorId) return true
            cur = node.parentPeerId
        }
        return false
    }

    function effectiveAvailableSlots(parentNode) {
        if (!parentNode.capable) return 0
        const load = parentNode.children.size + parentNode.pendingChildren.size
        return Math.max(0, parentNode.maxChildren - load)
    }

    function clearPendingForChild(childId) {
        const entry = pending.get(childId)
        if (!entry) return null
        pending.delete(childId)
        const parent = nodes.get(entry.parentPeerId)
        parent?.pendingChildren.delete(childId)
        return entry
    }

    // Detaches `rootId` and all of its descendants in BFS order. Returns orphaned descendants (excluding `rootId`).
    function detachSubtree(rootId) {
        const root = nodes.get(rootId)
        if (!root) return []
        const parent = root.parentPeerId !== djPeerId ? nodes.get(root.parentPeerId) : null
        if (parent) parent.children.delete(rootId)

        const orphaned = []
        const queue = [...root.children]
        for (const pChild of root.pendingChildren) {
            const pEntry = pending.get(pChild)
            if (pEntry && pEntry.parentPeerId === rootId) {
                pending.delete(pChild)
                setProbation(pChild, rootId)
                orphaned.push(pChild)
            }
        }
        nodes.delete(rootId)

        while (queue.length > 0) {
            const id = queue.shift()
            const node = nodes.get(id)
            if (!node) continue
            orphaned.push(id)
            for (const c of node.children) queue.push(c)
            for (const pChild of node.pendingChildren) {
                const pEntry = pending.get(pChild)
                if (pEntry && pEntry.parentPeerId === id) {
                    pending.delete(pChild)
                    setProbation(pChild, id)
                    orphaned.push(pChild)
                }
            }
            nodes.delete(id)
        }
        return orphaned
    }

    function attachDirect(peerId, capable, maxChildren) {
        nodes.set(peerId, {
            peerId,
            parentPeerId: djPeerId,
            hop: 1,
            capable,
            maxChildren: capable ? maxChildren : 0,
            children: new Set(),
            pendingChildren: new Set()
        })
        redirectAttempts.delete(peerId)
        return { action: 'direct', parentPeerId: djPeerId, hop: 1 }
    }

    function countDirectListeners() {
        let count = 0
        for (const node of nodes.values()) {
            if (node.parentPeerId === djPeerId) count++
        }
        return count
    }

    function resolveCap(peerId, capable, maxChildren) {
        if (!capable) return 0
        if (explicitCaps.has(peerId)) return explicitCaps.get(peerId)
        if (Number.isInteger(maxChildren)) return clampInt(maxChildren, 0, O.maxChildrenPerNode, 0)
        return clampInt(O.defaultMaxChildren, 0, O.maxChildrenPerNode, 2)
    }

    function requestJoin(peerId, { capable = true, maxChildren, redirectCount = 0 } = {}) {
        pruneExpired()
        if (typeof peerId !== 'string' || !peerId || peerId === djPeerId) {
            return { action: 'reject', reason: 'refused' }
        }

        const isCapable = capable !== false
        const cap = resolveCap(peerId, isCapable, maxChildren)

        // Retrying join while a redirect is still pending treats that parent as failed.
        const prevPending = clearPendingForChild(peerId)
        if (prevPending) setProbation(peerId, prevPending.parentPeerId)

        // Re-joining detaches any existing subtree for this peer cleanly.
        if (nodes.has(peerId)) detachSubtree(peerId)

        if (nodes.size + pending.size >= O.maxListeners) {
            return { action: 'reject', reason: 'full' }
        }

        // Legacy 1.0.9 pass-through: always direct, never redirected, never forwards.
        if (!isCapable) {
            return attachDirect(peerId, false, 0)
        }

        const attempts = Math.max(
            redirectAttempts.get(peerId) ?? 0,
            Number.isInteger(redirectCount) ? redirectCount : 0
        )
        if (attempts >= O.maxRedirects) {
            return attachDirect(peerId, true, cap)
        }

        // DJ (hop 0) is the shallowest parent when direct listener slots remain.
        if (countDirectListeners() < O.maxDirectListeners) {
            return attachDirect(peerId, true, cap)
        }

        const topo = getTopology()
        const candidates = []
        for (const p of nodes.values()) {
            if (p.peerId === peerId) continue
            if (!p.capable) continue
            if (p.hop < 1 || p.hop >= O.maxHop) continue
            if (isDescendant(p.peerId, peerId)) continue
            if (effectiveAvailableSlots(p) <= 0) continue
            if (isProbation(peerId, p.peerId)) continue
            if (topo && (isIdlePeer(topo, p.peerId) || !hasSymmetricMesh(topo, p.peerId, peerId))) continue
            candidates.push(p)
        }

        if (candidates.length === 0) {
            return attachDirect(peerId, true, cap)
        }

        candidates.sort((a, b) => {
            if (a.hop !== b.hop) return a.hop - b.hop
            const loadA = a.children.size + a.pendingChildren.size
            const loadB = b.children.size + b.pendingChildren.size
            if (loadA !== loadB) return loadA - loadB
            const availDiff = effectiveAvailableSlots(b) - effectiveAvailableSlots(a)
            if (availDiff !== 0) return availDiff
            const degDiff = meshDegree(topo, b.peerId) - meshDegree(topo, a.peerId)
            if (degDiff !== 0) return degDiff
            return a.peerId.localeCompare(b.peerId)
        })

        const chosen = candidates[0]
        tokenSeq += 1
        chosen.pendingChildren.add(peerId)
        pending.set(peerId, {
            childPeerId: peerId,
            parentPeerId: chosen.peerId,
            hop: chosen.hop + 1,
            tokenSeq,
            capable: true,
            maxChildren: cap,
            expiresAt: now() + O.redirectConfirmMs
        })
        redirectAttempts.set(peerId, attempts + 1)

        return {
            action: 'redirect',
            parentPeerId: chosen.peerId,
            hop: chosen.hop + 1,
            tokenSeq
        }
    }

    function confirmChild(parentId, childId, { maxChildren, capable = true } = {}) {
        pruneExpired()
        if (typeof parentId !== 'string' || !parentId || typeof childId !== 'string' || !childId || parentId === childId) {
            return { ok: false, reason: 'invalid-edge' }
        }

        if (parentId === djPeerId) {
            clearPendingForChild(childId)
            if (nodes.has(childId)) detachSubtree(childId)
            const isCapable = capable !== false
            const cap = resolveCap(childId, isCapable, maxChildren)
            attachDirect(childId, isCapable, cap)
            return { ok: true, parentPeerId: djPeerId, hop: 1 }
        }

        const parent = nodes.get(parentId)
        if (!parent) return { ok: false, reason: 'unknown-parent' }
        if (!parent.capable || parent.hop >= O.maxHop) {
            return { ok: false, reason: 'invalid-edge' }
        }
        if (isDescendant(parentId, childId)) {
            return { ok: false, reason: 'loop' }
        }

        const pEntry = pending.get(childId)
        let childCap = resolveCap(childId, capable !== false, maxChildren)
        let childCapable = capable !== false

        if (pEntry && pEntry.parentPeerId === parentId) {
            pending.delete(childId)
            parent.pendingChildren.delete(childId)
            childCap = explicitCaps.has(childId) ? explicitCaps.get(childId) : pEntry.maxChildren
            childCapable = pEntry.capable
        } else {
            clearPendingForChild(childId)
            if (nodes.has(childId)) detachSubtree(childId)
            if (!parent.children.has(childId) && effectiveAvailableSlots(parent) <= 0) {
                return { ok: false, reason: 'full' }
            }
        }

        const hop = parent.hop + 1
        parent.children.add(childId)
        nodes.set(childId, {
            peerId: childId,
            parentPeerId: parentId,
            hop,
            capable: childCapable,
            maxChildren: childCapable ? childCap : 0,
            children: new Set(),
            pendingChildren: new Set()
        })
        redirectAttempts.delete(childId)
        return { ok: true, parentPeerId: parentId, hop }
    }

    function reportFailure(childId, parentId) {
        pruneExpired()
        if (typeof childId !== 'string' || !childId || typeof parentId !== 'string' || !parentId) {
            return { ok: false, orphaned: [] }
        }
        setProbation(childId, parentId, O.parentFailBackoffMs)
        const pEntry = pending.get(childId)
        if (pEntry && pEntry.parentPeerId === parentId) {
            clearPendingForChild(childId)
        }
        const child = nodes.get(childId)
        if (child && child.parentPeerId === parentId) {
            const orphaned = detachSubtree(childId)
            return { ok: true, orphaned }
        }
        return { ok: true, orphaned: [] }
    }

    function removePeer(peerId) {
        pruneExpired()
        if (typeof peerId !== 'string' || !peerId) return { removed: false, orphaned: [] }
        let removed = false
        const orphaned = []

        if (clearPendingForChild(peerId)) removed = true

        for (const [childId, entry] of [...pending]) {
            if (entry.parentPeerId === peerId) {
                clearPendingForChild(childId)
                setProbation(childId, peerId)
                orphaned.push(childId)
            }
        }

        const node = nodes.get(peerId)
        if (node) {
            removed = true
            for (const directChildId of node.children) {
                setProbation(directChildId, peerId)
            }
            const subOrphans = detachSubtree(peerId)
            for (const id of subOrphans) orphaned.push(id)
        }

        redirectAttempts.delete(peerId)
        explicitCaps.delete(peerId)
        return { removed, orphaned }
    }

    function setForwardingCap(peerId, cap) {
        pruneExpired()
        if (typeof peerId !== 'string' || !peerId || peerId === djPeerId) {
            return { ok: false, cap: 0, shed: [] }
        }
        const clamped = clampInt(cap, 0, O.maxChildrenPerNode, 0)
        explicitCaps.set(peerId, clamped)

        const pEntry = pending.get(peerId)
        if (pEntry) pEntry.maxChildren = clamped

        const node = nodes.get(peerId)
        if (!node) return { ok: true, cap: clamped, shed: [] }

        node.maxChildren = node.capable ? clamped : 0
        const shed = []

        if (node.children.size + node.pendingChildren.size > node.maxChildren) {
            for (const pChild of [...node.pendingChildren]) {
                if (node.children.size + node.pendingChildren.size <= node.maxChildren) break
                const entry = pending.get(pChild)
                if (entry && entry.parentPeerId === peerId) {
                    clearPendingForChild(pChild)
                    shed.push(pChild)
                }
            }
            const childList = [...node.children]
            while (node.children.size > node.maxChildren && childList.length > 0) {
                const victim = childList.pop()
                const subOrphans = detachSubtree(victim)
                shed.push(victim, ...subOrphans)
            }
        }

        return { ok: true, cap: node.maxChildren, shed }
    }

    function reparent(peerIds, optsFor = () => ({ capable: true })) {
        const results = []
        for (const peerId of peerIds) {
            results.push({ peerId, decision: requestJoin(peerId, optsFor(peerId)) })
        }
        return results
    }

    function parentOf(peerId) {
        return nodes.get(peerId)?.parentPeerId ?? null
    }

    function childrenOf(peerId) {
        if (peerId === djPeerId) {
            const list = []
            for (const node of nodes.values()) {
                if (node.parentPeerId === djPeerId) list.push(node.peerId)
            }
            return list
        }
        const node = nodes.get(peerId)
        return node ? [...node.children] : []
    }

    function edges() {
        const list = []
        for (const node of nodes.values()) {
            list.push({
                parentPeerId: node.parentPeerId,
                childPeerId: node.peerId,
                hop: node.hop
            })
        }
        return list
    }

    function stats() {
        pruneExpired()
        const byHop = {}
        let maxActiveHop = 0
        for (const node of nodes.values()) {
            byHop[node.hop] = (byHop[node.hop] ?? 0) + 1
            if (node.hop > maxActiveHop) maxActiveHop = node.hop
        }
        return {
            djPeerId,
            channelId,
            listeners: nodes.size,
            pending: pending.size,
            directListeners: countDirectListeners(),
            maxHop: maxActiveHop,
            byHop
        }
    }

    return {
        requestJoin,
        confirmChild,
        reportFailure,
        removePeer,
        setForwardingCap,
        reparent,
        parentOf,
        childrenOf,
        edges,
        stats,
        pruneExpired,
        isProbation
    }
}

/**
 * Create a non-blocking per-child Opus frame forwarder with bounded drop-oldest queues,
 * per-origin sequence deduplication, and revocation cutoff.
 */
export function createMusicForwarder({
    maxQueueFrames = MUSIC_FANOUT_DEFAULTS.maxChildQueueFrames,
    dedupWindow = MUSIC_FANOUT_DEFAULTS.dedupWindow,
    allowed = () => true,
    onDrop = () => {},
    onRevoked = () => {}
} = {}) {
    const queueLimit = clampInt(maxQueueFrames, 1, 10000, MUSIC_FANOUT_DEFAULTS.maxChildQueueFrames)
    const dedupLimit = clampInt(dedupWindow, 1, 10000, MUSIC_FANOUT_DEFAULTS.dedupWindow)

    const children = new Map() // childPeerId -> { id, send, onDrain, queue, blocked, drops, sent }
    const seen = new Map() // origin -> { set: Set, order: [] }
    let duplicates = 0
    let totalDrops = 0
    let totalForwarded = 0

    function isDuplicate(origin, seq) {
        let w = seen.get(origin)
        if (!w) {
            w = { set: new Set(), order: [] }
            seen.set(origin, w)
        }
        if (w.set.has(seq)) return true
        w.set.add(seq)
        w.order.push(seq)
        if (w.order.length > dedupLimit) {
            w.set.delete(w.order.shift())
        }
        return false
    }

    function revokeChild(childPeerId) {
        const c = children.get(childPeerId)
        if (!c) return false
        c.queue.length = 0
        children.delete(childPeerId)
        onRevoked(childPeerId)
        return true
    }

    function checkAllowed() {
        const revoked = []
        for (const childId of [...children.keys()]) {
            if (!allowed(childId)) {
                revokeChild(childId)
                revoked.push(childId)
            }
        }
        return revoked
    }

    function drainChild(c) {
        if (!c || typeof c.send !== 'function' || c.blocked) return 0
        let sentCount = 0
        while (c.queue.length > 0 && !c.blocked) {
            if (!allowed(c.id)) {
                revokeChild(c.id)
                return sentCount
            }
            const frame = c.queue[0]
            let ok
            try {
                ok = c.send(frame)
            } catch {
                c.blocked = true
                break
            }
            c.queue.shift()
            c.sent++
            totalForwarded++
            sentCount++
            if (ok === false) {
                c.blocked = true
                if (typeof c.onDrain === 'function') {
                    Promise.resolve(c.onDrain()).then(
                        () => {
                            if (children.get(c.id) === c) {
                                c.blocked = false
                                drainChild(c)
                            }
                        },
                        () => {}
                    )
                }
                break
            }
        }
        return sentCount
    }

    function addChild(childPeerId, { send = null, onDrain = null } = {}) {
        if (typeof childPeerId !== 'string' || !childPeerId) {
            throw new TypeError('childPeerId must be a non-empty string')
        }
        if (!allowed(childPeerId)) {
            onRevoked(childPeerId)
            return { ok: false, reason: 'refused' }
        }
        const entry = {
            id: childPeerId,
            send,
            onDrain,
            queue: [],
            blocked: false,
            drops: 0,
            sent: 0
        }
        children.set(childPeerId, entry)
        return { ok: true }
    }

    function removeChild(childPeerId) {
        const c = children.get(childPeerId)
        if (!c) return false
        c.queue.length = 0
        children.delete(childPeerId)
        return true
    }

    function pushFrame(frame) {
        if (!frame || typeof frame.origin !== 'string' || !Number.isInteger(frame.seq)) {
            return { forwarded: 0, duplicate: false, invalid: true }
        }
        if (isDuplicate(frame.origin, frame.seq)) {
            duplicates++
            return { forwarded: 0, duplicate: true }
        }

        checkAllowed()

        let enqueued = 0
        for (const c of [...children.values()]) {
            c.queue.push(frame)
            while (c.queue.length > queueLimit) {
                const dropped = c.queue.shift()
                c.drops++
                totalDrops++
                onDrop(c.id, dropped)
            }
            enqueued++
            drainChild(c)
        }

        return { forwarded: enqueued, duplicate: false }
    }

    function popFrame(childPeerId) {
        const c = children.get(childPeerId)
        if (!c || c.queue.length === 0) return null
        return c.queue.shift()
    }

    function drain(childPeerId) {
        const c = children.get(childPeerId)
        if (!c) return 0
        c.blocked = false
        return drainChild(c)
    }

    function stats() {
        const perChild = {}
        for (const [id, c] of children) {
            perChild[id] = {
                queued: c.queue.length,
                drops: c.drops,
                sent: c.sent,
                blocked: c.blocked
            }
        }
        return {
            children: children.size,
            duplicates,
            drops: totalDrops,
            forwarded: totalForwarded,
            perChild
        }
    }

    return {
        addChild,
        removeChild,
        hasChild: childPeerId => children.has(childPeerId),
        childIds: () => [...children.keys()],
        queueLength: childPeerId => children.get(childPeerId)?.queue.length ?? 0,
        pushFrame,
        onFrame: pushFrame,
        popFrame,
        drain,
        checkAllowed,
        stats
    }
}
