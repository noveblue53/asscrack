// Room music: the pop-out window (music-window.html). The theme of the View menu (the same method as
// friends-window.js), and window.music for music-ui.js: this window has no audio, only the settings.
(function () {
    'use strict';
    const key = 'asscrack.theme.v1';
    try {
        const theme = localStorage.getItem(key);
        if (theme) document.documentElement.dataset.theme = theme;
    } catch { /* no saved theme */ }
    window.addEventListener('storage', event => {
        if (event.key === key && event.newValue) document.documentElement.dataset.theme = event.newValue;
    });

    const api = window.asscrack;
    if (!api) return;
    let settings = { volume: 60, ducking: true, visualizer: 'spectrum' };
    const listeners = [];
    const changed = () => { for (const fn of listeners) { try { fn(); } catch (err) { console.warn('music onChange failed:', err); } } };
    const take = value => { if (value && typeof value === 'object') { settings = value; changed(); } };
    api.onMusicSettings?.(take);
    Promise.resolve(api.getMusicSettings?.()).then(take).catch(() => {});
    window.music = {
        settings: () => ({ ...settings }),
        async setSettings(patch) {
            take(await api.setMusicSettings(patch));
            return settings;
        },
        onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
    };
})();
