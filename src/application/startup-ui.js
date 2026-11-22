// P9B: the dialog "Start at sign-in" (View menu). Only the installed build shows the menu line: the portable build
// gets { available: false } from the main process. The window gets the room IDs and names only, never a path.
// API for layout.js: window.startupUi = { open() }.
(function () {
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const menuLine = byId('view-startup');
    const dialog = byId('startup-dialog');
    const on = byId('startup-on');
    const choice = byId('startup-choice');
    const entry = byId('startup-entry');
    const status = byId('startup-status');
    if (!api?.getStartup || !menuLine || !dialog || !on || !choice) return;
    const errorText = err => String(err?.message ?? err ?? '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    const FRIENDS = 'friends';
    let busy = false;

    function entryText(view) {
        if (view.mode === 'off') return '';
        if (!view.entry?.present) return 'Windows has no start entry for ASSCRACK. Turn the setting off and on again.';
        if (!view.entry.enabled) {
            return 'The start is off in Windows (Task Manager, Startup apps). Turn ASSCRACK on there to start at sign-in.';
        }
        return 'Windows starts ASSCRACK when you sign in.';
    }

    function show(view) {
        menuLine.hidden = view?.available !== true;
        if (view?.available !== true) return;
        const options = [new Option('Friends only (no room)', FRIENDS)];
        for (const room of view.rooms ?? []) options.push(new Option(String(room.name ?? ''), 'room:' + String(room.roomId)));
        choice.replaceChildren(...options);
        if (view.mode === 'room') choice.value = 'room:' + view.roomId;
        else choice.value = FRIENDS;
        on.checked = view.mode !== 'off';
        choice.disabled = !on.checked;
        entry.textContent = entryText(view);
        if (view.archive !== 'open') status.textContent = 'The saved rooms are locked. Only "Friends only" is available now.';
    }

    function selected() {
        if (!on.checked) return { mode: 'off' };
        const value = choice.value;
        if (value.startsWith('room:')) return { mode: 'room', roomId: value.slice(5) };
        return { mode: 'friends' };
    }

    async function save() {
        if (busy) return;
        busy = true;
        status.textContent = '';
        try {
            show(await api.setStartup(selected()));
        } catch (err) {
            status.textContent = 'The start at sign-in was not saved: ' + errorText(err);
            try { show(await api.getStartup()); } catch { /* the dialog keeps its state */ }
        } finally {
            busy = false;
        }
    }
    on.addEventListener('change', () => { choice.disabled = !on.checked; void save(); });
    choice.addEventListener('change', () => void save());

    async function open() {
        if (dialog.open) return;
        status.textContent = '';
        try {
            show(await api.getStartup());
        } catch {
            status.textContent = 'The start at sign-in setting could not be read.';
        }
        if (!dialog.open) dialog.showModal();
    }

    window.startupUi = Object.freeze({ open });
    api.getStartup().then(show).catch(() => { menuLine.hidden = true; });
})();
