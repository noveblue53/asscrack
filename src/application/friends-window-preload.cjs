// 1.0.1: the bridge of the Friends window (friends-window.html, friends-popout.mjs). friends-ui.js uses the same
// names as the bridge of the room window (preload.cjs). This window can show the list, open a friend chat, change
// the name for friends, ask for UPnP and unblock a person. Each call sends only text and true or false.
const { contextBridge, ipcRenderer } = require('electron');

const text = value => String(value ?? '');

contextBridge.exposeInMainWorld('friends', {
    list: () => ipcRenderer.invoke('asscrack:friends-window-list'),
    openChat: friendId => ipcRenderer.invoke('asscrack:friends-window-open-chat', text(friendId)),
    setName: name => ipcRenderer.invoke('asscrack:friends-window-name', text(name)),
    setUpnp: on => ipcRenderer.invoke('asscrack:friends-window-upnp', on === true),
    unblock: deviceId => ipcRenderer.invoke('asscrack:friends-window-unblock', text(deviceId)),
    onChanged: callback => {
        ipcRenderer.on('asscrack:friends-window-changed', (_event, data) => callback(data));
    }
});
