const { contextBridge, ipcRenderer, webUtils } = require('electron');

function listen(channel) {
    return callback => {
        ipcRenderer.on(channel, (_event, data) => callback(data));
    };
}

contextBridge.exposeInMainWorld('asscrack', {
    login: ({ name, room, invite, internet, publicAddress, save, keepHistory } = {}) =>
        ipcRenderer.invoke('asscrack:login', { name, room, invite, internet, publicAddress, save, keepHistory }),
    // Saved rooms (milestone 6). The window gets no key, no invite and no file path.
    listSavedRooms: () => ipcRenderer.invoke('asscrack:saved-rooms'),
    unlockArchive: () => ipcRenderer.invoke('asscrack:unlock-archive'),
    // opts: { before: { time, id } } for a page of older lines, or nothing for the newest lines.
    savedRoomLines: (roomId, opts) => {
        const b = opts?.before;
        const before = b ? { time: Number(b.time), id: String(b.id) } : null;
        return ipcRenderer.invoke('asscrack:saved-room-lines', String(roomId), { before });
    },
    setKeepHistory: (roomId, on) => ipcRenderer.invoke('asscrack:set-keep-history', String(roomId), on === true),
    clearHistory: roomId => ipcRenderer.invoke('asscrack:clear-history', String(roomId)),
    forgetRoom: roomId => ipcRenderer.invoke('asscrack:forget-room', String(roomId)),
    onLineSaved: listen('asscrack:line-saved'),
    onSaveFailed: listen('asscrack:save-failed'),
    reopenRoom: roomId => ipcRenderer.invoke('asscrack:reopen-room', String(roomId)),
    getInvite: () => ipcRenderer.invoke('asscrack:invite'),
    getFullNode: () => ipcRenderer.invoke('asscrack:full-node'),
    onFullNode: listen('asscrack:full-node'),
    onFullNodeAddrs: listen('asscrack:full-node-addrs'),
    onUpnp: listen('asscrack:upnp'),
    copyText: text => ipcRenderer.invoke('asscrack:copy-text', text),
    getRoomActivity: () => ipcRenderer.invoke('asscrack:room-activity'),
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
    typingEdit: active => ipcRenderer.send('asscrack:typing-edit', active === true),
    onTyping: listen('asscrack:typing'),
    getShareTyping: () => ipcRenderer.invoke('asscrack:get-share-typing'),
    setShareTyping: value => ipcRenderer.invoke('asscrack:set-share-typing', value === true),
    getHost: () => ipcRenderer.invoke('asscrack:host'),
    getVoiceSettings: () => ipcRenderer.invoke('asscrack:voice-settings'),
    // A partial settings object. Returns the full settings after the check of the main process.
    setVoiceSettings: patch => ipcRenderer.invoke('asscrack:set-voice-settings', patch),
    // { workletUrl, wasm: Uint8Array } of RNNoise. simd: the window supports WebAssembly SIMD.
    getRnnoise: simd => ipcRenderer.invoke('asscrack:rnnoise', simd === true),
    // Push to talk from the key hook of the main process: { down }, and its state: { status }.
    onPushToTalk: listen('asscrack:ptt'),
    onPushToTalkStatus: listen('asscrack:ptt-status'),
    getPushToTalkStatus: () => ipcRenderer.invoke('asscrack:ptt-status'),
    onSignal: listen('asscrack:signal'),
    onVoiceState: listen('asscrack:voice-state'),
    onHostChanged: listen('asscrack:host-changed'),
    getTopic: () => ipcRenderer.invoke('asscrack:topic'),
    setTopic: text => ipcRenderer.invoke('asscrack:set-topic', text),
    onTopic: listen('asscrack:topic'),
    onPeerName: listen('asscrack:peer-name'),
    onTopology: listen('asscrack:topology'),
    getTopology: () => ipcRenderer.invoke('asscrack:topology'),
    offerFile: async (file, recipientId) => {
        const filePath = webUtils.getPathForFile(file);
        if (!filePath) throw new Error('The file has no path');
        return ipcRenderer.invoke('asscrack:offer-file', filePath, recipientId);
    },
    acceptFile: offerId => ipcRenderer.invoke('asscrack:accept-file', offerId),
    refuseFile: offerId => ipcRenderer.invoke('asscrack:refuse-file', offerId),
    cancelFile: (offerId, peerId) => ipcRenderer.invoke('asscrack:cancel-file', offerId, peerId),
    // Show a received file in Explorer. key: `${offerId}|${peerId}`. The main process keeps the path.
    revealFile: key => ipcRenderer.invoke('asscrack:reveal-file', String(key)),
    onFileOffer: listen('asscrack:file-offer'),
    onFileProgress: listen('asscrack:file-progress'),
    onFileDone: listen('asscrack:file-done'),
    onFileFailed: listen('asscrack:file-failed'),
    onFileRefused: listen('asscrack:file-refused'),
    onFileCancelled: listen('asscrack:file-cancelled'),
    // Manual status (milestone 3). presence: { state, note }.
    setPresence: ({ state, note } = {}) => ipcRenderer.invoke('asscrack:set-presence', { state, note }),
    getPresence: () => ipcRenderer.invoke('asscrack:presence'),
    onPresence: listen('asscrack:presence')
});
