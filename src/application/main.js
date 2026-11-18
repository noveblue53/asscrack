import { app, BrowserWindow, Menu, ipcMain, session } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { format } from 'util';
import { createAsscrackNode, keyedServiceTag } from '../network/node.mjs';
import { newRoomKey, readInvite } from '../network/invite.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

Menu.setApplicationMenu(null);

const EVENTS = ['peer-discovered', 'peer-joined', 'peer-left', 'message', 'history', 'signal', 'voice-state', 'host-changed', 'peer-name',
    'file-offer', 'file-progress', 'file-done', 'file-failed', 'file-refused', 'file-cancelled', 'topology', 'full-node', 'full-node-addrs',
    'voice-frame', 'connection', 'dial-failed'];

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
// 'voice-frame' comes 50 times each second for each speaker.
const UNLOGGED_EVENTS = new Set(['signal', 'file-progress', 'voice-frame']);

function logEvent(type, data) {
    if (UNLOGGED_EVENTS.has(type)) return;
    const parts = [`event ${type}`];
    if (type === 'connection' || type === 'dial-failed') {
        for (const [k, v] of Object.entries(data ?? {})) if (v !== undefined && v !== null) parts.push(`${k} ${JSON.stringify(v)}`);
        writeLog('EVENT', parts.join(' '));
        return;
    }
    if (data?.peerId) parts.push(`peer ${data.peerId}`);
    if (type === 'message') {
        parts.push(`ids ${data?.id ?? ''}`, 'count 1');
    } else if (type === 'history') {
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        parts.push(`ids ${messages.map(m => m?.id).join(',')}`, `count ${messages.length}`);
    } else if (data?.offerId) {
        parts.push(`offer ${data.offerId}`);
        // direction: the side of this node (send or receive).
        // by: the side whose user action caused the event (self or peer). A done or failed transfer has no such
        // action, so it gets "by none". An offer comes from the peer.
        const direction = data.direction ?? (type === 'file-offer' ? 'receive' : type === 'file-refused' ? 'send' : null);
        if (direction) parts.push(`direction ${direction}`);
        const by = data.by ?? (type === 'file-refused' || type === 'file-offer' ? 'peer' : 'none');
        parts.push(`by ${by}`);
        if (Number.isFinite(data.size)) parts.push(`size ${data.size}`);
        if (typeof data.reason === 'string') parts.push(`reason ${JSON.stringify(data.reason)}`);
    }
    writeLog('EVENT', parts.join(' '));
}

// One log line for each file action of the user. A Cancel before the transfer starts gives no node event.
function logAction(action, offerId) {
    writeLog('EVENT', `action ${action} offer ${offerId}`);
}

// Test option: --downloads <dir> sets the folder for received files.
let downloadDir = null;
const downloadsIndex = process.argv.indexOf('--downloads');
if (downloadsIndex !== -1 && process.argv[downloadsIndex + 1]) {
    downloadDir = path.resolve(process.argv[downloadsIndex + 1]);
    mkdirSync(downloadDir, { recursive: true });
}

// Test options for the check scripts: --port <n>, --full-node <auto|on|off>, --allow-private-full-node, --relay-only.
// With no flag, the node defaults do not change.
const nodeFlags = {};
const portIndex = process.argv.indexOf('--port');
if (portIndex !== -1 && process.argv[portIndex + 1]) nodeFlags.port = Number(process.argv[portIndex + 1]);
const fullNodeIndex = process.argv.indexOf('--full-node');
if (fullNodeIndex !== -1 && process.argv[fullNodeIndex + 1]) {
    const value = process.argv[fullNodeIndex + 1];
    nodeFlags.fullNode = value === 'on' ? true : value === 'off' ? false : 'auto';
}
if (process.argv.includes('--allow-private-full-node')) nodeFlags.allowPrivateFullNode = true;
if (process.argv.includes('--relay-only')) nodeFlags.relayOnly = true;

// "<IPv4>:<port>" gives { ip, port }. Throws for a bad value.
function parsePublicAddress(text) {
    const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\s*$/.exec(String(text));
    const port = m ? Number(m[2]) : NaN;
    if (!m || m[1].split('.').some(o => Number(o) > 255) || !(port >= 1 && port <= 65535)) {
        throw new Error('The public address must be <IPv4>:<port>');
    }
    return { ip: m[1], port };
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
        // The middle sky blue of styles.css: no white flash before the page shows.
        backgroundColor: '#2a8fec',
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

// The public address that this profile used to host a room (file rooms/<tag>.host.json in the profile).
function readHostAddress(file) {
    try {
        const value = JSON.parse(readFileSync(file, 'utf8'))?.publicAddress;
        return typeof value === 'string' ? value.trim() : '';
    } catch {
        return '';
    }
}
function saveHostAddress(file, address) {
    try {
        writeFileSync(file, JSON.stringify({ publicAddress: address }));
    } catch (err) {
        writeLog('WARN', `Public address not saved to ${file}: ${err?.message ?? err}`);
    }
}

ipcMain.handle('asscrack:login', async (_event, { name, room, invite, internet, publicAddress } = {}) => {
    if (loginStarted) throw new Error('Already logged in');
    loginStarted = true;
    let joinedRoom = room;
    try {
        const options = { name, room, downloadDir: downloadDir ?? app.getPath('downloads'), ...nodeFlags };
        if (typeof invite === 'string' && invite.trim() !== '') {
            const code = readInvite(invite);
            options.room = code.room;
            joinedRoom = code.room;
            options.roomKey = code.key;
            options.inviteNodes = code.nodes;
        } else if (internet === true) {
            options.roomKey = newRoomKey();
        }
        let hostFile = null;
        if (options.roomKey) {
            const dir = path.join(app.getPath('userData'), 'rooms');
            mkdirSync(dir, { recursive: true });
            const tag = keyedServiceTag(options.room, options.roomKey);
            options.storePath = path.join(dir, `${tag}.json`);
            hostFile = path.join(dir, `${tag}.host.json`);
        }
        // A host that rejoins its room with an empty Public address field uses the saved address again.
        let address = publicAddress === undefined || publicAddress === null ? '' : String(publicAddress).trim();
        if (address === '' && hostFile) {
            address = readHostAddress(hostFile);
            if (address !== '') writeLog('INFO', `Saved public address ${address} used for this room`);
        }
        if (address !== '') {
            const { ip, port } = parsePublicAddress(address);
            options.announce = [`/ip4/${ip}/tcp/${port}`];
            options.port = port;
            if (hostFile) saveHostAddress(hostFile, address);
        }
        node = await createAsscrackNode(options);
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
    // The node dials the invite nodes at start and again with the redial timer (option inviteNodes).
    return { peerId: node.peerId, room: joinedRoom, internet: node.roomKey() !== null };
});

ipcMain.handle('asscrack:invite', () => {
    if (!node) throw new Error('Not logged in');
    if (node.roomKey() === null) return { code: null, reason: 'lan' };
    const code = node.invite();
    return code ? { code } : { code: null, reason: 'no-full-node' };
});

ipcMain.handle('asscrack:full-node', () => {
    if (!node) throw new Error('Not logged in');
    return { self: node.fullNode(), peers: node.fullNodes() };
});

ipcMain.handle('asscrack:send', (_event, text) => {
    if (!node) throw new Error('Not logged in');
    return node.send(text);
});

ipcMain.handle('asscrack:signal', (_event, { peerId, data } = {}) => {
    if (!node) throw new Error('Not logged in');
    return node.sendTo(peerId, { type: 'signal', data });
});

// One Opus frame of the own microphone. An ipc send, not invoke: 50 frames each second.
ipcMain.on('asscrack:voice-frame', (_event, bytes) => {
    if (!node || !(bytes instanceof Uint8Array)) return;
    try {
        node.sendVoiceFrame(bytes);
    } catch (err) {
        writeLog('WARN', `Voice frame send failed: ${err?.message ?? err}`);
    }
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
    const result = node.offerFile(filePath);
    Promise.resolve(result).then(offer => logAction('offer-file', offer?.offerId ?? ''), () => {});
    return result;
});

ipcMain.handle('asscrack:accept-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    logAction('accept-file', String(offerId));
    return node.acceptFile(String(offerId));
});

ipcMain.handle('asscrack:refuse-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    logAction('refuse-file', String(offerId));
    return node.refuseFile(String(offerId));
});

ipcMain.handle('asscrack:cancel-file', (_event, offerId, peerId) => {
    if (!node) throw new Error('Not logged in');
    if (peerId !== undefined && peerId !== null && (typeof peerId !== 'string' || peerId.length > 128)) {
        throw new Error('Invalid peer ID');
    }
    const peer = typeof peerId === 'string' ? peerId : undefined;
    logAction('cancel-file', peer === undefined ? String(offerId) : `${offerId} peer ${peer}`);
    return node.cancelFile(String(offerId), peer);
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
