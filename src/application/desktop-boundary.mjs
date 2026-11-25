export function isDesktopFrame(window, sender, frame, page) {
    return Boolean(window && sender && frame && typeof page === 'string' && !window.isDestroyed() && sender === window.webContents &&
        !sender.isDestroyed() && frame === sender.mainFrame && frame.url === page);
}

export function lockDesktopNavigation(webContents) {
    const deny = event => event.preventDefault();
    webContents.on('will-frame-navigate', deny);
    webContents.on('will-redirect', deny);
    webContents.on('will-attach-webview', deny);
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// screenPending(): a screen source selection of the picker is pending (P8, design section 2.1, item 5). With no
// such function, display-capture is always refused. screenPendingAudio(): the pending selection uses Chromium
// loopback audio (when per-process WASAPI loopback is unavailable).
export function installRoomPermissions(electronSession, roomWindow, page, isIdle, screenPending = () => false,
    screenPendingAudio = () => false) {
    function trusted(webContents, permission, details, wanted = 'media') {
        return !isIdle() && permission === wanted && details?.isMainFrame === true &&
            details.requestingUrl === page && isDesktopFrame(roomWindow(), webContents, webContents?.mainFrame, page);
    }
    electronSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        const types = details?.mediaTypes;
        // P8: display-capture only for the room window, not in Idle Peer, with a pending selection, and video
        // (plus audio only when a loopback-audio share is pending).
        if (permission === 'display-capture') {
            const videoOnly = Array.isArray(types) && types.length === 1 && types[0] === 'video';
            const videoAndAudio = screenPendingAudio() === true && Array.isArray(types) && types.length === 2 &&
                types.includes('video') && types.includes('audio');
            callback(Boolean(trusted(contents, permission, details, 'display-capture') && screenPending() === true &&
                (videoOnly || videoAndAudio)));
            return;
        }
        callback(Boolean(trusted(contents, permission, details) && Array.isArray(types) && types.length && types.every(type => type === 'audio')));
    });
    electronSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
        trusted(contents, permission, details) && details.mediaType === 'audio');
}
