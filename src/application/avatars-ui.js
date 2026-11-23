// 1.0.6: profile pictures in the room window (avatars.mjs in the main process). Classic script; all names stay inside
// this function. window.avatarsCore: the pure crop math (tests).
//
// The window gets only hashes: { self, peers: { peerId: hash }, devices: { deviceId: hash } }. An <img> loads
// avatar/<hash> of the app scheme (a PNG that the decoder window made and the main process checked). An image that
// does not load goes away, and the letter (or the name alone) stays.
//
// Where: the buddy lines (an <img> in the .avatar ball), the chat lines (a small <img> in .from), the voice list
// (an <img> in .vc-person). The friends list and the knock bar set their own <img> (friends-ui.js, knock-ui.js).
// The dialog "Profile picture": Choose…, a square crop with drag and zoom, Save and Remove.
(function () {
    'use strict';

    const VIEW = 200; // the size of the crop square in CSS pixels

    // The crop of a picture of w x h preview pixels in the square VIEW: zoom 1 covers the square. ox, oy: the offset
    // of the picture (0 or less). Gives the clamped offset and the crop in parts of 1.
    function crop(w, h, zoom, ox, oy, view = VIEW) {
        const scale = (view / Math.min(w, h)) * Math.min(4, Math.max(1, zoom));
        const W = w * scale, H = h * scale;
        const x = Math.min(0, Math.max(view - W, ox));
        const y = Math.min(0, Math.max(view - H, oy));
        return { ox: x, oy: y, W, H, crop: { x: (-x / W) || 0, y: (-y / H) || 0, w: view / W, h: view / H } };
    }
    const DEVICE = /^([A-Za-z0-9_-]{43})\./;
    window.avatarsCore = Object.freeze({ crop, deviceOfMessage: id => DEVICE.exec(String(id ?? ''))?.[1] ?? null });

    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const api = window.asscrack;
    if (!api?.getAvatars) return;
    let view = { self: null, peers: {}, devices: {} };
    const url = hash => `avatar/${hash}`;
    const selfPeer = () => (typeof selfId === 'string' ? selfId : null); // renderer.js

    // Put an <img class=cls> as the first child of box, or remove it (hash null).
    function setPicture(box, hash, cls) {
        let img = box.querySelector(`:scope > img.${cls}`);
        if (!hash) { img?.remove(); return; }
        if (img && img.dataset.hash === hash) return;
        if (!img) {
            img = document.createElement('img');
            img.className = `${cls} avatar-pic`;
            img.alt = '';
            img.decoding = 'async';
            img.draggable = false;
            img.addEventListener('error', () => img.remove());
        }
        img.dataset.hash = hash;
        img.src = url(hash);
        if (box.firstChild !== img) box.prepend(img);
    }

    const peerHash = peerId => (peerId && peerId === selfPeer() ? view.self : view.peers[peerId] ?? null);
    function lineHash(li) {
        if (li.classList.contains('own')) return view.self;
        if (li.dataset.peerId) return peerHash(li.dataset.peerId) ?? deviceHash(li.dataset.id);
        return deviceHash(li.dataset.id);
    }
    function deviceHash(id) {
        const device = window.avatarsCore.deviceOfMessage(id);
        return device ? view.devices[device] ?? null : null;
    }

    function applyTo(root) {
        if (!(root instanceof Element)) return;
        const pick = selector => (root.matches(selector) ? [root] : []).concat(Array.from(root.querySelectorAll(selector)));
        for (const ball of pick('#peers li > .avatar')) {
            const li = ball.parentElement;
            setPicture(ball, li.dataset.self === 'true' ? view.self : peerHash(li.dataset.peerId), 'buddy-pic');
        }
        for (const from of pick('li > .from')) {
            const li = from.parentElement;
            if (li.classList.contains('note')) continue;
            setPicture(from, lineHash(li), 'chat-pic');
        }
        for (const person of pick('li.vc-person')) setPicture(person, peerHash(person.dataset.peerId), 'vc-pic');
    }
    const applyAll = () => applyTo(document.body);

    // New lines and a name change (setPeerName sets textContent of the ball) get the picture again.
    let queued = new Set();
    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.target instanceof Element && (record.target.matches('.avatar, .from, .vc-person'))) queued.add(record.target);
            for (const node of record.addedNodes) if (node instanceof Element && !node.classList.contains('avatar-pic')) queued.add(node);
        }
        if (queued.size === 0) return;
        const batch = queued;
        queued = new Set();
        for (const node of batch) {
            if (!node.isConnected) continue;
            // A changed .avatar, .from or .vc-person: its parent row is the root.
            applyTo(node.matches('.avatar, .from') ? node.parentElement : node);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    function update(next) {
        if (!next || typeof next !== 'object') return;
        view = { self: next.self ?? null, peers: next.peers ?? {}, devices: next.devices ?? {} };
        applyAll();
        showOwn();
    }
    api.onAvatars?.(update);
    Promise.resolve(api.getAvatars()).then(update).catch(() => {});

    // ---- The dialog "Profile picture" ----
    const dialog = document.getElementById('avatar-dialog');
    if (!dialog) return;
    const frame = document.getElementById('avatar-crop');
    const image = document.getElementById('avatar-crop-image');
    const zoom = document.getElementById('avatar-zoom');
    const chooseButton = document.getElementById('avatar-choose');
    const saveButton = document.getElementById('avatar-save');
    const removeButton = document.getElementById('avatar-remove');
    const error = document.getElementById('avatar-error');
    let pickState = null; // { token, width, height, ox, oy }
    let busy = false;

    function showOwn() {
        for (const box of document.querySelectorAll('.own-avatar')) setPicture(box, view.self, 'own-pic');
        if (!dialog.open) return;
        removeButton.disabled = busy || !view.self;
    }
    function setError(text) {
        error.textContent = text || '';
        error.hidden = !text;
    }
    const errorText = err => String(err?.message ?? err ?? '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    function place() {
        if (!pickState) return;
        const r = crop(pickState.width, pickState.height, pickState.zoom, pickState.ox, pickState.oy);
        pickState.ox = r.ox;
        pickState.oy = r.oy;
        pickState.crop = r.crop;
        image.style.width = `${r.W}px`;
        image.style.height = `${r.H}px`;
        image.style.transform = `translate(${r.ox}px, ${r.oy}px)`;
    }
    function controls() {
        const picked = Boolean(pickState);
        frame.classList.toggle('picked', picked);
        image.hidden = !picked;
        zoom.disabled = busy || !picked;
        saveButton.disabled = busy || !picked;
        chooseButton.disabled = busy;
        removeButton.disabled = busy || !view.self;
    }

    function open() {
        pickState = null;
        image.removeAttribute('src');
        zoom.value = '1';
        setError('');
        controls();
        showOwn();
        if (!dialog.open) dialog.showModal();
    }

    async function choose() {
        if (busy) return;
        busy = true;
        controls();
        setError('');
        try {
            const picked = await api.pickAvatar();
            if (picked && typeof picked.token === 'string') {
                // Center the square on the picture.
                const start = crop(picked.width, picked.height, 1, 0, 0);
                pickState = { token: picked.token, width: picked.width, height: picked.height,
                    zoom: 1, ox: (VIEW - start.W) / 2, oy: (VIEW - start.H) / 2 };
                zoom.value = '1';
                image.src = `avatar-pick/${picked.token}`;
                place();
            }
        } catch (err) { setError(errorText(err) || 'Can\'t open this picture.'); }
        finally {
            busy = false;
            controls();
        }
    }

    async function save() {
        if (busy || !pickState?.crop) return;
        busy = true;
        controls();
        try {
            update(await api.setAvatar(pickState.token, pickState.crop));
            dialog.close();
        } catch (err) { setError(errorText(err) || 'Can\'t use this picture.'); }
        finally {
            busy = false;
            controls();
        }
    }

    async function remove() {
        if (busy || !view.self) return;
        busy = true;
        controls();
        try {
            update(await api.removeAvatar());
            pickState = null;
        } catch (err) { setError(errorText(err)); }
        finally {
            busy = false;
            controls();
        }
    }

    // Drag to move, the wheel and the slider to zoom, the arrow keys to move.
    let drag = null;
    frame.addEventListener('pointerdown', event => {
        if (!pickState) return;
        drag = { x: event.clientX, y: event.clientY, ox: pickState.ox, oy: pickState.oy };
        frame.setPointerCapture(event.pointerId);
    });
    frame.addEventListener('pointermove', event => {
        if (!drag || !pickState) return;
        pickState.ox = drag.ox + event.clientX - drag.x;
        pickState.oy = drag.oy + event.clientY - drag.y;
        place();
    });
    const endDrag = () => { drag = null; };
    frame.addEventListener('pointerup', endDrag);
    frame.addEventListener('pointercancel', endDrag);
    function zoomTo(value) {
        if (!pickState || !Number.isFinite(value)) return;
        const before = crop(pickState.width, pickState.height, pickState.zoom, pickState.ox, pickState.oy);
        pickState.zoom = Math.min(4, Math.max(1, value));
        zoom.value = String(pickState.zoom);
        const after = crop(pickState.width, pickState.height, pickState.zoom, 0, 0);
        // Keep the center of the square on the same point of the picture.
        const cx = (VIEW / 2 - before.ox) / before.W, cy = (VIEW / 2 - before.oy) / before.H;
        pickState.ox = VIEW / 2 - cx * after.W;
        pickState.oy = VIEW / 2 - cy * after.H;
        place();
    }
    zoom.addEventListener('input', () => zoomTo(Number(zoom.value)));
    frame.addEventListener('wheel', event => {
        if (!pickState) return;
        event.preventDefault();
        zoomTo(pickState.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
    frame.addEventListener('keydown', event => {
        if (!pickState) return;
        const step = event.shiftKey ? 20 : 5;
        const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        pickState.ox += move[0];
        pickState.oy += move[1];
        place();
    });

    chooseButton.addEventListener('click', () => void choose());
    saveButton.addEventListener('click', () => void save());
    removeButton.addEventListener('click', () => void remove());
    for (const button of document.querySelectorAll('[data-avatar-open]')) button.addEventListener('click', () => open());
    window.avatarsUi = Object.freeze({ open });
})();
