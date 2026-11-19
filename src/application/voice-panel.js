'use strict';

// The voice settings panel and the push-to-talk key.
// - The main process keeps the settings (voice-settings.mjs, file voice-settings.json in the user data folder).
//   Each change goes to the main process first. The checked settings then go to voice.js (applySettings).
// - The microphone runs while the panel is open, for the input meter (voice.startPreview). Nothing goes out
//   while this user is not in voice.
// - Push to talk works while this window has the focus. A key up when the window is not in front does not come to
//   the window, thus a blur or a hidden window releases the key. (A key hook for all windows needs a native module.)
(function () {
    const api = window.asscrack;
    const voice = window.voice;
    if (!api || !voice || typeof api.getVoiceSettings !== 'function') return;

    const $ = id => document.getElementById(id);
    const panel = $('voice-settings');
    const toggle = $('voice-settings-toggle');
    const closeButton = $('vs-close');
    const toolbar = $('toolbar');
    const modeVoice = $('vs-mode-voice');
    const modePtt = $('vs-mode-ptt');
    const voiceGroup = $('vs-voice-group');
    const pttGroup = $('vs-ptt-group');
    const meterFill = $('vs-meter-fill');
    const meterLine = $('vs-meter-line');
    const meterNote = $('vs-meter-note');
    const threshold = $('vs-threshold');
    const thresholdValue = $('vs-threshold-value');
    const vadRelease = $('vs-vad-release');
    const vadReleaseValue = $('vs-vad-release-value');
    const pttKey = $('vs-ptt-key');
    const pttSet = $('vs-ptt-set');
    const pttNote = $('vs-ptt-note');
    const pttRelease = $('vs-ptt-release');
    const pttReleaseValue = $('vs-ptt-release-value');
    const echo = $('vs-ec');
    const noise = $('vs-ns');
    const gain = $('vs-agc');
    const inputSelect = $('vs-input');
    const outputSelect = $('vs-output');
    const deviceNote = $('vs-device-note');

    const METER_MIN = -80;
    const METER_MAX = -10;
    const FORBIDDEN = ['Escape', 'Enter', 'NumpadEnter', 'Tab'];
    const MOUSE_KEYS = { 1: 'MouseMiddle', 3: 'MouseBack', 4: 'MouseForward' };

    let settings = null;
    let capturingKey = false;
    let meterLevel = METER_MIN;
    let meterOpen = false;
    let meterFrame = 0;

    // ---- Text ----

    const KEY_NAMES = {
        Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
        Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space', CapsLock: 'Caps Lock',
        ContextMenu: 'Menu', MouseMiddle: 'Middle mouse button', MouseBack: 'Mouse back button',
        MouseForward: 'Mouse forward button'
    };

    function keyName(code) {
        if (!code) return 'Not set';
        if (KEY_NAMES[code]) return KEY_NAMES[code];
        let m = /^Key([A-Z])$/.exec(code);
        if (m) return m[1];
        m = /^Digit(\d)$/.exec(code);
        if (m) return m[1];
        m = /^Numpad(.+)$/.exec(code);
        if (m) return `Num ${m[1]}`;
        m = /^(Control|Shift|Alt|Meta)(Left|Right)$/.exec(code);
        if (m) return `${m[2]} ${{ Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Meta: 'Windows' }[m[1]]}`;
        m = /^Arrow(.+)$/.exec(code);
        if (m) return `${m[1]} arrow`;
        return code.replace(/([a-z])([A-Z])/g, '$1 $2');
    }

    // A key that types a character in the message field (a letter, a digit, a sign or Space).
    function typesText(code) {
        return /^(Key[A-Z]|Digit\d|Space|Backquote|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(code ?? '');
    }

    function percent(db) {
        const p = (db - METER_MIN) / (METER_MAX - METER_MIN);
        return `${Math.round(Math.min(1, Math.max(0, p)) * 1000) / 10}%`;
    }

    // ---- Settings ----

    function render() {
        if (!settings) return;
        const ptt = settings.mode === 'ptt';
        modeVoice.checked = !ptt;
        modePtt.checked = ptt;
        voiceGroup.hidden = ptt;
        pttGroup.hidden = !ptt;
        panel.classList.toggle('ptt', ptt);
        threshold.value = String(settings.vadThresholdDb);
        thresholdValue.textContent = `${settings.vadThresholdDb} dB`;
        meterLine.style.left = percent(settings.vadThresholdDb);
        vadRelease.value = String(settings.vadReleaseMs);
        vadReleaseValue.textContent = `${settings.vadReleaseMs} ms`;
        pttRelease.value = String(settings.pttReleaseMs);
        pttReleaseValue.textContent = `${settings.pttReleaseMs} ms`;
        if (!capturingKey) {
            pttKey.textContent = keyName(settings.pttKey);
            pttKey.classList.toggle('unset', !settings.pttKey);
        }
        echo.checked = settings.echoCancellation;
        noise.checked = settings.noiseSuppression;
        gain.checked = settings.autoGainControl;
        renderPttNote();
        renderDeviceNote();
    }

    function renderPttNote(text) {
        let note = text ?? '';
        let warn = false;
        if (!text) {
            if (!settings?.pttKey) {
                note = 'Set a key. Until then, your voice does not go out.';
                warn = true;
            } else if (typesText(settings.pttKey)) {
                note = 'This key also types in the message field. A side mouse button, F13 or Right Ctrl does not.';
            } else {
                note = 'Push to talk works while the ASSCRACK window is in front.';
            }
        }
        pttNote.textContent = note;
        pttNote.classList.toggle('vs-warn', warn);
    }

    function renderDeviceNote() {
        const state = voice.state();
        deviceNote.textContent = state.inputFallback
            ? 'The selected microphone is not connected. The default microphone is in use.'
            : '';
        deviceNote.classList.toggle('vs-warn', state.inputFallback === true);
    }

    function use(next) {
        settings = next;
        render();
        voice.applySettings(next).catch(err => console.warn('Voice settings apply failed:', err?.message ?? err));
    }

    // Send a change to the main process. A slider shows its value at once (local), and saves when it stops.
    function save(patch) {
        return api.setVoiceSettings(patch)
            .then(use)
            .catch(err => console.warn('Voice settings save failed:', err?.message ?? err));
    }

    function preview(patch) {
        if (!settings) return;
        use({ ...settings, ...patch });
    }

    // ---- Devices ----

    function fillSelect(select, devices, current, defaultText) {
        select.textContent = '';
        const add = (value, text) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            select.append(option);
        };
        add('', defaultText);
        for (const d of devices) add(d.id, d.label);
        if (current && !devices.some(d => d.id === current)) add(current, 'Selected device (not connected)');
        select.value = current ?? '';
    }

    async function refreshDevices() {
        try {
            const { inputs, outputs } = await voice.devices();
            fillSelect(inputSelect, inputs, settings?.inputDeviceId, 'System default');
            fillSelect(outputSelect, outputs, settings?.outputDeviceId, 'System default');
        } catch (err) {
            console.warn('Voice device list failed:', err?.message ?? err);
        }
    }

    // ---- Meter ----

    function drawMeter() {
        meterFrame = 0;
        meterFill.style.width = percent(meterLevel);
        meterFill.classList.toggle('open', meterOpen);
    }

    voice.onLevel((level, open) => {
        if (panel.hidden) return;
        meterLevel = level;
        meterOpen = open;
        if (!meterFrame) meterFrame = requestAnimationFrame(drawMeter);
    });

    // ---- Panel ----

    function placePanel() {
        if (!toolbar) return;
        panel.style.top = `${toolbar.offsetTop + toolbar.offsetHeight + 4}px`;
    }

    function setOpen(open) {
        if (open === !panel.hidden) return;
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) {
            // voice.js has the settings that apply now (the last change from any path).
            settings = voice.settings() ?? settings;
            placePanel();
            render();
            meterNote.textContent = voice.state().inVoice
                ? 'The bar shows your microphone. Green: your voice goes out.'
                : 'Speak to test your microphone. Nothing goes out while you are not in voice.';
            voice.startPreview()
                .then(() => {
                    renderDeviceNote();
                    // The device names show only after the microphone permission. Read the list after the start.
                    return refreshDevices();
                })
                .catch(err => {
                    meterNote.textContent = `The microphone did not start: ${err?.message ?? err}`;
                    refreshDevices();
                });
        } else {
            stopKeyCapture();
            voice.stopPreview().catch(err => console.warn('Voice preview stop failed:', err?.message ?? err));
            meterLevel = METER_MIN;
            meterOpen = false;
            drawMeter();
        }
    }

    toggle.addEventListener('click', () => setOpen(panel.hidden));
    closeButton.addEventListener('click', () => {
        setOpen(false);
        toggle.focus({ preventScroll: true });
    });
    window.addEventListener('resize', () => {
        if (!panel.hidden) placePanel();
    });

    modeVoice.addEventListener('change', () => save({ mode: 'voice' }));
    modePtt.addEventListener('change', () => save({ mode: 'ptt' }));
    threshold.addEventListener('input', () => preview({ vadThresholdDb: Number(threshold.value) }));
    threshold.addEventListener('change', () => save({ vadThresholdDb: Number(threshold.value) }));
    vadRelease.addEventListener('input', () => preview({ vadReleaseMs: Number(vadRelease.value) }));
    vadRelease.addEventListener('change', () => save({ vadReleaseMs: Number(vadRelease.value) }));
    pttRelease.addEventListener('input', () => preview({ pttReleaseMs: Number(pttRelease.value) }));
    pttRelease.addEventListener('change', () => save({ pttReleaseMs: Number(pttRelease.value) }));
    echo.addEventListener('change', () => save({ echoCancellation: echo.checked }));
    noise.addEventListener('change', () => save({ noiseSuppression: noise.checked }));
    gain.addEventListener('change', () => save({ autoGainControl: gain.checked }));
    inputSelect.addEventListener('change', () => save({ inputDeviceId: inputSelect.value }).then(renderDeviceNote));
    outputSelect.addEventListener('change', () => save({ outputDeviceId: outputSelect.value }));
    if (navigator.mediaDevices?.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', () => {
            if (!panel.hidden) refreshDevices();
        });
    }

    // ---- Push-to-talk key ----

    function startKeyCapture() {
        capturingKey = true;
        pttSet.setAttribute('aria-pressed', 'true');
        pttSet.textContent = 'Press a key';
        pttKey.textContent = '...';
        renderPttNote('Press the key or a side mouse button. Escape stops.');
        voice.setPushToTalk(false);
    }

    function stopKeyCapture() {
        if (!capturingKey) return;
        capturingKey = false;
        pttSet.setAttribute('aria-pressed', 'false');
        pttSet.textContent = 'Set key';
        render();
    }

    function takeKey(code) {
        stopKeyCapture();
        save({ pttKey: code });
    }

    pttSet.addEventListener('click', () => {
        if (capturingKey) stopKeyCapture();
        else startKeyCapture();
    });

    function pttActive() {
        return settings?.mode === 'ptt' && Boolean(settings.pttKey) && !capturingKey;
    }

    // Capture phase: the key capture of the panel comes before the Escape dispatcher of renderer.js.
    window.addEventListener('keydown', e => {
        if (capturingKey) {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === 'Escape') {
                stopKeyCapture();
                return;
            }
            if (!e.code || FORBIDDEN.includes(e.code)) {
                renderPttNote(`${e.key || 'This key'} cannot be the push-to-talk key. Press another key.`);
                return;
            }
            takeKey(e.code);
            return;
        }
        if (pttActive() && e.code === settings.pttKey && !e.repeat) voice.setPushToTalk(true);
    }, true);

    window.addEventListener('keyup', e => {
        if (pttActive() && e.code === settings.pttKey) voice.setPushToTalk(false);
    }, true);

    window.addEventListener('mousedown', e => {
        const code = MOUSE_KEYS[e.button];
        if (!code) return;
        if (capturingKey) {
            e.preventDefault();
            takeKey(code);
            return;
        }
        if (pttActive() && code === settings.pttKey) {
            e.preventDefault();
            voice.setPushToTalk(true);
        }
    }, true);

    window.addEventListener('mouseup', e => {
        const code = MOUSE_KEYS[e.button];
        if (code && pttActive() && code === settings.pttKey) voice.setPushToTalk(false);
    }, true);

    // The key up of a key that is down when the window loses the focus does not come to this window.
    window.addEventListener('blur', () => voice.setPushToTalk(false));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) voice.setPushToTalk(false);
    });

    voice.onChange(() => {
        if (!panel.hidden) renderDeviceNote();
    });

    api.getVoiceSettings()
        .then(value => {
            settings = value;
            render();
        })
        .catch(err => console.warn('Voice settings read failed:', err?.message ?? err));

    window.voicePanel = {
        isOpen: () => !panel.hidden,
        close: () => setOpen(false),
        // Escape while the panel waits for a key: the panel uses it (stops the key capture).
        capturingKey: () => capturingKey
    };
})();
