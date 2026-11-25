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
    onMute: listen('asscrack:voice-monitor-mute'),
    // P8b (design W6): Stop sharing in the voice panel. The room window stops the share with its own handler.
    onStopShare: listen('asscrack:voice-monitor-stop-share')
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
    // easy-join: "Invite to room" (the friend ID only).
    invite: friendId => ipcRenderer.invoke('asscrack:friend-invite', text(friendId)),
    retry: () => ipcRenderer.invoke('asscrack:unlock-archive'),
    // 1.0.1: open the Friends window (friends-popout.mjs). Only in a room; true when it opens or gets the focus.
    popOut: () => ipcRenderer.invoke('asscrack:friends-popout'),
    // easy-join: the Join of a friend invite that waits for this window: { token, room, name } or null (one time).
    takeJoin: () => ipcRenderer.invoke('asscrack:friend-join-take'),
    onJoin: listen('asscrack:friend-join'),
    // easy-join part 3: Join of a friend row (the friend ID only). leave: the user agreed to leave the current room.
    knockJoin: (friendId, leave) => ipcRenderer.invoke('asscrack:friend-knock', text(friendId), leave === true),
    // The state of the friend Join: { state: 'waiting', room } (the owner sees the request).
    onKnockState: listen('asscrack:friend-knock-state'),
    onChanged: listen('asscrack:friends'),
    onRequest: listen('asscrack:friend-request'),
    // G7b: a friend line for the attention rules (attention.js): { friendId, id, away, focused }. No text, no name.
    onAttention: listen('asscrack:friend-attention')
});

// easy-join part 3: the prompt for a device invite in the clipboard (clipboard-join-ui.js). The window gets
// { id, room } only. The main process keeps the code.
contextBridge.exposeInMainWorld('clipboardJoin', {
    take: () => ipcRenderer.invoke('asscrack:clipboard-join-take'),
    join: (id, leave) => ipcRenderer.invoke('asscrack:clipboard-join', String(id ?? ''), leave === true),
    dismiss: id => ipcRenderer.invoke('asscrack:clipboard-join-dismiss', String(id ?? '')),
    onPrompt: listen('asscrack:clipboard-join')
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
    // What's new: the notes list and the card after an update (release-notes.mjs). No argument.
    getWhatsNew: () => ipcRenderer.invoke('asscrack:whats-new'),
    whatsNewDone: () => ipcRenderer.invoke('asscrack:whats-new-done'),
    // Diagnostics (1.0.1): requests, the answer of the user, the bundle, the marks. The window gets no path.
    diagAsk: peerId => ipcRenderer.invoke('asscrack:diag-ask', String(peerId ?? '')),
    diagAskAll: () => ipcRenderer.invoke('asscrack:diag-ask-all'),
    diagPreview: includeDumps => ipcRenderer.invoke('asscrack:diag-preview', includeDumps === true),
    diagAnswer: (id, send, includeDumps) => ipcRenderer.invoke('asscrack:diag-answer', String(id ?? ''), send === true, includeDumps === true),
    diagSave: includeDumps => ipcRenderer.invoke('asscrack:diag-save', includeDumps === true),
    diagOpenReceived: () => ipcRenderer.invoke('asscrack:diag-open-received'),
    diagMark: category => ipcRenderer.invoke('asscrack:diag-mark', String(category ?? '')),
    // The voice code: the device result and the voice summary each minute (main.js checks the type and each field).
    diagEvent: (type, fields) => ipcRenderer.send('asscrack:diag-event', String(type ?? ''), fields && typeof fields === 'object' ? { ...fields } : {}),
    onDiag: listen('asscrack:diag'),
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
    // easy-join: friendInvite is the token of a Join from a friend invite (the main process keeps the code).
    login: ({ name, room, type, invite, friendInvite, publicAddress, allowUpnp, allowLegacy, save, keepHistory } = {}) =>
        ipcRenderer.invoke('asscrack:login', { name, room, type, invite, friendInvite, publicAddress, allowUpnp, allowLegacy, save, keepHistory }),
    // Saved rooms (milestone 6). The window gets no key, no invite and no file path.
    listSavedRooms: () => ipcRenderer.invoke('asscrack:saved-rooms'),
    unlockArchive: () => ipcRenderer.invoke('asscrack:unlock-archive'),
    // opts: { before: { time, id } } for a page of older lines, or nothing for the newest lines.
    savedRoomLines: (roomId, opts) => {
        const b = opts?.before;
        const before = b ? { time: Number(b.time), id: String(b.id) } : null;
        return ipcRenderer.invoke('asscrack:saved-room-lines', String(roomId), { before, channelId: opts?.channelId });
    },
    // The presence lines of a saved room: range { from, to } (times, null: no limit).
    savedRoomNotes: (roomId, range) => ipcRenderer.invoke('asscrack:saved-room-notes', String(roomId),
        { from: range?.from ?? null, to: range?.to ?? null }),
    // note: { id, kind, text, time, replaces } of transcript-notes.js.
    saveNote: note => ipcRenderer.send('asscrack:save-note', {
        id: String(note?.id ?? ''), kind: String(note?.kind ?? ''), text: String(note?.text ?? ''),
        time: Number(note?.time), replaces: note?.replaces ? String(note.replaces) : null
    }),
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
    // easy-join part 2: "Copy room code" (renew false) and "New room code" (renew true): { code, expires }. The main
    // process copies the code.
    roomCode: renew => ipcRenderer.invoke('asscrack:room-code', renew === true),
    // The knock prompts of the owner: [{ id, name, mark }]. answerKnock: Allow (true) or Deny (false).
    getKnocks: () => ipcRenderer.invoke('asscrack:knocks'),
    answerKnock: (id, allow) => ipcRenderer.invoke('asscrack:knock-answer', String(id), allow === true),
    onKnocks: listen('asscrack:knocks'),
    // The state of the own knock during the login: { state: 'looking' | 'waiting' | 'allowed', room }.
    onKnockState: listen('asscrack:knock-state'),
    // easy-join part 3: "Always allow my friends" (owner only). Returns the value now.
    setAutoAllowFriends: on => ipcRenderer.invoke('asscrack:auto-allow-friends', on === true),
    // A friend got in with no prompt: { name, mark }.
    onKnockAuto: listen('asscrack:knock-auto'),
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
    // messageId: the ID of the line of the card (the main process finds the sender of an archived line with it).
    requestMediaPreview: (ref, messageId) => ipcRenderer.invoke('asscrack:media-preview', ref, String(messageId ?? '')),
    onMediaChanged: listen('asscrack:media-changed'),
    // 1.0.4: a sender can answer thumbnail requests again: { peer, device } (device: its proved device ID, or null).
    onMediaPeer: listen('asscrack:media-peer'),
    // The image menu (menu.js, chat-media.js). The main process checks each descriptor and each path.
    copyMediaImage: ref => ipcRenderer.invoke('asscrack:media-copy-image', ref),
    saveMediaImage: (messageId, ref) => ipcRenderer.invoke('asscrack:media-save-image', String(messageId ?? ''), ref),
    cancelMediaSave: id => ipcRenderer.invoke('asscrack:media-save-cancel', String(id ?? '')),
    openMediaOriginal: (messageId, ref) => ipcRenderer.invoke('asscrack:media-open-original', String(messageId ?? ''), ref),
    onMediaSaved: listen('asscrack:media-saved'),
    getAttentionSettings: () => ipcRenderer.invoke('asscrack:attention-settings'),
    // Message alerts: the mutes of the open room ({ room, channels }) and a change ({ scope, channelId, time, mentions }).
    getAttentionMutes: () => ipcRenderer.invoke('asscrack:attention-mutes'),
    setAttentionMute: request => ipcRenderer.invoke('asscrack:attention-mute', request),
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
    onVoiceState: listen('asscrack:voice-state'),
    // M4 (P10b): the voice roster of the host: { hostId, members: [{ peerId, channel }] }.
    onVoiceRoster: listen('asscrack:voice-roster'),
    onHostChanged: listen('asscrack:host-changed'),
    // Ready check (milestone 9).
    getReady: () => ipcRenderer.invoke('asscrack:ready-state'),
    openReady: text => ipcRenderer.invoke('asscrack:ready-open', String(text ?? '')),
    voteReady: (id, vote) => ipcRenderer.invoke('asscrack:ready-vote', String(id), String(vote)),
    closeReady: id => ipcRenderer.invoke('asscrack:ready-close', String(id)),
    onReady: listen('asscrack:ready'),
    // Room music (music.js, music-ui.js). The window gives a link text or an ID; the main process keeps each path.
    getMusic: () => ipcRenderer.invoke('asscrack:music-state'),
    onMusic: listen('asscrack:music'),
    onMusicNotice: listen('asscrack:music-notice'),
    musicAdd: text => ipcRenderer.invoke('asscrack:music-add', String(text ?? '')),
    musicAddFiles: () => ipcRenderer.invoke('asscrack:music-add-files'),
    musicFolder: () => ipcRenderer.invoke('asscrack:music-folder'),
    musicChooseFolder: () => ipcRenderer.invoke('asscrack:music-choose-folder'),
    musicAddFolderFile: id => ipcRenderer.invoke('asscrack:music-add-folder-file', String(id ?? '')),
    musicSkip: () => ipcRenderer.invoke('asscrack:music-skip'),
    musicPause: paused => ipcRenderer.invoke('asscrack:music-pause', paused === true),
    musicRemove: id => ipcRenderer.invoke('asscrack:music-remove', String(id ?? '')),
    musicMove: (id, to) => ipcRenderer.invoke('asscrack:music-move', String(id ?? ''), Number(to)),
    musicStop: () => ipcRenderer.invoke('asscrack:music-stop'),
    musicOpen: id => ipcRenderer.invoke('asscrack:music-open', String(id ?? '')),
    musicEnded: id => ipcRenderer.send('asscrack:music-ended', String(id ?? '')),
    musicFailed: (id, kind) => ipcRenderer.send('asscrack:music-failed', String(id ?? ''), String(kind ?? '')),
    musicProgress: (id, pos) => ipcRenderer.send('asscrack:music-progress', String(id ?? ''), Number(pos)),
    // Uint8Array of one Opus frame of the music stream (the DJ). A plain send: 50 frames each second.
    sendMusicFrame: bytes => ipcRenderer.send('asscrack:music-frame', bytes),
    onMusicFrame: listen('asscrack:music-frame'),
    getMusicSettings: () => ipcRenderer.invoke('asscrack:music-settings'),
    setMusicSettings: patch => ipcRenderer.invoke('asscrack:set-music-settings', patch),
    // A change of the pop-out window or of the main process.
    onMusicSettings: listen('asscrack:music-settings-changed'),
    // The player in its own window (music-popout.mjs): open or close it; { open } after each change.
    musicPopout: open => ipcRenderer.invoke('asscrack:music-popout', open === true),
    onMusicPopout: listen('asscrack:music-popout-state'),
    // The visualizer (music-viz.js): the pop-out window asks for one frame; the answer is 18 bytes or null.
    onMusicVizPull: listen('asscrack:music-viz-pull'),
    sendMusicViz: bytes => ipcRenderer.send('asscrack:music-viz', bytes instanceof Uint8Array && bytes.length === 18 ? bytes : null),
    // false while the room window is minimized or hidden (to the tray).
    onMusicRoomShown: listen('asscrack:music-room-shown'),
    getTopic: () => ipcRenderer.invoke('asscrack:topic'),
    setTopic: text => ipcRenderer.invoke('asscrack:set-topic', text),
    onTopic: listen('asscrack:topic'),
    onPeerName: listen('asscrack:peer-name'),
    onTopology: listen('asscrack:topology'),
    getTopology: () => ipcRenderer.invoke('asscrack:topology'),
    getMapTraffic: () => ipcRenderer.invoke('asscrack:map-traffic'),
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
        if (file.type !== 'image/png' || file.size < 33) throw new Error('Can\'t paste this image.');
        if (file.size > 16 * 1024 * 1024) throw new Error('Image too large (16 MB max).');
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
    // P8b, screenshare (design section 4, IPC). The window sends only IDs, a quality name, numbers and frame bytes.
    // A tier ID is a number (screen-rate.mjs).
    getScreenSources: () => ipcRenderer.invoke('asscrack:screen-sources'),
    pickScreenSource: (id, quality, options) => ipcRenderer.invoke('asscrack:screen-pick', String(id ?? ''), String(quality ?? ''),
        { border: options?.border === true, ...(options?.audio === true ? { audio: true } : {}) }),
    getScreenQuality: () => ipcRenderer.invoke('asscrack:screen-last-quality'),
    getScreenAudio: () => ipcRenderer.invoke('asscrack:screen-last-audio'),
    startScreenShare: ({ preset, width, height, audio } = {}) => ipcRenderer.invoke('asscrack:screen-start',
        { preset: String(preset ?? 'auto'), width: Number(width), height: Number(height), ...(audio === true ? { audio: true } : {}) }),
    stopScreenShare: reason => ipcRenderer.send('asscrack:screen-stop', String(reason ?? 'stopped')),
    sendScreenFrame: ({ tier, key, timestampMs, data } = {}) => ipcRenderer.send('asscrack:screen-frame',
        { tier: Number(tier), key: key === true, timestampMs: Number(timestampMs), data }),
    sendScreenAudioFrame: data => ipcRenderer.send('asscrack:screen-audio-frame', data),
    reportScreenEncoder: report => ipcRenderer.send('asscrack:screen-report', report),
    setScreenSize: ({ tier, width, height } = {}) => ipcRenderer.send('asscrack:screen-size',
        { tier: Number(tier), width: Number(width), height: Number(height) }),
    watchScreen: peerId => ipcRenderer.invoke('asscrack:screen-watch', String(peerId ?? '')),
    unwatchScreen: () => ipcRenderer.send('asscrack:screen-unwatch'),
    watchScreenAudio: peerId => ipcRenderer.invoke('asscrack:screen-audio-watch', String(peerId ?? '')),
    unwatchScreenAudio: () => ipcRenderer.send('asscrack:screen-audio-unwatch'),
    getScreenListening: peerId => ipcRenderer.invoke('asscrack:get-screen-listening', String(peerId ?? '')),
    setScreenListening: (peerId, muted, volume) => ipcRenderer.invoke('asscrack:set-screen-listening', String(peerId ?? ''),
        muted === true, Number(volume)),
    requestScreenKey: () => ipcRenderer.send('asscrack:screen-keyreq'),
    getScreenState: () => ipcRenderer.invoke('asscrack:screen-state'),
    onScreenState: listen('asscrack:screen-state'),
    getScreenForwarding: () => ipcRenderer.invoke('asscrack:screen-forwarding'),
    setScreenForwarding: value => ipcRenderer.invoke('asscrack:set-screen-forwarding', typeof value === 'boolean' ? value : Number(value)),
    setScreenHubForwarding: value => ipcRenderer.invoke('asscrack:set-screen-hub-forwarding', Boolean(value)),
    onScreenForwarding: listen('asscrack:screen-forwarding'),
    // 1.0.4: { active, paused, reason } of the guard of a window share that uses the screen.
    onScreenGuard: listen('asscrack:screen-guard'),
    onScreenViewers: listen('asscrack:screen-viewers'),
    onScreenEncoder: listen('asscrack:screen-encoder'),
    onScreenConfig: listen('asscrack:screen-config'),
    onScreenFrame: listen('asscrack:screen-frame'),
    onScreenEnded: listen('asscrack:screen-ended'),
    onScreenAudioPcm: listen('asscrack:screen-audio-pcm'),
    onScreenAudioFrame: listen('asscrack:screen-audio-frame'),
    onScreenAudioEnded: listen('asscrack:screen-audio-ended'),
    // Manual status (milestone 3). presence: { state, note }.
    setPresence: ({ state, note } = {}) => ipcRenderer.invoke('asscrack:set-presence', { state, note }),
    getPresence: () => ipcRenderer.invoke('asscrack:presence'),
    onPresence: listen('asscrack:presence'),
    // 1.0.4: the automatic status. The own state after an automatic change, and the settings.
    onOwnPresence: listen('asscrack:own-presence'),
    getAutoStatus: () => ipcRenderer.invoke('asscrack:auto-status'),
    setAutoStatus: patch => ipcRenderer.invoke('asscrack:set-auto-status', {
        awayMinutes: patch?.awayMinutes, dndFullscreen: patch?.dndFullscreen }),
    // 1.0.6: profile pictures (avatars.mjs). The window gets hashes, a pick token and the preview size; the crop is
    // four numbers.
    getAvatars: () => ipcRenderer.invoke('asscrack:avatars'),
    onAvatars: listen('asscrack:avatars'),
    pickAvatar: () => ipcRenderer.invoke('asscrack:avatar-pick'),
    setAvatar: (token, crop) => ipcRenderer.invoke('asscrack:avatar-set', String(token ?? ''),
        { x: Number(crop?.x), y: Number(crop?.y), w: Number(crop?.w), h: Number(crop?.h) }),
    removeAvatar: () => ipcRenderer.invoke('asscrack:avatar-remove')
});
