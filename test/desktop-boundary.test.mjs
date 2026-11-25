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

// P8b, design W3 check 1: display-capture only with all of these: the room window frame, not Idle Peer, a pending
// selection, and mediaTypes exactly ['video']. Each condition alone, when false, gives a refusal.
test('display-capture needs the room frame, no Idle Peer, a pending selection and exactly video', () => {
    const page = 'file:///Asscrack/src/application/index.html';
    const webContents = { mainFrame: { url: page }, isDestroyed: () => false };
    let idle = false, pending = true, check, request;
    installRoomPermissions({
        setPermissionCheckHandler: handler => { check = handler; },
        setPermissionRequestHandler: handler => { request = handler; }
    }, () => ({ webContents, isDestroyed: () => false }), page, () => idle, () => pending);
    const ask = (details = {}, sender = webContents, permission = 'display-capture') => {
        let granted;
        request(sender, permission, value => { granted = value; }, { isMainFrame: true, requestingUrl: page, mediaTypes: ['video'], ...details });
        return granted;
    };
    assert.equal(ask(), true);
    assert.equal(ask({}, { mainFrame: { url: page }, isDestroyed: () => false }), false, 'another window');
    assert.equal(ask({ isMainFrame: false }), false, 'a subframe');
    assert.equal(ask({ requestingUrl: 'file:///Other/index.html' }), false, 'another page');
    assert.equal(ask({ mediaTypes: ['video', 'audio'] }), false, 'video and audio');
    assert.equal(ask({ mediaTypes: ['audio'] }), false, 'audio');
    assert.equal(ask({ mediaTypes: [] }), false, 'no media type');
    assert.equal(ask({ mediaTypes: undefined }), false, 'no media types');
    assert.equal(ask({ mediaTypes: ['video', 'video'] }), false, 'not exactly one entry');
    pending = false;
    assert.equal(ask(), false, 'no pending selection');
    pending = true;
    idle = true;
    assert.equal(ask(), false, 'Idle Peer');
    idle = false;
    // The audio rules do not change: media with video stays refused, and the check handler gives no display-capture.
    assert.equal(ask({ mediaTypes: ['video'] }, webContents, 'media'), false);
    assert.equal(ask({ mediaTypes: ['audio'] }, webContents, 'media'), true);
    assert.equal(check(webContents, 'display-capture', 'file://', { isMainFrame: true, requestingUrl: page, mediaType: 'video' }), false);
});

test('with no screen selection function, display-capture is always refused (the default of installRoomPermissions)', () => {
    const page = 'file:///Asscrack/src/application/index.html';
    const webContents = { mainFrame: { url: page }, isDestroyed: () => false };
    let request;
    installRoomPermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: handler => { request = handler; } },
        () => ({ webContents, isDestroyed: () => false }), page, () => false);
    let granted;
    request(webContents, 'display-capture', value => { granted = value; }, { isMainFrame: true, requestingUrl: page, mediaTypes: ['video'] });
    assert.equal(granted, false);
});

test('display-capture allows video and audio only when a loopback audio share is pending', () => {
    const page = 'file:///Asscrack/src/application/index.html';
    const webContents = { mainFrame: { url: page }, isDestroyed: () => false };
    let pending = true, pendingAudio = false, request;
    installRoomPermissions({
        setPermissionCheckHandler() {},
        setPermissionRequestHandler: handler => { request = handler; }
    }, () => ({ webContents, isDestroyed: () => false }), page, () => false, () => pending, () => pendingAudio);
    const ask = mediaTypes => {
        let granted;
        request(webContents, 'display-capture', value => { granted = value; }, { isMainFrame: true, requestingUrl: page, mediaTypes });
        return granted;
    };
    assert.equal(ask(['video']), true);
    assert.equal(ask(['video', 'audio']), false, 'no loopback audio pending');
    pendingAudio = true;
    assert.equal(ask(['video', 'audio']), true);
    assert.equal(ask(['audio', 'video']), true);
    assert.equal(ask(['audio']), false, 'audio alone stays refused');
    assert.equal(ask(['video', 'video']), false, 'duplicate types stay refused');
    pending = false;
    assert.equal(ask(['video', 'audio']), false, 'requires pending selection');
});
