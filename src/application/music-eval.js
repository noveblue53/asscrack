// Room music (MU-6): the page of the hidden sandboxed window (music-eval.mjs). It runs the code that youtubei.js cut
// from the YouTube player script and gives back the strings sig and n as JSON. No Node, no network.
(function () {
    'use strict';
    window.musicEval.onJob((id, code) => {
        let text = null;
        try {
            const value = new Function(String(code))();
            if (value && typeof value === 'object') {
                text = JSON.stringify({
                    sig: typeof value.sig === 'string' ? value.sig : undefined,
                    n: typeof value.n === 'string' ? value.n : undefined
                });
            }
        } catch {
            text = null;
        }
        window.musicEval.reply(id, text);
    });
})();
