// G5 (gap E2): the room window keeps its size and position. fitWindowBounds is pure; the file functions use a
// temporary profile folder. Electron does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitWindowBounds, MIN_WINDOW, readWindowBounds, saveWindowBounds, WINDOW_BOUNDS_FILE } from '../src/application/window-bounds.mjs';

const MAIN = { x: 0, y: 0, width: 1920, height: 1040 };

function profile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-bounds-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('a saved window on a display that is gone comes back into the work area of the nearest display', () => {
    // The window was on a second display to the right (x 2200). The nearest display is now the main display.
    const fitted = fitWindowBounds({ x: 2200, y: 300, width: 900, height: 700, maximized: false }, MAIN);
    assert.deepEqual(fitted, { x: 1920 - 900, y: 300, width: 900, height: 700, maximized: false });
    // A display above and to the left (negative coordinates) that is gone.
    const above = fitWindowBounds({ x: -1500, y: -900, width: 800, height: 600, maximized: true }, MAIN);
    assert.deepEqual(above, { x: 0, y: 0, width: 800, height: 600, maximized: true });
});

test('a size below the minimum grows, a size above the work area shrinks', () => {
    const small = fitWindowBounds({ x: 100, y: 100, width: 300, height: 200 }, MAIN);
    assert.equal(small.width, MIN_WINDOW.width);
    assert.equal(small.height, MIN_WINDOW.height);
    assert.deepEqual(MIN_WINDOW, { width: 560, height: 480 });
    const large = fitWindowBounds({ x: 100, y: 100, width: 4000, height: 3000 }, MAIN);
    assert.deepEqual(large, { x: 0, y: 0, width: 1920, height: 1040, maximized: false });
});

test('a missing or bad file gives 800 x 600 in the middle of the main display', t => {
    const dir = profile(t);
    assert.equal(readWindowBounds(dir), null, 'missing file');
    for (const text of ['not json', '{"x":1}', '{"x":"1","y":2,"width":800,"height":600}', 'null',
        '{"x":0,"y":0,"width":-5,"height":600}', '{"x":0.5,"y":0,"width":800,"height":600}']) {
        fs.writeFileSync(path.join(dir, WINDOW_BOUNDS_FILE), text);
        assert.equal(readWindowBounds(dir), null, text);
    }
    assert.deepEqual(fitWindowBounds(null, MAIN), { x: 560, y: 220, width: 800, height: 600, maximized: false });
    // The work area of the main display does not start at 0 (a taskbar at the top or the left).
    assert.deepEqual(fitWindowBounds(null, { x: 0, y: 40, width: 1280, height: 760 }),
        { x: 240, y: 120, width: 800, height: 600, maximized: false });
});

test('the saved bounds come back the same after a save and a read', t => {
    const dir = profile(t);
    saveWindowBounds(dir, { x: 120, y: 80, width: 1000, height: 720, maximized: true });
    assert.deepEqual(readWindowBounds(dir), { x: 120, y: 80, width: 1000, height: 720, maximized: true });
    assert.deepEqual(fitWindowBounds(readWindowBounds(dir), MAIN), { x: 120, y: 80, width: 1000, height: 720, maximized: true });
    assert.equal(fs.existsSync(path.join(dir, WINDOW_BOUNDS_FILE + '.tmp')), false);
});
