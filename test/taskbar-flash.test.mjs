// G5 (gap E1): the taskbar flash and the overlay dot. A fake window records each flashFrame and setOverlayIcon call
// (a spy in place of the Electron BrowserWindow). Electron does not start. The look on the real taskbar is for the
// operator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTaskbarFlash } from '../src/application/taskbar-flash.mjs';
import { overlayDotBitmap } from '../src/application/attention.mjs';

function setup({ focused = false, minimized = false, visible = true, allowed = true, enabled = true } = {}) {
    const win = Object.assign(new EventEmitter(), {
        state: { focused, minimized, visible, destroyed: false },
        calls: [],
        isFocused() { return this.state.focused; },
        isMinimized() { return this.state.minimized; },
        isVisible() { return this.state.visible; },
        isDestroyed() { return this.state.destroyed; },
        flashFrame(on) { this.calls.push(['flashFrame', on]); },
        setOverlayIcon(image, text) { this.calls.push(['setOverlayIcon', image, text]); }
    });
    const flags = { allowed, enabled };
    const logs = [];
    const flash = createTaskbarFlash({ getWindow: () => win, allowed: () => flags.allowed, enabled: () => flags.enabled,
        makeDot: () => 'dot', log: (level, text) => logs.push(`${level} ${text}`) });
    flash.attach(win);
    return { win, flash, flags, logs };
}

test('a window with no focus flashes with the dot; the focus ends the flash and removes the dot', () => {
    const { win, flash, logs } = setup();
    assert.equal(flash.start(), true);
    assert.equal(flash.start(), true, 'a second mention flashes again');
    assert.deepEqual(win.calls, [['flashFrame', true], ['setOverlayIcon', 'dot', 'New mention or private message'],
        ['flashFrame', true], ['setOverlayIcon', 'dot', 'New mention or private message']]);
    assert.deepEqual(logs, ['EVENT attention flash on'], 'one "on" line for a burst');
    win.calls.length = 0;
    win.state.focused = true;
    win.emit('focus');
    assert.deepEqual(win.calls, [['flashFrame', false], ['setOverlayIcon', null, '']]);
    assert.deepEqual(logs, ['EVENT attention flash on', 'EVENT attention flash off']);
    win.emit('focus');
    assert.equal(logs.length, 2, 'no "off" line with no flash');
});

test('a minimized window that Windows still reports as focused flashes; the restore ends the flash', () => {
    const { win, flash, logs } = setup({ focused: true, minimized: true });
    assert.equal(flash.start(), true);
    win.state.minimized = false;
    win.emit('restore');
    assert.deepEqual(logs, ['EVENT attention flash on', 'EVENT attention flash off']);
    assert.deepEqual(win.calls.at(-2), ['flashFrame', false]);
});

test('no flash: a window in focus, Idle Peer or a quit (not allowed), and the setting off', () => {
    for (const options of [{ focused: true }, { allowed: false }, { enabled: false }]) {
        const { win, flash, logs } = setup(options);
        assert.equal(flash.start(), false, JSON.stringify(options));
        assert.deepEqual(win.calls, []);
        assert.deepEqual(logs, []);
    }
    // A hidden window (not Idle Peer) has no focus: it flashes.
    assert.equal(setup({ focused: true, visible: false }).flash.start(), true);
});

test('the overlay dot is a 16 x 16 BGRA bitmap with a clear edge and an opaque middle', () => {
    const dot = overlayDotBitmap();
    assert.equal(dot.width, 16);
    assert.equal(dot.height, 16);
    assert.equal(dot.buffer.length, 16 * 16 * 4);
    const alpha = (x, y) => dot.buffer[(y * 16 + x) * 4 + 3];
    assert.equal(alpha(0, 0), 0);
    assert.equal(alpha(8, 8), 255);
});
