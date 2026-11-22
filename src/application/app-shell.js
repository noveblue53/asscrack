// G5, the Windows app shell of the room window: About ASSCRACK (gap E3), Keyboard shortcuts and F1 (E6), Leave room
// (A7) and Quit with active transfers (N6). Each dialog is a native <dialog>: it closes on Escape by itself.
// API for layout.js: window.appShell = { openAbout(), openShortcuts(), openLeave(), quit() }.
(function () {
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const errorText = err => String(err?.message ?? err ?? '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    // ---- E6: one table of the keys that work in this build. The push-to-talk key comes from the voice settings. ----
    const SHORTCUTS = Object.freeze([
        ['Enter', 'Send the message'],
        ['Shift+Enter', 'Start a new line in the message'],
        ['Ctrl+F', 'Find in the loaded messages'],
        ['F3 and Shift+F3', 'Go to the next or the previous result of Find'],
        ['Escape', 'Close the menu, the panel or the dialog on top'],
        ['Alt+J', 'Go to the next unread highlight'],
        ['Shift+F10 and the Menu key', 'Open the menu of the selected line'],
        ['Arrow keys', 'Move between the lines of a list or a menu'],
        ['F1', 'Show the keyboard shortcuts']
    ]);
    const PUSH_TO_TALK = 'Push to talk (voice settings)';

    async function pushToTalkKey() {
        try {
            const settings = await api.getVoiceSettings?.();
            const code = typeof settings?.pttKey === 'string' && settings.pttKey ? settings.pttKey : null;
            if (!code) return 'Not set';
            return window.voicePanel?.keyName?.(code) ?? code;
        } catch {
            return 'Not set';
        }
    }

    function row(key, action) {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.scope = 'row';
        th.textContent = key;
        const td = document.createElement('td');
        td.textContent = action;
        tr.append(th, td);
        return tr;
    }

    async function openShortcuts() {
        const dialog = byId('shortcuts-dialog');
        if (!dialog || dialog.open) return;
        const ptt = await pushToTalkKey();
        byId('shortcuts-list').replaceChildren(...SHORTCUTS.map(([key, action]) => row(key, action)), row(ptt, PUSH_TO_TALK));
        if (!dialog.open) dialog.showModal();
    }

    document.addEventListener('keydown', event => {
        if (event.key !== 'F1' || event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey ||
            event.shiftKey || event.metaKey) return;
        event.preventDefault();
        void openShortcuts();
    });

    // ---- E3: About ASSCRACK ----
    let aboutText = '';
    async function openAbout() {
        const dialog = byId('about-dialog');
        if (!dialog || dialog.open) return;
        byId('about-status').textContent = '';
        try {
            const about = await api.getAbout();
            const version = 'ASSCRACK ' + about.version;
            const runtime = 'Electron ' + about.electron + ' · Chromium ' + about.chromium + ' · ' + about.system;
            byId('about-version').textContent = version;
            byId('about-runtime').textContent = runtime;
            byId('about-log').hidden = about.debugLog !== true;
            aboutText = version + '\n' + runtime;
        } catch {
            byId('about-status').textContent = 'The version info could not be read.';
        }
        if (!dialog.open) dialog.showModal();
    }
    byId('about-copy')?.addEventListener('click', async () => {
        try {
            await api.copyText(aboutText);
            byId('about-status').textContent = 'Version info copied.';
        } catch {
            byId('about-status').textContent = 'The version info could not be copied.';
        }
    });
    byId('about-data')?.addEventListener('click', async () => {
        try {
            const result = await api.openDataFolder();
            byId('about-status').textContent = result?.ok ? '' : 'The data folder could not be opened.';
        } catch {
            byId('about-status').textContent = 'The data folder could not be opened.';
        }
    });

    // ---- A7 and N6: the transfers that stop ----
    function activeTransfers() {
        return window.roomTransfers?.activeCount() ?? 0;
    }
    function transfersStopText(count) {
        return count === 1 ? '1 file transfer stops.' : count + ' file transfers stop.';
    }

    // ---- A7: Leave room ----
    function leaveText(info) {
        if (info?.saved) return 'Leave this room? You go out of voice and the chat closes. The room stays in Saved rooms.';
        if (info?.owner) {
            return 'Leave this room? You own it and it is not saved on this device. If you leave, you cannot open it as the owner again.';
        }
        return 'Leave this room? It is not saved on this device. To come back, you need your invite again.';
    }

    let leaving = false;
    async function openLeave() {
        const dialog = byId('leave-dialog');
        if (!dialog || dialog.open || leaving || byId('chat-screen')?.hidden) return;
        let info = null;
        try { info = await api.leaveRoomInfo(); } catch { info = null; }
        byId('leave-text').textContent = leaveText(info);
        const count = activeTransfers();
        byId('leave-transfers').textContent = count > 0 ? transfersStopText(count) : '';
        byId('leave-transfers').hidden = count === 0;
        byId('leave-status').textContent = '';
        byId('leave-confirm').disabled = false;
        if (!dialog.open) dialog.showModal();
    }
    byId('leave-confirm')?.addEventListener('click', async () => {
        if (leaving) return;
        leaving = true;
        byId('leave-confirm').disabled = true;
        byId('leave-status').textContent = 'Leaving the room…';
        try {
            // The main process stops the node and then reloads the window.
            if (await api.leaveRoom()) return;
            byId('leave-status').textContent = 'Could not leave the room.';
        } catch (err) {
            byId('leave-status').textContent = 'Could not leave the room. ' + errorText(err);
        }
        leaving = false;
        byId('leave-confirm').disabled = false;
    });
    byId('leave-room')?.addEventListener('click', () => {
        byId('room-options')?.hidePopover?.();
        void openLeave();
    });

    // ---- N6: View, Quit with an active transfer asks first. The tray Quit and Alt+F4 do not change. ----
    function quit() {
        const count = activeTransfers();
        const dialog = byId('quit-dialog');
        if (count === 0 || !dialog) {
            api.quit();
            return;
        }
        byId('quit-text').textContent = 'Quit ASSCRACK? ' + transfersStopText(count);
        if (!dialog.open) dialog.showModal();
    }
    byId('quit-confirm')?.addEventListener('click', () => {
        byId('quit-dialog').close();
        api.quit();
    });

    window.appShell = Object.freeze({ openAbout, openShortcuts, openLeave, quit });
})();
