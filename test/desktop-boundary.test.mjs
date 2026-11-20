import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installRoomPermissions, isDesktopFrame, lockDesktopNavigation } from '../src/application/desktop-boundary.mjs';

test('desktop privilege requires the exact packaged document and top-level frame', () => {
    const page = 'file:///Asscrack%20Pilot/src/application/index.html';
    const frame = { url: page };
    const webContents = { mainFrame: frame, isDestroyed: () => false };
    const room = { webContents, isDestroyed: () => false };
    assert.equal(isDesktopFrame(room, webContents, frame, page), true);
    assert.equal(isDesktopFrame(room, { ...webContents }, frame, page), false);
    assert.equal(isDesktopFrame(room, webContents, { ...frame }, page), false);
    frame.url = 'file:///Other/src/application/index.html';
    assert.equal(isDesktopFrame(room, webContents, frame, page), false);
});

test('both permission paths grant only audio to the active room document', () => {
    const page = 'file:///Asscrack/src/application/index.html';
    const webContents = { mainFrame: { url: page }, isDestroyed: () => false };
    let idle = false, check, request;
    installRoomPermissions({
        setPermissionCheckHandler: handler => { check = handler; },
        setPermissionRequestHandler: handler => { request = handler; }
    }, () => ({ webContents, isDestroyed: () => false }), page, () => idle);
    const context = { isMainFrame: true, requestingUrl: page };
    const checkMedia = (mediaType, overrides = {}) => check(webContents, 'media', 'file://', { ...context, mediaType, ...overrides });
    assert.equal(checkMedia('audio'), true);
    assert.equal(checkMedia('video'), false);
    assert.equal(checkMedia('unknown'), false);
    assert.equal(checkMedia('audio', { isMainFrame: false }), false);
    assert.equal(checkMedia('audio', { requestingUrl: 'file:///Other/src/application/index.html' }), false);
    const ask = (types, permission = 'media', sender = webContents) => {
        let granted;
        request(sender, permission, value => { granted = value; }, { ...context, mediaTypes: types });
        return granted;
    };
    assert.equal(ask(['audio']), true);
    assert.equal(ask(['audio', 'video']), false);
    assert.equal(ask(undefined), false);
    assert.equal(ask(['audio'], 'display-capture'), false);
    assert.equal(ask(['audio'], 'media', null), false);
    idle = true;
    assert.equal(checkMedia('audio'), false);
    assert.equal(ask(['audio']), false);
});

test('desktop windows reject navigation, redirects, embedded webviews and popup windows', () => {
    const contents = new EventEmitter();
    contents.setWindowOpenHandler = handle => { contents.open = handle; };
    lockDesktopNavigation(contents);
    for (const event of ['will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
        let denied = false;
        contents.emit(event, { preventDefault: () => { denied = true; } });
        assert.equal(denied, true, event);
    }
    assert.deepEqual(contents.open(), { action: 'deny' });
});
