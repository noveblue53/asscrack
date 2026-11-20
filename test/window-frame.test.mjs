import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWindowFrame } from '../src/application/window-frame.mjs';

function attach(frame) {
    const calls = [], handlers = new Map();
    const win = new EventEmitter();
    let maximized = false;
    Object.assign(win, {
        webContents: { mainFrame: {}, send: (_channel, data) => calls.push(data.maximized) },
        isMaximized: () => maximized,
        maximize() { maximized = true; win.emit('maximize'); },
        unmaximize() { maximized = false; win.emit('unmaximize'); },
        minimize: () => calls.push('minimize'),
        close: () => calls.push('close'),
        setTitleBarOverlay: paint => calls.push(paint)
    });
    frame.attach(win, {
        handle(name, fn) { handlers.set(name, fn); },
        removeHandler(name) { handlers.delete(name); }
    });
    return {
        calls, handlers, win,
        action(name, ...args) {
            return handlers.get('asscrack:frame-' + name)({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args);
        }
    };
}

test('Windows frame forwards genuine window actions and remembers the native overlay for the next launch', async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'frame-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const glass = createWindowFrame(dir, 'win32');
    assert.deepEqual(glass.options, { frame: false });
    const ui = attach(glass);
    ui.action('action', 'maximize');
    ui.action('action', 'maximize');
    ui.action('action', 'minimize');
    ui.action('action', 'close');
    assert.deepEqual(ui.calls, [true, false, 'minimize', 'close']);
    assert.throws(() => ui.handlers.get('asscrack:frame-action')({sender: ui.win.webContents, senderFrame: {}}, 'close'));
    assert.equal(ui.action('system', true).mode, 'glass');
    ui.win.emit('closed');
    assert.equal(ui.handlers.size, 0);

    const overlay = createWindowFrame(dir, 'win32');
    assert.equal(overlay.options.titleBarStyle, 'hidden');
    assert.ok(overlay.options.titleBarOverlay);
    const native = attach(overlay);
    native.action('colors', '#253847', '#fff');
    native.action('colors', 'invalid', '#ffffff');
    assert.deepEqual(native.calls, [{ color: '#253847', symbolColor: '#ffffff', height: 36 }]);
    native.action('system', false);
    assert.deepEqual(createWindowFrame(dir, 'win32').options, glass.options);
    assert.equal(attach(createWindowFrame(dir, 'linux')).action('state').canChooseSystemButtons, false);
});
