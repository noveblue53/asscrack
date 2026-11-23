// Native notifications belong to the current room session. Only the most recent target
// in each conversation survives a burst. Nothing from this queue goes to disk or logs.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Settings version 2 (message alerts, 2026-11-22): a grid of rows (chat: every room line, mention, whisper, friend,
// voice: other people join or leave voice) and columns (Sound, Notification). version 1 (1.0.x) had one alerts box that
// was off by default, not by a choice of the user. The first load of a version 1 file turns on the new defaults once.
export const SETTINGS_VERSION = 2;
export const SOUND_KEYS = Object.freeze({ chat: 'chatSound', mention: 'mentionSound', whisper: 'whisperSound',
    friend: 'friendSound', voice: 'voiceSound' });
export const ALERT_KEYS = Object.freeze({ chat: 'chatAlert', mention: 'mentionAlert', whisper: 'whisperAlert',
    friend: 'friendAlert', voice: 'voiceAlert' });
const BOOLEAN_KEYS = ['voiceCues', ...Object.values(SOUND_KEYS), ...Object.values(ALERT_KEYS), 'previews', 'sound',
    'flash', 'background'];
export const ATTENTION_DEFAULTS = Object.freeze({ voiceCues: true, volume: 35,
    chatSound: true, mentionSound: true, whisperSound: true, friendSound: true, voiceSound: true,
    chatAlert: true, mentionAlert: true, whisperAlert: true, friendAlert: true, voiceAlert: false,
    previews: true, sound: false, flash: true, background: true, chatTone: 'soft' });
// The tones of a plain room line (attention.js CHAT_TONES).
export const CHAT_TONES = Object.freeze(['soft', 'chime', 'pop']);

function merge(current, patch) {
    const next = { ...current };
    for (const key of BOOLEAN_KEYS) if (typeof patch?.[key] === 'boolean') next[key] = patch[key];
    if (Number.isInteger(patch?.volume)) next.volume = Math.max(0, Math.min(100, patch.volume));
    if (CHAT_TONES.includes(patch?.chatTone)) next.chatTone = patch.chatTone;
    return next;
}

// A version 1 file: keep the choices that it can contain (own cues, volume, flash, Windows sound, the cues of other
// people and of mentions and whispers). The new defaults go on: every notification row, previews and the cue of
// every message. The old alerts and previews values are not choices (they were the defaults of 1.0.x). messageCues
// false was a choice (its default was true): then the cue of every message stays off too.
export function migrateAttention(saved) {
    if (!saved || typeof saved !== 'object') return { ...ATTENTION_DEFAULTS };
    if (saved.version === SETTINGS_VERSION) return merge(ATTENTION_DEFAULTS, saved);
    const kept = { voiceCues: saved.voiceCues, volume: saved.volume, flash: saved.flash, sound: saved.sound,
        voiceSound: saved.otherVoiceCues, mentionSound: saved.messageCues, whisperSound: saved.messageCues,
        friendSound: saved.messageCues, chatSound: saved.messageCues === false ? false : undefined };
    return merge(ATTENTION_DEFAULTS, kept);
}

export function attentionSettings(file) {
    let current = { ...ATTENTION_DEFAULTS };
    let saved = null;
    try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    current = migrateAttention(saved);
    function write(value) {
        writeFileSync(file + '.tmp', JSON.stringify({ version: SETTINGS_VERSION, ...value }));
        renameSync(file + '.tmp', file);
    }
    // Write the migration one time, so a later start keeps the choices of the user. A failed write does not stop
    // the start: the next start migrates again.
    if (saved && typeof saved === 'object' && saved.version !== SETTINGS_VERSION) try { write(current); } catch {}
    return {
        get: () => ({ ...current }),
        set(patch) {
            const next = merge(current, patch);
            write(next);
            current = next;
            return { ...current };
        }
    };
}

// Gap E1: the overlay dot of the taskbar button. A 16 x 16 BGRA bitmap for nativeImage.createFromBitmap: a red
// dot with a white edge on a clear background. No image file and no count (the window title has the count).
export function overlayDotBitmap() {
    const side = 16;
    const pixels = Buffer.alloc(side * side * 4);
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
            const d = Math.hypot(x + 0.5 - side / 2, y + 0.5 - side / 2);
            const i = (y * side + x) * 4;
            if (d > 7.5) continue;
            const [b, g, r] = d > 6 ? [255, 255, 255] : [40, 40, 220];
            pixels[i] = b; pixels[i + 1] = g; pixels[i + 2] = r; pixels[i + 3] = 255;
        }
    }
    return { buffer: pixels, width: side, height: side };
}

// P8b (design section 2.7): the taskbar overlay while a screen share is on. A red 16 x 16 disc with a white centre
// (the mention dot has a white ring), made in code: the icon files are the work of goal 9.
export function overlayShareBitmap() {
    const side = 16;
    const pixels = Buffer.alloc(side * side * 4);
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
            const d = Math.hypot(x + 0.5 - side / 2, y + 0.5 - side / 2);
            const i = (y * side + x) * 4;
            if (d > 7.5) continue;
            const [b, g, r] = d < 2.5 ? [255, 255, 255] : [30, 30, 230];
            pixels[i] = b; pixels[i + 1] = g; pixels[i + 2] = r; pixels[i + 3] = 255;
        }
    }
    return { buffer: pixels, width: side, height: side };
}

export const WINDOWS_APP_ID = 'com.asscrack.app';
export const WINDOWS_TOAST_ID = '{6CC57D8B-D0F0-4B19-AF70-A15B20DF2658}';

// A portable executable has no installer to register its Start Menu identity.
// Retain a stable target across unpacking to a different temporary folder.
export function registerNotificationShortcut({ appData, executable, args = '', shell }) {
    const dir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const file = path.join(dir, 'ASSCRACK.lnk');
    mkdirSync(dir, { recursive: true });
    const present = existsSync(file);
    if (present) {
        const old = shell.readShortcutLink(file);
        if (old.appUserModelId !== WINDOWS_APP_ID) throw new Error('The Start menu shortcut belongs to another app.');
        if (old.target === executable && (old.args || '') === args &&
            old.toastActivatorClsid?.toLowerCase() === WINDOWS_TOAST_ID.toLowerCase()) return;
    }
    const ok = shell.writeShortcutLink(file, present ? 'update' : 'create', {
        target: executable, args, appUserModelId: WINDOWS_APP_ID, toastActivatorClsid: WINDOWS_TOAST_ID
    });
    if (!ok) throw new Error('Windows couldn\'t add the notification shortcut.');
}

// A display name from the window or the node: no control characters, at most 64 characters.
function cleanName(value) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64) : '';
}

const shortId = value => typeof value === 'string' && value && value.length <= 128;

function targetOf(raw) {
    if (!raw || !shortId(raw.id)) return null;
    if (raw.kind === 'whisper' && shortId(raw.peerId)) return { kind: 'whisper', peerId: raw.peerId, id: raw.id };
    // Message alerts: a mention and a plain room line ('message') of one channel are one conversation. name: the
    // sender name that the room line shows.
    if ((raw.kind === 'mention' || raw.kind === 'message') && shortId(raw.channelId))
        return { kind: raw.kind, channelId: raw.channelId, id: raw.id, name: cleanName(raw.name) };
    // G7b: a friend line (as a whisper). away: the number of lines of a batch that was sent while this device was away.
    if (raw.kind === 'friend' && shortId(raw.friendId)) {
        const away = Number.isInteger(raw.away) && raw.away > 0 && raw.away <= 10000 ? raw.away : 0;
        return { kind: 'friend', friendId: raw.friendId, id: raw.id, away };
    }
    // Message alerts: a different person joins or leaves voice (the row of voice in the settings grid).
    if (raw.kind === 'voice' && shortId(raw.peerId)) return { kind: 'voice', peerId: raw.peerId, id: raw.id, joined: raw.joined === true };
    return null;
}

// The title and the body of a notification (message alerts, operator 2026-11-22): the title tells who and where, the
// body is the text (previews on) or a short text. A whisper and a friend line never show their text: they are private.
// kind: 'mention', 'message', 'whisper', 'friend' or 'voice'. count: the lines since the last notification of this
// conversation; mentions: how many of them are mentions. channel: the channel name with no '#'.
export function noticeText({ kind, name, channel, count = 1, mentions = 0, preview = '', away = 0, joined = true }) {
    const who = cleanName(name) || (kind === 'friend' ? 'A friend' : 'Someone');
    const lines = n => (n > 1 ? `${n} new messages` : 'New message');
    if (kind === 'friend') {
        const body = away > 1 ? `${away} messages while you were away` : away === 1 ? 'Sent while you were away' : lines(count);
        return { title: who, body };
    }
    if (kind === 'whisper') return { title: `${who} (whisper)`, body: lines(count) };
    if (kind === 'voice') return { title: who, body: joined ? 'Joined voice' : 'Left voice' };
    const title = `${who} in #${cleanName(channel) || 'general'}`;
    if (preview) return { title, body: preview };
    if (count > 1) return { title, body: mentions === count ? `${count} new mentions` : lines(count) };
    return { title, body: mentions ? 'Mentioned you' : 'New message' };
}

// The Notification column of the settings grid for a target. A mention that its row does not allow follows the row of
// every message (the window applies the room size rule of that row).
export function alertOn(prefs, target) {
    if (target.kind === 'mention') return prefs.mentionAlert === true || prefs.chatAlert === true;
    if (target.kind === 'message') return prefs.chatAlert === true;
    return prefs[ALERT_KEYS[target.kind]] === true;
}

// The tag of the toasts of one conversation: 16 hex characters (the tag of Windows 10 1607 has at most 16).
export function toastTag(key) {
    return createHash('sha256').update('asscrack-toast/' + key).digest('hex').slice(0, 16);
}

// friendName(friendId): G7b, the nickname of a friend for the text. A friend notification does not belong to the room
// session: the friend links run on the login screen too.
// peerName(peerId) and channelName(channelId): message alerts, the names of the title (from the node).
export function createAttention({ settings, room, quiet, allowed, notify, navigate, friendName = () => '',
    peerName = () => '', channelName = () => '', schedule = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout }) {
    const groups = new Map();
    const seen = new Set();
    // One notification for each conversation: a mention and a plain line of one channel replace each other.
    const keyOf = obj => obj.kind === 'voice' ? 'voice'
        : (obj.kind === 'message' ? 'mention' : obj.kind) + '/' + (obj.friendId ?? obj.peerId ?? obj.channelId);
    const roomOf = target => target.kind === 'friend' ? 'friends' : room();

    function dismiss(key) {
        const group = groups.get(key);
        if (!group) return;
        groups.delete(key);
        cancel(group.timer);
        group.notice?.close();
    }

    function eligible(group) {
        return !!group.room && group.room === roomOf(group.target) && alertOn(settings(), group.target) && !quiet() &&
            allowed(group.target);
    }

    function present(key, group) {
        if (groups.get(key) !== group) return;
        if (!eligible(group)) return dismiss(key);
        const prefs = settings();
        const target = group.target;
        const name = target.kind === 'friend' ? friendName(target.friendId)
            : target.kind === 'whisper' || target.kind === 'voice' ? peerName(target.peerId) : target.name;
        const { title, body } = noticeText({ kind: target.kind, name, channel: target.channelId === 'general' ? 'general'
            : channelName(target.channelId), count: group.count, mentions: group.mentions,
            preview: prefs.previews ? group.preview : '', away: target.away, joined: target.joined });
        group.preview = '';
        group.count = 0;
        group.mentions = 0;
        const shown = { ...group, target: group.target };
        const previous = group.notice;
        group.notice = null;
        previous?.close();
        try {
            // id: the Windows tag of the toast. A toast with the same tag replaces the old one also in the Action
            // Center (close() removes only a toast that is on the screen). A hash: no channel or peer ID in the tag.
            const notice = notify({ title, body, silent: !prefs.sound, id: toastTag(key) });
            group.notice = notice;
            notice.once('click', () => {
                if (groups.get(key) !== group || group.notice !== notice || !eligible(shown)) return;
                // The window gets a routing reference, not the name of the title.
                const { name: _name, ...target } = shown.target;
                dismiss(key);
                navigate(target);
            });
            const closed = () => {
                if (groups.get(key) === group && group.notice === notice) {
                    group.notice = null;
                    if (!group.timer) groups.delete(key);
                }
            };
            notice.once('close', closed);
            notice.once('failed', closed);
            notice.show();
        } catch { dismiss(key); }
    }

    return {
        add(raw) {
            const target = targetOf(raw);
            if (!target) return;
            const key = keyOf(target);
            const identity = key + '/' + target.id;
            if (seen.has(identity)) return;
            seen.add(identity);
            if (seen.size > 2048) seen.delete(seen.values().next().value);
            let group = groups.get(key);
            if (group && group.room !== roomOf(target)) { dismiss(key); group = null; }
            group ??= { room: roomOf(target), count: 0, notice: null, timer: null };
            group.target = target;
            if (!eligible(group)) return dismiss(key);
            if (!groups.has(key) && groups.size >= 64) dismiss(groups.keys().next().value);
            groups.set(key, group);
            group.count++;
            if (target.kind === 'mention') group.mentions = (group.mentions ?? 0) + 1;
            group.preview = (target.kind === 'mention' || target.kind === 'message') && settings().previews &&
                typeof raw.preview === 'string' ? raw.preview.slice(0, 160) : '';
            if (!group.timer) group.timer = schedule(() => {
                group.timer = null;
                present(key, group);
            }, group.notice ? 3000 : 750);
        },
        read(raw) {
            const target = targetOf(raw);
            if (target) dismiss(keyOf(target));
        },
        clear() {
            for (const key of groups.keys()) dismiss(key);
        }
    };
}

// ---- Mute per channel and per room (message alerts, operator 2026-11-22) ----
// A mute stops the cue and the notification of the room lines of a channel (or of all channels and voice of a room).
// mentions: a mention still plays and notifies ("Mentions still notify"). until: the end in ms, or null (until I unmute).
// The file has a hash of the room for each room: no room key, no room name.
export const MUTE_TIMES = Object.freeze(['hour', 'tomorrow', 'forever']);
const MAX_MUTED_ROOMS = 200;
const MAX_MUTED_CHANNELS = 200;

// The end of a mute: 1 hour, the next 08:00 (today before 04:00, else tomorrow), or null.
export function muteUntil(time, now = Date.now()) {
    if (time === 'hour') return now + 3600 * 1000;
    if (time === 'forever') return null;
    if (time !== 'tomorrow') throw new Error('Choose a mute time.');
    const end = new Date(now);
    if (end.getHours() >= 4) end.setDate(end.getDate() + 1);
    end.setHours(8, 0, 0, 0);
    return end.getTime();
}

export function muteActive(entry, now = Date.now()) {
    return !!entry && (entry.until === null || (Number.isFinite(entry.until) && entry.until > now));
}

export function roomMuteId(roomKey, roomName) {
    return createHash('sha256').update('asscrack-mute/' + (roomKey ? 'key/' + roomKey : 'name/' + (roomName ?? ''))).digest('hex').slice(0, 24);
}

function cleanEntry(raw, now) {
    if (!raw || typeof raw !== 'object') return null;
    const until = raw.until === null ? null : Number.isFinite(raw.until) ? raw.until : undefined;
    if (until === undefined) return null;
    const entry = { until, mentions: raw.mentions !== false };
    return muteActive(entry, now) ? entry : null;
}

function cleanRoom(raw, now) {
    const room = cleanEntry(raw?.room, now);
    const channels = {};
    for (const [id, value] of Object.entries(raw?.channels ?? {}).slice(0, MAX_MUTED_CHANNELS)) {
        const entry = typeof id === 'string' && id.length <= 128 ? cleanEntry(value, now) : null;
        if (entry) channels[id] = entry;
    }
    return room || Object.keys(channels).length ? { room, channels } : null;
}

// The mutes of this device (one file). view(roomId): { room, channels } with only the mutes that are on now.
// set(roomId, { scope: 'room' | 'channel', channelId, time, mentions }): time 'off' removes the mute.
export function muteStore(file, clock = () => Date.now()) {
    let rooms = {};
    try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        for (const [id, value] of Object.entries(saved?.rooms ?? {})) {
            const room = /^[0-9a-f]{24}$/.test(id) ? cleanRoom(value, clock()) : null;
            if (room) rooms[id] = room;
        }
    } catch {}
    const view = roomId => {
        const room = cleanRoom(rooms[roomId], clock());
        return room ? { room: room.room, channels: room.channels } : { room: null, channels: {} };
    };
    return {
        view,
        set(roomId, request) {
            if (!/^[0-9a-f]{24}$/.test(roomId ?? '')) throw new Error('Open a room first.');
            const scope = request?.scope;
            const channelId = request?.channelId;
            if (scope !== 'room' && !(scope === 'channel' && typeof channelId === 'string' && channelId && channelId.length <= 128))
                throw new Error('Choose a channel or the room.');
            const now = clock();
            const entry = request.time === 'off' ? null : { until: muteUntil(request.time, now), mentions: request.mentions !== false };
            const next = { ...rooms };
            const room = cleanRoom(next[roomId], now) ?? { room: null, channels: {} };
            if (scope === 'room') room.room = entry;
            else if (entry) room.channels = { ...room.channels, [channelId]: entry };
            else { room.channels = { ...room.channels }; delete room.channels[channelId]; }
            if (room.room || Object.keys(room.channels).length) next[roomId] = room;
            else delete next[roomId];
            const ids = Object.keys(next);
            for (const id of ids.slice(0, Math.max(0, ids.length - MAX_MUTED_ROOMS))) delete next[id];
            writeFileSync(file + '.tmp', JSON.stringify({ v: 1, rooms: next }));
            renameSync(file + '.tmp', file);
            rooms = next;
            return view(roomId);
        }
    };
}
