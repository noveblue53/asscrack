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
// Escape: see the one Escape dispatcher at the end of this file.

function formatTime(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// The text of a chat line. A message with a quotation (quote.js) gets a quotation block. The text nodes keep all the
// characters, thus textContent is the message text (copy and find use it). The marks "> " are in span.qmark.
function fillMessageText(span, text) {
    const value = String(text ?? '');
    const parts = window.quoteCore?.split(value) ?? null;
    if (!parts) {
        span.textContent = value;
        return;
    }
    const block = document.createElement('span');
    block.className = 'quote';
    parts.quote.split(/(?<=\n)/).forEach((line, i) => {
        const lineSpan = document.createElement('span');
        lineSpan.className = i === 0 ? 'quote-head' : 'quote-line';
        const mark = document.createElement('span');
        mark.className = 'qmark';
        mark.textContent = line.slice(0, 2);
        lineSpan.append(mark, line.slice(2));
        block.append(lineSpan);
    });
    span.append(block);
    if (parts.rest) span.append(parts.rest);
}

// A message line: <li><span.from/><span.bubble-text><span.text/><span.time/><button.btn-quote/></span></li>.
// Use textContent only for peer text. The class "own" is for a line of this user.
// id: the network message id (data-id). An optimistic own line has no id.
// peerId: the peer ID of the sender (data-peer-id), when it is known. A history line has no peer ID.
function makeMessageItem(from, text, time, own = false, id = null, peerId = null) {
    const item = document.createElement('li');
    if (id !== null && id !== undefined && id !== '') item.dataset.id = String(id);
    if (typeof peerId === 'string' && peerId) item.dataset.peerId = peerId;
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
    fillMessageText(textSpan, text);
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = formatTime(time);
    // The visible Quote control. The context menu action 'quote' calls the same function. Not a tab stop:
    // the keyboard uses the row menu (Menu key or Shift+F10).
    const quoteButton = makeButton('Quote', () => quoteMessage(item), 'quote', 'btn-quote');
    quoteButton.tabIndex = -1;
    bubble.append(textSpan, timeSpan, quoteButton);
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

// The reading position, the resize behavior and the unread count are in reading.js (window.reading).
// The ids of the lines in the list. A live line and a history line with the same id are the same line.
const shownMessageIds = new Set();

// Add a line at the end. Returns the new <li>, or null when the id is already shown.
// The caller calls window.reading.beforeChange() and afterChange() around it.
function addMessage(from, text, time, own = false, id = null, peerId = null) {
    if (id !== null && id !== undefined && id !== '') {
        if (shownMessageIds.has(String(id))) return null;
        shownMessageIds.add(String(id));
    }
    const item = makeMessageItem(from, text, time, own, id, peerId);
    messageList.appendChild(item);
    groupWithPrevious(item);
    return item;
}

// Put a history line before the first line that is newer. Equal times keep the arrival sequence.
// Returns the new <li>, or null when the id is already shown.
function insertMessage(from, text, time, id = null) {
    if (id !== null && id !== undefined && id !== '') {
        if (shownMessageIds.has(String(id))) return null;
        shownMessageIds.add(String(id));
    }
    // A history line has no peer ID: a line with the name of this user shows as an own line.
    const item = makeMessageItem(from, text, time, String(from ?? '') === ownName, id);
    const t = Number(item.dataset.time);
    const items = Array.from(messageList.children);
    const next = items[window.readingCore.insertIndex(items.map(li => li.dataset.time), t)] ?? null;
    messageList.insertBefore(item, next);
    groupWithPrevious(item);
    groupWithPrevious(next);
    return item;
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
// The message is in the history of this computer. A host sends its history to each member, thus a peer can get the
// message later in a history replay.
const NO_PEERS_TEXT = 'No peers in this room yet. The message is in the local history. A peer that joins later can get it in a history replay.';

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
    const state = window.reading.beforeChange();
    const line = addMessage(data.from, data.text, data.time, false, data.id, data.peerId);
    if (line) window.reading.noteIncoming(line);
    window.reading.afterChange(state);
});
// A history event can come more than one time (each host election, each new session). Only lines with an id
// that is not shown go in. History lines are not unread. The first history with lines on an empty list
// starts at the newest line. A later history keeps the reading position.
let historyShown = false;
window.asscrack.onHistory(data => {
    const lines = window.readingCore.newHistoryLines(data?.messages, id => shownMessageIds.has(id));
    const first = !historyShown && lines.length > 0 && messageList.children.length === 0;
    const state = window.reading.beforeChange();
    let added = 0;
    for (const line of lines) if (insertMessage(line.from, line.text, line.time, line.id)) added++;
    if (lines.length > 0) historyShown = true;
    console.info(`History shown: ${added} lines`);
    if (first) window.reading.followLatest();
    else window.reading.afterChange(state);
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

// ---- Quote ----
// The quote of the next message: a snapshot (quoteCore.makeQuote) of one chat line, or null. The chip above the
// message box shows it. The remove button, or Escape with the focus in the composer, removes it.
const composer = document.getElementById('composer');
const quoteChip = document.getElementById('quote-chip');
const quoteFrom = document.getElementById('quote-from');
const quoteTime = document.getElementById('quote-time');
const quoteExcerpt = document.getElementById('quote-excerpt');
const quoteRemove = document.getElementById('quote-remove');
let pendingQuote = null;

// The names in the buddy list now (the own name too): two users can have the same name.
function buddyNames() {
    const names = selfLine ? [ownName] : [];
    for (const item of peerItems.values()) names.push(item.querySelector('.name').textContent);
    return names;
}

function setQuote(quote) {
    pendingQuote = quote;
    quoteChip.hidden = quote === null;
    if (quote === null) {
        quoteFrom.textContent = '';
        quoteTime.textContent = '';
        quoteExcerpt.textContent = '';
        return;
    }
    quoteFrom.textContent = quote.tag ? `${quote.from} (${quote.tag})` : quote.from;
    quoteTime.textContent = `at ${quote.clock}`;
    quoteExcerpt.textContent = quote.lines.join('\n');
    setNameColor(quoteChip, quote.from);
}

function removeQuote() {
    if (pendingQuote === null) return false;
    setQuote(null);
    messageInput.focus({ preventScroll: true });
    return true;
}

// Quote one chat line. The name, the peer ID and the text come from the row itself, not from a name search:
// with two buddies of the same name, the quote names the sender of this row. A peer tag shows when the name repeats.
function quoteMessage(row) {
    if (!row || row.parentElement !== messageList || !selfLine) return false;
    const textEl = row.querySelector('.text');
    if (!textEl) return false;
    const from = row.querySelector('.from')?.textContent ?? '';
    setQuote(window.quoteCore.makeQuote({
        from,
        peerId: row.dataset.peerId ?? null,
        repeats: window.quoteCore.nameRepeats(from, buddyNames()),
        clock: row.querySelector('.time')?.textContent ?? '',
        text: textEl.textContent
    }));
    messageInput.focus({ preventScroll: true });
    return true;
}

quoteRemove.addEventListener('click', removeQuote);

// Send the text of the message box, with the quote when there is one. The draft (the text and the quote) stays
// until the send is done: a failed send keeps it.
let sendBusy = false;
async function sendMessage() {
    if (sendBusy) return;
    const reply = messageInput.value;
    const quote = pendingQuote;
    if (!reply.trim()) {
        if (quote) status.textContent = 'Type a reply to the quote.';
        return;
    }
    const text = window.quoteCore.compose(quote, reply);
    sendBusy = true;
    let count;
    try {
        count = await window.asscrack.send(text);
    } catch (err) {
        status.textContent = `Not sent: ${err?.message ?? err}. The message stays in the message box.`;
        return;
    } finally {
        sendBusy = false;
    }
    // A change of the draft while the send ran stays.
    if (messageInput.value === reply) messageInput.value = '';
    if (pendingQuote === quote) setQuote(null);
    // An own send goes to the newest line on purpose.
    addMessage(ownName, text, Date.now(), true, null, selfId ?? topologySelf);
    window.reading.followLatest();
    const none = typeof count === 'number' ? count === 0 : peerItems.size === 0;
    status.textContent = none ? NO_PEERS_TEXT : '';
}

loginButton.addEventListener('click', login);
for (const input of [usernameInput, roomInput, publicAddressInput]) {
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') login();
    });
}
sendButton.addEventListener('click', sendMessage);
// Enter sends. Shift+Enter makes a new line. An IME composition keeps its Enter.
messageInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
    }
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

// action: the data-action value (an action name of menu.js). className: optional, else btn-<text>.
function makeButton(text, onClick, action = null, className = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className ?? `btn-${text.toLowerCase()}`;
    button.textContent = text;
    if (action) button.dataset.action = action;
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
    const key = transferKey(entry.item);
    if (entry.direction === 'send') {
        addSendCancel(entry, state);
    } else if (state === 'offered') {
        buttons.append(
            makeButton('Accept', () => acceptTransfer(key), 'accept'),
            makeButton('Refuse', () => refuseTransfer(key), 'refuse')
        );
    } else if (state === 'receiving') {
        buttons.append(makeButton('Cancel', () => cancelReceive(key), 'cancel-receive'));
    }
    updateNodeMap();
}

// A sender row of one receiver gets a Cancel button while the row is offered or sending.
// The button cancels the transfer to that receiver only.
function addSendCancel(entry, state) {
    if (entry.direction !== 'send' || (state !== 'offered' && state !== 'sending') || entry.cancelRequested) return;
    const key = transferKey(entry.item);
    entry.item.querySelector('.buttons').append(makeButton('Cancel', () => cancelToReceiver(key), 'cancel-receiver'));
}

// ---- Row actions ----
// One function for each action. The row buttons and the context menus (menu.js) call the same function.
// Each function finds the row data when it runs. It does nothing when the action is not possible now
// (for example a menu that stayed open after the transfer completed).

function transferKey(item) {
    return `${item.dataset.offerId}|${item.dataset.peerId}`;
}

// The entry of a key, or null when the row is gone.
function liveTransfer(key) {
    const entry = transfers.get(String(key));
    return entry && entry.item.isConnected ? entry : null;
}

async function acceptTransfer(key) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'receive' || entry.state !== 'offered') return false;
    setTransferState(entry, 'receiving', 'Receiving');
    const ok = await callFile(window.asscrack.acceptFile, entry.item.dataset.offerId);
    if (ok !== true) setTransferResult(entry, 'failed', 'Failed: the offer is not available');
    return ok === true;
}

function refuseTransfer(key) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'receive' || entry.state !== 'offered') return false;
    setTransferState(entry, 'refused', 'Refused');
    callFile(window.asscrack.refuseFile, entry.item.dataset.offerId);
    return true;
}

// Cancel of a file that this computer receives.
async function cancelReceive(key) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'receive' || entry.state !== 'receiving' || entry.cancelRequested) return false;
    entry.cancelRequested = true;
    try {
        await window.asscrack.cancelFile(entry.item.dataset.offerId);
        return true;
    } catch (err) {
        entry.cancelRequested = false;
        status.textContent = `Error: ${err?.message ?? err}`;
        return false;
    }
}

// Cancel of the transfer to one receiver (the offer ID and the peer ID of the row). The other receivers continue.
async function cancelToReceiver(key) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'send' || (entry.state !== 'offered' && entry.state !== 'sending')
        || entry.cancelRequested) return false;
    entry.cancelRequested = true;
    entry.item.querySelector('.buttons').replaceChildren();
    try {
        await window.asscrack.cancelFile(entry.item.dataset.offerId, entry.item.dataset.peerId);
        return true;
    } catch (err) {
        entry.cancelRequested = false;
        status.textContent = `Error: ${err?.message ?? err}`;
        addSendCancel(entry, entry.state);
        return false;
    }
}

// Cancel of the whole own offer (all receivers). This action is different from cancelToReceiver.
async function cancelWholeOffer(offerId) {
    const head = offerHeads.get(String(offerId));
    if (!head || !head.active || !head.item.isConnected) return false;
    head.active = false;
    head.item.querySelector('.buttons').replaceChildren();
    await callFile(window.asscrack.cancelFile, String(offerId));
    head.item.querySelector('.state-text').textContent = `Offered ${head.name}: cancelled`;
    return true;
}

const REVEAL_TEXT = {
    missing: 'The file is not in its folder. It was moved or deleted.',
    unknown: 'This computer has no record of this received file.'
};

// Show in Explorer for a file that this computer received. The main process keeps the path.
async function revealTransfer(key) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'receive' || entry.state !== 'done' || !entry.revealable) return false;
    if (!hasApi('revealFile')) return false;
    try {
        const result = await window.asscrack.revealFile(String(key));
        if (result?.ok === true) return true;
        status.textContent = REVEAL_TEXT[result?.reason] ?? REVEAL_TEXT.unknown;
    } catch (err) {
        status.textContent = `Error: ${err?.message ?? err}`;
    }
    return false;
}

async function copyToClipboard(text, done) {
    try {
        await window.asscrack.copyText(String(text));
        status.textContent = done;
        return true;
    } catch (err) {
        status.textContent = `Copy failed: ${err?.message ?? err}`;
        return false;
    }
}

// The peer ID of a buddy line, or null when the line is not a current buddy line.
// A leaving line stays in the DOM for a short time, but peerItems does not have it.
function buddyId(row) {
    if (row && row === selfLine) return selfId ?? topologySelf ?? null;
    const peerId = row?.dataset?.peerId;
    return peerId && peerItems.get(peerId) === row ? peerId : null;
}

// Copy the display name of a buddy. The own line copies the name without "(you)".
function copyBuddyName(row) {
    if (row && row === selfLine) return copyToClipboard(ownName, 'Name copied.');
    if (buddyId(row) === null) return false;
    return copyToClipboard(row.querySelector('.name').textContent, 'Name copied.');
}

// Open the map and mark the node of the peer ID (not of the name: two users can have the same name).
function showBuddyOnMap(peerId) {
    const self = selfId ?? topologySelf;
    if (!peerId || (peerId !== self && !peerItems.has(peerId))) return false;
    setMapOpen(true);
    updateNodeMap();
    if (window.nodeMap?.highlight?.(peerId)) return true;
    status.textContent = 'This buddy is not on the network map yet.';
    return false;
}

// Copy the body of a chat line (not the name and not the time).
function copyMessageText(row) {
    if (!row || row.parentElement !== messageList) return false;
    return copyToClipboard(row.querySelector('.text')?.textContent ?? '', 'Message copied.');
}

// The data of a row for menu.js (menuCore.actionsFor), from the state now. null: the row has no menu now.
function rowInfo(row) {
    if (!row || !row.isConnected) return null;
    if (row.parentElement === peerList) {
        if (row === selfLine) return { kind: 'buddy', self: true, onMap: buddyId(row) !== null };
        return buddyId(row) === null ? null : { kind: 'buddy', self: false, onMap: true };
    }
    if (row.parentElement === messageList) {
        return { kind: 'message', quotable: selfLine !== null && row.querySelector('.text') !== null };
    }
    if (row.parentElement === transferList) {
        if (row.classList.contains('offer-head')) {
            const head = offerHeads.get(row.dataset.offerId);
            return head && head.item === row ? { kind: 'offer', active: head.active } : null;
        }
        const entry = liveTransfer(transferKey(row));
        if (!entry || entry.item !== row) return null;
        return {
            kind: 'transfer',
            direction: entry.direction,
            state: entry.state,
            cancelRequested: entry.cancelRequested === true,
            revealable: entry.revealable === true && hasApi('revealFile')
        };
    }
    return null;
}

// Run one action (an action name of menu.js) on a row. Each action checks the state again.
function runRowAction(action, row) {
    switch (action) {
        case 'copy-name': return copyBuddyName(row);
        case 'show-on-map': return showBuddyOnMap(buddyId(row));
        case 'copy-message': return copyMessageText(row);
        case 'quote': return quoteMessage(row);
        case 'accept': return acceptTransfer(transferKey(row));
        case 'refuse': return refuseTransfer(transferKey(row));
        case 'cancel-receive': return cancelReceive(transferKey(row));
        case 'cancel-receiver': return cancelToReceiver(transferKey(row));
        case 'cancel-offer': return cancelWholeOffer(row.dataset.offerId);
        case 'reveal': return revealTransfer(transferKey(row));
        default: return false;
    }
}

window.roomActions = Object.freeze({
    rowInfo,
    run: runRowAction,
    notice: text => {
        status.textContent = String(text);
    }
});

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
        // Only a completed local receive gets Show in Explorer. setTransferResult does nothing for a row that
        // already has a result, so check the state.
        if (entry.state === 'done' && typeof data.path === 'string' && data.path) {
            entry.revealable = true;
            if (hasApi('revealFile')) {
                const key = transferKey(entry.item);
                entry.item.querySelector('.buttons').append(
                    makeButton('Show in Explorer', () => revealTransfer(key), 'reveal', 'btn-reveal'));
            }
        }
    } else {
        setTransferResult(entry, 'done', 'Sent');
    }
});

window.asscrack.onFileFailed(data => setTransferResult(transferForEvent(data), 'failed', `Failed: ${data.reason ?? ''}`));
window.asscrack.onFileRefused(data => setTransferResult(transferForEvent({ ...data, direction: 'send' }), 'refused', 'Refused'));
window.asscrack.onFileCancelled(data => setTransferResult(transferForEvent(data), 'cancelled', 'Cancelled'));

// offerId -> { item, name, active }: the head line of each own offer. active: the whole-offer Cancel is available.
const offerHeads = new Map();

function addOfferHead(offerId, name, peers) {
    const item = document.createElement('li');
    item.className = 'transfer offer-head';
    item.dataset.offerId = String(offerId);
    const buttons = makeSpan('buttons', '');
    offerHeads.set(String(offerId), { item, name, active: peers > 0 });
    if (peers > 0) {
        const head = makeSpan('state-text', `Offered ${name} to ${peers} users`);
        head.title = head.textContent;
        item.append(head);
        buttons.append(makeButton('Cancel', () => cancelWholeOffer(offerId), 'cancel-offer'));
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

// ---- The one Escape dispatcher ----
// Escape closes only the top layer, in this sequence: the context menu (menu.js), the View menu and the Buddies
// drawer (layout.js), the find bar (find.js, it puts the list back at its old position), the quote chip (only with
// the focus in the composer), the invite panel, the map. The View menu and the drawer stop their own Escape when the focus is
// in them. A separator drag stops its Escape in the capture phase on window. Then this listener gets no event.
function focusIsIn(element) {
    const active = document.activeElement;
    return !active || active === document.body || element.contains(active);
}

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (window.contextMenu?.isOpen()) {
        e.preventDefault();
        window.contextMenu.close(true);
        return;
    }
    if (window.layout?.closeTopLayer()) {
        e.preventDefault();
        return;
    }
    if (window.findBar?.isOpen()) {
        e.preventDefault();
        window.findBar.close();
        return;
    }
    if (pendingQuote !== null && composer.contains(document.activeElement)) {
        e.preventDefault();
        removeQuote();
        return;
    }
    if (!invitePanel.hidden) {
        e.preventDefault();
        const returnFocus = focusIsIn(invitePanel);
        setInvitePanelOpen(false);
        if (returnFocus && !inviteToggle.hidden) inviteToggle.focus({ preventScroll: true });
        return;
    }
    if (document.body.classList.contains('map-open')) {
        e.preventDefault();
        const returnFocus = focusIsIn(mapPanel);
        setMapOpen(false);
        if (returnFocus) mapToggle.focus({ preventScroll: true });
    }
});
