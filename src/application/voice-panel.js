'use strict';

// The voice settings panel and the push-to-talk key.
// - The main process keeps the settings (voice-settings.mjs, file voice-settings.json in the user data folder).
//   Each change goes to the main process first. The checked settings then go to voice.js (applySettings).
// - The microphone runs while the panel is open, for the input meter (voice.startPreview). Nothing goes out
//   while this user is not in voice.
// - Push to talk: while the key hook of the main process runs (ptt-hook.mjs, status 'on'), the key events come only
//   from the hook, also while the window is not in front. Else the window listens to its own key events. Then a key
//   up when the window is not in front does not come to the window, thus a blur or a hidden window releases the key.
(function () {
    const FRAME_MS = 1000 / 30;
    const LED_SEGMENTS = 5;
    const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
    const clampSigned = value => (Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0);

    function rmsToLevel(rms) {
        if (!Number.isFinite(rms) || rms <= 0) return 0;
        return clamp01((20 * Math.log10(rms) + 54) / 48);
    }

    function ledCount(level, segments = LED_SEGMENTS) {
        const count = Math.max(1, Math.floor(segments));
        return Math.min(count, Math.max(0, Math.round(clamp01(level) * count)));
    }

    function createMeterLoop({ schedule, cancel = () => {}, now, decide, draw, stopped = () => {}, frameMs = FRAME_MS }) {
        let handle = null;
        let last = -Infinity;
        let frames = 0;
        function tick() {
            handle = null;
            if (!decide()) { stopped(); return; }
            const t = now();
            if (t - last >= frameMs - 2) {
                last = t;
                frames++;
                draw(t);
            }
            if (decide()) handle = schedule(tick);
            else stopped();
        }
        return {
            refresh() {
                if (handle !== null) {
                    if (decide()) return;
                    cancel(handle);
                    handle = null;
                    stopped();
                    return;
                }
                if (decide()) handle = schedule(tick);
            },
            stop() {
                if (handle !== null) cancel(handle);
                handle = null;
                stopped();
            },
            running: () => handle !== null,
            frames: () => frames
        };
    }

    function drawMiniOscilloscope(ctx, width, height, wave, { active = true, level = 0 } = {}) {
        if (!ctx || width <= 0 || height <= 0) return;
        ctx.clearRect(0, 0, width, height);
        const midY = height / 2;
        ctx.save?.();
        ctx.strokeStyle = 'rgba(57, 255, 122, 0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();

        const points = wave && wave.length ? wave : [0, 0];
        const amp = Math.max(1.5, height * 0.42);
        const boost = active || level > 0.02 ? 1 : 0.4;
        const trace = () => {
            ctx.beginPath();
            for (let i = 0; i < points.length; i++) {
                const x = points.length === 1 ? width / 2 : i * width / (points.length - 1);
                const y = midY - clampSigned(points[i]) * amp * boost;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        };
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = active ? 'rgba(43, 220, 79, 0.38)' : 'rgba(43, 220, 79, 0.2)';
        ctx.lineWidth = Math.max(2.5, height * 0.14);
        trace();
        ctx.strokeStyle = active ? '#6bff95' : '#4aa868';
        ctx.lineWidth = Math.max(1.2, height * 0.06);
        trace();
        ctx.restore?.();
    }

    function drawLedBar(ctx, width, height, level, segments = LED_SEGMENTS) {
        if (!ctx || width <= 0 || height <= 0) return;
        ctx.clearRect(0, 0, width, height);
        const count = Math.max(1, Math.floor(segments));
        const lit = ledCount(level, count);
        const pad = Math.max(1, Math.round(Math.min(width, height) * 0.12));
        const gap = Math.max(1, Math.round((width - pad * 2) * 0.06));
        const segW = Math.max(1, Math.floor((width - pad * 2 - gap * (count - 1)) / count));
        const segH = Math.max(1, height - pad * 2);
        const x0 = Math.floor((width - (segW * count + gap * (count - 1))) / 2);
        for (let i = 0; i < count; i++) {
            const x = x0 + i * (segW + gap);
            if (i < lit) {
                ctx.fillStyle = i >= count - 1 ? '#f0302c' : i >= count - 2 ? '#f0e231' : '#2bdc4f';
            } else {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
            }
            ctx.fillRect(x, pad, segW, segH);
        }
    }

    const metersCore = Object.freeze({
        FRAME_MS, LED_SEGMENTS, clamp01, clampSigned, rmsToLevel, ledCount,
        createMeterLoop, drawMiniOscilloscope, drawLedBar
    });
    window.voiceMetersCore = metersCore;

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
    const pttGlobal = $('vs-ptt-global');
    const echo = $('vs-ec');
    const noise = $('vs-ns');
    const noiseNote = $('vs-ns-note');
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
    // The state of the key hook of the main process: 'on', 'off', 'no-key' or 'unavailable'.
    let hookStatus = 'off';
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
        pttGlobal.checked = settings.pttGlobal;
        echo.checked = settings.echoCancellation;
        noise.value = settings.noiseSuppression;
        gain.checked = settings.autoGainControl;
        renderPttNote();
        renderDeviceNote();
        renderNoiseNote();
    }

    function renderPttNote(text) {
        let note = text ?? '';
        let warn = false;
        if (!text) {
            const notes = [];
            if (!settings?.pttKey) {
                notes.push('Set a key to talk.');
                warn = true;
            } else {
                // UI copy pass: the checkbox shows "all windows"; a note only for a limit or a problem.
                if (!settings.pttGlobal) notes.push('Works only while the window is focused.');
                else if (hookStatus === 'unavailable') {
                    notes.push('Background key unavailable. Works only while the window is focused.');
                    warn = true;
                } else if (hookStatus === 'no-key') {
                    notes.push('This key works only while the window is focused.');
                    warn = true;
                }
                if (typesText(settings.pttKey)) notes.push('This key also types text. Try a mouse side button, F13 or Right Ctrl.');
            }
            note = notes.join(' ');
        }
        pttNote.textContent = note;
        pttNote.classList.toggle('vs-warn', warn);
    }

    function renderNoiseNote() {
        const state = voice.state();
        const failed = settings?.noiseSuppression === 'rnnoise' && Boolean(state.rnnoiseError);
        noiseNote.textContent = failed ? 'Strong noise suppression failed. Using Light.' : '';
        noiseNote.classList.toggle('vs-warn', failed);
    }

    // In voice with no microphone (C1) the preview gives no error: the state has it, and it goes away with its cause.
    function renderMeterNote() {
        const { captureError, inVoice } = voice.state();
        if (captureError) meterNote.textContent = voice.microphoneErrorText(captureError, inVoice);
        // U11 of the UI copy pass: the meter is green above the line; in voice it needs no text.
        else meterNote.textContent = inVoice ? '' : 'Speak to test your mic.';
    }

    function renderDeviceNote() {
        const state = voice.state();
        deviceNote.textContent = state.inputFallback
            ? 'Mic disconnected. Using the default.'
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
        if (current && !devices.some(d => d.id === current)) add(current, 'Selected device (disconnected)');
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

    const scopeCanvas = (() => {
        const meterBox = meterFill?.parentElement;
        if (!meterBox) return null;
        let canvas = $('vs-scope');
        if (!canvas && typeof document.createElement === 'function') {
            canvas = document.createElement('canvas');
            canvas.id = 'vs-scope';
            canvas.className = 'vs-scope';
            canvas.setAttribute('aria-hidden', 'true');
            meterBox.insertBefore(canvas, meterLine ?? null);
        }
        return canvas;
    })();

    const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

    function sizeCanvas(canvas, fallbackW, fallbackH) {
        const ratio = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round((canvas.clientWidth || fallbackW) * ratio));
        const h = Math.max(1, Math.round((canvas.clientHeight || fallbackH) * ratio));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext?.('2d');
        return ctx ? { ctx, width: w, height: h } : null;
    }

    function drawEntryOnCanvas(canvas, entry, fallbackW, fallbackH) {
        const surface = sizeCanvas(canvas, fallbackW, fallbackH);
        if (!surface) return;
        const level = entry?.level ?? 0;
        const wave = entry?.wave;
        if (reducedMotion()) {
            metersCore.drawLedBar(surface.ctx, surface.width, surface.height, level, metersCore.LED_SEGMENTS);
        } else {
            metersCore.drawMiniOscilloscope(surface.ctx, surface.width, surface.height, wave, {
                active: entry?.active ?? entry?.transmitting ?? level > 0.02,
                level
            });
        }
    }

    const metersLoop = metersCore.createMeterLoop({
        schedule: fn => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, metersCore.FRAME_MS)),
        cancel: id => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); else clearTimeout(id); },
        now: () => performance.now(),
        decide: () => {
            if (document.visibilityState === 'hidden') return false;
            if (!panel.hidden && voice.state().capturing) return true;
            return document.querySelector?.('#voice-channel-list .vc-person.speaking canvas.vc-meter') !== null;
        },
        draw: () => {
            const snap = voice.meterSnapshot?.();
            if (!snap) return;
            if (!panel.hidden && scopeCanvas && (scopeCanvas.clientWidth > 0 || scopeCanvas.width > 0)) {
                drawEntryOnCanvas(scopeCanvas, snap.local, 320, 20);
            }
            const canvases = document.querySelectorAll?.('#voice-channel-list .vc-person.speaking canvas.vc-meter') ?? [];
            for (const canvas of canvases) {
                const li = canvas.closest?.('.vc-person');
                const isSelf = li?.dataset?.self === 'true';
                const peerId = li?.dataset?.peerId ?? '';
                const entry = isSelf ? snap.local : snap.remotes?.[peerId];
                drawEntryOnCanvas(canvas, entry, 38, 14);
            }
        },
        stopped: () => {
            if (scopeCanvas && scopeCanvas.width > 0 && scopeCanvas.height > 0) {
                scopeCanvas.getContext?.('2d')?.clearRect(0, 0, scopeCanvas.width, scopeCanvas.height);
            }
        }
    });

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
        metersLoop.refresh();
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
            renderMeterNote();
            voice.startPreview()
                .then(() => {
                    renderMeterNote();
                    renderDeviceNote();
                    metersLoop.refresh();
                    // The device names show only after the microphone permission. Read the list after the start.
                    return refreshDevices();
                })
                .catch(err => {
                    // C7: one text for each error name (voice.js). The original text goes to the console.
                    meterNote.textContent = voice.microphoneErrorText(err);
                    console.warn('Voice preview failed:', err?.name ?? 'Error', err?.message ?? err);
                    metersLoop.refresh();
                    refreshDevices();
                });
        } else {
            stopKeyCapture();
            voice.stopPreview().catch(err => console.warn('Voice preview stop failed:', err?.message ?? err));
            meterLevel = METER_MIN;
            meterOpen = false;
            drawMeter();
            metersLoop.refresh();
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
    pttGlobal.addEventListener('change', () => save({ pttGlobal: pttGlobal.checked }));
    echo.addEventListener('change', () => save({ echoCancellation: echo.checked }));
    noise.addEventListener('change', () => save({ noiseSuppression: noise.value }));
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
        renderPttNote('Press a key… (Esc to cancel)');
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

    // The window listens to its own key events only while the key hook does not run.
    function pttActive() {
        return settings?.mode === 'ptt' && Boolean(settings.pttKey) && !capturingKey && hookStatus !== 'on';
    }

    // The key hook of the main process.
    if (typeof api.onPushToTalk === 'function') {
        api.onPushToTalk(({ down } = {}) => {
            if (!capturingKey) voice.setPushToTalk(down === true);
        });
        const useStatus = status => {
            const before = hookStatus;
            hookStatus = typeof status === 'string' ? status : 'off';
            // The source of the key events changes: start with the key up.
            if (before !== hookStatus) voice.setPushToTalk(false);
            if (!panel.hidden && !capturingKey) renderPttNote();
        };
        api.onPushToTalkStatus(({ status } = {}) => useStatus(status));
        api.getPushToTalkStatus().then(useStatus).catch(err => console.warn('Push-to-talk status failed:', err?.message ?? err));
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
                renderPttNote(`Can't use ${e.key || 'this key'}. Press another key.`);
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
    // While the key hook runs, the hook gives the key up.
    window.addEventListener('blur', () => {
        if (hookStatus !== 'on') voice.setPushToTalk(false);
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && hookStatus !== 'on') voice.setPushToTalk(false);
        metersLoop.refresh();
    });

    voice.onChange(() => {
        metersLoop.refresh();
        if (panel.hidden) return;
        if (voice.state().inVoice) renderMeterNote();
        renderDeviceNote();
        renderNoiseNote();
    });

    api.getVoiceSettings()
        .then(value => {
            settings = value;
            render();
        })
        .catch(err => console.warn('Voice settings read failed:', err?.message ?? err));

    window.voiceMeters = Object.freeze({
        refresh: () => metersLoop.refresh(),
        stop: () => metersLoop.stop(),
        running: () => metersLoop.running()
    });

    window.voicePanel = {
        isOpen: () => !panel.hidden,
        close: () => setOpen(false),
        // Escape while the panel waits for a key: the panel uses it (stops the key capture).
        capturingKey: () => capturingKey,
        // The text of a key code, for the Keyboard shortcuts dialog (app-shell.js).
        keyName,
        // The name of the push-to-talk key, or null: the tooltip of the push-to-talk icon (renderer.js).
        pttKeyName: () => (settings?.pttKey ? keyName(settings.pttKey) : null)
    };
})();
