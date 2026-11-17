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
function makeMessageItem(from, text, time) {
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
    item.dataset.time = String(Number(time) || 0);
    return item;
}

function addMessage(from, text, time) {
    messageList.appendChild(makeMessageItem(from, text, time));
    messageList.scrollTop = messageList.scrollHeight;
}

// Put a history line before the first line that is newer. Equal times keep the arrival sequence.
function insertMessage(from, text, time) {
    const item = makeMessageItem(from, text, time);
    const t = Number(item.dataset.time);
    const next = Array.from(messageList.children).find(li => Number(li.dataset.time) > t);
    messageList.insertBefore(item, next ?? null);
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
// The name from the hello line of each peer.
const peerNames = new Map();

function addPeer(peerId) {
    if (peerItems.has(peerId)) return;
    const item = makePeerLine(peerNames.get(peerId) ?? String(peerId).slice(0, 12), peerId);
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
window.asscrack.onPeerName(data => {
    if (typeof data.name !== 'string') return;
    peerNames.set(data.peerId, data.name);
    const item = peerItems.get(data.peerId);
    if (item) setPeerName(item, data.name);
});
window.asscrack.onMessage(data => {
    const item = peerItems.get(data.peerId);
    if (item && data.from) setPeerName(item, data.from);
    addMessage(data.from, data.text, data.time);
});
window.asscrack.onHistory(data => {
    const lines = Array.isArray(data?.messages) ? [...data.messages] : [];
    lines.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
    for (const line of lines) insertMessage(line.from, line.text, line.time);
    messageList.scrollTop = messageList.scrollHeight;
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

// ---- File transfers ----

const fileInput = document.getElementById('file-input');
const sendFileButton = document.getElementById('send-file');
const transferList = document.getElementById('transfers');

const RESULT_STATES = new Set(['done', 'failed', 'refused', 'cancelled']);
const transfers = new Map(); // `${offerId}|${peerId}` -> { item, state, direction }
const ownOffers = new Map(); // offerId -> { name, size }

function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function transferPeerName(peerId, from) {
    return peerNames.get(peerId) || (typeof from === 'string' && from) || String(peerId ?? '').slice(0, 12);
}

function makeSpan(className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = String(text ?? '');
    return span;
}

function makeButton(text, onClick) {
    const button = document.createElement('button');
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
}

async function callFile(fn, offerId) {
    try {
        return await fn(offerId);
    } catch (err) {
        status.textContent = `Error: ${err?.message ?? err}`;
        return false;
    }
}

function setTransferState(entry, state, text) {
    entry.state = state;
    entry.item.dataset.state = state;
    entry.item.querySelector('.state-text').textContent = String(text ?? state);
    const buttons = entry.item.querySelector('.buttons');
    buttons.replaceChildren();
    const offerId = entry.item.dataset.offerId;
    if (state === 'offered') {
        buttons.append(
            makeButton('Accept', async () => {
                setTransferState(entry, 'receiving', 'Receiving');
                const ok = await callFile(window.asscrack.acceptFile, offerId);
                if (ok !== true) setTransferResult(entry, 'failed', 'Failed: the offer is not available');
            }),
            makeButton('Refuse', () => {
                setTransferState(entry, 'refused', 'Refused');
                callFile(window.asscrack.refuseFile, offerId);
            })
        );
    } else if (state === 'receiving') {
        // Sender rows get no Cancel: cancelFile() cancels the full offer. The offer head has that Cancel.
        buttons.append(makeButton('Cancel', () => callFile(window.asscrack.cancelFile, offerId)));
    }
}

function getTransfer(offerId, peerId, direction, info = {}) {
    const key = `${offerId}|${peerId}`;
    let entry = transfers.get(key);
    if (entry) return entry;
    const item = document.createElement('li');
    item.className = 'transfer';
    item.dataset.offerId = String(offerId);
    item.dataset.peerId = String(peerId);
    item.dataset.direction = direction;
    const progress = document.createElement('progress');
    progress.max = Number(info.size) || 1;
    progress.value = 0;
    item.append(
        makeSpan('file-name', info.name),
        makeSpan('file-size', formatSize(info.size)),
        makeSpan('peer-name', `${direction === 'send' ? 'to' : 'from'} ${transferPeerName(peerId, info.from)}`),
        progress,
        makeSpan('state-text', ''),
        makeSpan('buttons', '')
    );
    transferList.appendChild(item);
    transferList.scrollTop = transferList.scrollHeight;
    entry = { item, state: null, direction };
    transfers.set(key, entry);
    return entry;
}

// The entry for a file event. The sender makes the item at the first event for each receiver.
function transferForEvent(data) {
    const direction = data.direction === 'receive' ? 'receive' : 'send';
    const own = ownOffers.get(data.offerId) ?? {};
    const entry = getTransfer(data.offerId, data.peerId, direction, {
        name: data.name ?? own.name,
        size: data.size ?? own.size
    });
    if (entry.state === null) setTransferState(entry, direction === 'send' ? 'sending' : 'receiving', direction === 'send' ? 'Sending' : 'Receiving');
    return entry;
}

function setTransferResult(entry, state, text) {
    if (RESULT_STATES.has(entry.state)) return;
    setTransferState(entry, state, text);
    entry.item.querySelector('.buttons').replaceChildren();
}

window.asscrack.onFileOffer(data => {
    const entry = getTransfer(data.offerId, data.peerId, 'receive', data);
    setTransferState(entry, 'offered', 'Offered');
});

window.asscrack.onFileProgress(data => {
    const entry = transferForEvent(data);
    if (RESULT_STATES.has(entry.state)) return;
    const progress = entry.item.querySelector('progress');
    progress.max = Number(data.size) || 1;
    progress.value = Number(data.bytes) || 0;
});

window.asscrack.onFileDone(data => {
    const entry = transferForEvent(data);
    const progress = entry.item.querySelector('progress');
    progress.value = progress.max;
    if (data.direction === 'receive') {
        const fileName = String(data.path ?? '').split(/[\\/]/).pop();
        setTransferResult(entry, 'done', `Saved as ${fileName}`);
    } else {
        setTransferResult(entry, 'done', 'Sent');
    }
});

window.asscrack.onFileFailed(data => setTransferResult(transferForEvent(data), 'failed', `Failed: ${data.reason ?? ''}`));
window.asscrack.onFileRefused(data => setTransferResult(transferForEvent({ ...data, direction: 'send' }), 'refused', 'Refused'));
window.asscrack.onFileCancelled(data => setTransferResult(transferForEvent(data), 'cancelled', 'Cancelled'));

function addOfferHead(offerId, name, peers) {
    const item = document.createElement('li');
    item.className = 'transfer offer-head';
    item.dataset.offerId = String(offerId);
    const buttons = makeSpan('buttons', '');
    if (peers > 0) {
        item.append(makeSpan('state-text', `Offered ${name} to ${peers} users`));
        buttons.append(makeButton('Cancel', async () => {
            buttons.replaceChildren();
            await callFile(window.asscrack.cancelFile, offerId);
            item.querySelector('.state-text').textContent = `Offered ${name}: cancelled`;
        }));
    } else {
        item.append(makeSpan('state-text', 'No other users in the room'));
    }
    item.append(buttons);
    transferList.appendChild(item);
    transferList.scrollTop = transferList.scrollHeight;
}

async function sendFile() {
    const file = fileInput.files?.[0];
    if (!file) {
        status.textContent = 'Error: select a file.';
        return;
    }
    fileInput.value = '';
    try {
        const result = await window.asscrack.offerFile(file);
        ownOffers.set(result.offerId, { name: result.name, size: result.size });
        addOfferHead(result.offerId, result.name, result.peers);
        status.textContent = '';
    } catch (err) {
        status.textContent = `Error: ${err?.message ?? err}`;
    }
}

sendFileButton.addEventListener('click', sendFile);
