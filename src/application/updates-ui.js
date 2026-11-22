// P9C: the update bar and the update part of About ASSCRACK. The main process (update-service.mjs) checks the
// signature, downloads the file and does the restart. The window gets the versions, the state and the note text
// (plain text: textContent only). It gives no path and no URL.
// API for app-shell.js: window.updatesUi = { refreshAbout() }.
(function () {
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const bar = byId('update-bar');
    if (!api?.getUpdate || !bar) return;
    const text = byId('update-text');
    const restartButton = byId('update-restart');
    const downloadButton = byId('update-download');
    const notesButton = byId('update-notes');
    const laterButton = byId('update-later');
    const notesDialog = byId('update-notes-dialog');
    const busyDialog = byId('update-busy-dialog');
    let view = null;
    let hiddenFor = null;

    function barText(update) {
        if (update.ready && update.inDownloads) return `ASSCRACK ${update.version} is ready in your Downloads folder.`;
        if (update.ready) return `ASSCRACK ${update.version} is ready.`;
        if (update.downloading) return `ASSCRACK ${update.version} is available. Downloading…`;
        return `ASSCRACK ${update.version} is available.`;
    }

    function lastText(last) {
        if (!last?.time) return 'No check yet.';
        const when = new Date(last.time).toLocaleString();
        return `Last check: ${when}. ${last.note ?? ''}`.trim();
    }

    function stateText(current) {
        const update = current.update;
        if (update?.ready) return `ASSCRACK ${update.version} is ready. Restart to update.`;
        if (update?.downloading) return `ASSCRACK ${update.version} is downloading.`;
        if (update) return `ASSCRACK ${update.version} is available.` + (update.note ? ' ' + update.note : '');
        if (current.checking) return 'Checking for updates…';
        if (!current.buildKind) return 'This copy cannot install updates (for example npm start). It can check only.';
        return '';
    }

    function render(next) {
        view = next ?? view;
        if (!view) return;
        const update = view.update;
        const show = !!update && !view.dismissed && hiddenFor !== update.version;
        bar.hidden = !show;
        if (show) {
            text.textContent = barText(update);
            restartButton.hidden = !update.ready;
            downloadButton.hidden = update.ready || update.downloading || !update.canDownload;
        }
        const state = byId('about-update-state');
        if (state) {
            state.textContent = stateText(view);
            byId('about-update-last').textContent = lastText(view.lastCheck);
            byId('about-update-auto').checked = view.enabled === true;
            byId('about-update-check').disabled = view.checking === true;
        }
    }

    async function call(fn) {
        try { render(await fn()); } catch { /* the main process logs; the bar stays as it is */ }
    }

    restartButton.addEventListener('click', async () => {
        restartButton.disabled = true;
        try {
            const result = await api.restartToUpdate(false);
            if (result?.busy) {
                byId('update-busy-text').textContent = result.busy === 'voice'
                    ? 'You are in a voice call. The restart ends the call.'
                    : 'A file transfer runs. The restart stops it.';
                busyDialog.showModal();
            }
        } catch { /* see above */ } finally {
            restartButton.disabled = false;
        }
    });
    byId('update-busy-restart').addEventListener('click', async () => {
        busyDialog.close();
        try { await api.restartToUpdate(true); } catch { /* see above */ }
    });
    byId('update-busy-cancel').addEventListener('click', () => busyDialog.close());
    downloadButton.addEventListener('click', () => call(() => api.downloadUpdate()));
    laterButton.addEventListener('click', () => {
        hiddenFor = view?.update?.version ?? null;
        call(() => api.updateLater());
    });
    notesButton.addEventListener('click', () => {
        const update = view?.update;
        if (!update || notesDialog.open) return;
        byId('update-notes-title').textContent = `What's new in ASSCRACK ${update.version}`;
        byId('update-notes-meta').textContent = update.date ? `Release date: ${update.date}` : '';
        byId('update-notes-text').textContent = update.notes ?? '';
        notesDialog.showModal();
    });
    byId('about-update-check')?.addEventListener('click', () => call(() => api.checkUpdate()));
    byId('about-update-auto')?.addEventListener('change', event => call(() => api.setUpdateCheck(event.target.checked === true)));

    api.onUpdate(next => render(next));
    call(() => api.getUpdate());
    window.updatesUi = { refreshAbout: () => call(() => api.getUpdate()) };
})();
