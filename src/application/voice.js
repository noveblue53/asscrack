'use strict';

// Voice with a star topology. The elected host has one RTCPeerConnection to each voice member.
// A member that is not the host has one RTCPeerConnection, to the host.
// The host forwards each received audio track to the other voice members.
// Each connection uses the "perfect negotiation" pattern: the member is polite, the host is not polite.
(function () {
    const api = window.asscrack;

    let selfId = null;
    let hostId = null;
    let inVoice = false;
    let localStream = null;
    // peerId -> { inVoice, streamId } of the other peers.
    const members = new Map();
    // peerId -> connection entry.
    const connections = new Map();
    // Host only: origin peerId -> { track, stream } received from that member.
    const relayed = new Map();
    // track id -> <audio> element.
    const players = new Map();
    const listeners = [];

    function changed() {
        for (const callback of listeners) {
            try {
                callback();
            } catch (err) {
                console.warn('voice onChange callback failed:', err);
            }
        }
    }

    function isHost() {
        return selfId !== null && hostId === selfId;
    }

    function peerForStream(streamId) {
        for (const [peerId, state] of members) if (state.streamId === streamId) return peerId;
        return null;
    }

    // The peers that this node must have a connection to.
    function wantedPeers() {
        if (!inVoice || !localStream || selfId === null || hostId === null) return [];
        if (isHost()) return [...members].filter(([, s]) => s.inVoice).map(([peerId]) => peerId);
        return members.get(hostId)?.inVoice ? [hostId] : [];
    }

    function play(track, stream) {
        if (players.has(track.id)) return;
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.hidden = true;
        audio.srcObject = stream;
        players.set(track.id, audio);
        // Not in the visible layout.
        document.documentElement.appendChild(audio);
        audio.play().catch(err => console.warn('Audio play failed:', err?.message ?? err));
    }

    function stopPlay(trackId) {
        const audio = players.get(trackId);
        if (!audio) return;
        players.delete(trackId);
        audio.srcObject = null;
        audio.remove();
    }

    function signal(peerId, data) {
        api.signal(peerId, data).catch(err => console.warn('Signal send failed:', err?.message ?? err));
    }

    function createConnection(peerId) {
        const pc = new RTCPeerConnection({ iceServers: [] });
        const entry = {
            peerId,
            pc,
            polite: !isHost(),
            makingOffer: false,
            ignoreOffer: false,
            // track id -> stream id of the received tracks.
            remote: new Map(),
            // track id -> RTCRtpSender of the sent tracks.
            senders: new Map()
        };
        connections.set(peerId, entry);

        pc.onnegotiationneeded = async () => {
            try {
                entry.makingOffer = true;
                await pc.setLocalDescription();
                signal(peerId, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
            } catch (err) {
                console.warn('Negotiation failed:', err?.message ?? err);
            } finally {
                entry.makingOffer = false;
            }
        };
        pc.onicecandidate = ({ candidate }) => {
            if (candidate) signal(peerId, { candidate: candidate.toJSON() });
        };
        pc.ontrack = ({ track, streams }) => {
            const stream = streams[0];
            if (!stream) return;
            entry.remote.set(track.id, stream.id);
            play(track, stream);
            if (isHost()) {
                relayed.set(peerId, { track, stream });
                updateSenders();
            }
            stream.onremovetrack = ({ track: removed }) => {
                entry.remote.delete(removed.id);
                stopPlay(removed.id);
                changed();
            };
            changed();
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') {
                // Make a new connection on the next reconcile.
                closeConnection(peerId);
                reconcile();
            }
        };

        addSender(entry, localStream.getAudioTracks()[0], localStream);
        return entry;
    }

    function addSender(entry, track, stream) {
        if (!track || entry.senders.has(track.id)) return;
        entry.senders.set(track.id, entry.pc.addTrack(track, stream));
    }

    function closeConnection(peerId) {
        const entry = connections.get(peerId);
        if (!entry) return;
        connections.delete(peerId);
        for (const trackId of entry.remote.keys()) stopPlay(trackId);
        entry.pc.close();
        const relay = relayed.get(peerId);
        if (relay) relayed.delete(peerId);
    }

    // Host only: send the track of each voice member to each other voice member.
    function updateSenders() {
        if (!isHost()) return;
        for (const [origin] of relayed) {
            if (!connections.has(origin)) relayed.delete(origin);
        }
        for (const [peerId, entry] of connections) {
            const wanted = new Set();
            const own = localStream?.getAudioTracks()[0];
            if (own) wanted.add(own.id);
            for (const [origin, { track, stream }] of relayed) {
                if (origin === peerId) continue;
                wanted.add(track.id);
                addSender(entry, track, stream);
            }
            for (const [trackId, sender] of entry.senders) {
                if (wanted.has(trackId)) continue;
                entry.senders.delete(trackId);
                try {
                    entry.pc.removeTrack(sender);
                } catch (err) {
                    console.warn('Remove track failed:', err?.message ?? err);
                }
            }
        }
    }

    function reconcile() {
        const wanted = new Set(wantedPeers());
        for (const peerId of [...connections.keys()]) {
            const entry = connections.get(peerId);
            // A change of host also changes the role of the connection.
            if (!wanted.has(peerId) || entry.polite === isHost()) closeConnection(peerId);
        }
        for (const peerId of wanted) if (!connections.has(peerId)) createConnection(peerId);
        updateSenders();
        changed();
    }

    async function handleSignal({ peerId, data } = {}) {
        if (!data || typeof data !== 'object') return;
        if (!wantedPeers().includes(peerId)) return;
        const entry = connections.get(peerId) ?? createConnection(peerId);
        const pc = entry.pc;
        try {
            if (data.description) {
                const description = data.description;
                const offerCollision = description.type === 'offer' &&
                    (entry.makingOffer || pc.signalingState !== 'stable');
                entry.ignoreOffer = !entry.polite && offerCollision;
                if (entry.ignoreOffer) return;
                await pc.setRemoteDescription(description);
                if (description.type === 'offer') {
                    await pc.setLocalDescription();
                    signal(peerId, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
                }
            } else if (data.candidate) {
                try {
                    await pc.addIceCandidate(data.candidate);
                } catch (err) {
                    if (!entry.ignoreOffer) console.warn('ICE candidate failed:', err?.message ?? err);
                }
            }
        } catch (err) {
            if (connections.get(peerId) === entry) console.warn('Signal handling failed:', err?.message ?? err);
        }
    }

    async function refreshHost() {
        const info = await api.getHost();
        selfId = info.self;
        hostId = info.host?.peerId ?? null;
    }

    api.onSignal(data => { handleSignal(data); });
    api.onVoiceState(({ peerId, inVoice: memberInVoice, streamId } = {}) => {
        members.set(peerId, { inVoice: memberInVoice === true, streamId: streamId ?? null });
        reconcile();
    });
    api.onHostChanged(info => {
        hostId = info?.peerId ?? null;
        reconcile();
    });
    api.onPeerLeft(({ peerId } = {}) => {
        members.delete(peerId);
        reconcile();
    });

    window.voice = {
        async join() {
            if (inVoice) return;
            await refreshHost();
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            inVoice = true;
            await api.setVoice({ inVoice: true, streamId: localStream.id });
            reconcile();
        },
        async leave() {
            inVoice = false;
            for (const peerId of [...connections.keys()]) closeConnection(peerId);
            relayed.clear();
            for (const trackId of [...players.keys()]) stopPlay(trackId);
            if (localStream) for (const track of localStream.getTracks()) track.stop();
            localStream = null;
            await api.setVoice({ inVoice: false, streamId: null });
            changed();
        },
        setMuted(muted) {
            const track = localStream?.getAudioTracks()[0];
            if (track) track.enabled = !muted;
        },
        async stats() {
            const result = {};
            for (const entry of connections.values()) {
                for (const receiver of entry.pc.getReceivers()) {
                    const track = receiver.track;
                    if (!track || track.kind !== 'audio' || !entry.remote.has(track.id)) continue;
                    const origin = peerForStream(entry.remote.get(track.id));
                    if (origin === null) continue;
                    const report = await receiver.getStats();
                    for (const s of report.values()) {
                        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
                            result[origin] = { bytesReceived: s.bytesReceived ?? 0, audioLevel: s.audioLevel ?? 0 };
                        }
                    }
                }
            }
            return result;
        },
        onChange(callback) {
            if (typeof callback === 'function') listeners.push(callback);
        },
        // State for tests and step 5.
        state() {
            return {
                self: selfId,
                host: hostId,
                inVoice,
                members: Object.fromEntries(members),
                connections: [...connections.keys()]
            };
        }
    };
})();
