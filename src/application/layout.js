// The room window layout: the separators, the View menu, the Buddies drawer and the saved layout preference.
// Classic script. It loads before renderer.js. renderer.js stays the owner of the map (body.map-open, #map-toggle).
//
// window.layoutCore: pure functions (no DOM). test/layout.test.mjs tests them.
// window.layout: { closeTopLayer(), isDrawerOpen(), reset() } for the Escape dispatcher of a later package.
//
// The preference keeps the REQUESTED sizes in CSS px. null means "use the responsive default". The EFFECTIVE sizes
// are the requested sizes clamped to the current viewport. Only a user action writes the preference: a load, a window
// resize or a narrow start never writes it.
(function () {
    'use strict';

    const KEY = 'asscrack.layout.v1';
    const VERSION = 1;
    const PAD = 6;
    // Absolute limits of a requested size, in CSS px.
    const LIMITS = Object.freeze({
        buddyWidth: Object.freeze({ min: 120, max: 480 }),
        mapWidth: Object.freeze({ min: 260, max: 900 }),
        transferHeight: Object.freeze({ min: 32, max: 800 }),
    });
    const CHAT_MIN_W = 300;   // The chat column keeps this width. Below it, Buddies becomes a drawer.
    const CHAT_MIN_H = 120;   // The chat body keeps this height. Transfers gets the rest.
    const DOCK_MIN_W = 1000;  // The map has its own column from this window width (the old breakpoint).
    // The height of the title band, tool band, composer, status band, the transfer head and columns, and the margins.
    // layout.js measures it in the app. This value is for a hidden chat screen and for the tests.
    const DEFAULT_CHROME_H = 220;
    const STEP = 10;
    const BIG_STEP = 50;
    const SIDES = ['left', 'right'];

    function defaultPref() {
        return {
            version: VERSION,
            buddyWidth: null,
            buddySide: 'left',
            buddiesShown: true,
            mapWidth: null,
            transferHeight: null,
            transfersPinned: false,
            compactTranscript: false,
        };
    }

    function clampNumber(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    // A size field: a finite number, clamped to the absolute limits and rounded. Any other value gives null.
    function validSize(field, value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        const limit = LIMITS[field];
        return Math.round(clampNumber(value, limit.min, limit.max));
    }

    // Recover field by field. A value that is not an object, or another version, gives the defaults.
    function validatePref(raw) {
        const pref = defaultPref();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return pref;
        if (raw.version !== VERSION) return pref;
        pref.buddyWidth = validSize('buddyWidth', raw.buddyWidth);
        pref.mapWidth = validSize('mapWidth', raw.mapWidth);
        pref.transferHeight = validSize('transferHeight', raw.transferHeight);
        if (SIDES.includes(raw.buddySide)) pref.buddySide = raw.buddySide;
        if (typeof raw.buddiesShown === 'boolean') pref.buddiesShown = raw.buddiesShown;
        if (typeof raw.compactTranscript === 'boolean') pref.compactTranscript = raw.compactTranscript;
        if (typeof raw.transfersPinned === 'boolean') pref.transfersPinned = raw.transfersPinned;
        return pref;
    }

    function parsePref(text) {
        if (typeof text !== 'string' || text === '') return defaultPref();
        let raw;
        try {
            raw = JSON.parse(text);
        } catch {
            return defaultPref();
        }
        return validatePref(raw);
    }

    function serializePref(pref) {
        const p = validatePref(pref);
        return JSON.stringify(p);
    }

    // host is the object with localStorage (window). The getter of localStorage can throw: it is in the try.
    // No console output: unavailable storage is a normal case.
    function readPref(host) {
        try {
            const storage = host.localStorage;
            if (!storage) return defaultPref();
            return parsePref(storage.getItem(KEY));
        } catch {
            return defaultPref();
        }
    }

    function writePref(host, pref) {
        try {
            const storage = host.localStorage;
            if (!storage) return false;
            storage.setItem(KEY, serializePref(pref));
            return true;
        } catch {
            return false;
        }
    }

    // Give conversation more space without changing any saved splitter widths.
    function responsiveDefaults(width, height) {
        const bodyW = Math.max(0, width - 2 * PAD);
        let buddyWidth = 192;
        if (width <= 600) buddyWidth = 148;
        else if (width >= DOCK_MIN_W) buddyWidth = Math.round(clampNumber(0.22 * bodyW, 192, 370));
        let transferHeight = 90;
        if (height >= 900) transferHeight = 210;
        else if (height >= 700) transferHeight = 150;
        return {
            buddyWidth,
            mapWidth: Math.round(clampNumber(0.29 * bodyW, 300, 520)),
            transferHeight,
        };
    }

    function finiteOr(value, fallback) {
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    // The effective layout for one viewport. pref is not changed.
    // viewport: { width, height, chromeH?, mapOpen? } in CSS px.
    // Priorities: the composer is never pushed out (CSS guard and transfer cap); the chat column keeps CHAT_MIN_W;
    // the docked map shrinks before Buddies; Buddies becomes a drawer when even its minimum does not fit.
    function effectiveLayout(pref, viewport) {
        const p = pref || defaultPref();
        const width = Math.max(0, finiteOr(viewport && viewport.width, 0));
        const height = Math.max(0, finiteOr(viewport && viewport.height, 0));
        const chromeH = Math.max(0, finiteOr(viewport && viewport.chromeH, DEFAULT_CHROME_H));
        const mapOpen = Boolean(viewport && viewport.mapOpen);
        const defaults = responsiveDefaults(width, height);
        const bodyW = Math.max(0, width - 2 * PAD);

        // The map can dock when the chat minimum, the Buddies minimum and the map minimum fit.
        const buddyMin = LIMITS.buddyWidth.min;
        const mapMin = LIMITS.mapWidth.min;
        const buddyReserve = p.buddiesShown ? buddyMin + PAD : 0;
        const mapDockable = width >= DOCK_MIN_W && bodyW - CHAT_MIN_W - PAD - buddyReserve >= mapMin;
        const mapDocked = mapOpen && mapDockable;

        // Buddies. With a docked map, Buddies keeps room for the map minimum only: the map shrinks first.
        const room = bodyW - (mapDocked ? mapMin + PAD : 0);
        const dockedMax = Math.min(LIMITS.buddyWidth.max, room - PAD - CHAT_MIN_W);
        let buddyMode = 'docked';
        if (!p.buddiesShown) buddyMode = 'hidden';
        else if (dockedMax < buddyMin) buddyMode = 'drawer';
        const buddyMax = buddyMode === 'docked'
            ? dockedMax
            : clampNumber(bodyW - 48, buddyMin, LIMITS.buddyWidth.max);
        const buddyWidth = Math.round(clampNumber(p.buddyWidth ?? defaults.buddyWidth, buddyMin, buddyMax));

        // The docked map gets the rest after the chat minimum and the Buddies column.
        const buddyColumn = buddyMode === 'docked' ? buddyWidth + PAD : 0;
        const mapMax = mapDockable
            ? Math.max(mapMin, Math.min(LIMITS.mapWidth.max, bodyW - CHAT_MIN_W - PAD - buddyColumn))
            : mapMin;
        const mapWidth = Math.round(clampNumber(p.mapWidth ?? defaults.mapWidth, mapMin, mapMax));

        // Transfers: the list height. The chat body keeps CHAT_MIN_H and the composer stays in the window.
        const transferReserve = Math.round(chromeH + CHAT_MIN_H);
        const transferMax = Math.max(0, Math.min(LIMITS.transferHeight.max, Math.floor(height - transferReserve)));
        const transferMin = Math.min(LIMITS.transferHeight.min, transferMax);
        const transferHeight = Math.round(
            clampNumber(p.transferHeight ?? defaults.transferHeight, transferMin, transferMax));

        return {
            buddyMode,
            buddySide: p.buddySide,
            buddyWidth,
            buddyMin,
            buddyMax: Math.round(Math.max(buddyMin, buddyMax)),
            mapDockable,
            mapDocked,
            mapWidth,
            mapMin,
            mapMax: Math.round(mapMax),
            transferSet: p.transferHeight !== null,
            transferHeight,
            transferMin,
            transferMax,
            transferReserve,
        };
    }

    // A new preference with one requested size. The value is clamped to [min, max] (the effective limits of the
    // current viewport) and to the absolute limits. pref is not changed.
    function withSize(pref, field, value, min, max) {
        const next = Object.assign({}, pref);
        let v = finiteOr(value, NaN);
        if (Number.isNaN(v)) return next;
        if (typeof min === 'number' && typeof max === 'number') v = clampNumber(v, min, Math.max(min, max));
        next[field] = validSize(field, v);
        return next;
    }

    // The size change for a key on a separator. grow is +1 when the key makes the panel larger.
    function keyDelta(key, shiftKey, growKeys, shrinkKeys) {
        const step = shiftKey ? BIG_STEP : STEP;
        if (growKeys.includes(key)) return step;
        if (shrinkKeys.includes(key)) return -step;
        return 0;
    }

    const layoutCore = Object.freeze({
        KEY, VERSION, PAD, LIMITS, CHAT_MIN_W, CHAT_MIN_H, DOCK_MIN_W, DEFAULT_CHROME_H, STEP, BIG_STEP,
        defaultPref, validatePref, parsePref, serializePref, readPref, writePref,
        responsiveDefaults, effectiveLayout, withSize, keyDelta,
    });
    window.layoutCore = layoutCore;

    // ---- The window part. It stops here when the page has no room window (the tests). ----

    const doc = window.document;
    const byId = id => (doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null);
    const chatBody = byId('chat-body');
    if (!chatBody) {
        window.layout = Object.freeze({ closeTopLayer: () => false, isDrawerOpen: () => false, reset() {} });
        return;
    }

    const root = doc.documentElement;
    const body = doc.body;
    const buddyPanel = byId('buddy-panel');
    const transferPanel = byId('transfer-panel');
    const frameTransfers = byId('frame-transfers');
    const transferList = byId('transfers');
    const mapToggle = byId('map-toggle');
    const viewToggle = byId('view-toggle');
    const viewMenu = byId('view-menu');
    const items = {
        buddies: byId('view-buddies'),
        drawer: byId('view-buddy-drawer'),
        transfers: byId('view-transfers'),
        map: byId('view-map'),
        side: byId('view-side'),
        reset: byId('view-reset'),
    };
    const separators = {
        buddyWidth: byId('buddy-sep'),
        mapWidth: byId('map-sep'),
        transferHeight: byId('transfer-sep'),
    };

    let pref = readPref(window);
    let transfersOpen = pref.transfersPinned;
    let eff = null;
    let drag = null;
    let drawerOpener = null;
    let lastMapOpen = body.classList.contains('map-open');
    let frame = 0;

    function mapIsOpen() {
        return body.classList.contains('map-open');
    }

    function boxHeight(id) {
        const el = byId(id);
        if (!el) return 0;
        return el.getBoundingClientRect().height;
    }

    // The fixed vertical space: the four bands, the composer margin, the chat-body and transfer margins,
    // the transfer head (26), the columns (20) and the two panel borders.
    function measureChrome() {
        const bands = boxHeight('titlebar') + boxHeight('room-heading') + boxHeight('composer') + boxHeight('statusbar');
        if (bands <= 0) return DEFAULT_CHROME_H;
        return bands + 3 * PAD + 26 + 20 + 2;
    }

    function viewport() {
        return {
            width: root.clientWidth || window.innerWidth || 0,
            height: root.clientHeight || window.innerHeight || 0,
            chromeH: measureChrome(),
            mapOpen: mapIsOpen(),
        };
    }

    function setVar(name, px) {
        root.style.setProperty(name, `${px}px`);
    }

    function setSeparator(sep, now, min, max, label) {
        if (!sep) return;
        sep.setAttribute('aria-valuemin', String(min));
        sep.setAttribute('aria-valuemax', String(max));
        sep.setAttribute('aria-valuenow', String(now));
        sep.setAttribute('aria-valuetext', `${label} ${now} pixels`);
    }

    function updateMenu() {
        if (!viewMenu) return;
        byId('view-compact')?.setAttribute('aria-checked', String(pref.compactTranscript));
        if (items.buddies) items.buddies.setAttribute('aria-checked', String(pref.buddiesShown));
        if (items.transfers) items.transfers.setAttribute('aria-checked', String(pref.transfersPinned));
        if (items.map) items.map.setAttribute('aria-checked', String(mapIsOpen()));
        if (window.musicUi?.hidden) byId('view-music')?.setAttribute('aria-checked', String(!window.musicUi.hidden()));
        // Gap E5: on the login screen only the lines with no data-room-only attribute show. menuItems() skips the
        // lines with the hidden attribute, thus the keys skip them too.
        const inRoom = body.classList.contains('chat');
        for (const line of viewMenu.querySelectorAll('[data-room-only]')) line.hidden = !inRoom;
        if (items.drawer) items.drawer.hidden = !inRoom || !(eff && eff.buddyMode === 'drawer');
        if (items.side) {
            items.side.textContent = pref.buddySide === 'left' ? 'Move Buddies to the right' : 'Move Buddies to the left';
        }
    }

    // Apply the effective layout: CSS variables, body classes, separator values. No storage write here.
    function render() {
        eff = effectiveLayout(pref, viewport());
        setVar('--buddy-w', eff.buddyWidth);
        setVar('--map-w', eff.mapWidth);
        setVar('--transfer-h', eff.transferHeight);
        setVar('--transfer-reserve', eff.transferReserve);
        // A narrow map or Buddies drawer covers the transcript above the composer. Its height varies with drafts.
        setVar('--composer-height', boxHeight('composer'));
        const cls = body.classList;
        cls.toggle('layout-buddy-right', eff.buddySide === 'right');
        cls.toggle('compact-transcript', pref.compactTranscript);
        cls.toggle('layout-buddy-hidden', eff.buddyMode === 'hidden');
        cls.toggle('layout-buddy-drawer', eff.buddyMode === 'drawer');
        cls.toggle('layout-buddy-off', eff.buddyMode !== 'docked');
        cls.toggle('layout-map-docked', eff.mapDocked);
        transferPanel.hidden = !transfersOpen;
        frameTransfers.setAttribute('aria-expanded', String(transfersOpen));
        cls.toggle('layout-transfer-set', eff.transferSet);
        setSeparator(separators.buddyWidth, eff.buddyWidth, eff.buddyMin, eff.buddyMax, 'Buddies width');
        setSeparator(separators.mapWidth, eff.mapWidth, eff.mapMin, eff.mapMax, 'Map width');
        updateTransferSeparator();
        if (eff.buddyMode !== 'drawer' && isDrawerOpen()) {
            closeDrawer(buddyPanel && buddyPanel.contains(doc.activeElement));
        }
        updateMenu();
    }

    // Recompute once in the next frame. The timer is a fallback for a window that draws no frames (hidden).
    function schedule() {
        if (frame) return;
        const run = () => {
            if (!frame) return;
            frame = 0;
            render();
        };
        frame = 1;
        window.requestAnimationFrame(run);
        window.setTimeout(run, 100);
    }

    function save() {
        writePref(window, pref);
    }

    // ---- Sizing: drag, keys and Reset use these functions ----

    function limitsOf(field) {
        if (field === 'buddyWidth') return [eff.buddyMin, eff.buddyMax];
        if (field === 'mapWidth') return [eff.mapMin, eff.mapMax];
        return [eff.transferMin, eff.transferMax];
    }

    // The Transfers separator shows the visible list height, the same value that a drag or a key starts from.
    function updateTransferSeparator() {
        if (!eff) return;
        const now = currentSize('transferHeight');
        setSeparator(separators.transferHeight, now, Math.min(eff.transferMin, now), eff.transferMax,
            'Transfers height');
    }

    // The size that the user sees now. For Transfers with no requested height, the list can be lower than its cap.
    function currentSize(field) {
        // An empty list is 0 px high. A hidden list has no box: then use the cap.
        if (field === 'transferHeight' && !eff.transferSet && transferList && transferList.getClientRects().length > 0) {
            return Math.round(transferList.getBoundingClientRect().height);
        }
        if (field === 'buddyWidth') return eff.buddyWidth;
        if (field === 'mapWidth') return eff.mapWidth;
        return eff.transferHeight;
    }

    function applyRequested(field, value, commit) {
        if (!eff) render();
        const [min, max] = limitsOf(field);
        pref = withSize(pref, field, value, min, max);
        render();
        if (commit) save();
    }

    // +1: a larger value of the pointer coordinate makes the panel larger.
    function growSign(field) {
        if (field === 'buddyWidth') return pref.buddySide === 'right' ? -1 : 1;
        return -1;
    }

    function keysFor(field) {
        if (field === 'transferHeight') return [['ArrowUp'], ['ArrowDown']];
        if (field === 'mapWidth') return [['ArrowLeft'], ['ArrowRight']];
        return pref.buddySide === 'right' ? [['ArrowLeft'], ['ArrowRight']] : [['ArrowRight'], ['ArrowLeft']];
    }

    function onSeparatorKey(field, event) {
        if (event.key === 'Escape') {
            if (drag) {
                cancelDrag();
                event.preventDefault();
                event.stopPropagation();
            }
            return;
        }
        if (drag) return;
        const [min, max] = limitsOf(field);
        let target = null;
        if (event.key === 'Home') target = min;
        else if (event.key === 'End') target = max;
        else {
            const [grow, shrink] = keysFor(field);
            const delta = keyDelta(event.key, event.shiftKey, grow, shrink);
            if (delta !== 0) target = currentSize(field) + delta;
        }
        if (target === null) return;
        event.preventDefault();
        applyRequested(field, target, true);
    }

    function onDragKey(event) {
        if (!drag || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        cancelDrag();
    }

    function endDrag() {
        const d = drag;
        drag = null;
        window.removeEventListener('keydown', onDragKey, true);
        body.classList.remove('layout-dragging');
        if (d) {
            d.sep.classList.remove('layout-sep-active');
            if (d.sep.hasPointerCapture && d.sep.hasPointerCapture(d.pointerId)) d.sep.releasePointerCapture(d.pointerId);
        }
        return d;
    }

    function commitDrag() {
        if (!endDrag()) return;
        save();
    }

    function cancelDrag() {
        const d = endDrag();
        if (!d) return;
        pref = d.before;
        render();
    }

    function startDrag(field, sep, event) {
        if (drag || event.button !== 0) return;
        if (!eff) render();
        event.preventDefault();
        sep.focus({ preventScroll: true });
        drag = {
            field,
            sep,
            pointerId: event.pointerId,
            axis: field === 'transferHeight' ? 'clientY' : 'clientX',
            start: field === 'transferHeight' ? event.clientY : event.clientX,
            startSize: currentSize(field),
            sign: growSign(field),
            before: Object.assign({}, pref),
        };
        sep.setPointerCapture(event.pointerId);
        sep.classList.add('layout-sep-active');
        body.classList.add('layout-dragging');
        window.addEventListener('keydown', onDragKey, true);
    }

    function moveDrag(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const delta = (event[drag.axis] - drag.start) * drag.sign;
        applyRequested(drag.field, drag.startSize + delta, false);
    }

    for (const [field, sep] of Object.entries(separators)) {
        if (!sep) continue;
        sep.addEventListener('pointerdown', event => startDrag(field, sep, event));
        sep.addEventListener('pointermove', moveDrag);
        sep.addEventListener('pointerup', event => {
            if (drag && event.pointerId === drag.pointerId) commitDrag();
        });
        sep.addEventListener('pointercancel', event => {
            if (drag && event.pointerId === drag.pointerId) cancelDrag();
        });
        sep.addEventListener('lostpointercapture', event => {
            if (drag && event.pointerId === drag.pointerId) commitDrag();
        });
        sep.addEventListener('keydown', event => onSeparatorKey(field, event));
    }

    // ---- The Buddies drawer (narrow window) ----

    function isDrawerOpen() {
        return body.classList.contains('layout-drawer-open');
    }

    function openDrawer(opener) {
        if (!eff || eff.buddyMode !== 'drawer' || !buddyPanel) return;
        // One drawer at a time: close the map overlay first. renderer.js stays the owner of the map.
        if (mapIsOpen() && !eff.mapDocked && mapToggle) mapToggle.click();
        drawerOpener = opener || null;
        body.classList.add('layout-drawer-open');
        buddyPanel.focus({ preventScroll: true });
    }

    function closeDrawer(returnFocus) {
        if (!isDrawerOpen()) return;
        body.classList.remove('layout-drawer-open');
        const opener = drawerOpener;
        drawerOpener = null;
        if (returnFocus && opener && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    }

    if (buddyPanel) {
        buddyPanel.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !isDrawerOpen()) return;
            event.preventDefault();
            event.stopPropagation();
            closeDrawer(true);
        });
    }

    // ---- The View menu ----

    function isMenuOpen() {
        return Boolean(viewMenu && !viewMenu.hidden);
    }

    function menuItems() {
        if (!viewMenu) return [];
        return Array.from(viewMenu.querySelectorAll('[role^="menuitem"]')).filter(item => !item.hidden);
    }

    function focusItem(index) {
        const list = menuItems();
        if (list.length === 0) return;
        const i = ((index % list.length) + list.length) % list.length;
        list[i].focus({ preventScroll: true });
    }

    function openMenu(index) {
        if (!viewMenu || !viewToggle) return;
        updateMenu();
        viewMenu.hidden = false;
        viewToggle.setAttribute('aria-expanded', 'true');
        focusItem(index);
    }

    function closeMenu(returnFocus) {
        if (!isMenuOpen()) return;
        viewMenu.hidden = true;
        viewToggle.setAttribute('aria-expanded', 'false');
        if (returnFocus) viewToggle.focus({ preventScroll: true });
    }

    function setPref(change) {
        pref = Object.assign({}, pref, change);
        render();
        save();
    }

    // keepOpen: Space on a check item changes it and keeps the menu open.
    let compactSelection = null;
    let viewOrigin = null;
    // Native menu interaction can collapse a transcript selection before the click is delivered.
    function rememberTranscript() {
        const s = doc.getSelection();
        const list = byId('messages');
        compactSelection = s && !s.isCollapsed && list?.contains(s.anchorNode) && list.contains(s.focusNode)
            ? [s.anchorNode, s.anchorOffset, s.focusNode, s.focusOffset] : null;
        viewOrigin = doc.activeElement;
    }
    viewToggle?.addEventListener('pointerdown', rememberTranscript);
    viewToggle?.addEventListener('keydown', rememberTranscript);

    function activate(item, keepOpen) {
        if (!item) return;
        const isCheck = item.getAttribute('role') === 'menuitemcheckbox';
        const stay = keepOpen && isCheck;
        if (item === items.drawer) {
            closeMenu(false);
            openDrawer(viewToggle);
            return;
        }
        if (!stay) closeMenu(true);
        if (item.id === 'view-voice') {
            if (!pref.buddiesShown) setPref({ buddiesShown: true });
            if (eff.buddyMode === 'drawer') openDrawer(viewToggle);
            const join = byId('join-voice');
            (join.hidden ? byId('mute') : join).focus({ preventScroll: true });
        } else if (item.id === 'detach-voice') window.roomVoiceMonitor?.open();
        else if (item.id === 'view-compact') {
            window.reading.keepPosition(() => {
                setPref({ compactTranscript: !pref.compactTranscript });
                if (!stay && viewOrigin?.isConnected && !viewMenu.contains(viewOrigin)) {
                    viewOrigin.focus({ preventScroll: true });
                }
                if (compactSelection?.[0].isConnected && compactSelection[2].isConnected) {
                    doc.getSelection().setBaseAndExtent(...compactSelection);
                }
            });
        } else if (item === items.buddies) setPref({ buddiesShown: !pref.buddiesShown });
        else if (item === items.transfers) {
            transfersOpen = !pref.transfersPinned;
            setPref({ transfersPinned: transfersOpen });
        }
        else if (item === items.map && mapToggle) mapToggle.click();
        else if (item.id === 'view-music') void window.musicUi?.toggleHidden();
        else if (item.id === 'view-theme') window.roomThemes.open(viewOrigin);
        else if (item.id === 'view-system-buttons') window.frameControls?.toggleSystemButtons();
        else if (item.id === 'view-idle') window.idlePeer?.enter();
        else if (item.id === 'view-close-idle') window.idlePeer?.toggleClose();
        else if (item.id === 'view-quit') window.appShell ? window.appShell.quit() : window.asscrack.quit();
        else if (item.id === 'view-shortcuts') window.appShell?.openShortcuts();
        else if (item.id === 'view-about') window.appShell?.openAbout();
        else if (item.id === 'view-whats-new') void window.whatsNew?.open();
        else if (item.id === 'view-startup') window.startupUi?.open();
        else if (item.id === 'view-clear-previews') void window.chatMedia?.clearPreviews();
        else if (item.id === 'view-previews') window.chatMedia?.toggleAuto();
        else if (item.id === 'view-attention') window.roomAttention?.openSettings();
        else if (item.id === 'view-typing') window.typingUi?.toggleShare();
        else if (item === items.side) setPref({ buddySide: pref.buddySide === 'left' ? 'right' : 'left' });
        else if (item === items.reset) reset();
        updateMenu();
    }

    if (viewToggle && viewMenu) {
        viewToggle.addEventListener('click', () => {
            if (isMenuOpen()) closeMenu(true);
            else openMenu(0);
        });
        viewToggle.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                openMenu(event.key === 'ArrowDown' ? 0 : -1);
            }
        });
        viewMenu.addEventListener('keydown', event => {
            const list = menuItems();
            const index = list.indexOf(doc.activeElement);
            switch (event.key) {
                case 'ArrowDown': focusItem(index + 1); break;
                case 'ArrowUp': focusItem(index < 0 ? -1 : index - 1); break;
                case 'Home': focusItem(0); break;
                case 'End': focusItem(-1); break;
                case 'Enter': activate(list[index], false); break;
                case ' ': activate(list[index], true); break;
                case 'Escape':
                    event.stopPropagation();
                    closeMenu(true);
                    break;
                case 'Tab':
                    closeMenu(false);
                    return;
                default:
                    return;
            }
            event.preventDefault();
        });
        viewMenu.addEventListener('click', event => {
            const item = event.target.closest('[role^="menuitem"]');
            if (item && viewMenu.contains(item)) activate(item, false);
        });
    }

    // A pointer press outside closes the menu and the drawer.
    doc.addEventListener('pointerdown', event => {
        const target = event.target;
        if (isMenuOpen() && !viewMenu.contains(target) && !viewToggle.contains(target)) closeMenu(false);
        if (isDrawerOpen() && buddyPanel && !buddyPanel.contains(target) && !(viewMenu && viewMenu.contains(target))) {
            closeDrawer(false);
        }
    }, true);

    // ---- Public API, reset and recompute ----

    function reset() {
        if (drag) cancelDrag();
        pref = defaultPref();
        transfersOpen = false;
        render();
        save();
    }

    function closeTopLayer() {
        if (isMenuOpen()) {
            closeMenu(true);
            return true;
        }
        if (isDrawerOpen()) {
            closeDrawer(true);
            return true;
        }
        return false;
    }

    function showTransfers(open) {
        transfersOpen = open;
        if (!open && pref.transfersPinned) setPref({ transfersPinned: false });
        else render();
    }
    frameTransfers.addEventListener('click', () => showTransfers(!transfersOpen));
    window.layout = Object.freeze({ closeTopLayer, isDrawerOpen, reset, showTransfers: () => showTransfers(true) });

    window.addEventListener('resize', schedule);
    // The map changes the room for the chat column. Only the map-open class starts a recompute (render itself
    // changes body classes).
    new MutationObserver(() => {
        const open = mapIsOpen();
        if (open === lastMapOpen) return;
        lastMapOpen = open;
        if (open && isDrawerOpen()) {
            // An action in the drawer (for example "Show on map") opens the map. Focus goes back to the opener.
            const active = doc.activeElement;
            closeDrawer(!active || active === body || Boolean(buddyPanel && buddyPanel.contains(active)));
        }
        render();
    }).observe(body, { attributes: true, attributeFilter: ['class'] });
    // The bands change height (the tool band wraps, the chat screen shows). Recompute in the next frame.
    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(schedule);
        for (const id of ['titlebar', 'room-heading', 'composer', 'statusbar']) {
            const el = byId(id);
            if (el) observer.observe(el);
        }
        // New transfer rows change the visible list height: update only the separator value (no layout change).
        if (transferList) new ResizeObserver(updateTransferSeparator).observe(transferList);
    }

    render();
})();
