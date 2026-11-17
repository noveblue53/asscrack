import { app, BrowserWindow, Menu, ipcMain, session } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import { mkdirSync, appendFileSync } from 'fs';
import { format } from 'util';
import { createAsscrackNode } from '../network/node.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

Menu.setApplicationMenu(null);

const EVENTS = ['peer-discovered', 'peer-joined', 'peer-left', 'message', 'history', 'signal', 'voice-state', 'host-changed', 'peer-name',
    'file-offer', 'file-progress', 'file-done', 'file-failed', 'file-refused', 'file-cancelled', 'topology'];

// Test option: --profile <dir> gives each instance its own user data folder.
const profileIndex = process.argv.indexOf('--profile');
if (profileIndex !== -1 && process.argv[profileIndex + 1]) {
    app.setPath('userData', path.resolve(process.argv[profileIndex + 1]));
}

// Log file: one file for each start, in app.getPath('logs') or in the folder of --log-dir <dir>.
// A failure to write the log must not stop the app.
let logFile = null;

function pad(n) {
    return String(n).padStart(2, '0');
}

function writeLog(level, text) {
    if (!logFile) return;
    try {
        appendFileSync(logFile, `${new Date().toISOString()} ${level} ${text}
`);
    } catch {
        // Ignore: the terminal output stays.
    }
}

function openLog() {
    try {
        const logDirIndex = process.argv.indexOf('--log-dir');
        const dir = logDirIndex !== -1 && process.argv[logDirIndex + 1]
            ? path.resolve(process.argv[logDirIndex + 1])
            : app.getPath('logs');
        mkdirSync(dir, { recursive: true });
        const d = new Date();
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        logFile = path.join(dir, `asscrack-${stamp}.log`);
        writeLog('INFO', `ASSCRACK ${app.getVersion()} Electron ${process.versions.electron} args ${JSON.stringify(process.argv)} log ${logFile}`);
    } catch (err) {
        logFile = null;
        console.error('Log file open failed:', err);
    }
}

for (const [method, level] of [['log', 'LOG'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        original(...args);
        writeLog(level, format(...args));
    };
}

openLog();

// One log line for each node event. The chat text does not go into the log.
const UNLOGGED_EVENTS = new Set(['signal', 'file-progress']);

function logEvent(type, data) {
    if (UNLOGGED_EVENTS.has(type)) return;
    const parts = [`event ${type}`];
    if (data?.peerId) parts.push(`peer ${data.peerId}`);
    if (type === 'message') {
        parts.push(`ids ${data?.id ?? ''}`, 'count 1');
    } else if (type === 'history') {
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        parts.push(`ids ${messages.map(m => m?.id).join(',')}`, `count ${messages.length}`);
    } else if (data?.offerId) {
        parts.push(`offer ${data.offerId}`);
    }
    writeLog('EVENT', parts.join(' '));
}

// Test option: --downloads <dir> sets the folder for received files.
let downloadDir = null;
const downloadsIndex = process.argv.indexOf('--downloads');
if (downloadsIndex !== -1 && process.argv[downloadsIndex + 1]) {
    downloadDir = path.resolve(process.argv[downloadsIndex + 1]);
    mkdirSync(downloadDir, { recursive: true });
}

function isAppPage(url) {
    return typeof url === 'string' && url.startsWith('file://') && url.endsWith('/src/application/index.html');
}

function setPermissions() {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const url = details?.requestingUrl ?? webContents?.getURL();
        callback(permission === 'media' && isAppPage(url));
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
        const url = details?.requestingUrl ?? requestingOrigin;
        return permission === 'media' && isAppPage(url);
    });
}

let mainWindow = null;
let node = null;
let loginStarted = false;
let stopping = false;

function sendToWindow(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        title: 'AssCrack',
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            autoplayPolicy: 'no-user-gesture-required'
        }
    });

    const startUrl = new URL(`file://${path.join(__dirname, 'index.html')}`).href;

    mainWindow.webContents.on('console-message', details => {
        writeLog('WINDOW', `${details.level} ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });

    mainWindow.loadURL(startUrl);

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
}

ipcMain.handle('asscrack:login', async (_event, { name, room } = {}) => {
    if (loginStarted) throw new Error('Already logged in');
    loginStarted = true;
    try {
        node = await createAsscrackNode({ name, room, downloadDir: downloadDir ?? app.getPath('downloads') });
    } catch (err) {
        loginStarted = false;
        throw err;
    }
    for (const type of EVENTS) {
        node.events.on(type, data => {
            logEvent(type, data);
            sendToWindow(`asscrack:${type}`, data);
        });
    }
    return { peerId: node.peerId };
});

ipcMain.handle('asscrack:send', (_event, text) => {
    if (!node) throw new Error('Not logged in');
    return node.send(text);
});

ipcMain.handle('asscrack:signal', (_event, { peerId, data } = {}) => {
    if (!node) throw new Error('Not logged in');
    return node.sendTo(peerId, { type: 'signal', data });
});

ipcMain.handle('asscrack:set-voice', (_event, state) => {
    if (!node) throw new Error('Not logged in');
    node.setVoice(state ?? {});
});

ipcMain.handle('asscrack:host', () => {
    if (!node) throw new Error('Not logged in');
    return { host: node.host() ?? null, self: node.peerId };
});

ipcMain.handle('asscrack:topology', () => {
    return node ? node.topology() : null;
});

ipcMain.handle('asscrack:offer-file', (_event, filePath) => {
    if (!node) throw new Error('Not logged in');
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('The file path is not an absolute path');
    return node.offerFile(filePath);
});

ipcMain.handle('asscrack:accept-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    return node.acceptFile(String(offerId));
});

ipcMain.handle('asscrack:refuse-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    return node.refuseFile(String(offerId));
});

ipcMain.handle('asscrack:cancel-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    return node.cancelFile(String(offerId));
});

app.on('before-quit', event => {
    if (!node || stopping) return;
    event.preventDefault();
    stopping = true;
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            console.error('Node stop timed out');
            resolve();
        }, 3000);
    });
    Promise.race([
        node.stop().catch(err => console.error('Node stop failed:', err)),
        timeout
    ]).finally(() => {
        clearTimeout(timer);
        node = null;
        app.exit(0);
    });
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
    setPermissions();
    createMainWindow();
});
