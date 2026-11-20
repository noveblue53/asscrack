// Native notifications belong to the current room session. Only the most recent target
// in each conversation survives a burst. Nothing from this queue goes to disk or logs.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const defaults = Object.freeze({ voiceCues: true, volume: 35, alerts: false, previews: false, sound: false });

export function attentionSettings(file) {
    function merge(current, patch) {
        const next = { ...current };
        for (const key of ['voiceCues', 'alerts', 'previews', 'sound']) {
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
        if (old.appUserModelId !== WINDOWS_APP_ID) throw new Error('The ASSCRACK Start Menu shortcut already belongs to another app.');
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
    return null;
}

export function createAttention({ settings, room, quiet, allowed, notify, navigate,
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout }) {
    const groups = new Map();
    const seen = new Set();
    const keyOf = obj => obj.kind + '/' + (obj.peerId ?? obj.channelId);

    function dismiss(key) {
        const group = groups.get(key);
        if (!group) return;
        groups.delete(key);
        cancel(group.timer);
        group.notice?.close();
    }

    function eligible(group) {
        return !!group.room && group.room === room() && settings().alerts && !quiet() && allowed(group.target);
    }

    function present(key, group) {
        if (groups.get(key) !== group) return;
        if (!eligible(group)) return dismiss(key);
        const prefs = settings();
        const privateMessage = group.target.kind === 'whisper';
        let body = privateMessage ? 'New private message' : 'You were mentioned';
        if (group.count > 1) body = privateMessage ? group.count + ' new private messages' : group.count + ' new mentions';
        else if (!privateMessage && prefs.previews && group.preview) body = group.preview;
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
            if (group && group.room !== room()) { dismiss(key); group = null; }
            group ??= { room: room(), count: 0, notice: null, timer: null };
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
