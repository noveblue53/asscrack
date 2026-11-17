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
    // While muted, each sender of the own track sends no track (replaceTrack(null)).
    let muted = false;
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
        if (selfId === null || hostId === null) return [];
        // The host relays for the voice members, also when its own user is not in voice.
        if (isHost()) return [...members].filter(([, s]) => s.inVoice).map(([peerId]) => peerId);
        if (!inVoice || !localStream) return [];
        return [hostId];
    }

    // Chromium pulls the received audio, also for the relay, only while a media element plays it.
    // A host that is not in voice plays the relayed audio at volume 0.
    function setPlayVolume() {
        for (const audio of players.values()) audio.volume = inVoice ? 1 : 0;
    }

    function play(track, stream) {
        if (players.has(track.id)) return;
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.volume = inVoice ? 1 : 0;
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

    function createConnection(peerId, { withTrack = true } = {}) {
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
                // The connection can be replaced while the offer is made.
                if (connections.get(peerId) !== entry) return;
                signal(peerId, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
            } catch (err) {
                if (connections.get(peerId) === entry) console.warn('Negotiation failed:', err?.message ?? err);
            } finally {
                entry.makingOffer = false;
            }
        };
        pc.onicecandidate = ({ candidate }) => {
            if (candidate && connections.get(peerId) === entry) signal(peerId, { candidate: candidate.toJSON() });
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

        if (withTrack) addOwnTrack(entry);
        return entry;
    }

    function addOwnTrack(entry) {
        if (localStream) addSender(entry, localStream.getAudioTracks()[0], localStream);
    }

    // silent: the sender is made with no track (a muted member, relayed by the host).
    function addSender(entry, track, stream, silent = false) {
        if (!track || entry.senders.has(track.id)) return;
        const sender = entry.pc.addTrack(track, stream);
        entry.senders.set(track.id, sender);
        if (silent || (muted && isOwnTrack(track))) setSenderTrack(sender, null);
    }

    // Host only: stop or restart the relay of the track of a member that mutes or unmutes.
    function setRelayMuted(origin, memberMuted) {
        const relay = relayed.get(origin);
        if (!relay) return;
        for (const entry of connections.values()) {
            const sender = entry.senders.get(relay.track.id);
            if (sender) setSenderTrack(sender, memberMuted ? null : relay.track);
        }
    }

    function isOwnTrack(track) {
        return !!localStream && localStream.getAudioTracks()[0] === track;
    }

    function setSenderTrack(sender, track) {
        sender.replaceTrack(track).catch(err => console.warn('Replace track failed:', err?.message ?? err));
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
            if (own) {
                wanted.add(own.id);
                addSender(entry, own, localStream);
            }
            for (const [origin, { track, stream }] of relayed) {
                if (origin === peerId) continue;
                wanted.add(track.id);
                addSender(entry, track, stream, members.get(origin)?.muted === true);
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
        if (selfId === null) {
            try {
                await refreshHost();
            } catch (err) {
                console.warn('Host query failed:', err?.message ?? err);
                return;
            }
        }
        if (!wantedPeers().includes(peerId)) return;
        let entry = connections.get(peerId) ?? createConnection(peerId);
        try {
            if (data.description) {
                const description = data.description;
                const isOffer = description.type === 'offer';
                const offerCollision = isOffer && (entry.makingOffer || entry.pc.signalingState !== 'stable');
                entry.ignoreOffer = !entry.polite && offerCollision;
                if (entry.ignoreOffer) return;
                let deferTrack = false;
                if (offerCollision && !entry.pc.currentRemoteDescription) {
                    // Both nodes sent the first offer. Chromium can stop the ICE gathering of a connection that
                    // rolls back its first offer: the connection then stays in the state "new" for ever.
                    // The member (polite) starts again with a new connection. It answers first and adds its
                    // own track after the answer.
                    closeConnection(peerId);
                    entry = createConnection(peerId, { withTrack: false });
                    deferTrack = true;
                }
                const pc = entry.pc;
                await pc.setRemoteDescription(description);
                if (isOffer) {
                    await pc.setLocalDescription();
                    signal(peerId, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
                    if (deferTrack && connections.get(peerId) === entry) addOwnTrack(entry);
                }
            } else if (data.candidate) {
                try {
                    await entry.pc.addIceCandidate(data.candidate);
                } catch (err) {
                    if (!entry.ignoreOffer) console.warn('ICE candidate failed:', err?.message ?? err);
                }
            }
        } catch (err) {
            if (connections.get(peerId) === entry) console.warn('Signal handling failed:', err?.message ?? err);
        }
    }

    // All callers share one pending query. Signals that wait for it then continue in their arrival order.
    let hostQuery = null;
    function refreshHost() {
        if (!hostQuery) {
            hostQuery = api.getHost().then(info => {
                selfId = info.self;
                hostId = info.host?.peerId ?? null;
            }).finally(() => { hostQuery = null; });
        }
        return hostQuery;
    }

    // A host that is not in voice did not call join(). Get the own peer ID on the first event after the login.
    function reconcileWithIds() {
        if (selfId !== null) return reconcile();
        refreshHost().then(reconcile).catch(err => console.warn('Host query failed:', err?.message ?? err));
    }

    api.onSignal(data => { handleSignal(data); });
    api.onVoiceState(({ peerId, inVoice: memberInVoice, streamId, muted: memberMuted } = {}) => {
        const wasMuted = members.get(peerId)?.muted === true;
        const nowMuted = memberMuted === true;
        members.set(peerId, { inVoice: memberInVoice === true, streamId: streamId ?? null, muted: nowMuted });
        if (isHost() && wasMuted !== nowMuted) setRelayMuted(peerId, nowMuted);
        reconcileWithIds();
    });
    api.onHostChanged(info => {
        hostId = info?.peerId ?? null;
        reconcileWithIds();
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
            muted = false;
            inVoice = true;
            // A host that relayed before now plays the relayed audio at full volume.
            setPlayVolume();
            await api.setVoice({ inVoice: true, streamId: localStream.id });
            reconcile();
        },
        async leave() {
            inVoice = false;
            setPlayVolume();
            if (localStream) for (const track of localStream.getTracks()) track.stop();
            localStream = null;
            muted = false;
            // The host keeps the relay connections and removes its own track. A member closes its connection.
            reconcile();
            await api.setVoice({ inVoice: false, streamId: null });
            changed();
        },
        setMuted(muted_) {
            muted = muted_ === true;
            const track = localStream?.getAudioTracks()[0];
            if (!track) return;
            track.enabled = !muted;
            for (const entry of connections.values()) {
                const sender = entry.senders.get(track.id);
                if (sender) setSenderTrack(sender, muted ? null : track);
            }
            api.setVoice({ inVoice: true, streamId: localStream.id, muted })
                .catch(err => console.warn('Voice state send failed:', err?.message ?? err));
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
