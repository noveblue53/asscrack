'use strict';

// Room music: the pure parts of the window (music.js, music-ui.js). The node tests load this file in node:vm.
// - MU-5: the gain of the music for this listener (volume and ducking).
// - The chat commands /play <link>, /skip, /queue and /pause.
(function () {
    // Ducking: the music gain while someone talks (about -10 dB).
    const DUCK_GAIN = 0.3;
    // A voice level (RMS of voice.js stats, 0 to 1) above this value is speech (about -34 dBFS).
    const TALK_LEVEL = 0.02;
    const COMMAND = /^\/(play|skip|queue|pause)(?:\s+([\s\S]*))?$/i;
    const RESERVED = /^\/(?:play|skip|queue|pause)(?:\s|$)/i;

    // volume: 0 to 100 (%) of the settings. The curve is the square of the slider value: 50 % is about -12 dB.
    function musicGain({ volume = 60, ducking = true, talking = false } = {}) {
        const v = Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : 60;
        const base = (v / 100) ** 2;
        return ducking && talking ? base * DUCK_GAIN : base;
    }

    // stats: origin -> { audioLevel } of voice.stats(). own: this user sends voice. Gives true while someone talks.
    function talking(stats, own = false) {
        if (own) return true;
        for (const value of Object.values(stats ?? {})) if (Number(value?.audioLevel) > TALK_LEVEL) return true;
        return false;
    }

    // A chat line: null when it is not a music command; else { name, link } (play) or { name }.
    function parseCommand(text) {
        const match = COMMAND.exec(String(text ?? '').trim());
        if (!match) return null;
        const name = match[1].toLowerCase();
        return name === 'play' ? { name, link: (match[2] ?? '').trim() } : { name };
    }

    // A reserved music command never becomes a chat line or the caption of a file, also when it fails.
    const isCommand = text => RESERVED.test(String(text ?? '').trimStart());

    // Seconds as m:ss or h:mm:ss. 0 or no value: ''.
    function clock(seconds) {
        const s = Math.floor(Number(seconds) || 0);
        if (s <= 0) return '';
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
    }

    // The lines of /queue for a view of music.mjs. nameOf(peerId) gives a display name.
    function queueLines(view, nameOf = id => id) {
        if (!view?.dj) return ['No music.'];
        const lines = [];
        const dur = item => (item.dur ? ` (${clock(item.dur)})` : '');
        if (view.now) lines.push(`${view.paused ? 'Paused' : 'Playing'}: ${view.now.title}${dur(view.now)}`);
        view.queue.slice(0, 10).forEach((item, i) => lines.push(`${i + 1}. ${item.title}${dur(item)}`));
        if (view.queue.length > 10) lines.push(`+${view.queue.length - 10} more`);
        if (!view.queue.length) lines.push('Queue empty.');
        lines.push(`DJ: ${nameOf(view.dj)}`);
        return lines;
    }

    // The short text of a notice of music.mjs.
    const NOTICES = {
        refused: 'Skipped: YouTube refused this video.',
        unavailable: 'YouTube source unavailable.',
        error: "Skipped: this track didn't play.",
        full: 'Queue full.',
        limit: 'Too many adds. Wait a minute.',
        mix: "Mix playlists aren't supported.",
        link: 'Not a YouTube link.'
    };
    const noticeText = kind => NOTICES[kind] ?? '';

    window.musicCore = { musicGain, talking, parseCommand, isCommand, clock, queueLines, noticeText, DUCK_GAIN };
})();
