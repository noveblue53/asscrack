// BrowserWindow reads native-overlay options at construction. Persist the next-launch choice separately from theme.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export function createWindowFrame(profile, platform = process.platform) {
    const file = path.join(profile, 'window-frame.json');
    let systemButtons = false;
    if (platform === 'win32') {
        try { systemButtons = JSON.parse(readFileSync(file, 'utf8')).systemButtons === true; } catch {}
    }
    const mode = platform === 'darwin' ? 'mac' : systemButtons ? 'overlay' : 'glass';
    const options = mode === 'overlay'
        ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#205a45', symbolColor: '#ffffff', height: 36 } }
        : mode === 'mac' ? { titleBarStyle: 'hiddenInset' } : { frame: false };

    function attach(win, ipc) {
        const state = () => ({ mode, maximized: win.isMaximized(), canChooseSystemButtons: platform === 'win32', systemButtons });
        const handlers = {
            state,
            action(action) {
                if (mode !== 'glass') return;
                if (action === 'minimize') win.minimize();
                if (action === 'maximize') {
                    if (win.isMaximized()) win.unmaximize();
                    else win.maximize();
                }
                if (action === 'close') win.close();
            },
            system(enabled) {
                if (platform !== 'win32' || typeof enabled !== 'boolean') throw new Error('Unsupported window control setting');
                const temp = file + '.' + process.pid + '.tmp';
                writeFileSync(temp, JSON.stringify({ systemButtons: enabled }));
                renameSync(temp, file);
                systemButtons = enabled;
                return state();
            },
            colors(color, ink) {
                if (mode === 'overlay' && [color, ink].every(v => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v))) {
                    win.setTitleBarOverlay({ color, symbolColor: ink, height: 36 });
                }
            }
        };
        for (const [key, handle] of Object.entries(handlers)) {
            ipc.handle('asscrack:frame-' + key, (event, ...args) => {
                if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Unknown window');
                return handle(...args);
            });
        }
        const reportState = () => win.webContents.send('asscrack:frame-changed', state());
        win.on('maximize', reportState);
        win.on('unmaximize', reportState);
        win.once('closed', () => {
            for (const key of Object.keys(handlers)) ipc.removeHandler('asscrack:frame-' + key);
        });
    }
    return { options, attach };
}
