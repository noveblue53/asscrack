const MAX_TRACKED_PEERS = 128;

function bumpCounter(map, key) {
    if (typeof key !== 'string' || !key) return;
    if (!map.has(key) && map.size >= MAX_TRACKED_PEERS) return;
    map.set(key, (map.get(key) ?? 0) + 1);
}

function transferKey(data) {
    if (!data || typeof data.offerId !== 'string' || typeof data.peerId !== 'string') return '';
    const dir = data.direction === 'send' || data.direction === 'receive' ? data.direction : '';
    return dir ? `${dir}|${data.offerId}|${data.peerId}` : '';
}

function addEdge(edgeMap, kind, from, to, count, mode = 'sum') {
    if (!from || !to || from === to || !Number.isFinite(count) || count <= 0) return;
    const key = `${kind}|${from}|${to}`;
    const prev = edgeMap.get(key);
    const nextCount = prev ? (mode === 'max' ? Math.max(prev.count, count) : prev.count + count) : count;
    edgeMap.set(key, { from, to, kind, count: nextCount });
}

function collectRelayTraffic(edgeMap, kind, stats, inbound, selfId, hostId) {
    if (stats && typeof stats === 'object') {
        const forwardedTo = stats.forwardedTo;
        if (forwardedTo && typeof forwardedTo === 'object') {
            for (const [origin, targets] of Object.entries(forwardedTo)) {
                if (!targets || typeof targets !== 'object') continue;
                let maxIn = 0;
                for (const [target, count] of Object.entries(targets)) {
                    const n = Number(count);
                    if (!Number.isFinite(n) || n <= 0) continue;
                    if (n > maxIn) maxIn = n;
                    addEdge(edgeMap, kind, selfId, target, n);
                }
                if (origin && origin !== selfId && maxIn > 0) {
                    addEdge(edgeMap, kind, origin, selfId, maxIn, 'max');
                }
            }
        }
        const seq = Number(stats.seq);
        const streams = Number(stats.streams);
        if (Number.isFinite(seq) && seq > 0 && Number.isFinite(streams) && streams > 0 && hostId && hostId !== selfId) {
            addEdge(edgeMap, kind, selfId, hostId, seq, 'max');
        }
    }
    for (const [origin, count] of inbound) {
        if (origin && origin !== selfId) addEdge(edgeMap, kind, origin, selfId, count, 'max');
    }
}

export function createMapTraffic() {
    const voiceIn = new Map();
    const musicIn = new Map();
    const transferBytes = new Map();

    function recordVoiceFrame(origin) {
        bumpCounter(voiceIn, origin);
    }

    function recordMusicFrame(origin) {
        bumpCounter(musicIn, origin);
    }

    function recordFileProgress(data, selfId) {
        const key = transferKey(data);
        if (!key || typeof selfId !== 'string' || !selfId) return;
        const bytes = Number(data.bytes);
        if (!Number.isFinite(bytes) || bytes < 0) return;
        if (!transferBytes.has(key) && transferBytes.size >= MAX_TRACKED_PEERS) return;
        const from = data.direction === 'send' ? selfId : data.peerId;
        const to = data.direction === 'send' ? data.peerId : selfId;
        transferBytes.set(key, { from, to, bytes });
    }

    function recordFileEnd(data) {
        const key = transferKey(data);
        if (key) transferBytes.delete(key);
    }

    function reset() {
        voiceIn.clear();
        musicIn.clear();
        transferBytes.clear();
    }

    function snapshot(node) {
        if (!node || typeof node.peerId !== 'string' || !node.peerId) return null;
        const selfId = node.peerId;
        const hostId = typeof node.host === 'function' ? node.host() : null;
        const voiceStats = typeof node.voiceStats === 'function' ? node.voiceStats() : null;
        const musicStats = typeof node.musicStats === 'function' ? node.musicStats() : null;
        const screenStats = typeof node.screenStats === 'function' ? node.screenStats() : null;
        const activeTransfers = typeof node.activeTransfers === 'function' ? Number(node.activeTransfers()) || 0 : 0;

        const edgeMap = new Map();
        collectRelayTraffic(edgeMap, 'voice', voiceStats, voiceIn, selfId, hostId);
        collectRelayTraffic(edgeMap, 'music', musicStats, musicIn, selfId, hostId);

        if (screenStats && typeof screenStats === 'object') {
            const viewers = screenStats.own?.viewers;
            if (Array.isArray(viewers)) {
                for (const viewer of viewers) {
                    if (viewer && typeof viewer.peerId === 'string') {
                        addEdge(edgeMap, 'screen', selfId, viewer.peerId, Number(viewer.framesSent));
                    }
                }
            }
            const watching = screenStats.watching;
            if (watching && typeof watching === 'object' && Number(watching.frames) > 0) {
                const src = typeof watching.parentPeerId === 'string' && watching.parentPeerId
                    ? watching.parentPeerId
                    : watching.peerId;
                if (typeof src === 'string') addEdge(edgeMap, 'screen', src, selfId, Number(watching.frames));
            }
            if (Array.isArray(screenStats.forwarding)) {
                for (const fwd of screenStats.forwarding) {
                    if (fwd && typeof fwd.peerId === 'string') {
                        addEdge(edgeMap, 'screen', selfId, fwd.peerId, Number(fwd.framesSent ?? fwd.frames));
                    }
                }
            }
            if (Array.isArray(screenStats.fanoutEdges)) {
                for (const edge of screenStats.fanoutEdges) {
                    if (edge && typeof edge.from === 'string' && typeof edge.to === 'string') {
                        addEdge(edgeMap, 'screen', edge.from, edge.to, Number(edge.framesSent ?? edge.frames ?? edge.count));
                    }
                }
            }
        }

        if (activeTransfers > 0) {
            for (const entry of transferBytes.values()) {
                addEdge(edgeMap, 'transfer', entry.from, entry.to, entry.bytes);
            }
        }

        return {
            self: selfId,
            activeTransfers,
            edges: [...edgeMap.values()]
        };
    }

    return { recordVoiceFrame, recordMusicFrame, recordFileProgress, recordFileEnd, reset, snapshot };
}
