// Context menus of the room window rows: buddies (#peers), chat lines (#messages) and transfers (#transfers).
// Classic script. It loads after renderer.js. All names stay inside this function, because renderer.js, layout.js and
// reading.js are classic scripts in the same global scope.
//
// window.menuCore: pure functions with no DOM. test/app-events.test.mjs loads this file with node:vm and calls them.
// window.contextMenu: { isOpen(), close(returnFocus), open(row, opener) }. The Escape dispatcher of renderer.js
//   calls isOpen() and close(true). This menu does not handle Escape itself.
//
// renderer.js owns the state and the actions (window.roomActions). This file only shows the menu:
// - roomActions.rowInfo(row) gives the data of a row now, or null when the row has no menu.
// - menuCore.actionsFor(info) gives the action names. roomActions.run(action, row) runs one action.
// - Before an action runs, this file reads rowInfo again and checks menuCore.allowed. The action also checks the
//   state itself. Thus a menu that stayed open after a transfer completed cannot cancel or restart the transfer.
//
// Open: right-click on a row, the Menu key (ContextMenu) or Shift+F10 on a focused row.
// Keys in the menu: ArrowUp, ArrowDown, Home, End, Enter, Space, Tab. Escape: the dispatcher of renderer.js.
// No custom menu (native behavior stays): in an input, a textarea, a select, an editable element, and in #messages
// when the user selected text.
//
// The rows are focusable: one tab stop for each list (roving tabindex). ArrowUp, ArrowDown, Home and End move the
// focus between the rows of a list.
(function () {
    'use strict';

    const LABELS = Object.freeze({
        whisper: 'Whisper',
        'copy-name': 'Copy name',
        'inspect-peer': 'Peer details',
        'listening': 'Listening volume…',
        'show-on-map': 'Show on map',
        'copy-message': 'Copy message',
        'view-image': 'View image',
        quote: 'Quote',
        availability: 'Edit availability…',
        'message-details': 'Message details…',
        accept: 'Accept',
        refuse: 'Refuse',
        'cancel-receive': 'Cancel',
        retry: 'Retry',
        'cancel-receiver': 'Cancel for this user',
        'cancel-offer': 'Cancel for all users',
        reveal: 'Show in Explorer',
        resend: 'Send again'
    });

    // The action names for the data of a row (roomActions.rowInfo). An empty list: no menu.
    function actionsFor(info) {
        if (!info || typeof info !== 'object') return [];
        switch (info.kind) {
            case 'buddy': {
                const actions = info.onMap ? ['copy-name', 'show-on-map'] : ['copy-name'];
                if (info.self === false) actions.push('listening');
                if (info.inspect) actions.push('inspect-peer');
                if (info.whisper) actions.push('whisper');
                if (info.availability) actions.push('availability');
                return actions;
            }
            case 'message':
                // quotable: the window can take a quote now (renderer.js rowInfo).
                // localOnly: the line has "Only on this computer" (gap B3).
                return [...(info.quotable ? ['quote', 'copy-message'] : ['copy-message']), ...(info.image ? ['view-image'] : []), ...(info.inspect ? ['inspect-peer'] : []), ...(info.details ? ['message-details'] : []), ...(info.localOnly ? ['resend'] : [])];
            case 'offer':
                return info.active ? ['cancel-offer'] : [];
            case 'transfer':
                if (info.direction === 'receive') {
                    if (info.state === 'offered') return ['accept', 'refuse'];
                    if (info.state === 'receiving') return info.cancelRequested ? [] : ['cancel-receive'];
                    if (info.state === 'failed' && info.canRetry) return ['retry'];
                    if (info.state === 'done' && info.revealable) return ['reveal'];
                    return [];
                }
                if (info.direction === 'send' && (info.state === 'offered' || info.state === 'sending')) {
                    return info.cancelRequested ? [] : ['cancel-receiver'];
                }
                return [];
            default:
                return [];
        }
    }

    // True when the action is possible now for the data of the row.
    function allowed(action, info) {
        return actionsFor(info).includes(action);
    }

    function label(action) {
        return LABELS[action] ?? String(action);
    }

    // The next item index for a key in a menu of length items. -1: the key does not move the focus.
    function nextIndex(index, length, key) {
        if (length <= 0) return -1;
        switch (key) {
            case 'ArrowDown': return index < 0 ? 0 : (index + 1) % length;
            case 'ArrowUp': return index < 0 ? length - 1 : (index - 1 + length) % length;
            case 'Home': return 0;
            case 'End': return length - 1;
            default: return -1;
        }
    }

    // The menu position: in the viewport, with a margin. x, y: the wanted top left corner.
    function clampPosition(x, y, width, height, viewWidth, viewHeight, margin = 4) {
        const maxX = Math.max(margin, viewWidth - width - margin);
        const maxY = Math.max(margin, viewHeight - height - margin);
        const fx = Number.isFinite(x) ? x : margin;
        const fy = Number.isFinite(y) ? y : margin;
        return { x: Math.round(Math.min(Math.max(fx, margin), maxX)), y: Math.round(Math.min(Math.max(fy, margin), maxY)) };
    }

    // The keyboard keys that open a menu: the Menu key and Shift+F10.
    function isMenuKey(key, shiftKey) {
        return key === 'ContextMenu' || (key === 'F10' && shiftKey === true);
    }

    const menuCore = Object.freeze({ LABELS, actionsFor, allowed, label, nextIndex, clampPosition, isMenuKey });
    window.menuCore = menuCore;

    // ---- DOM part ----

    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;

    const lists = ['peers', 'messages', 'transfers'].map(id => document.getElementById(id)).filter(Boolean);
    const ROW_SELECTOR = '#peers > li, #messages > li, #transfers > li';
    const messageList = document.getElementById('messages');
    const docEl = document.documentElement;

    const menu = document.createElement('ul');
    menu.id = 'row-menu';
    menu.className = 'row-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Row actions');
    menu.hidden = true;
    document.body.append(menu);

    let current = null; // { row, opener, observer }

    function isOpen() {
        return current !== null;
    }

    function actions() {
        return window.roomActions ?? null;
    }

    function items() {
        return Array.from(menu.querySelectorAll('[role="menuitem"]'));
    }

    function focusItem(index) {
        const list = items();
        if (index >= 0 && index < list.length) list[index].focus({ preventScroll: true });
    }

    function close(returnFocus) {
        if (!current) return;
        const { opener, row, observer } = current;
        current = null;
        observer.disconnect();
        menu.hidden = true;
        menu.replaceChildren();
        if (!returnFocus) return;
        const target = opener && opener.isConnected ? opener : row && row.isConnected ? row : null;
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }

    // at: { x, y } of the pointer, or null for a keyboard open (the menu goes below the row).
    function open(row, opener, at = null) {
        const api = actions();
        if (!api || !row) return false;
        const list = actionsFor(api.rowInfo(row));
        if (list.length === 0) return false;
        close(false);
        for (const action of list) {
            const item = document.createElement('li');
            item.setAttribute('role', 'menuitem');
            item.tabIndex = -1;
            item.dataset.action = action;
            item.textContent = label(action);
            menu.append(item);
        }
        // Close the menu when its row goes away or the row changes its state.
        const observer = new MutationObserver(checkRow);
        for (const listEl of lists) observer.observe(listEl, { childList: true });
        observer.observe(row, { attributes: true, attributeFilter: ['data-state', 'class'] });
        current = { row, opener: opener || row, observer, info: JSON.stringify(api.rowInfo(row)) };
        menu.hidden = false;
        place(row, at);
        focusItem(0);
        return true;
    }

    function place(row, at) {
        let x;
        let y;
        if (at) {
            x = at.x;
            y = at.y;
        } else {
            const box = row.getBoundingClientRect();
            x = box.left + 12;
            y = box.bottom - 2;
        }
        const size = menu.getBoundingClientRect();
        const pos = clampPosition(x, y, size.width, size.height, docEl.clientWidth, docEl.clientHeight);
        docEl.style.setProperty('--row-menu-x', `${pos.x}px`);
        docEl.style.setProperty('--row-menu-y', `${pos.y}px`);
    }

    // A row that went away, a buddy that left, or a new state of the row: the menu closes. The focus goes back to
    // the opener (or the row) only when the focus was in the menu.
    function checkRow() {
        if (!current) return;
        const api = actions();
        const info = api ? api.rowInfo(current.row) : null;
        if (info !== null && current.row.isConnected && !current.row.classList.contains('leaving')
            && JSON.stringify(info) === current.info) return;
        close(menu.contains(document.activeElement));
    }

    function activate(item) {
        if (!current || !item) return;
        const action = item.dataset.action;
        const row = current.row;
        close(true);
        const api = actions();
        if (!api) return;
        if (!allowed(action, api.rowInfo(row))) {
            api.notice('This action is not available now.');
            return;
        }
        Promise.resolve(api.run(action, row))
            .catch(err => console.warn('Row action failed:', err?.message ?? err))
            .finally(() => {
                // The action can remove the opener (a row button). Then the focus goes to the row.
                if ((!document.activeElement || document.activeElement === document.body) && row.isConnected) {
                    row.focus({ preventScroll: true });
                }
            });
    }

    menu.addEventListener('keydown', event => {
        const list = items();
        const index = list.indexOf(document.activeElement);
        const next = nextIndex(index, list.length, event.key);
        if (next >= 0) {
            event.preventDefault();
            focusItem(next);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate(list[index]);
        } else if (event.key === 'Tab') {
            event.preventDefault();
            close(true);
        }
    });

    menu.addEventListener('click', event => {
        const item = event.target.closest('[role="menuitem"]');
        if (item && menu.contains(item)) activate(item);
    });

    menu.addEventListener('pointermove', event => {
        const item = event.target.closest('[role="menuitem"]');
        if (item && document.activeElement !== item) item.focus({ preventScroll: true });
    });

    // A press in the menu must not close the Buddies drawer or the View menu (layout.js closes them on a press
    // outside, in the capture phase on document). A press outside closes this menu.
    window.addEventListener('pointerdown', event => {
        if (!current) return;
        if (menu.contains(event.target)) {
            event.stopPropagation();
            return;
        }
        close(false);
    }, true);

    window.addEventListener('blur', () => close(false));
    window.addEventListener('resize', () => close(false));
    // A scroll moves the row away from the menu. Only a scroll of the list (or the page) of the row closes the menu:
    // a new chat line must not close the menu of a buddy.
    document.addEventListener('scroll', event => {
        if (!current || menu.contains(event.target)) return;
        const scrolled = event.target === document ? document.documentElement : event.target;
        if (scrolled && scrolled.nodeType === 1 && scrolled.contains(current.row)) close(menu.contains(document.activeElement));
    }, true);

    // ---- Where the native behavior stays ----

    function isEditable(element) {
        if (!element || element.nodeType !== 1) return false;
        return Boolean(element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
    }

    // True when the user selected text in the chat list.
    function hasChatSelection() {
        const selection = document.getSelection();
        if (!selection || selection.isCollapsed || selection.toString() === '' || !messageList) return false;
        for (let i = 0; i < selection.rangeCount; i++) {
            if (selection.getRangeAt(i).intersectsNode(messageList)) return true;
        }
        return false;
    }

    function rowOf(element) {
        if (!element || element.nodeType !== 1) return null;
        const row = element.closest(ROW_SELECTOR);
        return row && !row.classList.contains('leaving') ? row : null;
    }

    function nativeStays(target) {
        if (isEditable(target)) return true;
        return Boolean(messageList && messageList.contains(target) && hasChatSelection());
    }

    // ---- Open by pointer and by keyboard ----

    document.addEventListener('contextmenu', event => {
        const target = event.target;
        // The Menu key and Shift+F10 also give a contextmenu event (the Menu key on Windows at key up). The keydown
        // already opened the menu, and the focus is in the menu now.
        if (menu.contains(target)) {
            event.preventDefault();
            return;
        }
        if (nativeStays(target)) return;
        const row = rowOf(target);
        if (!row) return;
        // A keyboard contextmenu event on a focused row: keydown handles it.
        if (current && current.row === row && event.button !== 2) {
            event.preventDefault();
            return;
        }
        const opener = row.contains(document.activeElement) ? document.activeElement : row;
        if (open(row, opener, event.button === 2 ? { x: event.clientX, y: event.clientY } : null)) {
            event.preventDefault();
        }
    });

    document.addEventListener('keydown', event => {
        if (!isMenuKey(event.key, event.shiftKey)) return;
        if (menu.contains(event.target)) {
            event.preventDefault();
            return;
        }
        const active = document.activeElement;
        if (nativeStays(active)) return;
        const row = rowOf(active);
        if (!row) return;
        if (open(row, active, null)) event.preventDefault();
    });

    // ---- Focusable rows: one tab stop for each list ----

    const tabStops = new WeakMap(); // list -> the row with tabindex 0

    // A note row of the chat (transcript-notes.js) and a grey buddy line (connection lost) are no stops.
    function rowsOf(listEl) {
        return Array.from(listEl.children).filter(row => row.tagName === 'LI' && !row.hidden && !row.classList.contains('leaving')
            && !row.classList.contains('note') && !row.classList.contains('lost'));
    }

    function setTabStop(listEl, row) {
        const old = tabStops.get(listEl);
        if (old && old !== row) old.tabIndex = -1;
        if (row) row.tabIndex = 0;
        tabStops.set(listEl, row);
    }

    function refreshTabStops(listEl) {
        const rows = rowsOf(listEl);
        for (const row of rows) if (!row.hasAttribute('tabindex')) row.tabIndex = -1;
        // The chat list: while the focus is not in the list, the tab stop is the newest line. Without this rule the
        // tab stop stayed on the first line that the list got: Tab moved a long chat to its oldest line.
        if (listEl === messageList && !listEl.contains(document.activeElement)) {
            setTabStop(listEl, rows[rows.length - 1] ?? null);
            return;
        }
        const stop = tabStops.get(listEl);
        if (stop && stop.parentElement === listEl && rows.includes(stop)) return;
        // No current tab stop: the newest chat line, or the first row of the other lists.
        const fallback = listEl === messageList ? rows[rows.length - 1] : rows[0];
        setTabStop(listEl, fallback ?? null);
    }

    for (const listEl of lists) {
        new MutationObserver(() => refreshTabStops(listEl)).observe(listEl, { childList: true });
        refreshTabStops(listEl);
        listEl.addEventListener('focusin', event => {
            const row = event.target.closest('li');
            // The chat list: only the focus of a line itself moves the tab stop. A button in an older line (a file
            // card) does not take the tab stop from the newest line: Tab goes through the buttons, then to that line.
            if (listEl === messageList && event.target !== row) return;
            if (row && row.parentElement === listEl) setTabStop(listEl, row);
        });
        listEl.addEventListener('keydown', event => {
            const row = event.target;
            if (!row || row.parentElement !== listEl || event.altKey || event.ctrlKey || event.metaKey) return;
            const rows = rowsOf(listEl);
            const next = nextIndex(rows.indexOf(row), rows.length, event.key);
            if (next < 0 || (event.key === 'ArrowDown' && next === 0) || (event.key === 'ArrowUp' && next === rows.length - 1)) {
                // No wrap in a list: stop at the first and the last row.
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.preventDefault();
                return;
            }
            event.preventDefault();
            rows[next].focus();
        });
    }

    window.contextMenu = Object.freeze({ isOpen, close, open: (row, opener) => open(row, opener, null) });
})();
