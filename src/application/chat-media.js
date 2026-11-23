// The main process supplies opaque URLs only for a validated derivative or a
// verified local original. The caption and download controls are independent.
(function () {
    const api = window.asscrack;
    const menu = document.getElementById('view-previews');
    if (!api?.getMediaInfo || !menu) return;
    const records = new Map(), queue = new Set();
    // Gap D7: the image viewer. A click on a chat image, or the row action "View image", opens it.
    const viewer = document.getElementById('image-viewer');
    const viewerImage = document.getElementById('image-viewer-image');
    let viewing = 0, viewed = null;
    const key = 'asscrack.automaticThumbnails.v1';
    let auto = true, active = 0, playing = null;
    try { auto = localStorage.getItem(key) !== 'false'; } catch {}

    function menuState() { menu.setAttribute('aria-checked', String(auto)); }
    function visible(entry) { return entry.row.isConnected && document.visibilityState === 'visible'; }

    function stopPlayback() {
        const current = playing;
        playing = null;
        current?.stop();
    }

    function showError(entry, text) {
        const notice = document.createElement('span');
        notice.className = 'chat-media-status';
        notice.textContent = text;
        entry.box.replaceChildren(notice);
    }

    function showGif(entry, info) {
        if (!window.ImageDecoder) { showError(entry, 'Animation playback unavailable.'); return; }
        const canvas = document.createElement('canvas');
        canvas.width = info.width; canvas.height = info.height;
        canvas.setAttribute('aria-label', entry.descriptor.name);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.textContent = 'Play animation';
        entry.box.replaceChildren(canvas, toggle);
        let frame = 0, generation = 0, timer = null, decoder = null, controller = null;
        function stop() {
            generation++;
            clearTimeout(timer); controller?.abort(); decoder?.close();
            decoder = null; controller = null;
            toggle.textContent = 'Play animation';
            if (playing?.entry === entry) playing = null;
        }
        entry.stop = stop;
        async function draw(animate) {
            stop();
            if (animate) {
                stopPlayback(); playing = { entry, stop };
                toggle.textContent = 'Pause animation';
            }
            const current = generation;
            try {
                controller = new AbortController();
                const res = await fetch(info.originalUrl, { signal: controller.signal });
                if (current !== generation) return;
                if (!res.ok) throw Error();
                const local = decoder = new ImageDecoder({ type: 'image/gif', data: res.body, preferAnimation: true });
                await local.tracks.ready; await local.completed;
                const count = local.tracks.selectedTrack?.frameCount || 1;
                async function next() {
                    if (current !== generation) return;
                    const { image } = await local.decode({ frameIndex: frame % count });
                    try {
                        if (current !== generation) return;
                        canvas.getContext('2d').drawImage(image, 0, 0);
                        canvas.dataset.frame = String(frame % count);
                        if (!animate) { stop(); return; }
                        frame = (frame + 1) % count;
                        const ms = Math.min(10000, Math.max(20, (image.duration || 100000) / 1000));
                        timer = setTimeout(() => next().catch(failed), ms);
                    } finally { image.close(); }
                }
                await next();
            } catch { failed(); }
            function failed() {
                if (current !== generation) return;
                stop(); showError(entry, 'Can\'t play this animation.');
            }
        }
        toggle.addEventListener('click', () => {
            if (playing?.entry === entry) stop();
            else if (!window.idlePeer?.isIdle()) void draw(true);
        });
        // A first-frame poster stays still, including with reduced motion enabled.
        void draw(false);
    }

    function paint(entry, info) {
        const { descriptor, box } = entry;
        const url = descriptor.kind === 'image' ? (auto || entry.manual ? info.thumbnailUrl : null) : info.originalUrl;
        if (entry.url === (url || null)) return;
        entry.stop?.(); entry.stop = null;
        entry.url = url || null;
        box.replaceChildren();
        if (!url) {
            if (descriptor.kind === 'image') {
                const b = document.createElement('button');
                b.type = 'button'; b.textContent = 'Show thumbnail';
                b.addEventListener('click', () => { entry.manual = true; entry.attempted = false; enqueue(entry); });
                box.append(b);
            }
            return;
        }
        if (descriptor.kind === 'gif') { showGif(entry, info); return; }
        const media = document.createElement(descriptor.kind === 'video' ? 'video' : 'img');
        if (descriptor.kind === 'video') {
            media.controls = true; media.preload = 'metadata'; media.playsInline = true;
            if (!media.canPlayType(info.mime)) { showError(entry, 'Can\'t play this video format.'); return; }
            media.addEventListener('loadedmetadata', () => {
                if (media.videoWidth * media.videoHeight <= 16_000_000 && Math.max(media.videoWidth,media.videoHeight) <= 8192) return;
                media.removeAttribute('src'); media.load();
                showError(entry, 'Video too large to play here.');
            });
            media.addEventListener('play', () => {
                if (window.idlePeer?.isIdle()) { media.pause(); return; }
                stopPlayback(); playing = { entry, stop: () => media.pause() };
            });
            media.addEventListener('pause', () => { if (playing?.entry === entry) playing = null; });
            entry.stop = () => { media.pause(); media.removeAttribute('src'); media.load(); };
        } else {
            media.alt = 'Thumbnail of ' + descriptor.name; media.loading = 'lazy';
            // Not a tab stop: the keyboard uses the row action "View image".
            media.addEventListener('click', () => { void view(entry); });
        }
        media.addEventListener('error', () => {
            if (entry.url === url && box.contains(media)) showError(entry, 'No preview.');
        }, { once: true });
        media.src = url; box.append(media);
    }

    // At most two bounded preview requests, including the decoder work in main.
    async function run(entry) {
        let info = await api.getMediaInfo(entry.descriptor);
        if (entry.descriptor.kind === 'image' && !info.thumbnailUrl && (auto || entry.manual) && !entry.attempted) {
            entry.attempted = true;
            info = await api.requestMediaPreview(entry.descriptor);
        }
        if (info.thumbnailUrl) entry.attempted = true;
        if (records.get(entry.descriptor.id) === entry) paint(entry, info);
    }
    function drain() {
        while (active < 2 && queue.size) {
            const entry = queue.values().next().value; queue.delete(entry);
            if (entry.busy) { entry.again = true; continue; }
            active++; entry.busy = true;
            void run(entry).catch(() => paint(entry, {})).finally(() => {
                entry.busy = false; active--;
                if (entry.again) { entry.again = false; queue.add(entry); }
                drain();
            });
        }
    }
    function enqueue(entry) { queue.add(entry); drain(); }
    function imageEntry(row) {
        for (const entry of records.values()) if (entry.row === row && entry.descriptor.kind === 'image') return entry;
        return null;
    }
    // The original if getMediaInfo gives one, else the thumbnail. Escape closes the dialog (the dialog does that).
    async function view(entry) {
        if (!viewer || !viewerImage || !entry) return false;
        const call = ++viewing;
        let info = null;
        try { info = await api.getMediaInfo(entry.descriptor); } catch {}
        const url = info?.originalUrl || info?.thumbnailUrl || entry.url;
        if (call !== viewing || !url) return false;
        viewerImage.src = url;
        viewerImage.alt = entry.descriptor.name || 'Image';
        viewed = entry;
        if (!viewer.open) viewer.showModal();
        return true;
    }
    viewer?.addEventListener('close', () => { viewing++; viewed = null; viewerImage?.removeAttribute('src'); });
    // The image menu (menu.js): Copy image, Save image as and Open original. The main process checks each request.
    // Copy image needs the preview PNG (the decoder window copies it). Save image as without a local original starts
    // the download of the original (chat-attachments.js), and the main process saves the file at its end.
    async function saveImage(entry) {
        if (!entry || !api.saveMediaImage) return null;
        const result = await api.saveMediaImage(entry.row.dataset.id, entry.descriptor);
        if (!result?.pending) return result;
        if (await window.chatAttachments?.download?.(entry.row)) return result;
        await api.cancelMediaSave?.(entry.descriptor.id);
        return { ok: false, reason: 'unavailable' };
    }
    function decorate(row, descriptor) {
        if (!row || !descriptor?.id) return;
        const old = records.get(descriptor.id);
        if (old?.row === row) return;
        old?.stop?.();
        if (old) { old.box.remove(); queue.delete(old); }
        const box = document.createElement('div'); box.className = 'chat-media';
        row.append(box);
        const entry = { row, box, descriptor, manual: false, attempted: false };
        records.set(descriptor.id, entry); enqueue(entry);
    }
    api.onMediaChanged(id => { const entry = records.get(id); if (entry) enqueue(entry); });
    api.onAttachmentStatus?.(data => {
        const entry = records.get(data.id);
        if (entry && data.available && !entry.url) { entry.attempted = false; enqueue(entry); }
    });
    function pauseHidden() {
        if (playing && !visible(playing.entry)) stopPlayback();
    }
    api.onIdlePeer?.(state => { if (state.idle) stopPlayback(); });
    document.addEventListener('visibilitychange', pauseHidden);
    new MutationObserver(pauseHidden).observe(document.getElementById('messages'), { childList: true });
    window.addEventListener('pagehide', () => { stopPlayback(); for (const e of records.values()) e.stop?.(); });
    window.chatMedia = { decorate,
        hasImage: row => imageEntry(row) !== null,
        viewImage: row => view(imageEntry(row)),
        canCopy: row => Boolean(imageEntry(row)?.url && api.copyMediaImage),
        copyImage: async row => { const entry = imageEntry(row); return Boolean(entry?.url) && await api.copyMediaImage(entry.descriptor) === true; },
        saveImage: row => saveImage(imageEntry(row)),
        openOriginal: async row => { const entry = imageEntry(row); return Boolean(entry) && (await api.openMediaOriginal?.(row.dataset.id, entry.descriptor))?.ok === true; },
        // The row of the image in the open viewer, or null.
        viewerRow: () => (viewer?.open && viewed?.row.isConnected ? viewed.row : null),
        async clearPreviews() {
        for (const entry of records.values()) { entry.attempted = true; entry.manual = false; }
        await api.clearMediaPreviews();
    }, toggleAuto() {
        auto = !auto;
        try { localStorage.setItem(key, String(auto)); } catch {}
        menuState();
        for (const entry of records.values()) { entry.manual = false; entry.attempted = false; enqueue(entry); }
    } };
    menuState();
})();
