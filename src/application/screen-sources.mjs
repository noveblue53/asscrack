// Screen share, main process part (work-orders/astra/P8/DESIGN.md, sections 2.1, 2.2 and 2.9, package W3).
// The preset table of the picker, the source list, the pending selection and the display media handler.
// Electron is not imported: main.js gives desktopCapturer and the frame check, so that a test can use fakes.
import { MAX_SCREEN_FRAME_BYTES, SCREEN_PRESETS } from '../network/screen-rate.mjs';
import { covers, sameRect } from './share-guard.mjs';
import { hwndOf } from './win-helper.mjs';

// Section 5.
export const SELECTION_MS = 10000;
export const MAX_SOURCES = 40;
export const MAX_SOURCE_NAME = 128;
export const MAX_THUMBNAIL_BYTES = 200 * 1024;
export const THUMBNAIL_SIZE = Object.freeze({ width: 320, height: 180 });

// Section 2.2, the quality select: Auto first, then the ladder from the lowest to the highest preset.
const MAX_PRESET = SCREEN_PRESETS[SCREEN_PRESETS.length - 1];
export const PICKER_QUALITIES = Object.freeze([
    Object.freeze({ id: 'auto', label: 'Auto', width: MAX_PRESET.width, height: MAX_PRESET.height,
        fps: MAX_PRESET.fps, bitrate: MAX_PRESET.bitrate }),
    ...SCREEN_PRESETS.map(p => Object.freeze({ id: p.id, label: p.label, width: p.width, height: p.height, fps: p.fps, bitrate: p.bitrate }))
]);

// Windows 10 draws a yellow border around a window that Windows Graphics Capture captures. Chromium always captures a
// window with WGC and asks for no border, but only Windows 10.0.20348 and later can turn the border off. Chromium
// captures a screen with DXGI duplication before Windows 11 24H2, and with WGC with no border after. Thus on Windows
// before build 20348 only a window share has the border.
export function windowShareHasBorder(platform, release) {
    if (platform !== 'win32') return false;
    const build = Number(String(release ?? '').split('.')[2]);
    return Number.isInteger(build) && build > 0 && build < 20348;
}

const thumbnailSize = thumbnail => {
    try {
        const size = thumbnail?.getSize?.();
        return size && size.width > 0 && size.height > 0 ? `${size.width}x${size.height}` : null;
    } catch { return null; }
};

// 1.0.4: the screen of a window that fills it. state: the first state of the window guard (share-guard.mjs), in
// physical pixels. displays: [{ id, rect }] with the physical rectangle of each display. screens: the listed screen
// sources [{ id, displayId, source }]. Gives the one screen source of the monitor that the window covers, or null.
// A thumbnail size gives only the aspect ratio: a 1280 x 720 window has the thumbnail of a 2560 x 1440 screen.
export function screenForWindow(state, displays, screens) {
    if (!state?.alive || !state.monitor || !covers(state.rect, state.monitor)) return null;
    const matches = (Array.isArray(displays) ? displays : []).filter(d => sameRect(d?.rect, state.monitor));
    if (matches.length !== 1) return null;
    const displayId = String(matches[0].id ?? '');
    if (!displayId) return null;
    const found = (Array.isArray(screens) ? screens : []).filter(s => String(s?.displayId ?? '') === displayId);
    return found.length === 1 ? found[0] : null;
}

export const kindOfSource = id => typeof id !== 'string' ? null : id.startsWith('screen:') ? 'screen' : id.startsWith('window:') ? 'window' : null;

// Section 2.9, limits at the main process: the frame IPC from the window.
export function acceptScreenFrame(frame, shareActive) {
    if (!shareActive || !frame || typeof frame !== 'object') return false;
    const data = frame.data;
    return data instanceof Uint8Array && data.length >= 1 && data.length <= MAX_SCREEN_FRAME_BYTES;
}

// desktopCapturer: { getSources(options) }. isRoomFrame(frame): the frame is the main frame of the room window.
// isIdle(): the app is in Idle Peer. now(): the clock in ms. log(level, text): one line, never with a source name.
// windowBorder: a window share has the yellow border (windowShareHasBorder).
// 1.0.4: guard (share-guard.mjs) and displays() ([{ id, rect }], physical pixels): a window that fills a screen is
// shared as that screen, with the guard. With no guard, a window share stays a window share.
export function createScreenSources({ desktopCapturer, isRoomFrame, isIdle, now = Date.now, log = () => {}, windowBorder = false,
    guard = null, displays = () => [] }) {
    let listed = new Map(); // id -> DesktopCapturerSource of the last list
    let fillCandidates = new Set(); // the window IDs with the thumbnail size of a screen
    let pending = null; // { id, kind, from, source, expires }
    let pickSeq = 0;
    const seqNow = () => pickSeq;
    let lastQuality = 'auto'; // only in memory: a restart gives Auto again (section 2.7)

    async function list() {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: THUMBNAIL_SIZE, fetchWindowIcons: false });
        const entries = [];
        for (const source of Array.isArray(sources) ? sources : []) {
            const kind = kindOfSource(source?.id);
            if (!kind) continue;
            let thumbnail = null;
            try {
                const png = source.thumbnail && !source.thumbnail.isEmpty?.() ? source.thumbnail.toPNG() : null;
                if (png && png.length > 0 && png.length <= MAX_THUMBNAIL_BYTES) thumbnail = new Uint8Array(png);
            } catch { thumbnail = null; }
            entries.push({ id: source.id, kind, name: String(source.name ?? '').slice(0, MAX_SOURCE_NAME), thumbnail, source,
                size: thumbnailSize(source.thumbnail) });
        }
        // Screens first, then windows. The sort keeps the order of the system in each kind.
        const ordered = [...entries.filter(e => e.kind === 'screen'), ...entries.filter(e => e.kind === 'window')].slice(0, MAX_SOURCES);
        listed = new Map(ordered.map(e => [e.id, e.source]));
        // A window that fills a screen (a game in borderless full screen): the thumbnail of the window has the size of
        // the thumbnail of a screen. The window gets the screen ID only when one screen has this size.
        const screensBySize = new Map();
        for (const e of ordered) if (e.kind === 'screen' && e.size) screensBySize.set(e.size, [...(screensBySize.get(e.size) ?? []), e.id]);
        fillCandidates = new Set();
        return ordered.map(({ id, kind, name, thumbnail, size }) => {
            if (kind !== 'window') return { id, kind, name, thumbnail };
            const screens = windowBorder && size ? screensBySize.get(size) ?? [] : [];
            if (screens.length > 0) fillCandidates.add(id);
            return { id, kind, name, thumbnail, fillsScreen: screens.length > 0, screenId: screens.length === 1 ? screens[0] : null };
        });
    }

    // 1.0.4: the screen for a window that fills it, with the guard armed; or null (the window share, with its border).
    async function screenInstead(id, seq) {
        const hwnd = hwndOf(id);
        if (!guard || !windowBorder || hwnd === null || !fillCandidates.has(id)) return null;
        let state;
        try {
            state = await guard.open(hwnd);
        } catch (err) {
            // The guard stopped its helper. A newer pick can have its own run now: no close here.
            log('WARN', `screen guard not started: ${String(err?.message ?? err).slice(0, 80)}`);
            return null;
        }
        if (seqNow() !== seq) return null;
        const screens = [...listed].filter(([sid]) => kindOfSource(sid) === 'screen')
            .map(([sid, source]) => ({ id: sid, displayId: source?.display_id, source }));
        let found = null;
        try { found = screenForWindow(state, displays(), screens); } catch { found = null; }
        if (!found) {
            guard.close('no-fill');
            log('EVENT', 'screen share of a window: the window does not fill one screen');
            return null;
        }
        guard.arm(state.monitor);
        return found;
    }

    // The window sends the ID of the selected source and the quality. The selection is valid for one request in 10 s.
    // options.border: share the window itself, also when it fills a screen (the window then has the border).
    async function pick(id, quality, options = {}) {
        if (isIdle()) throw new Error('Screen sharing is not available in Idle Peer.');
        const preset = PICKER_QUALITIES.find(q => q.id === quality);
        if (!preset) throw new TypeError('Unknown screen quality.');
        const source = typeof id === 'string' ? listed.get(id) : undefined;
        if (!source) throw new Error('This source is not in the list.');
        const seq = ++pickSeq;
        pending = null;
        guard?.close('repick');
        // No await for a source with no guard step: the selection is set before pick returns its promise.
        const screen = options?.border === true || !fillCandidates.has(id) || !guard || !windowBorder ? null : await screenInstead(id, seq);
        if (seq !== pickSeq || isIdle() || !listed.has(id)) {
            if (screen && seq === pickSeq) guard.close('repick');
            throw new Error('The selection changed.');
        }
        pending = screen ? { id: screen.id, kind: 'screen', from: 'window', source: screen.source, expires: now() + SELECTION_MS }
            : { id, kind: kindOfSource(id), from: null, source, expires: now() + SELECTION_MS };
        lastQuality = preset.id;
        const guarded = screen ? guard.state() : null;
        return { name: String(source.name ?? '').slice(0, MAX_SOURCE_NAME), width: preset.width, height: preset.height,
            frameRate: preset.fps, bitrate: preset.bitrate, ...(guarded ? { guard: { paused: guarded.paused, reason: guarded.reason } } : {}) };
    }

    function hasPending() {
        if (pending && now() > pending.expires) pending = null;
        return pending !== null;
    }

    // session.setDisplayMediaRequestHandler. Refuse only with callback(null): callback({}) throws (section 2.1).
    function handleDisplayMedia(request, callback) {
        const selection = hasPending() ? pending : null;
        const refuse = reason => {
            log('EVENT', `screen capture request refused reason=${reason}${selection ? ` kind=${selection.kind}` : ''}`);
            callback(null);
        };
        if (!request || request.audioRequested === true) return refuse('audio');
        if (!isRoomFrame(request.frame)) return refuse('frame');
        if (request.userGesture !== true) return refuse('gesture');
        if (isIdle()) return refuse('idle');
        if (!selection) return refuse('no-selection');
        pending = null;
        log('EVENT', `screen capture request granted kind=${selection.kind}${selection.from ? ` from=${selection.from}` : ''}`);
        callback({ video: selection.source });
    }

    function clear() {
        pickSeq++;
        pending = null;
        listed = new Map();
        fillCandidates = new Set();
        guard?.close('clear');
    }

    return { list, pick, hasPending, handleDisplayMedia, clear, lastQuality: () => lastQuality };
}
