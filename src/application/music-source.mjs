// Room music: the YouTube source of the DJ (youtubei.js, in the main process; MU-6, P10).
// - It gets only a video ID or a playlist ID that music.mjs checked (VIDEO_ID, LIST_ID). No room data: no name, no peer
//   ID, no text of the room.
// - The player script of YouTube (the signature and n functions) runs in a hidden sandboxed window with no network
//   (music-eval.mjs), never in the main process.
// - No cache on disk (the cache option of the library stays unset) and no log of the library (its log has the URLs).
// - Errors have a kind: 'refused' (YouTube does not play this video or list: private, removed, age, region) or
//   'unavailable' (the library does not work: a YouTube change, no network).
import { LIST_ID, MUSIC_LIMITS, VIDEO_ID } from '../network/music.mjs';
import { youtubeStreamUrl } from './music-media.mjs';

// The clients of YouTube that the source tries, in this order (MU-6). Measured on this PC on 2026-11-23 with a public
// video: VISIONOS gave each byte range of the audio stream; ANDROID_VR, IOS and TV_SIMPLY gave only about the first
// minute (HTTP 403 after it); WEB_EMBEDDED, TV and WEB gave no stream. The two probes of stream() find a client that
// stops at the first minute, thus the order can change with YouTube and the list stays.
export const YOUTUBE_CLIENTS = Object.freeze(['VISIONOS', 'ANDROID_VR', 'TV_SIMPLY', 'WEB_EMBEDDED', 'TV']);
// The app clients: their stream URL works as YouTube gives it (no player script), with their own agent.
const NO_PLAYER = new Set(['VISIONOS', 'ANDROID_VR']);
const SESSION_MS = 30 * 60 * 1000;
const DESKTOP_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export const sourceError = (kind, text) => Object.assign(new Error(text ?? kind), { kind });

// An error text with no URL, for the log.
const safe = err => String(err?.message ?? err).replace(/https?:\/\/\S+/g, '<url>').slice(0, 120);

const text = value => {
    if (typeof value === 'string') return value;
    const s = value?.text ?? value?.toString?.();
    return typeof s === 'string' && s !== '[object Object]' ? s : '';
};

// load(): the youtubei.js module. evaluate(code): the sandbox (music-eval.mjs), gives { sig, n } or null.
// fetch: the fetch of the library and of the probe. now(): the clock. log(level, text): the log of the app; it gets
// the client name and a status, never a URL or a video ID.
export function createYouTubeSource({ load = () => import('youtubei.js'), evaluate, fetch = globalThis.fetch, now = Date.now,
    log = () => {} } = {}) {
    let session = null;
    let pending = null;
    let lib = null;

    async function innertube() {
        if (session && now() - session.at < SESSION_MS) return session.yt;
        if (!pending) {
            pending = (async () => {
                try {
                    lib = await load();
                    lib.Log?.setLevel?.(lib.Log.Level.NONE);
                    lib.Platform.shim.eval = async data => {
                        const result = await evaluate(String(data?.output ?? ''));
                        if (!result) throw new Error('The player script gave no result');
                        return result;
                    };
                    const yt = await lib.Innertube.create({ retrieve_player: true, fetch: (...args) => fetch(...args) });
                    session = { yt, at: now() };
                    return yt;
                } catch (err) {
                    throw err?.kind ? err : sourceError('unavailable', `YouTube source unavailable: ${err?.message ?? err}`);
                }
            })().finally(() => { pending = null; });
        }
        return pending;
    }

    function playable(info) {
        const status = info?.playability_status?.status;
        return !status || status === 'OK';
    }

    // The title and the length of a video, or of the first PLAYLIST videos of a list: [{ video, title, dur }].
    async function describe(request) {
        const yt = await innertube();
        try {
            if (typeof request?.video === 'string') {
                if (!VIDEO_ID.test(request.video)) throw sourceError('refused');
                let refused = false;
                for (const client of YOUTUBE_CLIENTS) {
                    const info = await yt.getBasicInfo(request.video, { client }).catch(() => null);
                    if (!info) continue;
                    if (!playable(info)) { refused = true; continue; }
                    return [{ video: request.video, title: text(info.basic_info?.title) || 'YouTube video',
                        dur: Number(info.basic_info?.duration) || 0 }];
                }
                throw sourceError(refused ? 'refused' : 'unavailable');
            }
            if (typeof request?.list === 'string' && LIST_ID.test(request.list)) {
                const list = await yt.getPlaylist(request.list).catch(err => {
                    throw sourceError(/not found|does not exist|private|unavailable/i.test(String(err?.message)) ? 'refused' : 'unavailable');
                });
                const out = [];
                for (const item of list?.items ?? list?.videos ?? []) {
                    const video = item?.id ?? item?.content_id;
                    if (typeof video !== 'string' || !VIDEO_ID.test(video) || item?.is_playable === false) continue;
                    out.push({ video, title: text(item.title) || text(item.metadata?.title) || 'YouTube video',
                        dur: Number(item.duration?.seconds) || 0 });
                    if (out.length >= MUSIC_LIMITS.playlist) break;
                }
                if (out.length === 0) throw sourceError('refused');
                return out;
            }
        } catch (err) {
            throw err?.kind ? err : sourceError('unavailable', String(err?.message ?? err));
        }
        throw sourceError('refused');
    }

    // The audio-only format: Opus in WebM first, then the format with the highest bitrate. At most 2 channels (no 5.1).
    function audioFormat(info) {
        const formats = (info?.streaming_data?.adaptive_formats ?? [])
            .filter(f => f?.has_audio && !f.has_video && (f.audio_channels ?? 2) <= 2 && /^audio\//.test(String(f.mime_type)));
        const opus = f => /webm/.test(f.mime_type) && /opus/.test(f.mime_type) ? 1 : 0;
        formats.sort((a, b) => opus(b) - opus(a) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
        return formats[0] ?? null;
    }

    // One probe of 1 KB at a byte offset. Gives the HTTP status.
    async function probe(url, headers, at) {
        const response = await fetch(`${url}&range=${at}-${at + 1023}`, { headers, redirect: 'follow' });
        await response.body?.cancel?.().catch?.(() => {});
        return response.status;
    }

    // The audio-only stream of a video: { url, mime, size, headers }. Two probes of 1 KB (the start and the end of the
    // file, where Chromium reads the index of a WebM file) check the URL; a refused URL gives the next client a try.
    async function stream(video) {
        if (!VIDEO_ID.test(video)) throw sourceError('refused');
        const yt = await innertube();
        let refused = false;
        for (const client of YOUTUBE_CLIENTS) {
            try {
                const info = await yt.getBasicInfo(video, { client });
                if (!playable(info)) {
                    refused = true;
                    log('INFO', `Music: YouTube client ${client}: status ${String(info?.playability_status?.status).slice(0, 32)}`);
                    continue;
                }
                const format = audioFormat(info);
                if (!format) { log('INFO', `Music: YouTube client ${client}: no audio format`); continue; }
                const agent = lib?.Constants?.CLIENTS?.[client]?.USER_AGENT;
                // An app client sends its own agent and no web origin; a web client the headers of youtube.com.
                const headers = NO_PLAYER.has(client) && typeof agent === 'string' ? { accept: '*/*', 'user-agent': agent }
                    : { accept: '*/*', origin: 'https://www.youtube.com', referer: 'https://www.youtube.com/', 'user-agent': DESKTOP_AGENT };
                const size = Number(format.content_length) || null;
                // MU-6: the URL of an app client (no player script) as it is, then the URL after the player script.
                const plain = typeof format.url === 'string' && !format.signature_cipher && !format.cipher;
                const variants = NO_PLAYER.has(client) && plain ? ['plain', 'deciphered'] : ['deciphered'];
                for (const variant of variants) {
                    const url = youtubeStreamUrl(variant === 'plain' ? format.url : await format.decipher(yt.session.player));
                    if (!url) { log('INFO', `Music: YouTube client ${client}: no googlevideo URL (${variant})`); continue; }
                    const first = await probe(url, headers, 0);
                    const last = first >= 200 && first < 300 && size > 4096 ? await probe(url, headers, size - 1024) : first;
                    log('INFO', `Music: YouTube client ${client}: probes ${first} ${last} (${variant}), ${String(format.mime_type ?? '').split(';')[0]}`);
                    if (first < 200 || first >= 300 || last < 200 || last >= 300) continue;
                    return { url: url.toString(), mime: String(format.mime_type ?? ''), size, headers, client };
                }
            } catch (err) {
                log('INFO', `Music: YouTube client ${client}: ${safe(err)}`);
            }
        }
        throw sourceError(refused ? 'refused' : 'unavailable');
    }

    return { describe, stream, loaded: () => session !== null };
}
