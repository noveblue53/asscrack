// Screen share, viewer side of the room window (work-orders/astra/P8/DESIGN.md, sections 2.5, 2.6, 2.7 and 2.9,
// package W5): the banner with Watch, the stage with the canvas, the decoder and the limits of the data from the
// sharer, the "sharing screen" text on the buddy lines, and Fill window.
// window.screenView: { isFilled(), unfill(), canWatch(peerId), watch(peerId), stats() }. The one Escape dispatcher of
// renderer.js calls isFilled() and unfill(). Reads the globals of renderer.js: peerNames, peerItems, selfLine.
(function () {
    'use strict';
    const api = window.asscrack;
    const check = window.screenFrameCheck;
    const byId = id => document.getElementById(id);
    const banner = byId('screen-banner');
    const stage = byId('screen-stage');
    const canvas = byId('screen-canvas');
    if (!api?.watchScreen || !check || !banner || !stage || !canvas) return;

    // Section 5.
    const WAITING_MS = 5000;
    const WATCH_AGAIN_MS = 60000;
    const RETRY_MS = 2000;
    const NOTICE_MS = 10000;
    const DECODE_QUEUE_LIMIT = 8;
    const RESETS_MAX = 5;
    const RESETS_WINDOW_MS = 60000;
    const KEY_REQUEST_MS = 2000;
    const END_TEXTS = {
        stopped: name => `${name} stopped sharing.`,
        source: name => `${name} stopped sharing.`,
        idle: name => `${name} stopped sharing.`,
        slow: () => 'Your connection is too slow for this share.',
        full: () => 'This share has 6 viewers.',
        refused: () => 'This share is not available.',
        error: name => `${name}'s share stopped.`,
        timeout: name => `${name}'s share stopped.`
    };

    const bannerText = byId('screen-banner-text');
    const watchButton = byId('screen-watch');
    const notice = byId('screen-notice');
    const title = byId('screen-stage-title');
    const info = byId('screen-stage-info');
    const note = byId('screen-stage-note');
    const fillButton = byId('screen-fill');
    const unwatchButton = byId('screen-unwatch');

    const now = () => performance.now();
    const shares = new Map(); // peerId -> { shareId, preset }
    let ownSharing = false;
    let idle = false;
    let watch = null;
    let lost = null; // { peerId, shareId, until, timer, retry }
    let filled = false;
    let noticeTimer = null;
    let waitTimer = null;
    const totals = { watches: 0, frames: 0, decoded: 0, resets: 0, keyRequests: 0, sizeErrors: 0, configs: 0, dropped: 0 };

    function nameOf(peerId) {
        const name = typeof peerNames !== 'undefined' ? peerNames.get(peerId) : '';
        return name || String(peerId ?? '').slice(-8);
    }
    function showNotice(text) {
        clearTimeout(noticeTimer);
        if (!notice) return;
        notice.textContent = text;
        notice.hidden = !text;
        // Section 2.7: the reason shows for 10 s.
        if (text) noticeTimer = setTimeout(() => { notice.textContent = ''; notice.hidden = true; }, NOTICE_MS);
    }
    function setNote(text) {
        if (!note) return;
        note.textContent = text;
        note.hidden = !text;
    }

    // ---- The buddy lines and the banner ----

    function markLine(item, on) {
        if (!item) return;
        let span = item.querySelector('.screen-state');
        if (on && !span) {
            span = document.createElement('span');
            span.className = 'screen-state';
            span.textContent = 'sharing screen';
            item.append(span);
        } else if (!on && span) {
            span.remove();
        }
    }
    function markLines() {
        if (typeof peerItems !== 'undefined') for (const [peerId, item] of peerItems) markLine(item, shares.has(peerId));
        if (typeof selfLine !== 'undefined') markLine(selfLine, ownSharing);
    }
    function renderBanner() {
        const [peerId] = [...shares.keys()];
        const show = peerId !== undefined && !(watch && watch.peerId === peerId) && !(lost && lost.peerId === peerId);
        banner.hidden = !show;
        if (show) {
            banner.dataset.peerId = peerId;
            if (bannerText) bannerText.textContent = `${nameOf(peerId)} is sharing a screen.`;
            if (watchButton) watchButton.disabled = idle;
        } else {
            delete banner.dataset.peerId;
        }
        markLines();
    }

    // ---- The stage ----

    function openStage(peerId, text) {
        stage.hidden = false;
        stage.dataset.peerId = peerId;
        if (title) title.textContent = `${nameOf(peerId)}'s screen`;
        if (info) info.textContent = '';
        setNote(text);
    }
    function closeStage() {
        stage.hidden = true;
        delete stage.dataset.peerId;
        setNote('');
        if (info) info.textContent = '';
        unfill();
    }
    function closeDecoder(w) {
        const decoder = w?.decoder;
        if (w) w.decoder = null;
        if (decoder && decoder.state !== 'closed') {
            try { decoder.close(); } catch { /* closed */ }
        }
    }
    // The watch ends here (the node ended it, or the user, or a check of section 2.9).
    function endWatch(w) {
        if (watch !== w) return;
        watch = null;
        closeDecoder(w);
        clearInterval(waitTimer);
        waitTimer = null;
    }
    function stopWatching({ send = true, text = '' } = {}) {
        const w = watch;
        if (!w) return;
        endWatch(w);
        if (send) api.unwatchScreen();
        closeStage();
        if (text) showNotice(text);
        renderBanner();
    }
    // A failure of a check of section 2.9: the viewer stops with an error.
    function failWatch(w, text = 'This share cannot be shown on this computer.') {
        if (watch !== w) return;
        stopWatching({ send: true, text });
    }

    function clearLost() {
        if (!lost) return;
        clearTimeout(lost.timer);
        clearTimeout(lost.retry);
        lost = null;
    }

    async function watchPeer(peerId) {
        const share = shares.get(peerId);
        if (!share || idle) return false;
        clearLost();
        if (watch) stopWatching({ send: true });
        const w = { peerId, shareId: share.shareId, config: null, decoder: null, gate: check.createFrameGate({ now, keyRequestMs: KEY_REQUEST_MS }),
            resets: [], lastFrameAt: now(), frames: 0, decoded: 0 };
        watch = w;
        totals.watches++;
        openStage(peerId, `Connecting to ${nameOf(peerId)}…`);
        renderBanner();
        try {
            const config = await api.watchScreen(peerId);
            if (watch !== w) return false;
            applyConfig(w, config, config?.shareId);
        } catch {
            // The node emits screen-ended before the rejection. A rejection with no event (no session) ends here.
            if (watch === w) stopWatching({ send: false, text: 'This share is not available.' });
            return false;
        }
        clearInterval(waitTimer);
        // Section 2.7: "Waiting for <name>…" after 5 s with no frame. A timer of the stage, not of the decoder.
        waitTimer = setInterval(() => {
            if (watch !== w || !w.config) return;
            if (now() - w.lastFrameAt >= WAITING_MS) setNote(`Waiting for ${nameOf(peerId)}…`);
        }, 1000);
        return true;
    }

    function makeDecoder(w) {
        const decoder = new VideoDecoder({
            output: frame => onDecoded(w, frame),
            error: () => { if (watch === w) resetDecoder(w); }
        });
        w.decoder = decoder;
        return decoder;
    }
    function configureDecoder(w) {
        let decoder = w.decoder;
        if (!decoder || decoder.state === 'closed') decoder = makeDecoder(w);
        else if (decoder.state === 'configured') decoder.reset();
        decoder.configure({ codec: 'vp8', codedWidth: w.config.width, codedHeight: w.config.height, optimizeForLatency: true });
    }
    // Section 2.9: the first CONFIG and each later CONFIG have the same checks. The canvas size is the coded size.
    function applyConfig(w, config, shareId = w.shareId) {
        totals.configs++;
        const result = check.checkConfig({ codec: 'vp8', ...config, shareId }, w.shareId);
        if (!result.ok) { failWatch(w); return; }
        w.config = { width: config.width, height: config.height, fps: Number.isInteger(config.fps) ? config.fps : null };
        canvas.width = w.config.width;
        canvas.height = w.config.height;
        if (info) info.textContent = `${w.config.width} x ${w.config.height}${w.config.fps ? `, ${w.config.fps} fps` : ''}`;
        w.gate.config();
        try { configureDecoder(w); } catch { failWatch(w); return; }
        setNote('');
    }
    // A decoder error or a long queue: reset the decoder and ask for a keyframe. After 5 resets in 60 s, stop.
    function resetDecoder(w) {
        totals.resets++;
        const t = now();
        w.resets = w.resets.filter(at => t - at < RESETS_WINDOW_MS);
        w.resets.push(t);
        if (w.resets.length >= RESETS_MAX) { failWatch(w); return; }
        try { configureDecoder(w); } catch { failWatch(w); return; }
        if (w.gate.reset()) requestKey();
    }
    function requestKey() {
        totals.keyRequests++;
        api.requestScreenKey();
    }

    function onFrame(data) {
        const w = watch;
        if (!w || !w.config || data?.peerId !== w.peerId || !(data.data instanceof Uint8Array)) return;
        totals.frames++;
        w.frames++;
        w.lastFrameAt = now();
        if (note && !note.hidden) setNote('');
        const key = data.key === true;
        const gate = w.gate.frame(data.seq >>> 0, key);
        if (gate.keyRequest) requestKey();
        if (!gate.decode) { totals.dropped++; return; }
        // Section 2.9: the VP8 keyframe header must have the size of CONFIG.
        if (key) {
            const header = check.checkKeyframe(data.data, w.config.width, w.config.height);
            if (!header.ok) { totals.sizeErrors++; failWatch(w); return; }
        }
        const decoder = w.decoder;
        if (!decoder || decoder.state !== 'configured') return;
        if (decoder.decodeQueueSize > DECODE_QUEUE_LIMIT) { resetDecoder(w); return; }
        try {
            decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.max(0, Number(data.timestampMs) || 0) * 1000, data: data.data }));
        } catch {
            resetDecoder(w);
        }
    }
    // Each decoded frame must have the size of CONFIG. The window draws it and closes it.
    function onDecoded(w, frame) {
        try {
            if (watch !== w || !w.config) return;
            if (frame.codedWidth !== w.config.width || frame.codedHeight !== w.config.height) {
                totals.sizeErrors++;
                failWatch(w);
                return;
            }
            canvas.getContext('2d')?.drawImage(frame, 0, 0, canvas.width, canvas.height);
            totals.decoded++;
            w.decoded++;
        } finally {
            frame.close();
        }
    }

    // ---- Fill window ----

    // Fill window puts the stage in the top layer (a manual popover): no ancestor with a transform or a filter can
    // change its box, and the other parts keep their layout under it (the reading position stays).
    function fill(on) {
        filled = on === true && !stage.hidden;
        document.body.classList.toggle('screen-fill', filled);
        if (typeof stage.showPopover === 'function') {
            try {
                if (filled) { stage.setAttribute('popover', 'manual'); stage.showPopover(); }
                else if (stage.hasAttribute('popover')) { if (stage.matches(':popover-open')) stage.hidePopover(); stage.removeAttribute('popover'); }
            } catch { /* the stage stays in its place */ }
        }
        if (fillButton) {
            fillButton.textContent = filled ? 'Exit fill window' : 'Fill window';
            fillButton.setAttribute('aria-pressed', String(filled));
        }
    }
    function unfill() {
        if (!filled) return false;
        fill(false);
        return true;
    }

    // ---- Events ----

    watchButton?.addEventListener('click', () => { const peerId = banner.dataset.peerId; if (peerId) watchPeer(peerId); });
    unwatchButton?.addEventListener('click', () => stopWatching({ send: true }));
    fillButton?.addEventListener('click', () => fill(!filled));

    api.onScreenState?.(state => {
        if (!state) return;
        if (state.own) {
            ownSharing = state.sharing === true;
            markLines();
            return;
        }
        if (state.sharing) {
            shares.set(state.peerId, { shareId: state.shareId, preset: state.preset ?? null });
            // Section 2.5, item 3: the same share comes again in 60 s after a lost connection: watch again.
            if (lost && lost.peerId === state.peerId && lost.shareId === state.shareId && now() < lost.until) watchPeer(state.peerId);
            else if (lost && lost.peerId === state.peerId) { clearLost(); closeStage(); }
        } else {
            shares.delete(state.peerId);
            // A lost connection keeps the stage with the last picture for 60 s.
            if (watch && watch.peerId === state.peerId) stopWatching({ send: false });
        }
        renderBanner();
    });
    api.onScreenConfig?.(config => {
        const w = watch;
        if (w && w.config && config?.peerId === w.peerId) applyConfig(w, config);
    });
    api.onScreenFrame?.(onFrame);
    api.onScreenEnded?.(data => {
        if (!data || data.own) return;
        const w = watch;
        if (!w || data.peerId !== w.peerId) return;
        if (data.reason === 'replaced') return;
        const name = nameOf(w.peerId);
        if (data.reason === 'lost') {
            // Section 2.5, item 3: keep the stage and the last picture. Watch again when the share comes back.
            endWatch(w);
            setNote(`The connection to ${name} was lost. Trying again…`);
            clearLost();
            const entry = { peerId: w.peerId, shareId: w.shareId, until: now() + WATCH_AGAIN_MS };
            entry.timer = setTimeout(() => {
                if (lost !== entry) return;
                lost = null;
                closeStage();
                renderBanner();
            }, WATCH_AGAIN_MS);
            // The session can still be open (only the stream closed): then no new screen line comes. Try one time.
            entry.retry = setTimeout(() => {
                if (lost === entry && shares.get(entry.peerId)?.shareId === entry.shareId) watchPeer(entry.peerId);
            }, RETRY_MS);
            lost = entry;
            renderBanner();
            return;
        }
        endWatch(w);
        closeStage();
        showNotice((END_TEXTS[data.reason] ?? END_TEXTS.stopped)(name));
        renderBanner();
    });
    api.onPeerJoined?.(() => queueMicrotask(markLines));
    api.onPeerName?.(() => queueMicrotask(renderBanner));
    api.onIdlePeer?.(state => {
        idle = state?.idle === true;
        if (idle) {
            // The node closed the stream (setIdle). The window closes the stage.
            clearLost();
            stopWatching({ send: false });
        }
        renderBanner();
    });
    // The window reads the state after it subscribed, so that an early event is not lost (a late join).
    Promise.resolve(api.getScreenState?.()).then(state => {
        for (const [peerId, value] of Object.entries(state?.peers ?? {})) {
            if (!shares.has(peerId)) shares.set(peerId, { shareId: value?.shareId ?? null, preset: value?.preset ?? null });
        }
        if (state?.own) ownSharing = true;
        renderBanner();
    }).catch(() => {});

    window.screenView = Object.freeze({
        isFilled: () => filled,
        unfill,
        canWatch: peerId => shares.has(peerId) && !idle && !(watch && watch.peerId === peerId),
        watch: peerId => watchPeer(peerId),
        stats: () => ({ ...totals, watching: watch?.peerId ?? null, config: watch?.config ?? null, lost: lost !== null,
            stage: !stage.hidden, banner: !banner.hidden, note: note?.textContent ?? '', notice: notice?.textContent ?? '' })
    });
})();
