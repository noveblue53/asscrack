import { app, BrowserWindow, Menu, Notification, nativeImage, protocol, Tray, screen, powerMonitor, clipboard, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { createRoomMedia } from './room-media.mjs';
import { createClipboardStaging } from './clipboard-image.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import path from 'path';
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs';
import { format } from 'util';
import { createAsscrackNode, keyedServiceTag } from '../network/node.mjs';
import { newRoomKey, readInvite } from '../network/invite.mjs';
import { installUpnpGuard } from '../network/upnp-guard.mjs';
import { observeRoomActivity } from './room-activity.mjs';
// Saved rooms (milestone 6).
import { createSavedRooms, makeProtector } from './saved-rooms.mjs';
import * as voiceSettings from './voice-settings.mjs';
import { attentionSettings, createAttention, registerNotificationShortcut, WINDOWS_APP_ID, WINDOWS_TOAST_ID } from './attention.mjs';
import { createPttHook } from './ptt-hook.mjs';
import { createWindowFrame } from './window-frame.mjs';
import { attachVoiceMonitor } from './voice-monitor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

Menu.setApplicationMenu(null);
protocol.registerSchemesAsPrivileged([{ scheme: 'room-media', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true
} }]);
if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_ID);
    app.setToastActivatorCLSID(WINDOWS_TOAST_ID);
}

const EVENTS = ['channels', 'peer-discovered', 'peer-joined', 'peer-left', 'message', 'history', 'signal', 'voice-state', 'host-changed', 'peer-name',
    'file-offer', 'file-retried', 'file-progress', 'file-done', 'file-failed', 'file-refused', 'file-cancelled', 'topology', 'full-node', 'full-node-addrs',
    'voice-frame', 'connection', 'dial-failed', 'upnp', 'presence', 'topic'];

// Test option: --profile <dir> gives each instance its own user data folder.
const profileIndex = process.argv.indexOf('--profile');
if (profileIndex !== -1 && process.argv[profileIndex + 1]) {
    app.setPath('userData', path.resolve(process.argv[profileIndex + 1]));
}

// Single instance lock (F1, goal 7): only for the packaged build with the default user data folder. Electron keys the
// lock on the user data folder. The check scripts start 2 or more copies with --profile, and npm start has no lock.
// A second start of the same copy shows the window of the first copy and exits.
const singleInstance = app.isPackaged && profileIndex === -1;
const isFirstInstance = !singleInstance || app.requestSingleInstanceLock();
if (!isFirstInstance) {
    app.exit(0);
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

// The UPnP router HTTP error guard (src/network/upnp-guard.mjs). Each uncaughtException listener turns off the
// default handler of Electron, which shows the dialog "A JavaScript error occurred in the main process" only when it
// is the single listener (Electron 40.5.0, lib/browser/init.ts). The process does not exit. onOther keeps this
// behavior for each other error, and also writes the error to the log.
installUpnpGuard({
    onOther: err => {
        const stack = err?.stack ? err.stack : `${err?.name}: ${err?.message}`;
        console.error('Uncaught exception in the main process:', stack);
        try {
            dialog.showErrorBox('A JavaScript error occurred in the main process', `Uncaught Exception:\n${stack}`);
        } catch {
            // Before app ready the dialog can fail. The log line stays.
        }
    }
});

// One log line for each node event. The chat text does not go into the log.
// 'voice-frame' comes 50 times each second for each speaker.
const UNLOGGED_EVENTS = new Set(['signal', 'file-progress', 'voice-frame']);

function logEvent(type, data) {
    if (UNLOGGED_EVENTS.has(type)) return;
    const parts = [`event ${type}`];
    if (type === 'connection' || type === 'dial-failed' || type === 'upnp') {
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
        if (data.retryOf) parts.push(`retry-of ${data.retryOf}`);
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
        callback(!idlePeer && permission === 'media' && isAppPage(url));
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
        const url = details?.requestingUrl ?? requestingOrigin;
        return !idlePeer && permission === 'media' && isAppPage(url);
    });
}

let mainWindow = null;
let voiceMonitor = null;
let node = null;
let readRoomActivity = () => [];
// The files that this computer received: `${offerId}|${peerId}` -> the final path (after a rename for a name
// collision). Only a file-done event with the direction receive adds a path. The window sends only the key.
const clipboardImages = createClipboardStaging(app.getPath('temp'));
const receivedFiles = new Map();
const restoringDownloads = new Map();
const roomMedia = createRoomMedia({ nativeImage, changed: id => sendToWindow('asscrack:media-changed', id) });
let mediaGeneration = 0;
function clearRoomMedia() { mediaGeneration++; roomMedia.clear(); }
function savedDownload(messageId, descriptorId) {
    if (typeof messageId !== 'string' || !messageId || messageId.length > 128 ||
        typeof descriptorId !== 'string' || descriptorId.length !== 36) return null;
    return savedRooms?.getDownload(messageId, descriptorId);
}

ipcMain.handle('asscrack:saved-original-available', async (_event, messageId, descriptorId) => {
    const download = savedDownload(messageId, descriptorId);
    if (!download) return false;
    const key = JSON.stringify([messageId, descriptorId]);
    let pending = restoringDownloads.get(key);
    if (!pending) {
        const allowed = () => savedDownload(messageId, descriptorId)?.path === download.path;
        pending = roomMedia.restore(download.descriptor, download.path, allowed)
            .finally(() => restoringDownloads.delete(key));
        restoringDownloads.set(key, pending);
    }
    return pending;
});
ipcMain.handle('asscrack:reveal-saved-original', async (_event, messageId, descriptorId) => {
    const download = savedDownload(messageId, descriptorId);
    if (!download || !await roomMedia.canReveal(download.descriptor, download.path) ||
        savedDownload(messageId, descriptorId)?.path !== download.path) return { ok: false };
    shell.showItemInFolder(download.path);
    return { ok: true };
});
ipcMain.handle('asscrack:media-clear-previews', () => { mediaGeneration++; roomMedia.clearPreviews(); });
ipcMain.handle('asscrack:media-info', (_event, ref) => node ? roomMedia.info(ref) : {});
ipcMain.handle('asscrack:media-preview', async (_event, id) => {
    if (!node?.attachmentDescriptor(id)) return {};
    const version = mediaGeneration;
    if (!roomMedia.info(id).thumbnailUrl) {
        const result = await node.requestPreviewById(id);
        if (version !== mediaGeneration) return {};
        if (result) roomMedia.storePreview(result.descriptor, result.bytes);
    }
    return roomMedia.info(id);
});
const MAX_RECEIVED_KEY = 300;
let loginStarted = false;
let stopping = false;

function sendToWindow(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

// Participation belongs to the room. Minimizing the window leaves voice and capture alone.
let idlePeer = false;
let tray = null;
let quitting = false;
const closePreference = path.join(app.getPath('userData'), 'close-to-idle.json');
let closeToTray = true;
try { closeToTray = JSON.parse(readFileSync(closePreference, 'utf8')) !== false; } catch { /* new profile */ }
const idleState = () => ({ idle: idlePeer, closeToTray });

const attentionPrefs = attentionSettings(path.join(app.getPath('userData'), 'attention.json'));
const attention = createAttention({
    settings: attentionPrefs.get,
    room: () => node,
    quiet: () => quitting || stopping || idlePeer || node?.presence().state === 'dnd',
    allowed: target => target.kind === 'whisper'
        ? node?.whisperPeers().includes(target.peerId)
        : target.channelId === 'general' || node?.channels().channels.some(channel => channel.id === target.channelId),
    notify: options => new Notification(options),
    navigate: target => {
        restoreRoomWindow();
        sendToWindow('asscrack:attention-open', target);
    }
});

function registerAlerts() {
    if (!Notification.isSupported()) throw new Error('Desktop notifications are unavailable on this system.');
    if (process.platform === 'win32' && app.isPackaged) {
        registerNotificationShortcut({
            appData: app.getPath('appData'),
            executable: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, shell
        });
    }
}

ipcMain.handle('asscrack:attention-settings', () => attentionPrefs.get());
ipcMain.handle('asscrack:attention-set', (_event, patch) => {
    if (patch?.alerts === true) registerAlerts();
    const next = attentionPrefs.set(patch);
    if (patch?.alerts === false || patch?.previews !== undefined || patch?.sound !== undefined) attention.clear();
    return next;
});
ipcMain.on('asscrack:attention-add', (_event, target) => attention.add(target));
ipcMain.on('asscrack:attention-read', (_event, target) => attention.read(target));

function restoreRoomWindow() {
    if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
    if (idlePeer) {
        idlePeer = false;
        node?.setIdle(false);
        sendToWindow('asscrack:idle-peer', idleState());
        node?.refreshRoutes();
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function enterIdlePeer() {
    if (!node || !mainWindow || mainWindow.isDestroyed() || quitting) return false;
    if (!tray) {
        try {
            tray = new Tray(path.join(__dirname, 'img', 'tray.png'));
            tray.setToolTip('Asscrack');
            tray.setContextMenu(Menu.buildFromTemplate([
                { label: 'Open Asscrack', click: restoreRoomWindow },
                { label: 'Quit Asscrack', click: () => app.quit() }
            ]));
            tray.on('click', restoreRoomWindow);
        } catch (err) {
            tray?.destroy();
            tray = null;
            writeLog('WARN', 'Cannot open the tray: ' + (err?.message ?? err));
            return false;
        }
    }
    if (!idlePeer) {
        idlePeer = true;
        voiceMonitor?.dismiss();
        attention.clear();
        node.setIdle(true);
        updatePttHook(() => pttHook.setInVoice(false));
        sendToWindow('asscrack:idle-peer', idleState());
    }
    mainWindow.hide();
    return true;
}

ipcMain.handle('asscrack:idle-peer', idleState);
ipcMain.handle('asscrack:enter-idle-peer', enterIdlePeer);
ipcMain.handle('asscrack:close-to-tray', (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected a close preference');
    writeFileSync(closePreference + '.tmp', JSON.stringify(enabled));
    renameSync(closePreference + '.tmp', closePreference);
    closeToTray = enabled;
    sendToWindow('asscrack:idle-peer', idleState());
    return idleState();
});
ipcMain.on('asscrack:quit', () => app.quit());

function createMainWindow() {
    const frame = createWindowFrame(app.getPath('userData'));
    mainWindow = new BrowserWindow({
        ...frame.options,
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

    frame.attach(mainWindow, ipcMain);
    voiceMonitor = attachVoiceMonitor({
        room: mainWindow, ipc: ipcMain, BrowserWindow, screen, profile: app.getPath('userData'), assets: __dirname,
        participating: () => !!node && !idlePeer && !quitting && !mainWindow.isDestroyed(),
        restoreRoom: restoreRoomWindow, warn: message => writeLog('WARN', message)
    });
    const startUrl = new URL(`file://${path.join(__dirname, 'index.html')}`).href;

    mainWindow.webContents.on('console-message', details => {
        writeLog('WINDOW', `${details.level} ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });

    mainWindow.on('close', event => {
        if (!quitting && closeToTray && enterIdlePeer()) event.preventDefault();
    });
    // Windows shutdown may bypass before-quit. Do not hide or veto session termination.
    mainWindow.on('session-end', () => { quitting = true; });

    mainWindow.loadURL(startUrl);

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
}

// The host data of this profile for a room (file rooms/<tag>.host.json in the profile):
// publicAddress (the typed public address) and upnpPort (the port of the last UPnP mapping).
function readHostFile(file) {
    try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        return value !== null && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}
function readHostAddress(file) {
    const value = readHostFile(file).publicAddress;
    return typeof value === 'string' ? value.trim() : '';
}
function readUpnpPort(file) {
    const value = readHostFile(file).upnpPort;
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}
function saveHostFields(file, fields) {
    try {
        writeFileSync(file, JSON.stringify({ ...readHostFile(file), ...fields }));
    } catch (err) {
        writeLog('WARN', `Host data not saved to ${file}: ${err?.message ?? err}`);
    }
}
// True when the error, its cause or one of its errors has the code EADDRINUSE.
function isAddressInUse(err, depth = 0) {
    if (!err || typeof err !== 'object' || depth > 4) return false;
    if (err.code === 'EADDRINUSE') return true;
    if (isAddressInUse(err.cause, depth + 1)) return true;
    return Array.isArray(err.errors) && err.errors.some(e => isAddressInUse(e, depth + 1));
}
function saveHostAddress(file, address) {
    saveHostFields(file, { publicAddress: address });
}

// Start the node of a room. options: the node options (name, room, and for a keyed room roomKey and inviteNodes).
// The login handler and the reopen of a saved room use this function. Returns the login result.
async function startRoom(options, publicAddress) {
    if (loginStarted) throw new Error('Already logged in');
    loginStarted = true;
    try {
        let hostFile = null;
        if (options.roomKey) {
            const dir = path.join(app.getPath('userData'), 'rooms');
            mkdirSync(dir, { recursive: true });
            const tag = keyedServiceTag(options.room, options.roomKey);
            options.storePath = path.join(dir, `${tag}.json`);
            hostFile = path.join(dir, `${tag}.host.json`);
            options.seedChannels = getSavedRooms().loadChannels(options.room, options.roomKey);
            options.seedHistory = removeHistory => getSavedRooms().prepareReplay(options.room, options.roomKey, removeHistory);
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
        } else if (hostFile) {
            // A keyed room with no typed or saved address: try UPnP. Rejoin (decision 56): use the port of the last
            // mapping again, so that old invite codes stay valid. The IP comes again from the router at each start.
            options.upnp = true;
            const savedPort = readUpnpPort(hostFile);
            if (savedPort !== null && options.port === undefined) {
                options.port = savedPort;
                options.savedUpnpPort = true;
                writeLog('INFO', `Saved UPnP port ${savedPort} used for this room`);
            }
        }
        options.previewProvider = (descriptor, filePath) => roomMedia.makePreview(filePath, descriptor);
        options.receiveWhisper = message => {
            if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isCrashed()) return false;
            sendToWindow('asscrack:whisper', message);
            return true;
        };
        const fromSavedUpnpPort = options.savedUpnpPort === true;
        delete options.savedUpnpPort;
        try {
            node = await createAsscrackNode(options);
        } catch (err) {
            // The saved UPnP port can be in use by another program: try one time again with a new port.
            // A typed or saved public address keeps today's behavior (no retry).
            if (!fromSavedUpnpPort || !isAddressInUse(err)) throw err;
            writeLog('WARN', `Saved UPnP port ${options.port} is in use (EADDRINUSE). Start again with port 0`);
            options.port = 0;
            node = await createAsscrackNode(options);
        }
        if (options.upnp && hostFile) {
            const file = hostFile;
            node.events.on('upnp', data => {
                if (data?.state === 'mapped' && Number.isInteger(data.port)) saveHostFields(file, { upnpPort: data.port });
            });
        }
    } catch (err) {
        savedRooms?.releaseReplay();
        loginStarted = false;
        throw err;
    }
    // Record the path before the window gets the event, so that a Show in Explorer at once finds it.
    node.events.on('attachment-status', data => sendToWindow('asscrack:attachment-status', data));
    node.events.on('shelf', data => sendToWindow('asscrack:shelf', data));
    node.events.on('shelf-offered', data => sendToWindow('asscrack:shelf-offered', data));
    node.events.on('file-done', data => {
        if (data?.direction !== 'receive' || typeof data.path !== 'string') return;
        receivedFiles.set(`${data.offerId}|${data.peerId}`, data.path);
        const descriptor = node.attachmentDescriptor(data.attachmentId);
        if (descriptor && descriptor.source === data.peerId && descriptor.sha256 === data.sha256 && descriptor.size === data.size) {
            getSavedRooms().rememberDownload(descriptor, data.path);
            Promise.resolve(roomMedia.verified(descriptor, data.path)).catch(err => writeLog('WARN', `Verified file preview unavailable: ${err.message}`));
        }
    });
    // Saved rooms (milestone 6): the archive listener comes before the window listener.
    getSavedRooms().attachNode(node);
    readRoomActivity = observeRoomActivity(node);
    // Typing goes straight to the window; transient controls never enter diagnostics or the archive.
    node.events.on('whisper-capability', data => sendToWindow('asscrack:whisper-capability', data));
    node.events.on('typing', data => sendToWindow('asscrack:typing', data));
    for (const type of EVENTS) {
        node.events.on(type, data => {
            if (type === 'channels') savedRooms?.persistChannels(data.added);
            logEvent(type, data);
            // The diagnostic window reads a redacted projection of these local events.
            if (type === 'connection' || type === 'dial-failed' || (idlePeer && type === 'voice-frame')) return;
            const shelfId = type === 'file-offer' ? node.shelfTransfer(data.peerId, data.offerId) : undefined;
            sendToWindow(`asscrack:${type}`, shelfId ? { ...data, shelfId } : data);
        });
    }
    // The node dials the invite nodes at start and again with the redial timer (option inviteNodes).
    return { peerId: node.peerId, room: options.room, internet: node.roomKey() !== null };
}

// Saved rooms (milestone 6). The archive opens at the first saved-rooms call or login, after app ready.
let savedRooms = null;
function getSavedRooms() {
    if (!savedRooms) {
        savedRooms = createSavedRooms({
            dir: path.join(app.getPath('userData'), 'saved-rooms'),
            protector: makeProtector(safeStorage),
            log: writeLog,
            backend: process.platform === 'linux' ? () => safeStorage.getSelectedStorageBackend() : null,
            // Saved rooms (milestone 6): the result of each archive write goes to the window. Only the ID and the reason.
            notify: (type, data) => {
                if (type === 'line-saved') sendToWindow('asscrack:line-saved', { id: String(data?.id ?? '') });
                else if (type === 'save-failed') {
                    sendToWindow('asscrack:save-failed', { id: String(data?.id ?? ''), reason: String(data?.reason ?? 'unknown') });
                }
            },
            forgetHints
        });
    }
    return savedRooms;
}

// Saved rooms (milestone 6). Forget deletes the room hint files userData/rooms/<tag>.json and <tag>.host.json.
function forgetHints(row) {
    if (!row?.name || !row?.roomKey) return;
    const dir = path.join(app.getPath('userData'), 'rooms');
    const tag = keyedServiceTag(row.name, row.roomKey);
    for (const file of [`${tag}.json`, `${tag}.host.json`]) {
        rmSync(path.join(dir, file), { force: true });
    }
}

// Saved rooms (milestone 6). The check of a roomId from the window.
function validRoomId(roomId) {
    return typeof roomId === 'string' && roomId.length > 0 && roomId.length <= 128;
}

// Saved rooms (milestone 6). Save the keyed room and mark the active room. A save failure does not stop the login.
function afterRoomStart(result, { invite = null, userName, save = false, keepHistory = true }) {
    const roomKey = node?.roomKey() ?? null;
    let saveInfo = { roomId: null, saved: false, saveError: null, savedRoom: false, keepHistory: null };
    try {
        saveInfo = getSavedRooms().afterLogin({ room: result.room, roomKey, invite, userName, save: save === true, keepHistory });
    } catch (err) {
        writeLog('WARN', `Saved rooms: ${err?.message ?? err}`);
        if (save === true) saveInfo.saveError = String(err?.message ?? err);
    }
    getSavedRooms().persistChannels(node.channels().channels);
    return { ...result, ...saveInfo };
}

ipcMain.handle('asscrack:login', async (_event, { name, room, invite, internet, publicAddress, save, keepHistory } = {}) => {
    if (loginStarted) throw new Error('Already logged in');
    const options = { name, room, downloadDir: downloadDir ?? app.getPath('downloads'), ...nodeFlags };
    let typedInvite = null;
    if (typeof invite === 'string' && invite.trim() !== '') {
        const code = readInvite(invite);
        options.room = code.room;
        options.roomKey = code.key;
        options.inviteNodes = code.nodes;
        typedInvite = invite.trim();
    } else if (internet === true) {
        options.roomKey = newRoomKey();
    }
    const result = await startRoom(options, publicAddress);
    return afterRoomStart(result, { invite: typedInvite, userName: name, save, keepHistory: keepHistory !== false });
});

// Saved rooms (milestone 6). The window gets no key, no invite and no file path.
ipcMain.handle('asscrack:saved-rooms', () => getSavedRooms().status());

ipcMain.handle('asscrack:unlock-archive', () => getSavedRooms().unlock());

ipcMain.handle('asscrack:saved-room-lines', (_event, roomId, opts) => {
    if (!validRoomId(roomId)) return [];
    // Paging: before is { time, id } of the first shown line, or null.
    let before = null;
    const b = opts?.before;
    if (b && Number.isFinite(Number(b.time)) && typeof b.id === 'string' && b.id.length <= 256) {
        before = { time: Number(b.time), id: b.id };
    }
    try {
        const channelId = typeof opts?.channelId === 'string' ? opts.channelId : 'general';
        return getSavedRooms().lines(roomId, { before, limit: before ? 100 : 200, channelId });
    } catch (err) {
        writeLog('WARN', `Saved lines not read: ${err?.message ?? err}`);
        throw new Error('Could not read this page from the saved room.');
    }
});

ipcMain.handle('asscrack:reopen-room', async (_event, roomId) => {
    if (loginStarted) throw new Error('Already logged in');
    if (typeof roomId !== 'string' || roomId.length > 128) throw new Error('Saved room not found');
    const row = getSavedRooms().getRoom(roomId);
    if (!row) throw new Error('Saved room not found');
    const options = {
        name: row.userName ?? '', room: row.name, roomKey: row.roomKey,
        downloadDir: downloadDir ?? app.getPath('downloads'), ...nodeFlags
    };
    if (row.invite) {
        try {
            options.inviteNodes = readInvite(row.invite).nodes;
        } catch (err) {
            writeLog('WARN', `Saved invite not read: ${err?.message ?? err}`);
        }
    }
    writeLog('INFO', 'Reopen of a saved room');
    const result = await startRoom(options, null);
    return afterRoomStart(result, { invite: row.invite, userName: row.userName, save: false, keepHistory: row.keepHistory });
});

// Saved rooms (milestone 6): the room storage controls and Forget.
ipcMain.handle('asscrack:set-keep-history', (_event, roomId, on) => {
    if (!validRoomId(roomId)) throw new Error('Saved room not found');
    return getSavedRooms().setKeepHistory(roomId, on === true);
});

ipcMain.handle('asscrack:clear-history', (_event, roomId) => {
    if (!validRoomId(roomId)) throw new Error('Saved room not found');
    const result = getSavedRooms().clear(roomId);
    writeLog('INFO', `Saved history cleared (${result?.cleared ?? 0} rows)`);
    return result;
});

ipcMain.handle('asscrack:forget-room', (_event, roomId) => {
    if (!validRoomId(roomId)) throw new Error('Saved room not found');
    const active = getSavedRooms().activeInfo()?.roomId === roomId;
    const result = getSavedRooms().forget(roomId);
    if (active) clearRoomMedia();
    writeLog('INFO', 'Saved room forgotten');
    return result;
});

ipcMain.handle('asscrack:invite', () => {
    if (!node) throw new Error('Not logged in');
    if (node.roomKey() === null) return { code: null, reason: 'lan' };
    const code = node.invite();
    if (code) return { code };
    // While the router can still open a port, the window tells the user to wait (not that a full node is missing).
    return { code: null, reason: node.upnpPending() ? 'upnp-wait' : 'no-full-node' };
});

// The window has no clipboard permission (setPermissions allows only the microphone). The main process copies.
ipcMain.handle('asscrack:room-activity', (_event, peerId, transfersOnly) => {
    if (peerId != null && (typeof peerId !== 'string' || !peerId || peerId.length > 128)) return [];
    return readRoomActivity({ peerId: peerId ?? null, transfersOnly: transfersOnly === true });
});
ipcMain.handle('asscrack:copy-text', (_event, text) => {
    if (typeof text !== 'string' || text.length > 10000) throw new Error('Text not copied');
    clipboard.writeText(text);
});

ipcMain.handle('asscrack:full-node', () => {
    if (!node) throw new Error('Not logged in');
    return { self: node.fullNode(), peers: node.fullNodes() };
});

ipcMain.handle('asscrack:whisper-peers', () => node?.whisperPeers() ?? []);
ipcMain.handle('asscrack:whisper-send', (_event, peerId, text, id) => node?.sendWhisper(peerId, text, id) ?? 'unavailable');

ipcMain.handle('asscrack:channels', () => node?.channels());
ipcMain.handle('asscrack:create-channel', (_event, name) => node.createChannel(name));
ipcMain.handle('asscrack:send', (_event, text, channelId) => {
    if (!node) throw new Error('Not logged in');
    // Saved rooms (milestone 6): the window gets the record. An archive error does not stop the send.
    const record = node.sendRecord(text, channelId);
    return archiveSend(record);
});

function archiveSend(record) {
    let save = { saved: false, saveError: null };
    try {
        const result = savedRooms?.recordSend(record);
        if (result) save = { saved: result.saved === true, saveError: result.saveError ?? null };
    } catch (err) {
        writeLog('WARN', `Saved line not written: ${err?.message ?? err}`);
        save = { saved: false, saveError: String(err?.message ?? err) };
    }
    return { ...record, ...save };
}

ipcMain.handle('asscrack:signal', (_event, { peerId, data } = {}) => {
    if (!node) throw new Error('Not logged in');
    return node.sendTo(peerId, { type: 'signal', data });
});

// One Opus frame of the own microphone. An ipc send, not invoke: 50 frames each second.
ipcMain.on('asscrack:voice-frame', (_event, bytes) => {
    if (!node || idlePeer || !(bytes instanceof Uint8Array)) return;
    try {
        node.sendVoiceFrame(bytes);
    } catch (err) {
        writeLog('WARN', `Voice frame send failed: ${err?.message ?? err}`);
    }
});

ipcMain.handle('asscrack:set-voice', (_event, state) => {
    if (!node) throw new Error('Not logged in');
    if (idlePeer && state?.inVoice === true) throw new Error('Idle Peer has left voice');
    node.setVoice(state ?? {});
    updatePttHook(() => pttHook.setInVoice(state?.inVoice === true));
});

// The voice settings of this profile (voice-settings.mjs checks each value). The file is read one time.
let voiceSettingsValue = null;
function voiceSettingsFile() {
    return path.join(app.getPath('userData'), voiceSettings.VOICE_SETTINGS_FILE);
}
function currentVoiceSettings() {
    if (!voiceSettingsValue) voiceSettingsValue = voiceSettings.load(voiceSettingsFile());
    return voiceSettingsValue;
}
// Push to talk while the window is not in front (ptt-hook.mjs). The native module loads at the first start.
const pttHook = createPttHook({
    loadModule: () => require('uiohook-napi'),
    send: down => sendToWindow('asscrack:ptt', { down }),
    log: writeLog
});
let pttStatus = 'off';
function updatePttHook(change) {
    change();
    const next = pttHook.status();
    if (next === pttStatus) return;
    pttStatus = next;
    sendToWindow('asscrack:ptt-status', { status: next });
}
ipcMain.handle('asscrack:ptt-status', () => pttHook.status());

// RNNoise (@sapphi-red/web-noise-suppressor): the window gets the worklet URL and the WASM bytes from here.
// The window cannot fetch file: URLs, and the main process reads only these two fixed files of the package.
ipcMain.handle('asscrack:rnnoise', (_event, simd) => {
    const wasm = require.resolve(`@sapphi-red/web-noise-suppressor/${simd === true ? 'rnnoise_simd.wasm' : 'rnnoise.wasm'}`);
    const worklet = require.resolve('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js');
    return { workletUrl: pathToFileURL(worklet).href, wasm: readFileSync(wasm) };
});

ipcMain.handle('asscrack:voice-settings', () => currentVoiceSettings());
ipcMain.handle('asscrack:set-voice-settings', (_event, patch) => {
    const next = voiceSettings.merge(currentVoiceSettings(), patch);
    voiceSettingsValue = next;
    updatePttHook(() => pttHook.configure(next));
    try {
        voiceSettings.save(voiceSettingsFile(), next);
    } catch (err) {
        writeLog('WARN', `Voice settings not saved: ${err?.message ?? err}`);
    }
    // No device IDs in the log: only the fields that a field test needs.
    writeLog('EVENT', `voice settings mode ${next.mode} threshold ${next.vadThresholdDb} vad-release ${next.vadReleaseMs} `
        + `ptt-key ${next.pttKey ?? 'none'} ptt-release ${next.pttReleaseMs} ptt-global ${next.pttGlobal} ec ${next.echoCancellation} `
        + `ns ${next.noiseSuppression} agc ${next.autoGainControl} input ${next.inputDeviceId ? 'selected' : 'default'} `
        + `output ${next.outputDeviceId ? 'selected' : 'default'}`);
    return next;
});

ipcMain.handle('asscrack:topic', () => node?.topic() ?? null);

ipcMain.handle('asscrack:set-topic', (_event, text) => {
    if (!node) throw new Error('Not logged in');
    node.setTopic(text);
});

ipcMain.handle('asscrack:host', () => {
    if (!node) throw new Error('Not logged in');
    return { host: node.host() ?? null, self: node.peerId };
});

// Manual status (milestone 3). state: 'available', 'away' or 'dnd'. The node cuts the note to 80 code points.
// Store only the preference in the profile. A corrupt or inaccessible setting keeps sharing off.
const typingPreference = path.join(app.getPath('userData'), 'share-typing.json');
let shareTyping;
try {
    shareTyping = JSON.parse(readFileSync(typingPreference, 'utf8')) === true;
} catch (err) {
    shareTyping = err.code === 'ENOENT';
}
ipcMain.handle('asscrack:get-share-typing', () => shareTyping);
ipcMain.handle('asscrack:set-share-typing', (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected a sharing preference');
    if (!enabled) node?.setTyping(false);
    // Apply an opt-out immediately even if persistence fails.
    if (!enabled) shareTyping = false;
    writeFileSync(typingPreference + '.tmp', JSON.stringify(enabled));
    renameSync(typingPreference + '.tmp', typingPreference);
    shareTyping = enabled;
    return shareTyping;
});
ipcMain.on('asscrack:typing-edit', (_event, active) => {
    if (!idlePeer && shareTyping && typeof active === 'boolean') node?.setTyping(active);
});

ipcMain.handle('asscrack:set-presence', (_event, { state, note } = {}) => {
    if (!node) throw new Error('Not logged in');
    const updated = node.setPresence({ state, note });
    if (node.presence().state === 'dnd') attention.clear();
    return updated;
});

ipcMain.handle('asscrack:presence', () => {
    return node ? { self: node.presence(), peers: node.peerPresence() } : null;
});

ipcMain.handle('asscrack:topology', () => {
    return node ? node.topology() : null;
});

ipcMain.handle('asscrack:refresh-shelf', () => node?.refreshShelf());
ipcMain.handle('asscrack:share-file', (_event, filePath) => {
    if (!node || typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Choose a local file to share');
    return node.publishShelfFile(filePath);
});
ipcMain.handle('asscrack:remove-shared-file', (_event, id) => node?.removeShelfFile(id) === true);
ipcMain.handle('asscrack:download-shared-file', (_event, peerId, id) => node?.downloadShelfFile(peerId, id) === true);

ipcMain.handle('asscrack:offer-file', (_event, filePath, recipientId) => {
    if (!node) throw new Error('Not logged in');
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('The file path is not an absolute path');
    const result = node.offerFile(filePath, recipientId);
    Promise.resolve(result).then(offer => logAction('offer-file', offer?.offerId ?? ''), () => {});
    return result;
});

// Clipboard IPC accepts bounded PNG bytes only. Path-backed originals use Electron's native File path.
ipcMain.handle('asscrack:post-media', async (_event, input, caption, channelId, recipientId) => {
    if (!node) throw new Error('Not logged in');
    const staged = input instanceof Uint8Array;
    const filePath = staged ? clipboardImages.stage(input) : input;
    try {
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('A local file is required');
        if (recipientId !== undefined) {
            const offer = await node.offerFile(filePath, recipientId);
            return { offer };
        }
        const { message, offer } = await node.postAttachment(filePath, caption, channelId);
        if (offer.peers) {
            if (staged) clipboardImages.retain(filePath, message.attachment.expires);
            Promise.resolve(roomMedia.verified(message.attachment, filePath)).catch(err => writeLog('WARN', `Original preview unavailable: ${err.message}`));
        } else if (staged) clipboardImages.discard(filePath);
        return { message: archiveSend(message), offer };
    } catch (err) {
        if (staged) clipboardImages.discard(filePath);
        throw err;
    }
});

ipcMain.handle('asscrack:attachment-available', (_event, id) => node?.attachmentAvailable(id) === true);
ipcMain.handle('asscrack:request-original', (_event, id) => node?.requestOriginal(id) === true);

ipcMain.handle('asscrack:accept-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    logAction('accept-file', String(offerId));
    return node.acceptFile(String(offerId));
});

ipcMain.handle('asscrack:retry-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    logAction('retry-file', String(offerId));
    return node.retryFile(String(offerId));
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

// Show in Explorer for a received file. The window sends the key `${offerId}|${peerId}` only, never a path.
// Result: { ok: true }, or { ok: false, reason: 'unknown' } (no received file for the key) or
// { ok: false, reason: 'missing' } (the file was moved or deleted).
ipcMain.handle('asscrack:reveal-file', (_event, key) => {
    if (typeof key !== 'string' || key.length > MAX_RECEIVED_KEY || !receivedFiles.has(key)) {
        return { ok: false, reason: 'unknown' };
    }
    const filePath = receivedFiles.get(key);
    if (!existsSync(filePath)) {
        writeLog('EVENT', `action reveal-file key ${key} result missing`);
        return { ok: false, reason: 'missing' };
    }
    shell.showItemInFolder(filePath);
    writeLog('EVENT', `action reveal-file key ${key} result ok`);
    return { ok: true };
});

app.on('before-quit', event => {
    quitting = true;
    voiceMonitor?.dismiss();
    attention.clear();
    clearRoomMedia();
    tray?.destroy();
    tray = null;
    pttHook.stop();
    // Saved rooms (milestone 6): close the archive.
    if (savedRooms) {
        try { savedRooms.close(); } catch (err) { writeLog('WARN', `Saved rooms archive not closed: ${err?.message ?? err}`); }
    }
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
        clipboardImages.clear();
        node = null;
        app.exit(0);
    });
});

app.on('window-all-closed', () => app.quit());

if (singleInstance && isFirstInstance) {
    app.on('second-instance', restoreRoomWindow);
}

app.whenReady().then(() => {
    if (!isFirstInstance) return;
    powerMonitor.on('resume', () => node?.refreshRoutes());
    protocol.handle('room-media', request => roomMedia.serve(request));
    setPermissions();
    pttHook.configure(currentVoiceSettings());
    if (attentionPrefs.get().alerts && process.platform === 'win32' && app.isPackaged) {
        try { registerAlerts(); } catch { writeLog('WARN', 'Windows notification registration unavailable'); }
    }
    createMainWindow();
});
