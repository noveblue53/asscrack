// Screen share, main process part (work-orders/astra/P8/DESIGN.md, sections 2.1, 2.2 and 2.9, package W3).
// The preset table of the picker, the source list, the pending selection and the display media handler.
// Electron is not imported: main.js gives desktopCapturer and the frame check, so that a test can use fakes.
import { MAX_SCREEN_FRAME_BYTES, SCREEN_PRESETS } from '../network/screen-rate.mjs';

// Section 5.
export const SELECTION_MS = 10000;
export const MAX_SOURCES = 40;
export const MAX_SOURCE_NAME = 128;
export const MAX_THUMBNAIL_BYTES = 200 * 1024;
export const THUMBNAIL_SIZE = Object.freeze({ width: 320, height: 180 });

// Section 2.2, the quality select: Auto first, then the ladder from the lowest to the highest preset.
const MAX_PRESET = SCREEN_PRESETS[SCREEN_PRESETS.length - 1];
export const PICKER_QUALITIES = Object.freeze([
    Object.freeze({ id: 'auto', label: 'Auto (adapts to each viewer)', width: MAX_PRESET.width, height: MAX_PRESET.height,
        fps: MAX_PRESET.fps, bitrate: MAX_PRESET.bitrate }),
    ...SCREEN_PRESETS.map(p => Object.freeze({ id: p.id, label: p.label, width: p.width, height: p.height, fps: p.fps, bitrate: p.bitrate }))
]);

export const kindOfSource = id => typeof id !== 'string' ? null : id.startsWith('screen:') ? 'screen' : id.startsWith('window:') ? 'window' : null;

// Section 2.9, limits at the main process: the frame IPC from the window.
export function acceptScreenFrame(frame, shareActive) {
    if (!shareActive || !frame || typeof frame !== 'object') return false;
    const data = frame.data;
    return data instanceof Uint8Array && data.length >= 1 && data.length <= MAX_SCREEN_FRAME_BYTES;
}

// desktopCapturer: { getSources(options) }. isRoomFrame(frame): the frame is the main frame of the room window.
// isIdle(): the app is in Idle Peer. now(): the clock in ms. log(level, text): one line, never with a source name.
export function createScreenSources({ desktopCapturer, isRoomFrame, isIdle, now = Date.now, log = () => {} }) {
    let listed = new Map(); // id -> DesktopCapturerSource of the last list
    let pending = null; // { id, kind, source, expires }
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
            entries.push({ id: source.id, kind, name: String(source.name ?? '').slice(0, MAX_SOURCE_NAME), thumbnail, source });
        }
        // Screens first, then windows. The sort keeps the order of the system in each kind.
        const ordered = [...entries.filter(e => e.kind === 'screen'), ...entries.filter(e => e.kind === 'window')].slice(0, MAX_SOURCES);
        listed = new Map(ordered.map(e => [e.id, e.source]));
        return ordered.map(({ id, kind, name, thumbnail }) => ({ id, kind, name, thumbnail }));
    }

    // The window sends the ID of the selected source and the quality. The selection is valid for one request in 10 s.
    function pick(id, quality) {
        if (isIdle()) throw new Error('Screen sharing is not available in Idle Peer.');
        const preset = PICKER_QUALITIES.find(q => q.id === quality);
        if (!preset) throw new TypeError('Unknown screen quality.');
        const source = typeof id === 'string' ? listed.get(id) : undefined;
        if (!source) throw new Error('This source is not in the list.');
        pending = { id, kind: kindOfSource(id), source, expires: now() + SELECTION_MS };
        lastQuality = preset.id;
        return { name: String(source.name ?? '').slice(0, MAX_SOURCE_NAME), width: preset.width, height: preset.height,
            frameRate: preset.fps, bitrate: preset.bitrate };
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
        log('EVENT', `screen capture request granted kind=${selection.kind}`);
        callback({ video: selection.source });
    }

    function clear() {
        pending = null;
        listed = new Map();
    }

    return { list, pick, hasPending, handleDisplayMedia, clear, lastQuality: () => lastQuality };
}
