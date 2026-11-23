// Room music: the player in its own window (operator request 2026-11-23). "Pop out" in the music bar opens it, only
// in a room. There is one window at most: a second open focuses it. The window has the queue, the controls and the
// large visualizer. The bar of the room window folds to the thin strip while this window is open. The window keeps
// its size and position in music-window.json of the profile. The settings remember the open window (popout): a close
// by the user clears it; a close at Leave room, at the close of the room window or at Quit keeps it.
// This module does not import electron: main.js gives BrowserWindow, ipcMain and screen. The method of
// friends-popout.mjs: an own preload, the navigation lock, the self-only content security policy of the page, and own
// IPC channels that accept only the main frame of this window.
// The window has no audio. The room window has the music (music.js); for each frame of the visualizer this window
// asks for the levels (pull), main.js asks the room window, and the room window gives 18 bytes (music-viz-core.js).
import path from 'node:path';
import { appPage } from './app-scheme.mjs';
import { isDesktopFrame, lockDesktopNavigation } from './desktop-boundary.mjs';
import { fitWindowBounds, readWindowBounds, saveWindowBounds } from './window-bounds.mjs';

export const MUSIC_WINDOW_FILE = 'music-window.json';
export const MUSIC_WINDOW_MIN = Object.freeze({ width: 300, height: 360 });
export const MUSIC_WINDOW_DEFAULT = Object.freeze({ width: 420, height: 560 });
// 16 bands and two VU levels.
export const VIZ_FRAME_BYTES = 18;

// The room channels of music-ipc.mjs that this window can also call, and the channel of this window for each.
export const WINDOW_CHANNELS = Object.freeze({
    'asscrack:music-state': 'asscrack:music-window-state',
    'asscrack:music-add': 'asscrack:music-window-add',
    'asscrack:music-add-files': 'asscrack:music-window-add-files',
    'asscrack:music-folder': 'asscrack:music-window-folder',
    'asscrack:music-choose-folder': 'asscrack:music-window-choose-folder',
    'asscrack:music-add-folder-file': 'asscrack:music-window-add-folder-file',
    'asscrack:music-skip': 'asscrack:music-window-skip',
    'asscrack:music-pause': 'asscrack:music-window-pause',
    'asscrack:music-remove': 'asscrack:music-window-remove',
    'asscrack:music-move': 'asscrack:music-window-move',
    'asscrack:music-stop': 'asscrack:music-window-stop',
    'asscrack:music-settings': 'asscrack:music-window-settings',
    'asscrack:set-music-settings': 'asscrack:music-window-set-settings'
});

// controls: the Map of music-ipc.mjs (room channel -> handler). names(): peer ID -> display name of the room.
// remember(on): save the popout setting. onState({ open }): tell the room window. pull(): ask the room window for one
// visualizer frame. nearBounds(): the bounds of the room window (a first open shows the window on the same display).
export function attachMusicPopout({ BrowserWindow, ipc, screen, profile, assets, controls, names = () => ({}), icon,
    nearBounds = () => null, remember = () => {}, onState = () => {}, pull = () => {}, warn = () => {} }) {
    const page = appPage('music-window.html');
    let win = null;
    // A close of this module (Leave room, Quit): the setting keeps the window for the next time.
    let closingByApp = false;

    const fromWindow = event => Boolean(win) && isDesktopFrame(win, event.sender, event.senderFrame, page);
    function post(channel, data) {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
        const contents = win.webContents;
        if (isDesktopFrame(win, contents, contents.mainFrame, page)) contents.send(channel, data);
    }
    const withNames = view => (view && typeof view === 'object' ? { ...view, names: { ...(names() ?? {}) } } : view);

    function startBounds() {
        const saved = readWindowBounds(profile, MUSIC_WINDOW_FILE);
        const near = nearBounds();
        const display = saved ? screen.getDisplayMatching(saved) : near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay();
        return fitWindowBounds(saved, display.workArea, MUSIC_WINDOW_MIN, MUSIC_WINDOW_DEFAULT);
    }
    function saveBounds(target) {
        try {
            saveWindowBounds(profile, { ...target.getNormalBounds(), maximized: target.isMaximized?.() === true }, MUSIC_WINDOW_FILE);
        } catch (err) {
            warn('Music window bounds not saved: ' + (err?.message ?? err));
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
            minWidth: MUSIC_WINDOW_MIN.width, minHeight: MUSIC_WINDOW_MIN.height, title: 'Music – ASSCRACK', show: false,
            autoHideMenuBar: true, ...(icon ? { icon } : {}),
            webPreferences: { preload: path.join(assets, 'music-window-preload.cjs'), nodeIntegration: false, sandbox: true, contextIsolation: true }
        });
        created.removeMenu?.();
        lockDesktopNavigation(created.webContents);
        win = created;
        closingByApp = false;
        created.on('page-title-updated', event => event.preventDefault());
        created.once('ready-to-show', () => {
            if (created.isDestroyed()) return;
            if (bounds.maximized) created.maximize();
            created.show();
        });
        created.on('close', () => saveBounds(created));
        created.once('closed', () => {
            if (win !== created) return;
            win = null;
            if (!closingByApp) remember(false);
            closingByApp = false;
            onState({ open: false });
        });
        created.loadURL(page).catch(err => {
            if (!created.isDestroyed()) { warn('Music window could not open: ' + err.message); created.close(); }
        });
        remember(true);
        onState({ open: true });
        return true;
    }

    // The calls of the window: the same functions as the room window (music-ipc.mjs), only from the main frame of
    // this window.
    const need = event => { if (!fromWindow(event)) throw new Error('Unknown music window'); };
    for (const [roomChannel, channel] of Object.entries(WINDOW_CHANNELS)) {
        const handler = controls.get(roomChannel);
        if (typeof handler !== 'function') throw new Error(`No music control ${roomChannel}`);
        ipc.handle(channel, async (event, ...args) => {
            need(event);
            const result = await handler(event, ...args);
            return roomChannel === 'asscrack:music-state' ? withNames(result) : result;
        });
    }
    ipc.on('asscrack:music-window-viz-pull', event => { if (fromWindow(event)) pull(); });

    return {
        open,
        isOpen: () => Boolean(win && !win.isDestroyed()),
        // The user closes the window from the room window (the Pop out button).
        closeByUser() { if (win && !win.isDestroyed()) win.close(); },
        // Leave room, the close of the room window, Quit: the setting stays.
        close() {
            if (!win || win.isDestroyed()) return;
            closingByApp = true;
            win.close();
        },
        // The live data of the room: the view of the node, a notice, the settings, the names.
        view: view => post('asscrack:music-window-view', withNames(view)),
        notice: notice => post('asscrack:music-window-notice', notice),
        settings: value => post('asscrack:music-window-settings-changed', value),
        // One frame of the visualizer from the room window: 18 bytes or nothing.
        viz(bytes) {
            const ok = bytes instanceof Uint8Array && bytes.length === VIZ_FRAME_BYTES;
            post('asscrack:music-window-viz', ok ? bytes : null);
        }
    };
}
