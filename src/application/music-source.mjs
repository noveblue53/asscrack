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

// The clients of YouTube that the source tries, in this order. They need no proof-of-origin token (yt-dlp PO token
// guide, July 2026): ANDROID_VR (no "made for kids" videos), WEB_EMBEDDED (only embeddable videos), TV.
export const YOUTUBE_CLIENTS = Object.freeze(['ANDROID_VR', 'WEB_EMBEDDED', 'TV']);
const SESSION_MS = 30 * 60 * 1000;
const DESKTOP_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export const sourceError = (kind, text) => Object.assign(new Error(text ?? kind), { kind });

const text = value => {
    if (typeof value === 'string') return value;
    const s = value?.text ?? value?.toString?.();
    return typeof s === 'string' && s !== '[object Object]' ? s : '';
};

// load(): the youtubei.js module. evaluate(code): the sandbox (music-eval.mjs), gives { sig, n } or null.
// fetch: the fetch of the library and of the probe. now(): the clock.
export function createYouTubeSource({ load = () => import('youtubei.js'), evaluate, fetch = globalThis.fetch, now = Date.now } = {}) {
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

    // The audio-only stream of a video: { url, mime, size, headers }. A short probe of the first bytes checks the URL;
    // a refused URL gives the next client a try.
    async function stream(video) {
        if (!VIDEO_ID.test(video)) throw sourceError('refused');
        const yt = await innertube();
        let refused = false;
        for (const client of YOUTUBE_CLIENTS) {
            try {
                const info = await yt.getBasicInfo(video, { client });
                if (!playable(info)) { refused = true; continue; }
                let format;
                try { format = info.chooseFormat({ type: 'audio', quality: 'best', format: 'webm', codec: 'opus' }); }
                catch { format = info.chooseFormat({ type: 'audio', quality: 'best', format: 'any' }); }
                const url = youtubeStreamUrl(await format.decipher(yt.session.player));
                if (!url) continue;
                const agent = lib?.Constants?.CLIENTS?.[client]?.USER_AGENT;
                const headers = { accept: '*/*', origin: 'https://www.youtube.com', referer: 'https://www.youtube.com/',
                    'user-agent': typeof agent === 'string' ? agent : DESKTOP_AGENT };
                const probe = await fetch(`${url}&range=0-1023`, { headers, redirect: 'follow' });
                await probe.body?.cancel?.().catch?.(() => {});
                if (!probe.ok) continue;
                return { url: url.toString(), mime: String(format.mime_type ?? ''), size: Number(format.content_length) || null,
                    headers, client };
            } catch {
                // The next client.
            }
        }
        throw sourceError(refused ? 'refused' : 'unavailable');
    }

    return { describe, stream, loaded: () => session !== null };
}
