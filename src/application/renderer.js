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

let ownName = '';
const peerItems = new Map(); // peerId -> <li>

function formatTime(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// All peer text goes in with textContent. Never innerHTML.
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

function addPeer(peerId) {
    if (peerItems.has(peerId)) return;
    const item = document.createElement('li');
    item.textContent = String(peerId).slice(0, 12);
    item.title = String(peerId);
    peerItems.set(peerId, item);
    peerList.appendChild(item);
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
    if (item && data.from) item.textContent = String(data.from);
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
