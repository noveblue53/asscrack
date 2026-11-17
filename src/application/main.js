import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import { createAsscrackNode } from '../network/node.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

Menu.setApplicationMenu(null);

const EVENTS = ['peer-discovered', 'peer-joined', 'peer-left', 'message'];

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
            sandbox: true
        }
    });

    const startUrl = new URL(`file://${path.join(__dirname, 'index.html')}`).href;

    mainWindow.loadURL(startUrl);

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
}

ipcMain.handle('asscrack:login', async (_event, { name, room } = {}) => {
    if (loginStarted) throw new Error('Already logged in');
    loginStarted = true;
    try {
        node = await createAsscrackNode({ name, room });
    } catch (err) {
        loginStarted = false;
        throw err;
    }
    for (const type of EVENTS) {
        node.events.on(type, data => sendToWindow(`asscrack:${type}`, data));
    }
    return { peerId: node.peerId };
});

ipcMain.handle('asscrack:send', (_event, text) => {
    if (!node) throw new Error('Not logged in');
    return node.send(text);
});

app.on('before-quit', event => {
    if (!node || stopping) return;
    event.preventDefault();
    stopping = true;
    node.stop()
        .catch(err => console.error('Node stop failed:', err))
        .finally(() => {
            node = null;
            app.quit();
        });
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(createMainWindow);
