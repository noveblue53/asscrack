const status = document.getElementById('status');
const button = document.getElementById('login');

window.asscrack.onPeerDiscovered(data => console.log('peer-discovered', data));
window.asscrack.onPeerJoined(data => console.log('peer-joined', data));
window.asscrack.onPeerLeft(data => console.log('peer-left', data));
window.asscrack.onMessage(data => console.log('message', data));

button.addEventListener('click', async () => {
    const name = document.getElementById('username').value.trim();
    const room = document.getElementById('ServerID').value.trim();
    if (!name || !room) {
        status.textContent = 'Error: enter a username and a Server ID.';
        return;
    }
    try {
        const { peerId } = await window.asscrack.login({ name, room });
        status.textContent = `Logged in. Peer ID: ${peerId}`;
    } catch (err) {
        status.textContent = `Error: ${err?.message ?? err}`;
    }
});
