// Room music: the bytes of the current track for the window of the DJ (MU-5). The window plays an opaque URL of the
// scheme asscrack-music:// in an <audio> element; Chromium decodes it in the renderer, never in the main process.
// - A local file: only a file of the own pick of the DJ (the file dialog or the music folder), with the L8 path rules
//   (file-choice.mjs checkChosenFile). The handler pins each response to the opened file.
// - A YouTube track: the main process fetches the audio-only stream of googlevideo.com in parts of CHUNK bytes (with the
//   range parameter of YouTube) and gives it to the window. Only an https URL of a googlevideo.com host.
// Each URL has a random token. The tokens go away at the next track, at Leave room and at Stop.
import { open, lstat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { APP_ORIGIN } from './app-scheme.mjs';
import { byteRange, mediaBody } from './room-media.mjs';

export const MUSIC_SCHEME = 'asscrack-music';
// stream: true lets Chromium read the media in parts (the same privileges as room-media).
export const MUSIC_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true };
export const AUDIO_TYPES = Object.freeze({
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
    '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.webm': 'audio/webm', '.weba': 'audio/webm'
});
// The files of the music folder that the window gets (the names only), and the size of one YouTube part.
export const FOLDER_MAX = 500;
export const CHUNK = 1024 * 1024;
const MAX_TOKENS = 8;
const TOKEN = /^\/([0-9a-f-]{36})$/;

export const audioType = file => AUDIO_TYPES[path.extname(String(file)).toLowerCase()] ?? null;

// A googlevideo.com stream URL of youtubei.js, or null.
export function youtubeStreamUrl(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return /(^|\.)googlevideo\.com$/i.test(url.hostname) ? url : null;
}

const failed = (status, headers = {}) => new Response(null, { status, headers });

// fetch: the fetch of YouTube parts (a test gives a fake). onError(kind): a part of a YouTube stream failed.
export function createMusicMedia({ fetch = globalThis.fetch, onError = () => {} } = {}) {
    const routes = new Map();
    const streams = new Set();

    function add(route) {
        const token = randomUUID();
        routes.set(token, route);
        while (routes.size > MAX_TOKENS) routes.delete(routes.keys().next().value);
        return `${MUSIC_SCHEME}://track/${token}`;
    }

    // file: a path that checkChosenFile accepted. Gives the URL, or null for a file with no audio type.
    function addFile(file) {
        const mime = audioType(file);
        return mime ? add({ kind: 'file', file, mime }) : null;
    }

    // stream: { url, mime, size, headers } of the YouTube source. Gives the URL, or null for a URL that is not googlevideo.com.
    function addYouTube({ url, mime, size, headers = {} }) {
        const checked = youtubeStreamUrl(url);
        if (!checked || typeof mime !== 'string' || !/^audio\/[a-z0-9.+-]+/i.test(mime)) return null;
        return add({ kind: 'yt', url: checked.toString(), mime: mime.split(';')[0].trim(), size: Number.isSafeInteger(size) && size > 0 ? size : null,
            headers: { ...headers } });
    }

    function clear() {
        routes.clear();
        for (const stream of streams) stream.destroy?.();
        streams.clear();
    }

    function baseHeaders(mime) {
        return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'",
            'Access-Control-Allow-Origin': APP_ORIGIN, 'Content-Type': mime, 'Accept-Ranges': 'bytes' };
    }

    async function serveFile(request, route) {
        let fh;
        try {
            const before = await lstat(route.file, { bigint: true });
            if (!before.isFile()) return failed(404);
            fh = await open(route.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
            const st = await fh.stat({ bigint: true });
            if (st.ino !== before.ino || st.size !== before.size) return failed(410);
            const size = Number(st.size);
            const range = request.headers.get('Range');
            const part = byteRange(range, size);
            if (!part) return failed(416, { 'Content-Range': `bytes */${size}` });
            const headers = baseHeaders(route.mime);
            headers['Content-Length'] = String(part.end - part.start + 1);
            if (range) headers['Content-Range'] = `bytes ${part.start}-${part.end}/${size}`;
            const status = range ? 206 : 200;
            if (request.method === 'HEAD') return new Response(null, { status, headers });
            const stream = fh.createReadStream({ start: part.start, end: part.end, autoClose: true, signal: request.signal });
            fh = null;
            streams.add(stream);
            stream.once('close', () => streams.delete(stream));
            return new Response(mediaBody(stream), { status, headers });
        } catch {
            return failed(410);
        } finally {
            await fh?.close().catch(() => {});
        }
    }

    // One part of the YouTube stream: [start, end] (end inclusive). Gives the response body, or throws.
    // A redirect is followed only to a googlevideo.com URL, at most 3 times.
    async function fetchPart(route, start, end, signal) {
        let url = `${route.url}&range=${start}-${end}`;
        for (let hop = 0; hop < 4; hop++) {
            const response = await fetch(url, { headers: route.headers, signal, redirect: 'manual' });
            if (response.status >= 300 && response.status < 400) {
                const next = youtubeStreamUrl(new URL(response.headers.get('location') ?? '', url).toString());
                await response.body?.cancel?.().catch?.(() => {});
                if (!next) break;
                url = next.toString();
                continue;
            }
            if (!response.ok || !response.body) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
            return response.body;
        }
        throw Object.assign(new Error('redirect'), { status: 0 });
    }

    async function serveYouTube(request, route) {
        const size = route.size;
        const rangeHeader = request.headers.get('Range');
        const part = size ? byteRange(rangeHeader, size) : { start: 0, end: null };
        if (!part) return failed(416, { 'Content-Range': `bytes */${size}` });
        const headers = baseHeaders(route.mime);
        const status = rangeHeader && size ? 206 : 200;
        if (size) {
            headers['Content-Length'] = String(part.end - part.start + 1);
            if (rangeHeader) headers['Content-Range'] = `bytes ${part.start}-${part.end}/${size}`;
        }
        if (request.method === 'HEAD') return new Response(null, { status, headers });
        const abort = new AbortController();
        request.signal?.addEventListener?.('abort', () => abort.abort());
        // The first part before the response: a refused stream gives an error status to the window.
        let position = part.start;
        const last = part.end ?? Number.MAX_SAFE_INTEGER;
        let reader;
        try {
            const end = Math.min(last, position + CHUNK - 1);
            reader = (await fetchPart(route, position, end, abort.signal)).getReader();
        } catch (err) {
            onError(err?.status === 403 || err?.status === 410 ? 'refused' : 'unavailable');
            return failed(502);
        }
        let partEnd = Math.min(last, position + CHUNK - 1);
        const handle = { destroy: () => abort.abort() };
        streams.add(handle);
        const body = new ReadableStream({
            async pull(controller) {
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (!done) {
                            position += value.byteLength;
                            controller.enqueue(value);
                            return;
                        }
                        // The part ended. An unknown size ends at a short part.
                        if (position > last || (part.end === null && position <= partEnd)) {
                            streams.delete(handle);
                            controller.close();
                            return;
                        }
                        partEnd = Math.min(last, position + CHUNK - 1);
                        reader = (await fetchPart(route, position, partEnd, abort.signal)).getReader();
                    }
                } catch (err) {
                    streams.delete(handle);
                    if (!abort.signal.aborted) onError('unavailable');
                    controller.error(err);
                }
            },
            cancel() {
                streams.delete(handle);
                abort.abort();
            }
        }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
        return new Response(body, { status, headers });
    }

    async function serve(request) {
        let url;
        try { url = new URL(request.url); } catch { return failed(404); }
        const m = TOKEN.exec(url.pathname);
        if (url.protocol !== `${MUSIC_SCHEME}:` || url.host !== 'track' || url.search || url.username || url.password || !m) return failed(404);
        if (!['GET', 'HEAD'].includes(request.method)) return failed(405);
        const route = routes.get(m[1]);
        if (!route) return failed(404);
        return route.kind === 'file' ? serveFile(request, route) : serveYouTube(request, route);
    }

    return { addFile, addYouTube, serve, clear, size: () => routes.size };
}

// The audio files of a folder (not the subfolders): [{ name, file }], sorted by name, at most FOLDER_MAX.
export async function listFolder(dir, { read = readdir } = {}) {
    const entries = await read(dir, { withFileTypes: true });
    return entries.filter(e => e.isFile() && audioType(e.name))
        .map(e => ({ name: e.name, file: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        .slice(0, FOLDER_MAX);
}
