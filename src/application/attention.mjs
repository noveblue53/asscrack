// Native notifications belong to the current room session. Only the most recent target
// in each conversation survives a burst. Nothing from this queue goes to disk or logs.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const defaults = Object.freeze({ voiceCues: true, otherVoiceCues: true, messageCues: true, volume: 35, alerts: false,
    previews: false, sound: false, flash: true });

export function attentionSettings(file) {
    function merge(current, patch) {
        const next = { ...current };
        for (const key of ['voiceCues', 'otherVoiceCues', 'messageCues', 'alerts', 'previews', 'sound', 'flash']) {
            if (typeof patch?.[key] === 'boolean') next[key] = patch[key];
        }
        if (Number.isInteger(patch?.volume)) next.volume = Math.max(0, Math.min(100, patch.volume));
        return next;
    }
    let current = { ...defaults };
    try { current = merge(defaults, JSON.parse(readFileSync(file, 'utf8'))); } catch {}
    return {
        get: () => ({ ...current }),
        set(patch) {
            const next = merge(current, patch);
            writeFileSync(file + '.tmp', JSON.stringify(next));
            renameSync(file + '.tmp', file);
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
    if (!ok) throw new Error('Windows could not register the notification shortcut.');
}

function targetOf(raw) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 128) return null;
    if (raw.kind === 'whisper' && typeof raw.peerId === 'string' && raw.peerId && raw.peerId.length <= 128)
        return { kind: 'whisper', peerId: raw.peerId, id: raw.id };
    if (raw.kind === 'mention' && typeof raw.channelId === 'string' && raw.channelId && raw.channelId.length <= 128)
        return { kind: 'mention', channelId: raw.channelId, id: raw.id };
    // G7b: a friend line (as a whisper). away: the number of lines of a batch that was sent while this device was away.
    if (raw.kind === 'friend' && typeof raw.friendId === 'string' && raw.friendId && raw.friendId.length <= 128) {
        const away = Number.isInteger(raw.away) && raw.away > 0 && raw.away <= 10000 ? raw.away : 0;
        return { kind: 'friend', friendId: raw.friendId, id: raw.id, away };
    }
    return null;
}

// G7b: the text of a friend notification. name: the nickname of the friend (from the main process, not the window).
export function friendNotice(name, count, away) {
    const who = name || 'A friend';
    if (away > 0) return away === 1 ? `${who} sent you a message while you were away.` : `${who} sent you ${away} messages while you were away.`;
    return count > 1 ? `${count} new private messages from ${who}` : `New private message from ${who}`;
}

// friendName(friendId): G7b, the nickname of a friend for the text. A friend notification does not belong to the room
// session: the friend links run on the login screen too.
export function createAttention({ settings, room, quiet, allowed, notify, navigate, friendName = () => '',
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout }) {
    const groups = new Map();
    const seen = new Set();
    const keyOf = obj => obj.kind + '/' + (obj.friendId ?? obj.peerId ?? obj.channelId);
    const roomOf = target => target.kind === 'friend' ? 'friends' : room();

    function dismiss(key) {
        const group = groups.get(key);
        if (!group) return;
        groups.delete(key);
        cancel(group.timer);
        group.notice?.close();
    }

    function eligible(group) {
        return !!group.room && group.room === roomOf(group.target) && settings().alerts && !quiet() && allowed(group.target);
    }

    function present(key, group) {
        if (groups.get(key) !== group) return;
        if (!eligible(group)) return dismiss(key);
        const prefs = settings();
        const privateMessage = group.target.kind === 'whisper';
        let body = privateMessage ? 'New private message' : 'You were mentioned';
        if (group.count > 1) body = privateMessage ? group.count + ' new private messages' : group.count + ' new mentions';
        else if (!privateMessage && prefs.previews && group.preview) body = group.preview;
        if (group.target.kind === 'friend') body = friendNotice(friendName(group.target.friendId), group.count, group.target.away);
        group.preview = '';
        group.count = 0;
        const shown = { ...group, target: group.target };
        const previous = group.notice;
        group.notice = null;
        previous?.close();
        try {
            const notice = notify({ title: 'ASSCRACK', body, silent: !prefs.sound });
            group.notice = notice;
            notice.once('click', () => {
                if (groups.get(key) !== group || group.notice !== notice || !eligible(shown)) return;
                const target = shown.target;
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
            group.preview = target.kind === 'mention' && settings().previews && typeof raw.preview === 'string'
                ? raw.preview.slice(0, 160) : '';
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
