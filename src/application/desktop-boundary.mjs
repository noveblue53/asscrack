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

export function installRoomPermissions(electronSession, roomWindow, page, isIdle) {
    function trusted(webContents, permission, details) {
        return !isIdle() && permission === 'media' && details?.isMainFrame === true &&
            details.requestingUrl === page && isDesktopFrame(roomWindow(), webContents, webContents?.mainFrame, page);
    }
    electronSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        const types = details?.mediaTypes;
        callback(Boolean(trusted(contents, permission, details) && Array.isArray(types) && types.length && types.every(type => type === 'audio')));
    });
    electronSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
        trusted(contents, permission, details) && details.mediaType === 'audio');
}
