// Gap E2: the room window keeps its size, its position and its maximized state between runs.
// The file window-bounds.json in the profile has { x, y, width, height, maximized }, from getNormalBounds().
// All values are device-independent pixels, the same as the Electron screen API.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const WINDOW_BOUNDS_FILE = 'window-bounds.json';
export const MIN_WINDOW = Object.freeze({ width: 560, height: 480 });
export const DEFAULT_WINDOW = Object.freeze({ width: 800, height: 600 });

const coordinate = n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
const size = n => Number.isInteger(n) && n > 0 && n <= 100000;

// The saved bounds, or null for a missing or bad file. file: 1.0.1, the friends window has its own file.
export function readWindowBounds(profile, file = WINDOW_BOUNDS_FILE) {
    try {
        const value = JSON.parse(readFileSync(path.join(profile, file), 'utf8'));
        if (!value || !coordinate(value.x) || !coordinate(value.y) || !size(value.width) || !size(value.height)) return null;
        return { x: value.x, y: value.y, width: value.width, height: value.height, maximized: value.maximized === true };
    } catch {
        return null;
    }
}

export function saveWindowBounds(profile, bounds, name = WINDOW_BOUNDS_FILE) {
    const file = path.join(profile, name);
    const value = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width),
        height: Math.round(bounds.height), maximized: bounds.maximized === true };
    writeFileSync(file + '.tmp', JSON.stringify(value));
    renameSync(file + '.tmp', file);
}

// The method of fitVoiceBounds (voice-monitor.mjs). saved: the saved bounds or null. area: the work area of the
// display nearest to the saved bounds (for null: of the main display). min: the minimum window size.
// A size below the minimum grows, a size above the work area shrinks, and the window moves into the work area.
// With no saved bounds: 800 x 600 (or the size fallback) in the middle of the area.
export function fitWindowBounds(saved, area, min = MIN_WINDOW, fallback = DEFAULT_WINDOW) {
    const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
    const valid = saved && coordinate(saved.x) && coordinate(saved.y) && size(saved.width) && size(saved.height);
    const width = Math.min(area.width, Math.max(min.width, valid ? saved.width : fallback.width));
    const height = Math.min(area.height, Math.max(min.height, valid ? saved.height : fallback.height));
    const x = valid ? saved.x : area.x + Math.round((area.width - width) / 2);
    const y = valid ? saved.y : area.y + Math.round((area.height - height) / 2);
    return {
        x: clamp(x, area.x, area.x + area.width - width),
        y: clamp(y, area.y, area.y + area.height - height),
        width, height,
        maximized: valid ? saved.maximized === true : false
    };
}
