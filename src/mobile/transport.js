// Phase 2-ready transport adapter for the ASSCRACK Mobile Browser Client.
// Phase 1 uses the desktop-hosted HTTPS bridge (SSE + fetch POST).
// Phase 2 can swap in a browser js-libp2p adapter implementing this same interface.

const SSE_EVENTS = [
    'snapshot',
    'room-opened',
    'room-left',
    'message',
    'whisper',
    'typing',
    'channels',
    'peer-joined',
    'peer-left',
    'peer-name',
    'presence',
    'host-changed',
    'topic',
    'media-changed',
    'guard-changed',
    'revoked',
    'bridge-stopped'
];

export function createBridgeTransport({ baseUrl = '' } = {}) {
    const listeners = new Map(); // event -> Set<fn>
    let eventSource = null;
    let activeChannelId = 'general';
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let intentionalClose = false;

    function emit(event, data) {
        const set = listeners.get(event);
        if (!set) return;
        for (const fn of set) {
            try { fn(data); } catch { /* ignore */ }
        }
    }

    function onEvent(event, fn) {
        if (typeof fn !== 'function') return () => {};
        let set = listeners.get(event);
        if (!set) {
            set = new Set();
            listeners.set(event, set);
        }
        set.add(fn);
        return () => offEvent(event, fn);
    }

    function offEvent(event, fn) {
        listeners.get(event)?.delete(fn);
    }

    async function requestJson(path, { method = 'GET', body = undefined } = {}) {
        const opts = {
            method,
            credentials: 'same-origin',
            headers: {}
        };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(`${baseUrl}${path}`, opts);
        let data = null;
        try {
            data = await res.json();
        } catch {
            data = null;
        }
        if (!res.ok) {
            const err = new Error(data?.error || `Request failed (${res.status})`);
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    async function pair(token, label = '') {
        return requestJson('/api/pair', {
            method: 'POST',
            body: { token: String(token || '').trim(), label: String(label || '').trim() }
        });
    }

    async function getSession() {
        return requestJson('/api/session');
    }

    function stopStream() {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    }

    function openStream() {
        stopStream();
        intentionalClose = false;
        const es = new EventSource(`${baseUrl}/api/events`, { withCredentials: true });
        eventSource = es;

        es.onopen = () => {
            reconnectAttempt = 0;
            emit('connection', { state: 'connected' });
        };

        for (const type of SSE_EVENTS) {
            es.addEventListener(type, ev => {
                let data = null;
                try { data = JSON.parse(ev.data); } catch { data = null; }
                if (type === 'revoked' || type === 'bridge-stopped') {
                    intentionalClose = true;
                    stopStream();
                }
                emit(type, data);
            });
        }

        es.onerror = () => {
            if (intentionalClose) return;
            stopStream();
            emit('connection', { state: 'reconnecting' });
            const delayMs = Math.min(15000, 1000 * Math.pow(1.6, reconnectAttempt++));
            reconnectTimer = setTimeout(() => {
                if (!intentionalClose) openStream();
            }, delayMs);
        };
    }

    async function connect() {
        const session = await getSession();
        openStream();
        return session;
    }

    function disconnect() {
        intentionalClose = true;
        stopStream();
        emit('connection', { state: 'disconnected' });
    }

    async function logout() {
        disconnect();
        try {
            await requestJson('/api/logout', { method: 'POST', body: {} });
        } catch {
            // Ignore if already unauthenticated
        }
    }

    async function getRooms() {
        return requestJson('/api/rooms');
    }

    async function openRoom(roomId) {
        return requestJson('/api/rooms/open', { method: 'POST', body: { roomId } });
    }

    async function leaveRoom() {
        return requestJson('/api/rooms/leave', { method: 'POST', body: {} });
    }

    async function getMessages(channelId = activeChannelId) {
        const q = encodeURIComponent(channelId || 'general');
        return requestJson(`/api/messages?channelId=${q}`);
    }

    async function switchChannel(channelId) {
        activeChannelId = channelId || 'general';
        return getMessages(activeChannelId);
    }

    async function sendMessage(text, channelId = activeChannelId) {
        return requestJson('/api/messages', {
            method: 'POST',
            body: { text, channelId: channelId || 'general' }
        });
    }

    async function sendWhisper(peerId, text) {
        return requestJson('/api/whispers', {
            method: 'POST',
            body: { peerId, text }
        });
    }

    async function sendTyping(active) {
        return requestJson('/api/typing', {
            method: 'POST',
            body: { active: active === true }
        });
    }

    function mediaUrl(id, messageId = '') {
        const q = messageId ? `?messageId=${encodeURIComponent(messageId)}` : '';
        return `${baseUrl}/api/media/${encodeURIComponent(id)}${q}`;
    }

    return {
        connect,
        disconnect,
        pair,
        logout,
        getSession,
        getRooms,
        openRoom,
        leaveRoom,
        getMessages,
        switchChannel,
        sendMessage,
        sendWhisper,
        sendTyping,
        mediaUrl,
        onEvent,
        offEvent
    };
}
