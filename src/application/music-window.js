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

    const byId = id => document.getElementById(id);
    const titlebar = byId('music-titlebar');
    const pinButton = byId('music-pin');
    const shadeButton = byId('music-shade');
    const minButton = byId('music-win-min');
    const closeButton = byId('music-win-close');
    const titleEl = byId('music-title');
    const marqueeEl = titleEl?.parentElement ?? null;
    let windowState = { shaded: false, pinned: false };

    function updateMarquee() {
        if (!titleEl || !marqueeEl) return;
        const shaded = document.documentElement.dataset.shaded === 'true';
        const overflow = shaded ? titleEl.scrollWidth - marqueeEl.clientWidth : 0;
        if (shaded && overflow > 2) {
            const distance = overflow + 12;
            const duration = Math.max(4, Math.min(20, distance / 28)).toFixed(2);
            titleEl.style?.setProperty('--marquee-distance', `-${distance}px`);
            titleEl.style?.setProperty('--marquee-duration', `${duration}s`);
            titleEl.classList?.add('scrolling');
        } else {
            titleEl.classList?.remove('scrolling');
            titleEl.style?.removeProperty('--marquee-distance');
            titleEl.style?.removeProperty('--marquee-duration');
        }
    }

    function applyWindowState(next) {
        if (!next || typeof next !== 'object') return;
        const shaded = next.shaded === true;
        const pinned = next.pinned === true;
        windowState = { shaded, pinned };
        document.documentElement.dataset.shaded = String(shaded);
        document.documentElement.dataset.pinned = String(pinned);
        if (shadeButton) {
            shadeButton.setAttribute('aria-pressed', String(shaded));
            shadeButton.textContent = shaded ? '▾' : '▴';
            const label = shaded ? 'Expand' : 'Shade mode';
            shadeButton.setAttribute('aria-label', label);
            shadeButton.title = label;
        }
        if (pinButton) {
            pinButton.setAttribute('aria-pressed', String(pinned));
            const label = pinned ? 'Unpin' : 'Always on top';
            pinButton.setAttribute('aria-label', label);
            pinButton.title = label;
        }
        updateMarquee();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(updateMarquee);
        try { window.dispatchEvent(new Event('resize')); } catch { /* ignore in minimal test dom */ }
    }

    pinButton?.addEventListener('click', () => {
        void api.setMusicWindowState?.({ pinned: !windowState.pinned })?.then(applyWindowState)?.catch(() => {});
    });
    shadeButton?.addEventListener('click', () => {
        void api.setMusicWindowState?.({ shaded: !windowState.shaded })?.then(applyWindowState)?.catch(() => {});
    });
    titlebar?.addEventListener('dblclick', event => {
        if (event.target?.closest?.('button')) return;
        void api.setMusicWindowState?.({ shaded: !windowState.shaded })?.then(applyWindowState)?.catch(() => {});
    });
    minButton?.addEventListener('click', () => { void api.musicWindowAction?.('minimize')?.catch(() => {}); });
    closeButton?.addEventListener('click', () => { void api.musicWindowAction?.('close')?.catch(() => {}); });

    api.onMusicWindowState?.(applyWindowState);
    Promise.resolve(api.getMusicWindowState?.()).then(applyWindowState).catch(() => {});

    if (titleEl && typeof MutationObserver === 'function') {
        new MutationObserver(updateMarquee).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
    window.addEventListener('resize', updateMarquee);
})();
