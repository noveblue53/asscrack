const status = document.getElementById('status');
const loginButton = document.getElementById('login');
const usernameInput = document.getElementById('username');
const roomInput = document.getElementById('room');
const loginScreen = document.getElementById('login-screen');
const chatScreen = document.getElementById('chat-screen');
const peerList = document.getElementById('peers');
const messageList = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send');
const joinVoiceButton = document.getElementById('join-voice');
const leaveVoiceButton = document.getElementById('leave-voice');
const muteButton = document.getElementById('mute');
const voiceError = document.getElementById('voice-error');

let ownName = '';
const peerItems = new Map(); // peerId -> <li>

function formatTime(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Use textContent only for peer text.
function addMessage(from, text, time) {
    const item = document.createElement('li');
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = formatTime(time);
    const fromSpan = document.createElement('span');
    fromSpan.className = 'from';
    fromSpan.textContent = String(from ?? '');
    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.textContent = String(text ?? '');
    item.append(timeSpan, fromSpan, textSpan);
    messageList.appendChild(item);
    messageList.scrollTop = messageList.scrollHeight;
}

// A peer line: <li><span.name/><span.host/><span.voice/></li>. All text goes in with textContent.
function makePeerLine(name, title) {
    const item = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = String(name);
    const hostSpan = document.createElement('span');
    hostSpan.className = 'host-mark';
    hostSpan.textContent = 'host';
    hostSpan.hidden = true;
    const voiceSpan = document.createElement('span');
    voiceSpan.className = 'voice-state';
    voiceSpan.textContent = 'not in voice';
    item.append(nameSpan, hostSpan, voiceSpan);
    item.title = String(title);
    return item;
}

function setPeerName(item, name) {
    item.querySelector('.name').textContent = String(name);
}

let selfLine = null;

function addPeer(peerId) {
    if (peerItems.has(peerId)) return;
    const item = makePeerLine(String(peerId).slice(0, 12), peerId);
    item.dataset.peerId = String(peerId);
    peerItems.set(peerId, item);
    peerList.appendChild(item);
    updateVoiceView();
}

function removePeer(peerId) {
    const item = peerItems.get(peerId);
    if (!item) return;
    item.remove();
    peerItems.delete(peerId);
}

window.asscrack.onPeerDiscovered(data => console.log('peer-discovered', data));
window.asscrack.onPeerJoined(data => addPeer(data.peerId));
window.asscrack.onPeerLeft(data => removePeer(data.peerId));
window.asscrack.onMessage(data => {
    const item = peerItems.get(data.peerId);
    if (item && data.from) setPeerName(item, data.from);
    addMessage(data.from, data.text, data.time);
});

async function login() {
    const name = usernameInput.value.trim();
    const room = roomInput.value.trim();
    if (!name || !room) {
        status.textContent = 'Error: enter a username and a room.';
        return;
    }
    loginButton.disabled = true;
    try {
        await window.asscrack.login({ name, room });
        ownName = name;
        document.getElementById('chat-user').textContent = name;
        document.getElementById('chat-room').textContent = room;
        loginScreen.hidden = true;
        chatScreen.hidden = false;
        document.body.classList.add('chat');
        status.textContent = '';
        selfLine = makePeerLine(`${name} (you)`, name);
        selfLine.classList.add('self');
        peerList.prepend(selfLine);
        refreshHostInfo();
        updateVoiceView();
        messageInput.focus();
    } catch (err) {
        status.textContent = `Error: ${err?.message ?? err}`;
        loginButton.disabled = false;
    }
}

async function sendMessage() {
    const text = messageInput.value;
    if (!text.trim()) return;
    messageInput.value = '';
    addMessage(ownName, text, Date.now());
    status.textContent = peerItems.size === 0 ? 'No peers in this room yet.' : '';
    try {
        await window.asscrack.send(text);
    } catch (err) {
        status.textContent = `Error: ${err?.message ?? err}`;
    }
}

loginButton.addEventListener('click', login);
for (const input of [usernameInput, roomInput]) {
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') login();
    });
}
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendMessage();
});

// ---- Voice user interface ----

const SPEAKING_LEVEL = 0.01;
const STATS_INTERVAL_MS = 250;

let selfId = null;
let hostId = null;
let ownInVoice = false;
let ownMuted = false;
let joining = false;
let speaking = new Set(); // peerIds above SPEAKING_LEVEL in the last stats() read
let statsTimer = null;

function setVoiceState(item, text) {
    const span = item.querySelector('.voice-state');
    span.textContent = text;
    span.dataset.state = text;
}

function updateVoiceView() {
    const state = window.voice.state();
    const members = state.members ?? {};
    if (state.self) selfId = state.self;
    if (state.host !== undefined && state.host !== null) hostId = state.host;
    for (const [peerId, item] of peerItems) {
        item.querySelector('.host-mark').hidden = peerId !== hostId;
        let text = 'not in voice';
        if (members[peerId]?.inVoice) {
            if (members[peerId].muted) text = 'in voice (muted)';
            else text = speaking.has(peerId) ? 'speaking' : 'in voice';
        }
        setVoiceState(item, text);
    }
    if (selfLine) {
        selfLine.querySelector('.host-mark').hidden = selfId === null || selfId !== hostId;
        let text = 'not in voice';
        if (ownInVoice) text = ownMuted ? 'in voice (muted)' : 'in voice';
        setVoiceState(selfLine, text);
    }
    joinVoiceButton.hidden = ownInVoice;
    joinVoiceButton.disabled = joining;
    leaveVoiceButton.hidden = !ownInVoice;
    muteButton.hidden = !ownInVoice;
    muteButton.textContent = ownMuted ? 'Unmute' : 'Mute';
}

async function refreshHostInfo() {
    try {
        const info = await window.asscrack.getHost();
        selfId = info?.self ?? selfId;
        hostId = info?.host?.peerId ?? null;
    } catch (err) {
        console.warn('Host query failed:', err?.message ?? err);
    }
    updateVoiceView();
}

async function readStats() {
    try {
        const stats = await window.voice.stats();
        const next = new Set();
        for (const [peerId, s] of Object.entries(stats)) {
            if ((s?.audioLevel ?? 0) > SPEAKING_LEVEL) next.add(peerId);
        }
        speaking = next;
    } catch (err) {
        console.warn('Voice stats failed:', err?.message ?? err);
    }
    updateVoiceView();
}

function startStatsTimer() {
    if (statsTimer === null) statsTimer = setInterval(readStats, STATS_INTERVAL_MS);
}

function stopStatsTimer() {
    if (statsTimer !== null) clearInterval(statsTimer);
    statsTimer = null;
    speaking = new Set();
}

async function joinVoice() {
    if (joining || ownInVoice) return;
    joining = true;
    voiceError.textContent = '';
    updateVoiceView();
    try {
        await window.voice.join();
        ownInVoice = true;
        ownMuted = false;
        startStatsTimer();
    } catch (err) {
        voiceError.textContent = `Voice error: ${err?.message ?? err}`;
    } finally {
        joining = false;
        updateVoiceView();
    }
}

async function leaveVoice() {
    stopStatsTimer();
    ownInVoice = false;
    ownMuted = false;
    updateVoiceView();
    try {
        await window.voice.leave();
    } catch (err) {
        voiceError.textContent = `Voice error: ${err?.message ?? err}`;
    }
    updateVoiceView();
}

function toggleMute() {
    if (!ownInVoice) return;
    ownMuted = !ownMuted;
    window.voice.setMuted(ownMuted);
    updateVoiceView();
}

joinVoiceButton.addEventListener('click', joinVoice);
leaveVoiceButton.addEventListener('click', leaveVoice);
muteButton.addEventListener('click', toggleMute);
window.voice.onChange(updateVoiceView);
window.asscrack.onHostChanged(info => {
    hostId = info?.peerId ?? null;
    updateVoiceView();
});
window.asscrack.onVoiceState(() => updateVoiceView());
