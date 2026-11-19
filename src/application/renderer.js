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

const statusBar = document.getElementById('statusbar');
const peerCount = document.getElementById('peer-count');
const transferCount = document.getElementById('transfer-count');
const mapToggle = document.getElementById('map-toggle');
const mapPanel = document.getElementById('map-panel');
const mapClose = document.getElementById('map-close');

let ownName = '';
const peerItems = new Map(); // peerId -> <li>

// ---- View helpers ----

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const NAME_COLORS = 8; // The classes nc0 to nc7 in styles.css.
const GROUP_MS = 5 * 60 * 1000;
const PEER_OUT_MS = 180; // The time of the peer-out animation in styles.css.

// The same name always gets the same color class, in the buddy list and in the chat.
function nameColorClass(name) {
    let hash = 0;
    for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return `nc${hash % NAME_COLORS}`;
}

function setNameColor(element, name) {
    for (let i = 0; i < NAME_COLORS; i++) element.classList.remove(`nc${i}`);
    element.classList.add(nameColorClass(name));
}

function firstLetter(name) {
    const first = Array.from(String(name).trim())[0];
    return first ? first.toUpperCase() : '?';
}

function updatePeerCount() {
    peerCount.textContent = String(peerItems.size + (selfLine ? 1 : 0));
}

// The node map panel opens and closes with a CSS transition (body.map-open).
function setMapOpen(open) {
    document.body.classList.toggle('map-open', open);
    mapToggle.setAttribute('aria-expanded', String(open));
    mapPanel.setAttribute('aria-hidden', String(!open));
}

mapToggle.addEventListener('click', () => setMapOpen(!document.body.classList.contains('map-open')));
mapClose.addEventListener('click', () => setMapOpen(false));
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') setMapOpen(false);
});

function formatTime(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// A message line: <li><span.from/><span.bubble-text><span.text/><span.time/></span></li>.
// Use textContent only for peer text. The class "own" is for a line of this user.
function makeMessageItem(from, text, time, own = false) {
    const item = document.createElement('li');
    const fromText = String(from ?? '');
    if (own) item.classList.add('own');
    else item.classList.add(nameColorClass(fromText));
    const fromSpan = document.createElement('span');
    fromSpan.className = 'from';
    fromSpan.textContent = fromText;
    const bubble = document.createElement('span');
    bubble.className = 'bubble-text';
    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.textContent = String(text ?? '');
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = formatTime(time);
    bubble.append(textSpan, timeSpan);
    item.append(fromSpan, bubble);
    item.dataset.time = String(Number(time) || 0);
    return item;
}

// View only: a line that follows a line of the same user gets the class "cont" (no name line).
function groupWithPrevious(item) {
    if (!item) return;
    const prev = item.previousElementSibling;
    const same = Boolean(prev)
        && prev.classList.contains('own') === item.classList.contains('own')
        && prev.querySelector('.from').textContent === item.querySelector('.from').textContent
        && Math.abs(Number(item.dataset.time) - Number(prev.dataset.time)) < GROUP_MS;
    item.classList.toggle('cont', same);
}

// View only: when the list gets a new height (the transfer table opens), keep the newest line in view.
let messagesAtEnd = true;
messageList.addEventListener('scroll', () => {
    messagesAtEnd = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 24;
});
new ResizeObserver(() => {
    if (messagesAtEnd) messageList.scrollTop = messageList.scrollHeight;
}).observe(messageList);

function addMessage(from, text, time, own = false) {
    const item = makeMessageItem(from, text, time, own);
    messageList.appendChild(item);
    groupWithPrevious(item);
    messageList.scrollTop = messageList.scrollHeight;
}

// Put a history line before the first line that is newer. Equal times keep the arrival sequence.
function insertMessage(from, text, time) {
    // A history line has no peer ID: a line with the name of this user shows as an own line.
    const item = makeMessageItem(from, text, time, String(from ?? '') === ownName);
    const t = Number(item.dataset.time);
    const next = Array.from(messageList.children).find(li => Number(li.dataset.time) > t);
    messageList.insertBefore(item, next ?? null);
    groupWithPrevious(item);
    groupWithPrevious(next);
}

// A peer line: <li><span.avatar/><span.name/><span.host/><span.voice/></li>. All text goes in with textContent.
// The avatar is the buddy icon: the first letter of the name on a ball with the name color.
function makePeerLine(name, title, colorName = name) {
    const item = document.createElement('li');
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = firstLetter(colorName);
    setNameColor(item, colorName);
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
    item.append(avatar, nameSpan, hostSpan, voiceSpan);
    item.title = String(title);
    return item;
}

function setPeerName(item, name) {
    item.querySelector('.name').textContent = String(name);
    item.querySelector('.avatar').textContent = firstLetter(name);
    setNameColor(item, name);
    updateNodeMap();
}

let selfLine = null;
// The name from the hello line of each peer.
const peerNames = new Map();

// The status line after a send with no peer. A peer that joins makes this text false, so addPeer removes it.
const NO_PEERS_TEXT = 'No peers in this room yet.';

function addPeer(peerId) {
    if (peerItems.has(peerId)) return;
    const item = makePeerLine(peerNames.get(peerId) ?? String(peerId).slice(0, 12), peerId);
    item.dataset.peerId = String(peerId);
    peerItems.set(peerId, item);
    peerList.appendChild(item);
    if (status.textContent === NO_PEERS_TEXT) status.textContent = '';
    updatePeerCount();
    updateVoiceView();
}

function removePeer(peerId) {
    const item = peerItems.get(peerId);
    if (!item) return;
    peerItems.delete(peerId);
    updatePeerCount();
    updateNodeMap();
    if (reducedMotion.matches) {
        item.remove();
        return;
    }
    // View only: the line moves out, then it goes away.
    item.classList.add('leaving');
    setTimeout(() => item.remove(), PEER_OUT_MS);
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
    console.info(`History shown: ${lines.length} lines`);
    messageList.scrollTop = messageList.scrollHeight;
});

// ---- Room type on the login screen ----

const roomTypeSelect = document.getElementById('room-type');
const roomField = document.getElementById('room-field');
const inviteField = document.getElementById('invite-field');
const inviteInput = document.getElementById('invite-input');
const publicAddressField = document.getElementById('public-address-field');
const publicAddressInput = document.getElementById('public-address');

function showRoomType() {
    const type = roomTypeSelect.value;
    roomField.hidden = type === 'join';
    inviteField.hidden = type !== 'join';
    publicAddressField.hidden = type === 'lan';
}
roomTypeSelect.addEventListener('change', showRoomType);
showRoomType();

let internetRoom = false;

async function login() {
    const name = usernameInput.value.trim();
    const type = roomTypeSelect.value;
    let room = roomInput.value.trim();
    const invite = inviteInput.value.trim();
    const publicAddress = publicAddressInput.value.trim();
    if (!name || (type !== 'join' && !room)) {
        status.textContent = 'Error: enter a username and a room.';
        return;
    }
    if (type === 'join' && !invite) {
        status.textContent = 'Error: enter a username and an invite code.';
        return;
    }
    const options = { name, room };
    if (type === 'join') options.invite = invite;
    if (type !== 'lan') {
        options.internet = true;
        if (publicAddress) options.publicAddress = publicAddress;
    }
    loginButton.disabled = true;
    try {
        const result = await window.asscrack.login(options);
        internetRoom = result?.internet === true || type !== 'lan';
        if (typeof result?.room === 'string' && result.room) room = result.room;
        ownName = name;
        document.getElementById('chat-user').textContent = name;
        document.getElementById('chat-room').textContent = room;
        loginScreen.hidden = true;
        chatScreen.hidden = false;
        document.body.classList.add('chat');
        status.textContent = '';
        // View only: the status text moves to the status band of the chat screen.
        statusBar.prepend(status);
        if (internetRoom) statusBar.querySelector('.net-note').textContent = 'Internet room';
        selfLine = makePeerLine(`${name} (you)`, name, name);
        selfLine.classList.add('self');
        peerList.prepend(selfLine);
        updatePeerCount();
        refreshHostInfo();
        refreshTopology();
        refreshFullNode();
        refreshInvite();
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
    addMessage(ownName, text, Date.now(), true);
    status.textContent = peerItems.size === 0 ? NO_PEERS_TEXT : '';
    try {
        await window.asscrack.send(text);
    } catch (err) {
        status.textContent = `Error: ${err?.message ?? err}`;
    }
}

loginButton.addEventListener('click', login);
for (const input of [usernameInput, roomInput, publicAddressInput]) {
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
    // No DOM write when the text is the same: the stats timer calls this 4 times each second.
    if (span.dataset.state === text) return;
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
    muteButton.setAttribute('aria-pressed', String(ownMuted));
    document.body.classList.toggle('in-voice', ownInVoice);
    updateNodeMap();
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
    button.type = 'button';
    button.className = `btn-${text.toLowerCase()}`;
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
    const stateSpan = entry.item.querySelector('.state-text');
    stateSpan.textContent = String(text ?? state);
    stateSpan.title = stateSpan.textContent;
    const buttons = entry.item.querySelector('.buttons');
    buttons.replaceChildren();
    const offerId = entry.item.dataset.offerId;
    if (entry.direction === 'send') {
        addSendCancel(entry, state);
    } else if (state === 'offered') {
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
        buttons.append(makeButton('Cancel', () => callFile(window.asscrack.cancelFile, offerId)));
    }
    updateNodeMap();
}

// A sender row of one receiver gets a Cancel button while the row is offered or sending.
// The button cancels the transfer to that receiver only.
function addSendCancel(entry, state) {
    if (entry.direction !== 'send' || (state !== 'offered' && state !== 'sending')) return;
    const peerId = entry.item.dataset.peerId;
    const offerId = entry.item.dataset.offerId;
    entry.item.querySelector('.buttons').append(makeButton('Cancel', async () => {
        entry.item.querySelector('.buttons').replaceChildren();
        try {
            await window.asscrack.cancelFile(offerId, peerId);
        } catch (err) {
            status.textContent = `Error: ${err?.message ?? err}`;
        }
    }));
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
    // The cell around the bar shows the percent text (data-pct, see showProgress).
    const progressCell = makeSpan('progress-cell', '');
    progressCell.append(progress);
    const fileName = makeSpan('file-name', info.name);
    fileName.title = fileName.textContent;
    const peerName = makeSpan('peer-name', `${direction === 'send' ? 'to' : 'from'} ${transferPeerName(peerId, info.from)}`);
    peerName.title = peerName.textContent;
    item.append(
        fileName,
        makeSpan('file-size', formatSize(info.size)),
        peerName,
        progressCell,
        makeSpan('state-text', ''),
        makeSpan('buttons', '')
    );
    transferList.appendChild(item);
    transferList.scrollTop = transferList.scrollHeight;
    entry = { item, state: null, direction };
    transfers.set(key, entry);
    transferCount.textContent = String(transfers.size);
    return entry;
}

// View only: the percent text on the progress bar.
function showProgress(progress) {
    const ratio = progress.max > 0 ? progress.value / progress.max : 0;
    progress.parentElement.dataset.pct = `${Math.floor(ratio * 100)}%`;
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
    showProgress(progress);
});

window.asscrack.onFileDone(data => {
    const entry = transferForEvent(data);
    const progress = entry.item.querySelector('progress');
    progress.value = progress.max;
    showProgress(progress);
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
        const head = makeSpan('state-text', `Offered ${name} to ${peers} users`);
        head.title = head.textContent;
        item.append(head);
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

// ---- Node map ----
// nodemap.js draws the map in #node-map. This part gives it the data at each change of the data.

let topologyLinks = {}; // peer ID -> the peer IDs that it has a chat session with
let topologyKinds = {}; // peer ID -> { peer ID: 'relay' | 'mesh' }, the link kinds that each peer reports
let fullNodeSelf = false; // true when this computer is a full node (getFullNode)
let fullNodePeers = new Set(); // the peer IDs of the full nodes (getFullNode, full-node events)
let topologySelf = null;

function setTopology(data) {
    if (data === null || typeof data !== 'object') return;
    if (data.links !== null && typeof data.links === 'object') topologyLinks = data.links;
    if (data.kinds !== null && typeof data.kinds === 'object') topologyKinds = data.kinds;
    if (typeof data.self === 'string') topologySelf = data.self;
    updateNodeMap();
}

async function refreshTopology() {
    try {
        setTopology(await window.asscrack.getTopology());
    } catch (err) {
        console.warn('Topology query failed:', err?.message ?? err);
    }
}

// The nodes are the lines of the buddy list. The voice data is the data of updateVoiceView().
// The transfers are the rows of this computer with the state sending or receiving.
function updateNodeMap() {
    if (!window.nodeMap || !selfLine) return;
    const voice = window.voice.state();
    const members = voice.members ?? {};
    const self = selfId ?? topologySelf;
    const nodes = [];
    if (self) {
        nodes.push({ id: self, name: ownName, color: nameColorClass(ownName), inVoice: voice.inVoice === true, muted: ownMuted, speaking: false, fullNode: fullNodeSelf });
    }
    for (const [peerId, item] of peerItems) {
        const name = item.querySelector('.name').textContent;
        nodes.push({
            id: peerId,
            name,
            color: nameColorClass(name),
            inVoice: members[peerId]?.inVoice === true,
            muted: members[peerId]?.muted === true,
            speaking: speaking.has(peerId),
            fullNode: fullNodePeers.has(peerId)
        });
    }
    const active = [];
    if (self) {
        for (const entry of transfers.values()) {
            if (entry.state !== 'sending' && entry.state !== 'receiving') continue;
            const { offerId, peerId } = entry.item.dataset;
            const id = `${offerId}|${peerId}`;
            active.push(entry.direction === 'send' ? { id, from: self, to: peerId } : { id, from: peerId, to: self });
        }
    }
    window.nodeMap.update({ self, host: hostId, nodes, links: topologyLinks, kinds: topologyKinds, transfers: active });
}

window.asscrack.onTopology(setTopology);

// ---- Internet room: full nodes and the invite code ----
// The calls of the new preload can be absent (old preload). Then the window works as a LAN window.

const inviteToggle = document.getElementById('invite-toggle');
const invitePanel = document.getElementById('invite-panel');
const inviteCode = document.getElementById('invite-code');
const copyInviteButton = document.getElementById('copy-invite');
const inviteNote = document.getElementById('invite-note');
const fullNodeState = document.getElementById('full-node-state');

const NO_FULL_NODE_TEXT = 'No invite code: this room has no address that the internet can reach. '
    + 'Log in again and type the public address of a forwarded TCP port, or turn on UPnP on the router.';
const UPNP_WAIT_TEXT = 'Asking the router to open a port. This can take up to 70 seconds. The code shows here when it is ready.';

function hasApi(name) {
    return typeof window.asscrack?.[name] === 'function';
}

function showFullNodeState() {
    let state = 'lan';
    let text = '';
    if (internetRoom) {
        const first = [...fullNodePeers].filter(id => peerItems.has(id)).sort()[0];
        if (fullNodeSelf) {
            state = 'self';
            text = 'This computer is a full node';
        } else if (first) {
            state = 'peer';
            text = `Full node: ${peerNames.get(first) ?? String(first).slice(0, 12)}`;
        } else {
            state = 'none';
            text = 'No full node';
        }
    }
    fullNodeState.dataset.state = state;
    fullNodeState.textContent = text;
    fullNodeState.hidden = state === 'lan';
}

async function refreshFullNode() {
    if (hasApi('getFullNode')) {
        try {
            const info = await window.asscrack.getFullNode();
            fullNodeSelf = info?.self === true;
            fullNodePeers = new Set(Array.isArray(info?.peers) ? info.peers.filter(id => typeof id === 'string') : []);
        } catch (err) {
            console.warn('Full node query failed:', err?.message ?? err);
        }
    }
    showFullNodeState();
    updateNodeMap();
}

function setInvitePanelOpen(open) {
    invitePanel.hidden = !open;
    inviteToggle.setAttribute('aria-expanded', String(open));
}

async function refreshInvite() {
    if (!hasApi('getInvite') || !selfLine) {
        inviteToggle.hidden = true;
        return;
    }
    try {
        const info = await window.asscrack.getInvite();
        if (info?.reason === 'lan') {
            inviteToggle.hidden = true;
            setInvitePanelOpen(false);
            return;
        }
        inviteToggle.hidden = false;
        if (typeof info?.code === 'string' && info.code) {
            inviteCode.value = info.code;
            inviteNote.textContent = '';
            copyInviteButton.disabled = false;
        } else {
            inviteCode.value = '';
            inviteNote.textContent = info?.reason === 'upnp-wait' ? UPNP_WAIT_TEXT
                : info?.reason === 'no-full-node' ? NO_FULL_NODE_TEXT : '';
            copyInviteButton.disabled = true;
        }
    } catch (err) {
        console.warn('Invite query failed:', err?.message ?? err);
    }
}

inviteToggle.addEventListener('click', () => {
    const open = invitePanel.hidden;
    setInvitePanelOpen(open);
    if (open) refreshInvite();
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') setInvitePanelOpen(false);
});
copyInviteButton.addEventListener('click', async () => {
    if (!inviteCode.value) return;
    try {
        await window.asscrack.copyText(inviteCode.value);
        inviteNote.textContent = 'Copied';
    } catch (err) {
        inviteNote.textContent = `Copy failed: ${err?.message ?? err}`;
    }
});

if (hasApi('onFullNode')) {
    window.asscrack.onFullNode(data => {
        if (typeof data?.peerId === 'string') {
            if (data.fullNode === true) fullNodePeers.add(data.peerId);
            else fullNodePeers.delete(data.peerId);
        }
        showFullNodeState();
        updateNodeMap();
        refreshFullNode();
        refreshInvite();
    });
}
if (hasApi('onFullNodeAddrs')) {
    window.asscrack.onFullNodeAddrs(() => refreshInvite());
}
// The UPnP result (mapped or none) changes the invite code or the note.
if (hasApi('onUpnp')) {
    window.asscrack.onUpnp(() => refreshInvite());
}
// The name of a full node can come later, and a full node can leave.
window.asscrack.onPeerName(() => showFullNodeState());
window.asscrack.onPeerLeft(() => showFullNodeState());
