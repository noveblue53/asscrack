// Room music: the asscrack-music:// handler of the main process (music-media.mjs), the settings
// (music-settings.mjs) and the journal fields. A local file with Range; a YouTube stream in parts of a fake fetch,
// only to googlevideo.com. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHUNK, createMusicMedia, listFolder, youtubeStreamUrl } from '../src/application/music-media.mjs';
import * as musicSettings from '../src/application/music-settings.mjs';
import { redact } from '../src/application/journal.mjs';

const req = (url, init) => new Request(url, init);

test('handler: only GET and HEAD of a known token of the track host', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'music-media-'));
    try {
        const file = path.join(dir, 'a.mp3');
        await writeFile(file, Buffer.alloc(1000, 7));
        const media = createMusicMedia();
        const url = media.addFile(file);
        assert.match(url, /^asscrack-music:\/\/track\/[0-9a-f-]{36}$/);
        assert.equal(media.addFile(path.join(dir, 'a.exe')), null, 'no audio type: no URL');
        for (const bad of [url + '?x=1', url.replace('track', 'other'), url.slice(0, -1) + (url.endsWith('0') ? '1' : '0'), 'asscrack-music://track/../a.mp3',
            'room-media://track/' + url.split('/').pop()]) {
            assert.equal((await media.serve(req(bad))).status, 404, bad);
        }
        assert.equal((await media.serve(req(url, { method: 'POST', body: 'x' }))).status, 405);
        const full = await media.serve(req(url));
        assert.equal(full.status, 200);
        assert.equal(full.headers.get('content-type'), 'audio/mpeg');
        assert.equal(full.headers.get('access-control-allow-origin'), 'asscrack-app://app');
        assert.equal((await full.arrayBuffer()).byteLength, 1000);
        const part = await media.serve(req(url, { headers: { Range: 'bytes=100-199' } }));
        assert.equal(part.status, 206);
        assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
        assert.equal((await part.arrayBuffer()).byteLength, 100);
        assert.equal((await media.serve(req(url, { headers: { Range: 'bytes=5000-' } }))).status, 416);
        media.clear();
        assert.equal((await media.serve(req(url))).status, 404, 'clear revokes the token');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('handler: a YouTube stream in parts with the range parameter, only from googlevideo.com', async () => {
    const size = CHUNK * 2 + 10;
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, headers: init.headers });
        const u = new URL(url);
        const [a, b] = u.searchParams.get('range').split('-').map(Number);
        if (u.hostname === 'evil.example') return new Response('x', { status: 200 });
        return new Response(new Uint8Array(Math.min(b, size - 1) - a + 1), { status: 200 });
    };
    const media = createMusicMedia({ fetch });
    assert.equal(media.addYouTube({ url: 'https://evil.example/videoplayback?x=1', mime: 'audio/webm', size }), null);
    assert.equal(media.addYouTube({ url: 'http://r1.googlevideo.com/videoplayback?x=1', mime: 'audio/webm', size }), null);
    assert.equal(media.addYouTube({ url: 'https://r1.googlevideo.com/videoplayback?x=1', mime: 'text/html', size }), null);
    const url = media.addYouTube({ url: 'https://r1---sn-x.googlevideo.com/videoplayback?x=1', mime: 'audio/webm; codecs="opus"', size,
        headers: { 'user-agent': 'UA' } });
    const res = await media.serve(req(url));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/webm');
    assert.equal(Number(res.headers.get('content-length')), size);
    assert.equal((await res.arrayBuffer()).byteLength, size);
    assert.deepEqual(calls.map(c => new URL(c.url).searchParams.get('range')), [`0-${CHUNK - 1}`, `${CHUNK}-${2 * CHUNK - 1}`, `${2 * CHUNK}-${size - 1}`]);
    assert.ok(calls.every(c => c.headers['user-agent'] === 'UA'));
    const tail = await media.serve(req(url, { headers: { Range: `bytes=${size - 5}-` } }));
    assert.equal(tail.status, 206);
    assert.equal((await tail.arrayBuffer()).byteLength, 5);
});

test('handler: a refused YouTube part gives 502 and the kind; a redirect goes only to googlevideo.com', async () => {
    const kinds = [];
    let mode = 'refuse';
    const fetch = async url => {
        const u = new URL(url);
        if (mode === 'refuse') return new Response(null, { status: 403 });
        if (u.hostname === 'r1.googlevideo.com') {
            return new Response(null, { status: 302, headers: { location: mode === 'evil' ? 'https://evil.example/x?y=1' : 'https://r2.googlevideo.com/v?y=1&range=0-9' } });
        }
        if (u.hostname === 'r2.googlevideo.com') return new Response(new Uint8Array(10), { status: 200 });
        throw new Error(`fetch of ${u.hostname}`);
    };
    const media = createMusicMedia({ fetch, onError: kind => kinds.push(kind) });
    const stream = { url: 'https://r1.googlevideo.com/videoplayback?x=1', mime: 'audio/webm', size: 10 };
    assert.equal((await media.serve(req(media.addYouTube(stream)))).status, 502);
    assert.deepEqual(kinds, ['refused']);
    mode = 'redirect';
    const ok = await media.serve(req(media.addYouTube(stream)));
    assert.equal(ok.status, 200);
    assert.equal((await ok.arrayBuffer()).byteLength, 10);
    mode = 'evil';
    assert.equal((await media.serve(req(media.addYouTube(stream)))).status, 502);
    assert.equal(youtubeStreamUrl('https://x.googlevideo.com.evil.example/v'), null);
    assert.ok(youtubeStreamUrl('https://rr3---sn-4g5e6nzl.googlevideo.com/videoplayback?a=1'));
});

test('music folder: audio files only, no subfolders, sorted', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'music-folder-'));
    try {
        for (const name of ['b.mp3', 'a10.flac', 'a2.ogg', 'notes.txt', 'run.exe']) await writeFile(path.join(dir, name), 'x');
        await mkdir(path.join(dir, 'sub.mp3'));
        const list = await listFolder(dir);
        assert.deepEqual(list.map(e => e.name), ['a2.ogg', 'a10.flac', 'b.mp3']);
        assert.equal(list[0].file, path.join(dir, 'a2.ogg'));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('settings: volume 0 to 100, ducking, the folder only from the dialog of the main process', () => {
    assert.deepEqual(musicSettings.normalize(null), { volume: 60, ducking: true, folder: '' });
    assert.deepEqual(musicSettings.normalize({ volume: 250, ducking: 'yes', folder: 'relative/dir' }), { volume: 100, ducking: true, folder: '' });
    const next = musicSettings.merge({ volume: 30 }, { volume: 12.6, ducking: false, folder: 'C:\\Windows' });
    assert.deepEqual(next, { volume: 13, ducking: false, folder: '' }, 'the window cannot set the folder');
    assert.equal(musicSettings.merge(next, { volume: 'loud' }).volume, 13);
    assert.equal(musicSettings.normalize({ folder: '\\\\?\\C:\\x' }).folder, '');
});

test('journal: a music line has the kind only, never a title, a link or a path', () => {
    const line = redact('music', { event: 'error', source: 'youtube', kind: 'refused', ms: 12, title: 'Song', video: 'dQw4w9WgXcQ',
        url: 'https://youtu.be/dQw4w9WgXcQ', file: 'C:\\Music\\a.mp3' });
    assert.deepEqual(line, { type: 'music', event: 'error', source: 'youtube', kind: 'refused', ms: 12 });
    assert.deepEqual(redact('music', { event: 'start', source: 'file', kind: 'my title' }), { type: 'music', event: 'start', source: 'file' });
});
