// The room keeps its DOM and layout when the palette changes. The setting belongs to this Electron profile.
(() => {
    const themes = {
        'aero-classic': 'Aero Classic', 'aero-night': 'Aero Night', 'aero-black': 'Aero Black',
        'aero-midnight': 'Aero Midnight', pearl: 'Pearl', 'amber-terminal': 'Amber Terminal'
    };
    const key = 'asscrack.theme.v1';
    const root = document.documentElement;
    const dialog = document.getElementById('theme-gallery');
    const grid = dialog.querySelector('.theme-grid');
    const template = document.getElementById('theme-choice');
    const view = document.getElementById('view-toggle');
    const buttons = new Map();
    let returnFocus = view;

    function apply(id) {
        root.dataset.theme = id;
        for (const [choice, button] of buttons) button.setAttribute('aria-pressed', String(choice === id));
        window.dispatchEvent(new Event('asscrack-theme-changed'));
    }

    for (const [id, name] of Object.entries(themes)) {
        const button = template.content.firstElementChild.cloneNode(true);
        button.querySelector('.theme-preview').dataset.theme = id;
        button.querySelector('.theme-name').textContent = name;
        button.addEventListener('click', () => {
            window.reading.keepPosition(() => apply(id));
            try { localStorage.setItem(key, id); } catch { /* A read-only profile keeps the session choice. */ }
            dialog.close();
        });
        buttons.set(id, button);
        grid.appendChild(button);
    }

    let saved;
    try { saved = localStorage.getItem(key); } catch { /* Default for an unavailable profile store. */ }
    apply(buttons.has(saved) ? saved : 'aero-classic');

    dialog.addEventListener('keydown', event => {
        const choices = [...buttons.values()];
        const current = choices.indexOf(document.activeElement);
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dialog.close();
        }
        if (current < 0) return;
        const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
        if (!Object.hasOwn(moves, event.key)) return;
        event.preventDefault();
        choices[(current + moves[event.key] + choices.length) % choices.length].focus();
    });
    dialog.addEventListener('close', () => {
        (returnFocus?.isConnected ? returnFocus : view).focus({ preventScroll: true });
        returnFocus = view;
    });
    window.roomThemes = Object.freeze({
        open(origin) {
            returnFocus = origin && origin !== document.body ? origin : view;
            dialog.showModal();
            buttons.get(root.dataset.theme).focus();
        }
    });
})();
