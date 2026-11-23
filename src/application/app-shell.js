// G5, the Windows app shell of the room window: About ASSCRACK (gap E3), Keyboard shortcuts and F1 (E6), Leave room
// (A7) and Quit with active transfers (N6). Each dialog is a native <dialog>: it closes on Escape by itself.
// API for layout.js: window.appShell = { openAbout(), openShortcuts(), openLeave(), quit() }.
(function () {
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const errorText = err => String(err?.message ?? err ?? '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    // ---- E6: one table of the keys that work in this build. The push-to-talk key comes from the voice settings. ----
    const SHORTCUTS = Object.freeze([
        ['Enter', 'Send'],
        ['Shift+Enter', 'New line'],
        ['Ctrl+F', 'Find'],
        ['F3 and Shift+F3', 'Next / previous result'],
        ['Escape', 'Close menu or dialog'],
        ['Alt+J', 'Next unread highlight'],
        ['Up and Down', 'Previous sent message'],
        ['Tab', 'Complete a name'],
        ['Ctrl+Shift+M', 'Mute / unmute'],
        ['Ctrl+Shift+D', 'Deafen / undeafen'],
        ['Shift+F10 and the Menu key', 'Open context menu'],
        ['Arrow keys', 'Move in lists and menus'],
        ['Ctrl+,', 'Settings menu'],
        ['F1', 'Keyboard shortcuts']
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
            byId('about-status').textContent = 'Couldn\'t read version info.';
        }
        // P9C: the update part (updates-ui.js).
        window.updatesUi?.refreshAbout();
        if (!dialog.open) dialog.showModal();
    }
    byId('about-copy')?.addEventListener('click', async () => {
        try {
            await api.copyText(aboutText);
            byId('about-status').textContent = 'Copied.';
        } catch {
            byId('about-status').textContent = 'Couldn\'t copy.';
        }
    });
    byId('about-data')?.addEventListener('click', async () => {
        try {
            const result = await api.openDataFolder();
            byId('about-status').textContent = result?.ok ? '' : 'Couldn\'t open the data folder.';
        } catch {
            byId('about-status').textContent = 'Couldn\'t open the data folder.';
        }
    });

    // ---- A7 and N6: the transfers that stop ----
    function activeTransfers() {
        return window.roomTransfers?.activeCount() ?? 0;
    }
    function transfersStopText(count) {
        return count === 1 ? '1 transfer will stop.' : count + ' transfers will stop.';
    }

    // ---- A7: Leave room ----
    function leaveText(info) {
        if (info?.saved) return 'Leave room? It stays in Saved rooms.';
        if (info?.owner) return 'Leave room? It isn\'t saved, so you can\'t reopen it as owner.';
        return 'Leave room? It isn\'t saved. You\'ll need the invite to rejoin.';
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
        byId('leave-status').textContent = 'Leaving…';
        try {
            // The main process stops the node and then reloads the window. The ready check view (P9A) ends now.
            if (await api.leaveRoom()) {
                window.readyCheckUi?.reset();
                return;
            }
            byId('leave-status').textContent = 'Couldn\'t leave the room.';
        } catch (err) {
            byId('leave-status').textContent = 'Couldn\'t leave the room. ' + errorText(err);
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
        byId('quit-text').textContent = 'Quit? ' + transfersStopText(count);
        if (!dialog.open) dialog.showModal();
    }
    byId('quit-confirm')?.addEventListener('click', () => {
        byId('quit-dialog').close();
        api.quit();
    });

    window.appShell = Object.freeze({ openAbout, openShortcuts, openLeave, quit });
})();
