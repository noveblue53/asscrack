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

// G7a: the Friends panel, the friend request bar and the buddy menu lines. Each call sends only text and true or false.
const text = value => String(value ?? '');
contextBridge.exposeInMainWorld('friends', {
    list: () => ipcRenderer.invoke('asscrack:friends'),
    relations: peerIds => ipcRenderer.invoke('asscrack:friend-relations', Array.isArray(peerIds) ? peerIds.slice(0, 128).map(text) : []),
    request: peerId => ipcRenderer.invoke('asscrack:friend-request', text(peerId)),
    respond: (id, accept) => ipcRenderer.invoke('asscrack:friend-respond', text(id), accept === true),
    remove: friendId => ipcRenderer.invoke('asscrack:friend-remove', text(friendId)),
    block: friendId => ipcRenderer.invoke('asscrack:friend-block', text(friendId)),
    unblock: deviceId => ipcRenderer.invoke('asscrack:friend-unblock', text(deviceId)),
    rename: (friendId, name) => ipcRenderer.invoke('asscrack:friend-rename', text(friendId), text(name)),
    setName: name => ipcRenderer.invoke('asscrack:friend-name', text(name)),
    setUpnp: on => ipcRenderer.invoke('asscrack:friend-upnp', on === true),
    openChat: friendId => ipcRenderer.invoke('asscrack:friend-open-chat', text(friendId)),
    retry: () => ipcRenderer.invoke('asscrack:unlock-archive'),
    onChanged: listen('asscrack:friends'),
    onRequest: listen('asscrack:friend-request'),
    // G7b: a friend line for the attention rules (attention.js): { friendId, id, away, focused }. No text, no name.
    onAttention: listen('asscrack:friend-attention')
});

contextBridge.exposeInMainWorld('asscrack', {
    getIdlePeer: () => ipcRenderer.invoke('asscrack:idle-peer'),
    onIdlePeer: listen('asscrack:idle-peer'),
    enterIdlePeer: () => ipcRenderer.invoke('asscrack:enter-idle-peer'),
    setCloseToTray: enabled => ipcRenderer.invoke('asscrack:close-to-tray', enabled),
    // P9B: start at sign-in (installed build only). choice: { mode: 'off' | 'friends' | 'room', roomId }.
    getStartup: () => ipcRenderer.invoke('asscrack:startup'),
    setStartup: choice => ipcRenderer.invoke('asscrack:set-startup', {
        mode: String(choice?.mode ?? 'off'), roomId: choice?.roomId == null ? null : String(choice.roomId) }),
    // The start at sign-in asks the window to reopen this saved room (the normal reopen path).
    onStartRoom: listen('asscrack:start-room'),
    quit: () => ipcRenderer.send('asscrack:quit'),
    // G5: the Windows app shell. The window gets no path and no room ID.
    leaveRoom: () => ipcRenderer.invoke('asscrack:leave-room'),
    leaveRoomInfo: () => ipcRenderer.invoke('asscrack:leave-room-info'),
    getAbout: () => ipcRenderer.invoke('asscrack:about'),
    openDataFolder: () => ipcRenderer.invoke('asscrack:open-data-folder'),
    // P9C: the updates. The window gets the versions, the note text and the state. It gives no path and no URL.
    getUpdate: () => ipcRenderer.invoke('asscrack:update'),
    checkUpdate: () => ipcRenderer.invoke('asscrack:update-check'),
    setUpdateCheck: on => ipcRenderer.invoke('asscrack:update-auto', on === true),
    downloadUpdate: () => ipcRenderer.invoke('asscrack:update-download'),
    updateLater: () => ipcRenderer.invoke('asscrack:update-later'),
    // force true: restart also in voice or during a transfer (the window asked the user first).
    restartToUpdate: force => ipcRenderer.invoke('asscrack:update-restart', force === true),
    onUpdate: listen('asscrack:update'),
    flashAttention: () => ipcRenderer.send('asscrack:attention-flash'),
    // ids: up to 64 peer IDs. Returns [{ id, alias }] with the pseudonym of the Room activity lines.
    getActivityAliases: ids => ipcRenderer.invoke('asscrack:activity-aliases', Array.isArray(ids) ? ids.slice(0, 64).map(String) : []),
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
    // G6: the voice channels of the room: { owner, editable, seq, channels: [{ id, name }] }.
    getVoiceChannels: () => ipcRenderer.invoke('asscrack:voice-channels'),
    onVoiceChannels: listen('asscrack:voice-channels'),
    createVoiceChannel: name => ipcRenderer.invoke('asscrack:voice-channel-create', String(name)),
    renameVoiceChannel: (id, name) => ipcRenderer.invoke('asscrack:voice-channel-rename', String(id), String(name)),
    deleteVoiceChannel: id => ipcRenderer.invoke('asscrack:voice-channel-delete', String(id)),
    // G4: the saved listening choice (volume, "Mute for me") of a person in this room. The main process finds the
    // device ID of the peer: the window never gives a name or a device ID.
    getListening: peerId => ipcRenderer.invoke('asscrack:get-listening', String(peerId)),
    setListening: (peerId, muted, volume) => ipcRenderer.invoke('asscrack:set-listening', String(peerId), muted === true,
        Number(volume)),
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
    // Ready check (milestone 9).
    getReady: () => ipcRenderer.invoke('asscrack:ready-state'),
    openReady: text => ipcRenderer.invoke('asscrack:ready-open', String(text ?? '')),
    voteReady: (id, vote) => ipcRenderer.invoke('asscrack:ready-vote', String(id), String(vote)),
    closeReady: id => ipcRenderer.invoke('asscrack:ready-close', String(id)),
    onReady: listen('asscrack:ready'),
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
    // P7b: Pause, Resume and Discard of a received file. The window sends an offer ID or a partial key as text.
    pauseFile: offerId => ipcRenderer.invoke('asscrack:pause-file', String(offerId)),
    resumeFile: offerId => ipcRenderer.invoke('asscrack:resume-file', String(offerId)),
    discardPartial: key => ipcRenderer.invoke('asscrack:discard-partial', String(key)),
    listPartials: () => ipcRenderer.invoke('asscrack:list-partials'),
    onFilePaused: listen('asscrack:file-paused'),
    onFileResumed: listen('asscrack:file-resumed'),
    onFileRestarted: listen('asscrack:file-restarted'),
    onFileDiscarded: listen('asscrack:file-discarded'),
    onFileExpired: listen('asscrack:file-expired'),
    onFilePartials: listen('asscrack:file-partials'),
    // Manual status (milestone 3). presence: { state, note }.
    setPresence: ({ state, note } = {}) => ipcRenderer.invoke('asscrack:set-presence', { state, note }),
    getPresence: () => ipcRenderer.invoke('asscrack:presence'),
    onPresence: listen('asscrack:presence')
});
