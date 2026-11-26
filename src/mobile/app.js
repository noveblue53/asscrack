import { createBridgeTransport } from './transport.js';

const transport = createBridgeTransport();
const byId = id => document.getElementById(id);

const pairScreen = byId('pair-screen');
const appScreen = byId('app-screen');
const pairForm = byId('pair-form');
const pairTokenInput = byId('pair-token');
const pairLabelInput = byId('pair-label');
const pairError = byId('pair-error');
const pairSubmit = byId('pair-submit');

const roomTitle = byId('room-title');
const channelSubtitle = byId('channel-subtitle');
const connDot = byId('conn-dot');
const guardBanner = byId('guard-banner');
const emptyRoom = byId('empty-room');
const emptyOpenRooms = byId('empty-open-rooms');
const messagesEl = byId('messages');
const typingBar = byId('typing-bar');
const whisperBar = byId('whisper-bar');
const whisperLabel = byId('whisper-label');
const whisperClear = byId('whisper-clear');
const composer = byId('composer');
const msgInput = byId('msg-input');

const roomsDrawer = byId('rooms-drawer');
const roomsList = byId('rooms-list');
const channelsSection = byId('channels-section');
const channelsList = byId('channels-list');
const leaveRoomBtn = byId('leave-room-btn');

const membersDrawer = byId('members-drawer');
const membersBtn = byId('members-btn');
const membersList = byId('members-list');

const imageModal = byId('image-modal');
const imageModalImg = byId('image-modal-img');

const state = {
    savedRooms: [],
    activeRoom: null,
    channels: [],
    activeChannelId: 'general',
    messages: [],
    whispers: [],
    members: [],
    typingPeers: new Map(), // peerId -> name
    roomSwitchBlocked: false,
    blockReason: null,
    whisperTarget: null, // { peerId, name }
    selfPeerId: null,
    selfName: ''
};

let typingTimer = null;
let typingSent = false;

function showPairScreen(message = '') {
    appScreen.hidden = true;
    pairScreen.hidden = false;
    pairError.hidden = !message;
    pairError.textContent = message;
}

function showAppScreen() {
    pairScreen.hidden = true;
    appScreen.hidden = false;
}

function formatTime(ts) {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

function renderTopbar() {
    if (!state.activeRoom) {
        roomTitle.textContent = 'No room open';
        channelSubtitle.textContent = 'Select a saved room';
        emptyRoom.hidden = false;
        messagesEl.hidden = true;
        typingBar.hidden = true;
        composer.hidden = true;
        leaveRoomBtn.hidden = true;
    } else {
        roomTitle.textContent = state.activeRoom.name || 'Room';
        const ch = state.channels.find(c => c.id === state.activeChannelId);
        const chName = ch?.name || state.activeChannelId || 'general';
        channelSubtitle.textContent = state.activeRoom.topic ? `#${chName} — ${state.activeRoom.topic}` : `#${chName}`;
        emptyRoom.hidden = true;
        messagesEl.hidden = false;
        typingBar.hidden = false;
        composer.hidden = false;
        leaveRoomBtn.hidden = false;
    }

    if (state.roomSwitchBlocked) {
        guardBanner.hidden = false;
        guardBanner.textContent = state.blockReason || 'Room switching is locked while desktop is in a call or screen share.';
    } else {
        guardBanner.hidden = true;
        guardBanner.textContent = '';
    }

    membersBtn.textContent = `Peers (${state.members.length})`;
}

function renderRoomsAndChannels() {
    roomsList.replaceChildren();
    for (const room of state.savedRooms) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-item' + (state.activeRoom?.roomId === room.roomId ? ' active' : '');
        const label = document.createElement('span');
        label.textContent = room.name || room.roomId;
        btn.appendChild(label);
        if (state.activeRoom?.roomId === room.roomId) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = 'Active';
            btn.appendChild(badge);
        }
        btn.disabled = state.roomSwitchBlocked && state.activeRoom?.roomId !== room.roomId;
        btn.addEventListener('click', async () => {
            if (state.activeRoom?.roomId === room.roomId) {
                roomsDrawer.hidden = true;
                return;
            }
            try {
                await transport.openRoom(room.roomId);
                roomsDrawer.hidden = true;
            } catch (err) {
                guardBanner.hidden = false;
                guardBanner.textContent = err.message;
            }
        });
        li.appendChild(btn);
        roomsList.appendChild(li);
    }

    channelsSection.hidden = !state.activeRoom;
    channelsList.replaceChildren();
    for (const ch of state.channels) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-item' + (ch.id === state.activeChannelId ? ' active' : '');
        btn.textContent = `# ${ch.name || ch.id}`;
        btn.addEventListener('click', async () => {
            state.activeChannelId = ch.id;
            roomsDrawer.hidden = true;
            renderTopbar();
            try {
                const res = await transport.switchChannel(ch.id);
                state.messages = res.messages ?? [];
                renderMessages();
            } catch {
                // Keep existing view on error
            }
        });
        li.appendChild(btn);
        channelsList.appendChild(li);
    }
}

function renderMembers() {
    membersList.replaceChildren();
    for (const m of state.members) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-item';
        const left = document.createElement('span');
        const dot = document.createElement('span');
        const pState = m.presence?.state || 'available';
        dot.className = `presence-dot ${pState}`;
        left.appendChild(dot);
        const nameSpan = document.createElement('span');
        nameSpan.textContent = m.name || m.peerId?.slice(0, 8) || 'Peer';
        left.appendChild(nameSpan);
        if (m.presence?.note) {
            const noteSpan = document.createElement('span');
            noteSpan.className = 'muted';
            noteSpan.textContent = ` — ${m.presence.note}`;
            left.appendChild(noteSpan);
        }
        btn.appendChild(left);

        if (m.isHost) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = 'Host';
            btn.appendChild(badge);
        }

        if (m.peerId && m.peerId !== state.selfPeerId) {
            btn.addEventListener('click', () => {
                state.whisperTarget = { peerId: m.peerId, name: m.name || m.peerId.slice(0, 8) };
                renderWhisperBar();
                membersDrawer.hidden = true;
                msgInput.focus();
            });
        } else {
            btn.disabled = true;
        }
        li.appendChild(btn);
        membersList.appendChild(li);
    }
}

function renderWhisperBar() {
    if (!state.whisperTarget) {
        whisperBar.hidden = true;
        whisperLabel.textContent = '';
        msgInput.placeholder = 'Message...';
    } else {
        whisperBar.hidden = false;
        whisperLabel.textContent = `Whispering to ${state.whisperTarget.name}`;
        msgInput.placeholder = `Whisper to ${state.whisperTarget.name}...`;
    }
}

function renderTyping() {
    const names = [...state.typingPeers.values()].filter(Boolean);
    if (names.length === 0) {
        typingBar.textContent = '';
    } else if (names.length === 1) {
        typingBar.textContent = `${names[0]} is typing…`;
    } else {
        typingBar.textContent = `${names.join(', ')} are typing…`;
    }
}

function appendMessageElement(item) {
    const li = document.createElement('li');
    li.className = 'msg' + (item.own ? ' own' : '') + (item.isWhisper ? ' whisper' : '');
    if (item.id) li.dataset.msgId = item.id;

    const head = document.createElement('div');
    head.className = 'msg-head';
    const from = document.createElement('span');
    from.className = 'msg-from';
    from.textContent = item.isWhisper
        ? (item.own ? `Whisper to ${item.toName || 'peer'}` : `Whisper from ${item.from || 'peer'}`)
        : (item.from || 'Peer');
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(item.time);
    head.append(from, time);
    li.appendChild(head);

    if (item.text) {
        const body = document.createElement('div');
        body.className = 'msg-text';
        body.textContent = item.text;
        li.appendChild(body);
    }

    if (item.attachment?.kind === 'image' && item.attachment?.id) {
        const img = document.createElement('img');
        img.className = 'msg-preview';
        img.alt = item.attachment.name || 'Image preview';
        img.loading = 'lazy';
        img.src = transport.mediaUrl(item.attachment.id, item.id || '');
        img.addEventListener('click', () => {
            imageModalImg.src = img.src;
            imageModal.hidden = false;
        });
        img.addEventListener('error', () => {
            img.hidden = true;
        });
        li.appendChild(img);
    }

    messagesEl.appendChild(li);
}

function renderMessages() {
    const combined = [
        ...state.messages.filter(m => (m.channelId || 'general') === state.activeChannelId),
        ...state.whispers
    ].sort((a, b) => (a.time || 0) - (b.time || 0));

    messagesEl.replaceChildren();
    for (const item of combined) appendMessageElement(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function applySnapshot(snap) {
    if (!snap) return;
    state.savedRooms = snap.savedRooms ?? [];
    state.activeRoom = snap.activeRoom ?? null;
    state.channels = snap.channels ?? [{ id: 'general', name: 'general' }];
    state.activeChannelId = snap.activeChannelId || 'general';
    state.messages = snap.messages ?? [];
    state.members = snap.members ?? [];
    state.roomSwitchBlocked = snap.roomSwitchBlocked === true;
    state.blockReason = snap.blockReason ?? null;
    state.selfPeerId = snap.selfPeerId ?? null;
    state.selfName = snap.selfName ?? '';
    state.typingPeers.clear();
    renderTopbar();
    renderRoomsAndChannels();
    renderMembers();
    renderMessages();
    renderTyping();
}

transport.onEvent('connection', ({ state: cState }) => {
    connDot.className = 'conn-dot ' + (cState === 'connected' ? 'ok' : cState === 'reconnecting' ? 'warn' : '');
});

transport.onEvent('snapshot', applySnapshot);
transport.onEvent('room-opened', applySnapshot);
transport.onEvent('room-left', applySnapshot);

transport.onEvent('guard-changed', data => {
    state.roomSwitchBlocked = data?.roomSwitchBlocked === true;
    state.blockReason = data?.blockReason ?? null;
    renderTopbar();
    renderRoomsAndChannels();
});

transport.onEvent('message', msg => {
    if (!msg) return;
    if (!state.messages.some(m => m.id && m.id === msg.id)) {
        state.messages.push(msg);
    }
    if ((msg.channelId || 'general') === state.activeChannelId) {
        renderMessages();
    }
});

transport.onEvent('whisper', w => {
    if (!w) return;
    state.whispers.push({ ...w, isWhisper: true });
    renderMessages();
});

transport.onEvent('typing', data => {
    if (!data?.peerId) return;
    if (data.active) {
        state.typingPeers.set(data.peerId, data.name || data.peerId.slice(0, 8));
    } else {
        state.typingPeers.delete(data.peerId);
    }
    renderTyping();
});

transport.onEvent('channels', data => {
    if (Array.isArray(data?.channels)) {
        state.channels = data.channels;
        renderRoomsAndChannels();
        renderTopbar();
    }
});

transport.onEvent('members', data => {
    if (Array.isArray(data?.members)) {
        state.members = data.members;
        renderMembers();
        renderTopbar();
    }
});

transport.onEvent('topic', data => {
    if (state.activeRoom) {
        state.activeRoom.topic = data?.topic ?? '';
        renderTopbar();
    }
});

transport.onEvent('media-changed', () => {
    renderMessages();
});

transport.onEvent('revoked', () => {
    showPairScreen('This device was unpaired from desktop.');
});

transport.onEvent('bridge-stopped', () => {
    showPairScreen('Desktop mobile bridge was turned off.');
});

pairForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    pairError.hidden = true;
    pairSubmit.disabled = true;
    try {
        await transport.pair(pairTokenInput.value, pairLabelInput.value);
        pairTokenInput.value = '';
        await transport.connect();
        showAppScreen();
    } catch (err) {
        pairError.hidden = false;
        pairError.textContent = err.message;
    } finally {
        pairSubmit.disabled = false;
    }
});

composer.addEventListener('submit', async ev => {
    ev.preventDefault();
    const text = msgInput.value.trim();
    if (!text) return;
    msgInput.value = '';
    if (typingSent) {
        typingSent = false;
        clearTimeout(typingTimer);
        void transport.sendTyping(false).catch(() => {});
    }
    try {
        if (state.whisperTarget) {
            const target = state.whisperTarget;
            await transport.sendWhisper(target.peerId, text);
            state.whispers.push({
                id: `local-w-${Date.now()}`,
                from: state.selfName || 'You',
                toName: target.name,
                text,
                time: Date.now(),
                own: true,
                isWhisper: true
            });
            renderMessages();
        } else {
            await transport.sendMessage(text, state.activeChannelId);
        }
    } catch (err) {
        guardBanner.hidden = false;
        guardBanner.textContent = err.message;
    }
});

msgInput.addEventListener('input', () => {
    if (!state.activeRoom || state.whisperTarget) return;
    const hasText = msgInput.value.trim().length > 0;
    if (hasText && !typingSent) {
        typingSent = true;
        void transport.sendTyping(true).catch(() => {});
    }
    clearTimeout(typingTimer);
    if (hasText) {
        typingTimer = setTimeout(() => {
            typingSent = false;
            void transport.sendTyping(false).catch(() => {});
        }, 2500);
    } else if (typingSent) {
        typingSent = false;
        void transport.sendTyping(false).catch(() => {});
    }
});

byId('nav-btn').addEventListener('click', () => { roomsDrawer.hidden = false; });
byId('empty-open-rooms').addEventListener('click', () => { roomsDrawer.hidden = false; });
byId('rooms-close').addEventListener('click', () => { roomsDrawer.hidden = true; });
roomsDrawer.addEventListener('click', ev => { if (ev.target === roomsDrawer) roomsDrawer.hidden = true; });

membersBtn.addEventListener('click', () => { membersDrawer.hidden = false; });
byId('members-close').addEventListener('click', () => { membersDrawer.hidden = true; });
membersDrawer.addEventListener('click', ev => { if (ev.target === membersDrawer) membersDrawer.hidden = true; });

whisperClear.addEventListener('click', () => {
    state.whisperTarget = null;
    renderWhisperBar();
});

leaveRoomBtn.addEventListener('click', async () => {
    try {
        await transport.leaveRoom();
        roomsDrawer.hidden = true;
    } catch (err) {
        guardBanner.hidden = false;
        guardBanner.textContent = err.message;
    }
});

byId('logout-btn').addEventListener('click', async () => {
    await transport.logout();
    roomsDrawer.hidden = true;
    showPairScreen('Device unpaired.');
});

imageModal.addEventListener('click', () => {
    imageModal.hidden = true;
    imageModalImg.src = '';
});

async function boot() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('t');
    if (token) {
        window.history.replaceState({}, document.title, '/');
        try {
            await transport.pair(token);
        } catch (err) {
            showPairScreen(err.message);
            return;
        }
    }
    try {
        await transport.connect();
        showAppScreen();
    } catch {
        showPairScreen();
    }
}

void boot();
