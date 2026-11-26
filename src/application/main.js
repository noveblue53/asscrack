import { app, BrowserWindow, Menu, Notification, nativeImage, protocol, Tray, screen, powerMonitor, clipboard, crashReporter, desktopCapturer, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { createRoomMedia } from './room-media.mjs';
import { createRoomIpc } from './room-ipc.mjs';
import { createMapTraffic } from './map-traffic.mjs';
import { createImageDecoder } from './image-decoder.mjs';
import { createMusicEval } from './music-eval.mjs';
import { attachMusic } from './music-ipc.mjs';
import { MUSIC_PRIVILEGES, MUSIC_SCHEME } from './music-media.mjs';
import { MUSIC_SETTINGS_FILE } from './music-settings.mjs';
import { checkChosenFile, checkSaveTarget } from './file-choice.mjs';
import { saveVerifiedCopy } from './media-save.mjs';
import { sameAttachment } from '../network/attachment.mjs';
import { APP_PRIVILEGES, APP_SCHEME, appPage, createAppHandler } from './app-scheme.mjs';
import { createClipboardStaging } from './clipboard-image.mjs';
import { createDownloadScratch } from './download-scratch.mjs';
import { clearLegacyDebugLogs } from './local-debug.mjs';
import { createDiagnostics, interfaceSummary, logDeduper, logText } from './diagnostics.mjs';
import { journalNodeEvents, loginErrorCode, projectFriendEvent, RENDERER_TYPES } from './diag-events.mjs';
import { buildBundle, hashFile } from './diag-bundle.mjs';
import { deviceClass, EVENT_FIELDS, JOURNAL_DIR } from './journal.mjs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from 'fs';
import { copyFile, rename, unlink, writeFile } from 'fs/promises';
import { format, promisify } from 'util';
import { execFile, spawn } from 'child_process';
import { createAsscrackNode, keyedServiceTag } from '../network/node.mjs';
import { isRoomCode, newRoomKey, readInvite, readRoomCode } from '../network/invite.mjs';
import { knockRoom } from '../network/knock-client.mjs';
import { checkAllowedInvite } from '../network/knock.mjs';
import { createDeviceIdentity, importDeviceIdentity, createRoomMembership } from '../network/room-membership.mjs';
import { joinAdmission, restoreSavedAdmission } from './room-admission.mjs';
import { observeRoomActivity } from './room-activity.mjs';
import { initialHostFields, resolveRoomHostPlan, saveHostFields } from './room-host.mjs';
// Saved rooms (milestone 6).
import { createSavedRooms, makeProtector } from './saved-rooms.mjs';
import { roomFingerprint } from './room-archive.mjs';
import * as voiceSettings from './voice-settings.mjs';
import { listeningRoomTag, listeningStore } from './listening-store.mjs';
import { ALERT_KEYS, attentionSettings, createAttention, muteStore, roomMuteId, overlayDotBitmap, overlayShareBitmap } from './attention.mjs';
import { localServerRegistry, repairPortableIdentity, windowsIdentity } from './windows-identity.mjs';
import { createPttHook } from './ptt-hook.mjs';
import { createWindowFrame } from './window-frame.mjs';
import { attachVoiceMonitor } from './voice-monitor.mjs';
import { installRoomPermissions, isDesktopFrame, lockDesktopNavigation } from './desktop-boundary.mjs';
import { isAddressInUse, knockResultText, loginErrorText } from './login-errors.mjs';
import { createLinkPolicy } from './link-policy.mjs';
import { fitWindowBounds, MIN_WINDOW, readWindowBounds, saveWindowBounds } from './window-bounds.mjs';
import { createTaskbarFlash } from './taskbar-flash.mjs';
import { acceptScreenAudioFrame, acceptScreenFrame, createScreenSources, windowShareHasBorder } from './screen-sources.mjs';
import { createScreenAudioCapture } from './screen-audio-capture.mjs';
import { createShareGuard } from './share-guard.mjs';
import { guardScript, qunsScript, startHelper } from './win-helper.mjs';
import { createAutoStatus, readSettings as readAutoStatus } from './auto-status.mjs';
import { createFriendLinks, friendTestOptions } from './friend-links.mjs';
import { createAvatars } from './avatars.mjs';
import { createNetworkWatch } from './network-watch.mjs';
import { withDeviceMarks } from './peer-marks.mjs';
import { attachFriendWindows, registerFriendIpc } from './friend-windows.mjs';
import { attachFriendsPopout } from './friends-popout.mjs';
import { attachMusicPopout } from './music-popout.mjs';
import { createFriendJoins, savedRoomHasId } from './friend-join.mjs';
import { createClipboardJoin, createAskedStore, ASKED_FILE } from './clipboard-join.mjs';
import { installInterfaceCache } from '../network/interface-cache.mjs';
import { createUpdateService } from './update-service.mjs';
import { hadOldProfile, readLastSeen, readReleaseNotes, whatsNewStart, writeLastSeen } from './release-notes.mjs';
import { chooseDataFolder, cleanHoldFolders, dataPaths, downloadOwner, holdFolder, legacyFolder, moveFailedText, moveOldData, needsMove,
    notWritableText, probeWritable, writeKeptMarker } from './data-folder.mjs';
import { CHOICE_FILE, choiceAfterForget, createStartEntry, createStartRunner, isInstalledBuild, isStaleChoice, normalizeChoice,
    readChoice, START_IDLE_FLAG, startArgs, startRooms, writeChoice } from './start-at-sign-in.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
// I4: the room page comes from the app scheme, not from file:// (app-scheme.mjs).
const ROOM_PAGE = appPage('index.html');
const RNNOISE_WORKLET = '/vendor/rnnoiseWorklet.js';

Menu.setApplicationMenu(null);
protocol.registerSchemesAsPrivileged([{ scheme: 'room-media', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true
} }, { scheme: APP_SCHEME, privileges: APP_PRIVILEGES }, { scheme: MUSIC_SCHEME, privileges: MUSIC_PRIVILEGES }]);
const EVENTS = ['channels', 'peer-discovered', 'peer-joined', 'peer-left', 'message', 'history', 'voice-state', 'voice-roster', 'host-changed', 'peer-name',
    'file-offer', 'file-retried', 'file-progress', 'file-done', 'file-failed', 'file-refused', 'file-cancelled', 'topology', 'full-node', 'full-node-addrs',
    'voice-frame', 'connection', 'dial-failed', 'upnp', 'dialback', 'presence', 'topic', 'voice-channels',
    // P7b: pause and resume of a received file (P7a). The Partial objects have no path.
    'file-paused', 'file-resumed', 'file-restarted', 'file-discarded', 'file-expired', 'file-partials'];

// Test option: --profile <dir> gives each instance its own user data folder.
const profileIndex = process.argv.indexOf('--profile');
// R103-1 (windows-identity.mjs): the AUMID and the toast CLSID of this kind of build. Electron writes a Start menu
// shortcut and a CLSID key for them when it makes the notification presenter. A dev start or a start with --profile
// thus never uses the shortcut or the CLSID of the installed copy. The test kind never makes the presenter.
const winIdentity = windowsIdentity({ isPackaged: app.isPackaged, profile: profileIndex !== -1,
    portableFile: process.env.PORTABLE_EXECUTABLE_FILE || null,
    installed: isInstalledBuild({ platform: process.platform, isPackaged: app.isPackaged, env: process.env,
        execPath: process.execPath, exists: existsSync }) });
if (process.platform === 'win32') {
    app.setAppUserModelId(winIdentity.appId);
    app.setToastActivatorCLSID(winIdentity.clsid);
}
const winToasts = process.platform !== 'win32' || winIdentity.toasts;
// One data folder (data-folder.mjs): the portable build uses "ASSCRACK Data" next to the .exe, the installed build
// <install folder>\data, --profile its folder, npm start the Electron default. Each path is set before ready.
const dataFolder = chooseDataFolder({ argv: process.argv, env: process.env, isPackaged: app.isPackaged,
    platform: process.platform, execPath: process.execPath, exists: existsSync });
// The move question of the first start with an empty data folder: { from, to }, or null. Then this run uses a hold
// folder in %TEMP% (Chromium must not open the new folder before the move) and stops after the answer.
let moveOffer = null;
// The user data path of the old versions (the Electron default). It is the owner text of their download scratch.
const defaultUserData = app.getPath('userData');
function useDataFolder(dir) {
    const paths = dataPaths(dir);
    app.setPath('userData', paths.userData);
    app.setPath('sessionData', paths.sessionData);
    app.setAppLogsPath(paths.logs);
    app.setPath('crashDumps', paths.crashDumps);
}
if (dataFolder.dir) {
    const probe = probeWritable(dataFolder.dir);
    if (!probe.ok) {
        dialog.showErrorBox('ASSCRACK cannot start', notWritableText(dataFolder.dir, probe.error));
        process.exit(1);
    }
    const legacy = legacyFolder({ env: process.env, appData: app.getPath('appData') });
    if (dataFolder.kind !== 'profile' && needsMove({ dir: dataFolder.dir, legacy })) {
        moveOffer = { from: legacy, to: dataFolder.dir };
        useDataFolder(holdFolder(app.getPath('temp'), process.pid));
    } else {
        useDataFolder(dataFolder.dir);
    }
}

// What's new (release-notes.mjs): a file of an older version in the data folder, before this run writes to it.
const oldProfile = !moveOffer && hadOldProfile(app.getPath('userData'));

// Single instance lock (F1, goal 7): only for the packaged build with the default user data folder. Electron keys the
// lock on the user data folder. The check scripts start 2 or more copies with --profile, and npm start has no lock.
// A second start of the same copy shows the window of the first copy and exits.
const singleInstance = app.isPackaged && profileIndex === -1;
const isFirstInstance = !singleInstance || app.requestSingleInstanceLock();
if (!isFirstInstance) {
    app.exit(0);
}

// Diagnostics (1.0.1, docs/DIAGNOSTICS.md): the redacted journal of this run in <data folder>\diagnostics. It is always
// on and stays on this computer (DECISIONS.md: the redaction at write time replaces the opt-in rule of 42cf3b4 for this
// journal). Not in the run that asks the move question (hold folder) and not in a second copy that exits. The crash
// reporter writes the dumps to the crashDumps path of the data folder and uploads nothing.
let diag = null;
const buildKind = !app.isPackaged ? 'dev' : process.env.PORTABLE_EXECUTABLE_DIR ? 'portable'
    : isInstalledBuild({ platform: process.platform, isPackaged: app.isPackaged, env: process.env, execPath: process.execPath, exists: existsSync }) ? 'installed' : 'other';
if (isFirstInstance && !moveOffer) {
    try { crashReporter.start({ uploadToServer: false }); } catch (err) { console.warn('Crash reporter not started:', err?.message ?? err); }
    try {
        diag = createDiagnostics({ app, userData: app.getPath('userData'), alive: processRuns, appRoot: path.resolve(__dirname, '..', '..'),
            info: { dataKind: dataFolder.kind, startKind: process.argv.includes(START_IDLE_FLAG) ? 'sign-in' : 'manual', buildKind } });
        diag.hookApp();
    } catch (err) {
        console.warn('Diagnostics journal not started:', err?.message ?? err);
    }
}
// One journal event (journal.mjs checks the type and each field). False when the journal is off.
function journal(type, fields) {
    return diag?.write(type, fields) ?? false;
}

// Raw diagnostics can contain network addresses. Persist them only in an explicit
// troubleshooting run; the room always offers the redacted activity copy.
const MAX_DEBUG_LOG_BYTES = 4 * 1024 * 1024;
let logFile = null;
let logBytes = 0;

function pad(n) {
    return String(n).padStart(2, '0');
}

// A curated log line: the journal gets it (with the redaction of journal.mjs), and the raw log of --log-dir. The same
// text again within 10 s goes only to the raw log.
const dedupeLog = logDeduper();
function writeLog(level, text) {
    const line = dedupeLog(logText(text));
    if (line !== null) journal('log', { level, text: line });
    writeRaw(level, text);
}

// Only the raw log of --log-dir (raw addresses: never the journal).
function writeRaw(level, text) {
    if (!logFile) return;
    const line = `${new Date().toISOString()} ${level} ${String(text).slice(0, 8192)}\n`;
    const bytes = Buffer.byteLength(line);
    if (logBytes + bytes > MAX_DEBUG_LOG_BYTES) return;
    try {
        appendFileSync(logFile, line);
        logBytes += bytes;
    } catch {
        // Ignore: the terminal output stays.
    }
}

function openLog() {
    const index = process.argv.indexOf('--log-dir');
    if (index === -1 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) return;
    try {
        const dir = path.resolve(process.argv[index + 1]);
        mkdirSync(dir, { recursive: true });
        const d = new Date();
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        const file = path.join(dir, `asscrack-${stamp}-${process.pid}.log`);
        writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
        logFile = file;
        writeRaw('INFO', `ASSCRACK ${app.getVersion()} Electron ${process.versions.electron} (local debug capture)`);
    } catch (err) {
        logFile = null;
        console.error('Log file open failed:', err);
    }
}

openLog();

if (logFile) for (const [method, level] of [['log', 'LOG'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        original(...args);
        writeRaw(level, format(...args));
    };
}



// G7a: one read of the network interfaces each 2 s for all nodes (the mDNS cost of the friend nodes).
const interfaceCache = installInterfaceCache();
// One log line for each node event. The chat text does not go into the log.
// 'voice-frame' comes 50 times each second for each speaker.
// G7a: 'friend' and 'pm' carry room keys and private text. They never go in the log or to the window as raw events.
// P8b: 'screen-frame' carries the picture bytes of a screen share (design section 2.9). It never goes in the log.
const UNLOGGED_EVENTS = new Set(['file-progress', 'voice-frame', 'friend', 'pm', 'screen-frame', 'screen-audio-frame']);

function logEvent(type, data) {
    if (!logFile || UNLOGGED_EVENTS.has(type)) return;
    const parts = [`event ${type}`];
    if (type === 'connection' || type === 'dial-failed' || type === 'upnp') {
        for (const [k, v] of Object.entries(data ?? {})) if (v !== undefined && v !== null) parts.push(`${k} ${JSON.stringify(v)}`);
        writeRaw('EVENT', parts.join(' '));
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
    writeRaw('EVENT', parts.join(' '));
}

// One log line for each file action of the user. A Cancel before the transfer starts gives no node event.
function logAction(action, offerId) {
    journal('file', { event: 'action', action, offer: String(offerId).split(' ')[0] });
    writeRaw('EVENT', `action ${action} offer ${offerId}`);
}

// Test option: --downloads <dir> sets the folder for received files.
let downloadDir = null;
const downloadsIndex = process.argv.indexOf('--downloads');
if (downloadsIndex !== -1 && process.argv[downloadsIndex + 1]) {
    downloadDir = path.resolve(process.argv[downloadsIndex + 1]);
    mkdirSync(downloadDir, { recursive: true });
}

// Test option: --open-links-to <file>. Each link that the policy accepts goes to the end of the file as one line,
// and the system browser does not start (the app check of gap D2 needs it).
let openLinksTo = null;
const openLinksIndex = process.argv.indexOf('--open-links-to');
if (openLinksIndex !== -1 && process.argv[openLinksIndex + 1] && !process.argv[openLinksIndex + 1].startsWith('--')) {
    openLinksTo = path.resolve(process.argv[openLinksIndex + 1]);
}
// Test option: --save-to <dir>. Save image as writes to this folder with no Save dialog (the app check of the image
// menu needs it). The path checks of the save stay the same.
let saveTo = null;
const saveToIndex = process.argv.indexOf('--save-to');
if (saveToIndex !== -1 && process.argv[saveToIndex + 1] && !process.argv[saveToIndex + 1].startsWith('--')) {
    saveTo = path.resolve(process.argv[saveToIndex + 1]);
}

// Test option: --avatar-pick <file>. "Choose…" of the profile picture dialog takes this file with no Open dialog (the
// app check of the profile pictures needs it). The checks of the file stay the same.
let avatarPick = null;
const avatarPickIndex = process.argv.indexOf('--avatar-pick');
if (avatarPickIndex !== -1 && process.argv[avatarPickIndex + 1] && !process.argv[avatarPickIndex + 1].startsWith('--')) {
    avatarPick = path.resolve(process.argv[avatarPickIndex + 1]);
}

// Test option: --music-pick <file>. Add files of the music bar adds this file with no Open dialog (the music check
// needs it). The path checks stay the same.
let musicPick = null;
const musicPickIndex = process.argv.indexOf('--music-pick');
if (musicPickIndex !== -1 && process.argv[musicPickIndex + 1] && !process.argv[musicPickIndex + 1].startsWith('--')) {
    musicPick = [path.resolve(process.argv[musicPickIndex + 1])];
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

let mainWindow = null;
let voiceMonitor = null;
let node = null;
let readRoomActivity = () => [];
const mapTraffic = createMapTraffic();

const roomIpc = createRoomIpc(ipcMain, event => isDesktopFrame(mainWindow, event.sender, event.senderFrame, ROOM_PAGE));
function handleRoomIpc(channel, handler) {
    roomIpc.handle(channel, handler);
}

function onRoomIpc(channel, listener) {
    roomIpc.on(channel, listener);
}

// OI2: a read-only call. A window that closes at Quit gets null and no error line.
function queryRoomIpc(channel, handler) {
    roomIpc.query(channel, handler);
}
// The files that this computer received: `${offerId}|${peerId}` -> the final path (after a rename for a name
// collision). Only a file-done event with the direction receive adds a path. The window sends only the key.
const clipboardImages = createClipboardStaging(path.join(app.getPath('userData'), 'clipboard-staging'));
let downloadScratch = null;
const receivedFiles = new Map();
const restoringDownloads = new Map();
// L7: the previews of peer images are decoded in a hidden sandboxed window (image-decoder.mjs), not here.
const DECODER_PAGE = appPage('image-decoder.html');
const imageDecoder = createImageDecoder({ BrowserWindow, ipc: ipcMain, page: DECODER_PAGE,
    preload: path.join(__dirname, 'image-decoder-preload.cjs'), lock: lockDesktopNavigation,
    isFrame: (win, event) => isDesktopFrame(win, event.sender, event.senderFrame, DECODER_PAGE) });
// 1.0.6: profile pictures (avatars.mjs) in <data folder>/avatars. The decoder window above makes and checks each picture.
let avatarTimer = null;
const avatars = createAvatars({ dir: path.join(app.getPath('userData'), 'avatars'), journal: (type, fields) => journal(type, fields),
    decode: (info, limit, job) => imageDecoder.decode(info, limit, job), log: (level, text) => writeLog(level, text),
    changed: () => {
        if (avatarTimer) return;
        avatarTimer = setTimeout(() => {
            avatarTimer = null;
            sendToWindow('asscrack:avatars', avatars.view());
            friendLinks.avatarsChanged();
        }, 100);
    } });
queryRoomIpc('asscrack:avatars', () => avatars.view());
// The pick dialog of the main process: the window gets only a token and the size of the preview.
handleRoomIpc('asscrack:avatar-pick', async () => {
    if (avatarPick) return avatars.choose(avatarPick);
    const options = { title: 'Profile picture', properties: ['openFile'],
        filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] };
    const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths?.[0]) return null;
    return avatars.choose(result.filePaths[0]);
});
handleRoomIpc('asscrack:avatar-set', (_event, token, crop) => avatars.setOwn(String(token ?? ''), crop));
handleRoomIpc('asscrack:avatar-remove', () => avatars.removeOwn());
// The node gets the picture hub; its picture events go to avatars.mjs until the node stops.
function withAvatars(created) {
    const detach = avatars.attach(created);
    const stop = created.stop;
    created.stop = (...args) => { detach(); return stop.apply(created, args); };
    return created;
}
// Room music (MU-6): the YouTube player script runs in a hidden sandboxed window with no network, not here. The window
// has its own in-memory session: no shared renderer process with the room window (see app ready for its handlers).
const MUSIC_EVAL_PAGE = appPage('music-eval.html');
const MUSIC_EVAL_PARTITION = 'music-eval';
const musicEval = createMusicEval({ BrowserWindow, ipc: ipcMain, page: MUSIC_EVAL_PAGE, partition: MUSIC_EVAL_PARTITION,
    preload: path.join(__dirname, 'music-eval-preload.cjs'), lock: lockDesktopNavigation,
    isFrame: (win, event) => isDesktopFrame(win, event.sender, event.senderFrame, MUSIC_EVAL_PAGE) });
// Room music (music-ipc.mjs): the IPC of the music bar, the local files and the YouTube source of the DJ.
// The file dialogs have the window of the call as parent (the room window or the music pop-out window).
const music = attachMusic({ handle: handleRoomIpc, on: onRoomIpc, getNode: () => node, dialog,
    getWindow: event => (event?.sender && BrowserWindow.fromWebContents(event.sender)) || mainWindow,
    chosenFile: file => chosenFile(file), settingsFile: () => path.join(app.getPath('userData'), MUSIC_SETTINGS_FILE),
    journal: (type, fields) => journal(type, fields), log: (level, text) => writeLog(level, text), pick: musicPick,
    evaluate: code => musicEval.run(code), idle: () => idlePeer,
    onSettings: value => { sendToWindow('asscrack:music-settings-changed', value); musicPopout?.settings(value); } });
// Room music: the player in its own window (music-popout.mjs). "Pop out" in the music bar opens it, only in a room.
// It closes at Leave room, with the room window and at Quit; the settings keep it open for the next voice session.
// The visualizer of the window asks the room window for the levels (a pull for each frame, no network).
const musicPopout = attachMusicPopout({
    BrowserWindow, ipc: ipcMain, screen, profile: app.getPath('userData'), assets: __dirname, controls: music.controls,
    names: () => node?.peerNames?.() ?? {}, icon: path.join(__dirname, 'img', 'app.ico'),
    nearBounds: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null),
    remember: on => music.setPopout(on), onState: state => sendToWindow('asscrack:music-popout-state', state),
    pull: () => sendToWindow('asscrack:music-viz-pull', null), warn: message => writeLog('WARN', message)
});
handleRoomIpc('asscrack:music-popout', (_event, open) => {
    if (open !== true) { musicPopout.closeByUser(); return false; }
    return node ? musicPopout.open() : false;
});
onRoomIpc('asscrack:music-viz', (_event, bytes) => musicPopout.viz(bytes));
// 1.0.4: the thumbnails of a saved room that keeps history stay in its encrypted archive (the data folder), thus the
// history shows them again after a quit, a Leave room or an update.
const roomMedia = createRoomMedia({ decodeImage: (info, limit) => imageDecoder.decode(info, limit),
    changed: id => sendToWindow('asscrack:media-changed', id),
    store: { save: (d, png) => getSavedRooms().rememberThumbnail(d, png), load: d => getSavedRooms().getThumbnail(d) } });
let mediaGeneration = 0;
function clearRoomMedia() { mediaGeneration++; roomMedia.clear(); localOriginals.clear(); pendingSaves.clear(); }
// The image menu (chat-media.js): descriptor ID -> the path of a local original (an own post or a received file).
// The main process hashes the file again before each use (roomMedia.canReveal).
const localOriginals = new Map();
// Save image as before the original is on this computer: descriptor ID -> { descriptor, target }. The file-done
// listener copies the received original to the target.
const pendingSaves = new Map();
function savedDownload(messageId, descriptorId) {
    if (typeof messageId !== 'string' || !messageId || messageId.length > 128 ||
        typeof descriptorId !== 'string' || descriptorId.length !== 36) return null;
    return savedRooms?.getDownload(messageId, descriptorId);
}

handleRoomIpc('asscrack:saved-original-available', async (_event, messageId, descriptorId) => {
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
handleRoomIpc('asscrack:reveal-saved-original', async (_event, messageId, descriptorId) => {
    const download = savedDownload(messageId, descriptorId);
    if (!download || !await roomMedia.canReveal(download.descriptor, download.path) ||
        savedDownload(messageId, descriptorId)?.path !== download.path) return { ok: false };
    shell.showItemInFolder(download.path);
    return { ok: true };
});
handleRoomIpc('asscrack:media-clear-previews', () => {
    mediaGeneration++; roomMedia.clearPreviews(); getSavedRooms().clearThumbnails();
});
// OI2: a read-only call. The window can ask during a Quit.
queryRoomIpc('asscrack:media-info', (_event, ref) => {
    if (!node) return {};
    roomMedia.loadStored(ref);
    return roomMedia.info(ref);
});
// The thumbnail of a card: the stored one, else a request to the sender. With no thumbnail, reason tells the window
// why: 'offline' (no session of the sender; the window asks again when the sender is back) or 'unavailable'.
// The peer ID of a sender is new at each start. In a protected room the ID of a line starts with the device ID of its
// sender, and the archive keeps only checked pairs of line and card: the request goes to the session peer with that
// proved device ID.
const deviceOfLine = id => /^([A-Za-z0-9_-]{43})\./.exec(id)?.[1] ?? null;
handleRoomIpc('asscrack:media-preview', async (_event, ref, messageId) => {
    if (!node) return {};
    if (roomMedia.loadStored(ref)) return roomMedia.info(ref);
    const card = getSavedRooms().messageCard(messageId);
    const archived = card && sameAttachment(card.descriptor, ref) ? card : null;
    const descriptor = node.attachmentDescriptor(ref) ?? archived?.descriptor ?? null;
    if (!descriptor) return { reason: 'unavailable' };
    // An own post: no other copy has it.
    if (archived?.own || descriptor.source === node.peerId) return { ...roomMedia.info(ref), reason: 'unavailable' };
    const lineDevice = deviceOfLine(messageId), device = archived ? lineDevice : null;
    const via = node.attachmentSourceOnline(descriptor) ? descriptor.source :
        device ? node.peers().find(peer => node.deviceOf(peer) === device) ?? null : null;
    if (!via) {
        // A line that is not in the archive (a host replay, or a room with no saved history) is not a checked pair: no
        // request on the device route. Its device can be online with a new peer ID: then the card is unavailable.
        const online = Boolean(lineDevice) && node.peers().some(peer => node.deviceOf(peer) === lineDevice);
        return { ...roomMedia.info(ref), reason: online ? 'unavailable' : 'offline' };
    }
    const version = mediaGeneration, current = node;
    const result = await node.requestPreviewById(descriptor, { via, descriptor });
    if (version !== mediaGeneration || node !== current) return {};
    if (result) await roomMedia.storePreview(result.descriptor, result.bytes);
    const info = roomMedia.info(ref);
    return info.thumbnailUrl ? info : { ...info, reason: 'unavailable' };
});
const MAX_RECEIVED_KEY = 300;
let loginStarted = false;
// easy-join part 2: true while a knock with a room code waits for the owner (up to 2.5 minutes).
let knocking = false;
let stopping = false;

function sendToWindow(channel, data) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const sender = mainWindow.webContents;
    if (!sender.isDestroyed() && isDesktopFrame(mainWindow, sender, sender.mainFrame, ROOM_PAGE)) sender.send(channel, data);
}

// Participation belongs to the room. Minimizing the window leaves voice and capture alone.
let idlePeer = false;
let tray = null;
// G7b: the last tooltip of the tray (one log line for each change).
let lastTooltip = null;
let quitting = false;
// The room name for the tray tooltip (gap E8), and the voice state of the window (asscrack:set-voice).
let roomName = null;
let inVoice = false;
// Gap A7: the running Leave room (a promise), or null.
let leaving = null;
const closePreference = path.join(app.getPath('userData'), 'close-to-idle.json');
let closeToTray = true;
try { closeToTray = JSON.parse(readFileSync(closePreference, 'utf8')) !== false; } catch { /* new profile */ }
const idleState = () => ({ idle: idlePeer, closeToTray });
const autoUpnpPreference = path.join(app.getPath('userData'), 'auto-upnp.json');
let autoUpnp = true;
try { autoUpnp = JSON.parse(readFileSync(autoUpnpPreference, 'utf8')) !== false; } catch { /* new profile */ }
const swarmSeedingPreference = path.join(app.getPath('userData'), 'swarm-seeding.json');
let swarmSeeding = true;
try { swarmSeeding = JSON.parse(readFileSync(swarmSeedingPreference, 'utf8')) !== false; } catch { /* new profile */ }
const screenForwardingPreference = path.join(app.getPath('userData'), 'screen-forwarding.json');
const clampForwardingCap = value => (Number.isInteger(value) ? Math.max(0, Math.min(8, value)) : 2);
let screenForwardingCap = 2;
let lastNonZeroForwardingCap = 2;
let screenHubForwarding = false;
try {
    const saved = JSON.parse(readFileSync(screenForwardingPreference, 'utf8'));
    if (saved && typeof saved === 'object') {
        screenForwardingCap = clampForwardingCap(saved.maxChildren);
        const savedLast = clampForwardingCap(saved.lastNonZero);
        lastNonZeroForwardingCap = savedLast > 0 ? savedLast : 2;
        screenHubForwarding = saved.hubForwarding === true;
    }
} catch { /* new profile */ }
const effectiveScreenForwardingCap = () => (idlePeer ? 0 : screenForwardingCap);
const effectiveScreenHubForwarding = () => (!idlePeer && screenHubForwarding);
const screenForwardingState = () => ({
    maxChildren: screenForwardingCap,
    effectiveMaxChildren: effectiveScreenForwardingCap(),
    hubForwarding: screenHubForwarding,
    idle: idlePeer
});
// Gap E8: the flag file of the first close to the tray of this profile.
const trayHintFile = path.join(app.getPath('userData'), 'tray-hint.json');
// P9B: start at sign-in (start-at-sign-in.mjs). Only the installed build has it. The start entry starts this profile.
const installedBuild = isInstalledBuild({ platform: process.platform, isPackaged: app.isPackaged, env: process.env,
    execPath: process.execPath, exists: existsSync });
const startIdle = installedBuild && process.argv.includes(START_IDLE_FLAG);
const startChoiceFile = path.join(app.getPath('userData'), CHOICE_FILE);
const startEntry = createStartEntry({ app, execPath: process.execPath,
    args: startArgs(profileIndex !== -1 ? app.getPath('userData') : null) });
let startRunner = null;
// P9C: the updates that the operator publishes (update-service.mjs). The window gets no path.
const updates = createUpdateService({ app, shell, handle: handleRoomIpc, send: (channel, data) => sendToWindow(channel, data),
    log: writeLog, installedBuild, quit: () => app.quit(),
    busy: () => ({ voice: inVoice, transfers: node?.activeTransfers?.() ?? 0 }) });

const attentionPrefs = attentionSettings(path.join(app.getPath('userData'), 'attention.json'));
const attention = createAttention({
    settings: attentionPrefs.get,
    room: () => node,
    quiet: () => quitting || stopping || idlePeer || node?.presence().state === 'dnd',
    allowed: target => target.kind === 'friend' ? friendLinks.friend(target.friendId) !== null
        : target.kind === 'whisper'
        ? node?.whisperPeers().includes(target.peerId)
        : target.kind === 'voice' ? !!node
        : target.channelId === 'general' || node?.channels().channels.some(channel => channel.id === target.channelId),
    // G7b: one log line for each notification (no name, no text).
    // Message alerts: the show and failed events of Windows go to the log too (a check that the toast came).
    notify: options => {
        writeLog('EVENT', 'notification requested');
        // The test kind (R103-1): no presenter, thus no notification. attention.mjs catches the error.
        if (!winToasts) throw new Error('No desktop notifications in this kind of start.');
        // 1.0.6: the profile picture as the icon. The pixels come from the decoder window (no decode here).
        const { avatarHash, ...rest } = options;
        const pixels = avatarHash ? avatars.pixels(avatarHash) : null;
        if (pixels) rest.icon = nativeImage.createFromBitmap(pixels, { width: 128, height: 128 });
        const notice = new Notification(rest);
        notice.once('show', () => writeLog('EVENT', 'notification shown'));
        notice.once('failed', () => writeLog('WARN', 'notification failed'));
        return notice;
    },
    // G7b: a friend notification opens the chat window of that friend (the main window stays as it is).
    navigate: target => {
        if (target.kind === 'friend') { friendWindows.open(target.friendId); return; }
        restoreRoomWindow();
        if (target.kind !== 'voice') sendToWindow('asscrack:attention-open', target);
    },
    friendName: friendId => friendLinks.friend(friendId)?.name ?? '',
    // 1.0.6: the picture hash of a friend or a peer of the room (the notification icon), or null.
    avatarOf: target => (target.kind === 'friend' ? friendLinks.friend(target.friendId)?.avatar
        : target.peerId ? avatars.view().peers[target.peerId] : null) ?? null,
    // Message alerts: the title tells who and where. The names come from the node, not from the window (a room line
    // brings the name that its row shows).
    peerName: peerId => node?.peerNames()?.[peerId] ?? '',
    channelName: channelId => node?.channels().channels.find(channel => channel.id === channelId)?.name ?? ''
});

// R103-1: Notification.isSupported() makes the presenter, and Electron then writes the shortcut and the CLSID key of
// this identity. A portable start then points them to the portable .exe (one time for each run).
let portableRepair = null;
function registerAlerts() {
    if (!winToasts) { writeLog('INFO', 'notification identity test: no desktop notifications'); return; }
    if (!Notification.isSupported()) throw new Error('Desktop notifications are unavailable on this system.');
    if (process.platform === 'win32' && winIdentity.kind === 'portable' && !portableRepair) {
        const run = promisify(execFile);
        portableRepair = repairPortableIdentity({
            programsDir: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
            portableFile: process.env.PORTABLE_EXECUTABLE_FILE, execPath: process.execPath, shell,
            registry: localServerRegistry((file, args) => run(file, args, { windowsHide: true })),
            sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
        }).then(result => writeLog('INFO', `notification identity portable: shortcut ${result.shortcut}, server ${result.server}` +
            (result.timedOut ? ' (no Electron write in time)' : '')))
            .catch(err => writeLog('WARN', `notification identity portable not repaired: ${err?.message ?? err}`));
    }
}

handleRoomIpc('asscrack:attention-settings', () => attentionPrefs.get());
// Message alerts: the mutes of the open room (attention.mjs muteStore). The window gets the mutes, not the room ID.
const attentionMutes = muteStore(path.join(app.getPath('userData'), 'attention-mutes.json'));
const openRoomMuteId = () => (node && roomName !== null ? roomMuteId(node.roomKey(), roomName) : null);
handleRoomIpc('asscrack:attention-mutes', () => {
    const id = openRoomMuteId();
    return id ? attentionMutes.view(id) : { room: null, channels: {} };
});
handleRoomIpc('asscrack:attention-mute', (_event, request) => {
    const result = attentionMutes.set(openRoomMuteId(), request);
    writeLog('EVENT', `mute ${request?.scope === 'room' ? 'room' : 'channel'} ${request?.time === 'off' ? 'off' : 'on'}`);
    return result;
});
// The Notification column of the settings grid: a box that goes on registers the Start menu shortcut first.
const anyAlert = prefs => Object.values(ALERT_KEYS).some(key => prefs?.[key] === true);
handleRoomIpc('asscrack:attention-set', (_event, patch) => {
    if (anyAlert(patch)) registerAlerts();
    const next = attentionPrefs.set(patch);
    if (Object.values(ALERT_KEYS).some(key => patch?.[key] === false) || patch?.previews !== undefined ||
        patch?.sound !== undefined) attention.clear();
    return next;
});
onRoomIpc('asscrack:attention-add', (_event, target) => attention.add(target));
onRoomIpc('asscrack:attention-read', (_event, target) => attention.read(target));

// Gap E1: the taskbar flash and the overlay dot (taskbar-flash.mjs). The dot is a bitmap made in code.
const taskbarFlash = createTaskbarFlash({
    getWindow: () => mainWindow,
    allowed: () => !quitting && !idlePeer && !!node,
    enabled: () => attentionPrefs.get().flash === true,
    makeDot: () => {
        const dot = overlayDotBitmap();
        return nativeImage.createFromBitmap(dot.buffer, { width: dot.width, height: dot.height });
    },
    // P8b: the share overlay has the slot while a share is on (taskbar-flash.mjs, updateOverlay).
    makeShare: () => {
        const disc = overlayShareBitmap();
        return nativeImage.createFromBitmap(disc.buffer, { width: disc.width, height: disc.height });
    },
    log: writeLog
});
const stopFlash = taskbarFlash.stop;
onRoomIpc('asscrack:attention-flash', () => taskbarFlash.start());

function restoreRoomWindow() {
    if (!mainWindow || mainWindow.isDestroyed() || quitting) return;
    if (idlePeer) {
        idlePeer = false;
        node?.setIdle(false);
        node?.setScreenForwarding?.(effectiveScreenForwardingCap());
        node?.setScreenHubForwarding?.(effectiveScreenHubForwarding());
        friendLinks.setAvailability({ idle: false });
        sendToWindow('asscrack:idle-peer', idleState());
        sendToWindow('asscrack:screen-forwarding', screenForwardingState());
        node?.refreshRoutes();
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    updateTray();
}

// Gap E8: the tooltip and the menu of the tray icon.
// G7b: on the login screen with 1 or more friends, the friend links stay online (design F11).
const FRIENDS_TOOLTIP = 'ASSCRACK – online for friends';
const friendCount = () => (friendLinks.state() === 'open' ? friendLinks.list().count : 0);
function trayTooltip() {
    if (!roomName) return friendCount() > 0 ? FRIENDS_TOOLTIP : 'ASSCRACK';
    return idlePeer ? `ASSCRACK – Idle Peer in ${roomName}` : `ASSCRACK – ${roomName}`;
}
function updateTray() {
    if (!tray) return;
    const tooltip = trayTooltip();
    tray.setToolTip(tooltip);
    if (tooltip !== lastTooltip) {
        lastTooltip = tooltip;
        writeLog('EVENT', `tray tooltip: ${tooltip === FRIENDS_TOOLTIP ? 'online for friends' : roomName ? 'room' : 'plain'}`);
    }
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open ASSCRACK', click: restoreRoomWindow },
        { label: 'Close to tray', type: 'checkbox', checked: closeToTray, click: item => {
            try { setCloseToTray(item.checked); } catch (err) { writeLog('WARN', `Close preference not saved: ${err?.message ?? err}`); }
        } },
        { label: 'Quit ASSCRACK', click: () => app.quit() }
    ]));
}

function showTrayBalloon(content) {
    try {
        tray?.displayBalloon({ iconType: 'info', title: 'ASSCRACK', content });
        writeLog('EVENT', 'tray balloon requested');
    } catch (err) {
        writeLog('WARN', `Tray balloon not shown: ${err?.message ?? err}`);
    }
}

function openTray() {
    if (tray) return true;
    try {
        tray = new Tray(path.join(__dirname, 'img', 'app.ico'));
        tray.on('click', restoreRoomWindow);
        tray.on('balloon-show', () => writeLog('EVENT', 'tray balloon shown'));
        return true;
    } catch (err) {
        tray?.destroy();
        tray = null;
        writeLog('WARN', 'Cannot open the tray: ' + (err?.message ?? err));
        return false;
    }
}

// G7b (operator decision 4, 2026-11-21): Close on the login screen with 1 or more friends and "Close to Idle Peer" on
// hides the window to the tray. The friend links stay online. The first time gives a note. Quit is in the tray menu.
const friendsTrayHintFile = path.join(app.getPath('userData'), 'tray-friends-hint.json');
function hideForFriends() {
    if (node || leaving || quitting || !mainWindow || mainWindow.isDestroyed() || friendCount() < 1) return false;
    if (!openTray()) return false;
    // Not Idle Peer: there is no room, and the friends see the availability of the login screen ('available').
    mainWindow.hide();
    updateTray();
    writeLog('INFO', 'Window in the tray on the login screen (online for friends)');
    if (!existsSync(friendsTrayHintFile)) {
        try { writeFileSync(friendsTrayHintFile, JSON.stringify({ shown: true })); }
        catch (err) { writeLog('WARN', `Tray hint flag not saved: ${err?.message ?? err}`); }
        showTrayBalloon('Still running in the tray.');
    }
    return true;
}

function enterIdlePeer() {
    if (!node || !mainWindow || mainWindow.isDestroyed() || quitting || leaving) return false;
    if (!openTray()) return false;
    // A close in voice ends voice with no question (the window leaves voice at the idle-peer event).
    const leftVoice = !idlePeer && inVoice;
    if (!idlePeer) {
        idlePeer = true;
        inVoice = false;
        voiceMonitor?.dismiss();
        attention.clear();
        stopFlash();
        node.setIdle(true);
        // P8b: setIdle stops the own share and the watch (section 2.8). The selection ends too.
        screenSources.clear();
        friendLinks.setAvailability({ idle: true });
        updatePttHook(() => pttHook.setInVoice(false));
        sendToWindow('asscrack:idle-peer', idleState());
        sendToWindow('asscrack:screen-forwarding', screenForwardingState());
    }
    mainWindow.hide();
    updateTray();
    // The first close to the tray of the profile gives the hint. A close that ended voice says so.
    const firstClose = !existsSync(trayHintFile);
    if (firstClose) {
        try { writeFileSync(trayHintFile, JSON.stringify({ shown: true })); }
        catch (err) { writeLog('WARN', `Tray hint flag not saved: ${err?.message ?? err}`); }
    }
    const hint = 'Still in the room. Running in the tray.';
    if (firstClose) showTrayBalloon(leftVoice ? 'You left voice. ' + hint : hint);
    else if (leftVoice) showTrayBalloon('You left voice. Still in the room.');
    return true;
}

function saveScreenForwardingPrefs() {
    writeFileSync(screenForwardingPreference + '.tmp', JSON.stringify({
        maxChildren: screenForwardingCap,
        lastNonZero: lastNonZeroForwardingCap,
        hubForwarding: screenHubForwarding
    }));
    renameSync(screenForwardingPreference + '.tmp', screenForwardingPreference);
}

function setScreenForwarding(value) {
    let next;
    if (typeof value === 'boolean') {
        next = value ? lastNonZeroForwardingCap : 0;
    } else if (typeof value === 'number' && Number.isInteger(value)) {
        next = clampForwardingCap(value);
    } else {
        throw new TypeError('Expected a screen forwarding setting');
    }
    if (next > 0) lastNonZeroForwardingCap = next;
    screenForwardingCap = next;
    saveScreenForwardingPrefs();
    node?.setScreenForwarding?.(effectiveScreenForwardingCap());
    sendToWindow('asscrack:screen-forwarding', screenForwardingState());
    return screenForwardingState();
}

function setScreenHubForwarding(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected a screen hub forwarding setting');
    screenHubForwarding = enabled;
    saveScreenForwardingPrefs();
    node?.setScreenHubForwarding?.(effectiveScreenHubForwarding());
    sendToWindow('asscrack:screen-forwarding', screenForwardingState());
    return screenForwardingState();
}

function setCloseToTray(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected a close preference');
    writeFileSync(closePreference + '.tmp', JSON.stringify(enabled));
    renameSync(closePreference + '.tmp', closePreference);
    closeToTray = enabled;
    sendToWindow('asscrack:idle-peer', idleState());
    updateTray();
    return idleState();
}

function setAutoUpnp(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected an auto-UPnP preference');
    writeFileSync(autoUpnpPreference + '.tmp', JSON.stringify(enabled));
    renameSync(autoUpnpPreference + '.tmp', autoUpnpPreference);
    autoUpnp = enabled;
    sendToWindow('asscrack:auto-upnp', { enabled });
    return { enabled };
}

function setSwarmSeeding(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected a swarm seeding preference');
    writeFileSync(swarmSeedingPreference + '.tmp', JSON.stringify(enabled));
    renameSync(swarmSeedingPreference + '.tmp', swarmSeedingPreference);
    swarmSeeding = enabled;
    node?.setSwarmSeeding?.(swarmSeeding);
    sendToWindow('asscrack:swarm-seeding', { enabled: swarmSeeding });
    return { enabled: swarmSeeding };
}

// P9B: the start at sign-in. The window gets the choice, the protected saved rooms (ID and name) and the state of
// the start entry in Windows. No path and no argument.
function startupView() {
    if (!installedBuild) return { available: false };
    const status = getSavedRooms().status();
    if (isStaleChoice(readChoice(startChoiceFile), status)) forgetStartRoom(readChoice(startChoiceFile).roomId);
    return { available: true, ...readChoice(startChoiceFile), archive: status.state, rooms: startRooms(status.rooms),
        entry: startEntry.state() };
}
function setStartup(raw) {
    if (!installedBuild) throw new Error('Only the installed app can start at sign-in.');
    const choice = normalizeChoice(raw);
    if (choice.mode === 'room' && !startRooms(getSavedRooms().status().rooms).some(room => room.roomId === choice.roomId)) {
        throw new Error('Saved room not found');
    }
    writeChoice(startChoiceFile, choice);
    startEntry.apply(choice);
    writeLog('INFO', `Start at sign-in set: ${choice.mode}`);
    return startupView();
}
// Forget in each build clears the choice (the portable build uses the same profile). Only the installed build
// changes the start entry.
function forgetStartRoom(roomId) {
    const choice = readChoice(startChoiceFile);
    if (choiceAfterForget(choice, roomId).mode === choice.mode) return;
    try {
        writeChoice(startChoiceFile, { mode: 'off' });
        if (installedBuild) startEntry.apply({ mode: 'off' });
        writeLog('INFO', 'Start at sign-in set: off (room forgotten)');
    } catch (err) { writeLog('WARN', `Start at sign-in not removed: ${err?.message ?? err}`); }
}
// With START_IDLE_FLAG: the window stays hidden, the tray opens, and the runner opens the choice.
function beginStartAtSignIn() {
    if (!openTray()) { mainWindow.show(); return; }
    updateTray();
    writeLog('INFO', 'Start at sign-in: in the tray');
    startRunner = createStartRunner({
        choice: readChoice(startChoiceFile),
        status: () => getSavedRooms().status(),
        unlock: async () => { await getSavedRooms().unlock(); startFriendLinks(); },
        busy: () => loginStarted || !!node || quitting,
        openRoom: roomId => sendToWindow('asscrack:start-room', roomId),
        done: result => {
            if (result === 'room' && !mainWindow.isDestroyed() && !mainWindow.isVisible()) enterIdlePeer();
            else if (result === 'missing') { forgetStartRoom(readChoice(startChoiceFile).roomId); restoreRoomWindow(); }
            else if (result === 'none') restoreRoomWindow();
        },
        log: writeLog
    });
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', () => startRunner.start());
    else startRunner.start();
}
handleRoomIpc('asscrack:startup', () => startupView());
handleRoomIpc('asscrack:set-startup', (_event, choice) => setStartup(choice));

handleRoomIpc('asscrack:idle-peer', idleState);
handleRoomIpc('asscrack:enter-idle-peer', enterIdlePeer);
handleRoomIpc('asscrack:close-to-tray', (_event, enabled) => setCloseToTray(enabled));
handleRoomIpc('asscrack:screen-forwarding', screenForwardingState);
handleRoomIpc('asscrack:set-screen-forwarding', (_event, value) => setScreenForwarding(value));
handleRoomIpc('asscrack:set-screen-hub-forwarding', (_event, value) => setScreenHubForwarding(value));
handleRoomIpc('asscrack:auto-upnp', () => ({ enabled: autoUpnp }));
handleRoomIpc('asscrack:set-auto-upnp', (_event, value) => setAutoUpnp(value));
handleRoomIpc('asscrack:swarm-seeding', () => ({ enabled: swarmSeeding }));
handleRoomIpc('asscrack:set-swarm-seeding', (_event, value) => setSwarmSeeding(value));
onRoomIpc('asscrack:quit', () => app.quit());

// Gap E3: the values of the About dialog.
handleRoomIpc('asscrack:about', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    system: `${process.platform === 'win32' ? 'Windows' : process.platform} ${process.getSystemVersion()}`,
    debugLog: logFile !== null
}));
// What's new: the notes list (release-notes.json) and the card of the first start after an update. The decision and
// the save of the version happen one time for each run; the card stays until the window closes it.
let whatsNew = null;
function whatsNewState() {
    if (whatsNew) return whatsNew;
    let list = [];
    try { list = readReleaseNotes(); } catch (err) { writeLog('WARN', `Release notes not read: ${err?.message ?? err}`); }
    let pending = null;
    if (isFirstInstance && !moveOffer) {
        const dir = app.getPath('userData');
        const decision = whatsNewStart({ current: app.getVersion(), lastSeen: readLastSeen(dir), oldProfile, list });
        if (decision.save) {
            try { writeLastSeen(dir, decision.save); } catch (err) { writeLog('WARN', `What's new state not saved: ${err?.message ?? err}`); }
        }
        pending = decision.show;
    }
    whatsNew = { list, pending };
    return whatsNew;
}
handleRoomIpc('asscrack:whats-new', () => {
    const state = whatsNewState();
    return { current: app.getVersion(), entries: state.list, pending: state.pending };
});
handleRoomIpc('asscrack:whats-new-done', () => {
    whatsNewState().pending = null;
    return true;
});
// ---- Diagnostics: requests, bundles and marks (1.0.1, docs/DIAGNOSTICS.md). The window gets no path. ----
const diagFolder = () => path.join(app.getPath('userData'), JOURNAL_DIR);
const receivedFolder = () => path.join(diagFolder(), 'received');
const fileStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
let exeHash = null;
// The SHA-256 of the program file (once for each run, streamed: no stall of the main thread).
function exeSha256() {
    exeHash ??= hashFile(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath).catch(() => null);
    return exeHash;
}
function diagSystem() {
    const cpus = os.cpus();
    return { version: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, os: os.release(),
        arch: process.arch, build: buildKind, data: dataFolder.kind, run: diag?.run ?? null,
        journal: !diag ? 'off' : diag.journal.failed ? 'stopped' : 'on', cpu: cpus[0]?.model?.trim() ?? null, cpus: cpus.length,
        ramMb: Math.round(os.totalmem() / 1048576), uptimeS: Math.round(process.uptime()), ...interfaceSummary() };
}
// The last reach result: the state of roomReach(), the UPnP state with no address, the number of peers.
function diagReach() {
    if (!node) return { inRoom: false };
    const upnp = lastUpnp ? { state: lastUpnp.state ?? null, reason: lastUpnp.reason ?? null, port: lastUpnp.port ?? null } : null;
    return { inRoom: true, ...roomReach(), upnp, peers: node.peers().length };
}
async function makeBundle(includeDumps) {
    diag?.flushSync();
    return buildBundle({ diagDir: diagFolder(), crashDir: app.getPath('crashDumps'), includeDumps: includeDumps === true,
        system: diagSystem(), reach: diagReach(), exe: { sha256: await exeSha256() } });
}
// The bundles of the "Send" answers wait in diagnostics\outgoing for the transfer. Files older than 1 h go.
function outgoingFile() {
    const dir = path.join(diagFolder(), 'outgoing');
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
        try { if (Date.now() - statSync(path.join(dir, name)).mtimeMs > 3600_000) rmSync(path.join(dir, name), { force: true }); } catch { /* next time */ }
    }
    return path.join(dir, `${fileStamp()}-${Math.random().toString(16).slice(2, 10)}.zip`);
}
// A received bundle moves from the download folder to diagnostics\received under a name of this computer.
async function saveReceived(data) {
    const dir = receivedFolder();
    const target = path.join(dir, `${fileStamp()}-${String(data.peerId).slice(-8).replace(/[^A-Za-z0-9]/g, '_')}.zip`);
    try {
        mkdirSync(dir, { recursive: true });
        try { await rename(data.path, target); } catch { await copyFile(data.path, target); await unlink(data.path).catch(() => {}); }
        journal('diag', { event: 'saved', peer: data.peerId, id: data.id, size: data.size });
        sendToWindow('asscrack:diag', { event: 'saved', peerId: data.peerId, id: data.id });
    } catch (err) {
        journal('diag', { event: 'save-failed', peer: data.peerId, id: data.id, reason: err?.code?.toLowerCase?.() });
        sendToWindow('asscrack:diag', { event: 'failed', peerId: data.peerId, id: data.id, reason: 'not saved' });
    }
}
function onDiagEvent(data) {
    if (data?.event === 'received' && typeof data.path === 'string') { void saveReceived(data); return; }
    sendToWindow('asscrack:diag', { event: data?.event, id: data?.id, peerId: data?.peerId, by: data?.by, side: data?.side,
        reason: typeof data?.reason === 'string' ? data.reason.slice(0, 64) : undefined });
}
handleRoomIpc('asscrack:diag-ask', (_event, peerId) => {
    if (!node) throw new Error('Not logged in');
    if (typeof peerId !== 'string' || !peerId || peerId.length > 128) return { ok: false, reason: 'offline' };
    return node.askDiagnostics(peerId);
});
// "Ask everyone in the room": one request for each member, and the own bundle in the same folder (both sides of
// each connection).
handleRoomIpc('asscrack:diag-ask-all', async () => {
    if (!node) throw new Error('Not logged in');
    let asked = 0, skipped = 0;
    for (const peerId of node.peers()) { if (node.askDiagnostics(peerId).ok) asked++; else skipped++; }
    let saved = false;
    try {
        const bundle = await makeBundle(false);
        mkdirSync(receivedFolder(), { recursive: true });
        await writeFile(path.join(receivedFolder(), `${fileStamp()}-own.zip`), bundle.zip);
        journal('diag', { event: 'saved-own' });
        saved = true;
    } catch (err) { writeLog('WARN', `Own diagnostics not saved: ${err?.code ?? err?.message ?? err}`); }
    return { asked, skipped, saved };
});
handleRoomIpc('asscrack:diag-preview', async (_event, includeDumps) => {
    const bundle = await makeBundle(includeDumps === true);
    return { summary: bundle.summary.slice(0, 20000), files: bundle.names.slice(0, 64) };
});
handleRoomIpc('asscrack:diag-answer', async (_event, id, send, includeDumps) => {
    if (!node || typeof id !== 'string' || id.length > 64) return { ok: false, reason: 'expired' };
    if (send !== true) return node.answerDiagnostics(id, null);
    const file = outgoingFile();
    await writeFile(file, (await makeBundle(includeDumps === true)).zip);
    const result = await node.answerDiagnostics(id, file);
    if (!result.ok) rmSync(file, { force: true });
    return { ok: result.ok === true, reason: result.reason };
});
handleRoomIpc('asscrack:diag-save', async (_event, includeDumps) => {
    const options = { title: 'Save diagnostics', filters: [{ name: 'Zip file', extensions: ['zip'] }],
        defaultPath: path.join(app.getPath('downloads'), `asscrack-diagnostics-${fileStamp()}.zip`) };
    const { canceled, filePath } = mainWindow && !mainWindow.isDestroyed() ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return { ok: false, canceled: true };
    await writeFile(filePath, (await makeBundle(includeDumps === true)).zip);
    journal('diag', { event: 'saved-own', crashDumps: includeDumps === true });
    return { ok: true };
});
handleRoomIpc('asscrack:diag-open-received', async () => {
    mkdirSync(receivedFolder(), { recursive: true });
    const error = await shell.openPath(receivedFolder());
    return { ok: !error };
});
// "Mark a problem": a category, the time and the room state. No free text.
handleRoomIpc('asscrack:diag-mark', (_event, category) => {
    if (EVENT_FIELDS.mark.category(category) === undefined) throw new Error('Select what went wrong.');
    if (!journal('mark', { category, inVoice, sharing: screenOwn, peers: node?.peers().length ?? 0 })) throw new Error('Diagnostics are off.');
    diag?.flushSync();
    return true;
});
// The voice code of the window: the device result and the voice summary each minute. A device label becomes a kind
// and a tag here (journal.mjs deviceClass); the label does not go in the journal.
onRoomIpc('asscrack:diag-event', (_event, type, fields) => {
    if (!RENDERER_TYPES.has(type) || !fields || typeof fields !== 'object') return;
    if (type === 'voice-device') {
        const { label, ...rest } = fields;
        journal(type, { ...rest, ...deviceClass(typeof label === 'string' ? label.slice(0, 256) : '', diag?.tagKey()) });
    } else journal(type, fields);
});

// Gap E3: open the user data folder of this profile in Explorer. The window gets no path.
handleRoomIpc('asscrack:open-data-folder', async () => {
    const error = await shell.openPath(app.getPath('userData'));
    if (error) writeLog('WARN', `Data folder not opened: ${error}`);
    return { ok: !error };
});

// Gap E2: the window bounds of the last run, fitted to the work area of the nearest display.
function startBounds() {
    const saved = readWindowBounds(app.getPath('userData'));
    const area = saved ? screen.getDisplayMatching(saved).workArea : screen.getPrimaryDisplay().workArea;
    return fitWindowBounds(saved, area, MIN_WINDOW);
}
let boundsTimer = null;
function saveBoundsNow() {
    clearTimeout(boundsTimer);
    boundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        saveWindowBounds(app.getPath('userData'), { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
    } catch (err) {
        writeLog('WARN', `Window bounds not saved: ${err?.message ?? err}`);
    }
}
function saveBoundsSoon() {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBoundsNow, 500);
}

function createMainWindow() {
    const frame = createWindowFrame(app.getPath('userData'));
    const bounds = startBounds();
    mainWindow = new BrowserWindow({
        ...frame.options,
        title: 'ASSCRACK',
        show: !startIdle,
        icon: path.join(__dirname, 'img', 'app.ico'),
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: MIN_WINDOW.width,
        minHeight: MIN_WINDOW.height,
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

    lockDesktopNavigation(mainWindow.webContents);
    frame.attach(mainWindow, ipcMain, ROOM_PAGE);
    voiceMonitor = attachVoiceMonitor({
        room: mainWindow, roomPage: ROOM_PAGE, ipc: ipcMain, BrowserWindow, screen, profile: app.getPath('userData'), assets: __dirname,
        participating: () => !!node && !idlePeer && !quitting && !mainWindow.isDestroyed(),
        restoreRoom: restoreRoomWindow, warn: message => writeLog('WARN', message)
    });

    diag?.attachWindow(mainWindow);
    mainWindow.once('ready-to-show', () => journal('ready', { ms: Math.round(process.uptime() * 1000) }));
    if (logFile) mainWindow.webContents.on('console-message', details => {
        writeRaw('WINDOW', `${details.level} ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });

    // P9B: maximize() shows the window. A start at sign-in maximizes at the first show.
    if (bounds.maximized && startIdle) mainWindow.once('show', () => mainWindow.maximize());
    else if (bounds.maximized) mainWindow.maximize();
    for (const type of ['resize', 'move', 'maximize', 'unmaximize']) mainWindow.on(type, saveBoundsSoon);
    // Gap E1: the focus ends the taskbar flash and removes the dot.
    taskbarFlash.attach(mainWindow);
    attachClipboardJoin(mainWindow);

    mainWindow.on('close', event => {
        saveBoundsNow();
        if (!quitting && closeToTray && (enterIdlePeer() || hideForFriends())) event.preventDefault();
    });
    // G7a: the friend chat windows close with the main window (then the app quits as before).
    mainWindow.on('closed', () => { friendWindows.closeAll(); friendsPopout.close(); musicPopout.close(); imageDecoder.close(); });
    // Room music: the visualizer of the bar stops while the room window is minimized or hidden.
    for (const name of ['minimize', 'hide', 'restore', 'show', 'maximize', 'unmaximize']) {
        mainWindow.on(name, () => {
            if (mainWindow && !mainWindow.isDestroyed()) sendToWindow('asscrack:music-room-shown', mainWindow.isVisible() && !mainWindow.isMinimized());
        });
    }
    // Windows shutdown may bypass before-quit. Do not hide or veto session termination.
    mainWindow.on('session-end', () => { quitting = true; diag?.quit(); });

    mainWindow.loadURL(ROOM_PAGE);

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
}

// Start the node of a room. options: the node options (name, room, and for a keyed room roomKey and inviteNodes).
// The login handler and the reopen of a saved room use this function. Returns the login result.
let retainRoomHints = null;
// The last 'upnp' event of the room (the reach state of gap A1), and the call that saves the UPnP choice of a saved
// room after enableUpnp() (gap N2). startRoom sets both.
let lastUpnp = null;
let saveUpnpChoice = () => {};
let onLive = () => {};
async function startRoom(options, { publicAddress = '', allowUpnp = false, reopen = false, lan = false } = {}) {
    if (loginStarted) throw new Error('Already logged in');
    loginStarted = true;
    mapTraffic.reset();
    try {
        try {
            downloadScratch ??= createDownloadScratch(options.downloadDir, downloadOwner(app.getPath('userData'), app.getPath('userData')));
            options.scratchDir = downloadScratch.directory;
        } catch {
            writeLog('WARN', 'Private download staging unavailable');
        }
        let hints = null;
        let alreadySaved = false;
        if (options.roomKey) {
            hints = roomHintFiles(options.room, options.roomKey);
            const rooms = getSavedRooms();
            alreadySaved = Boolean(rooms.getRoom(roomFingerprint(options.room, options.roomKey)));
            if (alreadySaved) options.storePath = hints.peers;
            else if (rooms.status().state === 'open') {
                // Older versions wrote hints for rooms that users never saved.
                try { deleteHintFiles(hints); } catch { writeLog('WARN', 'Could not remove old unsaved room hints'); }
            }
            options.seedChannels = rooms.loadChannels(options.room, options.roomKey);
            options.seedVoiceChannels = rooms.loadVoiceChannels(options.room, options.roomKey);
            options.seedHistory = removeHistory => rooms.prepareReplay(options.room, options.roomKey, removeHistory);
            // P7c: the resume grants of a sender, one file for each room in the profile. The node writes a grant
            // only in a protected room (it needs the device ID of the receiver).
            options.partials = { grantsFile: path.join(app.getPath('userData'), 'resume-grants',
                `${roomFingerprint(options.room, options.roomKey)}.json`) };
        }
        const hostFile = alreadySaved ? hints.host : null;
        // Saved internet rooms follow the global autoUpnp setting on reopen unless
        // the room explicitly opted out (allowUpnp: false) or has a saved publicAddress.
        const { address, mapping, savedPort } = resolveRoomHostPlan({ hostFile, publicAddress, allowUpnp, autoUpnp, reopen, lan });
        if (address !== '') {
            const { ip, port } = parsePublicAddress(address);
            options.announce = [`/ip4/${ip}/tcp/${port}`];
            options.port = port;
        } else if (mapping) {
            options.upnp = true;
            if (savedPort !== null && options.port === undefined) {
                options.port = savedPort;
                options.savedUpnpPort = true;
                writeLog('INFO', `Saved UPnP port ${savedPort} used for this room`);
            }
        }
        if (lan) {
            options.fullNode = false;
            options.upnp = false;
        }
        options.previewProvider = (descriptor, filePath) => roomMedia.makePreview(filePath, descriptor);
        // 1.0.4: an own post after a restart or after its 30 minutes: the stored thumbnail (checked again on load). An
        // own card of the archive, or the live descriptor of an own post of this start.
        options.storedPreview = (id, live) => {
            const descriptor = getSavedRooms().ownCard(id) ?? live;
            return descriptor && roomMedia.loadStored(descriptor) ? { descriptor, png: roomMedia.previewBytes(descriptor) } : null;
        };
        options.receiveWhisper = message => {
            if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isCrashed()) return false;
            sendToWindow('asscrack:whisper', message);
            return true;
        };
        const fromSavedUpnpPort = options.savedUpnpPort === true;
        delete options.savedUpnpPort;
        options.updates = updates.hub;
        options.avatars = avatars.hub;
        // easy-join part 2: the owner answers knocks; a relay lets a knock circuit reach the owner.
        // Part 3: isFriend for "Always allow my friends" (a friend that is not blocked).
        options.knock = { isFriend: deviceId => friendLinks.isFriend(deviceId) };
        // Room music: the YouTube source of this computer when it is the DJ (music-source.mjs).
        options.musicResolve = request => music.resolve(request);
        options.screen = { ...options.screen, maxChildren: effectiveScreenForwardingCap(), hubForwarding: effectiveScreenHubForwarding() };
        options.fileSwarmOptions = { ...options.fileSwarmOptions, seedingEnabled: swarmSeeding };
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
        withAvatars(node);
        // Gap A7: each listener of this room acts only while its node is the live node. After Leave room, a late
        // event of the old node (for example in a stop that took more than 3 s) does nothing.
        const live = node;
        onLive = (type, listener) => live.events.on(type, data => { if (node === live) listener(data); });
        roomName = options.room;
        lastUpnp = null;
        saveUpnpChoice = () => {};
        onLive('upnp', data => { lastUpnp = data ?? null; });
        // Diagnostics (1.0.1): the node events of the journal (diag-events.mjs projects each field), and the
        // diagnostics requests (the prompt, the answers, the received bundle).
        journalNodeEvents(onLive, journal, node.peerId);
        onLive('diag', onDiagEvent);
        if (hints) {
            let persistence = false, mappedPort = null;
            // For each room with hint files: an owner can turn on UPnP after the start (enableUpnp).
            onLive('upnp', data => {
                if (data?.state !== 'mapped' || !Number.isInteger(data.port)) return;
                mappedPort = data.port;
                if (persistence) saveHostFields(hints.host, { upnpPort: mappedPort }, { log: writeLog });
            });
            saveUpnpChoice = () => { if (persistence) saveHostFields(hints.host, { allowUpnp: true }, { log: writeLog }); };
            retainRoomHints = () => {
                mkdirSync(path.dirname(hints.peers), { recursive: true, mode: 0o700 });
                if (!alreadySaved) node.setAddressStore(hints.peers);
                const fields = initialHostFields({ reopen, lan, address, mapping, mappedPort });
                if (Object.keys(fields).length > 0) saveHostFields(hints.host, fields, { log: writeLog });
                persistence = true;
            };
        }
    } catch (err) {
        savedRooms?.releaseReplay();
        roomName = null;
        loginStarted = false;
        throw err;
    }
    // Record the path before the window gets the event, so that a Show in Explorer at once finds it.
    onLive('attachment-status', data => sendToWindow('asscrack:attachment-status', data));
    // 1.0.4: a peer can answer thumbnail requests again (its attachment hello). The window asks again for the cards
    // of that sender that have no thumbnail.
    onLive('attachment-peer', data => sendToWindow('asscrack:media-peer',
        { peer: data?.peer ?? null, device: node?.deviceOf(data?.peer) ?? null }));
    onLive('shelf', data => sendToWindow('asscrack:shelf', data));
    onLive('shelf-offered', data => sendToWindow('asscrack:shelf-offered', data));
    onLive('membership', () => sendToWindow('asscrack:membership', node.memberState()));
    // easy-join part 2: the knock prompts of the owner. The window gets the name and the device mark, no device ID.
    onLive('knocks', ({ pending, added }) => {
        sendToWindow('asscrack:knocks', knockView(pending));
        if (!added) return;
        writeLog('INFO', `Knock prompt shown (${pending.length} waiting)`);
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
            showTrayBalloon(`${added.name} #${added.mark} wants to join ${roomName ?? 'the room'}.`);
        }
    });
    // easy-join part 3: "Always allow my friends" let a friend in with no prompt. The window shows a line with the name
    // of the Friends list and the device mark. The log has no name.
    onLive('knock-auto', ({ name, mark, deviceId }) => {
        writeLog('INFO', 'Knock auto-allowed (friend)');
        sendToWindow('asscrack:knock-auto', { name: friendLinks.nameOf(deviceId) ?? name, mark });
    });
    // P7b fix: `live` is a const of the try block above. A ReferenceError here failed each received file at its end
    // ("stream ended" on both ends). This listener keeps its own copy of the live node.
    const doneNode = node;
    node.events.on('file-done', data => {
        if (node !== doneNode) return;
        if (data?.direction !== 'receive' || typeof data.path !== 'string') return;
        receivedFiles.set(`${data.offerId}|${data.peerId}`, data.path);
        if (receivedFiles.size > 2048) receivedFiles.delete(receivedFiles.keys().next().value);
        const descriptor = node.attachmentDescriptor(data.attachmentId);
        if (descriptor && descriptor.source === data.peerId && descriptor.sha256 === data.sha256 && descriptor.size === data.size) {
            getSavedRooms().rememberDownload(descriptor, data.path);
            rememberOriginal(descriptor, data.path);
            const pending = pendingSaves.get(descriptor.id);
            if (pending && sameAttachment(pending.descriptor, descriptor)) {
                pendingSaves.delete(descriptor.id);
                void finishSave(descriptor, data.path, pending.target)
                    .then(result => sendToWindow('asscrack:media-saved', { id: descriptor.id, ...result }));
            }
            Promise.resolve(roomMedia.verified(descriptor, data.path)).catch(err => writeLog('WARN', `Verified file preview unavailable: ${err.message}`));
        }
    });
    // Saved rooms (milestone 6): the archive listener comes before the window listener.
    getSavedRooms().attachNode(node);
    // G7a: the friend requests of a protected room. G7b: the common-room path, and the room name for the panel.
    friendLinks.attachRoom(node, { name: roomName ?? '' });
    readRoomActivity = observeRoomActivity(node);
    // Typing goes straight to the window; transient controls never enter diagnostics or the archive.
    onLive('whisper-capability', data => sendToWindow('asscrack:whisper-capability', data));
    onLive('typing', data => sendToWindow('asscrack:typing', data));
    // Ready check (milestone 9): straight to the window, not in the event log (the log must not get the text).
    onLive('ready', data => sendToWindow('asscrack:ready', data));
    // Room music: the view and the notices (titles: not in the event log), and the frames of the DJ (no decode here).
    onLive('music', data => { sendToWindow('asscrack:music', data); musicPopout.view(data); });
    onLive('music-notice', data => { sendToWindow('asscrack:music-notice', data); musicPopout.notice(data); });
    onLive('music-track', data => music.trackDone(data));
    onLive('music-frame', data => {
        mapTraffic.recordMusicFrame(data?.origin);
        if (!idlePeer) sendToWindow('asscrack:music-frame', data);
    });
    // P8b: the screen share events (design section 4, IPC).
    forwardScreenEvents(onLive);
    for (const type of EVENTS) {
        onLive(type, data => {
            if (type === 'voice-frame') mapTraffic.recordVoiceFrame(data?.origin);
            if (type === 'channels') savedRooms?.persistChannels(data.added);
            // G6: the archive gets the signed catalog. The window gets the view only.
            if (type === 'voice-channels') {
                const { catalog, ...view } = data;
                savedRooms?.persistVoiceChannels(catalog);
                logEvent(type, { seq: view.seq, channels: view.channels.length, movedFrom: view.movedFrom?.id });
                sendToWindow('asscrack:voice-channels', view);
                return;
            }
            logEvent(type, data);
            // The diagnostic window reads a redacted projection of these local events.
            if (type === 'connection' || type === 'dial-failed' || (idlePeer && type === 'voice-frame')) return;
            // Diagnostics: the transfer of a bundle is not a row of Transfers (the diagnostics bar shows it).
            if (type.startsWith('file-') && node.isDiagOffer?.(data?.offerId)) return;
            if (type === 'file-progress') mapTraffic.recordFileProgress(data, node.peerId);
            else if (type === 'file-done' || type === 'file-failed' || type === 'file-cancelled' || type === 'file-paused') {
                mapTraffic.recordFileEnd(data);
            }
            if (type === 'file-done' && data?.direction === 'receive') {
                const { path: localPath, ...event } = data;
                const savedName = typeof localPath === 'string' ? path.basename(localPath) : null;
                sendToWindow('asscrack:file-done', { ...event, savedName });
                return;
            }
            const shelfId = type === 'file-offer' ? node.shelfTransfer(data.peerId, data.offerId) : undefined;
            // L3 (P10a): the device marks of the names and the lines (peer-marks.mjs).
            sendToWindow(`asscrack:${type}`, withDeviceMarks(type, shelfId ? { ...data, shelfId } : data, node));
        });
    }
    // The node dials the invite nodes at start and again with the redial timer (option inviteNodes).
    return { peerId: node.peerId, room: options.room, internet: !lan, membership: node.memberState() };
}

// Saved rooms (milestone 6). The archive opens after app ready, before the window (asynchronous safeStorage calls).
let savedRooms = null;
function getSavedRooms() {
    if (!savedRooms) {
        savedRooms = createSavedRooms({
            dir: path.join(app.getPath('userData'), 'saved-rooms'),
            // The safeStorage key of Windows is in "Local State" of the user data folder (saved-rooms.mjs durable()).
            protector: makeProtector(safeStorage, process.platform,
                { localStateFile: path.join(app.getPath('userData'), 'Local State') }),
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
function roomHintFiles(room, roomKey) {
    const dir = path.join(app.getPath('userData'), 'rooms');
    const tag = keyedServiceTag(room, roomKey);
    return { peers: path.join(dir, `${tag}.json`), host: path.join(dir, `${tag}.host.json`) };
}

function deleteHintFiles({ peers, host }) {
    for (const file of [peers, host, `${peers}.tmp`, `${host}.tmp`]) {
        rmSync(file, { force: true });
    }
}

function forgetHints(row) {
    if (row?.name && row?.roomKey) deleteHintFiles(roomHintFiles(row.name, row.roomKey));
    // G4: the listening choices of the room go with it.
    const tag = listeningRoomTag(row?.roomKey);
    if (tag) {
        listeningChoicesStore().removeRoom(tag);
        screenListeningChoicesStore().removeRoom(tag);
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
        const membership = node.membershipSnapshot();
        saveInfo = getSavedRooms().afterLogin({ room: result.room, roomKey, invite, userName, save: save === true, keepHistory, membership });
        if (membership && saveInfo.savedRoom) node.setMembershipPersistence(snapshot => {
            if (!getSavedRooms().persistMembership(snapshot)) throw new Error('Couldn\'t save room access.');
        });
    } catch (err) {
        writeLog('WARN', `Saved rooms: ${err?.message ?? err}`);
        if (save === true) saveInfo.saveError = String(err?.message ?? err);
    }
    try { if (saveInfo.savedRoom) retainRoomHints?.(); }
    catch { writeLog('WARN', 'Saved room address hints could not be stored'); }
    finally { retainRoomHints = null; }
    getSavedRooms().persistChannels(node.channels().channels);
    getSavedRooms().persistVoiceChannels(node.voiceChannelCatalog());
    return { ...result, ...saveInfo };
}

function getAdmissionIdentity() {
    const serialized = getSavedRooms().deviceIdentity(() => createDeviceIdentity().exportPrivate());
    return importDeviceIdentity(serialized);
}

handleRoomIpc('asscrack:device-id', () => getAdmissionIdentity().id);

// The login and the reopen give the user a plain text for an error (login-errors.mjs). The log keeps the original.
async function withLoginErrors(what, options, start, kind = 'reopen') {
    try {
        const result = await start();
        journal('room', { event: 'start', kind, protected: result?.membership?.protected === true, lan: result?.internet === false,
            upnp: options.upnp === true, address: Array.isArray(options.announce) });
        return result;
    } catch (err) {
        journal('room', { event: 'start-failed', kind, reason: loginErrorCode(err) });
        console.warn(`${what} failed: ${err?.message ?? err}`);
        throw new Error(loginErrorText(err, { port: options.port }));
    }
}

handleRoomIpc('asscrack:login', async (_event, fields = {}) => {
    if (loginStarted) throw new Error('Already logged in');
    if (knocking) throw new Error('Wait for the room owner to answer first.');
    const options = { downloadDir: downloadDir ?? app.getPath('downloads'), ...nodeFlags };
    return withLoginErrors('Login', options, () => login(options, fields), ['new', 'lan', 'join'].includes(fields?.type) ? fields.type : undefined);
});

async function login(options, { name, room, type, invite, friendInvite, publicAddress, allowUpnp, allowLegacy, save, keepHistory } = {}) {
    if (typeof name !== 'string' || !name.trim() || name.length > 64) throw new Error('Enter a username of up to 64 characters.');
    options.name = name.trim();
    let lan = false;
    let typedInvite = null;
    if (type === 'join') {
        // easy-join: a Join from a friend invite gives a token. The code stays in the main process.
        if (typeof friendInvite === 'string') {
            invite = friendJoins.code(friendInvite);
            if (!invite) throw new Error('Invite no longer available. Select Join in the friend chat again.');
        }
        if (typeof invite !== 'string' || !invite.trim()) throw new Error('Enter an invite code.');
        if (invite.length > 128 * 1024 + 10) throw new Error('The invite code is too large.');
        // easy-join part 2: a room code. Knock, then join with the device invite of Allow (the normal path below).
        if (isRoomCode(invite)) invite = await knockForInvite(invite, options.name);
        const code = readInvite(invite);
        options.room = code.room;
        options.roomKey = code.key;
        options.inviteNodes = code.nodes;
        typedInvite = invite.trim();
        if (code.membership) {
            const saved = getSavedRooms().getRoom(roomFingerprint(code.room, code.key));
            options.membership = joinAdmission(code, getAdmissionIdentity(), saved);
            lan = options.membership.lan;
        } else {
            if (allowLegacy !== true) throw new Error('Tick “I trust everyone with this code” first.');
            if (getSavedRooms().isProtectedRoom(code.room, code.key)) throw new Error('This room needs a device invite.');
        }
    } else if (type === 'new' || type === 'lan') {
        if (typeof room !== 'string' || !room.trim() || room.length > 64) throw new Error('Enter a room name of up to 64 characters.');
        options.room = room.trim();
        options.roomKey = newRoomKey();
        lan = type === 'lan';
        options.membership = createRoomMembership({ identity: getAdmissionIdentity(), room: options.room, roomKey: options.roomKey, lan });
    } else throw new Error('Choose how to open the room.');
    if (publicAddress !== undefined && (typeof publicAddress !== 'string' || publicAddress.length > 32)) throw new Error('Enter a valid public address.');
    const result = await startRoom(options, { publicAddress: publicAddress?.trim(), allowUpnp: type !== 'lan' && allowUpnp === true, lan });
    return afterRoomStart(result, { invite: typedInvite, userName: options.name, save, keepHistory: keepHistory !== false });
}

// easy-join part 2: the knock of a room code. Returns the device invite of Allow; else throws the text for the user.
// The log gets the result, not the codes.
async function knockForInvite(text, name) {
    const roomCode = readRoomCode(text);
    const saved = getSavedRooms().getRoom(roomFingerprint(roomCode.room, roomCode.key));
    if (saved?.protected) throw new Error('This room is in your saved rooms. Open it there.');
    const identity = getAdmissionIdentity();
    const state = value => sendToWindow('asscrack:knock-state', { state: value, room: roomCode.room });
    knocking = true;
    state('looking');
    try {
        const outcome = await knockRoom({ code: roomCode, identity, name, serviceTag: keyedServiceTag(roomCode.room, roomCode.key),
            onState: state, log: line => writeLog('INFO', line) });
        writeLog('INFO', `Knock result: ${outcome.result}${outcome.reason ? ` (${outcome.reason})` : ''}`);
        journal('knock', { event: 'result', side: 'knocker', route: 'room-code', result: outcome.result, cause: outcome.reason });
        if (outcome.result !== 'allowed') throw new Error(knockResultText(outcome));
        checkAllowedInvite(roomCode, identity, outcome.invite);
        state('allowed');
        return outcome.invite;
    } finally {
        knocking = false;
    }
}

// easy-join part 2: the prompts for the window: [{ id, name, mark }].
function knockView(pending) {
    // 1.0.6: a friend that knocks shows its cached picture (no fetch from a device that is not admitted).
    return (pending ?? []).map(({ id, name, mark, deviceId }) => {
        const avatar = friendLinks.isFriend(deviceId) ? avatars.deviceHash(deviceId) : null;
        return avatar ? { id, name, mark, avatar } : { id, name, mark };
    });
}
queryRoomIpc('asscrack:knocks', () => knockView(node?.knocks()));
handleRoomIpc('asscrack:knock-answer', (_event, id, allow) => {
    if (!node?.memberState().owner) throw new Error('Only the room owner can answer.');
    if (typeof id !== 'string' || id.length > 64) return false;
    const done = node.answerKnock(id, allow === true);
    writeLog('INFO', `Knock ${allow === true ? 'allowed' : 'denied'}${done ? '' : ' (not waiting now)'}`);
    return done;
});
// easy-join part 3: "Always allow my friends" of the owner (the room membership card). Returns the value now.
handleRoomIpc('asscrack:auto-allow-friends', (_event, on) => {
    if (!node?.memberState().owner) throw new Error('Only the room owner can change this setting.');
    const value = node.setAutoAllowFriends(on === true);
    writeLog('INFO', `Always allow my friends: ${value ? 'on' : 'off'}`);
    return value;
});
// "Copy room code" (renew false) and "New room code" (renew true). The main process copies the code.
handleRoomIpc('asscrack:room-code', (_event, renew) => {
    if (!node?.memberState().owner) throw new Error('Only the room owner can make a room code.');
    let made;
    try {
        made = node.roomCode({ renew: renew === true });
    } catch (err) {
        if (/reachable owner address/.test(String(err?.message))) {
            throw new Error('This room cannot be reached from the internet. See Invite for details.');
        }
        throw err;
    }
    clipboard.writeText(made.code);
    writeLog('INFO', renew === true ? 'New room code copied' : 'Room code copied');
    return made;
});

// Saved rooms (milestone 6). The window gets no key, no invite and no file path.
handleRoomIpc('asscrack:saved-rooms', () => getSavedRooms().status());

handleRoomIpc('asscrack:unlock-archive', async () => {
    const result = await getSavedRooms().unlock();
    startFriendLinks();
    return result;
});

// G7a: the friend links start after the archive opens (also on the login screen) and stop at Quit. Leave room, a new
// login and Idle Peer do not stop them. Only the test flags allowPrivateFullNode and fullNode go to the friend nodes.
// 1.0.6: the test flag --friend-test (only in a dev start; friend-links.mjs friendTestOptions): other friend ports, no
// inbound address, no mDNS or no address refresh on the friend nodes. The check scripts use it on this PC.
const friendTestIndex = process.argv.indexOf('--friend-test');
const { listen: friendListen, ...friendTest } = !app.isPackaged && friendTestIndex !== -1 ? friendTestOptions(process.argv[friendTestIndex + 1]) : {};
const friendLinks = createFriendLinks({
    createNode: async options => withAvatars(await createAsscrackNode({ ...options, updates: updates.hub, avatars: avatars.hub })),
    avatarOf: deviceId => avatars.deviceHash(deviceId), hintFiles: (room, roomKey) => roomHintFiles(room, roomKey), log: writeLog,
    nodeOptions: { ...Object.fromEntries(Object.entries(nodeFlags).filter(([name]) => name === 'allowPrivateFullNode' || name === 'fullNode')),
        ...(friendListen ? { listen: friendListen } : {}) },
    ...friendTest
});
// 1.0.6: the friend link events of the journal (diag-events.mjs projectFriendEvent: a device tag, no device ID, no name).
friendLinks.events.on('journal', data => {
    const projected = projectFriendEvent(data, diag?.tagKey());
    if (projected) journal(projected[0], projected[1]);
});
// 1.0.6: a network change of this PC gives new friend tries at once (network-watch.mjs; resume is in app.whenReady).
const networkWatch = createNetworkWatch({ onChange: cause => friendLinks.networkChanged(cause) });
friendLinks.events.on('changed', view => { sendToWindow('asscrack:friends', view); if (tray && !roomName) updateTray(); });
// G7b: the attention of a friend line (live lines one by one, away lines as one batch). The window decides by the
// attention rules (attention.js wanted()); it gets no name and no text.
friendLinks.events.on('line', ({ friendId, line }) => {
    if (line.own || line.away) return;
    sendToWindow('asscrack:friend-attention', { friendId, id: line.id, away: 0, focused: friendWindows.isFocused(friendId) });
});
friendLinks.events.on('away', ({ friendId, batch, count }) => {
    writeLog('INFO', `Friend lines sent while away: ${count}`);
    sendToWindow('asscrack:friend-attention', { friendId, id: batch, away: count, focused: friendWindows.isFocused(friendId) });
});
friendLinks.events.on('request', event => sendToWindow('asscrack:friend-request', event));
const friendWindows = attachFriendWindows({
    BrowserWindow, ipc: ipcMain, assets: __dirname, links: friendLinks, icon: path.join(__dirname, 'img', 'app.ico'),
    warn: message => writeLog('WARN', message), openLink: value => openCheckedLink(value),
    focused: friendId => attention.read({ kind: 'friend', friendId, id: 'focus' }),
    join: async (friendId, id, leave) => {
        const answer = await friendJoins.join(friendId, id, leave);
        // Diagnostics: the Join of a friend invite with its result code (no code, no room name).
        journal('join', { event: 'friend-invite-used', result: answer?.result });
        return answer;
    }
});
// easy-join part 1: Join of a friend invite (friend-join.mjs), and the tray balloon of a new invite.
const friendJoins = createFriendJoins({
    links: friendLinks, room: () => (node ? roomName ?? '' : null), busy: () => Boolean(leaving) || (loginStarted && !node) || knocking,
    leave: () => leaveRoom(),
    reload: () => setImmediate(() => { if (mainWindow && !mainWindow.isDestroyed() && !quitting) mainWindow.webContents.reload(); }),
    show: () => restoreRoomWindow(), notify: () => sendToWindow('asscrack:friend-join', null),
    name: () => friendLinks.list().name ?? '', log: writeLog,
    knocking: on => { knocking = on === true; }, savedRoom: roomId => savedProtectedRoom(roomId)
});
handleRoomIpc('asscrack:friend-join-take', () => friendJoins.take());
// easy-join part 3: true when a saved protected room has this room ID (the announce line of a friend has no key).
function savedProtectedRoom(roomId) {
    try {
        return savedRoomHasId(getSavedRooms(), roomId);
    } catch (err) {
        writeLog('WARN', `Saved rooms not read for a friend Join: ${err?.message ?? err}`);
        return false;
    }
}
// easy-join part 3: Join of a friend row (friend-join.mjs knock()). The window gives only the friend ID. Returns
// { result, room, current?, text? }: text is the knock result text for the user (login-errors.mjs).
handleRoomIpc('asscrack:friend-knock', async (_event, friendId, leave) => {
    if (typeof friendId !== 'string' || friendId.length > 128) return { result: 'gone', room: '' };
    const answer = await friendJoins.knock(friendId, leave === true, {
        onState: state => sendToWindow('asscrack:friend-knock-state', { state, room: friendLinks.joinTarget(friendId).room })
    });
    writeLog('INFO', `Friend Join: ${answer.result}${answer.outcome ? ` (${answer.outcome.result}${answer.outcome.reason ? `, ${answer.outcome.reason}` : ''})` : ''}`);
    // Diagnostics: the result of a friend knock. 'joining' and 'failed' come after Allow.
    if (['knock', 'joining', 'failed'].includes(answer.result)) {
        journal('knock', { event: 'result', side: 'knocker', route: 'friend', result: answer.result === 'knock' ? answer.outcome.result : 'allowed',
            cause: answer.result === 'knock' ? answer.outcome.reason : answer.result === 'failed' ? 'leave-failed' : undefined });
    }
    if (answer.result !== 'knock') return answer;
    return { result: 'knock', room: answer.room, denied: answer.outcome.result === 'denied', text: knockResultText(answer.outcome) };
});
// easy-join part 3: a device invite in the clipboard (clipboard-join.mjs). Main reads the clipboard text only when the
// main window opens or gets the focus. The window gets { id, room }, never the code.
const clipboardJoin = createClipboardJoin({
    readText: () => clipboard.readText(),
    selfId: clipboardSelfId,
    currentRoom: () => (node && roomName !== null ? { room: roomName, roomKey: node.roomKey() } : null),
    busy: () => Boolean(leaving) || (loginStarted && !node) || knocking || quitting,
    store: createAskedStore(path.join(app.getPath('userData'), ASKED_FILE), { log: writeLog }),
    notify: kind => {
        journal('join', { event: 'clipboard-prompt', kind });
        sendToWindow('asscrack:clipboard-join', null);
    },
    join: (code, room, leave) => friendJoins.joinCode(code, room, leave),
    log: writeLog
});
// The device ID only when the protected storage is open and has an identity. This read makes no identity.
function clipboardSelfId() {
    if (friendLinks.state() !== 'open') return null;
    try {
        return importDeviceIdentity(getSavedRooms().deviceIdentity(() => { throw new Error('no identity'); })).id;
    } catch {
        return null;
    }
}
function attachClipboardJoin(win) {
    const check = () => {
        // The window takes the prompt at its start (clipboard-join-ui.js), thus a check during the load is no loss.
        if (!win.isDestroyed() && win.isVisible()) clipboardJoin.check().catch(() => {});
    };
    win.on('focus', check);
    win.webContents.on('did-finish-load', check);
}
handleRoomIpc('asscrack:clipboard-join-take', () => clipboardJoin.take());
handleRoomIpc('asscrack:clipboard-join', async (_event, id, leave) => {
    const answer = await clipboardJoin.join(typeof id === 'string' ? id : '', leave === true);
    journal('join', { event: 'clipboard-join', result: answer?.result });
    return answer;
});
handleRoomIpc('asscrack:clipboard-join-dismiss', (_event, id) => {
    journal('join', { event: 'clipboard-dismiss' });
    clipboardJoin.dismiss(typeof id === 'string' ? id : '');
});
// Diagnostics: a friend invite sent (or queued) and a valid friend invite received. No code, no name, no room name.
friendLinks.events.on('invite-sent', ({ result }) => journal('join', { event: 'friend-invite-sent', result }));
friendLinks.events.on('invite', ({ name, room }) => {
    journal('join', { event: 'friend-invite-received' });
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    showTrayBalloon(`${name || 'A friend'} invited you to ${room}`);
});
// 1.0.1: the Friends window. "Pop out" in the drawer opens it, only in a room. It stays open after Leave room
// and closes with the room window and at Quit.
const friendsPopout = attachFriendsPopout({
    BrowserWindow, ipc: ipcMain, screen, profile: app.getPath('userData'), assets: __dirname, links: friendLinks,
    openChat: friendId => friendWindows.open(friendId), icon: path.join(__dirname, 'img', 'app.ico'),
    nearBounds: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null),
    warn: message => writeLog('WARN', message)
});
handleRoomIpc('asscrack:friends-popout', () => (node ? friendsPopout.open() : false));
registerFriendIpc(handleRoomIpc, {
    links: friendLinks, roomNode: () => node, openChat: friendId => friendWindows.open(friendId), query: queryRoomIpc
});
function startFriendLinks() {
    if (friendLinks.state() === 'open' || quitting) return;
    const archive = getSavedRooms().friendArchive();
    let identity = null;
    if (archive) {
        try { identity = getAdmissionIdentity(); } catch (err) { writeLog('WARN', `Friend links: ${err?.message ?? err}`); }
    }
    friendLinks.start(identity, identity ? archive : null);
}

handleRoomIpc('asscrack:saved-room-lines', (_event, roomId, opts) => {
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
        throw new Error('Couldn\'t read this page of the saved room.');
    }
});

// The presence lines of a saved room: from <= time < to (null: no limit).
handleRoomIpc('asscrack:saved-room-notes', (_event, roomId, range) => {
    if (!validRoomId(roomId)) return [];
    const bound = value => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
    try {
        return getSavedRooms().notes(roomId, { from: bound(range?.from), to: bound(range?.to) });
    } catch (err) {
        writeLog('WARN', `Saved presence lines not read: ${err?.message ?? err}`);
        return [];
    }
});

// A presence line of the open room (transcript-notes.js). A one-way message: a window that closes at Quit gives no
// error line. room-archive.mjs checks each field. During a Quit or a Leave room, the own node stops: the peers go
// with no bye and the window sees "Connection lost.". That line is not a fact of the room, thus it is not saved.
onRoomIpc('asscrack:save-note', (_event, note) => {
    if (!node || quitting || leaving || !note || typeof note !== 'object') return;
    getSavedRooms().saveNote({ id: note.id, kind: note.kind, text: note.text, time: note.time, replaces: note.replaces });
});

handleRoomIpc('asscrack:reopen-room', async (_event, roomId, allowLegacy) => {
    if (loginStarted) throw new Error('Already logged in');
    // easy-join part 2: a knock waits for the owner. A reopen now would make the Allow of the owner fail.
    if (knocking) throw new Error('Wait for the room owner to answer first.');
    if (typeof roomId !== 'string' || roomId.length > 128) throw new Error('Saved room not found');
    // G7a: a friend room is not a saved room of the list. Only its friend link opens it.
    if (getSavedRooms().isFriendRoom(roomId)) throw new Error('Saved room not found');
    const row = getSavedRooms().getRoom(roomId);
    if (!row) throw new Error('Saved room not found');
    const options = {
        name: row.userName ?? '', room: row.name, roomKey: row.roomKey,
        downloadDir: downloadDir ?? app.getPath('downloads'), ...nodeFlags
    };
    const started = withLoginErrors('Reopen', options, () => reopenRoom(row, options, allowLegacy));
    started.then(() => startRunner?.reopened(roomId, true), err => startRunner?.reopened(roomId, false, err?.message));
    return started;
});

async function reopenRoom(row, options, allowLegacy) {
    let lan = false;
    if (row.protected) {
        options.membership = restoreSavedAdmission(row, getAdmissionIdentity());
        lan = options.membership.lan;
    } else if (allowLegacy !== true) throw new Error('Tick “I trust everyone with this code” first.');
    if (row.invite) {
        try {
            options.inviteNodes = readInvite(row.invite).nodes;
        } catch (err) {
            writeLog('WARN', `Saved invite not read: ${err?.message ?? err}`);
        }
    }
    writeLog('INFO', 'Reopen of a saved room');
    const result = await startRoom(options, { reopen: true, lan });
    return afterRoomStart(result, { invite: row.invite, userName: row.userName, save: false, keepHistory: row.keepHistory });
}

// Saved rooms (milestone 6): the room storage controls and Forget.
handleRoomIpc('asscrack:set-keep-history', (_event, roomId, on) => {
    if (!validRoomId(roomId)) throw new Error('Saved room not found');
    return getSavedRooms().setKeepHistory(roomId, on === true);
});

handleRoomIpc('asscrack:saved-room-name', (_event, roomId, name) => {
    if (!validRoomId(roomId)) throw new Error('Saved room not found');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) throw new Error('Enter a username of up to 64 characters.');
    return getSavedRooms().setUserName(roomId, name.trim());
});

handleRoomIpc('asscrack:clear-history', (_event, roomId) => {
    if (!validRoomId(roomId)) throw new Error('Saved room not found');
    const result = getSavedRooms().clear(roomId);
    writeLog('INFO', `Saved history cleared (${result?.cleared ?? 0} rows)`);
    return result;
});

handleRoomIpc('asscrack:forget-room', (_event, roomId) => {
    if (!validRoomId(roomId)) throw new Error('Saved room not found');
    const active = getSavedRooms().activeInfo()?.roomId === roomId;
    const result = getSavedRooms().forget(roomId);
    if (active) clearRoomMedia();
    forgetStartRoom(roomId);
    writeLog('INFO', 'Saved room forgotten');
    return result;
});

// The reach state of the room (gaps A1 and B4): can friends on the internet join it now?
// state: 'lan', 'ready' (a public address), 'upnp-wait', 'upnp-failed' (the last upnp event was 'none') or 'none'.
// reason: the reason of the last upnp event with the state 'none'. proven: this computer is a full node.
function roomReach() {
    const failed = lastUpnp?.state === 'none';
    const reason = failed && typeof lastUpnp.reason === 'string' ? lastUpnp.reason : null;
    const dialback = node.dialbackState?.() ?? { state: 'idle', reason: null };
    let state;
    if (node.roomKey() === null || node.memberState().lan === true) state = 'lan';
    else if (node.publicAddrs().length > 0) state = 'ready';
    else if (node.upnpPending()) state = 'upnp-wait';
    else if (failed) state = 'upnp-failed';
    else state = 'none';
    return {
        state,
        reason: state === 'upnp-failed' ? reason : null,
        proven: node.fullNode(),
        dialback: dialback.state,
        dialbackReason: dialback.state === 'failed' ? dialback.reason : null
    };
}

// Diagnostics: one journal line for each change of the reach state.
let lastReach = null;
function journalReach(reach) {
    const text = JSON.stringify(reach);
    if (text === lastReach) return;
    lastReach = text;
    journal('reach', reach);
}

queryRoomIpc('asscrack:invite', () => {
    if (!node) throw new Error('Not logged in');
    const reach = roomReach();
    journalReach(reach);
    if (node.memberState().protected) return { membership: node.memberState(), reach };
    if (node.roomKey() === null) return { code: null, reason: 'lan', reach };
    const code = node.invite();
    if (code) return { code, reach };
    // While the router can still open a port, the window tells the user to wait (not that a full node is missing).
    return { code: null, reason: node.upnpPending() ? 'upnp-wait' : 'no-full-node', reach };
});

// Gap N2: the owner asks the router for a port in a running room. A saved room keeps the choice for each reopen.
handleRoomIpc('asscrack:enable-upnp', () => {
    if (!node) throw new Error('Not logged in');
    const started = node.enableUpnp();
    if (started) {
        saveUpnpChoice();
        writeLog('INFO', 'UPnP turned on in the room');
    }
    return { started, reach: roomReach() };
});

handleRoomIpc('asscrack:member-invite', (_event, deviceId, canHost) => {
    if (!node?.memberState().owner) throw new Error('Only the room owner can invite devices.');
    if (typeof deviceId !== 'string' || deviceId.length > 128) throw new Error('Enter the friend’s device ID.');
    return node.createMemberInvite(deviceId.trim(), { canHost: canHost === true });
});

handleRoomIpc('asscrack:member-revoke', (_event, deviceId) => {
    if (!node?.memberState().owner) throw new Error('Only the room owner can revoke access.');
    if (typeof deviceId !== 'string' || deviceId.length > 128) throw new Error('Enter a device ID.');
    return node.revokeMember(deviceId.trim());
});

// The window has no clipboard permission (setPermissions allows only the microphone). The main process copies.
handleRoomIpc('asscrack:room-activity', (_event, peerId, transfersOnly) => {
    if (peerId != null && (typeof peerId !== 'string' || !peerId || peerId.length > 128)) return [];
    return readRoomActivity({ peerId: peerId ?? null, transfersOnly: transfersOnly === true });
});
// Gap B5: the pseudonyms of the Recent events lines for up to 64 peer IDs: [{ id, alias }].
handleRoomIpc('asscrack:activity-aliases', (_event, ids) => {
    if (!Array.isArray(ids)) return [];
    const valid = ids.slice(0, 64).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 128);
    const aliases = readRoomActivity.aliases?.(valid) ?? [];
    return valid.map((id, i) => ({ id, alias: aliases[i] })).filter(row => typeof row.alias === 'string');
});
handleRoomIpc('asscrack:copy-text', (_event, text) => {
    if (typeof text !== 'string' || text.length > 10000) throw new Error('Text not copied');
    clipboard.writeText(text);
});

handleRoomIpc('asscrack:full-node', () => {
    if (!node) throw new Error('Not logged in');
    return { self: node.fullNode(), peers: node.fullNodes() };
});

handleRoomIpc('asscrack:whisper-peers', () => node?.whisperPeers() ?? []);
handleRoomIpc('asscrack:whisper-send', (_event, peerId, text, id) => node?.sendWhisper(peerId, text, id) ?? 'unavailable');

handleRoomIpc('asscrack:channels', () => node?.channels());
handleRoomIpc('asscrack:create-channel', (_event, name) => node.createChannel(name));
// G6: the voice channels. Only the room owner edits them; the node throws a plain text error for the window.
handleRoomIpc('asscrack:voice-channels', () => node?.voiceChannels());
handleRoomIpc('asscrack:voice-channel-create', (_event, name) => node.createVoiceChannel(String(name ?? '')));
handleRoomIpc('asscrack:voice-channel-rename', (_event, id, name) => node.renameVoiceChannel(String(id ?? ''), String(name ?? '')));
handleRoomIpc('asscrack:voice-channel-delete', (_event, id) => node.deleteVoiceChannel(String(id ?? '')));
handleRoomIpc('asscrack:send', (_event, text, channelId) => {
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

// One Opus frame of the own microphone. An ipc send, not invoke: 50 frames each second.
onRoomIpc('asscrack:voice-frame', (_event, bytes) => {
    if (!node || idlePeer || !(bytes instanceof Uint8Array)) return;
    try {
        node.sendVoiceFrame(bytes);
    } catch (err) {
        writeLog('WARN', `Voice frame send failed: ${err?.message ?? err}`);
    }
});

// P8b, screenshare (design work package W3): the source list, the pending selection, the capture permission and
// the IPC of the share. The node does the protocol (src/network/screen-share.mjs).
// 1.0.4: on Windows 10 a window that fills a screen is shared as that screen (no capture border), with the guard of
// share-guard.mjs: the viewers get a "Paused" picture while the window is not in front. The guard helper has the
// normal priority: a late pause shows more of the screen.
const windowBorder = windowShareHasBorder(process.platform, os.release());
const screenAudioCapture = createScreenAudioCapture({
    spawn, platform: process.platform, release: os.release(), ownPid: process.pid, log: writeLog
});
const shareGuard = createShareGuard({
    start: (hwnd, handlers) => startHelper({ spawn, script: guardScript(hwnd, process.pid), ...handlers }),
    onChange: state => {
        screenAudioCapture.setPaused(state?.active === true && state?.paused === true);
        sendToWindow('asscrack:screen-guard', state);
    },
    log: writeLog
});
const physicalDisplays = () => screen.getAllDisplays().map(display => {
    const r = screen.dipToScreenRect(null, display.bounds);
    return { id: display.id, rect: { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height } };
});
const screenSources = createScreenSources({
    desktopCapturer,
    isRoomFrame: frame => !!mainWindow && !mainWindow.isDestroyed() && isDesktopFrame(mainWindow, mainWindow.webContents, frame, ROOM_PAGE),
    isIdle: () => idlePeer || quitting || !node,
    log: writeLog,
    windowBorder,
    guard: windowBorder && process.platform === 'win32' ? shareGuard : null,
    displays: physicalDisplays,
    audioCapture: screenAudioCapture,
    onAudioBlock: block => { if (screenOwn && !idlePeer) sendToWindow('asscrack:screen-audio-pcm', block); },
    onAudioEnd: reason => writeLog('EVENT', `screen audio capture ended reason=${reason}`)
});
let screenOwn = false;
// A guard or audio helper with no share after the selection time stops (the share did not start).
let guardExpiry = null;
const SCREEN_STOP_REASONS = new Set(['stopped', 'source', 'error']);
handleRoomIpc('asscrack:screen-sources', () => (node && !idlePeer ? screenSources.list() : []));
handleRoomIpc('asscrack:screen-pick', async (_event, id, quality, options) => {
    clearTimeout(guardExpiry);
    const info = await screenSources.pick(String(id ?? ''), String(quality ?? ''), {
        border: options?.border === true,
        audio: options?.audio === true
    });
    if (info?.guard || info?.audioMode === 'process') {
        guardExpiry = setTimeout(() => {
            if (!screenOwn) {
                shareGuard.close('expired');
                screenAudioCapture.stop();
            }
        }, 15000);
    }
    return info;
});
handleRoomIpc('asscrack:screen-last-quality', () => screenSources.lastQuality());
handleRoomIpc('asscrack:screen-last-audio', () => screenSources.lastAudio());
handleRoomIpc('asscrack:screen-start', (_event, options = {}) => {
    if (!node) throw new Error('Not logged in');
    const size = n => (Number.isInteger(n) && n > 0 && n <= 16384 ? n : undefined);
    return node.startScreenShare({
        preset: String(options?.preset ?? 'auto'),
        width: size(options?.width),
        height: size(options?.height),
        audio: options?.audio === true
    });
});
onRoomIpc('asscrack:screen-stop', (_event, reason) => {
    screenAudioCapture.stop();
    node?.stopScreenShare(SCREEN_STOP_REASONS.has(reason) ? reason : 'stopped');
});
onRoomIpc('asscrack:screen-frame', (_event, frame) => {
    if (!node || idlePeer || !acceptScreenFrame(frame, screenOwn)) return;
    node.sendScreenFrame({ tier: frame.tier, key: frame.key === true, timestampMs: Number(frame.timestampMs), data: frame.data });
});
onRoomIpc('asscrack:screen-audio-frame', (_event, data) => {
    if (!node || idlePeer || !acceptScreenAudioFrame(data, screenOwn)) return;
    node.sendScreenAudioFrame(data);
});
onRoomIpc('asscrack:screen-report', (_event, report) => { if (node && screenOwn) node.reportScreenEncoder(report); });
onRoomIpc('asscrack:screen-size', (_event, size) => { if (node && screenOwn) node.setScreenSize(size ?? {}); });
handleRoomIpc('asscrack:screen-watch', (_event, peerId) => {
    if (!node) throw new Error('Not logged in');
    if (idlePeer) throw new Error('Watching is not available in Idle Peer.');
    return node.watchScreen(String(peerId ?? ''));
});
onRoomIpc('asscrack:screen-unwatch', () => { node?.unwatchScreen(); });
handleRoomIpc('asscrack:screen-audio-watch', (_event, peerId) => {
    if (!node) throw new Error('Not logged in');
    if (idlePeer) throw new Error('Watching is not available in Idle Peer.');
    return node.watchScreenAudio(String(peerId ?? ''));
});
onRoomIpc('asscrack:screen-audio-unwatch', () => { node?.unwatchScreenAudio(); });
onRoomIpc('asscrack:screen-keyreq', () => { node?.requestScreenKey(); });
handleRoomIpc('asscrack:screen-state', () => {
    if (!node) return { own: null, peers: {}, watching: null, maxShares: null };
    const state = node.screenState();
    // The window gets the view, not the internal tier objects of the rate control.
    return { own: state.own ? { shareId: state.own.shareId, preset: state.own.preset, audio: state.own.audio === true, viewers: state.own.viewers } : null,
        peers: state.peers, watching: state.watching, maxShares: state.maxShares };
});
// The forwarding of the screen events of one node (startRoom). 'screen-frame' does not go to the window in Idle Peer.
function forwardScreenEvents(onLiveEvent) {
    onLiveEvent('screen-state', data => {
        if (data?.own) {
            screenOwn = data.sharing === true;
            if (!screenOwn) {
                shareGuard.close('stop');
                screenAudioCapture.stop();
            }
            taskbarFlash.setSharing(screenOwn);
            if (screenOwn) writeLog('EVENT', `screen share started preset ${data.preset}`);
        }
        sendToWindow('asscrack:screen-state', data);
    });
    onLiveEvent('screen-ended', data => {
        writeLog('EVENT', data?.own ? `screen share stopped reason ${data.reason}` : `screen watch ended reason ${data?.reason}`);
        if (data?.own) {
            shareGuard.close('stop');
            screenAudioCapture.stop();
        }
        // The journal lines of the screen events (with the share ID) come from diag-events.mjs (journalNodeEvents).
        sendToWindow('asscrack:screen-ended', data);
    });
    for (const type of ['screen-viewers', 'screen-encoder', 'screen-config', 'screen-audio-ended']) {
        onLiveEvent(type, data => sendToWindow(`asscrack:${type}`, data));
    }
    onLiveEvent('screen-frame', data => { if (!idlePeer) sendToWindow('asscrack:screen-frame', data); });
    onLiveEvent('screen-audio-frame', data => { if (!idlePeer) sendToWindow('asscrack:screen-audio-frame', data); });
}
function resetScreen(current) {
    try {
        current?.stopScreenShare?.('stopped');
        current?.unwatchScreen?.();
        current?.unwatchScreenAudio?.();
    } catch (err) {
        writeLog('WARN', `Screen share stop: ${err?.message ?? err}`);
    }
    screenSources.clear();
    screenAudioCapture.stop();
    screenOwn = false;
    taskbarFlash.setSharing(false);
}

handleRoomIpc('asscrack:set-voice', (_event, state) => {
    if (!node) throw new Error('Not logged in');
    if (idlePeer && state?.inVoice === true) throw new Error('You left voice.');
    const result = node.setVoice(state ?? {});
    inVoice = state?.inVoice === true;
    journal('voice-state', { in: inVoice, muted: state?.muted === true, deafened: state?.deafened === true,
        host: node.host()?.peerId === node.peerId });
    updatePttHook(() => pttHook.setInVoice(inVoice));
    autoStatus.voice();
    return result;
});

// G4: the listening choice of each person, per room, in the profile. The key is the device ID of the room membership.
// A room with no membership has no stable identity of a person (the libp2p peer ID is new at each start): no save.
let listeningChoices = null;
function listeningChoicesStore() {
    listeningChoices ??= listeningStore(path.join(app.getPath('userData'), 'listening.json'));
    return listeningChoices;
}
let screenListeningChoices = null;
function screenListeningChoicesStore() {
    screenListeningChoices ??= listeningStore(path.join(app.getPath('userData'), 'screen-listening.json'),
        { maxVolume: 100, defaultVolume: 80 });
    return screenListeningChoices;
}
function listeningKey(peerId) {
    if (!node || typeof peerId !== 'string' || peerId.length > 128) return null;
    const tag = listeningRoomTag(node.roomKey());
    const device = node.memberDevice(peerId);
    return tag && device ? { tag, device } : null;
}
handleRoomIpc('asscrack:get-listening', (_event, peerId) => {
    const key = listeningKey(peerId);
    if (!key) return null;
    return listeningChoicesStore().get(key.tag, key.device);
});
handleRoomIpc('asscrack:set-listening', (_event, peerId, muted, volume) => {
    const key = listeningKey(peerId);
    if (!key) return false;
    try {
        return listeningChoicesStore().set(key.tag, key.device, { muted, volume });
    } catch (err) {
        writeLog('WARN', `Listening choice not saved: ${err?.message ?? err}`);
        return false;
    }
});
handleRoomIpc('asscrack:get-screen-listening', (_event, peerId) => {
    const key = listeningKey(peerId);
    if (!key) return null;
    return screenListeningChoicesStore().get(key.tag, key.device);
});
handleRoomIpc('asscrack:set-screen-listening', (_event, peerId, muted, volume) => {
    const key = listeningKey(peerId);
    if (!key) return false;
    try {
        return screenListeningChoicesStore().set(key.tag, key.device, { muted, volume });
    } catch (err) {
        writeLog('WARN', `Screen listening choice not saved: ${err?.message ?? err}`);
        return false;
    }
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
handleRoomIpc('asscrack:ptt-status', () => pttHook.status());

// RNNoise (@sapphi-red/web-noise-suppressor): the window gets the worklet URL and the WASM bytes from here.
// The window cannot fetch file: URLs, and the main process reads only these two fixed files of the package.
// I4: the app scheme gives the worklet at a fixed path (see protocol.handle of APP_SCHEME).
handleRoomIpc('asscrack:rnnoise', (_event, simd) => {
    const wasm = require.resolve(`@sapphi-red/web-noise-suppressor/${simd === true ? 'rnnoise_simd.wasm' : 'rnnoise.wasm'}`);
    return { workletUrl: appPage(RNNOISE_WORKLET.slice(1)), wasm: readFileSync(wasm) };
});

handleRoomIpc('asscrack:voice-settings', () => currentVoiceSettings());
handleRoomIpc('asscrack:set-voice-settings', (_event, patch) => {
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

handleRoomIpc('asscrack:topic', () => node?.topic() ?? null);

handleRoomIpc('asscrack:set-topic', (_event, text) => {
    if (!node) throw new Error('Not logged in');
    node.setTopic(text);
});

// Ready check (milestone 9). The node checks the text, the ID and the vote.
handleRoomIpc('asscrack:ready-state', () => node?.readyCheck() ?? null);
handleRoomIpc('asscrack:ready-open', (_event, text) => {
    if (!node) throw new Error('Not logged in');
    return node.openReady(typeof text === 'string' ? text : '');
});
handleRoomIpc('asscrack:ready-vote', (_event, id, vote) => {
    if (!node) throw new Error('Not logged in');
    return node.voteReady(id, vote);
});
handleRoomIpc('asscrack:ready-close', (_event, id) => {
    if (!node) throw new Error('Not logged in');
    return node.closeReady(id);
});

handleRoomIpc('asscrack:host', () => {
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
handleRoomIpc('asscrack:get-share-typing', () => shareTyping);
handleRoomIpc('asscrack:set-share-typing', (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected a sharing preference');
    if (!enabled) node?.setTyping(false);
    // Apply an opt-out immediately even if persistence fails.
    if (!enabled) shareTyping = false;
    writeFileSync(typingPreference + '.tmp', JSON.stringify(enabled));
    renameSync(typingPreference + '.tmp', typingPreference);
    shareTyping = enabled;
    return shareTyping;
});
onRoomIpc('asscrack:typing-edit', (_event, active) => {
    if (!idlePeer && shareTyping && typeof active === 'boolean') node?.setTyping(active);
});

// The same path for a choice of the user and for the automatic status.
function applyPresence({ state, note }) {
    const updated = node.setPresence({ state, note });
    if (node.presence().state === 'dnd') attention.clear();
    // G7b: the friends see the same availability (design F11).
    friendLinks.setAvailability({ state: updated.state, note: updated.note });
    return updated;
}
handleRoomIpc('asscrack:set-presence', (_event, { state, note } = {}) => {
    if (!node) throw new Error('Not logged in');
    const updated = applyPresence({ state, note });
    // A choice of the user wins over the automatic status.
    autoStatus.manual();
    return updated;
});

// 1.0.4: the automatic status (auto-status.mjs). The settings are in the profile. A dev start can give a short Away
// time with --auto-away-ms <ms> for a check.
const autoStatusFile = path.join(app.getPath('userData'), 'auto-status.json');
let autoStatusSettings = readAutoStatus(null);
try { autoStatusSettings = readAutoStatus(JSON.parse(readFileSync(autoStatusFile, 'utf8'))); } catch { /* new profile */ }
const autoAwayIndex = process.argv.indexOf('--auto-away-ms');
const autoAwayMs = !app.isPackaged && autoAwayIndex !== -1 ? Number(process.argv[autoAwayIndex + 1]) : null;
const autoStatus = createAutoStatus({
    presence: () => (node && !leaving ? node.presence() : null),
    setPresence: value => {
        const updated = applyPresence(value);
        sendToWindow('asscrack:own-presence', updated);
        return updated;
    },
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    inVoice: () => inVoice,
    idlePeer: () => idlePeer,
    settings: () => autoStatusSettings,
    // The notification state helper runs only while "Do not disturb in full-screen games" is on.
    startQuns: process.platform === 'win32' ? (onState, onEnd) => startHelper({ spawn, script: qunsScript(process.pid),
        setPriority: pid => os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL),
        onLine: line => { const m = /^q (\d+)$/.exec(line); if (m) onState(Number(m[1])); },
        onExit: info => { writeLog('WARN', `status helper ended code=${info?.code ?? 'none'}`); onEnd(); } }) : null,
    journal: (event, reason) => {
        journal('status', { event, reason });
        writeRaw('EVENT', `status ${event} reason=${reason}`);
    },
    log: writeLog,
    awayMs: () => autoAwayMs
});
handleRoomIpc('asscrack:auto-status', () => autoStatusSettings);
handleRoomIpc('asscrack:set-auto-status', (_event, patch = {}) => {
    const next = { ...autoStatusSettings };
    if (patch?.awayMinutes !== undefined) next.awayMinutes = patch.awayMinutes;
    if (patch?.dndFullscreen !== undefined) next.dndFullscreen = patch.dndFullscreen;
    const checked = readAutoStatus(next);
    if (checked.awayMinutes !== next.awayMinutes || checked.dndFullscreen !== next.dndFullscreen) throw new TypeError('Bad status setting.');
    writeFileSync(autoStatusFile + '.tmp', JSON.stringify(checked));
    renameSync(autoStatusFile + '.tmp', autoStatusFile);
    autoStatusSettings = checked;
    autoStatus.settingsChanged();
    return checked;
});

handleRoomIpc('asscrack:presence', () => {
    return node ? { self: node.presence(), peers: node.peerPresence() } : null;
});

handleRoomIpc('asscrack:topology', () => {
    return node ? node.topology() : null;
});

handleRoomIpc('asscrack:map-traffic', () => {
    return mapTraffic.snapshot(node);
});

handleRoomIpc('asscrack:refresh-shelf', () => node?.refreshShelf());
// L8: the folders that the room never gets a file from: the profile (archive, key files, logs, partials), the
// default profile, and the folder of the release key. The window cannot prove the choice of the user (a drop).
function privateFolders() {
    return [app.getPath('userData'), path.join(app.getPath('appData'), 'ASSCRACK'), path.join(os.homedir(), '.asscrack-release')];
}
function chosenFile(filePath) {
    return checkChosenFile(filePath, { blocked: privateFolders() });
}

// ---- The image menu of the chat (menu.js, chat-media.js) ----
function rememberOriginal(descriptor, file) {
    if (descriptor?.kind !== 'image' || typeof file !== 'string') return;
    localOriginals.delete(descriptor.id);
    localOriginals.set(descriptor.id, file);
    if (localOriginals.size > 512) localOriginals.delete(localOriginals.keys().next().value);
}
// The descriptor of an image line: the live room, or the archive row of a saved room. The window sends the
// descriptor, and the main process uses only a descriptor that it knows.
function imageDescriptor(messageId, ref) {
    if (!ref || typeof ref.id !== 'string') return null;
    const d = node?.attachmentDescriptor(ref.id) ?? savedDownload(messageId, ref.id)?.descriptor ?? null;
    return d && d.kind === 'image' && sameAttachment(d, ref) ? d : null;
}
// The local original, after a new hash check, or null.
async function localImageOriginal(messageId, d) {
    for (const file of [localOriginals.get(d.id), savedDownload(messageId, d.id)?.path]) {
        if (typeof file === 'string' && await roomMedia.canReveal(d, file)) return file;
    }
    return null;
}
async function finishSave(d, source, target) {
    let checked;
    try { checked = checkSaveTarget(target, { blocked: privateFolders() }); }
    catch (err) { return { ok: false, reason: 'target', text: err.message }; }
    const result = await saveVerifiedCopy({ source, target: checked, descriptor: d, fromPeer: d.source !== node?.peerId });
    writeLog(result.ok ? 'EVENT' : 'WARN', `action save-image result ${result.ok ? 'ok' : result.reason}`);
    return result.ok ? { ok: true, name: path.basename(checked) } : { ok: false, reason: result.reason };
}
// Copy image: the checked preview PNG goes to the hidden decoder window. That window copies the image (L7: no decode
// in the main process).
handleRoomIpc('asscrack:media-copy-image', async (_event, ref) => {
    const bytes = roomMedia.previewBytes(ref);
    return bytes ? imageDecoder.copy(bytes) : false;
});
// Save image as: a Save dialog with the original name. With a local original, a copy at once. Else the window starts
// the download of the original (the Download original path), and the file-done listener makes the copy.
handleRoomIpc('asscrack:media-save-image', async (_event, messageId, ref) => {
    const d = imageDescriptor(messageId, ref);
    if (!d) return { ok: false, reason: 'unknown' };
    const name = path.basename(String(d.name)) || 'image';
    let target;
    if (saveTo) target = path.join(saveTo, name);
    else {
        const ext = path.extname(name).slice(1);
        const options = { title: 'Save image as', defaultPath: path.join(downloadDir ?? app.getPath('downloads'), name),
            filters: ext ? [{ name: 'Image', extensions: [ext] }] : [] };
        const { canceled, filePath } = mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
        if (canceled || !filePath) return { ok: false, reason: 'canceled' };
        target = filePath;
    }
    try { checkSaveTarget(target, { blocked: privateFolders() }); }
    catch (err) { return { ok: false, reason: 'target', text: err.message }; }
    const source = await localImageOriginal(messageId, d);
    if (source) return finishSave(d, source, target);
    pendingSaves.set(d.id, { descriptor: d, target });
    return { ok: true, pending: true, name: path.basename(target) };
});
// The window ends a pending save when it cannot start the download.
handleRoomIpc('asscrack:media-save-cancel', (_event, id) => { if (typeof id === 'string') pendingSaves.delete(id); });
// Open original: the local original in the app of Windows for the file type (the descriptor kind is image). With
// --open-links-to, the path goes to that file and no app starts.
handleRoomIpc('asscrack:media-open-original', async (_event, messageId, ref) => {
    const d = imageDescriptor(messageId, ref);
    const file = d ? await localImageOriginal(messageId, d) : null;
    if (!file) return { ok: false };
    if (openLinksTo) { appendFileSync(openLinksTo, `open-original ${file}\n`); return { ok: true }; }
    return { ok: (await shell.openPath(file)) === '' };
});
handleRoomIpc('asscrack:share-file', (_event, filePath) => {
    if (!node || typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Choose a local file to share');
    return node.publishShelfFile(chosenFile(filePath));
});
handleRoomIpc('asscrack:remove-shared-file', (_event, id) => node?.removeShelfFile(id) === true);
handleRoomIpc('asscrack:download-shared-file', (_event, peerId, id) => node?.downloadShelfFile(peerId, id) === true);

handleRoomIpc('asscrack:offer-file', (_event, filePath, recipientId) => {
    if (!node) throw new Error('Not logged in');
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('The file path is not an absolute path');
    const result = node.offerFile(chosenFile(filePath), recipientId);
    Promise.resolve(result).then(offer => logAction('offer-file', offer?.offerId ?? ''), () => {});
    return result;
});

// Clipboard IPC accepts bounded PNG bytes only. Path-backed originals use Electron's native File path.
handleRoomIpc('asscrack:post-media', async (_event, input, caption, channelId, recipientId) => {
    if (!node) throw new Error('Not logged in');
    const staged = input instanceof Uint8Array;
    // L8: a staged clipboard image is in the profile, and the main process made it. Each other path gets the check.
    const filePath = staged ? clipboardImages.stage(input) : chosenFile(input);
    try {
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('A local file is required');
        if (recipientId !== undefined) {
            const offer = await node.offerFile(filePath, recipientId);
            return { offer };
        }
        const { message, offer } = await node.postAttachment(filePath, caption, channelId);
        if (offer.peers) {
            if (staged) clipboardImages.retain(filePath, message.attachment.expires);
            rememberOriginal(message.attachment, filePath);
            Promise.resolve(roomMedia.verified(message.attachment, filePath)).catch(err => writeLog('WARN', `Original preview unavailable: ${err.message}`));
        } else if (staged) clipboardImages.discard(filePath);
        // The image menu: a file of the user stays the own original (a staged image with no receiver is gone).
        else rememberOriginal(message.attachment, filePath);
        return { message: archiveSend(message), offer };
    } catch (err) {
        if (staged) clipboardImages.discard(filePath);
        throw err;
    }
});

handleRoomIpc('asscrack:attachment-available', (_event, id) => node?.attachmentAvailable(id) === true);
handleRoomIpc('asscrack:request-original', (_event, id) => node?.requestOriginal(id) === true);

handleRoomIpc('asscrack:accept-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    logAction('accept-file', String(offerId));
    return node.acceptFile(String(offerId));
});

handleRoomIpc('asscrack:retry-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    logAction('retry-file', String(offerId));
    return node.retryFile(String(offerId));
});

handleRoomIpc('asscrack:refuse-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    logAction('refuse-file', String(offerId));
    return node.refuseFile(String(offerId));
});

handleRoomIpc('asscrack:cancel-file', (_event, offerId, peerId) => {
    if (!node) throw new Error('Not logged in');
    if (peerId !== undefined && peerId !== null && (typeof peerId !== 'string' || peerId.length > 128)) {
        throw new Error('Invalid peer ID');
    }
    const peer = typeof peerId === 'string' ? peerId : undefined;
    logAction('cancel-file', peer === undefined ? String(offerId) : `${offerId} peer ${peer}`);
    return node.cancelFile(String(offerId), peer);
});

// P7b: Pause, Resume and Discard of a received file. The window sends an offer ID or a partial key as text only.
const PARTIAL_KEY = /^[0-9a-f]{64}-(?:0|[1-9]\d{0,15})$/;
const fileOfferId = offerId => {
    if (typeof offerId !== 'string' || offerId.length === 0 || offerId.length > 64) throw new Error('Invalid offer ID');
    return offerId;
};
handleRoomIpc('asscrack:pause-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    logAction('pause-file', fileOfferId(offerId));
    return node.pauseFile(offerId) === true;
});
handleRoomIpc('asscrack:resume-file', (_event, offerId) => {
    if (!node) throw new Error('Not logged in');
    logAction('resume-file', fileOfferId(offerId));
    return node.resumeFile(offerId) === true;
});
handleRoomIpc('asscrack:discard-partial', async (_event, key) => {
    if (!node) throw new Error('Not logged in');
    if (typeof key !== 'string' || !PARTIAL_KEY.test(key)) return false;
    writeLog('EVENT', `action discard-partial size ${key.slice(65)}`);
    return await node.discardPartial(key) === true;
});
handleRoomIpc('asscrack:list-partials', async () => (node ? await node.partials() : []));

// Gap D2: a click on a link in a chat line. The window sends the text of the href only. link-policy.mjs accepts an
// http: or https: URL of 2048 characters or less with a host and no user name or password, at most one each 500 ms.
// All other input: no action and one warning in the log.
const linkPolicy = createLinkPolicy();
handleRoomIpc('asscrack:open-link', (_event, value) => openCheckedLink(value));
// G7a: the friend chat windows use the same link policy.
async function openCheckedLink(value) {
    const result = linkPolicy.check(value);
    if (!result.ok) {
        console.warn(`open-link refused: ${result.reason}`);
        return false;
    }
    if (openLinksTo) {
        appendFileSync(openLinksTo, `${result.href}
`);
        return true;
    }
    await shell.openExternal(result.href);
    return true;
}

// Show in Explorer for a received file. The window sends the key `${offerId}|${peerId}` only, never a path.
// Result: { ok: true }, or { ok: false, reason: 'unknown' } (no received file for the key) or
// { ok: false, reason: 'missing' } (the file was moved or deleted).
handleRoomIpc('asscrack:reveal-file', (_event, key) => {
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

// Stop a node with the limit of 3 s. Quit and Leave room use it. The promise never rejects.
function stopNodeWithin(current) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            console.error('Node stop timed out');
            resolve();
        }, 3000);
    });
    return Promise.race([
        current.stop().catch(err => console.error('Node stop failed:', err)),
        timeout
    ]).finally(() => clearTimeout(timer));
}

// Gap A7: Leave room. Stop the node, reset the room state of the main process, then reload the window. The tray
// and the profile settings stay. A later package (screenshare, ready check) adds its reset here.
function leaveRoom() {
    if (leaving) return leaving;
    if (!node || quitting) return Promise.resolve(false);
    const current = node;
    writeLog('INFO', 'Leave room');
    journal('room', { event: 'leave' });
    voiceMonitor?.dismiss();
    attention.clear();
    stopFlash();
    inVoice = false;
    updatePttHook(() => pttHook.setInVoice(false));
    // Ready check (P9A): the checks of the room end with the room. P7a keeps its partial files in the node: the
    // stop of the node and the clear of the download scratch below cover them. P7b: a paused partial belongs to
    // the profile, not to the room. Its in-memory state (the node store and the window rows) ends with the node
    // and the reload. The files stay in the scratch folder, and the next room of this run uses the same folder.
    try { current.resetReady?.(); } catch (err) { writeLog('WARN', `Ready check reset: ${err?.message ?? err}`); }
    // Room music: the music of the room ends with the room. No URL, local key or folder ID stays.
    try { current.music?.reset(); } catch (err) { writeLog('WARN', `Music reset: ${err?.message ?? err}`); }
    music.reset();
    musicPopout.close();
    // P8b (conflict table of G5): Leave room stops the capture and the watch, and resets the screen state. The window
    // stops its capture track at the screen-state event, and the reload resets the window.
    resetScreen(current);
    leaving = stopNodeWithin(current).then(() => {
        if (node === current) node = null;
        mapTraffic.reset();
        readRoomActivity = () => [];
        receivedFiles.clear();
        restoringDownloads.clear();
        clearRoomMedia();
        clipboardImages.clear();
        downloadScratch?.clear();
        // P7b: clear() keeps a folder with paused partials. createDownloadScratch does not adopt the folder of a
        // live process (this process), thus keep the session while its folder exists.
        if (!downloadScratch || !existsSync(downloadScratch.directory)) downloadScratch = null;
        retainRoomHints = null;
        lastUpnp = null;
        saveUpnpChoice = () => {};
        onLive = () => {};
        roomName = null;
        idlePeer = false;
        try { savedRooms?.leave(); } catch (err) { writeLog('WARN', `Saved rooms leave: ${err?.message ?? err}`); }
        // G7a: the friend links stay. Only the friend requests of the room end. G7b: on the login screen the
        // availability for the friends is 'available'.
        friendLinks.attachRoom(null);
        friendLinks.setAvailability({ state: 'available', note: '', idle: false });
        loginStarted = false;
        updateTray();
        return true;
    }).finally(() => { leaving = null; });
    return leaving;
}

handleRoomIpc('asscrack:leave-room', async () => {
    const left = await leaveRoom();
    // Reload after the reply goes to the window: the reload resets the whole window state.
    if (left && !quitting) setImmediate(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !quitting) mainWindow.webContents.reload();
    });
    return left;
});

// The texts of the Leave room dialog need two facts of the main process: is the room saved, and is this device
// the owner. The window gets no room ID.
handleRoomIpc('asscrack:leave-room-info', () => ({
    saved: savedRooms?.activeInfo() != null,
    owner: node?.memberState().owner === true
}));

app.on('before-quit', event => {
    quitting = true;
    saveBoundsNow();
    voiceMonitor?.dismiss();
    attention.clear();
    clearRoomMedia();
    tray?.destroy();
    tray = null;
    pttHook.stop();
    shareGuard.close('quit');
    screenAudioCapture.stop();
    autoStatus.stop();
    friendWindows.closeAll();
    friendsPopout.close();
    musicPopout.close();
    imageDecoder.dispose();
    musicEval.dispose();
    // Saved rooms (milestone 6): close the archive. G7a: after the friend nodes stop (they write to it).
    const closeArchive = () => {
        if (!savedRooms) return;
        try { savedRooms.close(); } catch (err) { writeLog('WARN', `Saved rooms archive not closed: ${err?.message ?? err}`); }
    };
    if (stopping) return;
    const friends = friendLinks.state() === 'open';
    if (!node && !leaving && !friends) {
        closeArchive();
        clipboardImages.clear();
        downloadScratch?.clear();
        diag?.quit();
        return;
    }
    event.preventDefault();
    stopping = true;
    // A quit during Leave room waits for that stop: the node does not stop two times. The friend nodes stop at the
    // same time, in the same 3 s limit.
    Promise.all([leaving ?? (node ? stopNodeWithin(node) : null), friends ? stopNodeWithin(friendLinks) : null]).finally(() => {
        closeArchive();
        clipboardImages.clear();
        downloadScratch?.clear();
        node = null;
        // Diagnostics: the clean end (app.exit skips will-quit).
        diag?.quit();
        app.exit(0);
    });
});

app.on('window-all-closed', () => app.quit());

function processRuns(pid) {
    try { process.kill(pid, 0); return true; } catch (err) { return err?.code !== 'ESRCH'; }
}

// One data folder: the question of the first start with an empty data folder when %APPDATA%\ASSCRACK has data. This
// run has a hold folder in %TEMP% as user data: Chromium has not opened the new folder (the safeStorage key is in its
// "Local State" file, and it moves with the data). After the answer this run starts the app again and stops.
async function offerMove({ from, to }) {
    writeLog('INFO', 'Data folder: old data found, asking for the move');
    const { response } = await dialog.showMessageBox({
        type: 'question', title: 'ASSCRACK', noLink: true, buttons: ['Move', 'Keep there'], defaultId: 0, cancelId: 1,
        message: `Move your rooms and history to ${to}?`,
        detail: `Your rooms, history, friends and settings are in ${from}.\n\n` +
            'Move: copies them here and removes the old folder.\nKeep there: leaves them, and this copy starts empty.'
    });
    let restart = true;
    if (response === 0) {
        const result = moveOldData({ from, to });
        // The paused partials of the old version in the download folder stay with the moved data.
        if (result.ok) downloadOwner(to, defaultUserData);
        writeLog(result.ok ? 'INFO' : 'WARN', `Data folder: move ${result.ok ? `done, ${result.files} files` : `failed (${result.reason})`}`);
        if (!result.ok) {
            restart = false;
            await dialog.showMessageBox({ type: 'warning', title: 'ASSCRACK', noLink: true, buttons: ['OK'],
                message: 'Your rooms and history did not move.', detail: moveFailedText(result, from) });
        } else if (result.leftover) {
            writeLog('WARN', 'Data folder: the old folder was not removed completely');
            await dialog.showMessageBox({ type: 'info', title: 'ASSCRACK', noLink: true, buttons: ['OK'],
                message: 'Your rooms and history moved.',
                detail: `Some old files are left. You can delete: ${result.leftover}` });
        }
    } else {
        try { writeKeptMarker(to, from); } catch (err) { writeLog('WARN', `Data folder: marker not written: ${err?.message ?? err}`); }
    }
    if (restart) app.relaunch();
    app.exit(0);
}

if (singleInstance && isFirstInstance) {
    // P9B: a second start from the start entry does not open the window.
    app.on('second-instance', (_event, argv) => { if (!argv.includes(START_IDLE_FLAG)) restoreRoomWindow(); });
}

app.whenReady().then(async () => {
    if (!isFirstInstance) return;
    if (moveOffer) { await offerMove(moveOffer); return; }
    cleanHoldFolders(app.getPath('temp'), { alive: processRuns, own: process.pid });
    if (installedBuild) {
        try { if (startEntry.repair(readChoice(startChoiceFile))) writeLog('INFO', 'Start at sign-in: the entry now starts this exe'); }
        catch (err) { writeLog('WARN', `Start at sign-in entry not repaired: ${err?.message ?? err}`); }
    }
    if (profileIndex === -1) clearLegacyDebugLogs(app.getPath('logs'));
    diag?.hookPower(powerMonitor);
    diag?.environment({ screen });
    diag?.startMetrics();
    powerMonitor.on('resume', () => {
        interfaceCache.clear();
        node?.refreshRoutes();
        startRunner?.wake();
        friendLinks.networkChanged('resume');
    });
    networkWatch.start();
    for (const event of ['lock-screen', 'unlock-screen', 'suspend', 'resume']) powerMonitor.on(event, () => autoStatus.power(event));
    autoStatus.start();
    protocol.handle('room-media', request => roomMedia.serve(request));
    protocol.handle(MUSIC_SCHEME, request => music.serve(request));
    // Room music (MU-6): the session of the player script window. The app pages only, no permission, no download.
    const musicEvalSession = session.fromPartition(MUSIC_EVAL_PARTITION);
    musicEvalSession.protocol.handle(APP_SCHEME, createAppHandler({ root: __dirname }));
    musicEvalSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    musicEvalSession.setPermissionCheckHandler(() => false);
    musicEvalSession.on('will-download', event => event.preventDefault());
    const appHandler = createAppHandler({ root: __dirname,
        extra: { [RNNOISE_WORKLET]: require.resolve('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js') } });
    // 1.0.6: /avatar/<hash> and /avatar-pick/<token> (avatars.mjs), else the files of the app.
    protocol.handle(APP_SCHEME, request => avatars.serve(request) ?? appHandler(request));
    installRoomPermissions(session.defaultSession, () => mainWindow, ROOM_PAGE, () => idlePeer,
        () => screenSources.hasPending(), () => screenSources.hasPendingAudio());
    // P8b: getDisplayMedia of the room window gets only the source of the pending selection (design section 2.1).
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => screenSources.handleDisplayMedia(request, callback));
    pttHook.configure(currentVoiceSettings());
    if (anyAlert(attentionPrefs.get()) && process.platform === 'win32' && app.isPackaged) {
        try { registerAlerts(); } catch { writeLog('WARN', 'Windows notification registration unavailable'); }
    }
    // open() never rejects. A failure gives the state locked with the reason open-failed.
    await getSavedRooms().open();
    startFriendLinks();
    createMainWindow();
    if (startIdle) beginStartAtSignIn();
    void updates.startup();
});
