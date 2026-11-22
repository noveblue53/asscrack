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

// P8b (goal prompt, the overlay rule): one overlay slot. A share on: the share overlay; else a pending attention:
// the dot; else none. A focus clears only the dot state.
test('the share overlay has the slot while a share is on; after the stop the pending dot comes back', () => {
    const win = Object.assign(new EventEmitter(), {
        state: { focused: false, minimized: false, visible: true, destroyed: false }, calls: [],
        isFocused() { return this.state.focused; }, isMinimized() { return this.state.minimized; },
        isVisible() { return this.state.visible; }, isDestroyed() { return this.state.destroyed; },
        flashFrame(on) { this.calls.push(['flashFrame', on]); },
        setOverlayIcon(image, text) { this.calls.push(['setOverlayIcon', image, text]); }
    });
    const flash = createTaskbarFlash({ getWindow: () => win, allowed: () => true, enabled: () => true,
        makeDot: () => 'dot', makeShare: () => 'share', log: () => {} });
    flash.attach(win);
    const overlay = () => win.calls.filter(c => c[0] === 'setOverlayIcon').at(-1);
    flash.setSharing(true);
    assert.deepEqual(overlay(), ['setOverlayIcon', 'share', 'Sharing your screen']);
    // A mention while the share is on: the window flashes, and the overlay stays the share overlay.
    assert.equal(flash.start(), true);
    assert.deepEqual(overlay(), ['setOverlayIcon', 'share', 'Sharing your screen']);
    assert.equal(flash.isFlashing(), true);
    // Stop sharing: the pending dot shows.
    flash.setSharing(false);
    assert.deepEqual(overlay(), ['setOverlayIcon', 'dot', 'New mention or private message']);
    // A share again, then the focus: the focus clears only the dot state; the share overlay stays.
    flash.setSharing(true);
    win.state.focused = true;
    win.emit('focus');
    assert.equal(flash.isFlashing(), false);
    assert.deepEqual(overlay(), ['setOverlayIcon', 'share', 'Sharing your screen']);
    flash.setSharing(false);
    assert.deepEqual(overlay(), ['setOverlayIcon', null, ''], 'no share and no attention: no overlay');
    const before = win.calls.length;
    flash.setSharing(false);
    assert.equal(win.calls.length, before, 'no change: no call');
});

test('the share overlay is a 16 x 16 BGRA bitmap, different from the dot', async () => {
    const { overlayShareBitmap } = await import('../src/application/attention.mjs');
    const disc = overlayShareBitmap();
    assert.equal(disc.width, 16);
    assert.equal(disc.buffer.length, 16 * 16 * 4);
    assert.equal(disc.buffer[3], 0, 'a clear corner');
    assert.notDeepEqual(disc.buffer, overlayDotBitmap().buffer);
});
