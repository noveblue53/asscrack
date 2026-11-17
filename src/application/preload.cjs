const { contextBridge, ipcRenderer } = require('electron');

function listen(channel) {
    return callback => {
        ipcRenderer.on(channel, (_event, data) => callback(data));
    };
}

contextBridge.exposeInMainWorld('asscrack', {
    login: ({ name, room }) => ipcRenderer.invoke('asscrack:login', { name, room }),
    send: text => ipcRenderer.invoke('asscrack:send', text),
    onPeerDiscovered: listen('asscrack:peer-discovered'),
    onPeerJoined: listen('asscrack:peer-joined'),
    onPeerLeft: listen('asscrack:peer-left'),
    onMessage: listen('asscrack:message'),
    signal: (peerId, data) => ipcRenderer.invoke('asscrack:signal', { peerId, data }),
    setVoice: state => ipcRenderer.invoke('asscrack:set-voice', state),
    getHost: () => ipcRenderer.invoke('asscrack:host'),
    onSignal: listen('asscrack:signal'),
    onVoiceState: listen('asscrack:voice-state'),
    onHostChanged: listen('asscrack:host-changed')
});
