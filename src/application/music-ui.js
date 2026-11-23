'use strict';

// Room music: the music bar of the room window (MU-5). In voice only. Now playing, Pause, Skip, Stop (the DJ), the
// music volume and ducking of this listener, the queue with Add (a YouTube link), Add files and the music folder (the
// DJ's own computer). The chat commands /play <link>, /skip, /queue and /pause (renderer.js calls command()).
// Each title is peer text: textContent only.
// Reads the globals of renderer.js: ownName and peerNames.
(function () {
    const api = window.asscrack;
    const core = window.musicCore;
    if (!api || !core || typeof api.onMusic !== 'function' || !window.music) return;
    const byId = id => document.getElementById(id);
    const bar = byId('music-bar');
    if (!bar) return;
    const title = byId('music-title');
    const meta = byId('music-meta');
    const pauseButton = byId('music-pause');
    const skipButton = byId('music-skip');
    const stopButton = byId('music-stop');
    const volume = byId('music-volume');
    const ducking = byId('music-ducking');
    const queueToggle = byId('music-queue-toggle');
    const queuePanel = byId('music-queue-panel');
    const count = byId('music-count');
    const form = byId('music-add-form');
    const link = byId('music-link');
    const filesButton = byId('music-files');
    const folderButton = byId('music-folder');
    const folderList = byId('music-folder-list');
    const list = byId('music-queue');
    const status = byId('music-status');

    let view = null;
    let statusTimer = null;

    function nameOf(peerId) {
        if (peerId && peerId === view?.self) return (typeof ownName === 'string' && ownName) || 'You';
        const name = typeof peerNames !== 'undefined' ? peerNames.get(peerId) : '';
        return name || String(peerId ?? '').slice(-8);
    }

    // Out of voice the bar is hidden: the text goes to the status line of the room.
    function setStatus(text) {
        if (bar.hidden) {
            const roomStatus = byId('status');
            if (roomStatus && text) roomStatus.textContent = text;
            return;
        }
        status.textContent = text ?? '';
        clearTimeout(statusTimer);
        if (text) statusTimer = setTimeout(() => { status.textContent = ''; }, 8000);
    }

    const errorText = err => String(err?.message ?? err ?? 'Error').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

    function element(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    function render() {
        const inVoice = view?.inVoice === true;
        bar.hidden = !inVoice;
        if (!inVoice) return;
        const active = Boolean(view.dj);
        const mine = view.mine === true;
        bar.classList.toggle('active', active && Boolean(view.now));
        title.textContent = view.now ? view.now.title : active ? 'Waiting for the next track' : 'No music';
        const parts = [];
        if (active) parts.push(`DJ ${nameOf(view.dj)}`);
        if (view.now?.dur) parts.push(core.clock(view.now.dur));
        if (active && view.yt === false) parts.push('YouTube unavailable');
        if (mine && view.adding) parts.push('Adding…');
        meta.textContent = parts.join(' · ');
        pauseButton.hidden = !view.now;
        pauseButton.textContent = view.paused ? 'Play' : 'Pause';
        pauseButton.setAttribute('aria-pressed', String(view.paused === true));
        skipButton.hidden = !view.now;
        stopButton.hidden = !mine;
        count.textContent = view.queue.length ? String(view.queue.length) : '';
        // Only the DJ (or a member while no DJ plays) adds files: they are on this computer.
        const filesAllowed = !active || mine;
        filesButton.disabled = !filesAllowed;
        folderButton.disabled = !filesAllowed;
        filesButton.title = filesAllowed ? '' : 'Only the DJ can add files';
        if (!filesAllowed) folderList.hidden = true;
        list.replaceChildren(...view.queue.map((item, index) => {
            const row = element('li', 'music-item');
            row.dataset.id = item.id;
            row.append(element('span', 'music-item-title', item.title));
            const info = [item.src === 'file' ? 'File' : null, item.dur ? core.clock(item.dur) : null, nameOf(item.by)].filter(Boolean);
            row.append(element('span', 'music-item-meta', info.join(' · ')));
            if (mine) {
                const up = element('button', 'music-up', '↑');
                up.type = 'button';
                up.title = 'Move up';
                up.setAttribute('aria-label', `Move up: ${item.title}`);
                up.disabled = index === 0;
                const down = element('button', 'music-down', '↓');
                down.type = 'button';
                down.title = 'Move down';
                down.setAttribute('aria-label', `Move down: ${item.title}`);
                down.disabled = index === view.queue.length - 1;
                row.append(up, down);
            }
            if (mine || item.by === view.self) {
                const remove = element('button', 'music-remove', 'Remove');
                remove.type = 'button';
                remove.setAttribute('aria-label', `Remove: ${item.title}`);
                row.append(remove);
            }
            return row;
        }));
        if (!view.queue.length) list.append(element('li', 'music-empty', 'Queue empty'));
    }

    function apply(next) {
        view = next ?? null;
        render();
    }

    async function run(fn) {
        try {
            const result = await fn();
            if (result && typeof result === 'object' && 'dj' in result) apply(result);
            return result;
        } catch (err) {
            setStatus(errorText(err));
            return null;
        }
    }

    // A YouTube link of the add field or of /play. Gives true when the add went to the DJ (or this node resolved it).
    async function addLink(text) {
        const value = String(text ?? '').trim();
        if (!value) { setStatus('Paste a YouTube link.'); return false; }
        const result = await run(() => api.musicAdd(value));
        if (!result) return false;
        if (result.ok === false) {
            setStatus(core.noticeText(result.kind) || 'Not added.');
            return false;
        }
        setStatus(result.count > 1 ? `Added ${result.count} videos.` : 'Added.');
        return true;
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (await addLink(link.value)) link.value = '';
    });
    pauseButton.addEventListener('click', () => run(() => api.musicPause(!view?.paused)));
    skipButton.addEventListener('click', () => run(() => api.musicSkip()));
    stopButton.addEventListener('click', () => run(() => api.musicStop()));
    filesButton.addEventListener('click', async () => {
        const result = await run(() => api.musicAddFiles());
        if (result?.ok && result.count) setStatus(result.count > 1 ? `Added ${result.count} files.` : 'Added.');
    });
    queueToggle.addEventListener('click', () => {
        queuePanel.hidden = !queuePanel.hidden;
        queueToggle.setAttribute('aria-expanded', String(!queuePanel.hidden));
    });
    list.addEventListener('click', event => {
        const button = event.target?.closest?.('button');
        const row = button?.closest('.music-item');
        if (!row || !view) return;
        const id = row.dataset.id;
        const index = view.queue.findIndex(item => item.id === id);
        if (button.classList.contains('music-remove')) void run(() => api.musicRemove(id));
        else if (button.classList.contains('music-up')) void run(() => api.musicMove(id, index - 1));
        else if (button.classList.contains('music-down')) void run(() => api.musicMove(id, index + 1));
    });

    // The music folder: the first click shows the files (the main process keeps the paths; the window gets IDs and
    // names). "Change folder" opens the folder dialog.
    async function showFolder(choose) {
        const result = await run(() => (choose ? api.musicChooseFolder() : api.musicFolder()));
        if (!result) return;
        if (!result.folder) {
            if (!choose) return showFolder(true);
            return;
        }
        const rows = result.files.map(file => {
            const row = element('li', 'music-file');
            const add = element('button', 'music-file-add', file.name);
            add.type = 'button';
            add.dataset.id = file.id;
            add.title = 'Add';
            row.append(add);
            return row;
        });
        const change = element('li', 'music-file');
        const changeButton = element('button', 'music-folder-change', 'Change folder');
        changeButton.type = 'button';
        change.append(changeButton);
        if (!rows.length) rows.push(element('li', 'music-empty', 'No audio files'));
        folderList.replaceChildren(...rows, change);
        folderList.hidden = false;
    }
    folderButton.addEventListener('click', () => {
        if (!folderList.hidden) { folderList.hidden = true; return; }
        void showFolder(false);
    });
    folderList.addEventListener('click', async event => {
        const button = event.target?.closest?.('button');
        if (!button) return;
        if (button.classList.contains('music-folder-change')) return showFolder(true);
        const result = await run(() => api.musicAddFolderFile(button.dataset.id));
        if (result?.ok) setStatus('Added.');
    });

    volume.addEventListener('input', () => { void window.music.setSettings({ volume: Number(volume.value) }); });
    ducking.addEventListener('change', () => { void window.music.setSettings({ ducking: ducking.checked }); });
    Promise.resolve(api.getMusicSettings?.()).then(value => {
        if (!value) return;
        volume.value = String(value.volume);
        ducking.checked = value.ducking === true;
    }).catch(() => {});

    api.onMusic(apply);
    api.onMusicNotice?.(notice => {
        const text = core.noticeText(notice?.kind);
        if (text) setStatus(text);
    });
    Promise.resolve(api.getMusic?.()).then(value => { if (value && !view) apply(value); }).catch(() => {});
    // A new name changes the lines.
    api.onPeerName?.(() => render());

    // renderer.js (sendMessage): false when the text is not a music command; else a promise of true when the command
    // ran (the text then leaves the box). /queue shows the queue in the status line of the bar.
    function command(text) {
        const parsed = core.parseCommand(text);
        if (!parsed) return false;
        return (async () => {
            if (parsed.name === 'play' && parsed.link) return addLink(parsed.link);
            if (parsed.name !== 'queue' && !view?.now) {
                setStatus(view?.inVoice ? 'No music.' : 'Join voice first.');
                return true;
            }
            if (parsed.name === 'play') return Boolean(await run(() => api.musicPause(false)));
            if (parsed.name === 'skip') return Boolean(await run(() => api.musicSkip()));
            if (parsed.name === 'pause') return Boolean(await run(() => api.musicPause(!view?.paused)));
            const lines = core.queueLines(view, nameOf);
            queuePanel.hidden = false;
            queueToggle.setAttribute('aria-expanded', 'true');
            setStatus(lines.slice(0, 2).join(' · '));
            return true;
        })();
    }

    window.musicUi = { command, isCommand: core.isCommand, view: () => view, reset: () => apply(null) };
})();
