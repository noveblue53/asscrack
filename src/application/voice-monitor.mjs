import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const coordinate = n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;

// Electron screen and window bounds are both in device-independent pixels. Fit a saved window back onto
// the nearest work area when its monitor was unplugged, moved or rescaled between runs.
export function fitVoiceBounds(saved, area) {
    const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
    const width = Math.min(area.width, Math.max(230, Number.isSafeInteger(saved?.width) ? saved.width : 288));
    const height = Math.min(area.height, Math.max(130, Number.isSafeInteger(saved?.height) ? saved.height : 170));
    const x = coordinate(saved?.x) ? saved.x : area.x + area.width - width - 20;
    const y = coordinate(saved?.y) ? saved.y : area.y + 20;
    return { x: clamp(x, area.x, area.x + area.width - width), y: clamp(y, area.y, area.y + area.height - height), width, height };
}

export function attachVoiceMonitor({ room, ipc, BrowserWindow, screen, profile, assets, participating, restoreRoom, warn }) {
    const file = path.join(profile, 'voice-window.json');
    let monitor = null;
    let ready = false;
    let returnToRoom = false;
    const from = (event, win) => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
    function roomMessage(channel, data) {
        if (!room.isDestroyed() && !room.webContents.isDestroyed()) room.webContents.send(channel, data);
    }
    function open(event) {
        if (!from(event, room) || !participating()) return;
        if (monitor) { monitor.show(); monitor.focus(); return; }
        let saved;
        try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* New profile or invalid saved bounds. */ }
        const hasLocation = coordinate(saved?.x) && coordinate(saved?.y);
        const display = hasLocation ? screen.getDisplayNearestPoint({ x: saved.x, y: saved.y }) : screen.getDisplayMatching(room.getBounds());
        const win = new BrowserWindow({
            ...fitVoiceBounds(saved, display.workArea), minWidth: 230, minHeight: 130, title: 'Asscrack Voice',
            alwaysOnTop: true, skipTaskbar: true, maximizable: false, minimizable: false, fullscreenable: false, show: false,
            webPreferences: { preload: path.join(assets, 'voice-monitor-preload.cjs'), nodeIntegration: false, sandbox: true, contextIsolation: true }
        });
        monitor = win;
        returnToRoom = true;
        ready = false;
        // The room's existing audio-level timer must keep following speakers while the chat window is minimized.
        room.webContents.setBackgroundThrottling(false);
        win.webContents.on('did-finish-load', () => {
            ready = true;
            roomMessage('asscrack:voice-monitor-active', true);
        });
        win.once('ready-to-show', () => { if (monitor === win) win.show(); });
        win.on('close', () => {
            try {
                writeFileSync(file + '.' + process.pid + '.tmp', JSON.stringify(win.getNormalBounds()));
                renameSync(file + '.' + process.pid + '.tmp', file);
            } catch (err) { warn('Voice window position not saved: ' + err.message); }
        });
        win.once('closed', () => {
            monitor = null;
            ready = false;
            if (!room.isDestroyed() && !room.webContents.isDestroyed()) room.webContents.setBackgroundThrottling(true);
            roomMessage('asscrack:voice-monitor-active', false);
            if (returnToRoom && participating()) restoreRoom();
        });
        win.loadFile(path.join(assets, 'voice-monitor.html')).catch(err => {
            if (!win.isDestroyed()) { warn('Voice window could not open: ' + err.message); win.close(); }
        });
    }
    function update(event, view) {
        if (ready && from(event, room)) monitor.webContents.send('asscrack:voice-monitor-state', view);
    }
    function mute(event, value) {
        if (from(event, monitor) && participating() && typeof value === 'boolean') roomMessage('asscrack:voice-monitor-mute', value);
    }
    function close(event) {
        if (from(event, monitor)) monitor.close();
    }
    function dismiss() {
        returnToRoom = false;
        monitor?.close();
    }
    const handlers = {
        'asscrack:voice-monitor-open': open, 'asscrack:voice-monitor-publish': update,
        'asscrack:voice-monitor-set-muted': mute, 'asscrack:voice-monitor-close': close
    };
    for (const [channel, handler] of Object.entries(handlers)) ipc.on(channel, handler);
    room.webContents.once('render-process-gone', dismiss);
    room.once('closed', () => {
        dismiss();
        for (const [channel, handler] of Object.entries(handlers)) ipc.removeListener(channel, handler);
    });
    return { dismiss };
}
