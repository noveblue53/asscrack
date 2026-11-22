(() => {
    const api = window.desktopFrame;
    const root = document.documentElement;
    const buttons = document.getElementById('window-controls');
    const max = document.getElementById('window-maximize');
    const choice = document.getElementById('view-system-buttons');
    let current;
    let saving = false;

    function themeOverlay() {
        if (current?.mode !== 'overlay') return;
        const paint = getComputedStyle(root);
        api.setColors(paint.getPropertyValue('--frame-mid').trim(), paint.getPropertyValue('--frame-ink').trim());
    }
    function show(state) {
        current = state;
        root.dataset.frame = state.mode;
        buttons.hidden = state.mode !== 'glass';
        const name = state.maximized ? 'Restore window' : 'Maximize window';
        max.dataset.maximized = String(state.maximized);
        max.setAttribute('aria-label', name);
        max.title = name;
        choice.hidden = !state.canChooseSystemButtons;
        choice.setAttribute('aria-checked', String(state.systemButtons));
    }
    document.getElementById('window-minimize').addEventListener('click', () => api.minimize());
    max.addEventListener('click', () => api.toggleMaximize());
    document.getElementById('window-close').addEventListener('click', () => api.close());
    window.frameControls = {
        async toggleSystemButtons() {
            if (saving || !current?.canChooseSystemButtons) return;
            saving = true;
            try { show(await api.useSystemButtons(!current.systemButtons)); }
            catch { document.getElementById('status').textContent = 'Couldn\'t save this setting.'; }
            finally { saving = false; }
        }
    };
    api.onChanged(show);
    api.state().then(state => { show(state); themeOverlay(); });
    window.addEventListener('asscrack-theme-changed', themeOverlay);
})();
