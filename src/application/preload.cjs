const { contextBridge, ipcRenderer, webUtils } = require('electron');

function listen(channel) {
    return callback => {
        ipcRenderer.on(channel, (_event, data) => callback(data));
    };
}

contextBridge.exposeInMainWorld('desktopFrame', {
    state: () => ipcRenderer.invoke('asscrack:frame-state'),
    minimize: () => ipcRenderer.invoke('asscrack:frame-action', 'minimize'),
    toggleMaximize: () => ipcRenderer.invoke('asscrack:frame-action', 'maximize'),
    close: () => ipcRenderer.invoke('asscrack:frame-action', 'close'),
    useSystemButtons: enabled => ipcRenderer.invoke('asscrack:frame-system', enabled),
    setColors: (color, ink) => ipcRenderer.invoke('asscrack:frame-colors', color, ink),
    onChanged: listen('asscrack:frame-changed')
});

contextBridge.exposeInMainWorld('roomVoiceMonitor', {
    open: () => ipcRenderer.send('asscrack:voice-monitor-open'),
    publish: view => ipcRenderer.send('asscrack:voice-monitor-publish', view),
    onActive: listen('asscrack:voice-monitor-active'),
    onMute: listen('asscrack:voice-monitor-mute')
});

contextBridge.exposeInMainWorld('asscrack', {
    getIdlePeer: () => ipcRenderer.invoke('asscrack:idle-peer'),
    onIdlePeer: listen('asscrack:idle-peer'),
    enterIdlePeer: () => ipcRenderer.invoke('asscrack:enter-idle-peer'),
    setCloseToTray: enabled => ipcRenderer.invoke('asscrack:close-to-tray', enabled),
    quit: () => ipcRenderer.send('asscrack:quit'),
    login: ({ name, room, type, invite, publicAddress, allowUpnp, allowLegacy, save, keepHistory } = {}) =>
        ipcRenderer.invoke('asscrack:login', { name, room, type, invite, publicAddress, allowUpnp, allowLegacy, save, keepHistory }),
    // Saved rooms (milestone 6). The window gets no key, no invite and no file path.
    listSavedRooms: () => ipcRenderer.invoke('asscrack:saved-rooms'),
    unlockArchive: () => ipcRenderer.invoke('asscrack:unlock-archive'),
    // opts: { before: { time, id } } for a page of older lines, or nothing for the newest lines.
    savedRoomLines: (roomId, opts) => {
        const b = opts?.before;
        const before = b ? { time: Number(b.time), id: String(b.id) } : null;
        return ipcRenderer.invoke('asscrack:saved-room-lines', String(roomId), { before, channelId: opts?.channelId });
    },
    setKeepHistory: (roomId, on) => ipcRenderer.invoke('asscrack:set-keep-history', String(roomId), on === true),
    setSavedRoomName: (roomId, name) => ipcRenderer.invoke('asscrack:saved-room-name', String(roomId), String(name)),
    clearHistory: roomId => ipcRenderer.invoke('asscrack:clear-history', String(roomId)),
    forgetRoom: roomId => ipcRenderer.invoke('asscrack:forget-room', String(roomId)),
    onLineSaved: listen('asscrack:line-saved'),
    onSaveFailed: listen('asscrack:save-failed'),
    reopenRoom: (roomId, allowLegacy) => ipcRenderer.invoke('asscrack:reopen-room', String(roomId), allowLegacy === true),
    getInvite: () => ipcRenderer.invoke('asscrack:invite'),
    enableUpnp: () => ipcRenderer.invoke('asscrack:enable-upnp'),
    getDeviceId: () => ipcRenderer.invoke('asscrack:device-id'),
    createMemberInvite: (deviceId, canHost) => ipcRenderer.invoke('asscrack:member-invite', deviceId, canHost === true),
    revokeMember: deviceId => ipcRenderer.invoke('asscrack:member-revoke', deviceId),
    onMembership: listen('asscrack:membership'),
    getFullNode: () => ipcRenderer.invoke('asscrack:full-node'),
    onFullNode: listen('asscrack:full-node'),
    onFullNodeAddrs: listen('asscrack:full-node-addrs'),
    onUpnp: listen('asscrack:upnp'),
    copyText: text => ipcRenderer.invoke('asscrack:copy-text', text),
    // Gap D2: open a chat link in the system browser. The main process checks the URL (link-policy.mjs).
    openLink: href => ipcRenderer.invoke('asscrack:open-link', String(href)),
    // Gap N7: true when the file has a local path that offerFile can send. The window never gets the path.
    canSendFile: file => {
        try {
            return Boolean(webUtils.getPathForFile(file));
        } catch {
            return false;
        }
    },
    getRoomActivity: (peerId, transfersOnly) => ipcRenderer.invoke('asscrack:room-activity', peerId, transfersOnly === true),
    getWhisperPeers: () => ipcRenderer.invoke('asscrack:whisper-peers'),
    sendWhisper: (peerId, text, id) => ipcRenderer.invoke('asscrack:whisper-send', peerId, text, id),
    onWhisper: listen('asscrack:whisper'),
    onWhisperCapability: listen('asscrack:whisper-capability'),
    getChannels: () => ipcRenderer.invoke('asscrack:channels'),
    onChannels: listen('asscrack:channels'),
    createChannel: name => ipcRenderer.invoke('asscrack:create-channel', name),
    send: (text, channelId) => ipcRenderer.invoke('asscrack:send', text, channelId),
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
    savedOriginalAvailable: (messageId, descriptorId) => ipcRenderer.invoke('asscrack:saved-original-available', messageId, descriptorId),
    revealSavedOriginal: (messageId, descriptorId) => ipcRenderer.invoke('asscrack:reveal-saved-original', messageId, descriptorId),
    clearMediaPreviews: () => ipcRenderer.invoke('asscrack:media-clear-previews'),
    getMediaInfo: ref => ipcRenderer.invoke('asscrack:media-info', ref),
    requestMediaPreview: ref => ipcRenderer.invoke('asscrack:media-preview', ref),
    onMediaChanged: listen('asscrack:media-changed'),
    getAttentionSettings: () => ipcRenderer.invoke('asscrack:attention-settings'),
    setAttentionSettings: patch => ipcRenderer.invoke('asscrack:attention-set', patch),
    addAttention: data => ipcRenderer.send('asscrack:attention-add', data),
    readAttention: data => ipcRenderer.send('asscrack:attention-read', data),
    onAttentionOpen: listen('asscrack:attention-open'),
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
    refreshShelf: () => ipcRenderer.invoke('asscrack:refresh-shelf'),
    shareFile: file => {
        const filePath = webUtils.getPathForFile(file);
        if (!filePath) throw new Error('Choose a local file to share');
        return ipcRenderer.invoke('asscrack:share-file', filePath);
    },
    removeSharedFile: id => ipcRenderer.invoke('asscrack:remove-shared-file', id),
    downloadSharedFile: (peerId, id) => ipcRenderer.invoke('asscrack:download-shared-file', peerId, id),
    onShelf: listen('asscrack:shelf'),
    onShelfOffered: listen('asscrack:shelf-offered'),
    postMedia: async (file, caption, channelId, recipientId) => {
        const filePath = webUtils.getPathForFile(file);
        if (filePath) return ipcRenderer.invoke('asscrack:post-media', filePath, caption, channelId, recipientId);
        if (file.type !== 'image/png' || file.size < 33 || file.size > 16 * 1024 * 1024) throw new Error('Clipboard images must be PNGs of at most 16 MiB');
        return ipcRenderer.invoke('asscrack:post-media', new Uint8Array(await file.arrayBuffer()), caption, channelId, recipientId);
    },
    attachmentAvailable: id => ipcRenderer.invoke('asscrack:attachment-available', id),
    requestOriginal: id => ipcRenderer.invoke('asscrack:request-original', id),
    onAttachmentStatus: listen('asscrack:attachment-status'),
    acceptFile: offerId => ipcRenderer.invoke('asscrack:accept-file', offerId),
    retryFile: offerId => ipcRenderer.invoke('asscrack:retry-file', offerId),
    refuseFile: offerId => ipcRenderer.invoke('asscrack:refuse-file', offerId),
    cancelFile: (offerId, peerId) => ipcRenderer.invoke('asscrack:cancel-file', offerId, peerId),
    // Show a received file in Explorer. key: `${offerId}|${peerId}`. The main process keeps the path.
    revealFile: key => ipcRenderer.invoke('asscrack:reveal-file', String(key)),
    onFileOffer: listen('asscrack:file-offer'),
    onFileRetried: listen('asscrack:file-retried'),
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
