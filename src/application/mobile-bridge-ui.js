// Desktop Settings UI for the Mobile Browser Bridge (window.mobileBridgeUi = { open() }).
(function () {
    const bridge = window.mobileBridge;
    const api = window.asscrack;
    const byId = id => document.getElementById(id);
    const dialog = byId('mobile-bridge-dialog');
    const enabledBox = byId('mobile-bridge-enabled');
    const statusEl = byId('mobile-bridge-status');
    const portInput = byId('mobile-bridge-port');
    const hostInput = byId('mobile-bridge-host');
    const remotePortInput = byId('mobile-bridge-remote-port');
    const saveConfigBtn = byId('mobile-bridge-save-config');
    const pairingWrap = byId('mobile-bridge-pairing');
    const qrLanBox = byId('mobile-qr-lan');
    const urlLanInput = byId('mobile-url-lan');
    const copyLanBtn = byId('mobile-copy-lan');
    const qrRemoteCard = byId('mobile-qr-remote-card');
    const qrRemoteBox = byId('mobile-qr-remote');
    const urlRemoteInput = byId('mobile-url-remote');
    const copyRemoteBtn = byId('mobile-copy-remote');
    const refreshQrBtn = byId('mobile-bridge-refresh-qr');
    const devicesList = byId('mobile-bridge-devices');
    const revokeAllBtn = byId('mobile-bridge-revoke-all');
    if (!bridge || !dialog || !enabledBox) return;

    let busy = false;

    function formatLastSeen(ts) {
        if (!ts) return 'Never';
        try {
            return new Date(ts).toLocaleString();
        } catch {
            return '';
        }
    }

    function renderQrSvg(container, svgText) {
        container.replaceChildren();
        if (!svgText) return;
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const svg = doc.documentElement;
        if (svg && svg.nodeName.toLowerCase() === 'svg') {
            container.appendChild(document.importNode(svg, true));
        }
    }

    function renderDevices(devices) {
        devicesList.replaceChildren();
        const list = Array.isArray(devices) ? devices : [];
        revokeAllBtn.hidden = list.length === 0;
        if (list.length === 0) {
            const li = document.createElement('li');
            li.className = 'dialog-note';
            li.textContent = 'No paired devices.';
            devicesList.appendChild(li);
            return;
        }
        for (const d of list) {
            const li = document.createElement('li');
            li.className = 'mobile-device-row';
            const info = document.createElement('span');
            info.textContent = `${d.label} — Last seen: ${formatLastSeen(d.lastSeenAt)}`;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = 'Revoke';
            btn.addEventListener('click', () => void bridge.revokeDevice(d.id).then(renderState));
            li.append(info, btn);
            devicesList.appendChild(li);
        }
    }

    function renderState(state) {
        if (!state) return;
        enabledBox.checked = state.enabled === true;
        portInput.value = state.savedPort ? String(state.savedPort) : '';
        hostInput.value = state.manualHost || '';
        remotePortInput.value = state.manualPort ? String(state.manualPort) : '';

        if (!state.enabled) {
            statusEl.textContent = 'Off';
            pairingWrap.hidden = true;
        } else if (state.running) {
            const upnp =
                state.upnpStatus === 'mapped'
                    ? 'UPnP open'
                    : state.upnpStatus === 'mapping'
                        ? 'Opening UPnP port…'
                        : 'LAN only (UPnP unavailable)';
            statusEl.textContent = `Listening on port ${state.port} · ${upnp}`;
        } else {
            statusEl.textContent = 'Starting…';
            pairingWrap.hidden = true;
        }
        renderDevices(state.devices);
    }

    async function refreshPairing() {
        const info = await bridge.createPairing();
        if (!info) {
            pairingWrap.hidden = true;
            return;
        }
        pairingWrap.hidden = false;
        renderQrSvg(qrLanBox, info.lanQrSvg);
        urlLanInput.value = info.lanUrl || '';
        if (info.remoteUrl && info.remoteQrSvg) {
            qrRemoteCard.hidden = false;
            renderQrSvg(qrRemoteBox, info.remoteQrSvg);
            urlRemoteInput.value = info.remoteUrl;
        } else {
            qrRemoteCard.hidden = true;
            qrRemoteBox.replaceChildren();
            urlRemoteInput.value = '';
        }
    }

    async function refreshAll() {
        const state = await bridge.getState();
        renderState(state);
        if (state?.running) await refreshPairing();
        else pairingWrap.hidden = true;
    }

    enabledBox.addEventListener('change', async () => {
        if (busy) return;
        busy = true;
        enabledBox.disabled = true;
        try {
            const state = await bridge.setEnabled(enabledBox.checked);
            renderState(state);
            if (state?.running) await refreshPairing();
            else pairingWrap.hidden = true;
        } catch (err) {
            statusEl.textContent = String(err?.message ?? err);
        } finally {
            busy = false;
            enabledBox.disabled = false;
        }
    });

    saveConfigBtn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
            const port = portInput.value.trim() === '' ? 0 : Number(portInput.value);
            const manualHost = hostInput.value.trim();
            const manualPort = remotePortInput.value.trim() === '' ? null : Number(remotePortInput.value);
            const state = await bridge.setConfig({ port, manualHost, manualPort });
            renderState(state);
            if (state?.running) await refreshPairing();
        } catch (err) {
            statusEl.textContent = String(err?.message ?? err);
        } finally {
            busy = false;
        }
    });

    refreshQrBtn.addEventListener('click', () => void refreshPairing());
    copyLanBtn.addEventListener('click', () => void api?.copyText?.(urlLanInput.value));
    copyRemoteBtn.addEventListener('click', () => void api?.copyText?.(urlRemoteInput.value));
    revokeAllBtn.addEventListener('click', () => void bridge.revokeAll().then(renderState));

    bridge.onChanged?.(state => {
        if (dialog.open) renderState(state);
    });

    async function open() {
        if (!dialog.open) dialog.showModal();
        await refreshAll();
    }

    window.mobileBridgeUi = Object.freeze({ open });
})();
