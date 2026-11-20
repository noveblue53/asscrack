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
let idlePeerIds = new Set();
let selfIdle = false;
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
    peerCount.textContent = String([...peerItems.keys()].filter(id => !idlePeerIds.has(id)).length + (selfLine && !selfIdle ? 1 : 0));
}

// The node map panel opens and closes with a CSS transition (body.map-open).
function setMapOpen(open) {
    document.body.classList.toggle('map-open', open);
    if (!open) window.peerInspector?.close();
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
    item.classList.add(nameColorClass(fromText));
    const fromSpan = document.createElement('span');
    fromSpan.className = 'from';
    fromSpan.textContent = fromText;
    if (peerId) {
        fromSpan.classList.add('inspect-sender');
        fromSpan.addEventListener('click', () => window.peerInspector?.open(peerId));
    }
    const bubble = document.createElement('span');
    bubble.className = 'bubble-text';
    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    fillMessageText(textSpan, text);
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = formatTime(time);
    // The visible Quote control. It runs the row action 'quote', as the context menu does. Not a tab stop:
    // the keyboard uses the row menu (Menu key or Shift+F10).
    const quoteButton = makeButton('Quote', () => runRowAction('quote', item), 'quote', 'btn-quote');
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
    const same = Boolean(prev) && !prev.classList.contains('file-card') && !item.classList.contains('file-card')
        && prev.classList.contains('own') === item.classList.contains('own')
        && prev.querySelector('.from').textContent === item.querySelector('.from').textContent
        && Math.abs(Number(item.dataset.time) - Number(prev.dataset.time)) < GROUP_MS;
    item.classList.toggle('cont', same);
}

// Archive acknowledgements can arrive before the corresponding live row.
const savedMessageIds = new Set();
const messageDetails = document.getElementById('message-details');

function showArchiveFact() {
    if (!messageDetails?.open) return;
    const saved = savedMessageIds.has(messageDetails.dataset.messageId);
    document.getElementById('message-detail-archive').textContent = saved ? 'Saved on this device' : 'No local archive copy recorded';
}

function showMessageDetails(row) {
    if (row?.parentElement !== messageList || !row.querySelector('.text')) return false;
    messageDetails.dataset.messageId = row.dataset.id ?? '';
    document.getElementById('message-detail-author').textContent = row.querySelector('.from').textContent;
    document.getElementById('message-detail-time').textContent = new Date(Number(row.dataset.time)).toLocaleString();
    messageDetails.showModal();
    showArchiveFact();
    return true;
}

function noteSaved(id) {
    if (id === null || id === undefined || id === '') return;
    savedMessageIds.add(String(id));
    showArchiveFact();
}

function clearSavedMarks() {
    savedMessageIds.clear();
    showArchiveFact();
}
// Saved rooms (milestone 6): an own send with no accepting peer. The line is only in this window.
function markLocalOnly(item) {
    if (!item || item.classList.contains('local-only')) return;
    item.classList.add('local-only');
    const mark = document.createElement('span');
    mark.className = 'local-only-mark';
    mark.textContent = 'Only on this computer';
    const bubble = item.querySelector('.bubble-text');
    (bubble ?? item).appendChild(mark);
}

// The reading position, the resize behavior and the unread count are in reading.js (window.reading).
// The ids of the lines in the list. A live line and a history line with the same id are the same line.
const shownMessageIds = new Set();

// Add a line at the end. Returns the new <li>, or null when the id is already shown.
// The caller calls window.reading.beforeChange() and afterChange() around it.
function addMessage(from, text, time, own = false, id = null, peerId = null, channelId = 'general', attachment = null) {
    if (id !== null && id !== undefined && id !== '') {
        if (shownMessageIds.has(String(id))) return null;
        shownMessageIds.add(String(id));
    }
    const item = makeMessageItem(from, text, time, own, id, peerId);
    (window.roomChannels?.listFor(channelId) ?? messageList).appendChild(item);
    groupWithPrevious(item);
    if (attachment) window.chatAttachments?.decorate(item, attachment, own);
    return item;
}

// Put a history line before the first line that is newer. Equal times keep the arrival sequence.
// Returns the new <li>, or null when the id is already shown.
// own: true or false for a saved line (milestone 6). null: a line with the name of this user is an own line.
function insertMessage(from, text, time, id = null, own = null, channelId = 'general', attachment = null) {
    if (id !== null && id !== undefined && id !== '') {
        if (shownMessageIds.has(String(id))) return null;
        shownMessageIds.add(String(id));
    }
    // A history line has no peer ID: a line with the name of this user shows as an own line.
    const item = makeMessageItem(from, text, time, typeof own === 'boolean' ? own : String(from ?? '') === ownName, id);
    const t = Number(item.dataset.time);
    const list = window.roomChannels?.listFor(channelId) ?? messageList;
    const items = Array.from(list.children);
    const next = items[window.readingCore.insertIndex(items.map(li => li.dataset.time), t)] ?? null;
    list.insertBefore(item, next);
    groupWithPrevious(item);
    groupWithPrevious(next);
    if (attachment) window.chatAttachments?.decorate(item, attachment, attachment.source === selfId);
    return item;
}

// A peer line: <li><span.avatar/><span.name/><span.host/><span.voice/></li>. All text goes in with textContent.
// The avatar is the buddy icon: the first letter of the name on a ball with the name color.
function makePeerLine(name, title, colorName = name, self = false) {
    const item = document.createElement('li');
    const avatar = document.createElement(self ? 'button' : 'span');
    avatar.className = 'avatar';
    if (self) {
        avatar.type = 'button';
        avatar.setAttribute('aria-label', 'Edit your availability and status note');
        avatar.setAttribute('aria-haspopup', 'dialog');
        avatar.addEventListener('click', editAvailability);
    } else avatar.setAttribute('aria-hidden', 'true');
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
    item.append(avatar, nameSpan, hostSpan, voiceSpan, makePresenceMark());
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
// Saved rooms (milestone 6, decision P3): a send with no accepting peer is not in the history and not saved.
const NO_PEERS_TEXT = 'No peer got this message. It is only in this window. It is not saved, and a peer that joins later does not get it.';

function addPeer(peerId) {
    if (peerItems.has(peerId)) return;
    const item = makePeerLine(peerNames.get(peerId) ?? String(peerId).slice(0, 12), peerId);
    item.dataset.peerId = String(peerId);
    item.hidden = idlePeerIds.has(peerId);
    peerItems.set(peerId, item);
    peerList.appendChild(item);
    refreshFileRecipients();
    if (status.textContent === NO_PEERS_TEXT) status.textContent = '';
    updatePeerCount();
    updateVoiceView();
}

function removePeer(peerId) {
    const item = peerItems.get(peerId);
    if (!item) return;
    peerItems.delete(peerId);
    if (listeningDialog?.open && listeningDialog.dataset.peerId === peerId) listeningDialog.close();
    refreshFileRecipients();
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
    if (item) {
        setPeerName(item, data.name);
        refreshFileRecipients();
    }
});
window.asscrack.onMessage(data => {
    const item = peerItems.get(data.peerId);
    if (item && data.from) setPeerName(item, data.from);
    const state = window.reading.beforeChange();
    const line = addMessage(data.from, data.text, data.time, false, data.id, data.peerId, data.channelId, data.attachment);
    if (line && !window.idlePeer?.isIdle()) {
        window.roomAttention?.mention(data);
        if (window.roomChannels && !window.roomChannels.isViewing(data.channelId)) {
            window.roomChannels.missed(data.channelId);
            window.chatHighlights?.note(line, data.text, true);
            return;
        }
        const unread = window.reading.noteIncoming(line);
        if (!data.peerId || data.peerId !== (selfId ?? topologySelf)) window.chatHighlights?.note(line, data.text, unread);
    }
    window.reading.afterChange(state);
});
// A history event can come more than one time (each host election, each new session). Only lines with an id
// that is not shown go in. History lines are not unread. The first history with lines on an empty list
// starts at the newest line. A later history keeps the reading position.
const historyShown = new Set();
window.asscrack.onHistory(data => {
    const lines = window.readingCore.newHistoryLines(data?.messages, id => shownMessageIds.has(id));
    const activeChannel = window.roomChannels?.active() ?? 'general';
    const visible = lines.some(line => (line.channelId ?? 'general') === activeChannel);
    const first = visible && !historyShown.has(activeChannel) && messageList.children.length === 0;
    const state = window.reading.beforeChange();
    let added = 0;
    for (const line of lines) if (insertMessage(line.from, line.text, line.time, line.id, null, line.channelId, line.attachment)) added++;
    for (const line of lines) historyShown.add(line.channelId ?? 'general');
    console.info(`History shown: ${added} lines`);
    if (first) window.reading.followLatest();
    else if (visible) window.reading.afterChange(state);
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
    // Saved rooms (milestone 6): the save choice of a keyed room.
    if (window.savedRoomsUi) Object.assign(options, window.savedRoomsUi.loginOptions(type));
    loginButton.disabled = true;
    try {
        const result = await window.asscrack.login(options);
        internetRoom = result?.internet === true || type !== 'lan';
        if (typeof result?.room === 'string' && result.room) room = result.room;
        showChat(name, room);
        roomStarted(result);
    } catch (err) {
        status.textContent = `Error: ${err?.message ?? err}`;
        loginButton.disabled = false;
    }
}

// Show the chat screen for the user name and the room. The login and the reopen of a saved room use it.
function showChat(name, room) {
    ownName = name;
    window.chatHighlights?.setName(name);
    const heading = document.getElementById('chat-room');
    heading.textContent = room;
    heading.title = room;
    loginScreen.hidden = true;
    chatScreen.hidden = false;
    document.body.classList.add('chat');
    status.textContent = '';
    // View only: the status text moves to the status band of the chat screen.
    statusBar.prepend(status);
    if (internetRoom) statusBar.querySelector('.net-note').textContent = 'Internet room';
    if (!selfLine) {
        selfLine = makePeerLine(`${name} (you)`, name, name, true);
        selfLine.classList.add('self');
        peerList.prepend(selfLine);
    }
    updatePeerCount();
}

// After the node started: get the room state from the main process.
function roomStarted(result) {
    void window.roomChannels?.start();
    window.whispers?.refresh();
    refreshRoomTopic();
    startPresence();
    updatePeerCount();
    refreshHostInfo();
    refreshTopology();
    refreshFullNode();
    refreshInvite();
    updateVoiceView();
    messageInput.focus();
    // Saved rooms (milestone 6).
    if (window.savedRoomsUi) window.savedRoomsUi.roomStarted(result);
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

// A reserved whisper command must never become a public line or the caption of a room file.
function handleWhisperCommand(text) {
    if (!/^\/(?:w|msg|whisper)(?:\s|$)/i.test(text.trimStart())) return false;
    if (!window.whispers?.command) {
        status.textContent = 'Whispers are unavailable.';
    } else if (window.whispers.command(text) && messageInput.value === text) {
        messageInput.value = '';
    }
    return true;
}

// Send the text of the message box, with the quote when there is one. The draft (the text and the quote) stays
// until the send is done: a failed send keeps it.
let sendBusy = false;
async function sendMessage() {
    if (sendBusy || window.whispers?.isOpen?.()) return;
    const channelId = window.roomChannels?.active() ?? 'general';
    const reply = messageInput.value;
    const quote = pendingQuote;
    if (handleWhisperCommand(reply)) return;
    if (!quote && window.peerInspector?.command(reply)) {
        if (messageInput.value === reply) messageInput.value = '';
        return;
    }
    const command = !quote && /^\/(topic|away)(?:\s+([\s\S]*))?$/i.exec(reply.trim());
    if (command) {
        sendBusy = true;
        try {
            const argument = command[2] ?? '';
            const applied = command[1].toLowerCase() === 'topic'
                ? await submitTopic(argument) : await applyPresence({ state: 'away', note: cutNote(argument.trim()) });
            if (applied && messageInput.value === reply) messageInput.value = '';
        } finally { sendBusy = false; }
        return;
    }
    if (!reply.trim()) {
        if (quote) status.textContent = 'Type a reply to the quote.';
        return;
    }
    const text = window.quoteCore.compose(quote, reply);
    sendBusy = true;
    // Saved rooms (milestone 6): send returns the record { id, from, text, time, accepted }.
    let record;
    try {
        record = channelId === 'general' ? await window.asscrack.send(text) : await window.asscrack.send(text, channelId);
    } catch (err) {
        status.textContent = `Not sent: ${err?.message ?? err}. The message stays in the message box.`;
        return;
    } finally {
        sendBusy = false;
    }
    // A change of the draft while the send ran stays.
    const visible = !window.roomChannels || window.roomChannels.isViewing(channelId);
    if (visible) {
        if (messageInput.value === reply) messageInput.value = '';
        if (pendingQuote === quote) setQuote(null);
    } else window.roomChannels.sent(channelId, reply, quote);
    // An own send goes to the newest line on purpose.
    // Saved rooms (milestone 6): retain the local archive acknowledgement for Message details.
    if (record?.saved === true && record?.id) savedMessageIds.add(String(record.id));
    const line = addMessage(ownName, text, record?.time ?? Date.now(), true, record?.id ?? null, selfId ?? topologySelf, channelId);
    const count = record?.accepted;
    if (count === 0) markLocalOnly(line);
    if (visible) window.reading.followLatest();
    const none = typeof count === 'number' ? count === 0 : peerItems.size === 0;
    status.textContent = none ? NO_PEERS_TEXT : '';
    if (typeof record?.saveError === 'string' && record.saveError && window.savedRoomsUi) {
        window.savedRoomsUi.saveFailed({ id: record.id, reason: record.saveError });
    }
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
let monitorActive = false;
let lastMonitorView = '';

function publishMonitorView(state, speakers) {
    const view = { inVoice: ownInVoice, muted: ownMuted, transmitting: state.transmitting === true,
        speakers, theme: document.documentElement.dataset.theme || 'aero-classic' };
    const key = JSON.stringify(view);
    if (key === lastMonitorView) return;
    lastMonitorView = key;
    window.roomVoiceMonitor.publish(view);
}

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
    const speakers = monitorActive ? [] : null;
    if (state.self) selfId = state.self;
    if (state.host !== undefined && state.host !== null) hostId = state.host;
    for (const [peerId, item] of peerItems) {
        item.querySelector('.host-mark').hidden = peerId !== hostId;
        let text = 'not in voice';
        if (members[peerId]?.inVoice) {
            if (members[peerId].muted) text = 'in voice (muted)';
            else text = speaking.has(peerId) ? 'speaking' : 'in voice';
        }
        if (speakers && text === 'speaking') speakers.push(peerNames.get(peerId) || peerId.slice(-8));
        setVoiceState(item, text);
    }
    if (selfLine) {
        selfLine.querySelector('.host-mark').hidden = selfId === null || selfId !== hostId;
        let text = 'not in voice';
        // transmitting: the send gate of voice.js is open (voice activity or push to talk).
        if (ownInVoice) text = ownMuted ? 'in voice (muted)' : (state.transmitting ? 'speaking' : 'in voice');
        if (speakers && text === 'speaking') speakers.unshift('You');
        setVoiceState(selfLine, text);
    }
    joinVoiceButton.hidden = ownInVoice;
    joinVoiceButton.disabled = joining;
    leaveVoiceButton.hidden = !ownInVoice;
    muteButton.hidden = !ownInVoice;
    muteButton.textContent = ownMuted ? 'Unmute' : 'Mute';
    const ptt = document.getElementById('ptt-state');
    if (ptt) {
        ptt.hidden = !ownInVoice || state.inputMode !== 'ptt';
        ptt.dataset.held = String(state.pttHeld === true);
        ptt.textContent = state.pttHeld ? 'PTT held' : 'PTT released';
    }
    muteButton.setAttribute('aria-pressed', String(ownMuted));
    if (speakers) publishMonitorView(state, speakers);
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
        if (window.idlePeer?.isIdle()) return;
        window.roomAttention?.cue('join');
        ownInVoice = true;
        ownMuted = false;
        startStatsTimer();
    } catch (err) {
        if (err?.message !== 'Voice capture ended') voiceError.textContent = `Voice error: ${err?.message ?? err}`;
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
        window.roomAttention?.cue('leave');
    } catch (err) {
        voiceError.textContent = `Voice error: ${err?.message ?? err}`;
    }
    updateVoiceView();
}

function toggleMute() {
    if (!ownInVoice) return;
    ownMuted = !ownMuted;
    window.voice.setMuted(ownMuted);
    window.roomAttention?.cue(ownMuted ? 'mute' : 'unmute');
    updateVoiceView();
}

joinVoiceButton.addEventListener('click', joinVoice);
leaveVoiceButton.addEventListener('click', leaveVoice);
muteButton.addEventListener('click', toggleMute);
document.getElementById('detach-voice')?.addEventListener('click', () => window.roomVoiceMonitor?.open());
window.roomVoiceMonitor?.onActive(active => {
    monitorActive = active;
    lastMonitorView = '';
    if (active) updateVoiceView();
});
window.roomVoiceMonitor?.onMute(desired => { if (desired !== ownMuted) toggleMute(); });
window.addEventListener('asscrack-theme-changed', () => { if (monitorActive) updateVoiceView(); });
window.voice.onChange(updateVoiceView);
window.asscrack.onHostChanged(info => {
    hostId = info?.peerId ?? null;
    updateVoiceView();
});
window.asscrack.onVoiceState(() => updateVoiceView());

// ---- File transfers ----

const fileInput = document.getElementById('file-input');
const attachFileButton = document.getElementById('attach-file');
const fileDraft = document.getElementById('file-draft');
const fileDraftName = document.getElementById('file-draft-name');
const removeFileButton = document.getElementById('file-remove');
const fileRecipient = document.getElementById('file-recipient');
const sendFileButton = document.getElementById('send-file');
const transferList = document.getElementById('transfers');
const messagePanel = document.getElementById('message-panel');
let pendingFile = null;
let offeringFile = false;

const RESULT_STATES = new Set(['done', 'failed', 'refused', 'cancelled']);
const transfers = new Map(); // One entry per offer/peer, shared by the Transfers row and any incoming chat card.

function recipientLabel(peerId) {
    return `${peerNames.get(peerId) || 'Peer'} (${peerId.slice(-8)})`;
}

function refreshFileRecipients(selected = fileRecipient.value) {
    const roomOption = fileRecipient.firstElementChild;
    const peerIds = [...peerItems.keys()];
    // Removing a selected <option> would silently select the whole room for a private draft.
    if (selected !== 'room' && !peerItems.has(selected)) peerIds.push(selected);
    const options = peerIds.map(peerId => {
        const option = document.createElement('option');
        option.value = peerId;
        option.textContent = recipientLabel(peerId) + (peerItems.has(peerId) ? '' : ' — disconnected');
        option.title = peerId;
        return option;
    });
    fileRecipient.replaceChildren(roomOption, ...options);
    fileRecipient.value = selected;
}

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

function renderTransferActions(entry, row) {
    const buttons = row.querySelector('.buttons');
    const hadFocus = buttons.contains(document.activeElement);
    buttons.replaceChildren();
    const key = transferKey(entry.item);
    if (entry.cancelRequested) {
        if (hadFocus) row.focus({ preventScroll: true });
        return;
    }
    if (entry.direction === 'send' && (entry.state === 'offered' || entry.state === 'sending')) {
        buttons.append(makeButton('Cancel', () => cancelToReceiver(key), 'cancel-receiver'));
    } else if (entry.state === 'offered') {
        buttons.append(
            makeButton('Accept', () => acceptTransfer(key), 'accept'),
            makeButton('Refuse', () => refuseTransfer(key), 'refuse')
        );
    } else if (entry.state === 'receiving') {
        buttons.append(makeButton('Cancel', () => cancelReceive(key), 'cancel-receive'));
    } else if (entry.state === 'done' && entry.revealable && hasApi('revealFile')) {
        buttons.append(makeButton('Show in Explorer', () => revealTransfer(key), 'reveal', 'btn-reveal'));
    }
    if (hadFocus) (buttons.firstElementChild ?? row).focus({ preventScroll: true });
}

function setTransferState(entry, state, text) {
    entry.state = state;
    const render = row => {
        row.dataset.state = state;
        const stateSpan = row.querySelector('.state-text');
        stateSpan.textContent = text;
        stateSpan.title = text;
        renderTransferActions(entry, row);
    };
    render(entry.item);
    if (entry.card) window.reading.keepPosition(() => render(entry.card));
    if (entry.direction === 'send') updateOfferSummary(entry.item.dataset.offerId);
    if (entry.richOffer) window.chatAttachments?.changed(entry.richOffer);
    updateNodeMap();
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

async function refuseTransfer(key) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'receive' || entry.state !== 'offered') return false;
    setTransferState(entry, 'refusing', 'Refusing');
    const ok = await callFile(window.asscrack.refuseFile, entry.item.dataset.offerId);
    if (ok === true) setTransferResult(entry, 'refused', 'Refused');
    else setTransferResult(entry, 'failed', 'Failed: the offer is not available');
    return ok === true;
}

// Cancel of a file that this computer receives.
async function cancelReceive(key) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'receive' || entry.state !== 'receiving' || entry.cancelRequested) return false;
    entry.cancelRequested = true;
    setTransferState(entry, 'receiving', 'Cancelling');
    try {
        const ok = await window.asscrack.cancelFile(entry.item.dataset.offerId);
        if (!ok) throw new Error('Cancel is no longer available');
        return true;
    } catch (err) {
        entry.cancelRequested = false;
        if (entry.state === 'receiving') setTransferState(entry, 'receiving', 'Receiving');
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
    renderTransferActions(entry, entry.item);
    try {
        const ok = await window.asscrack.cancelFile(entry.item.dataset.offerId, entry.item.dataset.peerId);
        if (!ok) throw new Error('Cancel is no longer available');
        return true;
    } catch (err) {
        entry.cancelRequested = false;
        status.textContent = `Error: ${err?.message ?? err}`;
        renderTransferActions(entry, entry.item);
        return false;
    }
}

// Cancel of the whole own offer (all receivers). This action is different from cancelToReceiver.
async function cancelWholeOffer(offerId) {
    const head = offerHeads.get(String(offerId));
    if (!head || !head.active || !head.item.isConnected) return false;
    head.cancelRequested = true;
    updateOfferSummary(offerId);
    const ok = await callFile(window.asscrack.cancelFile, String(offerId));
    if (ok !== true) {
        head.cancelRequested = false;
        updateOfferSummary(offerId);
    }
    return ok === true;
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

const listeningDialog = document.getElementById('listening-dialog');
const listenerMuted = document.getElementById('listener-muted');
const listenerVolume = document.getElementById('listener-volume');
const listenerPercent = document.getElementById('listener-percent');

function showListening(row) {
    const id = buddyId(row);
    if (!id || !peerItems.has(id)) return false;
    const settings = window.voice.listeningFor(id);
    listeningDialog.dataset.peerId = id;
    document.getElementById('listening-title').textContent = `Listening to ${row.querySelector('.name').textContent}`;
    listenerMuted.checked = settings.muted;
    listenerVolume.value = String(settings.volume);
    listenerPercent.textContent = `${settings.volume}%`;
    listenerVolume.setAttribute('aria-valuetext', listenerPercent.textContent);
    listeningDialog.showModal();
    return true;
}

function changeListening() {
    const id = listeningDialog.dataset.peerId;
    if (!listeningDialog.open || !peerItems.has(id)) return;
    const volume = Number(listenerVolume.value);
    listenerPercent.textContent = `${volume}%`;
    listenerVolume.setAttribute('aria-valuetext', listenerPercent.textContent);
    window.voice.setListening(id, listenerMuted.checked, volume);
}

listenerMuted?.addEventListener('change', changeListening);
listenerVolume?.addEventListener('input', changeListening);

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
        if (row === selfLine) return { kind: 'buddy', inspect: Boolean(window.peerInspector), self: true, availability: Boolean(presenceControls), onMap: buddyId(row) !== null };
        return buddyId(row) === null ? null : { kind: 'buddy', inspect: Boolean(window.peerInspector), whisper: Boolean(window.whispers), self: false, onMap: true };
    }
    if (row.parentElement === messageList && !row.classList.contains('file-card')) {
        return { kind: 'message', details: Boolean(row.querySelector('.text')), inspect: Boolean(window.peerInspector && peerItems.has(row.dataset.peerId)), quotable: selfLine !== null && row.querySelector('.text') !== null };
    }
    if (row.parentElement === transferList || row.parentElement === messageList) {
        if (row.classList.contains('offer-head')) {
            const head = offerHeads.get(row.dataset.offerId);
            return head && head.item === row ? { kind: 'offer', active: head.active } : null;
        }
        const entry = liveTransfer(transferKey(row));
        if (!entry || (entry.item !== row && entry.card !== row)) return null;
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
        case 'inspect-peer': return window.peerInspector?.open(row.dataset.peerId || buddyId(row));
        case 'availability': return row === selfLine && editAvailability();
        case 'message-details': return showMessageDetails(row);
        case 'whisper': {
            const peerId = buddyId(row);
            return Boolean(peerId && row !== selfLine && window.whispers?.open(peerId));
        }
        case 'copy-name': return copyBuddyName(row);
        case 'listening': return showListening(row);
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
    rowInfo, editAvailability,
    run: runRowAction,
    notice: text => {
        status.textContent = String(text);
    }
});

function makeTransferRow(offerId, peerId, direction, info, className) {
    const item = document.createElement('li');
    item.className = className;
    item.dataset.offerId = String(offerId);
    item.dataset.peerId = String(peerId);
    item.dataset.direction = direction;
    const progress = document.createElement('progress');
    progress.setAttribute('aria-label', 'File transfer progress');
    progress.max = Number(info.size) || 1;
    progress.value = 0;
    // The cell around the bar shows the percent text (data-pct, see showProgress).
    const progressCell = makeSpan('progress-cell', '');
    progressCell.append(progress);
    showProgress(progress);
    const fileName = makeSpan('file-name', info.name);
    fileName.title = fileName.textContent;
    const peerName = makeSpan('peer-name', `${direction === 'send' ? 'to' : 'from'} ${transferPeerName(peerId, info.from)} (${String(peerId).slice(-8)})`);
    peerName.title = peerName.textContent;
    item.append(
        fileName,
        makeSpan('file-size', formatSize(info.size)),
        peerName,
        progressCell,
        makeSpan('state-text', ''),
        makeSpan('buttons', '')
    );
    return item;
}

function getTransfer(offerId, peerId, direction, info = {}) {
    const key = `${offerId}|${peerId}`;
    let entry = transfers.get(key);
    if (entry) return entry;
    const item = makeTransferRow(offerId, peerId, direction, info, 'transfer');
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
    const percent = `${Math.floor(ratio * 100)}%`;
    progress.parentElement.dataset.pct = percent;
    progress.setAttribute('aria-valuetext', percent);
}

// A file event can reach the window before the sender receives the IPC result with the recipient list.
function transferForEvent(data) {
    const direction = data.direction === 'receive' ? 'receive' : 'send';
    const entry = getTransfer(data.offerId, data.peerId, direction, data);
    if (entry.state === null || entry.state === 'offered') setTransferState(entry, direction === 'send' ? 'sending' : 'receiving', direction === 'send' ? 'Sending' : 'Receiving');
    return entry;
}

function setTransferResult(entry, state, text) {
    if (RESULT_STATES.has(entry.state)) return;
    entry.cancelRequested = false;
    setTransferState(entry, state, text);
}

window.asscrack.onFileOffer(data => {
    const entry = getTransfer(data.offerId, data.peerId, 'receive', data);
    if (entry.card || entry.state !== null) return;
    if (data.attachmentId && window.chatAttachments) {
        entry.richOffer = data;
        setTransferState(entry, 'offered', 'Offered');
        window.chatAttachments.offer(data, entry);
        return;
    }
    const reading = window.reading.beforeChange();
    entry.card = makeTransferRow(data.offerId, data.peerId, 'receive', data, 'file-card');
    entry.card.dataset.time = String(Date.now());
    (window.roomChannels?.listFor('general') ?? messageList).appendChild(entry.card);
    setTransferState(entry, 'offered', 'Offered');
    if (!window.idlePeer?.isIdle()) {
        if (!window.roomChannels || window.roomChannels.isViewing('general')) window.reading.noteIncoming(entry.card);
        else window.roomChannels.missed('general');
    }
    window.reading.afterChange(reading);
});

window.asscrack.onFileProgress(data => {
    const entry = transferForEvent(data);
    if (RESULT_STATES.has(entry.state)) return;
    for (const row of [entry.item, entry.card].filter(Boolean)) {
        const progress = row.querySelector('progress');
        progress.max = Number(data.size) || 1;
        progress.value = Number(data.bytes) || 0;
        showProgress(progress);
    }
});

window.asscrack.onFileDone(data => {
    const entry = transferForEvent(data);
    if (RESULT_STATES.has(entry.state)) return;
    for (const row of [entry.item, entry.card].filter(Boolean)) {
        const progress = row.querySelector('progress');
        progress.value = progress.max;
        showProgress(progress);
    }
    if (data.direction === 'receive') {
        const fileName = String(data.path ?? '').split(/[\\/]/).pop();
        entry.revealable = typeof data.path === 'string' && Boolean(data.path);
        setTransferResult(entry, 'done', `Saved as ${fileName}`);
    } else {
        entry.confirmed = data.confirmed === true;
        setTransferResult(entry, 'done', data.confirmed === true ? 'Delivered' : 'Sent (delivery unconfirmed)');
    }
});

window.asscrack.onFileFailed(data => setTransferResult(transferForEvent(data), 'failed', `Failed: ${data.reason ?? ''}`));
window.asscrack.onFileRefused(data => setTransferResult(transferForEvent({ ...data, direction: 'send' }), 'refused', 'Refused'));
window.asscrack.onFileCancelled(data => setTransferResult(transferForEvent(data), 'cancelled', 'Cancelled'));

const offerHeads = new Map();

function updateOfferSummary(offerId) {
    const head = offerHeads.get(offerId);
    if (!head) return;
    const counts = new Map();
    const labels = { offered: 'awaiting reply', sending: 'sending', refused: 'declined', failed: 'failed', cancelled: 'cancelled' };
    let pending = false;
    for (const entry of head.rows) {
        const label = entry.state === 'done' ? (entry.confirmed ? 'delivered' : 'sent (unconfirmed)') : labels[entry.state];
        counts.set(label, (counts.get(label) ?? 0) + 1);
        if (!RESULT_STATES.has(entry.state)) pending = true;
    }
    head.summary.textContent = [...counts].map(([label, n]) => `${n} ${label}`).join(' · ');
    head.active = pending && !head.cancelRequested;
    head.cancel.hidden = !head.active;
}

function addOfferHead(offer, recipientId) {
    const { offerId, name, recipients } = offer;
    const item = document.createElement('li');
    item.className = 'transfer offer-head';
    item.dataset.offerId = offerId;
    const audience = recipientId === undefined ? `${recipients.length} ${recipients.length === 1 ? 'user' : 'users'}` : recipientLabel(recipientId);
    const title = makeSpan('state-text', `Offered ${name} to ${audience}`);
    title.title = title.textContent;
    const summary = makeSpan('offer-summary', '');
    const buttons = makeSpan('buttons', '');
    const rows = [];
    const toggle = makeButton('Hide recipients', () => {
        const hide = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!hide));
        toggle.textContent = hide ? 'Show recipients' : 'Hide recipients';
        for (const entry of rows) entry.item.hidden = hide;
    }, null, 'offer-toggle');
    toggle.setAttribute('aria-expanded', 'true');
    const cancel = makeButton('Cancel', () => cancelWholeOffer(offerId), 'cancel-offer');
    buttons.append(toggle, cancel);
    item.append(title, summary, buttons);
    transferList.appendChild(item);
    for (const peerId of recipients) {
        // A fast response can precede the IPC offer result. Keep its state and fill in the original metadata.
        const entry = getTransfer(offerId, peerId, 'send', offer);
        const fileName = entry.item.querySelector('.file-name');
        fileName.textContent = name;
        fileName.title = name;
        entry.item.querySelector('.file-size').textContent = formatSize(offer.size);
        if (entry.state === null) setTransferState(entry, 'offered', 'Offered');
        transferList.appendChild(entry.item);
        rows.push(entry);
    }
    offerHeads.set(offerId, { item, rows, summary, cancel, active: true });
    updateOfferSummary(offerId);
    transferList.scrollTop = transferList.scrollHeight;
}

function updateFileDraft() {
    fileDraft.hidden = pendingFile === null;
    fileDraftName.textContent = pendingFile?.name ?? '';
    fileDraftName.title = fileDraftName.textContent;
    attachFileButton.disabled = offeringFile;
    removeFileButton.disabled = offeringFile;
    fileRecipient.disabled = offeringFile;
    sendFileButton.disabled = offeringFile;
    sendFileButton.textContent = offeringFile ? 'Preparing…' : (fileRecipient.value === 'room' ? 'Send file to room' : 'Send file');
}

function attachFile(file) {
    if (!file || offeringFile || window.whispers?.isOpen?.()) return;
    pendingFile = file;
    updateFileDraft();
    status.textContent = '';
    fileRecipient.focus({ preventScroll: true });
}

function removeFileDraft() {
    pendingFile = null;
    updateFileDraft();
    status.textContent = '';
    attachFileButton.focus({ preventScroll: true });
}

async function sendFile() {
    if (!pendingFile || offeringFile || window.whispers?.isOpen?.()) return;
    if (handleWhisperCommand(messageInput.value)) return;
    const recipientId = fileRecipient.value === 'room' ? undefined : fileRecipient.value;
    if (recipientId !== undefined && !peerItems.has(recipientId)) {
        status.textContent = 'The selected recipient is disconnected. Choose a recipient before sending.';
        return;
    }
    offeringFile = true;
    updateFileDraft();
    const file = pendingFile, reply = messageInput.value, quote = pendingQuote;
    const caption = window.quoteCore.compose(quote, reply);
    const channelId = window.roomChannels?.active() ?? 'general';
    try {
        const media = /\.(png|jpe?g|webp|gif|mp4|webm|m4v|mov|ogv)$/i.test(file.name) || file.type === 'image/png';
        let posted;
        if (media && typeof window.asscrack.postMedia === 'function') {
            posted = await window.asscrack.postMedia(file, caption, channelId, recipientId);
        }
        const result = posted?.offer ?? await window.asscrack.offerFile(file, recipientId);
        if (result.peers === 0) {
            status.textContent = 'No peer received the offer. The file is still attached.';
            return;
        }
        if (posted?.message) {
            const m = posted.message;
            if (m.saved) noteSaved(m.id);
            addMessage(m.from, m.text, m.time, true, m.id, selfId, channelId, m.attachment);
            if (!window.roomChannels || window.roomChannels.isViewing(channelId)) {
                if (messageInput.value === reply) messageInput.value = '';
                if (pendingQuote === quote) setQuote(null);
                window.reading.followLatest();
            } else window.roomChannels.sent(channelId, reply, quote);
        }
        addOfferHead(result, recipientId);
        if (!window.roomChannels || window.roomChannels.isViewing(channelId)) {
            if (pendingFile === file) pendingFile = null;
        } else window.roomChannels.fileSent(channelId, file);
        if (!window.whispers?.isOpen?.() && (document.activeElement === document.body || composer.contains(document.activeElement))) {
            messageInput.focus({ preventScroll: true });
        }
        status.textContent = '';
    } catch (err) {
        status.textContent = `Error: ${err?.message ?? err}`;
    } finally {
        offeringFile = false;
        updateFileDraft();
    }
}

messageInput.addEventListener('paste', event => {
    const item = Array.from(event.clipboardData?.items ?? []).find(item => item.kind === 'file' && item.type === 'image/png');
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    if (file.size > 16 * 1024 * 1024) { status.textContent = 'Clipboard PNG exceeds 16 MiB.'; return; }
    attachFile(file);
    messageInput.focus({ preventScroll: true });
});

attachFileButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
    attachFile(fileInput.files?.[0]);
    fileInput.value = ''; // Allow picking the same file again, including after Remove.
});
fileRecipient.addEventListener('change', updateFileDraft);
removeFileButton.addEventListener('click', removeFileDraft);
sendFileButton.addEventListener('click', sendFile);

// File drops always stay in the app. Plain text retains the browser's normal editing behavior.
for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, e => {
        const data = e.dataTransfer;
        if (!data?.types.includes('Files')) return;
        e.preventDefault();
        const acceptsDrop = messagePanel.contains(e.target) && !offeringFile && !window.whispers?.isOpen?.();
        data.dropEffect = acceptsDrop ? 'copy' : 'none';
        composer.classList.toggle('file-drop-active', acceptsDrop && type === 'dragover');
        if (type !== 'drop' || !acceptsDrop) return;
        if (data.files.length !== 1 || data.items?.[0]?.webkitGetAsEntry?.()?.isDirectory) {
            status.textContent = 'Choose one file to attach.';
            return;
        }
        attachFile(data.files[0]);
    });
}
messagePanel.addEventListener('dragleave', e => {
    if (!messagePanel.contains(e.relatedTarget)) composer.classList.remove('file-drop-active');
});

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
    idlePeerIds = new Set(Array.isArray(data.idlePeers) ? data.idlePeers : []);
    selfIdle = data.selfIdle === true;
    for (const [id, item] of peerItems) item.hidden = idlePeerIds.has(id);
    if (selfLine) selfLine.hidden = selfIdle;
    updatePeerCount();
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
        nodes.push({ id: self, name: ownName, color: nameColorClass(ownName), idle: selfIdle, inVoice: voice.inVoice === true, muted: ownMuted, speaking: voice.transmitting === true && !ownMuted, fullNode: fullNodeSelf });
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
            idle: idlePeerIds.has(peerId),
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

// A proposed edit appears in the room header only when the host publishes it.
const topicValue = document.getElementById('topic-value');
const topicEdit = document.getElementById('topic-edit');
const topicEditor = document.getElementById('topic-editor');
const topicInput = document.getElementById('topic-input');
let currentTopic = { available: false, text: '' };
let topicEvents = 0;

function editRoomTopic(edit) {
    topicEditor.hidden = !edit;
    topicValue.hidden = edit;
    topicEdit.hidden = edit;
    if (edit) {
        topicInput.value = currentTopic.text;
        topicInput.focus();
    }
}

function showRoomTopic(value) {
    currentTopic = value?.available === true ? value : { available: false, text: '' };
    topicValue.textContent = currentTopic.available ? currentTopic.text || 'No topic set' : 'Topic unavailable';
    topicValue.title = topicValue.textContent;
    topicEdit.disabled = !currentTopic.available;
    if (!currentTopic.available) editRoomTopic(false);
}

async function refreshRoomTopic() {
    if (!hasApi('getTopic')) return;
    const before = topicEvents;
    try {
        const value = await window.asscrack.getTopic();
        if (before === topicEvents) showRoomTopic(value);
    } catch { if (before === topicEvents) showRoomTopic(null); }
}

async function submitTopic(text) {
    if (!currentTopic.available || !hasApi('setTopic')) {
        status.textContent = 'Topic unavailable until a host with topic support is connected.';
        return false;
    }
    try {
        await window.asscrack.setTopic(text);
        status.textContent = '';
        return true;
    } catch (err) {
        status.textContent = err?.message ?? 'Topic change failed.';
        return false;
    }
}

topicEdit.addEventListener('click', () => editRoomTopic(true));
document.getElementById('topic-cancel').addEventListener('click', () => {
    editRoomTopic(false);
    topicEdit.focus();
});
async function saveEditedTopic() {
    const draft = topicInput.value;
    if (await submitTopic(draft) && topicInput.value === draft) {
        editRoomTopic(false);
        topicEdit.focus();
    }
}
document.getElementById('topic-save').addEventListener('click', saveEditedTopic);
topicInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveEditedTopic(); }
});
if (hasApi('onTopic')) window.asscrack.onTopic(value => { topicEvents++; showRoomTopic(value); });

// ---- Manual status (milestone 3) ----
// The own state (Available, Away or Do not disturb) and a note of up to 80 code points. The badge .presence-mark of
// each buddy line shows the state of that peer ID. A buddy with no known state (an old client) shows "status unknown".
// The status code calls no voice function: Do not disturb does not change the mute, the voice state or the speaking mark.
const PRESENCE_LABELS = { available: 'Available', away: 'Away', dnd: 'Do not disturb' };
const PRESENCE_UNKNOWN = 'status unknown';
const NOTE_MAX = 80; // Unicode code points
const presenceByPeer = new Map(); // peerId -> { state, note }
let ownPresence = { state: 'available', note: '' };
// A count of the presence changes. A state read that started before a change does not overwrite that change.
let presenceSeq = 0;
const presenceTouched = new Map(); // peerId (or '' for this user) -> presenceSeq of the last change
let presenceControls = null;

function cutNote(text) {
    return [...String(text ?? '')].slice(0, NOTE_MAX).join('');
}

// { state, note } for a valid value, else null.
function readPresence(value) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(PRESENCE_LABELS, value.state)) return null;
    return { state: value.state, note: typeof value.note === 'string' ? cutNote(value.note) : '' };
}

function makePresenceMark() {
    const span = document.createElement('span');
    span.className = 'presence-mark';
    fillPresenceMark(span, null);
    return span;
}

// presence: { state, note }, or null for "status unknown". The note goes in with textContent only.
function fillPresenceMark(span, presence) {
    if (!span) return;
    if (!presence) {
        span.textContent = PRESENCE_UNKNOWN;
        span.dataset.presence = 'unknown';
        span.title = PRESENCE_UNKNOWN;
        return;
    }
    const label = PRESENCE_LABELS[presence.state];
    const text = presence.note ? `${label}: ${presence.note}` : label;
    span.textContent = text;
    span.dataset.presence = presence.state;
    span.title = text;
}

function showPeerPresence(peerId) {
    const item = peerItems.get(peerId);
    if (item) fillPresenceMark(item.querySelector('.presence-mark'), presenceByPeer.get(peerId) ?? null);
}

function showOwnPresence() {
    if (selfLine) fillPresenceMark(selfLine.querySelector('.presence-mark'), ownPresence);
    if (presenceControls) {
        presenceControls.select.value = ownPresence.state;
        presenceControls.note.value = ownPresence.note;
    }
}

function touchPresence(key) {
    presenceSeq++;
    presenceTouched.set(key, presenceSeq);
}

function setPeerPresence(peerId, value) {
    const presence = readPresence(value);
    if (typeof peerId !== 'string' || !peerId || !presence) return;
    touchPresence(peerId);
    presenceByPeer.set(peerId, presence);
    showPeerPresence(peerId);
}

function forgetPresence(peerId) {
    if (typeof peerId !== 'string') return;
    touchPresence(peerId);
    presenceByPeer.delete(peerId);
}

// Send the state of the select and the note (cut to 80 code points) to the node.
async function setOwnPresence() {
    if (!presenceControls || !hasApi('setPresence')) return;
    return applyPresence({ state: presenceControls.select.value, note: cutNote(presenceControls.note.value.trim()) });
}

async function applyPresence(sent) {
    if (!hasApi('setPresence') || !readPresence(sent)) return false;
    touchPresence('');
    try {
        const result = await window.asscrack.setPresence(sent);
        ownPresence = readPresence(result) ?? sent;
    } catch (err) {
        status.textContent = `Status not set: ${err?.message ?? err}`;
        return false;
    }
    showOwnPresence();
    return true;
}

// The state menu and the note field above the self line. The window makes them at login.
function makePresenceControls() {
    const box = document.createElement('div');
    box.id = 'presence-controls';
    const select = document.createElement('select');
    select.id = 'presence-state';
    select.setAttribute('aria-label', 'Your status');
    for (const [value, label] of Object.entries(PRESENCE_LABELS)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    }
    select.value = ownPresence.state;
    const note = document.createElement('input');
    note.id = 'presence-note';
    note.type = 'text';
    note.placeholder = 'Status note';
    note.setAttribute('aria-label', 'Status note (80 characters or less)');
    note.autocomplete = 'off';
    const button = document.createElement('button');
    button.id = 'presence-set';
    button.type = 'button';
    button.textContent = 'Set';
    select.addEventListener('change', setOwnPresence);
    button.addEventListener('click', setOwnPresence);
    note.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            setOwnPresence();
        }
    });
    box.append(select, note, button);
    document.getElementById('presence-fields').appendChild(box);
    return { box, select, note, button };
}

// Read the state from the node one time after login (an event before the subscription is not lost).
// A change after the start of the read stays: the read does not overwrite it.
async function refreshPresence() {
    if (!hasApi('getPresence')) return;
    const start = presenceSeq;
    const newer = key => (presenceTouched.get(key) ?? 0) > start;
    let info;
    try {
        info = await window.asscrack.getPresence();
    } catch (err) {
        console.warn('Status query failed:', err?.message ?? err);
        return;
    }
    if (!info || typeof info !== 'object') return;
    const self = readPresence(info.self);
    if (self && !newer('')) {
        ownPresence = self;
        showOwnPresence();
    }
    if (info.peers && typeof info.peers === 'object') {
        for (const [peerId, value] of Object.entries(info.peers)) {
            const presence = readPresence(value);
            if (!presence || newer(peerId)) continue;
            presenceByPeer.set(peerId, presence);
            showPeerPresence(peerId);
        }
    }
}

function editAvailability() {
    if (!presenceControls) return false;
    document.getElementById('availability-dialog').showModal();
    presenceControls.select.focus();
    return true;
}

function startPresence() {
    if (hasApi('setPresence') && !presenceControls) presenceControls = makePresenceControls();
    showOwnPresence();
    refreshPresence();
}

if (hasApi('onPresence')) {
    window.asscrack.onPresence(data => setPeerPresence(data?.peerId, data));
}
// addPeer (an earlier listener) makes the line first. Then the line gets the known state.
window.asscrack.onPeerJoined(data => showPeerPresence(data?.peerId));
window.asscrack.onPeerLeft(data => forgetPresence(data?.peerId));

// ---- The one Escape dispatcher ----
// Escape closes only the top layer, in this sequence: the context menu (menu.js), the View menu and the Buddies
// drawer (layout.js), a focused whisper pane, the find bar (find.js, it puts the list back at its old position), the quote chip (only with
// the focus in the composer), the voice settings, the invite panel, the map. The View menu and the drawer stop their own Escape when the focus is
// in them. A separator drag stops its Escape in the capture phase on window. Then this listener gets no event.
function focusIsIn(element) {
    const active = document.activeElement;
    return !active || active === document.body || element.contains(active);
}

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (window.contextMenu?.isOpen()) {
        e.preventDefault();
        window.contextMenu.close(true);
        return;
    }
    if (window.layout?.closeTopLayer()) {
        e.preventDefault();
        return;
    }
    if (window.whispers?.isOpen?.() && document.getElementById('whisper-pane')?.contains(document.activeElement)) {
        e.preventDefault();
        window.whispers.close();
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
    if (window.voicePanel?.isOpen()) {
        e.preventDefault();
        const returnFocus = focusIsIn(document.getElementById('voice-settings'));
        window.voicePanel.close();
        if (returnFocus) document.getElementById('voice-settings-toggle')?.focus({ preventScroll: true });
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

// Subscribe before the initial read. Close-to-tray preference changes can also arrive while visible.
{
    const api = window.asscrack;
    const setting = document.getElementById('view-close-idle');
    let idle = false;
    let closeToTray = true;
    let updates = 0;
    function apply(state) {
        if (!state || typeof state.idle !== 'boolean') return;
        const entering = !idle && state.idle;
        idle = state.idle;
        closeToTray = state.closeToTray;
        setting?.setAttribute('aria-checked', String(closeToTray));
        if (entering) {
            window.voicePanel?.close();
            stopStatsTimer();
            ownInVoice = false;
            ownMuted = false;
            void window.voice.enterIdle();
            updateVoiceView();
        }
    }
    window.idlePeer = {
        isIdle: () => idle,
        enter: async () => {
            try { if (!await api.enterIdlePeer()) status.textContent = 'The tray is unavailable. The room is still open.'; }
            catch { status.textContent = 'Could not enter Idle Peer.'; }
        },
        toggleClose: async () => {
            try { await api.setCloseToTray(!closeToTray); }
            catch { status.textContent = 'Could not save the close preference.'; }
        }
    };
    api.onIdlePeer?.(state => { updates++; apply(state); });
    api.getIdlePeer?.().then(state => { if (!updates) apply(state); }).catch(() => {});
}
