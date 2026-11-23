// Screen share, sharer side of the room window (work-orders/astra/P8/DESIGN.md, sections 2.1, 2.2, 2.7 and 2.8,
// package W4): the picker dialog, the capture, the encoder loop (rules E1 to E11, one encoder for each tier) and the
// share bar. The node does the protocol and the rate control (src/network/screen-share.mjs, screen-rate.mjs). The
// main process keeps the source selection (screen-sources.mjs).
// Rule E9: the encoder loop uses no timer of the window. It runs on the captured frames, on the screen-encoder events
// of the main process (keyframe requests and refresh ticks), and on the encoder outputs.
// window.screenShare: { isSharing(), stop(reason), stats() }. Reads the globals of renderer.js: peerNames, ownName.
(function () {
    'use strict';
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const button = byId('share-screen');
    const picker = byId('screen-picker');
    if (!api?.startScreenShare || !button || !picker) return;

    // Section 2.2. The sequence is the Auto ladder. The labels are the labels of the picker.
    const PRESETS = Object.freeze({
        standard: { label: 'Standard (720p, 15 fps)', width: 1280, height: 720, fps: 15 },
        smooth: { label: 'Smooth (720p, 30 fps)', width: 1280, height: 720, fps: 30 },
        balanced: { label: 'Balanced (1080p, 30 fps)', width: 1920, height: 1080, fps: 30 },
        high: { label: 'High (1080p, 60 fps)', width: 1920, height: 1080, fps: 60 },
        max: { label: 'Max (1440p, 60 fps)', width: 2560, height: 1440, fps: 60 }
    });
    const LADDER = ['standard', 'smooth', 'balanced', 'high', 'max'];
    const QUALITIES = [['auto', 'Auto'], ...LADDER.map(id => [id, PRESETS[id].label])];
    // Section 5.
    const KEPT_KEY_MS = 100; // E5
    const SIZE_CHANGE_MS = 1000; // E7
    const RECONFIGURE_MS = 1000; // E6
    const RECONFIGURE_CHANGE = 0.05; // E6
    const QUEUE_LIMIT = 2; // E4
    const REPORT_MS = 500; // E11
    const MAX_REPORT_TIERS = 4;

    const statusBar = byId('share-bar');
    // The preview of the own share: the captured track in a small muted <video>, on this computer only (no network,
    // no encode). The video has no track while the window is hidden or the preview is off. The choice stays.
    const preview = byId('share-preview');
    const previewToggle = byId('share-preview-toggle');
    const PREVIEW_KEY = 'asscrack.sharePreview.v1';
    let previewOn = true;
    let previewTrack = null; // { source, clone }
    const PREVIEW_FPS = 5;
    try { previewOn = localStorage.getItem(PREVIEW_KEY) !== 'false'; } catch { /* no storage */ }
    const errorLine = byId('share-error');
    const pickStatus = byId('screen-picker-status');
    const screensList = byId('screen-list-screens');
    const windowsList = byId('screen-list-windows');
    const qualitySelect = byId('screen-quality');
    const goButton = byId('screen-share-go');
    const borderHint = byId('screen-border-hint');
    const borderSwitch = byId('screen-border-switch');
    const cancelButton = byId('screen-cancel');

    const clock = () => performance.now();
    let idle = false;
    const others = new Map(); // peerId -> shareId of the other members that share
    // Multi-share (1.0.6): at most maxShares shares in a room (screen-share.mjs). The node gives the value.
    let maxShares = 3;
    const atLimit = () => others.size >= maxShares;
    const limitText = () => `Share limit reached (${maxShares}).`;
    let share = null;
    let lastEncoder = { tiers: [] };
    let lastViewers = { viewers: [], tiers: [], cap: null, relayed: [], cpu: null };
    let selectedId = null;
    let listedSources = new Map(); // id -> { kind, fillsScreen, screenId } of the open picker
    let pickerToken = 0;
    let starting = false;
    let encoderGen = 0;
    let lastTrack = null; // for stats(): the track state after a stop (W4 check 6)
    // 1.0.4: the guard of a window share that uses the screen (share-guard.mjs). The last state from the main process.
    let guardView = { active: false, paused: true, reason: 'off' };
    const totals = { captured: 0, encoded: 0, sent: 0, sentBytes: 0, skipped: 0, dropped: 0, keyframes: 0, reports: 0,
        pauses: 0, pausedCaptured: 0, pauseEncoded: 0, pauseSent: 0 };

    function nameOf(peerId) {
        const name = typeof peerNames !== 'undefined' ? peerNames.get(peerId) : '';
        return name || String(peerId ?? '').slice(-8);
    }
    function errorName(err) {
        if (err && typeof err.name === 'string' && err.name && err.name !== 'Error') return err.name;
        return String(err?.message ?? err ?? 'unknown').replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
    }
    function showError(text) {
        if (!errorLine) return;
        errorLine.textContent = text;
        errorLine.hidden = !text;
    }
    // The size of a source in the box of a preset. Chromium keeps the aspect ratio and does not make a small source
    // larger. The same formula as fitSize of screen-rate.mjs.
    function fit(source, box) {
        const scale = Math.min(1, box.width / source.width, box.height / source.height);
        const even = x => Math.max(16, 2 * Math.round(x / 2));
        return { width: Math.min(box.width, even(source.width * scale)), height: Math.min(box.height, even(source.height * scale)) };
    }
    function p95(values) {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor((sorted.length - 1) * 0.95)];
    }

    // ---- The button and the picker ----

    function updateButton() {
        button.textContent = share ? 'Stop sharing' : 'Share screen';
        button.setAttribute('aria-pressed', String(Boolean(share)));
        // At the share limit the button stays enabled: a click shows the reason.
        button.disabled = !share && (idle || starting);
        button.title = !share && atLimit() ? limitText() : '';
    }

    function sourceEntry(source) {
        const item = document.createElement('li');
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'screen-source';
        choice.dataset.id = source.id;
        choice.setAttribute('aria-pressed', 'false');
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        canvas.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'screen-source-name';
        name.textContent = source.name || (source.kind === 'screen' ? 'Screen' : 'Window');
        choice.append(canvas, name);
        choice.addEventListener('click', () => select(source.id));
        choice.addEventListener('dblclick', () => { select(source.id); startFromPicker(false); });
        item.append(choice);
        drawThumbnail(canvas, source.thumbnail);
        return item;
    }
    // Section 2.1: the thumbnail comes as PNG bytes. An ImageBitmap from a Blob goes on a canvas (no data: URL).
    async function drawThumbnail(canvas, bytes) {
        if (!(bytes instanceof Uint8Array) || typeof createImageBitmap !== 'function' || typeof Blob !== 'function') return;
        try {
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
            const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
            const w = bitmap.width * scale, h = bitmap.height * scale;
            canvas.getContext('2d')?.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
            bitmap.close?.();
        } catch { /* no thumbnail: the name stays */ }
    }
    function select(id) {
        selectedId = id;
        for (const list of [screensList, windowsList]) {
            for (const choice of list?.querySelectorAll('.screen-source') ?? []) choice.setAttribute('aria-pressed', String(choice.dataset.id === id));
        }
        goButton.disabled = starting || !selectedId;
        updateBorderHint();
    }
    // Windows 10 draws a yellow border around a shared window, not around a shared screen. The main process marks a
    // window that can fill a screen (screen-sources.mjs). Share then uses that screen, with no border, and the viewers
    // see "Paused" while the window is not in front. The switch shares the window itself, with the border.
    function updateBorderHint() {
        const source = listedSources.get(selectedId);
        const fills = source?.kind === 'window' && source.fillsScreen === true;
        if (borderHint) borderHint.hidden = !fills;
        if (borderSwitch) borderSwitch.hidden = !fills;
    }

    async function openPicker() {
        if (share) { stop('stopped'); return; }
        if (idle || starting) return;
        if (atLimit()) { showError(limitText()); return; }
        const token = ++pickerToken;
        selectedId = null;
        listedSources = new Map();
        updateBorderHint();
        screensList?.replaceChildren();
        windowsList?.replaceChildren();
        pickStatus.textContent = 'Loading sources…';
        pickStatus.hidden = false;
        goButton.textContent = 'Share';
        goButton.disabled = true;
        showError('');
        qualitySelect.value = 'auto';
        picker.showModal();
        try {
            const last = await api.getScreenQuality?.();
            if (token === pickerToken && QUALITIES.some(([id]) => id === last)) qualitySelect.value = last;
            const sources = await api.getScreenSources();
            if (token !== pickerToken || !picker.open) return;
            const list = Array.isArray(sources) ? sources : [];
            listedSources = new Map(list.map(s => [s?.id, { kind: s?.kind, fillsScreen: s?.fillsScreen === true,
                screenId: typeof s?.screenId === 'string' ? s.screenId : null }]));
            for (const source of list) (source.kind === 'screen' ? screensList : windowsList)?.append(sourceEntry(source));
            pickStatus.textContent = list.length ? '' : 'No screen or window to share.';
            pickStatus.hidden = list.length > 0;
        } catch (err) {
            if (token !== pickerToken) return;
            pickStatus.textContent = `Couldn't list the sources: ${errorName(err)}`;
            pickStatus.hidden = false;
        }
    }
    function fillQualities() {
        qualitySelect.replaceChildren();
        for (const [id, label] of QUALITIES) {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = label;
            if (id === 'auto') option.title = 'Adapts to each viewer';
            qualitySelect.append(option);
        }
    }
    function closePicker() {
        pickerToken++;
        if (picker.open) picker.close();
    }

    // border: share the window itself, also when it fills a screen.
    async function startFromPicker(border = false) {
        if (!selectedId || starting || share || idle) return;
        starting = true;
        goButton.textContent = 'Starting…';
        goButton.disabled = true;
        updateButton();
        const quality = qualitySelect.value || 'auto';
        let stream = null;
        try {
            const info = await api.pickScreenSource(selectedId, quality, { border: border === true });
            // Section 2.1, item 6: the constraints of the preset (Auto: the capture preset of rule A1, at first Max).
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: { max: info.width }, height: { max: info.height }, frameRate: { max: info.frameRate } },
                audio: false
            });
            const track = stream.getVideoTracks()[0];
            if (!track) throw Object.assign(new Error('no video track'), { name: 'NotFoundError' });
            const settings = track.getSettings?.() ?? {};
            const result = await api.startScreenShare({ preset: quality, width: settings.width, height: settings.height });
            begin(track, info.name, quality, result?.shareId ?? null, settings, Boolean(info?.guard));
            starting = false;
            closePicker();
        } catch (err) {
            for (const track of stream?.getTracks?.() ?? []) track.stop();
            starting = false;
            closePicker();
            const reason = errorName(err);
            showError(/^Share limit reached/.test(reason) ? reason : `Couldn't start the share: ${reason}`);
        } finally {
            starting = false;
            goButton.textContent = 'Share';
            updateButton();
        }
    }

    // ---- The share and the encoder loop ----

    function begin(track, name, quality, shareId, settings, guarded = false) {
        const startAt = clock();
        lastTrack = track;
        share = { track, name: String(name ?? ''), quality, shareId, startAt, tiers: new Map(), kept: null, lastReportAt: startAt,
            capture: { width: settings.width ?? null, height: settings.height ?? null, fps: settings.frameRate ?? null }, reader: null,
            guarded, paused: false, frameSize: null };
        const current = share;
        // A guarded share starts paused until the guard says that the window is in front.
        if (guarded) setPaused(guardView.active ? guardView.paused : true);
        track.addEventListener?.('ended', () => { if (share === current) stop('source'); });
        try {
            const processor = new MediaStreamTrackProcessor({ track });
            current.reader = processor.readable.getReader();
        } catch (err) {
            stop('error');
            showError(`Sharing stopped: ${errorName(err)}`);
            return;
        }
        readLoop(current);
        onEncoder(lastEncoder);
        render();
    }

    async function readLoop(current) {
        try {
            for (;;) {
                const { value, done } = await current.reader.read();
                if (done) break;
                if (share !== current) { value?.close?.(); break; }
                onCaptured(value);
            }
        } catch (err) {
            if (share === current) {
                stop('error');
                showError(`Sharing stopped: ${errorName(err)}`);
            }
        }
    }

    function newTier(view) {
        const t = clock();
        return { id: view.tier, preset: view.preset, fps: view.fps ?? PRESETS[view.preset]?.fps ?? 15, bitrate: view.bitrate,
            encoder: null, gen: 0, size: null, configuredBitrate: 0, lastConfigureAt: -Infinity, mismatchSince: null,
            // E3: the bucket starts full (1 s of the bitrate).
            tokens: view.bitrate / 8, lastTokenAt: t,
            // E10: the frame slots count from the start of the tier.
            startAt: t, lastSlot: -1, keyWanted: true,
            slots: 0, skipped: 0, dropped: 0, starts: new Map(), encodeTimes: [] };
    }
    function closeEncoder(tier) {
        const encoder = tier.encoder;
        tier.encoder = null;
        tier.gen = 0;
        tier.starts.clear();
        if (encoder && encoder.state !== 'closed') {
            try { encoder.close(); } catch { /* closed */ }
        }
    }
    // E7: a new preset of a tier. A new encoder at the next frame, with the new size and frame rate, a full bucket and
    // a keyframe. The node refuses the frames of the tier until setScreenSize (DECISIONS.md P8a-3).
    function changePreset(tier, view) {
        closeEncoder(tier);
        const t = clock();
        tier.preset = view.preset;
        tier.fps = view.fps ?? PRESETS[view.preset]?.fps ?? tier.fps;
        tier.bitrate = view.bitrate;
        tier.size = null;
        tier.tokens = tier.bitrate / 8;
        tier.lastTokenAt = t;
        tier.startAt = t;
        tier.lastSlot = -1;
        tier.keyWanted = true;
    }
    // E6: the bucket follows a new bitrate at once. The encoder gets it at most each 1 s, for a change of 5 % or more.
    function setBitrate(tier, bitrate) {
        refill(tier, clock());
        tier.bitrate = bitrate;
        tier.tokens = Math.min(tier.tokens, bitrate / 8);
    }
    function maybeReconfigure(tier, t) {
        if (!tier.encoder || !tier.size || tier.configuredBitrate <= 0) return;
        if (Math.abs(tier.bitrate - tier.configuredBitrate) / tier.configuredBitrate < RECONFIGURE_CHANGE) return;
        if (t - tier.lastConfigureAt < RECONFIGURE_MS) return;
        try {
            tier.encoder.configure(encoderConfig(tier, tier.size));
            tier.configuredBitrate = tier.bitrate;
            tier.lastConfigureAt = t;
        } catch (err) { fail(err); }
    }
    function encoderConfig(tier, size) {
        return { codec: 'vp8', width: size.width, height: size.height, bitrate: Math.round(tier.bitrate), framerate: tier.fps,
            latencyMode: 'realtime', hardwareAcceleration: 'prefer-software' };
    }
    function openEncoder(tier, size) {
        closeEncoder(tier);
        const gen = ++encoderGen;
        const encoder = new VideoEncoder({
            output: chunk => onChunk(tier, gen, chunk),
            error: err => { if (tier.gen === gen) fail(err); }
        });
        encoder.configure(encoderConfig(tier, size));
        tier.encoder = encoder;
        tier.gen = gen;
        tier.size = size;
        tier.configuredBitrate = tier.bitrate;
        tier.lastConfigureAt = clock();
        tier.keyWanted = true;
        tier.mismatchSince = null;
        // DECISIONS.md P8a-3: after each configure of a size, also the first one, the node gets the coded size. It
        // sends CONFIG to the viewers of the tier and asks for a keyframe.
        api.setScreenSize({ tier: tier.id, width: size.width, height: size.height });
    }
    // E7: the coded size follows the captured size after 1000 ms with a different size.
    function ensureEncoder(tier, frame, t) {
        const box = PRESETS[tier.preset] ?? PRESETS.standard;
        const want = fit({ width: frame.displayWidth || frame.codedWidth, height: frame.displayHeight || frame.codedHeight }, box);
        if (tier.encoder && tier.size) {
            if (want.width === tier.size.width && want.height === tier.size.height) { tier.mismatchSince = null; return; }
            tier.mismatchSince ??= t;
            if (t - tier.mismatchSince < SIZE_CHANGE_MS) return;
        }
        openEncoder(tier, want);
    }
    function refill(tier, t) {
        const rate = tier.bitrate / 8;
        tier.tokens = Math.min(rate, tier.tokens + (t - tier.lastTokenAt) * rate / 1000);
        tier.lastTokenAt = t;
    }

    // ---- 1.0.4: the pause of a guarded share ----

    // The "Paused" picture with the size of the captured frames, so that the encoders keep their size (E7).
    function pausePicture(current) {
        const size = current.frameSize ?? { width: current.capture.width, height: current.capture.height };
        const width = Math.max(16, 2 * Math.round((size.width || 1280) / 2));
        const height = Math.max(16, 2 * Math.round((size.height || 720) / 2));
        let canvas;
        if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(width, height);
        else {
            canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
        }
        try {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#1e1f22';
            ctx.fillRect(0, 0, width, height);
            ctx.fillStyle = '#e3e5e8';
            ctx.font = `600 ${Math.round(height / 12)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Paused', width / 2, height / 2);
        } catch { /* a plain picture */ }
        return new VideoFrame(canvas, { timestamp: Math.round((clock() - current.startAt) * 1000) });
    }
    // Paused: the captured frames do not go out. The kept frame (E5: keyframe requests, refresh ticks) is the "Paused"
    // picture, and each tier sends it now as a keyframe. Resumed: the next captured frame is a keyframe.
    function setPaused(paused) {
        const current = share;
        if (!current?.guarded || current.paused === paused) return;
        current.paused = paused;
        try { current.kept?.frame.close(); } catch { /* closed */ }
        current.kept = null;
        if (paused) {
            totals.pauses++;
            try {
                current.kept = { frame: pausePicture(current), at: clock() };
            } catch (err) {
                fail(err);
                return;
            }
            for (const tier of current.tiers.values()) encodeKept(tier, true);
        } else {
            for (const tier of current.tiers.values()) tier.keyWanted = true;
        }
        render();
    }
    function onGuard(view) {
        guardView = { active: view?.active === true, paused: view?.paused !== false, reason: String(view?.reason ?? '') };
        if (share?.guarded) setPaused(guardView.active ? guardView.paused : true);
    }

    // One captured frame. Rule E10: each tier takes it only in a new frame slot of its preset.
    function onCaptured(frame) {
        const current = share;
        const t = clock();
        totals.captured++;
        current.frameSize = { width: frame.displayWidth || frame.codedWidth, height: frame.displayHeight || frame.codedHeight };
        // 1.0.4: a paused share drops the captured frame. A tier that wants a keyframe gets the "Paused" picture.
        if (current.paused) {
            totals.pausedCaptured++;
            frame.close();
            for (const tier of current.tiers.values()) if (tier.keyWanted) encodeKept(tier, true);
            maybeReport(t);
            return;
        }
        // E5: keep a clone of the last captured frame.
        try {
            current.kept?.frame.close();
            current.kept = { frame: frame.clone(), at: t };
        } catch { current.kept = null; }
        // E8: the chunk timestamp is the time since the start of the share in microseconds.
        let stamped = null;
        try {
            for (const tier of current.tiers.values()) {
                // The slot grid starts half a slot before the first frame of the tier, so that the frames of a
                // capture at the same frame rate sit in the middle of their slots (DECISIONS.md P8b-5).
                if (tier.lastSlot === -1) tier.startAt = t - 500 / tier.fps;
                const slot = Math.floor((t - tier.startAt) * tier.fps / 1000 + 1e-6);
                if (slot <= tier.lastSlot) continue;
                tier.lastSlot = slot;
                tier.slots++;
                stamped ??= new VideoFrame(frame, { timestamp: Math.round((t - current.startAt) * 1000) });
                encode(tier, stamped, t, { slot: true });
            }
        } finally {
            stamped?.close();
            frame.close();
        }
        maybeReport(t);
    }
    // E5: the kept frame again, as a keyframe (key: true) or as a refresh frame.
    function encodeKept(tier, key) {
        const current = share;
        if (!current?.kept) return false;
        const t = clock();
        let again = null;
        try {
            again = new VideoFrame(current.kept.frame, { timestamp: Math.round((t - current.startAt) * 1000) });
            if (current.paused) {
                totals.pauseEncoded++;
                current.pauseStamps ??= new Set();
                if (current.pauseStamps.size > 64) current.pauseStamps.clear();
                current.pauseStamps.add(again.timestamp);
            }
            encode(tier, again, t, { key, refresh: !key });
        } catch (err) {
            fail(err);
        } finally {
            again?.close();
        }
        return true;
    }
    function encode(tier, frame, t, { slot = false, key = false } = {}) {
        ensureEncoder(tier, frame, t);
        if (!tier.encoder) return;
        maybeReconfigure(tier, t);
        refill(tier, t);
        // E3: while the bucket is below zero, do not encode for this tier. A keyframe on request comes at once.
        if (!key && tier.tokens < 0) {
            if (slot) { tier.skipped++; totals.skipped++; }
            return;
        }
        // E4: at most 2 frames in the queue of the encoder.
        if (tier.encoder.encodeQueueSize >= QUEUE_LIMIT) {
            if (slot) { tier.dropped++; totals.dropped++; }
            return;
        }
        const keyFrame = key || tier.keyWanted;
        tier.keyWanted = false;
        if (tier.starts.size > 64) tier.starts.clear();
        tier.starts.set(frame.timestamp, t);
        try {
            tier.encoder.encode(frame, { keyFrame });
        } catch (err) {
            fail(err);
        }
    }
    function onChunk(tier, gen, chunk) {
        const current = share;
        if (!current || tier.gen !== gen || current.tiers.get(tier.id) !== tier) return;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const t = clock();
        // E3: subtract the bytes of each chunk.
        refill(tier, t);
        tier.tokens -= data.length;
        const start = tier.starts.get(chunk.timestamp);
        if (start !== undefined) {
            tier.starts.delete(chunk.timestamp);
            tier.encodeTimes.push(t - start);
        }
        totals.encoded++;
        if (current.pauseStamps?.delete(chunk.timestamp)) totals.pauseSent++;
        const key = chunk.type === 'key';
        if (key) totals.keyframes++;
        api.sendScreenFrame({ tier: tier.id, key, timestampMs: Math.floor(chunk.timestamp / 1000), data });
        totals.sent++;
        totals.sentBytes += data.length;
        maybeReport(t);
    }
    // E11: each 500 ms, for each tier: the frame slots, the frames that E3 skipped and E4 dropped, the encode p95.
    function maybeReport(t = clock()) {
        const current = share;
        if (!current || t - current.lastReportAt < REPORT_MS) return;
        current.lastReportAt = t;
        const tiers = [...current.tiers.values()].slice(0, MAX_REPORT_TIERS).map(tier => {
            const entry = { tier: tier.id, slots: tier.slots, skipped: tier.skipped, dropped: tier.dropped, encodeP95Ms: p95(tier.encodeTimes) };
            tier.slots = 0;
            tier.skipped = 0;
            tier.dropped = 0;
            tier.encodeTimes = [];
            return entry;
        });
        totals.reports++;
        api.reportScreenEncoder({ tiers });
    }

    // The screen-encoder event: the active tiers, the keyframe requests and the refresh ticks (rules E1, E2, E5).
    function onEncoder(view) {
        lastEncoder = view ?? { tiers: [] };
        const current = share;
        if (!current) return;
        const listed = new Set();
        for (const entry of Array.isArray(view?.tiers) ? view.tiers : []) {
            // A tier ID is a number of screen-rate.mjs.
            if (!Number.isInteger(entry?.tier) || !PRESETS[entry.preset]) continue;
            listed.add(entry.tier);
            let tier = current.tiers.get(entry.tier);
            if (!tier) {
                tier = newTier(entry);
                current.tiers.set(entry.tier, tier);
            } else if (tier.preset !== entry.preset) {
                changePreset(tier, entry);
            } else if (entry.bitrate !== tier.bitrate) {
                setBitrate(tier, entry.bitrate);
            }
            if (entry.keyFrame) {
                tier.keyWanted = true;
                // E5: a keyframe at once from the kept frame when the last captured frame is older than 100 ms.
                if (current.kept && clock() - current.kept.at > KEPT_KEY_MS) encodeKept(tier, true);
            } else if (entry.refresh) {
                encodeKept(tier, false);
            }
        }
        // E1: a tier that is not in the list has no viewer: close its encoder.
        for (const [id, tier] of current.tiers) {
            if (!listed.has(id)) {
                closeEncoder(tier);
                current.tiers.delete(id);
            }
        }
        if (view?.capture) applyCapture(view.capture);
        maybeReport();
        render();
    }
    // Section 2.1, item 6: a new capture preset (rule A1 or A9) changes the constraints of the track.
    function applyCapture(capture) {
        const current = share;
        if (!current || !capture) return;
        const { width, height, fps } = capture;
        if (current.capture.width === width && current.capture.height === height && current.capture.fps === fps) return;
        current.capture = { width, height, fps };
        Promise.resolve(current.track.applyConstraints?.({ width: { max: width }, height: { max: height }, frameRate: { max: fps } }))
            .catch(err => console.warn(`Screen capture constraints not applied: ${errorName(err)}`));
    }

    function release(current) {
        try { current.track.stop(); } catch { /* ended */ }
        for (const tier of current.tiers.values()) closeEncoder(tier);
        current.tiers.clear();
        try { current.kept?.frame.close(); } catch { /* closed */ }
        current.kept = null;
        Promise.resolve(current.reader?.cancel?.()).catch(() => {});
    }
    // Section 2.7, "Stop at once": track.stop() and the close of the encoders, then asscrack:screen-stop (a send, no
    // await before it), then the bar goes away.
    function stop(reason = 'stopped') {
        const current = share;
        if (!current) return false;
        share = null;
        release(current);
        api.stopScreenShare(reason);
        render();
        return true;
    }
    // The node stopped the share (Idle Peer, the 10 s with no session, the share limit, Leave room): release the capture.
    function endLocal() {
        const current = share;
        if (!current) return;
        share = null;
        release(current);
        render();
    }
    function fail(err) {
        if (!share) return;
        stop('error');
        showError(`Sharing stopped: ${errorName(err)}`);
    }

    // ---- The share bar ----

    function tierLine(tier) {
        const label = PRESETS[tier.preset]?.label ?? tier.preset;
        const names = (tier.viewers ?? []).map(nameOf);
        const slow = tier.role === 'slow';
        return `Quality: ${label}${names.length ? ` for ${names.join(', ')}` : ''}${slow ? ' (slow connection)' : ''}`;
    }
    function updatePreview() {
        if (previewToggle) {
            previewToggle.textContent = previewOn ? 'Hide preview' : 'Show preview';
            previewToggle.setAttribute('aria-pressed', String(previewOn));
        }
        if (!preview) return;
        const track = share?.track ?? null;
        preview.hidden = !(track && previewOn);
        if (track && previewOn && document.visibilityState !== 'hidden' && typeof MediaStream === 'function') {
            if (previewTrack?.source !== track) {
                stopPreviewTrack();
                // A clone of the captured track at PREVIEW_FPS: Chromium drops the other frames before the video.
                const clone = track.clone?.() ?? null;
                if (!clone) return;
                previewTrack = { source: track, clone };
                Promise.resolve(clone.applyConstraints?.({ frameRate: { max: PREVIEW_FPS } })).catch(() => {});
                preview.muted = true;
                preview.srcObject = new MediaStream([clone]);
            }
            Promise.resolve(preview.play?.()).catch(() => {});
        } else stopPreviewTrack();
    }
    // The clone stops with the preview. A clone that runs keeps the capture of the source open.
    function stopPreviewTrack() {
        const current = previewTrack;
        previewTrack = null;
        if (preview?.srcObject) { preview.pause?.(); preview.srcObject = null; }
        try { current?.clone.stop(); } catch { /* stopped */ }
    }
    function render() {
        updateButton();
        updatePreview();
        const current = share;
        if (statusBar) {
            statusBar.hidden = !current;
            const source = byId('share-bar-source');
            const watching = byId('share-bar-viewers');
            const quality = byId('share-bar-quality');
            const notes = byId('share-bar-notes');
            if (current) {
                if (source) source.textContent = `You are sharing: ${current.name || 'a screen'}`;
                const viewers = Array.isArray(lastViewers.viewers) ? lastViewers.viewers : [];
                if (watching) watching.textContent = viewers.length ? `${viewers.length} watching: ${viewers.map(nameOf).join(', ')}` : 'No one is watching';
                if (quality) {
                    const tiers = Array.isArray(lastViewers.tiers) ? lastViewers.tiers.filter(t => (t.viewers ?? []).length > 0) : [];
                    const lines = current.quality !== 'auto' ? [`Quality: ${PRESETS[current.quality]?.label ?? current.quality}`]
                        : tiers.length ? tiers.map(tierLine) : ['Quality: Auto'];
                    quality.replaceChildren(...lines.map(text => { const line = document.createElement('span'); line.textContent = text; return line; }));
                }
                if (notes) {
                    const texts = [];
                    if (current.guarded && current.paused) texts.push('Paused');
                    for (const r of Array.isArray(lastViewers.relayed) ? lastViewers.relayed : []) {
                        texts.push(`${nameOf(r.peerId)}: relayed, ${Math.round((r.bitrate ?? 0) / 1000)} kbit/s`);
                    }
                    const cpu = lastViewers.cpu;
                    if (current.quality === 'auto' && cpu?.lowered && PRESETS[lastViewers.cap]) {
                        const above = LADDER[LADDER.indexOf(lastViewers.cap) + 1];
                        if (above) texts.push(`Too slow for ${PRESETS[above].label}. Using ${PRESETS[lastViewers.cap].label}.`);
                    }
                    if (current.quality !== 'auto' && cpu?.tooSlow) {
                        texts.push(`Can't encode ${PRESETS[current.quality]?.label ?? current.quality} in real time. Try Auto.`);
                    }
                    notes.replaceChildren(...texts.map(text => { const line = document.createElement('span'); line.textContent = text; return line; }));
                    notes.hidden = texts.length === 0;
                }
            }
        }
        // W6: the detached voice panel shows the share (renderer.js publishes its view).
        if (typeof updateVoiceView === 'function') {
            try { updateVoiceView(); } catch { /* the voice view is not ready */ }
        }
    }

    // ---- Events ----

    button.addEventListener('click', openPicker);
    goButton.addEventListener('click', () => startFromPicker(false));
    borderSwitch?.addEventListener('click', () => {
        if (listedSources.get(selectedId)?.kind !== 'window') return;
        startFromPicker(true);
    });
    cancelButton?.addEventListener('click', closePicker);
    // Escape closes the dialog (the native cancel). The close ends a pending list.
    picker.addEventListener('close', () => { pickerToken++; });
    byId('share-stop')?.addEventListener('click', () => stop('stopped'));
    previewToggle?.addEventListener('click', () => {
        previewOn = !previewOn;
        try { localStorage.setItem(PREVIEW_KEY, String(previewOn)); } catch { /* no storage */ }
        updatePreview();
    });
    document.addEventListener('visibilitychange', updatePreview);
    fillQualities();

    api.onScreenEncoder?.(view => onEncoder(view));
    api.onScreenGuard?.(view => onGuard(view));
    api.onScreenViewers?.(view => {
        lastViewers = view ?? lastViewers;
        if (share) render();
    });
    api.onScreenState?.(state => {
        if (!state) return;
        if (state.own) {
            if (!state.sharing) endLocal();
            return;
        }
        if (state.sharing) others.set(state.peerId, state.shareId);
        else others.delete(state.peerId);
        if (atLimit() && picker.open && !starting) {
            closePicker();
            showError(limitText());
        }
        // A place is free again: the limit text goes away.
        if (!atLimit() && errorLine?.textContent === limitText()) showError('');
        updateButton();
    });
    api.onScreenEnded?.(data => {
        if (!data?.own) return;
        endLocal();
        if (data.reason === 'source') showError('Sharing stopped: the source closed.');
        else if (data.reason === 'isolated') showError('Sharing stopped: the room connection was lost.');
        else if (data.reason === 'limit') showError(`${limitText()} Your share stopped.`);
    });
    api.onIdlePeer?.(state => {
        idle = state?.idle === true;
        if (idle) {
            endLocal();
            closePicker();
        }
        updateButton();
    });
    window.roomVoiceMonitor?.onStopShare?.(() => stop('stopped'));
    // The window reads the state after it subscribed, so that an early event is not lost.
    Promise.resolve(api.getScreenState?.()).then(state => {
        if (Number.isInteger(state?.maxShares) && state.maxShares > 0) maxShares = state.maxShares;
        for (const [peerId, value] of Object.entries(state?.peers ?? {})) others.set(peerId, value?.shareId ?? null);
        updateButton();
    }).catch(() => {});
    Promise.resolve(api.getIdlePeer?.()).then(state => { idle = state?.idle === true; updateButton(); }).catch(() => {});

    window.screenShare = Object.freeze({
        isSharing: () => share !== null,
        // The preview state for the checks: shown (the element), live (a track in the video).
        preview: () => ({ on: previewOn, shown: Boolean(preview && !preview.hidden), live: Boolean(preview?.srcObject) }),
        stop,
        stats: () => ({
            sharing: share !== null, trackState: lastTrack?.readyState ?? null, ...totals,
            guarded: share?.guarded === true, paused: share?.paused === true,
            tiers: share ? [...share.tiers.values()].map(t => ({ tier: t.id, preset: t.preset, fps: t.fps, bitrate: t.bitrate,
                width: t.size?.width ?? null, height: t.size?.height ?? null, encoder: Boolean(t.encoder) })) : [],
            capture: share?.capture ?? null,
            // The groups of the last screen-viewers event: [{ tier, role, preset, bitrate, viewers }].
            groups: share && Array.isArray(lastViewers.tiers) ? lastViewers.tiers.map(t => ({ ...t, viewers: [...(t.viewers ?? [])] })) : []
        })
    });
    updateButton();
})();
