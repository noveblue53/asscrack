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
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appPage } from './app-scheme.mjs';
import { isDesktopFrame, lockDesktopNavigation } from './desktop-boundary.mjs';
import { fitWindowBounds, readWindowBounds, saveWindowBounds } from './window-bounds.mjs';

export const MUSIC_WINDOW_FILE = 'music-window.json';
export const MUSIC_WINDOW_STATE_FILE = 'music-window-state.json';
export const MUSIC_WINDOW_MIN = Object.freeze({ width: 300, height: 360 });
export const MUSIC_WINDOW_DEFAULT = Object.freeze({ width: 420, height: 560 });
export const MUSIC_SHADE_HEIGHT = 48;
export const MUSIC_SHADE_MIN_WIDTH = 400;
export const MUSIC_SHADE_DEFAULT_WIDTH = 480;
export const MUSIC_SHADE_MIN = Object.freeze({ width: MUSIC_SHADE_MIN_WIDTH, height: MUSIC_SHADE_HEIGHT });
export const MUSIC_SHADE_DEFAULT = Object.freeze({ width: MUSIC_SHADE_DEFAULT_WIDTH, height: MUSIC_SHADE_HEIGHT });
// 16 bands and two VU levels.
export const VIZ_FRAME_BYTES = 18;

export const POPOUT_CHANNELS = Object.freeze({
    state: 'asscrack:music-window-ui-state',
    setState: 'asscrack:music-window-set-ui-state',
    action: 'asscrack:music-window-action'
});

const validInt = (n, min = -2147483648, max = 2147483647) => Number.isInteger(n) && n >= min && n <= max;

function normalizeShadeBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    if (!validInt(bounds.x) || !validInt(bounds.y) || !validInt(bounds.width, 1, 100000)) return null;
    return { x: bounds.x, y: bounds.y, width: Math.max(MUSIC_SHADE_MIN_WIDTH, bounds.width), height: MUSIC_SHADE_HEIGHT };
}

function readWindowState(profile) {
    try {
        const value = JSON.parse(readFileSync(path.join(profile, MUSIC_WINDOW_STATE_FILE), 'utf8'));
        if (!value || typeof value !== 'object') return { shaded: false, pinned: false, shadeBounds: null };
        return {
            shaded: value.shaded === true,
            pinned: value.pinned === true,
            shadeBounds: normalizeShadeBounds(value.shadeBounds)
        };
    } catch {
        return { shaded: false, pinned: false, shadeBounds: null };
    }
}

function saveWindowState(profile, state) {
    const file = path.join(profile, MUSIC_WINDOW_STATE_FILE);
    const payload = {
        shaded: state.shaded === true,
        pinned: state.pinned === true,
        ...(state.shadeBounds ? { shadeBounds: normalizeShadeBounds(state.shadeBounds) } : {})
    };
    writeFileSync(file + '.tmp', JSON.stringify(payload));
    renameSync(file + '.tmp', file);
}

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
    let uiState = { shaded: false, pinned: false, shadeBounds: null };
    let lastFullBounds = null;

    const fromWindow = event => Boolean(win) && isDesktopFrame(win, event.sender, event.senderFrame, page);
    function post(channel, data) {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
        const contents = win.webContents;
        if (isDesktopFrame(win, contents, contents.mainFrame, page)) contents.send(channel, data);
    }
    const withNames = view => (view && typeof view === 'object' ? { ...view, names: { ...(names() ?? {}) } } : view);

    function fitBounds(saved, min, fallback) {
        const near = nearBounds();
        const display = saved ? screen.getDisplayMatching(saved) : near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay();
        return fitWindowBounds(saved, display.workArea, min, fallback);
    }
    function startBounds() {
        return fitBounds(readWindowBounds(profile, MUSIC_WINDOW_FILE), MUSIC_WINDOW_MIN, MUSIC_WINDOW_DEFAULT);
    }
    function startShadeBounds(savedShade, fallbackBounds) {
        const seed = normalizeShadeBounds(savedShade) ?? (fallbackBounds
            ? { x: Math.round(fallbackBounds.x), y: Math.round(fallbackBounds.y),
                width: Math.max(MUSIC_SHADE_MIN_WIDTH, Math.round(fallbackBounds.width ?? MUSIC_SHADE_DEFAULT_WIDTH)),
                height: MUSIC_SHADE_HEIGHT }
            : null);
        const fitted = fitBounds(seed, MUSIC_SHADE_MIN, MUSIC_SHADE_DEFAULT);
        return { x: fitted.x, y: fitted.y, width: fitted.width, height: MUSIC_SHADE_HEIGHT };
    }
    function saveBounds(target) {
        try {
            saveWindowBounds(profile, { ...target.getNormalBounds(), maximized: target.isMaximized?.() === true }, MUSIC_WINDOW_FILE);
        } catch (err) {
            warn('Music window bounds not saved: ' + (err?.message ?? err));
        }
    }
    function persistState() {
        try {
            saveWindowState(profile, uiState);
        } catch (err) {
            warn('Music window state not saved: ' + (err?.message ?? err));
        }
    }
    function captureShadeBounds(target) {
        const cur = target.getNormalBounds();
        return {
            x: Math.round(cur.x),
            y: Math.round(cur.y),
            width: Math.max(MUSIC_SHADE_MIN_WIDTH, Math.round(cur.width)),
            height: MUSIC_SHADE_HEIGHT
        };
    }

    function open() {
        if (win && !win.isDestroyed()) {
            if (win.isMinimized?.()) win.restore();
            win.show();
            win.focus();
            return true;
        }
        uiState = readWindowState(profile);
        lastFullBounds = readWindowBounds(profile, MUSIC_WINDOW_FILE);
        const shaded = uiState.shaded;
        const bounds = shaded ? startShadeBounds(uiState.shadeBounds, lastFullBounds ?? nearBounds()) : startBounds();
        const created = new BrowserWindow({
            x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
            minWidth: shaded ? MUSIC_SHADE_MIN_WIDTH : MUSIC_WINDOW_MIN.width,
            minHeight: shaded ? MUSIC_SHADE_HEIGHT : MUSIC_WINDOW_MIN.height,
            ...(shaded ? { maxHeight: MUSIC_SHADE_HEIGHT, maximizable: false } : {}),
            frame: false, alwaysOnTop: uiState.pinned,
            title: 'Music – ASSCRACK', show: false,
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
            if (!shaded && bounds.maximized) created.maximize();
            created.show();
        });
        created.on('close', () => {
            if (uiState.shaded) {
                uiState.shadeBounds = captureShadeBounds(created);
                persistState();
            } else {
                saveBounds(created);
                if (uiState.pinned || uiState.shadeBounds) persistState();
            }
        });
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
    ipc.handle(POPOUT_CHANNELS.state, async event => {
        need(event);
        return { shaded: uiState.shaded, pinned: uiState.pinned };
    });
    ipc.handle(POPOUT_CHANNELS.setState, async (event, patch) => {
        need(event);
        if (patch && typeof patch === 'object') {
            if (typeof patch.pinned === 'boolean' && patch.pinned !== uiState.pinned) {
                uiState.pinned = patch.pinned;
                win.setAlwaysOnTop?.(uiState.pinned);
            }
            if (typeof patch.shaded === 'boolean' && patch.shaded !== uiState.shaded) {
                if (patch.shaded) {
                    lastFullBounds = { ...win.getNormalBounds(), maximized: win.isMaximized?.() === true };
                    saveBounds(win);
                    if (win.isMaximized?.()) win.unmaximize?.();
                    const sb = startShadeBounds(uiState.shadeBounds, {
                        x: lastFullBounds.x,
                        y: lastFullBounds.y,
                        width: Math.max(MUSIC_SHADE_MIN_WIDTH, lastFullBounds.width),
                        height: MUSIC_SHADE_HEIGHT
                    });
                    win.setMaximizable?.(false);
                    win.setMinimumSize?.(MUSIC_SHADE_MIN_WIDTH, MUSIC_SHADE_HEIGHT);
                    win.setMaximumSize?.(16384, MUSIC_SHADE_HEIGHT);
                    win.setBounds?.({ x: sb.x, y: sb.y, width: sb.width, height: MUSIC_SHADE_HEIGHT });
                    uiState.shaded = true;
                    uiState.shadeBounds = { x: sb.x, y: sb.y, width: sb.width, height: MUSIC_SHADE_HEIGHT };
                } else {
                    uiState.shadeBounds = captureShadeBounds(win);
                    const saved = lastFullBounds ?? readWindowBounds(profile, MUSIC_WINDOW_FILE);
                    const fb = fitBounds(saved, MUSIC_WINDOW_MIN, MUSIC_WINDOW_DEFAULT);
                    win.setMaximumSize?.(0, 0);
                    win.setMinimumSize?.(MUSIC_WINDOW_MIN.width, MUSIC_WINDOW_MIN.height);
                    win.setMaximizable?.(true);
                    win.setBounds?.({ x: fb.x, y: fb.y, width: fb.width, height: fb.height });
                    if (fb.maximized) win.maximize?.();
                    uiState.shaded = false;
                }
            }
            persistState();
        }
        const next = { shaded: uiState.shaded, pinned: uiState.pinned };
        post('asscrack:music-window-ui-state-changed', next);
        return next;
    });
    ipc.handle(POPOUT_CHANNELS.action, async (event, action) => {
        need(event);
        if (action === 'minimize') win.minimize?.();
        else if (action === 'close') win.close();
    });

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
