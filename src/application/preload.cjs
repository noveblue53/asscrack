const { contextBridge, ipcRenderer, webUtils } = require('electron');

function listen(channel) {
    return callback => {
        ipcRenderer.on(channel, (_event, data) => callback(data));
    };
}

contextBridge.exposeInMainWorld('asscrack', {
    login: ({ name, room, invite, internet, publicAddress } = {}) =>
        ipcRenderer.invoke('asscrack:login', { name, room, invite, internet, publicAddress }),
    getInvite: () => ipcRenderer.invoke('asscrack:invite'),
    getFullNode: () => ipcRenderer.invoke('asscrack:full-node'),
    onFullNode: listen('asscrack:full-node'),
    onFullNodeAddrs: listen('asscrack:full-node-addrs'),
    send: text => ipcRenderer.invoke('asscrack:send', text),
    onPeerDiscovered: listen('asscrack:peer-discovered'),
    onPeerJoined: listen('asscrack:peer-joined'),
    onPeerLeft: listen('asscrack:peer-left'),
    onMessage: listen('asscrack:message'),
    onHistory: listen('asscrack:history'),
    signal: (peerId, data) => ipcRenderer.invoke('asscrack:signal', { peerId, data }),
    setVoice: state => ipcRenderer.invoke('asscrack:set-voice', state),
    // Uint8Array of one Opus frame. A plain send: 50 frames each second.
    sendVoiceFrame: bytes => ipcRenderer.send('asscrack:voice-frame', bytes),
    onVoiceFrame: listen('asscrack:voice-frame'),
    getHost: () => ipcRenderer.invoke('asscrack:host'),
    onSignal: listen('asscrack:signal'),
    onVoiceState: listen('asscrack:voice-state'),
    onHostChanged: listen('asscrack:host-changed'),
    onPeerName: listen('asscrack:peer-name'),
    onTopology: listen('asscrack:topology'),
    getTopology: () => ipcRenderer.invoke('asscrack:topology'),
    offerFile: async file => {
        const filePath = webUtils.getPathForFile(file);
        if (!filePath) throw new Error('The file has no path');
        return ipcRenderer.invoke('asscrack:offer-file', filePath);
    },
    acceptFile: offerId => ipcRenderer.invoke('asscrack:accept-file', offerId),
    refuseFile: offerId => ipcRenderer.invoke('asscrack:refuse-file', offerId),
    cancelFile: (offerId, peerId) => ipcRenderer.invoke('asscrack:cancel-file', offerId, peerId),
    onFileOffer: listen('asscrack:file-offer'),
    onFileProgress: listen('asscrack:file-progress'),
    onFileDone: listen('asscrack:file-done'),
    onFileFailed: listen('asscrack:file-failed'),
    onFileRefused: listen('asscrack:file-refused'),
    onFileCancelled: listen('asscrack:file-cancelled')
});
