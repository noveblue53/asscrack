// G7a: the friend chat windows (design F7) and the friend IPC of the room window. This module does not import
// electron: main.js gives BrowserWindow and ipcMain. The method of voice-monitor.mjs: an own preload, the navigation
// lock, the self-only content security policy of the page. One window for each friend; a second open focuses it.
// The chat window gets no key, no address, no room ID and no file path. The main process binds each window to its
// friend: the window never sends a friend ID.
import path from 'node:path';
import { appPage } from './app-scheme.mjs';
import { isDesktopFrame, lockDesktopNavigation } from './desktop-boundary.mjs';

const text128 = value => typeof value === 'string' && value.length > 0 && value.length <= 128;

// The view of one friend for its chat window.
function chatState(links, friendId) {
    const friend = links.friend(friendId);
    if (!friend) return { name: '', state: 'gone', lastSeen: null, reach: 'local' };
    // G7b: also the availability of the friend, and the room name of a common room (state 'room').
    return { name: friend.name, state: friend.state, lastSeen: friend.lastSeen, reach: links.list().reach,
        availability: friend.availability ?? null, note: friend.note ?? '', roomName: friend.roomName ?? '' };
}

// focused(friendId): G7b, the chat window of that friend got the focus (main.js reads its notification).
// join(friendId, lineId, leave): easy-join, Join of an invite card (main.js). The window gives only the line ID.
export function attachFriendWindows({ BrowserWindow, ipc, assets, links, warn = () => {}, openLink = async () => false, icon,
    focused = () => {}, join = async () => ({ result: 'failed' }) }) {
    // I4: the page comes from the app scheme (app-scheme.mjs).
    const page = appPage('friend-chat.html');
    const windows = new Map(); // friendId -> BrowserWindow

    function friendOf(event) {
        for (const [friendId, win] of windows) if (isDesktopFrame(win, event.sender, event.senderFrame, page)) return friendId;
        return null;
    }
    function need(event) {
        const friendId = friendOf(event);
        if (!friendId) throw new Error('Unknown friend chat window');
        return friendId;
    }
    function post(friendId, channel, data) {
        const win = windows.get(friendId);
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
        const contents = win.webContents;
        if (isDesktopFrame(win, contents, contents.mainFrame, page)) contents.send(channel, data);
    }
    const title = name => `${name || 'Friend'} – ASSCRACK`;

    function open(friendId) {
        if (!links.friend(friendId)) return false;
        const old = windows.get(friendId);
        if (old && !old.isDestroyed()) {
            if (old.isMinimized()) old.restore();
            old.show();
            old.focus();
            return true;
        }
        const win = new BrowserWindow({
            width: 420, height: 520, minWidth: 320, minHeight: 360, title: title(links.friend(friendId).name), show: false,
            autoHideMenuBar: true, ...(icon ? { icon } : {}),
            webPreferences: { preload: path.join(assets, 'friend-chat-preload.cjs'), nodeIntegration: false, sandbox: true, contextIsolation: true }
        });
        win.removeMenu?.();
        lockDesktopNavigation(win.webContents);
        windows.set(friendId, win);
        // The page sets the title "<name> – ASSCRACK" (friend-chat.js). Until then the window has the same title.
        win.on('page-title-updated', (event, value) => { if (!/ – ASSCRACK$/.test(value)) event.preventDefault(); });
        win.on('focus', () => { links.markRead(friendId); focused(friendId); });
        win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
        win.once('closed', () => { if (windows.get(friendId) === win) windows.delete(friendId); });
        win.loadURL(page).catch(err => {
            if (!win.isDestroyed()) { warn('Friend chat window could not open: ' + err.message); win.close(); }
        });
        return true;
    }

    const handlers = {
        'asscrack:friend-chat-state': event => {
            const friendId = need(event);
            links.markRead(friendId);
            return chatState(links, friendId);
        },
        'asscrack:friend-chat-lines': (event, before) => {
            const friendId = need(event);
            let cursor = null;
            if (before && Number.isFinite(Number(before.time)) && text128(String(before.id ?? ''))) {
                cursor = { time: Number(before.time), id: String(before.id) };
            }
            return links.lines(friendId, cursor);
        },
        'asscrack:friend-chat-send': (event, text) => {
            const friendId = need(event);
            if (typeof text !== 'string') return { result: 'invalid' };
            return links.send(friendId, text);
        },
        // G7b: Delete of a waiting line: 'deleted', 'sending' or 'gone'.
        'asscrack:friend-chat-delete': (event, id) => {
            const friendId = need(event);
            return text128(id) ? links.deleteWaiting(friendId, id) : 'gone';
        },
        // easy-join: Join of an invite card. leave: the user agreed to leave the current room.
        'asscrack:friend-chat-join': (event, id, leave) => {
            const friendId = need(event);
            return text128(id) ? join(friendId, id, leave === true) : { result: 'gone' };
        },
        'asscrack:friend-chat-open-link': (event, href) => {
            need(event);
            return openLink(href);
        }
    };
    for (const [channel, handler] of Object.entries(handlers)) ipc.handle(channel, handler);

    links.events.on('line', ({ friendId, line }) => {
        post(friendId, 'asscrack:friend-chat-line', line);
        const win = windows.get(friendId);
        if (win && !win.isDestroyed() && win.isFocused()) links.markRead(friendId);
    });
    links.events.on('receipt', ({ friendId, id, result }) => post(friendId, 'asscrack:friend-chat-receipt', { id, result }));
    links.events.on('changed', () => {
        for (const [friendId, win] of windows) {
            const state = chatState(links, friendId);
            if (!win.isDestroyed() && state.name) win.setTitle(title(state.name));
            post(friendId, 'asscrack:friend-chat-state', state);
        }
    });

    return {
        open,
        // G7b: true when the chat window of that friend has the focus (the attention rule of a friend line).
        isFocused(friendId) {
            const win = windows.get(friendId);
            return Boolean(win && !win.isDestroyed() && win.isFocused());
        },
        closeAll() { for (const win of windows.values()) if (!win.isDestroyed()) win.close(); }
    };
}

// The friend IPC of the room window (main window). handle: handleRoomIpc of main.js (the sender check).
// roomNode(): the node of the room now, or null.
// query: the same check for the two read-only calls, but a call from a window that closes (for example at Quit)
// gets null and no error line in the terminal.
export function registerFriendIpc(handle, { links, roomNode, openChat, query = handle }) {
    query('asscrack:friends', () => links.list());
    query('asscrack:friend-relations', (_event, peerIds) => links.relations(Array.isArray(peerIds) ? peerIds.filter(text128) : []));
    handle('asscrack:friend-request', (_event, peerId) => {
        const node = roomNode();
        if (!node || !text128(peerId)) return { result: 'unavailable' };
        return links.request(node, peerId);
    });
    handle('asscrack:friend-respond', (_event, id, accept) => text128(id) && links.respond(id, accept === true));
    handle('asscrack:friend-remove', (_event, friendId) => text128(friendId) && links.remove(friendId));
    handle('asscrack:friend-block', (_event, friendId) => text128(friendId) && links.block(friendId));
    handle('asscrack:friend-unblock', (_event, deviceId) => text128(deviceId) && links.unblock(deviceId));
    handle('asscrack:friend-rename', (_event, friendId, name) => text128(friendId) && links.rename(friendId, String(name ?? '')));
    handle('asscrack:friend-name', (_event, name) => links.setName(String(name ?? '')));
    handle('asscrack:friend-upnp', (_event, on) => links.setUpnp(on === true));
    handle('asscrack:friend-open-chat', (_event, friendId) => text128(friendId) && openChat(friendId));
    // easy-join: "Invite to room" of a friend row. The window gives only the friend ID (never a device ID).
    handle('asscrack:friend-invite', (_event, friendId) => (text128(friendId) ? links.invite(friendId) : { result: 'unavailable' }));
}
