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
const deafenButton = document.getElementById('deafen');
const voiceError = document.getElementById('voice-error');
const waitingPeer = document.getElementById('waiting-peer');

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

// The text of an error for the user. Electron puts "Error invoking remote method '<channel>': Error: " before the
// message of an error from the main process. That part is for a programmer, not for the user.
// P4 of the UI copy pass: the guard texts of the main process (only in a race) get one short text in the window.
// P6 and 4.19: the texts of src/network/ that reach the window get a short window text. The network modules keep their
// texts (the terminal demo and the tests use them).
const GUARD_TEXTS = [
    [/^Not logged in/, 'Not in a room.'],
    [/^Saved room not found/, 'Room not found.'],
    [/^(Already logged in|Invalid peer ID|Invalid offer ID|A local file is required|The file path is not an absolute path|The file has no path)/,
        'Something went wrong. Try again.'],
    [/^This device has been removed from the room/, 'You were removed from this room.'],
    [/^Named channels need a host/, 'Channels aren\'t available right now.'],
    [/^This channel is read-only/, 'This channel is read-only right now.'],
    [/^Too many files are being prepared/, 'Too many files at once. Wait a moment.'],
    [/^Too many (outstanding file offers|recipients have pending file offers)/, 'Too many open offers. Wait for some to finish.'],
    [/^The selected recipient (is not connected|disconnected before)/, 'Recipient is offline.'],
    [/^File changed/, 'The file changed. Try again.']
];
function errorText(err) {
    const text = String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
    return GUARD_TEXTS.find(([re]) => re.test(text))?.[1] ?? text;
}

// P1: an error in the status line has no "Error:" prefix. The class "error" makes it red. The next text removes it.
let statusErrorText = null;
function showStatusError(text) {
    statusErrorText = String(text);
    status.textContent = statusErrorText;
    status.classList.add('error');
}
window.statusError = showStatusError;
window.statusErrorText = errorText;

// The status band cuts a long status text with an ellipsis: the tooltip has the full text.
new MutationObserver(() => {
    status.title = status.textContent;
    if (status.textContent !== statusErrorText) status.classList.remove('error');
}).observe(status, { childList: true, characterData: true, subtree: true });

// #waiting-peer and the link key of the status bar come from room-link.js (window.roomLink), not from this count.
function updatePeerCount() {
    peerCount.textContent = String([...peerItems.keys()].filter(id => !idlePeerIds.has(id)).length + (selfLine && !selfIdle ? 1 : 0));
}

// The node map panel opens and closes with a CSS transition (body.map-open).
function setMapOpen(open) {
    document.body.classList.toggle('map-open', open);
    if (!open) window.peerInspector?.close();
    mapToggle.setAttribute('aria-expanded', String(open));
    mapPanel.setAttribute('aria-hidden', String(!open));
    window.nodeMap?.setOpen?.(open);
}

mapToggle.addEventListener('click', () => setMapOpen(!document.body.classList.contains('map-open')));
mapClose.addEventListener('click', () => {
    setMapOpen(false);
    document.getElementById('view-toggle')?.focus({ preventScroll: true });
});
// Escape: see the one Escape dispatcher at the end of this file.

function formatTime(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// The text of a chat line. A message with a quotation (quote.js) gets a quotation block. The text nodes keep all the
// characters, thus textContent is the message text (copy and find use it). The marks "> " are in span.qmark.
// Gap D2: at the end, each http:// or https:// URL becomes a link (chat-links.js). textContent does not change.
function fillMessageText(span, text) {
    const value = String(text ?? '');
    const parts = window.quoteCore?.split(value) ?? null;
    if (!parts) {
        span.textContent = value;
        window.chatLinks?.apply(span);
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
    window.chatLinks?.apply(span);
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
    // Gap D6: the full local date and time.
    timeSpan.title = new Date(Number(time) || 0).toLocaleString();
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
// A note row (transcript-notes.js) has no .from: it is never "the same user", thus no line groups over it.
function groupWithPrevious(item) {
    if (!item || item.classList.contains('note')) return;
    const prev = item.previousElementSibling;
    const prevFrom = prev?.querySelector('.from');
    const itemFrom = item.querySelector('.from');
    const same = Boolean(prevFrom && itemFrom) && !prev.classList.contains('file-card') && !item.classList.contains('file-card')
        && prev.classList.contains('own') === item.classList.contains('own')
        && prev.classList.contains('unverified') === item.classList.contains('unverified')
        && (prevFrom.dataset.mark ?? '') === (itemFrom.dataset.mark ?? '')
        && prevFrom.textContent === itemFrom.textContent
        && Math.abs(Number(item.dataset.time) - Number(prev.dataset.time)) < GROUP_MS;
    item.classList.toggle('cont', same);
}

// M1 (P10a): a history line of a device that this computer does not know. The host gave the name. The mark is CSS
// (styles.css), thus the text of .from stays the name for the quote and the detail view.
function markUnverified(item) {
    const from = item.querySelector('.from');
    if (!from) return;
    item.classList.add('unverified');
    from.classList.add('unverified');
    from.title = 'Name given by the host';
    groupWithPrevious(item);
    groupWithPrevious(nextContentRow(item));
}

// L3 (P10a): the device mark (6 hex characters, main.js peer-marks.mjs) beside the name of a line. The mark is CSS
// (styles.css), thus the text of .from stays the name. Two devices with the same name do not group.
function applyMark(item, mark) {
    const from = item?.querySelector('.from');
    if (!from || typeof mark !== 'string' || !/^[0-9a-f]{6}$/.test(mark)) return;
    from.dataset.mark = mark;
    groupWithPrevious(item);
    groupWithPrevious(nextContentRow(item));
}

// The first row after item that is not a note row, or null.
function nextContentRow(item) {
    let next = item?.nextElementSibling ?? null;
    while (next && next.classList.contains('note')) next = next.nextElementSibling;
    return next;
}

// True when the list has a row that is not a note row. A list with only note rows is "empty" for the history code.
function hasContentRows(list) {
    return Array.from(list.children).some(row => !row.classList.contains('note'));
}

// Archive acknowledgements can arrive before the corresponding live row.
const savedMessageIds = new Set();
const messageDetails = document.getElementById('message-details');

function showArchiveFact() {
    if (!messageDetails?.open) return;
    const saved = savedMessageIds.has(messageDetails.dataset.messageId);
    document.getElementById('message-detail-archive').textContent = saved ? 'Saved' : 'Not saved';
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
// Gap B3: the line keeps its channel ID and gets "Send again" (row action 'resend', also in the row menu).
function markLocalOnly(item, channelId = 'general') {
    if (!item || item.classList.contains('local-only')) return;
    item.classList.add('local-only');
    item.dataset.channelId = String(channelId);
    const mark = document.createElement('span');
    mark.className = 'local-only-mark';
    mark.textContent = 'Only on this PC';
    // Not a tab stop, as the Quote button: the keyboard uses the row menu.
    const again = makeButton('Send again', () => runRowAction('resend', item), 'resend', 'btn-resend');
    again.tabIndex = -1;
    const bubble = item.querySelector('.bubble-text');
    (bubble ?? item).append(mark, again);
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
    const list = window.roomChannels?.listFor(channelId) ?? messageList;
    list.appendChild(item);
    // Gap D6: a day row before the line when the day changed.
    window.transcriptNotes?.placed(list, item);
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
    // Gap D6: the day rows before the line and before the next line.
    window.transcriptNotes?.placed(list, item);
    groupWithPrevious(item);
    groupWithPrevious(nextContentRow(item));
    if (attachment) window.chatAttachments?.decorate(item, attachment, attachment.source === selfId);
    return item;
}

// A peer line: <li><span.avatar/><span.name/><span.host/><span.voice/></li>. All text goes in with textContent.
// The avatar is the buddy icon: the first letter of the name on a ball with the name color.
function makePeerLine(name, title, colorName = name, self = false) {
    const item = document.createElement('li');
    const avatar = document.createElement('button');
    avatar.type = 'button';
    avatar.className = 'avatar';
    if (self) {
        item.dataset.self = 'true';
        avatar.setAttribute('aria-label', 'Set status');
        avatar.setAttribute('aria-haspopup', 'dialog');
        avatar.addEventListener('click', editAvailability);
    } else {
        avatar.setAttribute('aria-label', 'Inspect ' + name);
        item.addEventListener('click', () => window.peerInspector?.open(title));
    }
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
    voiceSpan.title = 'Not in voice';
    voiceSpan.append(makeSpan('sr-only', 'not in voice'));
    voiceSpan.dataset.state = 'not in voice';
    voiceSpan.dataset.extra = '';
    item.append(avatar, nameSpan, hostSpan, voiceSpan, makePresenceMark());
    item.title = String(title);
    return item;
}

function setPeerName(item, name) {
    item.querySelector('.name').textContent = String(name);
    const avatar = item.querySelector('.avatar');
    avatar.textContent = firstLetter(name);
    avatar.setAttribute('aria-label', 'Inspect ' + name);
    setNameColor(item, name);
    updateNodeMap();
}

let selfLine = null;
// The name from the hello line of each peer.
const peerNames = new Map();
// L3 (P10a): the device mark of each peer (the peer-name event).
const peerMarks = new Map();
// M4 (P10b): the voice roster of the host: peer ID -> voice channel ID.
let voiceRoster = new Map();

// L3 (P10a): the device mark beside each name of the peer list, and the mark "same name" when two people in the list
// (this user included) use the same name.
function refreshPeerMarks() {
    const count = new Map();
    const names = [ownName, ...[...peerItems.keys()].map(peerId => peerNames.get(peerId))].filter(Boolean)
        .map(name => String(name).trim().toLowerCase());
    for (const name of names) count.set(name, (count.get(name) ?? 0) + 1);
    for (const [peerId, item] of [...peerItems, ...heldItems]) {
        const nameSpan = item.querySelector('.name');
        if (!nameSpan) continue;
        const mark = peerMarks.get(peerId);
        if (mark) nameSpan.dataset.mark = mark;
        const name = peerNames.get(peerId);
        const clash = Boolean(name) && (count.get(String(name).trim().toLowerCase()) ?? 0) > 1;
        item.classList.toggle('name-clash', clash);
        nameSpan.title = clash ? 'Same name as another buddy' : '';
    }
}

// Gap B1: the grey buddy lines of peers that went with no bye. peer ID -> <li>. A grey line is not in peerItems:
// it has no menu, it is no file recipient and it does not count.
const heldItems = new Map();

function addPeer(peerId) {
    if (peerItems.has(peerId)) return;
    const before = peerItems.size;
    // A peer that comes back in its grey time gets its old line back.
    let item = heldItems.get(peerId);
    if (item) {
        heldItems.delete(peerId);
        item.classList.remove('lost');
    } else {
        item = makePeerLine(peerNames.get(peerId) ?? String(peerId).slice(0, 12), peerId);
        peerList.appendChild(item);
    }
    item.dataset.peerId = String(peerId);
    item.hidden = idlePeerIds.has(peerId);
    peerItems.set(peerId, item);
    refreshPeerMarks();
    refreshFileRecipients();
    updatePeerCount();
    updateVoiceView();
    if (before === 0) noteUnsentLines();
}

// hold: keep the line grey with the text "connection lost" (gap B1). Else the line goes away.
function removePeer(peerId, hold = false) {
    const item = peerItems.get(peerId);
    if (!item) return;
    peerItems.delete(peerId);
    refreshPeerMarks();
    if (listeningDialog?.open && listeningDialog.dataset.peerId === peerId) listeningDialog.close();
    refreshFileRecipients();
    updatePeerCount();
    updateNodeMap();
    if (hold) {
        item.classList.add('lost');
        setVoiceState(item, 'connection lost');
        heldItems.set(peerId, item);
        return;
    }
    removePeerLine(item);
}

function removePeerLine(item) {
    if (reducedMotion.matches) {
        item.remove();
        return;
    }
    // View only: the line moves out, then it goes away.
    item.classList.add('leaving');
    setTimeout(() => item.remove(), PEER_OUT_MS);
}

// ---- Roster notes and the room link (gaps B1, A2, A4, B2) ----
// transcript-notes.js (rosterNotesCore) decides the notes and the grey lines. room-link.js shows #waiting-peer and
// the link key of the status bar. roomRole: 'creator', 'joiner' or 'reopen'; the login and saved-rooms-ui.js set it.
let roomRole = 'creator';
let roster = null;
let rosterTimer = null;

function rosterNow() {
    if (!roster && window.rosterNotesCore) roster = window.rosterNotesCore.createRoster({ creator: roomRole === 'creator' });
    return roster;
}

// A roster note: a rejoin in 60 s removes the leave note first. A saved room that keeps history saves the note in its
// archive (main.js decides). The note does not go to the room.
function addRosterNote(action) {
    if (action.replaces) window.transcriptNotes?.removeNote(action.replaces);
    window.transcriptNotes?.append(action.kind, action.text, action.time, 'general', action.id);
    window.asscrack.saveNote?.({ id: action.id, kind: action.kind, text: action.text, time: action.time, replaces: action.replaces });
}

// The person of a peer for the 60 s merge of the roster notes: in a protected room the device mark (the same after an
// app restart, which gives a new peer ID), else nothing (the roster uses the name).
let roomProtected = false;
function personKey(peerId) {
    const mark = roomProtected ? peerMarks.get(peerId) : null;
    return mark ? `device:${mark}` : undefined;
}

function applyRoster(actions) {
    for (const action of actions ?? []) {
        if (action.type === 'note') addRosterNote(action);
        else if (action.type === 'add' || action.type === 'restore') addPeer(action.peerId);
        else if (action.type === 'grey') removePeer(action.peerId, true);
        else if (action.type === 'remove') {
            otherVoiceGone(action.peerId);
            const held = heldItems.get(action.peerId);
            if (held) {
                heldItems.delete(action.peerId);
                removePeerLine(held);
            } else removePeer(action.peerId);
        }
    }
    if (rosterTimer !== null) clearTimeout(rosterTimer);
    rosterTimer = null;
    const due = roster?.nextDue() ?? null;
    if (due !== null) rosterTimer = setTimeout(() => applyRoster(roster.tick(Date.now())), Math.max(0, due - Date.now()));
    if (roster) window.roomLink?.presence(roster.link());
}

// ---- Voice cues of other people (P11) ----
// peer ID -> { inVoice, openedAt, base, lost }: the last known voice state of each peer (null: not known yet). A peer
// sends a voice line when its session opens only if it is in voice. Thus the first state in VOICE_BASE_MS after the
// session opens is the base (no cue), and with no state in that time the peer is not in voice. A peer that comes back
// in the 10 s of G2 thus gives no cue. The entry stays while the roster holds the peer: the leave cue comes when the
// roster removes the line. The states update also when I am not in voice, thus the states that come at my own Join
// are not a change.
// G6: "in voice" means "in my voice channel" (my channel at the time of each event). A move between two different
// channels plays no cue.
const VOICE_BASE_MS = 3 * 1000;
const otherVoice = new Map();

function otherInVoice(entry, now) {
    if (!entry) return false;
    if (entry.inVoice === null) return now - entry.openedAt > VOICE_BASE_MS ? false : null;
    return entry.inVoice && (entry.channel ?? 'general') === ownVoiceChannel();
}

function otherVoiceOpened(peerId) {
    otherVoice.set(peerId, { inVoice: null, openedAt: Date.now(), base: true, lost: false });
}

// After a 'peer-left' event: 0 peers is my own loss. The peers that go at that time give no leave cue later.
function otherVoiceLoss() {
    if ((roster?.link().peers ?? peerItems.size) > 0) return;
    for (const entry of otherVoice.values()) entry.lost = true;
}

function otherVoiceState(peerId, inVoice, channel = 'general') {
    if (typeof peerId !== 'string' || !peerId || peerId === selfId) return;
    const now = Date.now();
    const entry = otherVoice.get(peerId);
    const before = otherInVoice(entry, now);
    const inBase = entry?.base === true && now - entry.openedAt <= VOICE_BASE_MS;
    const next = { inVoice, channel, openedAt: entry?.openedAt ?? now, base: false, lost: entry?.lost === true };
    otherVoice.set(peerId, next);
    const after = otherInVoice(next, now);
    // No entry: a state before the session event. Not a known change.
    if (!entry || inBase || before === null || before === after) return;
    otherVoiceCue(after ? 'other-join' : 'other-leave', peerId);
}

// The roster removes the line of a peer: at once after a bye, or at the end of the grey time.
function otherVoiceGone(peerId) {
    const entry = otherVoice.get(peerId);
    otherVoice.delete(peerId);
    // No leave cue when I have 0 peers after the event (my own loss).
    if (entry?.lost || otherInVoice(entry, Date.now()) !== true) return;
    if ((roster?.link().peers ?? peerItems.size) > 0) otherVoiceCue('other-leave', peerId);
}

// Message alerts: the notification of voice join and leave (default off) does not need me in voice.
function otherVoiceCue(kind, peerId) {
    if (ownInVoice && !joining) window.roomAttention?.cue(kind, 'voice-other');
    window.roomAttention?.voice?.(kind, peerId);
}

window.asscrack.onVoiceState(data => otherVoiceState(data?.peerId, data?.inVoice === true,
    typeof data?.channel === 'string' && data.channel ? data.channel : 'general'));

function peerJoined(peerId) {
    otherVoiceOpened(peerId);
    const notes = rosterNow();
    if (notes) applyRoster(notes.joined(peerId, Date.now(), peerNames.get(peerId), personKey(peerId)));
    else addPeer(peerId);
    restoreListening(peerId);
}

// G4: the saved listening choice of this person in this room (the main process keys it by the device ID).
function restoreListening(peerId) {
    Promise.resolve(window.asscrack.getListening?.(peerId)).then(choice => {
        if (!choice || !peerItems.has(peerId)) return;
        window.voice.setListening?.(peerId, choice.muted, choice.volume);
        updateVoiceView();
    }).catch(err => console.warn('Listening choice not read:', err?.message ?? err));
}

function peerLeft(peerId, withBye) {
    const notes = rosterNow();
    if (notes) applyRoster(notes.left(peerId, withBye === true, Date.now()));
    else removePeer(peerId);
    otherVoiceLoss();
}

window.asscrack.onPeerDiscovered(data => console.log('peer-discovered', data));
window.asscrack.onPeerJoined(data => peerJoined(data.peerId));
window.asscrack.onPeerLeft(data => peerLeft(data.peerId, data.left));
window.asscrack.onPeerName(data => {
    if (typeof data.name !== 'string') return;
    peerNames.set(data.peerId, data.name);
    if (typeof data.mark === 'string') peerMarks.set(data.peerId, data.mark);
    const item = peerItems.get(data.peerId) ?? heldItems.get(data.peerId);
    if (item) {
        setPeerName(item, data.name);
        refreshFileRecipients();
    }
    refreshPeerMarks();
    if (roster) applyRoster(roster.named(data.peerId, data.name, Date.now(), personKey(data.peerId)));
});
window.asscrack.onMessage(data => {
    const item = peerItems.get(data.peerId);
    if (item && data.from) setPeerName(item, data.from);
    const state = window.reading.beforeChange();
    const line = addMessage(data.from, data.text, data.time, false, data.id, data.peerId, data.channelId, data.attachment);
    applyMark(line, data.mark);
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
    const first = visible && !historyShown.has(activeChannel) && !hasContentRows(messageList);
    const state = window.reading.beforeChange();
    let added = 0;
    for (const line of lines) {
        // M1 (P10a): a line of a device that this computer does not know is never an own line, and it gets a mark.
        const item = insertMessage(line.from, line.text, line.time, line.id, line.unverified === true ? false : null, line.channelId, line.attachment);
        if (!item) continue;
        added++;
        if (line.unverified === true) markUnverified(item);
        applyMark(item, line.mark);
    }
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
const upnpField = document.getElementById('upnp-field');
const allowUpnp = document.getElementById('allow-upnp');
let autoUpnpEnabled = true;
let allowUpnpTouched = false;
if (allowUpnp) allowUpnp.checked = autoUpnpEnabled;
const legacyConsent = document.getElementById('legacy-consent');
const allowLegacy = document.getElementById('allow-legacy');

function legacyInvite() {
    return roomTypeSelect.value === 'join' && inviteInput.value.replace(/\s+/g, '').startsWith('asscrack1:');
}

function showLegacyConsent() {
    if (!legacyConsent) return;
    legacyConsent.hidden = !legacyInvite();
    allowLegacy.checked = false;
}

const upnpOffNote = document.getElementById('upnp-off-note');

// Gap A1: an internet room with no public address and no UPnP cannot get friends from the internet. The login is
// not stopped: the owner can turn on UPnP later in the Invite panel.
function showUpnpChoice() {
    if (!upnpField) return;
    upnpField.hidden = roomTypeSelect.value === 'lan';
    allowUpnp.disabled = publicAddressInput.value.trim() !== '';
    if (upnpOffNote) {
        upnpOffNote.hidden = roomTypeSelect.value !== 'new' || publicAddressInput.value.trim() !== '' || allowUpnp.checked === true;
    }
}

// Gap A5: the label of the login button names the action of the room type.
const LOGIN_LABELS = { new: 'Create room', join: 'Join room', lan: 'Create LAN room' };
const STARTING_TEXT = 'Starting the room…';
let loginBusy = false;
function loginLabel() {
    return LOGIN_LABELS[roomTypeSelect.value] ?? LOGIN_LABELS.new;
}

// Gap N9: Create with the name of a saved room starts no room at the first click. A second click starts it.
// A change of the room name or of the room type resets this.
const SAME_NAME_TEXT = 'You have a saved room with this name. Use Reopen to open it.';
let sameNameWarned = false;

function showRoomType() {
    const type = roomTypeSelect.value;
    roomField.hidden = type === 'join';
    inviteField.hidden = type !== 'join';
    publicAddressField.hidden = type === 'lan';
    if (!loginBusy) loginButton.textContent = loginLabel();
    sameNameWarned = false;
    showUpnpChoice();
    showLegacyConsent();
}
// Set the room type from code (the device ID button). The listeners of the change event run.
function setRoomType(type) {
    roomTypeSelect.value = type;
    roomTypeSelect.dispatchEvent(new Event('change'));
}
roomTypeSelect.addEventListener('change', showRoomType);
publicAddressInput.addEventListener('input', showUpnpChoice);
allowUpnp?.addEventListener('change', () => { allowUpnpTouched = true; showUpnpChoice(); });
inviteInput.addEventListener('input', showLegacyConsent);
roomInput.addEventListener('input', () => { sameNameWarned = false; });
showRoomType();

// Gap A6: the user name of the last successful login comes back in the empty Username field.
const USER_NAME_KEY = 'asscrack.userName.v1';
try {
    const savedName = window.localStorage?.getItem(USER_NAME_KEY);
    if (!usernameInput.value && typeof savedName === 'string' && savedName.length <= 64) usernameInput.value = savedName;
} catch { /* no storage: the field stays empty */ }
function rememberUserName(name) {
    try { window.localStorage?.setItem(USER_NAME_KEY, name); } catch { /* no storage */ }
}

let internetRoom = false;

// easy-join: friendJoin { token, room, name } is a Join from a friend invite (takeFriendJoin below). The
// main process keeps the code; the window sends the token. A click event is not a friendJoin.
async function login(friendJoin = null) {
    // A reopen of a saved room also disables the button: Enter in a field must not start a second room.
    if (loginBusy || loginButton.disabled) return;
    const join = typeof friendJoin?.token === 'string' ? friendJoin : null;
    const name = usernameInput.value.trim() || (join?.name ?? '');
    const type = join ? 'join' : roomTypeSelect.value;
    let room = join ? join.room : roomInput.value.trim();
    const invite = join ? '' : inviteInput.value.trim();
    const publicAddress = join ? '' : publicAddressInput.value.trim();
    if (join && !name) {
        status.textContent = 'Enter a name, then click Join again.';
        return;
    }
    if (!name || (type !== 'join' && !room)) {
        // The join type has no room field: it has the invite code.
        showStatusError(type === 'join' ? 'Enter a name and an invite code.' : 'Enter a name and a room name.');
        return;
    }
    if (type === 'join' && !invite && !join) {
        showStatusError('Enter a name and an invite code.');
        return;
    }
    if (!join && legacyInvite() && allowLegacy?.checked !== true) {
        showStatusError('Tick “I trust everyone with this code” first.');
        allowLegacy?.focus();
        return;
    }
    if (type !== 'join' && !sameNameWarned && window.savedRoomsUi?.hasRoomNamed?.(room)) {
        sameNameWarned = true;
        status.textContent = SAME_NAME_TEXT;
        return;
    }
    const options = { name, room, type };
    if (join) options.friendInvite = join.token;
    else if (type === 'join') {
        options.invite = invite;
        options.allowLegacy = legacyInvite() && allowLegacy?.checked === true;
    }
    if (type !== 'lan') {
        if (publicAddress) options.publicAddress = publicAddress;
        options.allowUpnp = !publicAddress && allowUpnp?.checked === true;
    }
    // Saved rooms (milestone 6): the save choice of a keyed room.
    if (window.savedRoomsUi) Object.assign(options, window.savedRoomsUi.loginOptions(type));
    loginBusy = true;
    mapUpnpTried = false;
    mapUpnpError = '';
    roomRole = type === 'join' ? 'joiner' : 'creator';
    loginButton.disabled = true;
    loginButton.textContent = STARTING_TEXT;
    status.textContent = '';
    try {
        const result = await window.asscrack.login(options);
        rememberUserName(name);
        internetRoom = result?.internet === true;
        if (typeof result?.room === 'string' && result.room) room = result.room;
        showChat(name, room);
        roomStarted(result);
    } catch (err) {
        showStatusError(errorText(err));
        loginBusy = false;
        loginButton.disabled = false;
        loginButton.textContent = loginLabel();
    }
}

// easy-join part 2: the state of a knock with a room code. The login waits for the owner (up to 2.5 minutes).
const KNOCK_STATE_TEXTS = {
    looking: room => `Looking for the owner of ${room}…`,
    waiting: room => `Waiting for the owner of ${room}…`,
    allowed: room => `Allowed. Joining ${room}…`
};
window.asscrack.onKnockState?.(data => {
    const text = KNOCK_STATE_TEXTS[data?.state];
    if (text && loginBusy && chatScreen.hidden) status.textContent = text(String(data.room ?? ''));
});

// easy-join: a Join of a friend invite waits in the main process (after Leave room it waits for this new window).
async function takeFriendJoin() {
    if (!window.friends?.takeJoin || !chatScreen.hidden || loginBusy) return;
    let pending = null;
    try { pending = await window.friends.takeJoin(); } catch { pending = null; }
    if (pending?.token) {
        status.textContent = `Joining ${pending.room}…`;
        await login(pending);
    }
}
window.friends?.onJoin?.(() => { void takeFriendJoin(); });
void takeFriendJoin();

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
    window.roomTitle?.setRoom(room);
    status.textContent = '';
    // View only: the status text moves to the status band of the chat screen.
    statusBar.prepend(status);
    if (internetRoom) statusBar.querySelector('.net-note').textContent = 'Internet room';
    if (!selfLine) {
        selfLine = makePeerLine(`${name} (you)`, name, name, true);
        // Two parts with the same text as before: the ellipsis of a long name cuts the name, not the mark "(you)".
        selfLine.querySelector('.name').replaceChildren(makeSpan('name-text', name), makeSpan('you-mark', ' (you)'));
        selfLine.classList.add('self');
        peerList.prepend(selfLine);
    }
    updatePeerCount();
}

// After the node started: get the room state from the main process.
function roomStarted(result) {
    // Gap A2: the room-link state starts before the membership, which can change it.
    const membership = result?.membership?.protected === true ? result.membership : null;
    roomProtected = membership !== null;
    window.roomLink?.start({ role: roomRole, owner: membership?.owner === true,
        admitted: membership ? membership.admitted !== false : true, revoked: membership?.revoked === true });
    window.roomLink?.presence(rosterNow()?.link());
    window.roomMembership?.start(result?.membership);
    if (result?.membership?.protected === false && internetRoom) {
        const netNote = statusBar.querySelector('.net-note');
        netNote.textContent = 'Shared-code room';
        netNote.title = 'Anyone with the code can join';
    }
    void window.roomChannels?.start();
    void window.voiceChannels?.start();
    window.whispers?.refresh();
    refreshRoomTopic();
    void refreshKeptPartials();
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
    // Milestone 9: /ready <text> opens a ready check (ready-check-ui.js). A text that is not valid stays in the box.
    const ready = !quote && window.readyCheckUi?.command(reply);
    if (ready) {
        sendBusy = true;
        try { if (await ready && messageInput.value === reply) messageInput.value = ''; } finally { sendBusy = false; }
        return;
    }
    // Room music: /play <link>, /skip, /queue and /pause (music-ui.js). A reserved command never becomes a chat line.
    if (window.musicCore?.isCommand(reply)) {
        if (!window.musicUi) {
            status.textContent = 'Music is unavailable.';
            return;
        }
        sendBusy = true;
        try { if (await window.musicUi.command(reply) && messageInput.value === reply) messageInput.value = ''; } finally { sendBusy = false; }
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
        if (quote) status.textContent = 'Type a reply.';
        return;
    }
    const text = window.quoteCore.compose(quote, reply);
    sendBusy = true;
    // Saved rooms (milestone 6): send returns the record { id, from, text, time, accepted }.
    let record;
    try {
        record = channelId === 'general' ? await window.asscrack.send(text) : await window.asscrack.send(text, channelId);
    } catch (err) {
        showStatusError(`Not sent: ${errorText(err)}`);
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
    if (noneAccepted(record)) markLocalOnly(line, channelId);
    if (visible) window.reading.followLatest();
    status.textContent = '';
    if (typeof record?.saveError === 'string' && record.saveError && window.savedRoomsUi) {
        window.savedRoomsUi.saveFailed({ id: record.id, reason: record.saveError });
    }
    return true;
}

// Gap D1: Enter and the Send button. The message box always belongs to the room.
// - No file draft: sendMessage.
// - A file for the entire room, a media file: sendFile. The text is the caption.
// - A file for the entire room, not a media file: sendFile, then sendMessage when the offer had 1 or more peers and
//   the box has the same text.
// - A file for one person and an empty box: sendFile (a private offer).
// - A file for one person and text in the box: sendMessage only. The draft stays: a text for one person must not go
//   to the room by accident, and the file must not go with a text that the room gets.
// Gap D3: each text of the box goes into the recall list of composer-keys.js.
async function submitComposer() {
    const reply = messageInput.value;
    if (reply.trim()) window.composerKeys?.remember(reply);
    // A music command is never the caption of a file (music-core.js isCommand).
    if (!pendingFile || window.musicCore?.isCommand(reply)) return sendMessage();
    if (fileRecipient.value === 'room') {
        if (isMediaFile(pendingFile)) return sendFile();
        const channelId = window.roomChannels?.active() ?? 'general';
        const result = await sendFile();
        const sameView = !window.roomChannels || window.roomChannels.isViewing(channelId);
        if (result && result.peers > 0 && reply.trim() && messageInput.value === reply && sameView) return sendMessage();
        return Boolean(result);
    }
    if (!reply.trim()) return sendFile();
    const recipientId = fileRecipient.value;
    const sent = await sendMessage();
    if (sent === true && pendingFile && fileRecipient.value === recipientId) {
        status.textContent = `File for ${transferPeerName(recipientId)} is still attached.`;
    }
    return sent;
}

// True when no peer accepted the send (record of asscrack:send). An old bridge gives no count: the peer count decides.
function noneAccepted(record) {
    const count = record?.accepted;
    return typeof count === 'number' ? count === 0 : peerItems.size === 0;
}

// Gap B3: Send again of a line with "Only on this computer". The same text goes to the same channel. With 1 or more
// accepting peers the old row goes and the new line comes at the end. With 0 the row stays. No automatic send.
async function resendMessage(row) {
    if (!row || row.parentElement !== messageList || !row.classList.contains('local-only') || sendBusy) return false;
    const text = row.querySelector('.text')?.textContent ?? '';
    if (!text.trim()) return false;
    const channelId = row.dataset.channelId || 'general';
    sendBusy = true;
    let record;
    try {
        record = channelId === 'general' ? await window.asscrack.send(text) : await window.asscrack.send(text, channelId);
    } catch (err) {
        status.textContent = `Not sent: ${errorText(err)}.`;
        return false;
    } finally {
        sendBusy = false;
    }
    if (noneAccepted(record)) {
        status.textContent = 'Not sent: no one is here.';
        return false;
    }
    // The row can be in a stored channel list now (a change of the channel while the send ran).
    if (row.parentElement) {
        if (row.dataset.id) shownMessageIds.delete(row.dataset.id);
        const next = nextContentRow(row);
        if (window.transcriptNotes) window.transcriptNotes.remove(row);
        else row.remove();
        groupWithPrevious(next);
    }
    if (record?.saved === true && record?.id) savedMessageIds.add(String(record.id));
    // As a new send: the new line is the newest line, and the list goes to it.
    addMessage(ownName, text, record?.time ?? Date.now(), true, record?.id ?? null, selfId ?? topologySelf, channelId);
    if (!window.roomChannels || window.roomChannels.isViewing(channelId)) window.reading.followLatest();
    status.textContent = '';
    if (typeof record?.saveError === 'string' && record.saveError && window.savedRoomsUi) {
        window.savedRoomsUi.saveFailed({ id: record.id, reason: record.saveError });
    }
    return true;
}

// Gap B3: when the first peer comes, say how many lines were not sent. The user decides on each one.
function noteUnsentLines() {
    const lists = [messageList, ...(window.roomChannels?.storedLists?.() ?? [])].filter((list, i, all) => all.indexOf(list) === i);
    let count = 0;
    for (const list of lists) for (const row of Array.from(list.children)) if (row.classList.contains('local-only')) count++;
    if (count === 0) return;
    status.textContent = count === 1 ? '1 message not sent.' : `${count} messages not sent.`;
}

loginButton.addEventListener('click', login);
for (const input of [usernameInput, roomInput, publicAddressInput]) {
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') login();
    });
}
// Enter with no Shift in the invite box logs in. Shift+Enter keeps a new line. An IME composition keeps its Enter.
inviteInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        login();
    }
});
sendButton.addEventListener('click', submitComposer);
// Enter sends. Shift+Enter makes a new line. An IME composition keeps its Enter.
messageInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submitComposer();
    }
});

// ---- Voice user interface ----

const SPEAKING_LEVEL = 0.01;
const STATS_INTERVAL_MS = 250;

let selfId = null;
let hostId = null;
let ownInVoice = false;
// C8: the mute state stays through Leave and Join while the window runs. Idle Peer sets it to off.
let ownMuted = false;
// C2: Deafen mutes the microphone too. mutedBeforeDeafen comes back at Deafen off and at Leave.
let ownDeafened = false;
let mutedBeforeDeafen = false;
// The text of a failed Join or Leave. The texts of the voice state (C1) come from voice.state().
let voiceFailText = '';
let joining = false;
// G6: the own voice channel (voice.js keeps it), and the last channel of this run for "Join voice".
let lastVoiceChannel = 'general';
function ownVoiceChannel() {
    return window.voice.state().channel ?? 'general';
}
// The text after the voice state: " · Raid" when the room has 2 or more voice channels.
function channelSuffix(channelId) {
    const name = window.voiceChannels?.label(channelId ?? 'general') ?? '';
    return name ? ` · ${name}` : '';
}
let speaking = new Set(); // peerIds above SPEAKING_LEVEL in the last stats() read
let statsTimer = null;
let monitorActive = false;
let lastMonitorView = '';

function publishMonitorView(state, speakers) {
    const view = { inVoice: ownInVoice, muted: ownMuted, deafened: ownDeafened, transmitting: state.transmitting === true,
        speakers, theme: document.documentElement.dataset.theme || 'aero-classic',
        // G6: the microphone line of the detached panel starts with the channel name.
        channel: ownInVoice && window.voiceChannels ? window.voiceChannels.name(state.channel ?? 'general') : '',
        // P8b (design W6): the panel shows "Sharing your screen" and Stop sharing while the share is on.
        sharing: window.screenShare?.isSharing() === true };
    const key = JSON.stringify(view);
    if (key === lastMonitorView) return;
    lastMonitorView = key;
    window.roomVoiceMonitor.publish(view);
}

// extra: the text after the state (G6 channel, G4 volume). data-state has the state only: the CSS of the voice marks
// reads it.
// U7 of the UI copy pass: the state is an icon. Its words are the tooltip, and they stay in the line as text for
// screen readers only (class "sr-only"). Thus textContent is the same as before ("in voice (muted) · Raid").
const VOICE_ICONS = {
    'in voice': 'headset', speaking: 'headset', 'in voice (muted)': 'mic-off', 'not in voice (mic muted)': 'mic-off',
    'in voice (no microphone)': 'mic-off', 'in voice (deafened)': 'deafened', 'muted for you': 'speaker-off',
    'listening (not in voice for you)': 'ear'
};
const VOICE_TIPS = {
    'not in voice': 'Not in voice', 'in voice': 'In voice', speaking: 'Speaking', 'in voice (muted)': 'Muted',
    'not in voice (mic muted)': 'Not in voice · Muted', 'in voice (no microphone)': 'No mic', 'in voice (deafened)': 'Deafened',
    'muted for you': 'Muted by you', 'listening (not in voice for you)': 'Listening only'
};
function setVoiceState(item, text, extra = '') {
    const span = item.querySelector('.voice-state');
    // No DOM write when the text is the same: the stats timer calls this 4 times each second.
    if (span.dataset.state === text && span.dataset.extra === extra) return;
    const icon = VOICE_ICONS[text];
    const words = makeSpan(Object.hasOwn(VOICE_TIPS, text) ? 'sr-only' : 'voice-words', text);
    let shown = extra;
    // The separator after the hidden words is hidden too: the line shows "[icon] Raid · 40%".
    if (words.className === 'sr-only' && shown.startsWith(' · ')) {
        words.textContent += ' · ';
        shown = shown.slice(3);
    }
    const parts = [];
    if (icon) {
        const mark = document.createElement('span');
        mark.className = 'state-icon voice-icon';
        mark.dataset.icon = icon;
        mark.setAttribute('aria-hidden', 'true');
        parts.push(mark);
    }
    parts.push(words);
    if (shown) parts.push(makeSpan('voice-extra', shown));
    span.replaceChildren(...parts);
    span.title = VOICE_TIPS[text] ? VOICE_TIPS[text] + (extra ? extra : '') : '';
    span.dataset.state = text;
    span.dataset.extra = extra;
}

// C5: the choice of this listener for a person (Listening dialog).
function listeningTo(peerId) {
    return window.voice.listeningFor?.(peerId) ?? { muted: false, volume: 100 };
}

// C1: the texts of the voice state, while in voice. Each text goes away when its cause goes away.
function voiceStateText(state) {
    if (!ownInVoice) return '';
    const texts = [];
    if (state.capturing === false && state.captureError) {
        texts.push(window.voice.microphoneErrorText?.(state.captureError, true) ?? 'Mic didn\'t start.');
    } else if (state.capturing === true && state.inputFallback === true) {
        texts.push('Mic disconnected. Using the default.');
    }
    if (state.outputFallback === true) texts.push('Speakers disconnected. Using the default.');
    return texts.join(' ');
}

window.asscrack.onVoiceRoster?.(data => {
    const rows = Array.isArray(data?.members) ? data.members : [];
    voiceRoster = new Map(rows.filter(row => typeof row?.peerId === 'string').map(row => [row.peerId, row.channel]));
    updateVoiceView();
});

function updateVoiceView() {
    const state = window.voice.state();
    const members = state.members ?? {};
    const speakers = monitorActive ? [] : null;
    if (state.self) selfId = state.self;
    if (state.host !== undefined && state.host !== null) hostId = state.host;
    // voice.js keeps the mute and Deafen state. This copy follows it.
    if (typeof state.muted === 'boolean') ownMuted = state.muted;
    if (typeof state.deafened === 'boolean') ownDeafened = state.deafened;
    for (const [peerId, item] of peerItems) {
        item.querySelector('.host-mark').hidden = peerId !== hostId;
        let text = 'not in voice';
        let extra = '';
        let talking = false;
        const member = members[peerId];
        // M4 (P10b): the host gets voice for this person, but this person sent no voice line to this computer.
        const hiddenListener = !member?.inVoice && voiceRoster.has(peerId);
        if (hiddenListener) {
            text = 'listening (not in voice for you)';
            extra = channelSuffix(voiceRoster.get(peerId));
        } else if (member?.inVoice) {
            const listen = listeningTo(peerId);
            talking = !listen.muted && !member.muted && speaking.has(peerId);
            if (listen.muted) text = 'muted for you';
            else if (member.deafened) text = 'in voice (deafened)';
            else if (member.muted) text = 'in voice (muted)';
            else text = talking ? 'speaking' : 'in voice';
            // G6, G4: state, channel, volume ("in voice (muted) · Raid · 40%").
            extra = channelSuffix(member.channel);
            if (listen.volume !== 100) extra += ` · ${listen.volume}%`;
        }
        // G4: the tooltip of the line gives the listening choice when it is not the default.
        const choice = listeningTo(peerId);
        const tip = choice.muted || choice.volume !== 100
            ? `Volume ${choice.volume}%${choice.muted ? ' · muted by you' : ''}` : peerId;
        if (item.title !== tip) item.title = tip;
        if (speakers && talking) speakers.push(peerNames.get(peerId) || peerId.slice(-8));
        setVoiceState(item, text, extra);
    }
    if (selfLine) {
        selfLine.querySelector('.host-mark').hidden = selfId === null || selfId !== hostId;
        let text = ownMuted ? 'not in voice (mic muted)' : 'not in voice';
        // transmitting: the send gate of voice.js is open (voice activity or push to talk).
        if (ownInVoice) {
            if (ownDeafened) text = 'in voice (deafened)';
            else if (state.capturing === false) text = 'in voice (no microphone)';
            else if (ownMuted) text = 'in voice (muted)';
            else text = state.transmitting ? 'speaking' : 'in voice';
        }
        if (speakers && text === 'speaking') speakers.unshift('You');
        setVoiceState(selfLine, text, ownInVoice ? channelSuffix(state.channel) : '');
    }
    renderVoiceChannels(state, members);
    const errorText = voiceFailText || voiceStateText(state);
    // #voice-error is an alert: write it only when the text changes (the stats timer calls this 4 times each second).
    if (voiceError.textContent !== errorText) voiceError.textContent = errorText;
    joinVoiceButton.hidden = ownInVoice;
    joinVoiceButton.disabled = joining;
    leaveVoiceButton.hidden = !ownInVoice;
    // C8: Mute also before Join.
    muteButton.hidden = false;
    muteButton.textContent = ownMuted ? 'Unmute' : 'Mute';
    deafenButton.hidden = !ownInVoice;
    deafenButton.setAttribute('aria-pressed', String(ownDeafened));
    // U8 of the UI copy pass: push to talk is a mic icon that lights while the key is down. The key is the tooltip.
    const ptt = document.getElementById('ptt-state');
    if (ptt) {
        ptt.hidden = !ownInVoice || state.inputMode !== 'ptt';
        ptt.dataset.held = String(state.pttHeld === true);
        const tip = `Push to talk: ${window.voicePanel?.pttKeyName?.() ?? 'not set'}`;
        if (ptt.title !== tip) ptt.title = tip;
        const label = state.pttHeld ? 'Push to talk: sending' : 'Push to talk';
        if (ptt.getAttribute('aria-label') !== label) ptt.setAttribute('aria-label', label);
    }
    muteButton.setAttribute('aria-pressed', String(ownMuted));
    if (speakers) publishMonitorView(state, speakers);
    document.body.classList.toggle('in-voice', ownInVoice);
    updateNodeMap();
}

// G6: the people of each voice channel, for voice-channels-ui.js.
function renderVoiceChannels(state, members) {
    if (!window.voiceChannels) return;
    const people = [];
    if (ownInVoice && selfLine) {
        people.push({ peerId: selfId ?? 'self', name: ownName, self: true, inVoice: true, channel: state.channel ?? 'general',
            muted: ownMuted, deafened: ownDeafened, speaking: state.transmitting === true && !ownMuted });
    }
    for (const [peerId, item] of peerItems) {
        const member = members[peerId];
        if (!member?.inVoice) continue;
        people.push({ peerId, name: item.querySelector('.name').textContent, inVoice: true, channel: member.channel ?? 'general',
            muted: member.muted === true, deafened: member.deafened === true,
            speaking: speaking.has(peerId) && !listeningTo(peerId).muted });
    }
    window.voiceChannels.render({ inVoice: ownInVoice, channel: state.channel ?? 'general', people });
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

// G6: "Join voice" joins the last channel of this run (when it still exists), else General.
async function joinVoice(channelId = lastVoiceChannel) {
    if (joining || ownInVoice) return;
    const channel = window.voiceChannels?.has(channelId) ? channelId : 'general';
    joining = true;
    voiceFailText = '';
    updateVoiceView();
    try {
        // C1 and N1: a microphone error does not stop Join. voice.state() then gives the text.
        await window.voice.join(channel);
        if (window.idlePeer?.isIdle()) return;
        window.roomAttention?.cue('join');
        lastVoiceChannel = channel;
        ownInVoice = true;
        ownDeafened = false;
        startStatsTimer();
    } catch (err) {
        if (err?.message !== 'Voice capture ended') voiceFailText = `Voice error: ${errorText(err)}`;
    } finally {
        joining = false;
        updateVoiceView();
    }
}

// G6: move to a different voice channel. The microphone stays open. My own move plays the join cue.
async function moveVoice(channelId) {
    if (!ownInVoice || joining || window.idlePeer?.isIdle() || !window.voiceChannels?.has(channelId)) return;
    if (channelId === ownVoiceChannel()) return;
    voiceFailText = '';
    try {
        await window.voice.move?.(channelId);
        lastVoiceChannel = channelId;
        window.roomAttention?.cue('join');
    } catch (err) {
        voiceFailText = `Voice error: ${errorText(err)}`;
    }
    updateVoiceView();
}

// G6: the owner deleted my voice channel. The node moved me to General (voice.js follows it).
function voiceChannelMoved(movedFrom) {
    if (lastVoiceChannel === movedFrom?.id) lastVoiceChannel = 'general';
    if (!ownInVoice) return;
    showNotice(window.voiceChannels?.movedText(String(movedFrom?.name ?? '')) ?? '');
    window.roomAttention?.cue('join');
    updateVoiceView();
}

async function leaveVoice() {
    stopStatsTimer();
    ownInVoice = false;
    // C2: Leave turns Deafen off. C8: the mute state stays.
    if (ownDeafened) ownMuted = mutedBeforeDeafen;
    ownDeafened = false;
    updateVoiceView();
    try {
        await window.voice.leave();
        window.roomAttention?.cue('leave');
    } catch (err) {
        voiceFailText = `Voice error: ${errorText(err)}`;
    }
    updateVoiceView();
}

// C8: Mute works also before Join. C2: Unmute while deafened also turns Deafen off.
function toggleMute() {
    if (window.idlePeer?.isIdle()) return;
    if (ownDeafened) {
        ownDeafened = false;
        ownMuted = false;
    } else {
        ownMuted = !ownMuted;
    }
    window.voice.setMuted(ownMuted);
    window.roomAttention?.cue(ownMuted ? 'mute' : 'unmute');
    updateVoiceView();
}

// C2: Deafen, only in voice. Its cues are the mute and unmute cues.
function toggleDeafen() {
    if (!ownInVoice || window.idlePeer?.isIdle()) return;
    if (ownDeafened) {
        ownDeafened = false;
        ownMuted = mutedBeforeDeafen;
    } else {
        mutedBeforeDeafen = ownMuted;
        ownDeafened = true;
        ownMuted = true;
    }
    window.voice.setDeafened(ownDeafened);
    window.roomAttention?.cue(ownDeafened ? 'mute' : 'unmute');
    updateVoiceView();
}

joinVoiceButton.addEventListener('click', () => joinVoice());
leaveVoiceButton.addEventListener('click', leaveVoice);
muteButton.addEventListener('click', toggleMute);
deafenButton.addEventListener('click', toggleDeafen);
// C6 and C2: Ctrl+Shift+M changes Mute and Ctrl+Shift+D changes Deafen, while the room is open. Not a global key:
// the key hook runs only in push-to-talk mode (ptt-hook.mjs).
document.addEventListener('keydown', e => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.repeat || e.defaultPrevented || chatScreen.hidden) return;
    if (e.code === 'KeyM') {
        e.preventDefault();
        toggleMute();
    } else if (e.code === 'KeyD' && ownInVoice) {
        e.preventDefault();
        toggleDeafen();
    }
});
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
// Gap D1: the size of the file, and a small picture for an image.
const fileDraftSize = document.getElementById('file-draft-size');
const fileDraftThumb = document.getElementById('file-draft-thumb');
const removeFileButton = document.getElementById('file-remove');
const fileRecipient = document.getElementById('file-recipient');
const sendFileButton = document.getElementById('send-file');
const transferList = document.getElementById('transfers');
const messagePanel = document.getElementById('message-panel');
let pendingFile = null;
let offeringFile = false;

const RESULT_STATES = new Set(['done', 'failed', 'refused', 'cancelled']);
const MAX_TRANSFER_ROWS = 768;
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

// L2: the real type of a file from a peer. The window shows the extension apart from the name, and a warning for a
// file type that can run a program on Windows when the user opens it.
const PROGRAM_EXTENSIONS = new Set(['exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'msi', 'msp', 'msix', 'appx',
    'appinstaller', 'application', 'appref-ms', 'lnk', 'url', 'scf', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1',
    'psm1', 'hta', 'cpl', 'msc', 'jar', 'reg', 'inf', 'chm', 'dll', 'gadget', 'settingcontent-ms', 'library-ms',
    'iso', 'img', 'vhd', 'vhdx']);
function fileKind(name) {
    const text = String(name ?? '');
    const dot = text.lastIndexOf('.');
    const ext = dot > 0 && dot < text.length - 1 ? text.slice(dot + 1).toLowerCase() : '';
    const program = PROGRAM_EXTENSIONS.has(ext);
    return { ext, program, label: ext ? `.${ext}` : 'no extension',
        warning: program ? `Program file (.${ext}). Open it only if you trust the sender.` : '' };
}
window.fileKind = fileKind;

// Shows the type of a received file on its name element, and the warning on the row.
function showFileKind(item, fileName, name) {
    const kind = fileKind(name);
    fileName.dataset.ext = kind.label;
    fileName.title = kind.warning ? `${name}\n${kind.warning}` : `${name}\nType: ${kind.label}`;
    item.classList.toggle('program-file', kind.program);
    for (const old of [...item.children]) if (old.classList.contains('file-warning')) old.remove();
    if (kind.program) item.append(makeSpan('file-warning', kind.warning));
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
        showStatusError(errorText(err));
        return false;
    }
}

function canRetryTransfer(entry) {
    return peerItems.has(entry.item.dataset.peerId) && entry.retryable && hasApi('retryFile');
}

function renderTransferActions(entry, row) {
    const buttons = row.querySelector('.buttons');
    const hadFocus = buttons.contains(document.activeElement);
    buttons.replaceChildren();
    const key = transferKey(entry.item);
    if (entry.cancelRequested || entry.pauseRequested) {
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
        // P7b: Pause keeps the received part (P7a). A chat attachment can also pause; a Shared download cannot.
        if (hasApi('pauseFile') && !entry.shelf) buttons.append(makeButton('Pause', () => pauseTransfer(key), 'pause'));
        buttons.append(makeButton('Cancel', () => cancelReceive(key), 'cancel-receive'));
    } else if (entry.direction === 'receive' && (entry.state === 'paused' || entry.state === 'waiting')) {
        if (entry.state === 'paused' && entry.resumable && hasApi('resumeFile')) {
            buttons.append(makeButton('Resume', () => resumeTransfer(key), 'resume'));
        }
        if (canDiscardTransfer(entry)) buttons.append(makeButton('Discard', () => discardTransfer(key), 'discard'));
    } else if (entry.state === 'failed' && entry.retryable && hasApi('retryFile')) {
        const online = canRetryTransfer(entry);
        const retry = makeButton(online ? 'Retry' : 'Sender offline', () => retryTransfer(key), 'retry', 'btn-retry');
        retry.disabled = !online;
        buttons.append(retry);
        if (canDiscardTransfer(entry)) buttons.append(makeButton('Discard', () => discardTransfer(key), 'discard'));
    } else if (entry.state === 'failed' && canDiscardTransfer(entry)) {
        buttons.append(makeButton('Discard', () => discardTransfer(key), 'discard'));
    } else if (entry.state === 'done' && entry.revealable && hasApi('revealFile')) {
        buttons.append(makeButton('Show in Explorer', () => revealTransfer(key), 'reveal', 'btn-reveal'));
    }
    if (hadFocus) (buttons.firstElementChild ?? row).focus({ preventScroll: true });
}

// tip: the tooltip of the state text (default: the text). UI copy pass: a raw failure reason or "Delivery not confirmed".
function setTransferState(entry, state, text, tip = text) {
    entry.state = state;
    const render = row => {
        row.dataset.state = state;
        const stateSpan = row.querySelector('.state-text');
        stateSpan.textContent = text;
        stateSpan.title = tip;
        renderTransferActions(entry, row);
    };
    render(entry.item);
    if (entry.card) window.reading.keepPosition(() => render(entry.card));
    if (entry.direction === 'send') updateOfferSummary(entry.headId ?? entry.item.dataset.offerId);
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
    if (ok !== true) setTransferResult(entry, 'failed', 'Failed: offer expired');
    return ok === true;
}

async function retryTransfer(key) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'receive' || entry.state !== 'failed' || !canRetryTransfer(entry)) return false;
    setTransferState(entry, 'requesting', 'Retrying…');
    const ok = await callFile(window.asscrack.retryFile, entry.item.dataset.offerId);
    if (ok !== true && entry.state === 'requesting' && transferKey(entry.item) === key) {
        setTransferResult(entry, 'failed', 'Retry failed');
    }
    return ok === true;
}

function refreshTransferRetries({ peerId }) {
    for (const entry of transfers.values()) {
        if (entry.state !== 'failed' || !entry.retryable || entry.item.dataset.peerId !== peerId) continue;
        renderTransferActions(entry, entry.item);
        if (entry.card) window.reading.keepPosition(() => renderTransferActions(entry, entry.card));
    }
}

window.asscrack.onPeerJoined(refreshTransferRetries);
window.asscrack.onPeerLeft(refreshTransferRetries);

async function refuseTransfer(key) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'receive' || entry.state !== 'offered') return false;
    setTransferState(entry, 'refusing', 'Refusing');
    const ok = await callFile(window.asscrack.refuseFile, entry.item.dataset.offerId);
    if (ok === true) setTransferResult(entry, 'refused', 'Refused');
    else setTransferResult(entry, 'failed', 'Failed: offer expired');
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
        if (!ok) throw new Error('Too late to cancel');
        return true;
    } catch (err) {
        entry.cancelRequested = false;
        if (entry.state === 'receiving') setTransferState(entry, 'receiving', 'Receiving');
        showStatusError(errorText(err));
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
        if (!ok) throw new Error('Too late to cancel');
        return true;
    } catch (err) {
        entry.cancelRequested = false;
        showStatusError(errorText(err));
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
    missing: 'File was moved or deleted.',
    unknown: 'File not found.'
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
        showStatusError(errorText(err));
    }
    return false;
}

// Gap N4: a notice clears after 6 s when the status still has its text. An error text stays.
const NOTICE_MS = 6000;
function showNotice(text) {
    const value = String(text);
    status.textContent = value;
    setTimeout(() => {
        if (status.textContent === value) status.textContent = '';
    }, NOTICE_MS);
}

async function copyToClipboard(text, done) {
    try {
        await window.asscrack.copyText(String(text));
        showNotice(done);
        return true;
    } catch (err) {
        status.textContent = `Copy failed: ${errorText(err)}`;
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
    // C5: setListening gives no change event. The line shows "muted for you" and the volume.
    updateVoiceView();
}

// G4: save the choice when it stops changing (a slider gives many input events). The default removes the entry.
function saveListening() {
    const id = listeningDialog.dataset.peerId;
    if (!listeningDialog.open || !peerItems.has(id)) return;
    const choice = window.voice.listeningFor(id);
    Promise.resolve(window.asscrack.setListening?.(id, choice.muted, choice.volume))
        .catch(err => console.warn('Listening choice not saved:', err?.message ?? err));
}

// G4: Reset and a double-click on the label of the slider.
function setListeningVolume(volume, muted = listenerMuted.checked) {
    listenerMuted.checked = muted;
    listenerVolume.value = String(volume);
    changeListening();
    saveListening();
}

listenerMuted?.addEventListener('change', () => {
    changeListening();
    saveListening();
});
listenerVolume?.addEventListener('input', changeListening);
listenerVolume?.addEventListener('change', saveListening);
document.getElementById('listener-volume-label')?.addEventListener('dblclick', () => setListeningVolume(100));
document.getElementById('listener-reset')?.addEventListener('click', () => setListeningVolume(100, false));

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
    if (peerId !== self && window.peerInspector?.open(peerId)) return true;
    if (window.nodeMap?.highlight?.(peerId)) return true;
    status.textContent = 'Not on the map yet.';
    return false;
}

// Copy the body of a chat line (not the name and not the time).
// The image menu (menu.js, chat-media.js).
async function copyChatImage(row) {
    const ok = await Promise.resolve(window.chatMedia?.copyImage?.(row)).catch(() => false);
    showNotice(ok ? 'Image copied.' : 'Couldn\'t copy the image.');
    return ok === true;
}
async function saveChatImage(row) {
    const result = await Promise.resolve(window.chatMedia?.saveImage?.(row)).catch(() => null);
    if (result?.reason === 'canceled') return false;
    if (result?.pending) showNotice('Downloading the original. It is saved when the download is complete.');
    else if (result?.ok) showNotice(`Saved ${result.name}.`);
    else showNotice(result?.text || (result?.reason === 'unavailable' ? 'The original is not available now.' : 'Couldn\'t save the image.'));
    return result?.ok === true;
}
async function openChatOriginal(row) {
    const ok = await Promise.resolve(window.chatMedia?.openOriginal?.(row)).catch(() => false);
    if (!ok) showNotice('The original is not on this computer.');
    return ok === true;
}
if (hasApi('onMediaSaved')) {
    window.asscrack.onMediaSaved(result => showNotice(result?.ok ? `Saved ${result.name}.` : 'Couldn\'t save the image.'));
}

function copyMessageText(row) {
    if (!row || row.parentElement !== messageList) return false;
    return copyToClipboard(row.querySelector('.text')?.textContent ?? '', 'Message copied.');
}

// The image fields of a message row (menu.js): image, copyImage (a preview is shown), original (on this computer).
function imageInfo(row) {
    if (window.chatMedia?.hasImage?.(row) !== true) return { image: false };
    return { image: true, copyImage: window.chatMedia.canCopy?.(row) === true, original: window.chatAttachments?.hasOriginal?.(row) === true };
}

// The data of a row for menu.js (menuCore.actionsFor), from the state now. null: the row has no menu now.
function rowInfo(row) {
    // A note row (transcript-notes.js) has no menu.
    if (!row || !row.isConnected || row.classList.contains('note')) return null;
    if (row.parentElement === peerList) {
        if (row === selfLine) return { kind: 'buddy', inspect: Boolean(window.peerInspector), self: true, availability: Boolean(presenceControls), onMap: buddyId(row) !== null };
        if (buddyId(row) === null) return null;
        // G7a: friend is 'add', 'open' or null (friends-ui.js knows the friends and the protected room peers).
        return { kind: 'buddy', inspect: Boolean(window.peerInspector), whisper: Boolean(window.whispers), self: false, onMap: true, friend: window.friendsUi?.relation(buddyId(row)) ?? null,
            // P8b: "Watch screen" on the line of a member that shares (screen-view.js).
            watch: window.screenView?.canWatch(buddyId(row)) === true,
            // Diagnostics (1.0.1): "Ask for diagnostics…" (diagnostics-ui.js).
            diag: window.diagnosticsUi?.canAsk(buddyId(row)) === true };
    }
    if (row.parentElement === messageList && !row.classList.contains('file-card')) {
        return { kind: 'message', details: Boolean(row.querySelector('.text')), inspect: Boolean(window.peerInspector && peerItems.has(row.dataset.peerId)), quotable: selfLine !== null && row.querySelector('.text') !== null, localOnly: row.classList.contains('local-only'), link: Boolean(window.chatLinks?.firstLink(row)), ...imageInfo(row) };
    }
    // G6: a voice channel row (voice-channels-ui.js).
    if (row.parentElement?.id === 'voice-channel-list') return window.voiceChannels?.rowInfo(row) ?? null;
    // G7a: a row of the Friends panel (friends-ui.js).
    if (row.parentElement?.id === 'friend-list') return window.friendsUi?.rowInfo(row) ?? null;
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
            canRetry: canRetryTransfer(entry) === true,
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
        case 'watch-screen': return Boolean(buddyId(row) && window.screenView?.watch(buddyId(row)));
        case 'show-on-map': return showBuddyOnMap(buddyId(row));
        case 'copy-message': return copyMessageText(row);
        case 'open-link': return window.chatLinks?.openFirst(row) ?? false;
        case 'view-image': return window.chatMedia?.viewImage?.(row) ?? false;
        case 'copy-image': return copyChatImage(row);
        case 'save-image': return saveChatImage(row);
        case 'open-original': return openChatOriginal(row);
        case 'quote': return quoteMessage(row);
        case 'resend': return resendMessage(row);
        case 'accept': return acceptTransfer(transferKey(row));
        case 'retry': return retryTransfer(transferKey(row));
        case 'refuse': return refuseTransfer(transferKey(row));
        case 'cancel-receive': return cancelReceive(transferKey(row));
        case 'cancel-receiver': return cancelToReceiver(transferKey(row));
        case 'cancel-offer': return cancelWholeOffer(row.dataset.offerId);
        case 'reveal': return revealTransfer(transferKey(row));
        case 'pause': return pauseTransfer(transferKey(row));
        case 'resume': return resumeTransfer(transferKey(row));
        case 'discard': return discardTransfer(transferKey(row));
        case 'rename-voice-channel': return window.voiceChannels?.rename(row) ?? false;
        case 'delete-voice-channel': return window.voiceChannels?.remove(row) ?? false;
        case 'add-friend': return window.friendsUi?.add(buddyId(row)) ?? false;
        case 'ask-diagnostics': return Boolean(buddyId(row) && row !== selfLine && window.diagnosticsUi?.ask(buddyId(row)));
        case 'open-friend-chat': return window.friendsUi?.openFor(buddyId(row)) ?? false;
        case 'friend-open': case 'friend-rename': case 'friend-remove': case 'friend-block': case 'friend-invite': case 'friend-join':
            return window.friendsUi?.run(action, row) ?? false;
        default: return false;
    }
}

window.roomActions = Object.freeze({
    rowInfo, editAvailability,
    // Diagnostics (diagnostics-ui.js): the name and the device mark of a buddy for the prompt texts.
    peerLabel: peerId => ({ name: peerNames.get(peerId) ?? null, mark: peerMarks.get(peerId) ?? null }),
    run: runRowAction,
    notice: text => showNotice(text)
});

function makeTransferRow(offerId, peerId, direction, info, className) {
    const item = document.createElement('li');
    item.className = className;
    item.dataset.offerId = String(offerId);
    item.dataset.peerId = String(peerId);
    item.dataset.direction = direction;
    const progress = document.createElement('progress');
    progress.setAttribute('aria-label', 'Progress');
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
    if (direction === 'receive') showFileKind(item, fileName, info.name);
    return item;
}

function getTransfer(offerId, peerId, direction, info = {}) {
    const key = `${offerId}|${peerId}`;
    let entry = transfers.get(key);
    if (entry) return entry;
    for (const [previousKey, previous] of transfers) {
        if (transfers.size < MAX_TRANSFER_ROWS) break;
        if (!RESULT_STATES.has(previous.state) || previous.retryable ||
            previous.item.contains(document.activeElement) || previous.card?.contains(document.activeElement)) continue;
        previous.item.remove();
        if (previous.card) window.reading.keepPosition(() => previous.card.remove());
        if (previous.richOffer) window.chatAttachments?.forgetOffer?.(previous.richOffer, previous);
        transfers.delete(previousKey);
        const previousOffer = previous.item.dataset.offerId;
        const head = offerHeads.get(previousOffer);
        if (head) {
            const index = head.rows.indexOf(previous);
            if (index !== -1) head.rows.splice(index, 1);
            if (head.rows.length) updateOfferSummary(previousOffer);
            else { head.item.remove(); offerHeads.delete(previousOffer); }
        }
    }
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

function setTransferResult(entry, state, text, tip = text) {
    if (RESULT_STATES.has(entry.state)) return;
    entry.cancelRequested = false;
    entry.pauseRequested = false;
    setTransferState(entry, state, text, tip);
}

// P6 of the UI copy pass: the short window text of a transfer failure reason (src/network/file-transfer.mjs). An
// unknown reason gives "Failed"; the tooltip has the raw reason.
const FAIL_TEXTS = {
    'peer left': 'they left', 'stream ended': 'connection lost', 'transfer stalled': 'stalled',
    'too many active file transfers': 'too many transfers', 'not enough disk space': 'disk full',
    'offer expired': 'offer expired', 'resume expired': 'resume expired', 'retry expired': 'retry expired',
    'retry request timed out': 'no answer', 'the sender can no longer offer this file': 'no longer offered',
    'the source file changed': 'file changed', 'original file changed': 'file changed',
    'the paused part is over the storage budget': 'no space for the partial file'
};
function failText(reason) {
    const short = FAIL_TEXTS[reason];
    return short ? `Failed: ${short}` : 'Failed';
}

window.asscrack.onFileOffer(data => {
    if (data.retryOf) {
        const previousKey = `${data.retryOf}|${data.peerId}`;
        const entry = liveTransfer(previousKey);
        if (!entry || entry.direction !== 'receive' || entry.state !== 'requesting') return;
        transfers.delete(previousKey);
        for (const row of [entry.item, entry.card].filter(Boolean)) {
            row.dataset.offerId = data.offerId;
            const progress = row.querySelector('progress');
            progress.value = 0;
            showProgress(progress);
        }
        const key = transferKey(entry.item);
        transfers.set(key, entry);
        entry.retryable = false;
        setTransferState(entry, 'offered', 'Offered');
        void acceptTransfer(key);
        return;
    }
    const entry = getTransfer(data.offerId, data.peerId, 'receive', data);
    if (entry.card || entry.state !== null) return;
    if (data.shelfId) {
        // P7b: the Shared panel has no paused state (shared-shelf.mjs), thus a shelf receive has no Pause.
        entry.shelf = true;
        setTransferState(entry, 'receiving', 'Receiving');
        return;
    }
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

window.asscrack.onFileRetried?.(data => {
    // P7b: the row that the receiver paused continues as the new attempt. P7c: after a restart of the receiver, the
    // node gives the peer ID of the paused row in previousPeerId, and the row moves to the new peer ID.
    const previousPeer = typeof data.previousPeerId === 'string' ? data.previousPeerId : data.peerId;
    const paused = liveTransfer(`${data.retryOf}|${previousPeer}`);
    if (paused && paused.direction === 'send' && paused.state === 'paused') {
        moveTransfer(paused, data.offerId, data.peerId);
        setTransferState(paused, 'offered', 'Resume offered');
        return;
    }
    const entry = getTransfer(data.offerId, data.peerId, 'send', data);
    if (entry.state === null) setTransferState(entry, 'offered', 'Retry offered');
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

window.asscrack.onShelfOffered?.(data => {
    const entry = getTransfer(data.offerId, data.peerId, 'send', data);
    if (entry.state === null) setTransferState(entry, 'offered', 'Offered');
});

window.asscrack.onFileDone(data => {
    linkResume(data);
    const entry = transferForEvent(data);
    if (RESULT_STATES.has(entry.state)) return;
    for (const row of [entry.item, entry.card].filter(Boolean)) {
        const progress = row.querySelector('progress');
        progress.value = progress.max;
        showProgress(progress);
    }
    if (data.direction === 'receive') {
        const fileName = typeof data.savedName === 'string' ? data.savedName : '';
        entry.revealable = Boolean(fileName);
        setTransferResult(entry, 'done', `Saved as ${fileName}`);
    } else {
        entry.confirmed = data.confirmed === true;
        const text = data.confirmed === true ? 'Delivered' : 'Sent ?';
        // P7b: a resumed send gives the bytes of this attempt (P7a: `sent`).
        const resumed = Number(data.offset) > 0 && Number.isFinite(Number(data.sent));
        const full = resumed ? `${text} · ${formatSize(data.sent)} after resume` : text;
        setTransferResult(entry, 'done', full, data.confirmed === true ? full : 'Delivery not confirmed');
    }
});

window.asscrack.onFileFailed(data => {
    linkResume(data);
    const entry = transferForEvent(data);
    if (entry.state !== 'failed' && RESULT_STATES.has(entry.state)) return;
    entry.retryable = data.retryable === true;
    entry.cancelRequested = false;
    entry.pauseRequested = false;
    setTransferState(entry, 'failed', failText(data.reason), String(data.reason ?? ''));
});
window.asscrack.onFileRefused(data => setTransferResult(transferForEvent({ ...data, direction: 'send' }), 'refused', 'Refused'));
window.asscrack.onFileCancelled(data => {
    linkResume(data);
    setTransferResult(transferForEvent(data), 'cancelled', 'Cancelled');
});

// ---- P7b: Pause, Resume and Discard of a received file (P7a is the node part) ----
// A paused receive keeps its part on disk. The key of the part is the SHA-256 and the size of the offer. A resume
// attempt has a new offer ID and no file-offer event: its first event has resumeOf, and linkResume moves the row
// to the new ID. A part of an earlier session gets its own row ("kept row"). P7c: in a protected room the node keeps
// the retry state of the part, thus the kept row has Resume. Else only a new offer of the same file continues it.
const keptPartials = new Map(); // key -> the Partial of the node (no path)
let discardKey = null;
let discardBound = false;

function moveTransfer(entry, offerId, peerId) {
    const oldKey = transferKey(entry.item);
    for (const row of [entry.item, entry.card].filter(Boolean)) {
        row.dataset.offerId = String(offerId);
        if (typeof peerId === 'string') row.dataset.peerId = peerId;
    }
    transfers.delete(oldKey);
    transfers.set(transferKey(entry.item), entry);
}

function linkResume(data) {
    if (typeof data?.resumeOf !== 'string' || data.direction !== 'receive') return null;
    if (transfers.has(`${data.offerId}|${data.peerId}`)) return null;
    // P7c: after a restart of the sender, the resume attempt comes from a new peer ID of the same device.
    let entry = liveTransfer(`${data.resumeOf}|${data.peerId}`);
    if (!entry) {
        entry = [...transfers.values()].find(item => item.direction === 'receive' && item.item.isConnected &&
            item.item.dataset.offerId === data.resumeOf) ?? null;
    }
    if (!entry || entry.direction !== 'receive') return null;
    moveTransfer(entry, data.offerId, data.peerId);
    return entry;
}

function setProgress(entry, bytes, size) {
    for (const row of [entry.item, entry.card].filter(Boolean)) {
        const progress = row.querySelector('progress');
        if (Number(size) > 0) progress.max = Number(size);
        progress.value = Number(bytes) || 0;
        showProgress(progress);
    }
}

function keptPartOf(entry) {
    return entry.partialKey ? keptPartials.get(entry.partialKey) ?? null : null;
}

function canDiscardTransfer(entry) {
    const partial = keptPartOf(entry);
    return entry.direction === 'receive' && partial !== null && partial.active !== true && hasApi('discardPartial');
}

function pausedText(entry) {
    const partial = keptPartOf(entry);
    const bytes = partial?.bytes ?? entry.keptBytes ?? 0;
    const size = partial?.size ?? entry.keptSize ?? 0;
    const parts = ['Paused', `${formatSize(bytes)} of ${formatSize(size)}`];
    const expiresAt = Number(partial?.expiresAt);
    if (partial && Number.isFinite(expiresAt) && expiresAt > 0) parts.push(`kept until ${new Date(expiresAt).toLocaleString()}`);
    if (entry.kept && !entry.resumable) parts.push('resumes when the sender is back');
    return parts.join(' · ');
}

// P7c: the sender of a row is in the room with its peer ID, or with a new peer ID after its restart (the same name;
// the node then finds the sender by its device ID and refuses all other peers).
function senderPresent(entry) {
    const peerId = entry.item.dataset.peerId;
    if (peerItems.has(peerId)) return true;
    const name = entry.from || peerNames.get(peerId);
    return Boolean(name) && [...peerItems.keys()].some(id => peerNames.get(id) === name);
}

async function pauseTransfer(key) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'receive' || entry.state !== 'receiving' || entry.cancelRequested ||
        entry.pauseRequested || !hasApi('pauseFile')) return false;
    entry.pauseRequested = true;
    setTransferState(entry, 'receiving', 'Pausing…');
    const ok = await callFile(window.asscrack.pauseFile, entry.item.dataset.offerId);
    if (ok !== true && entry.pauseRequested) {
        entry.pauseRequested = false;
        if (entry.state === 'receiving') setTransferState(entry, 'receiving', 'Receiving');
        status.textContent = 'Can\'t pause now.';
    }
    return ok === true;
}

// Resume asks the sender again, on any open route. With no session to the sender, the row waits for it.
async function resumeTransfer(key, fromJoin = false) {
    const entry = liveTransfer(key);
    if (!entry || entry.direction !== 'receive' || (entry.state !== 'paused' && entry.state !== 'waiting') ||
        !entry.resumable || !hasApi('resumeFile')) return false;
    const peerId = entry.item.dataset.peerId;
    entry.from ||= peerNames.get(peerId) ?? '';
    const waiting = () => setTransferState(entry, 'waiting', `Waiting for ${transferPeerName(peerId, entry.from)}`);
    if (!fromJoin && !senderPresent(entry)) {
        waiting();
        return false;
    }
    setTransferState(entry, 'requesting', 'Resuming…');
    // P7c: a kept row that resumes is a normal row from now on. Its part is in use during the receive.
    entry.kept = false;
    const ok = await callFile(window.asscrack.resumeFile, entry.item.dataset.offerId);
    if (ok === true) {
        entry.waitRetried = false;
        return true;
    }
    if (entry.state !== 'requesting' || transferKey(entry.item) !== key) return false;
    if (fromJoin || !senderPresent(entry)) {
        waiting();
        // The session of a peer that came back can need a moment before the node accepts a file line.
        if (fromJoin && !entry.waitRetried) {
            entry.waitRetried = true;
            setTimeout(() => { if (entry.state === 'waiting') void resumeTransfer(transferKey(entry.item), true); }, 2000);
        }
    } else setTransferState(entry, 'paused', `${pausedText(entry)} · Resume failed`);
    return false;
}

function resumeWaiting(peerId) {
    for (const [key, entry] of [...transfers]) {
        if (entry.state !== 'waiting') continue;
        // P7c: a sender with a new peer ID (its restart) has the same name. Its name comes after the join.
        const name = entry.from || peerNames.get(entry.item.dataset.peerId);
        if (entry.item.dataset.peerId === peerId || (name && peerNames.get(peerId) === name)) void resumeTransfer(key, true);
    }
}

window.asscrack.onPeerJoined(data => resumeWaiting(data?.peerId));
window.asscrack.onPeerName?.(data => { if (typeof data?.peerId === 'string') queueMicrotask(() => resumeWaiting(data.peerId)); });

function discardTransfer(key) {
    const entry = liveTransfer(key);
    const dialog = document.getElementById('discard-dialog');
    if (!entry || !canDiscardTransfer(entry) || !dialog) return false;
    discardKey = key;
    const name = entry.item.querySelector('.file-name').textContent;
    document.getElementById('discard-text').textContent =
        `Discard the partial download of ${name}? It will restart from the beginning.`;
    if (!discardBound) {
        discardBound = true;
        document.getElementById('discard-confirm').addEventListener('click', () => {
            dialog.close();
            void confirmDiscard();
        });
    }
    if (!dialog.open) dialog.showModal();
    return true;
}

async function confirmDiscard() {
    const key = discardKey;
    discardKey = null;
    const entry = key ? liveTransfer(key) : null;
    if (!entry || !canDiscardTransfer(entry)) return false;
    const partialKey = entry.partialKey;
    const ok = await callFile(window.asscrack.discardPartial, partialKey);
    if (ok !== true) {
        status.textContent = 'Partial file is in use or gone.';
        return false;
    }
    partialGone(partialKey, 'Partial file discarded.');
    return true;
}

// The node deleted a kept part (Discard, expiry or another reason). A row that waits on it gets the text.
function partialGone(key, text) {
    keptPartials.delete(key);
    for (const entry of transfers.values()) {
        if (entry.partialKey !== key) continue;
        entry.partialKey = null;
        if (entry.kept || entry.state === 'paused' || entry.state === 'waiting') {
            if (entry.kept) entry.retryable = false;
            entry.pauseRequested = false;
            setTransferState(entry, 'failed', text);
        } else {
            renderTransferActions(entry, entry.item);
            if (entry.card) window.reading.keepPosition(() => renderTransferActions(entry, entry.card));
        }
    }
}

function removeKeptRow(key, entry) {
    entry.item.remove();
    transfers.delete(key);
    transferCount.textContent = String(transfers.size);
}

function keptRow(partial) {
    // P7c: a part with a retry state gets the offer ID and the sender of its last attempt, thus Resume works.
    const resumable = partial.resumable === true && typeof partial.offerId === 'string' && typeof partial.peerId === 'string' &&
        hasApi('resumeFile');
    const from = typeof partial.from === 'string' ? partial.from : '';
    const entry = resumable
        ? getTransfer(partial.offerId, partial.peerId, 'receive', { name: partial.name, size: partial.size, from })
        : getTransfer(`kept-${partial.key}`, 'kept', 'receive', { name: partial.name, size: partial.size });
    if (entry.kept || entry.state !== null) return;
    Object.assign(entry, { kept: true, partialKey: partial.key, resumable, retryable: resumable, from });
    const peer = entry.item.querySelector('.peer-name');
    peer.textContent = resumable ? `from ${transferPeerName(partial.peerId, from)} (earlier)` : 'from earlier';
    peer.title = peer.textContent;
    setProgress(entry, partial.bytes, partial.size);
    setTransferState(entry, 'paused', pausedText(entry));
}

// The list of the kept parts (file-partials and listPartials). Each part links to the row of its last offer, else
// it gets a kept row. A kept row goes away when a receive uses its part.
function syncPartials(list) {
    if (!Array.isArray(list)) return;
    keptPartials.clear();
    for (const partial of list) if (typeof partial?.key === 'string') keptPartials.set(partial.key, partial);
    for (const partial of keptPartials.values()) {
        let linked = false;
        for (const entry of transfers.values()) {
            if (entry.direction !== 'receive') continue;
            if (entry.partialKey === partial.key || (!entry.kept && entry.item.dataset.offerId === partial.offerId)) {
                entry.partialKey = partial.key;
                linked = true;
            }
        }
        if (!linked && partial.active !== true) keptRow(partial);
    }
    for (const [key, entry] of [...transfers]) {
        if (!entry.partialKey || !entry.item.isConnected) continue;
        const partial = keptPartials.get(entry.partialKey);
        if (entry.kept && (!partial || partial.active === true)) removeKeptRow(key, entry);
        else if (entry.state === 'paused' && partial) setTransferState(entry, 'paused', pausedText(entry));
        else {
            renderTransferActions(entry, entry.item);
            if (entry.card) window.reading.keepPosition(() => renderTransferActions(entry, entry.card));
        }
    }
}

async function refreshKeptPartials() {
    if (!hasApi('listPartials')) return;
    try { syncPartials(await window.asscrack.listPartials()); } catch { /* The file-partials event comes later. */ }
}

window.asscrack.onFilePaused?.(data => {
    linkResume(data);
    const direction = data.direction === 'receive' ? 'receive' : 'send';
    const entry = getTransfer(data.offerId, data.peerId, direction, data);
    if (RESULT_STATES.has(entry.state)) return;
    entry.pauseRequested = false;
    entry.cancelRequested = false;
    if (direction === 'send') {
        setTransferState(entry, 'paused', `Paused by ${transferPeerName(data.peerId)} · ${formatSize(data.bytes)} of ${formatSize(data.size)}`);
        return;
    }
    entry.partialKey = typeof data.key === 'string' ? data.key : null;
    entry.keptBytes = Number(data.bytes) || 0;
    entry.keptSize = Number(data.size) || 0;
    // An attachment or a shelf file cannot resume (P7a): only a new offer continues it.
    entry.resumable = data.resumable === true;
    entry.retryable = data.resumable === true;
    setProgress(entry, entry.keptBytes, entry.keptSize);
    setTransferState(entry, 'paused', pausedText(entry));
});

window.asscrack.onFileResumed?.(data => {
    linkResume(data);
    const send = data.direction !== 'receive';
    const entry = getTransfer(data.offerId, data.peerId, send ? 'send' : 'receive', data);
    if (RESULT_STATES.has(entry.state)) return;
    setProgress(entry, data.offset, data.size);
    setTransferState(entry, send ? 'sending' : 'receiving', `${send ? 'Sending' : 'Receiving'} · resuming at ${formatSize(data.offset)}`);
});

window.asscrack.onFileRestarted?.(data => {
    linkResume(data);
    const entry = getTransfer(data.offerId, data.peerId, 'receive', data);
    if (RESULT_STATES.has(entry.state)) return;
    setProgress(entry, 0);
    setTransferState(entry, 'receiving', 'Restarted from the beginning.');
});

window.asscrack.onFileExpired?.(partial => {
    if (typeof partial?.key === 'string') partialGone(partial.key, 'Partial file expired.');
});

window.asscrack.onFileDiscarded?.(partial => {
    if (typeof partial?.key !== 'string' || !keptPartials.has(partial.key)) return;
    partialGone(partial.key, partial.reason === 'user'
        ? 'Partial file discarded.'
        : `Partial file deleted (${partial.reason ?? 'unknown'}).`);
});

window.asscrack.onFilePartials?.(data => syncPartials(data?.partials));

const offerHeads = new Map();

function updateOfferSummary(offerId) {
    const head = offerHeads.get(offerId);
    if (!head) return;
    const counts = new Map();
    const labels = { offered: 'waiting', sending: 'sending', paused: 'paused', refused: 'declined', failed: 'failed', cancelled: 'cancelled' };
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
        entry.headId = offerId;
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

// A media file goes with postMedia (a chat line with a preview).
function isMediaFile(file) {
    return /\.(png|jpe?g|webp|gif|mp4|webm|m4v|mov|ogv)$/i.test(file?.name ?? '') || file?.type === 'image/png';
}

// Gap D1: a 48 px picture of an image file of 16 MiB or less, made with createImageBitmap (no blob: URL: the
// content security policy has no blob: source). On an error there is no picture.
const DRAFT_THUMB_PX = 48;
const DRAFT_THUMB_MAX_BYTES = 16 * 1024 * 1024;
let thumbFile = null;
async function drawDraftThumb(file) {
    if (!fileDraftThumb) return;
    fileDraftThumb.hidden = true;
    if (!file || !String(file.type).startsWith('image/') || file.size > DRAFT_THUMB_MAX_BYTES
        || typeof createImageBitmap !== 'function') return;
    let bitmap = null;
    try {
        bitmap = await createImageBitmap(file);
        if (thumbFile !== file || !bitmap.width || !bitmap.height) return;
        const scale = Math.min(DRAFT_THUMB_PX / bitmap.width, DRAFT_THUMB_PX / bitmap.height, 1);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        fileDraftThumb.width = DRAFT_THUMB_PX;
        fileDraftThumb.height = DRAFT_THUMB_PX;
        const context = fileDraftThumb.getContext('2d');
        context.clearRect(0, 0, DRAFT_THUMB_PX, DRAFT_THUMB_PX);
        context.drawImage(bitmap, (DRAFT_THUMB_PX - width) / 2, (DRAFT_THUMB_PX - height) / 2, width, height);
        fileDraftThumb.hidden = false;
    } catch {
        fileDraftThumb.hidden = true;
    } finally {
        bitmap?.close?.();
    }
}

function updateFileDraft() {
    fileDraft.hidden = pendingFile === null;
    fileDraftName.textContent = pendingFile?.name ?? '';
    fileDraftName.title = fileDraftName.textContent;
    if (fileDraftSize) fileDraftSize.textContent = pendingFile ? formatSize(pendingFile.size) : '';
    if (pendingFile !== thumbFile) {
        thumbFile = pendingFile;
        void drawDraftThumb(pendingFile);
    }
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
        status.textContent = 'Recipient is offline. Choose another.';
        return;
    }
    offeringFile = true;
    updateFileDraft();
    const file = pendingFile, reply = messageInput.value, quote = pendingQuote;
    const caption = window.quoteCore.compose(quote, reply);
    const channelId = window.roomChannels?.active() ?? 'general';
    try {
        const media = isMediaFile(file);
        let posted;
        if (media && typeof window.asscrack.postMedia === 'function') {
            posted = await window.asscrack.postMedia(file, caption, channelId, recipientId);
        }
        const result = posted?.offer ?? await window.asscrack.offerFile(file, recipientId);
        if (result.peers === 0) {
            status.textContent = 'No one received the file.';
            return null;
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
        // Gap N5: an offer with no chat line gets a note row in the channel, thus the sender sees it in the chat.
        if (!posted?.message) {
            const size = formatSize(Number.isFinite(result.size) ? result.size : file.size);
            const audience = recipientId === undefined ? 'the room' : transferPeerName(recipientId);
            window.transcriptNotes?.append('offer', `You offered ${result.name ?? file.name} (${size}) to ${audience}.`, Date.now(), channelId);
        }
        if (!window.roomChannels || window.roomChannels.isViewing(channelId)) {
            if (pendingFile === file) pendingFile = null;
        } else window.roomChannels.fileSent(channelId, file);
        if (!window.whispers?.isOpen?.() && (document.activeElement === document.body || composer.contains(document.activeElement))) {
            messageInput.focus({ preventScroll: true });
        }
        status.textContent = '';
        return result;
    } catch (err) {
        showStatusError(errorText(err));
        return null;
    } finally {
        offeringFile = false;
        updateFileDraft();
    }
}

// Gap N7: a paste of exactly one file that has a local path (for example a file copied in Explorer) attaches it.
// The preload says only true or false (canSendFile), never the path. Else a PNG of the clipboard (a screenshot)
// attaches as before.
messageInput.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 1 && window.asscrack.canSendFile?.(files[0]) === true) {
        event.preventDefault();
        attachFile(files[0]);
        messageInput.focus({ preventScroll: true });
        return;
    }
    const item = Array.from(event.clipboardData?.items ?? []).find(item => item.kind === 'file' && item.type === 'image/png');
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    if (file.size > 16 * 1024 * 1024) { status.textContent = 'Image too large (16 MB max).'; return; }
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
            status.textContent = 'Attach one file at a time.';
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
let topologyScreenEdges = []; // active screen share forwarding edges: [{ from, to, sharer }]
let topologyMusicEdges = []; // active music forwarding edges: [{ from, to, dj }]
let fullNodeSelf = false; // true when this computer is a full node (getFullNode)
let fullNodePeers = new Set(); // the peer IDs of the full nodes (getFullNode, full-node events)
let topologySelf = null;

function setTopology(data) {
    if (data === null || typeof data !== 'object') return;
    if (data.links !== null && typeof data.links === 'object') topologyLinks = data.links;
    if (data.kinds !== null && typeof data.kinds === 'object') topologyKinds = data.kinds;
    if (Array.isArray(data.screenEdges)) topologyScreenEdges = data.screenEdges;
    if (Array.isArray(data.musicEdges)) topologyMusicEdges = data.musicEdges;
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

// Gaps A7 and N6: the number of transfers of this computer in the state sending or receiving (app-shell.js).
window.roomTransfers = {
    activeCount: () => [...transfers.values()].filter(entry => entry.state === 'sending' || entry.state === 'receiving').length
};

// The nodes are the lines of the buddy list. The voice data is the data of updateVoiceView().
// The transfers are the rows of this computer with the state sending or receiving.
function updateNodeMap() {
    if (!window.nodeMap || !selfLine) return;
    const voice = window.voice.state();
    const members = voice.members ?? {};
    const self = selfId ?? topologySelf;
    const nodes = [];
    if (self) {
        selfLine.dataset.peerId = self;
        nodes.push({ id: self, name: ownName, color: nameColorClass(ownName), idle: selfIdle, inVoice: voice.inVoice === true, muted: ownMuted, speaking: voice.transmitting === true && !ownMuted, fullNode: fullNodeSelf, channel: window.voiceChannels?.label(voice.channel ?? 'general') ?? '' });
    }
    for (const [peerId, item] of peerItems) {
        const name = item.querySelector('.name').textContent;
        nodes.push({
            id: peerId,
            name,
            color: nameColorClass(name),
            inVoice: members[peerId]?.inVoice === true,
            muted: members[peerId]?.muted === true,
            // G6: the channel name when the room has 2 or more voice channels.
            channel: window.voiceChannels?.label(members[peerId]?.channel ?? 'general') ?? '',
            // C5: no speaking mark for a person that is muted for me.
            speaking: speaking.has(peerId) && !listeningTo(peerId).muted,
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
    window.nodeMap.update({ self, host: hostId, nodes, links: topologyLinks, kinds: topologyKinds, transfers: active, screenEdges: topologyScreenEdges, musicEdges: topologyMusicEdges });
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
const mapUpnpBox = document.getElementById('map-upnp-box');
const mapUpnpButton = document.getElementById('map-upnp');
const mapUpnpNote = document.getElementById('map-upnp-note');
let mapUpnpBusy = false;
let mapUpnpError = '';
let mapUpnpTried = false;

// The reach state of the room from asscrack:invite (gap A1): { state, reason, proven }, or null before the first
// answer. roomOwner: this device owns the protected room.
let roomReach = null;
let roomOwner = false;

const NO_FULL_NODE_TEXT = 'No invite code: this room isn\'t reachable from the internet. Turn on UPnP or set a public address.';
const UPNP_WAIT_TEXT = 'Opening port…';

function hasApi(name) {
    return typeof window.asscrack?.[name] === 'function';
}

// Gap B4, U2 of the UI copy pass: the status bar item tells if friends on the internet can join, as a dot and a
// short label (internet rooms only). The tooltip has the reason. Only the state 'warn' (an owner with no address and
// no peer) has the red color.
const REACH_DOTS = { self: 'ok', peer: 'ok', untested: 'none', 'upnp-wait': 'busy', 'no-port': 'warn', warn: 'bad' };
function fullNodeView() {
    if (!internetRoom || roomReach?.state === 'lan') return { state: 'lan', text: '', tip: '' };
    const first = [...fullNodePeers].filter(id => peerItems.has(id)).sort()[0];
    if (fullNodeSelf) return { state: 'self', text: 'Reachable', tip: 'Others connect to this PC directly. It can relay.' };
    if (first) {
        const name = peerNames.get(first) ?? String(first).slice(0, 12);
        return { state: 'peer', text: `Via ${name}`, tip: `New members connect through ${name}` };
    }
    if (roomReach?.state === 'ready') return { state: 'untested', text: 'Not tested', tip: 'Checked when the first friend joins' };
    if (roomReach?.state === 'upnp-wait') return { state: 'upnp-wait', text: 'Opening port…', tip: '' };
    if (peerItems.size > 0) return { state: 'no-port', text: 'No open port', tip: 'New members from the internet can\'t join' };
    if (roomOwner) return { state: 'warn', text: 'Not reachable', tip: 'See Invite' };
    return { state: 'hidden', text: '', tip: '' };
}

const MAP_UPNP_REASONS = {
    'no-gateway': 'Router didn\'t respond.',
    'private-ip': 'Router has no public IP.',
    failed: 'Router refused to open a port.'
};

function showMapUpnp() {
    if (!mapUpnpBox || !mapUpnpButton) return;
    const hide = !internetRoom || roomReach?.state === 'lan' || fullNodeSelf || roomReach?.state === 'ready' || !hasApi('enableUpnp');
    mapUpnpBox.hidden = hide;
    if (hide) return;
    const waiting = mapUpnpBusy || roomReach?.state === 'upnp-wait';
    mapUpnpButton.disabled = waiting;
    mapUpnpButton.textContent = waiting ? UPNP_WAIT_TEXT : (mapUpnpTried && roomReach?.state === 'upnp-failed') ? 'Try UPnP again' : 'Open port (UPnP)';
    const note = waiting ? '' : (mapUpnpTried && roomReach?.state === 'upnp-failed')
        ? (MAP_UPNP_REASONS[roomReach.reason] ?? MAP_UPNP_REASONS.failed)
        : mapUpnpError;
    if (mapUpnpNote) {
        mapUpnpNote.textContent = note;
        mapUpnpNote.hidden = !note;
    }
}

function showFullNodeState() {
    const { state, text, tip } = fullNodeView();
    fullNodeState.dataset.state = state;
    fullNodeState.dataset.reach = REACH_DOTS[state] ?? '';
    fullNodeState.textContent = text;
    fullNodeState.title = tip;
    fullNodeState.hidden = state === 'lan' || state === 'hidden';
    showMapUpnp();
}

mapUpnpButton?.addEventListener('click', async () => {
    if (mapUpnpBusy || !hasApi('enableUpnp')) return;
    mapUpnpBusy = true;
    mapUpnpTried = true;
    mapUpnpError = '';
    showMapUpnp();
    try {
        const result = await window.asscrack.enableUpnp();
        if (result?.reach) roomReach = result.reach;
        if (result?.started === false) mapUpnpError = 'UPnP isn\'t available in this room.';
    } catch (error) {
        mapUpnpError = error?.message ? errorText(error) : 'Couldn\'t start UPnP.';
    } finally {
        mapUpnpBusy = false;
        showFullNodeState();
        refreshInvite();
    }
});

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
        roomReach = info?.reach && typeof info.reach.state === 'string' ? info.reach : null;
        roomOwner = info?.membership?.protected === true && info.membership.owner === true;
        showFullNodeState();
        if (info?.membership?.protected) {
            window.roomMembership?.update(info.membership, roomReach);
            return;
        }
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
        inviteNote.textContent = `Copy failed: ${errorText(err)}`;
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
// The name of a full node can come later, and a full node can leave. The peer count changes the text (gap B4).
window.asscrack.onPeerName(() => showFullNodeState());
window.asscrack.onPeerLeft(() => showFullNodeState());
window.asscrack.onPeerJoined(() => showFullNodeState());
// A membership change can change the reach of the owner (the relay role). Only the owner has a reach note.
window.asscrack.onMembership(() => { if (selfLine && roomOwner) refreshInvite(); });

// A proposed edit appears in the room header only when the host publishes it.
const topicValue = document.getElementById('topic-value');
const topicUnavailable = document.getElementById('topic-unavailable');
const topicEdit = document.getElementById('topic-edit');
const topicEditor = document.getElementById('topic-editor');
const topicInput = document.getElementById('topic-input');
let currentTopic = { available: false, text: '' };
let topicEvents = 0;

function editRoomTopic(edit) {
    topicEditor.hidden = !edit;
    topicEdit.setAttribute('aria-expanded', String(edit));
    if (edit) {
        topicInput.value = currentTopic.text;
        topicInput.focus();
    }
}

function showRoomTopic(value) {
    currentTopic = value?.available === true ? value : { available: false, text: '' };
    topicValue.textContent = currentTopic.available ? currentTopic.text : '';
    topicValue.title = topicValue.textContent;
    topicValue.hidden = !topicValue.textContent;
    if (topicUnavailable) topicUnavailable.hidden = currentTopic.available;
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
        status.textContent = 'Can\'t edit the topic right now.';
        return false;
    }
    try {
        await window.asscrack.setTopic(text);
        status.textContent = '';
        return true;
    } catch (err) {
        status.textContent = err?.message ? errorText(err) : 'Couldn\'t change the topic.';
        return false;
    }
}

topicEdit.addEventListener('click', () => editRoomTopic(topicEditor.hidden));
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
        status.textContent = `Status not set: ${errorText(err)}`;
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
    note.setAttribute('aria-label', 'Status note');
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
// 1.0.4: the automatic status (auto-status.mjs) changed the own state.
if (hasApi('onOwnPresence')) {
    window.asscrack.onOwnPresence(value => {
        const presence = readPresence(value);
        if (!presence) return;
        touchPresence('');
        ownPresence = presence;
        showOwnPresence();
    });
}
// addPeer (an earlier listener) makes the line first. Then the line gets the known state.
window.asscrack.onPeerJoined(data => showPeerPresence(data?.peerId));
window.asscrack.onPeerLeft(data => forgetPresence(data?.peerId));

// ---- The one Escape dispatcher ----
// Escape closes only the top layer, in this sequence: Fill window of the screen stage (screen-view.js), the context menu (menu.js), the View menu and the Buddies
// drawer (layout.js), a focused whisper pane, the find bar (find.js, it puts the list back at its old position), the quote chip (only with
// the focus in the composer), the voice settings, the invite panel, the map. The View menu and the drawer stop their own Escape when the focus is
// in them. A separator drag stops its Escape in the capture phase on window. Then this listener gets no event.
function focusIsIn(element) {
    const active = document.activeElement;
    return !active || active === document.body || element.contains(active);
}

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    // P8b: Fill window of the screen stage (screen-view.js) is a manual popover. Escape goes back.
    if (window.screenView?.unfill()) {
        e.preventDefault();
        return;
    }
    if (document.querySelector(':popover-open')) return;
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
        if (returnFocus) document.getElementById('view-toggle')?.focus({ preventScroll: true });
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
            ownDeafened = false;
            void window.voice.enterIdle();
            updateVoiceView();
        }
    }
    window.idlePeer = {
        isIdle: () => idle,
        enter: async () => {
            try { if (!await api.enterIdlePeer()) status.textContent = 'Tray unavailable.'; }
            catch { status.textContent = 'Couldn\'t minimize to tray.'; }
        },
        toggleClose: async () => {
            try { await api.setCloseToTray(!closeToTray); }
            catch { status.textContent = 'Couldn\'t save this setting.'; }
        }
    };
    api.onIdlePeer?.(state => { updates++; apply(state); });
    api.getIdlePeer?.().then(state => { if (!updates) apply(state); }).catch(() => {});
}

// Screen share forwarding preference (Settings -> System -> Forward screen shares).
{
    const api = window.asscrack;
    const setting = document.getElementById('view-screen-forwarding');
    const hubSetting = document.getElementById('view-screen-hub-forwarding');
    let state = { maxChildren: 2, effectiveMaxChildren: 2, hubForwarding: false, idle: false };
    let updates = 0;
    function apply(next) {
        if (!next || typeof next.maxChildren !== 'number') return;
        state = {
            maxChildren: next.maxChildren,
            effectiveMaxChildren: typeof next.effectiveMaxChildren === 'number' ? next.effectiveMaxChildren : next.maxChildren,
            hubForwarding: next.hubForwarding === true,
            idle: next.idle === true
        };
        if (setting) {
            setting.setAttribute('aria-checked', String(state.maxChildren > 0));
            setting.title = state.idle
                ? 'Paused while Idle Peer'
                : state.maxChildren > 0
                    ? `Relay watched screen shares (max ${state.maxChildren})`
                    : 'Opted out of forwarding';
        }
        if (hubSetting) {
            hubSetting.setAttribute('aria-checked', String(state.hubForwarding));
            hubSetting.title = state.idle
                ? 'Paused while Idle Peer'
                : state.hubForwarding
                    ? 'Full node relays shares when not watching'
                    : 'Allow this full node to relay screen shares without watching';
        }
    }
    window.screenForwarding = {
        state: () => ({ ...state }),
        toggle: async () => {
            try { apply(await api.setScreenForwarding?.(state.maxChildren === 0)); }
            catch { status.textContent = 'Couldn\'t save this setting.'; }
        },
        toggleHub: async () => {
            try { apply(await api.setScreenHubForwarding?.(!state.hubForwarding)); }
            catch { status.textContent = 'Couldn\'t save this setting.'; }
        },
        setCap: async maxChildren => {
            try { apply(await api.setScreenForwarding?.(maxChildren)); }
            catch { status.textContent = 'Couldn\'t save this setting.'; }
        }
    };
    api.onScreenForwarding?.(next => { updates++; apply(next); });
    api.getScreenForwarding?.().then(next => { if (!updates) apply(next); }).catch(() => {});
}

// Auto-UPnP preference (Settings -> System -> Open port automatically).
{
    const api = window.asscrack;
    const setting = document.getElementById('view-auto-upnp');
    let updates = 0;
    function apply(next, syncLogin = false) {
        if (!next || typeof next.enabled !== 'boolean') return;
        autoUpnpEnabled = next.enabled;
        if (setting) setting.setAttribute('aria-checked', String(autoUpnpEnabled));
        if (allowUpnp && (syncLogin || !allowUpnpTouched)) {
            allowUpnp.checked = autoUpnpEnabled;
            showUpnpChoice();
        }
    }
    window.autoUpnp = {
        state: () => ({ enabled: autoUpnpEnabled }),
        toggle: async () => {
            allowUpnpTouched = false;
            try { apply(await api.setAutoUpnp?.(!autoUpnpEnabled), true); }
            catch { status.textContent = 'Couldn\'t save this setting.'; }
        }
    };
    api.onAutoUpnp?.(next => { updates++; apply(next); });
    api.getAutoUpnp?.().then(next => { if (!updates) apply(next); }).catch(() => {});
}
