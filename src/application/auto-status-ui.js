// 1.0.4: the settings of the automatic status in the dialog "Your availability" (auto-status.mjs in the main process
// does the rule). "Away after" 5, 10 or 15 minutes, or Off; "Do not disturb in full-screen games", off by default.
// The dialog shows the settings after login, the same as the status menu.
(function () {
    'use strict';
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const box = byId('auto-status');
    const away = byId('auto-away');
    const dnd = byId('auto-dnd');
    const error = byId('auto-status-error');
    if (!box || !away || !dnd || !api?.getAutoStatus || !api?.setAutoStatus) return;

    function show(settings) {
        if (!settings || typeof settings !== 'object') return;
        if ([5, 10, 15, 0].includes(settings.awayMinutes)) away.value = String(settings.awayMinutes);
        dnd.checked = settings.dndFullscreen === true;
    }
    function showError(text) {
        if (!error) return;
        error.textContent = text;
        error.hidden = !text;
    }
    async function load() {
        try {
            show(await api.getAutoStatus());
            box.hidden = false;
        } catch { box.hidden = true; }
    }
    async function save(patch) {
        showError('');
        try {
            show(await api.setAutoStatus(patch));
        } catch {
            showError('Not saved. Try again.');
            load();
        }
    }
    away.addEventListener('change', () => save({ awayMinutes: Number(away.value) }));
    dnd.addEventListener('change', () => save({ dndFullscreen: dnd.checked }));
    byId('availability-dialog')?.addEventListener('focusin', () => { if (box.hidden) load(); });
    load();
})();
