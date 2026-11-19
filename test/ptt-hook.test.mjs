// The push-to-talk key hook of the main process (src/application/ptt-hook.mjs) with a fake uiohook-napi module.
// No native module, no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPttHook, hookTarget } from '../src/application/ptt-hook.mjs';

// A part of the real UiohookKey table of uiohook-napi 1.5.5.
const KEYS = { A: 0x1E, J: 0x24, 1: 0x02, F13: 0x5B, F24: 0x6B, Ctrl: 0x1D, CtrlRight: 0x0E1D, Numpad5: 0x4C, Backquote: 0x29, Space: 0x39 };

function fakeModule() {
    const uIOhook = new EventEmitter();
    uIOhook.started = 0;
    uIOhook.stopped = 0;
    uIOhook.start = () => { uIOhook.started++; };
    uIOhook.stop = () => { uIOhook.stopped++; };
    return { uIOhook, UiohookKey: KEYS };
}

function setup(module = fakeModule()) {
    const sent = [];
    let loads = 0;
    const hook = createPttHook({
        loadModule: () => { loads++; if (module instanceof Error) throw module; return module; },
        send: down => sent.push(down)
    });
    return { hook, sent, module, loads: () => loads };
}

const PTT = { mode: 'ptt', pttKey: 'ControlRight', pttGlobal: true };

test('hookTarget maps the key codes of the window to the codes of the hook', () => {
    assert.deepEqual(hookTarget('KeyA', KEYS), { type: 'key', keycode: 0x1E });
    assert.deepEqual(hookTarget('Digit1', KEYS), { type: 'key', keycode: 0x02 });
    assert.deepEqual(hookTarget('F13', KEYS), { type: 'key', keycode: 0x5B });
    assert.deepEqual(hookTarget('ControlLeft', KEYS), { type: 'key', keycode: 0x1D });
    assert.deepEqual(hookTarget('ControlRight', KEYS), { type: 'key', keycode: 0x0E1D });
    assert.deepEqual(hookTarget('Numpad5', KEYS), { type: 'key', keycode: 0x4C });
    assert.deepEqual(hookTarget('Backquote', KEYS), { type: 'key', keycode: 0x29 });
    assert.deepEqual(hookTarget('MouseMiddle', KEYS), { type: 'mouse', button: 3 });
    assert.deepEqual(hookTarget('MouseBack', KEYS), { type: 'mouse', button: 4 });
    assert.deepEqual(hookTarget('MouseForward', KEYS), { type: 'mouse', button: 5 });
    for (const code of ['F25', 'KeyAA', 'IntlBackslash', 'AudioVolumeUp', '', null]) {
        assert.equal(hookTarget(code, KEYS), null, String(code));
    }
});

test('the hook runs only in voice, in push-to-talk mode, with a key and the global option', () => {
    const { hook, module, loads } = setup();
    hook.configure(PTT);
    assert.equal(module.uIOhook.started, 0, 'not in voice: no hook');
    assert.equal(loads(), 0, 'the native module loads only when it is necessary');
    hook.setInVoice(true);
    assert.equal(module.uIOhook.started, 1);
    assert.equal(hook.status(), 'on');
    hook.configure({ ...PTT, mode: 'voice' });
    assert.equal(module.uIOhook.stopped, 1, 'voice activity mode: the hook stops');
    hook.configure(PTT);
    assert.equal(module.uIOhook.started, 2);
    hook.configure({ ...PTT, pttGlobal: false });
    assert.equal(module.uIOhook.stopped, 2, 'global option off: the hook stops');
    hook.configure(PTT);
    hook.configure({ ...PTT, pttKey: null });
    assert.equal(module.uIOhook.stopped, 3, 'no key: the hook stops');
    hook.configure(PTT);
    hook.setInVoice(false);
    assert.equal(module.uIOhook.stopped, 4, 'leave voice: the hook stops');
    assert.equal(hook.status(), 'off');
    assert.equal(loads(), 1);
});

test('only the push-to-talk key goes to the window, as one down and one up', () => {
    const { hook, sent, module } = setup();
    hook.configure(PTT);
    hook.setInVoice(true);
    const h = module.uIOhook;
    h.emit('keydown', { keycode: KEYS.A });
    h.emit('keyup', { keycode: KEYS.A });
    assert.deepEqual(sent, [], 'other keys do nothing');
    h.emit('keydown', { keycode: KEYS.CtrlRight });
    h.emit('keydown', { keycode: KEYS.CtrlRight });
    h.emit('keydown', { keycode: KEYS.CtrlRight });
    h.emit('keyup', { keycode: KEYS.CtrlRight });
    h.emit('keyup', { keycode: KEYS.CtrlRight });
    assert.deepEqual(sent, [true, false], 'key repeat gives no more events');
    h.emit('mousedown', { button: 4 });
    assert.deepEqual(sent, [true, false], 'a mouse button is not the key');
});

test('a mouse button can be the key', () => {
    const { hook, sent, module } = setup();
    hook.configure({ ...PTT, pttKey: 'MouseBack' });
    hook.setInVoice(true);
    module.uIOhook.emit('keydown', { keycode: KEYS.CtrlRight });
    module.uIOhook.emit('mousedown', { button: 3 });
    module.uIOhook.emit('mousedown', { button: 4 });
    module.uIOhook.emit('mouseup', { button: 4 });
    assert.deepEqual(sent, [true, false]);
});

test('a stop or a key change while the key is down releases the key', () => {
    const { hook, sent, module } = setup();
    hook.configure(PTT);
    hook.setInVoice(true);
    module.uIOhook.emit('keydown', { keycode: KEYS.CtrlRight });
    hook.configure({ ...PTT, pttKey: 'F13' });
    assert.deepEqual(sent, [true, false], 'a new key releases the old key');
    module.uIOhook.emit('keydown', { keycode: KEYS.F13 });
    hook.stop();
    assert.deepEqual(sent, [true, false, true, false]);
    assert.equal(hook.status(), 'off');
});

test('a key that the hook cannot see: no hook, status no-key', () => {
    const { hook, module } = setup();
    hook.configure({ ...PTT, pttKey: 'IntlBackslash' });
    hook.setInVoice(true);
    assert.equal(module.uIOhook.started, 0);
    assert.equal(hook.status(), 'no-key');
});

test('a native module that does not load: status unavailable, no exception', () => {
    const { hook, sent, loads } = setup(new Error('The specified module could not be found.'));
    hook.configure(PTT);
    hook.setInVoice(true);
    assert.equal(hook.status(), 'unavailable');
    hook.configure({ ...PTT, pttKey: 'F13' });
    assert.equal(loads(), 1, 'no second load');
    assert.deepEqual(sent, []);
});
