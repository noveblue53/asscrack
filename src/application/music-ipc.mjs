// Room music: the IPC of the room window and the sources of the DJ in the main process (MU-5, MU-6, MU-7).
// - The window gives a link text, an item ID or a folder file ID. The main process parses the link (music.mjs: only a
//   video ID or a playlist ID goes on), keeps each local path, and gives the window opaque asscrack-music:// URLs.
// - Local files only from the own pick of this user: the file dialog (or the test option --music-pick) and the music
//   folder of the settings, each with the L8 path rules (chosenFile).
// - The journal gets the kind of each music event, never a title, a link, an ID or a path.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseYouTubeLink } from '../network/music.mjs';
import { AUDIO_TYPES, audioType, createMusicMedia, listFolder } from './music-media.mjs';
import { createYouTubeSource } from './music-source.mjs';
import * as musicSettings from './music-settings.mjs';

const MAX_LOCALS = 1000;
const KINDS = ['refused', 'unavailable', 'error'];

// handle(channel, fn) and on(channel, fn): the room IPC of main.js. getNode(): the live node or null. getWindow(): the
// room window. dialog: of Electron. chosenFile(path): the L8 check (throws). settingsFile(): the path of
// music-settings.json. journal(type, fields), log(level, text). pick: the files of --music-pick, or null.
// evaluate(code): the sandbox of the YouTube player script (music-eval.mjs). idle(): true while Idle Peer.
export function attachMusic({ handle, on, getNode, getWindow = () => null, dialog, chosenFile, settingsFile, journal = () => {},
    log = () => {}, pick = null, evaluate, idle = () => false, fetch = globalThis.fetch, loadYouTube } = {}) {
    let streamError = null;
    const media = createMusicMedia({ fetch, onError: (kind, detail) => {
        streamError = kind;
        log('WARN', `Music: YouTube part failed: ${detail ?? kind}`);
    } });
    const youtube = createYouTubeSource({ evaluate, fetch, log, ...(loadYouTube ? { load: loadYouTube } : {}) });
    // key -> the path of a local file that this user chose (the DJ).
    const locals = new Map();
    // id -> the path of a file of the music folder (the last list that the window got).
    let folderFiles = new Map();
    let settings = null;
    let openedAt = 0;
    let current = null;

    const node = () => {
        const n = getNode();
        if (!n?.music) throw new Error('Join a room first.');
        return n.music;
    };
    const currentSettings = () => (settings ??= musicSettings.load(settingsFile()));
    const source = item => (item?.src === 'yt' ? 'youtube' : 'file');

    function keep(file) {
        const key = randomUUID();
        locals.set(key, file);
        while (locals.size > MAX_LOCALS) locals.delete(locals.keys().next().value);
        return key;
    }

    // Checked audio files: [{ title, local }]. A file that fails a rule is left out.
    function localItems(files) {
        const items = [];
        for (const file of files) {
            try {
                const checked = chosenFile(file);
                if (!audioType(checked)) continue;
                items.push({ title: path.basename(checked, path.extname(checked)), local: keep(checked) });
            } catch (err) {
                log('WARN', `Music file not added: ${err?.message ?? err}`);
            }
        }
        return items;
    }

    function addLocal(files) {
        const items = localItems(files);
        if (!items.length) return { ok: false, kind: 'error' };
        return node().addLocal(items);
    }

    handle('asscrack:music-state', () => getNode()?.music?.state() ?? null);

    handle('asscrack:music-add', async (_event, text) => {
        const parsed = parseYouTubeLink(String(text ?? ''));
        if (parsed.error) return { ok: false, kind: parsed.error };
        const result = await node().add(parsed);
        if (result?.ok === false && KINDS.includes(result.kind)) journal('music', { event: 'error', source: 'youtube', kind: result.kind });
        return result;
    });

    handle('asscrack:music-add-files', async () => {
        node();
        let files = pick;
        if (!files) {
            const win = getWindow();
            const options = { title: 'Add music', properties: ['openFile', 'multiSelections'],
                filters: [{ name: 'Audio', extensions: Object.keys(AUDIO_TYPES).map(ext => ext.slice(1)) }] };
            const result = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
            if (result.canceled) return { ok: false, kind: 'canceled' };
            files = result.filePaths;
        }
        return addLocal(files.slice(0, 200));
    });

    async function folderView() {
        const folder = currentSettings().folder;
        if (!folder) return { folder: '', files: [] };
        let entries = [];
        try { entries = await listFolder(folder); } catch (err) { log('WARN', `Music folder not read: ${err?.code ?? err?.message ?? err}`); }
        folderFiles = new Map(entries.map(entry => [randomUUID(), entry.file]));
        const names = new Map(entries.map(entry => [entry.file, entry.name]));
        return { folder: path.basename(folder) || folder, files: [...folderFiles].map(([id, file]) => ({ id, name: names.get(file) })) };
    }

    handle('asscrack:music-folder', () => folderView());

    handle('asscrack:music-choose-folder', async () => {
        const win = getWindow();
        const options = { title: 'Music folder', properties: ['openDirectory'] };
        const result = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        if (result.canceled || !result.filePaths?.[0]) return folderView();
        settings = musicSettings.save(settingsFile(), { ...currentSettings(), folder: result.filePaths[0] });
        return folderView();
    });

    handle('asscrack:music-add-folder-file', (_event, id) => {
        const file = folderFiles.get(String(id));
        if (!file) throw new Error('This file is not in the music folder.');
        return addLocal([file]);
    });

    handle('asscrack:music-skip', () => node().skip());
    handle('asscrack:music-pause', (_event, paused) => node().pause(paused === true));
    handle('asscrack:music-remove', (_event, id) => node().remove(String(id)));
    handle('asscrack:music-move', (_event, id, to) => node().move(String(id), Number(to)));
    handle('asscrack:music-stop', () => {
        const view = node().stop();
        media.clear();
        return view;
    });

    // The DJ window asks for the URL of the current item. Gives { url } or { error: kind }.
    handle('asscrack:music-open', async (_event, id) => {
        const music = node();
        const item = music.playing();
        if (!item || item.id !== String(id)) return { error: 'error' };
        media.clear();
        streamError = null;
        openedAt = Date.now();
        current = item;
        if (item.src === 'file') {
            const file = locals.get(item.local);
            let url = null;
            try { url = file ? media.addFile(chosenFile(file)) : null; } catch { url = null; }
            // The window reports the error (music-failed), which journals it.
            if (!url) return { error: 'error' };
            journal('music', { event: 'start', source: 'file', ms: Date.now() - openedAt });
            return { url };
        }
        try {
            const stream = await youtube.stream(item.video);
            const url = media.addYouTube(stream);
            if (!url) throw Object.assign(new Error('no stream'), { kind: 'unavailable' });
            journal('music', { event: 'start', source: 'youtube', ms: Date.now() - openedAt });
            return { url };
        } catch (err) {
            const kind = KINDS.includes(err?.kind) ? err.kind : 'unavailable';
            log('WARN', `Music: YouTube ${kind}`);
            return { error: kind };
        }
    });

    on('asscrack:music-ended', (_event, id) => getNode()?.music?.ended(String(id)));
    on('asscrack:music-failed', (_event, id, kind) => {
        const n = getNode();
        if (!n?.music) return;
        const item = n.music.playing();
        if (item?.id !== String(id)) return;
        // A YouTube stream that the main process could not fetch has its own kind.
        const k = item.src === 'yt' && streamError ? streamError : KINDS.includes(kind) ? kind : 'error';
        journal('music', { event: 'error', source: source(item), kind: k });
        n.music.failed(String(id), k);
    });
    on('asscrack:music-progress', (_event, id, pos) => getNode()?.music?.progress(String(id), Number(pos)));
    on('asscrack:music-frame', (_event, bytes) => {
        const n = getNode();
        if (!n || idle() || !(bytes instanceof Uint8Array) || bytes.length > 4000) return;
        try { n.sendMusicFrame(bytes); } catch (err) { log('WARN', `Music frame send failed: ${err?.message ?? err}`); }
    });

    handle('asscrack:music-settings', () => {
        const { volume, ducking } = currentSettings();
        return { volume, ducking };
    });
    handle('asscrack:set-music-settings', (_event, patch) => {
        settings = musicSettings.save(settingsFile(), musicSettings.merge(currentSettings(), patch));
        return { volume: settings.volume, ducking: settings.ducking };
    });

    // The node event 'music-track' of the DJ: the end, a skip (also by a member) and the Stop of a track. An error has
    // its kind at music-open or music-failed.
    function trackDone({ source: kind, reason } = {}) {
        if (['end', 'skip', 'stop'].includes(reason)) journal('music', { event: reason, source: kind });
    }

    // Leave room: no URL, no local key and no folder ID stays.
    function reset() {
        media.clear();
        locals.clear();
        folderFiles = new Map();
        current = null;
    }

    return { reset, trackDone, serve: request => media.serve(request), resolve: request => youtube.describe(request), current: () => current };
}
