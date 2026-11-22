// 1.0.1: the Friends window (operator request 2026-11-22). In a room, "Pop out" in the Friends drawer opens the
// Friends list in its own window. There is one window at most: a second open focuses it. The window shows the same
// live data as the drawer: the friends with their online state, the requests that wait, and a click opens the
// friend chat window. It keeps its size and its position in the file friends-window.json of the profile.
// This module does not import electron: main.js gives BrowserWindow, ipcMain and screen. The method of
// friend-windows.mjs: an own preload, the navigation lock, the self-only content security policy of the page, and
// own IPC channels that accept only the main frame of this window.
import path from 'node:path';
import { appPage } from './app-scheme.mjs';
import { isDesktopFrame, lockDesktopNavigation } from './desktop-boundary.mjs';
import { fitWindowBounds, readWindowBounds, saveWindowBounds } from './window-bounds.mjs';

export const FRIENDS_WINDOW_FILE = 'friends-window.json';
export const FRIENDS_WINDOW_MIN = Object.freeze({ width: 260, height: 320 });
export const FRIENDS_WINDOW_DEFAULT = Object.freeze({ width: 320, height: 520 });

const text128 = value => typeof value === 'string' && value.length > 0 && value.length <= 128;

// links: friend-links.mjs. openChat(friendId): the friend chat window (friend-windows.mjs).
// nearBounds(): the bounds of the room window (a first open shows the window on the same display).
export function attachFriendsPopout({ BrowserWindow, ipc, screen, profile, assets, links, openChat, icon,
    nearBounds = () => null, warn = () => {} }) {
    const page = appPage('friends-window.html');
    let win = null;

    const fromWindow = event => Boolean(win) && isDesktopFrame(win, event.sender, event.senderFrame, page);
    function post(channel, data) {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
        const contents = win.webContents;
        if (isDesktopFrame(win, contents, contents.mainFrame, page)) contents.send(channel, data);
    }

    function startBounds() {
        const saved = readWindowBounds(profile, FRIENDS_WINDOW_FILE);
        const near = nearBounds();
        const display = saved ? screen.getDisplayMatching(saved) : near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay();
        return fitWindowBounds(saved, display.workArea, FRIENDS_WINDOW_MIN, FRIENDS_WINDOW_DEFAULT);
    }
    function saveBounds(target) {
        try {
            saveWindowBounds(profile, { ...target.getNormalBounds(), maximized: target.isMaximized?.() === true }, FRIENDS_WINDOW_FILE);
        } catch (err) {
            warn('Friends window bounds not saved: ' + (err?.message ?? err));
        }
    }

    function open() {
        if (win && !win.isDestroyed()) {
            if (win.isMinimized?.()) win.restore();
            win.show();
            win.focus();
            return true;
        }
        const bounds = startBounds();
        const created = new BrowserWindow({
            x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
            minWidth: FRIENDS_WINDOW_MIN.width, minHeight: FRIENDS_WINDOW_MIN.height, title: 'Friends – ASSCRACK', show: false,
            autoHideMenuBar: true, ...(icon ? { icon } : {}),
            webPreferences: { preload: path.join(assets, 'friends-window-preload.cjs'), nodeIntegration: false, sandbox: true, contextIsolation: true }
        });
        created.removeMenu?.();
        lockDesktopNavigation(created.webContents);
        win = created;
        created.on('page-title-updated', event => event.preventDefault());
        created.once('ready-to-show', () => {
            if (created.isDestroyed()) return;
            if (bounds.maximized) created.maximize();
            created.show();
        });
        created.on('close', () => saveBounds(created));
        created.once('closed', () => { if (win === created) win = null; });
        created.loadURL(page).catch(err => {
            if (!created.isDestroyed()) { warn('Friends window could not open: ' + err.message); created.close(); }
        });
        return true;
    }

    // The calls of the window. Each handler accepts only the main frame of the Friends window. The window can show
    // the list, open a friend chat, change the name for friends, ask for UPnP and unblock a person.
    const need = event => { if (!fromWindow(event)) throw new Error('Unknown friends window'); };
    const handlers = {
        'asscrack:friends-window-list': event => (fromWindow(event) ? links.list() : null),
        'asscrack:friends-window-open-chat': (event, friendId) => { need(event); return text128(friendId) && openChat(friendId); },
        'asscrack:friends-window-name': (event, name) => { need(event); return links.setName(String(name ?? '')); },
        'asscrack:friends-window-upnp': (event, on) => { need(event); return links.setUpnp(on === true); },
        'asscrack:friends-window-unblock': (event, deviceId) => { need(event); return text128(deviceId) && links.unblock(deviceId); }
    };
    for (const [channel, handler] of Object.entries(handlers)) ipc.handle(channel, handler);

    links.events.on('changed', view => post('asscrack:friends-window-changed', view));

    return {
        open,
        isOpen: () => Boolean(win && !win.isDestroyed()),
        close() { if (win && !win.isDestroyed()) win.close(); }
    };
}
