// G7a: the bridge of a friend chat window (friend-chat.html). The main process binds the window to one friend: no
// call sends a friend ID, a key, an address or a path. asscrack.openLink is for chat-links.js (the same link policy).
const { contextBridge, ipcRenderer } = require('electron');

function listen(channel) {
    return callback => {
        ipcRenderer.on(channel, (_event, data) => callback(data));
    };
}

contextBridge.exposeInMainWorld('friendChat', {
    state: () => ipcRenderer.invoke('asscrack:friend-chat-state'),
    lines: before => ipcRenderer.invoke('asscrack:friend-chat-lines',
        before ? { time: Number(before.time), id: String(before.id ?? '') } : null),
    send: text => ipcRenderer.invoke('asscrack:friend-chat-send', String(text ?? '')),
    // G7b: Delete of a waiting line (the line ID only).
    deleteWaiting: id => ipcRenderer.invoke('asscrack:friend-chat-delete', String(id ?? '')),
    onLine: listen('asscrack:friend-chat-line'),
    onReceipt: listen('asscrack:friend-chat-receipt'),
    onState: listen('asscrack:friend-chat-state')
});

contextBridge.exposeInMainWorld('asscrack', {
    openLink: href => ipcRenderer.invoke('asscrack:friend-chat-open-link', String(href ?? ''))
});
