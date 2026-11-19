// Push to talk in all windows (main process). A key hook of the system (uiohook-napi) sees the key also while the
// ASSCRACK window is not in front. The window gets only { down } changes of the one push-to-talk key.
// Privacy: the hook runs only while this user is in voice, in push-to-talk mode, with a key and the option
// "also when ASSCRACK is in the back" on. The handler compares the key code only. It keeps and logs no key.
// The native module is loaded only when the hook starts the first time (loadModule), thus a failure to load it
// stops only this function: the window then uses push to talk in the focused window.

// KeyboardEvent.code -> the name in UiohookKey of uiohook-napi.
const NAMED = {
    Backspace: 'Backspace', CapsLock: 'CapsLock', Space: 'Space', PageUp: 'PageUp', PageDown: 'PageDown',
    End: 'End', Home: 'Home', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowRight: 'ArrowRight',
    ArrowDown: 'ArrowDown', Insert: 'Insert', Delete: 'Delete', NumpadMultiply: 'NumpadMultiply',
    NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSubtract', NumpadDecimal: 'NumpadDecimal',
    NumpadDivide: 'NumpadDivide', Semicolon: 'Semicolon', Equal: 'Equal', Comma: 'Comma', Minus: 'Minus',
    Period: 'Period', Slash: 'Slash', Backquote: 'Backquote', BracketLeft: 'BracketLeft', Backslash: 'Backslash',
    BracketRight: 'BracketRight', Quote: 'Quote', ControlLeft: 'Ctrl', ControlRight: 'CtrlRight', AltLeft: 'Alt',
    AltRight: 'AltRight', ShiftLeft: 'Shift', ShiftRight: 'ShiftRight', MetaLeft: 'Meta', MetaRight: 'MetaRight',
    NumLock: 'NumLock', ScrollLock: 'ScrollLock', PrintScreen: 'PrintScreen'
};

// The mouse buttons of the settings -> the button number of libuiohook (3 middle, 4 back, 5 forward).
const MOUSE = { MouseMiddle: 3, MouseBack: 4, MouseForward: 5 };

// The hook target of a push-to-talk key: { type: 'key', keycode } or { type: 'mouse', button }, or null when the
// hook cannot see this key (then push to talk works only in the focused window).
export function hookTarget(code, keys) {
    if (typeof code !== 'string' || !keys) return null;
    if (Object.prototype.hasOwnProperty.call(MOUSE, code)) return { type: 'mouse', button: MOUSE[code] };
    let name = NAMED[code];
    if (!name) {
        const m = /^(?:Key([A-Z])|Digit(\d)|Numpad(\d)|(F(?:[1-9]|1\d|2[0-4])))$/.exec(code);
        if (m) name = m[1] ?? m[2] ?? (m[3] !== undefined ? `Numpad${m[3]}` : m[4]);
    }
    const keycode = name !== undefined ? keys[name] : undefined;
    return Number.isInteger(keycode) ? { type: 'key', keycode } : null;
}

// loadModule(): returns { uIOhook, UiohookKey } (the uiohook-napi exports). send(down): to the window.
// log(level, text): the log file of the app.
export function createPttHook({ loadModule, send, log = () => {} }) {
    let mod = null;
    let failed = null;
    let running = false;
    let settings = null;
    let inVoice = false;
    let target = null;
    let down = false;

    function release() {
        if (!down) return;
        down = false;
        send(false);
    }

    function press() {
        if (down) return;
        down = true;
        send(true);
    }

    const onKeyDown = e => { if (target?.type === 'key' && e?.keycode === target.keycode) press(); };
    const onKeyUp = e => { if (target?.type === 'key' && e?.keycode === target.keycode) release(); };
    const onMouseDown = e => { if (target?.type === 'mouse' && e?.button === target.button) press(); };
    const onMouseUp = e => { if (target?.type === 'mouse' && e?.button === target.button) release(); };

    function load() {
        if (mod || failed) return mod;
        try {
            mod = loadModule();
            mod.uIOhook.on('keydown', onKeyDown);
            mod.uIOhook.on('keyup', onKeyUp);
            mod.uIOhook.on('mousedown', onMouseDown);
            mod.uIOhook.on('mouseup', onMouseUp);
        } catch (err) {
            failed = err?.message ?? String(err);
            mod = null;
            log('WARN', `Push-to-talk key hook not available: ${failed}`);
        }
        return mod;
    }

    function start() {
        if (running || !load()) return;
        try {
            mod.uIOhook.start();
            running = true;
            log('EVENT', 'push-to-talk key hook started');
        } catch (err) {
            failed = err?.message ?? String(err);
            log('WARN', `Push-to-talk key hook did not start: ${failed}`);
        }
    }

    function stop() {
        release();
        if (!running) return;
        running = false;
        try {
            mod.uIOhook.stop();
        } catch (err) {
            log('WARN', `Push-to-talk key hook did not stop: ${err?.message ?? err}`);
        }
        log('EVENT', 'push-to-talk key hook stopped');
    }

    function update() {
        const wanted = inVoice && settings?.mode === 'ptt' && settings?.pttGlobal === true && Boolean(settings?.pttKey);
        if (!wanted) {
            stop();
            target = null;
            return;
        }
        if (!load()) {
            stop();
            return;
        }
        const next = hookTarget(settings.pttKey, mod.UiohookKey);
        if (JSON.stringify(next) !== JSON.stringify(target)) release();
        target = next;
        if (target) start();
        else stop();
    }

    return {
        configure(next) {
            settings = next;
            update();
        },
        setInVoice(value) {
            inVoice = value === true;
            update();
        },
        stop() {
            inVoice = false;
            update();
        },
        // 'on': the hook runs. 'off': not wanted now. 'no-key': the hook cannot see this key.
        // 'unavailable': the native module did not load or start.
        status() {
            if (running) return 'on';
            if (failed) return 'unavailable';
            if (inVoice && settings?.mode === 'ptt' && settings?.pttGlobal === true && settings?.pttKey && mod && !target) return 'no-key';
            return 'off';
        }
    };
}
