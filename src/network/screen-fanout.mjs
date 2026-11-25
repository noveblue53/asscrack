// Pure tree coordinator for peer-assisted screen share fanout (docs/SCREENSHARE_FANOUT.md, Session 2).
// Zero libp2p dependencies and zero timers: callers supply `now` and `getTopology`.

export const FANOUT_DEFAULTS = Object.freeze({
    maxHop: 3, // 0 = sharer, 1 = direct child, 2 = grandchild, 3 = great-grandchild
    maxViewers: 24,
    maxDirectViewers: 1,
    maxRedirects: 3,
    maxChildrenPerNode: 8,
    defaultGlobalMaxChildren: 2,
    maxShares: 3,
    redirectConfirmMs: 8000,
    parentFailBackoffMs: 30000,
    congestedBackoffMs: 30000,
    slowDirectMs: 30000
})

function clampInt(value, min, max, fallback = min) {
    if (!Number.isInteger(value)) return fallback
    return Math.max(min, Math.min(max, value))
}

/**
 * Pure global per-node forwarding slot accounting across up to `maxShares` concurrent shares.
 */
export function createGlobalSlotLedger({
    maxShares = FANOUT_DEFAULTS.maxShares,
    defaultCap = FANOUT_DEFAULTS.defaultGlobalMaxChildren,
    maxCap = FANOUT_DEFAULTS.maxChildrenPerNode
} = {}) {
    const shares = new Set()
    const caps = new Map() // peerId -> integer 0..maxCap
    const ownSharing = new Set() // peerIds currently sharing their own screen
    const forwarded = new Map() // parentPeerId -> Map(shareId -> Set(childPeerId))

    function registerShare(shareId) {
        if (typeof shareId !== 'string' || !shareId) return false
        if (shares.has(shareId)) return true
        if (shares.size >= maxShares) return false
        shares.add(shareId)
        return true
    }

    function releaseAllForShare(shareId) {
        for (const [peerId, byShare] of forwarded) {
            byShare.delete(shareId)
            if (byShare.size === 0) forwarded.delete(peerId)
        }
    }

    function unregisterShare(shareId) {
        releaseAllForShare(shareId)
        return shares.delete(shareId)
    }

    function setNodeCap(peerId, cap) {
        if (typeof peerId !== 'string' || !peerId) return false
        caps.set(peerId, clampInt(cap, 0, maxCap, 0))
        return true
    }

    const hasExplicitCap = peerId => caps.has(peerId)
    const capOf = peerId => (caps.has(peerId) ? caps.get(peerId) : defaultCap)

    function setOwnSharing(peerId, sharing) {
        if (typeof peerId !== 'string' || !peerId) return
        if (sharing) ownSharing.add(peerId)
        else ownSharing.delete(peerId)
    }

    const isOwnSharing = peerId => ownSharing.has(peerId)

    function activeChildrenForShare(peerId, shareId) {
        return forwarded.get(peerId)?.get(shareId)?.size ?? 0
    }

    function activeChildren(peerId) {
        const byShare = forwarded.get(peerId)
        if (!byShare) return 0
        let total = 0
        for (const set of byShare.values()) total += set.size
        return total
    }

    function availableSlots(peerId) {
        if (ownSharing.has(peerId)) return 0
        return Math.max(0, capOf(peerId) - activeChildren(peerId))
    }

    function canAccept(peerId, shareId, childPeerId = null) {
        if (ownSharing.has(peerId)) return false
        if (childPeerId && forwarded.get(peerId)?.get(shareId)?.has(childPeerId)) return true
        return availableSlots(peerId) > 0
    }

    function reserveSlot(peerId, shareId, childPeerId) {
        if (!peerId || !shareId || !childPeerId) return false
        if (!canAccept(peerId, shareId, childPeerId)) return false
        let byShare = forwarded.get(peerId)
        if (!byShare) {
            byShare = new Map()
            forwarded.set(peerId, byShare)
        }
        let children = byShare.get(shareId)
        if (!children) {
            children = new Set()
            byShare.set(shareId, children)
        }
        children.add(childPeerId)
        return true
    }

    function releaseSlot(peerId, shareId, childPeerId) {
        const byShare = forwarded.get(peerId)
        const children = byShare?.get(shareId)
        if (!children) return false
        const deleted = children.delete(childPeerId)
        if (children.size === 0) byShare.delete(shareId)
        if (byShare.size === 0) forwarded.delete(peerId)
        return deleted
    }

    function releaseAllForPeer(peerId) {
        return forwarded.delete(peerId)
    }

    function snapshot() {
        const nodes = {}
        for (const [peerId, byShare] of forwarded) {
            const perShare = {}
            for (const [sId, children] of byShare) perShare[sId] = [...children]
            nodes[peerId] = {
                cap: capOf(peerId),
                ownSharing: ownSharing.has(peerId),
                active: activeChildren(peerId),
                available: availableSlots(peerId),
                shares: perShare
            }
        }
        return { maxShares, shares: [...shares], nodes }
    }

    return {
        registerShare,
        unregisterShare,
        shareCount: () => shares.size,
        setNodeCap,
        hasExplicitCap,
        capOf,
        setOwnSharing,
        isOwnSharing,
        activeChildrenForShare,
        activeChildren,
        availableSlots,
        canAccept,
        reserveSlot,
        releaseSlot,
        releaseAllForShare,
        releaseAllForPeer,
        snapshot
    }
}

function isIdlePeer(topo, peerId) {
    const idle = topo?.idlePeers
    if (!idle) return false
    if (typeof idle.has === 'function') return idle.has(peerId)
    if (Array.isArray(idle)) return idle.includes(peerId)
    return false
}

function hasSymmetricMesh(topo, parentId, childId) {
    if (!topo || parentId === childId) return false
    if (isIdlePeer(topo, parentId) || isIdlePeer(topo, childId)) return false
    const kinds = topo.kinds ?? topo.linkKinds
    if (kinds?.[parentId]?.[childId] !== 'mesh' || kinds?.[childId]?.[parentId] !== 'mesh') return false
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
 * Create a sharer-side pure tree coordinator for a single screen share.
 */
export function createScreenFanout({
    selfId,
    shareId = 'default',
    getTopology = () => null,
    now = () => performance.now(),
    slotLedger = null,
    options = {}
} = {}) {
    if (typeof selfId !== 'string' || !selfId) throw new TypeError('selfId must be a non-empty string')
    if (typeof now !== 'function') throw new TypeError('now must be a function')

    const O = { ...FANOUT_DEFAULTS, ...options }
    const hasExternalLedger = slotLedger !== null
    const ledger = slotLedger ?? createGlobalSlotLedger({
        maxShares: O.maxShares,
        defaultCap: O.defaultGlobalMaxChildren,
        maxCap: O.maxChildrenPerNode
    })
    ledger.registerShare(shareId)

    let topoOverride = null
    const getTopo = () => topoOverride ?? getTopology()

    // Active tree nodes: peerId -> { peerId, parentPeerId, hop, fanout, maxChildren, children, pendingChildren, congested, congestedUntil }
    const nodes = new Map()
    // Pending redirects: childPeerId -> { childPeerId, parentPeerId, hop, tokenSeq, fanout, maxChildren, expiresAt }
    const pending = new Map()
    // Failed (child, parent) pairs: `${childId}\n${parentId}` -> expiresAt
    const probation = new Map()
    // Consecutive redirect attempts per viewer during startup
    const redirectAttempts = new Map()
    // Slow-shed viewers forced direct for slowDirectMs
    const preferDirectUntil = new Map()
    let tokenSeq = 0

    const probationKey = (childId, parentId) => `${childId}\n${parentId}`

    function pruneExpired() {
        const t = now()
        for (const [childId, entry] of pending) {
            if (t >= entry.expiresAt) {
                pending.delete(childId)
                const parent = nodes.get(entry.parentPeerId)
                parent?.pendingChildren.delete(childId)
                ledger.releaseSlot(entry.parentPeerId, shareId, childId)
            }
        }
        for (const [key, until] of probation) {
            if (t >= until) probation.delete(key)
        }
        for (const [peerId, until] of preferDirectUntil) {
            if (t >= until) preferDirectUntil.delete(peerId)
        }
    }

    function isProbation(childId, parentId) {
        const until = probation.get(probationKey(childId, parentId))
        return until !== undefined && now() < until
    }

    function setProbation(childId, parentId, durationMs = O.parentFailBackoffMs) {
        if (!childId || !parentId || parentId === selfId) return
        probation.set(probationKey(childId, parentId), now() + durationMs)
    }

    function isDescendant(candidateId, ancestorId) {
        if (candidateId === ancestorId) return true
        const visited = new Set()
        let cur = candidateId
        while (cur && cur !== selfId) {
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
        const load = parentNode.children.size + parentNode.pendingChildren.size
        const perShareAvail = Math.max(0, parentNode.maxChildren - load)
        if (hasExternalLedger || ledger.hasExplicitCap(parentNode.peerId) || ledger.isOwnSharing(parentNode.peerId)) {
            return Math.min(perShareAvail, ledger.availableSlots(parentNode.peerId))
        }
        return perShareAvail
    }

    function clearPendingForChild(childId) {
        const entry = pending.get(childId)
        if (!entry) return null
        pending.delete(childId)
        const parent = nodes.get(entry.parentPeerId)
        parent?.pendingChildren.delete(childId)
        ledger.releaseSlot(entry.parentPeerId, shareId, childId)
        return entry
    }

    // Detaches `rootId` and all of its descendants in BFS order. Returns orphaned descendants (excluding `rootId`).
    function detachSubtree(rootId) {
        const root = nodes.get(rootId)
        if (!root) return []
        const parent = root.parentPeerId !== selfId ? nodes.get(root.parentPeerId) : null
        if (parent) {
            parent.children.delete(rootId)
            ledger.releaseSlot(parent.peerId, shareId, rootId)
        }
        const orphaned = []
        const queue = [...root.children]
        for (const pChild of root.pendingChildren) {
            const pEntry = pending.get(pChild)
            if (pEntry && pEntry.parentPeerId === rootId) {
                pending.delete(pChild)
                ledger.releaseSlot(rootId, shareId, pChild)
                setProbation(pChild, rootId)
                orphaned.push(pChild)
            }
        }
        nodes.delete(rootId)
        ledger.releaseSlot(rootId, shareId, rootId)
        while (queue.length > 0) {
            const id = queue.shift()
            const node = nodes.get(id)
            if (!node) continue
            ledger.releaseSlot(node.parentPeerId, shareId, id)
            orphaned.push(id)
            for (const c of node.children) queue.push(c)
            for (const pChild of node.pendingChildren) {
                const pEntry = pending.get(pChild)
                if (pEntry && pEntry.parentPeerId === id) {
                    pending.delete(pChild)
                    ledger.releaseSlot(id, shareId, pChild)
                    setProbation(pChild, id)
                    orphaned.push(pChild)
                }
            }
            nodes.delete(id)
        }
        return orphaned
    }

    function attachDirect(viewerId, isFanout, maxChildren) {
        nodes.set(viewerId, {
            peerId: viewerId,
            parentPeerId: selfId,
            hop: 1,
            fanout: isFanout,
            maxChildren,
            children: new Set(),
            pendingChildren: new Set(),
            congested: false,
            congestedUntil: 0
        })
        redirectAttempts.delete(viewerId)
        return { action: 'direct', parentPeerId: selfId, hop: 1 }
    }

    function countDirectViewers() {
        let count = 0
        for (const node of nodes.values()) {
            if (node.hop === 1) count++
        }
        return count
    }

    function planWatch(viewerId, { fanout = 0, maxChildren = 0, redirectCount = 0 } = {}) {
        pruneExpired()
        if (typeof viewerId !== 'string' || !viewerId || viewerId === selfId) {
            return { action: 'reject', reason: 'refused' }
        }

        const isFanout = fanout === 1
        const cap = isFanout ? clampInt(maxChildren, 0, O.maxChildrenPerNode, 0) : 0

        // If viewer retries WATCH while a previous redirect is still pending, treat that parent as failed.
        const prevPending = clearPendingForChild(viewerId)
        if (prevPending) setProbation(viewerId, prevPending.parentPeerId)

        // If viewer was already active, detach it cleanly before re-planning.
        if (nodes.has(viewerId)) detachSubtree(viewerId)

        if (nodes.size + pending.size >= O.maxViewers) {
            return { action: 'reject', reason: 'full' }
        }

        // 1.0.1-1.0.6 viewer pass-through: always direct, never a parent.
        if (!isFanout) return attachDirect(viewerId, false, 0)

        const t = now()
        if ((preferDirectUntil.get(viewerId) ?? 0) > t) {
            return attachDirect(viewerId, true, cap)
        }

        const attempts = Math.max(redirectAttempts.get(viewerId) ?? 0, Number.isInteger(redirectCount) ? redirectCount : 0)
        if (attempts >= O.maxRedirects) {
            return attachDirect(viewerId, true, cap)
        }

        if (countDirectViewers() < O.maxDirectViewers) {
            return attachDirect(viewerId, true, cap)
        }

        const topo = getTopo()
        const candidates = []
        for (const p of nodes.values()) {
            if (p.peerId === viewerId) continue
            if (p.hop < 1 || p.hop >= O.maxHop) continue
            if (isDescendant(p.peerId, viewerId)) continue
            if (p.congested || t < p.congestedUntil) continue
            if (effectiveAvailableSlots(p) <= 0) continue
            if (isProbation(viewerId, p.peerId)) continue
            if (!hasSymmetricMesh(topo, p.peerId, viewerId)) continue
            candidates.push(p)
        }

        if (candidates.length === 0) {
            return attachDirect(viewerId, true, cap)
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
        if (hasExternalLedger && !ledger.reserveSlot(chosen.peerId, shareId, viewerId)) {
            return attachDirect(viewerId, true, cap)
        }
        if (!hasExternalLedger) {
            // Best-effort tracking in internal ledger without blocking single-share maxChildren > defaultCap
            ledger.reserveSlot(chosen.peerId, shareId, viewerId)
        }

        tokenSeq += 1
        chosen.pendingChildren.add(viewerId)
        pending.set(viewerId, {
            childPeerId: viewerId,
            parentPeerId: chosen.peerId,
            hop: chosen.hop + 1,
            tokenSeq,
            fanout: true,
            maxChildren: cap,
            expiresAt: t + O.redirectConfirmMs
        })
        redirectAttempts.set(viewerId, attempts + 1)

        return {
            action: 'redirect',
            parentPeerId: chosen.peerId,
            hop: chosen.hop + 1,
            tokenSeq
        }
    }

    function handleReport(parentPeerId, report) {
        pruneExpired()
        const parent = nodes.get(parentPeerId)
        if (!parent || !report || typeof report !== 'object') {
            return { ok: false, reason: 'unknown-parent' }
        }

        const t = now()
        if (Number.isInteger(report.maxChildren)) {
            parent.maxChildren = clampInt(report.maxChildren, 0, O.maxChildrenPerNode, parent.maxChildren)
        }
        if (typeof report.congested === 'boolean') {
            if (report.congested) {
                parent.congested = true
                parent.congestedUntil = Math.max(parent.congestedUntil, t + O.congestedBackoffMs)
            } else {
                parent.congested = false
            }
        }

        const event = report.event
        if (event === 'capacity') {
            return { ok: true, event: 'capacity' }
        }

        const childId = report.childPeerId
        if (typeof childId !== 'string' || !childId) {
            return { ok: false, reason: 'missing-child' }
        }

        if (event === 'child-joined') {
            if (parent.hop >= O.maxHop || isDescendant(parentPeerId, childId)) {
                return { ok: false, reason: 'invalid-edge' }
            }
            const pEntry = pending.get(childId)
            let childCap = clampInt(report.childMaxChildren, 0, O.maxChildrenPerNode, 0)
            let childFanout = true
            if (pEntry && pEntry.parentPeerId === parentPeerId) {
                pending.delete(childId)
                parent.pendingChildren.delete(childId)
                childCap = pEntry.maxChildren
                childFanout = pEntry.fanout
            } else {
                clearPendingForChild(childId)
                if (nodes.has(childId)) detachSubtree(childId)
                if (hasExternalLedger && !ledger.reserveSlot(parentPeerId, shareId, childId)) {
                    return { ok: false, reason: 'full' }
                }
                if (!hasExternalLedger) ledger.reserveSlot(parentPeerId, shareId, childId)
            }
            const hop = parent.hop + 1
            parent.children.add(childId)
            nodes.set(childId, {
                peerId: childId,
                parentPeerId,
                hop,
                fanout: childFanout,
                maxChildren: childCap,
                children: new Set(),
                pendingChildren: new Set(),
                congested: false,
                congestedUntil: 0
            })
            redirectAttempts.delete(childId)
            return { ok: true, event: 'child-joined', hop }
        }

        if (event === 'child-left') {
            const child = nodes.get(childId)
            if (!child || child.parentPeerId !== parentPeerId) {
                const pEntry = pending.get(childId)
                if (pEntry && pEntry.parentPeerId === parentPeerId) {
                    clearPendingForChild(childId)
                    return { ok: true, event: 'child-left', orphaned: [] }
                }
                return { ok: false, reason: 'not-child' }
            }
            const orphaned = detachSubtree(childId)
            return { ok: true, event: 'child-left', orphaned }
        }

        if (event === 'child-shed') {
            setProbation(childId, parentPeerId)
            if (report.reason === 'congested') {
                parent.congested = true
                parent.congestedUntil = Math.max(parent.congestedUntil, t + O.congestedBackoffMs)
            } else if (report.reason === 'slow') {
                preferDirectUntil.set(childId, t + O.slowDirectMs)
            }
            const child = nodes.get(childId)
            if (!child || child.parentPeerId !== parentPeerId) {
                const pEntry = pending.get(childId)
                if (pEntry && pEntry.parentPeerId === parentPeerId) {
                    clearPendingForChild(childId)
                }
                return { ok: true, event: 'child-shed', reason: report.reason ?? null, orphaned: [] }
            }
            const orphaned = detachSubtree(childId)
            return { ok: true, event: 'child-shed', reason: report.reason ?? null, orphaned }
        }

        return { ok: false, reason: 'unknown-event' }
    }

    function onPeerLeft(peerId) {
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
        preferDirectUntil.delete(peerId)
        return { removed, orphaned }
    }

    function recordParentFailure(viewerId, parentPeerId) {
        pruneExpired()
        const entry = pending.get(viewerId)
        if (entry && entry.parentPeerId === parentPeerId) clearPendingForChild(viewerId)
        setProbation(viewerId, parentPeerId)
    }

    function setCongested(parentPeerId, congested) {
        return handleReport(parentPeerId, { event: 'capacity', congested: congested === true })
    }

    function reparent(peerIds, watchOptsFor = () => ({ fanout: 1, maxChildren: 2 })) {
        const results = []
        for (const peerId of peerIds) {
            results.push({ peerId, decision: planWatch(peerId, watchOptsFor(peerId)) })
        }
        return results
    }

    function destroy() {
        nodes.clear()
        pending.clear()
        probation.clear()
        redirectAttempts.clear()
        preferDirectUntil.clear()
        ledger.unregisterShare(shareId)
    }

    function snapshot() {
        pruneExpired()
        const tree = {}
        for (const [id, n] of nodes) {
            tree[id] = {
                parentPeerId: n.parentPeerId,
                hop: n.hop,
                fanout: n.fanout,
                maxChildren: n.maxChildren,
                children: [...n.children],
                pendingChildren: [...n.pendingChildren],
                congested: n.congested
            }
        }
        return {
            selfId,
            shareId,
            nodes: tree,
            pending: [...pending.values()],
            ledger: ledger.snapshot()
        }
    }

    return {
        planWatch,
        handleReport,
        onPeerLeft,
        recordParentFailure,
        setCongested,
        reparent,
        pruneExpired,
        isProbation,
        setTopology: topo => { topoOverride = topo },
        getNode: peerId => nodes.get(peerId) ?? null,
        snapshot,
        destroy
    }
}
