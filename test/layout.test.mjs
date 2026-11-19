// Tests of the pure layout functions in src/application/layout.js. Electron does not start.
// layout.js is a classic script: it runs in a node:vm context with a minimal window, document and localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/application/layout.js', import.meta.url), 'utf8');
const KEY = 'asscrack.layout.v1';

function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
        data,
    };
}

// Load layout.js. The console records each call: unavailable storage must not write to the console.
function load(storage = memoryStorage()) {
    const calls = [];
    const record = name => (...args) => calls.push([name, ...args]);
    const context = {
        console: { log: record('log'), warn: record('warn'), error: record('error'), info: record('info') },
        document: { getElementById: () => null },
        localStorage: storage,
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'layout.js' });
    return { core: context.window.layoutCore, window: context.window, calls };
}

// Objects from the vm context have another Object.prototype. Compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

const DEFAULTS = {
    version: 1,
    buddyWidth: null,
    buddySide: 'left',
    buddiesShown: true,
    mapWidth: null,
    transferHeight: null,
    transfersShown: true,
};

// The composer and Send stay inside the viewport: the bands (with the composer), the minimum chat body and the
// list fit the height. When the bands and the chat minimum alone do not fit, the list gets no height.
function assertComposerRoom(core, eff, height) {
    assert.ok(eff.transferHeight >= 0);
    assert.ok(eff.transferHeight <= Math.max(0, height - eff.transferReserve),
        `transfer ${eff.transferHeight} + reserve ${eff.transferReserve} > ${height}`);
    assert.ok(eff.transferReserve >= core.CHAT_MIN_H);
}

test('layout.js installs layoutCore and a stub layout API without a room window', () => {
    const { core, window, calls } = load();
    assert.equal(typeof core.effectiveLayout, 'function');
    assert.equal(window.layout.closeTopLayer(), false);
    assert.equal(window.layout.isDrawerOpen(), false);
    assert.equal(core.KEY, KEY);
    assert.deepEqual(calls, []);
});

test('no stored value gives the defaults', () => {
    const { core } = load();
    assert.deepEqual(plain(core.readPref({ localStorage: memoryStorage() })), DEFAULTS);
    assert.deepEqual(plain(core.readPref({})), DEFAULTS);
});

test('malformed JSON gives the defaults', () => {
    const { core, calls } = load();
    for (const text of ['{', 'not json', '', '[]', 'null', '42', '"text"', '{"version":1,']) {
        const host = { localStorage: memoryStorage({ [KEY]: text }) };
        assert.deepEqual(plain(core.readPref(host)), DEFAULTS, text);
    }
    assert.deepEqual(calls, []);
});

test('another version gives the defaults', () => {
    const { core } = load();
    for (const version of [undefined, 0, 2, '1']) {
        const pref = core.validatePref({ version, buddyWidth: 300, buddySide: 'right' });
        assert.deepEqual(plain(pref), DEFAULTS, String(version));
    }
});

test('wrong types recover field by field', () => {
    const { core } = load();
    const text = JSON.stringify({
        version: 1,
        buddyWidth: '300',
        buddySide: 'right',
        buddiesShown: 'no',
        mapWidth: 400,
        transferHeight: [120],
        transfersShown: false,
    });
    const pref = core.readPref({ localStorage: memoryStorage({ [KEY]: text }) });
    assert.deepEqual(plain(pref), {
        version: 1,
        buddyWidth: null,
        buddySide: 'right',
        buddiesShown: true,
        mapWidth: 400,
        transferHeight: null,
        transfersShown: false,
    });
});

test('NaN and Infinity give the default of the field', () => {
    const { core } = load();
    const pref = core.validatePref({ version: 1, buddyWidth: NaN, mapWidth: Infinity, transferHeight: -Infinity });
    assert.deepEqual(plain(pref), DEFAULTS);
    // JSON.parse gives Infinity for 1e999.
    const host = { localStorage: memoryStorage({ [KEY]: '{"version":1,"buddyWidth":1e999,"mapWidth":350}' }) };
    const read = core.readPref(host);
    assert.equal(read.buddyWidth, null);
    assert.equal(read.mapWidth, 350);
});

test('an unknown side gives the left side', () => {
    const { core } = load();
    for (const side of ['top', 'LEFT', '', null, 1]) {
        assert.equal(core.validatePref({ version: 1, buddySide: side }).buddySide, 'left', String(side));
    }
    assert.equal(core.validatePref({ version: 1, buddySide: 'right' }).buddySide, 'right');
});

test('missing fields get their defaults, the other fields stay', () => {
    const { core } = load();
    const pref = core.parsePref('{"version":1,"buddyWidth":250}');
    assert.deepEqual(plain(pref), { ...DEFAULTS, buddyWidth: 250 });
});

test('a size out of the absolute limits is clamped and rounded', () => {
    const { core } = load();
    const pref = core.validatePref({ version: 1, buddyWidth: 5, mapWidth: 99999, transferHeight: 100.6 });
    assert.equal(pref.buddyWidth, core.LIMITS.buddyWidth.min);
    assert.equal(pref.mapWidth, core.LIMITS.mapWidth.max);
    assert.equal(pref.transferHeight, 101);
});

test('storage that throws gives the defaults and no console output', () => {
    const { core, calls } = load();
    const getterThrows = {};
    Object.defineProperty(getterThrows, 'localStorage', {
        get() { throw new Error('SecurityError: storage is not available'); },
    });
    const methodsThrow = {
        localStorage: {
            getItem() { throw new Error('getItem failed'); },
            setItem() { throw new Error('QuotaExceededError'); },
        },
    };
    assert.deepEqual(plain(core.readPref(getterThrows)), DEFAULTS);
    assert.deepEqual(plain(core.readPref(methodsThrow)), DEFAULTS);
    assert.equal(core.writePref(getterThrows, core.defaultPref()), false);
    assert.equal(core.writePref(methodsThrow, core.defaultPref()), false);
    assert.deepEqual(calls, []);
});

test('layout.js loads with a throwing localStorage getter and makes no console output', () => {
    const calls = [];
    const record = name => (...args) => calls.push([name, ...args]);
    const context = {
        console: { log: record('log'), warn: record('warn'), error: record('error') },
        document: { getElementById: () => null },
    };
    Object.defineProperty(context, 'localStorage', { get() { throw new Error('denied'); } });
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context);
    assert.equal(typeof context.window.layoutCore.readPref, 'function');
    assert.deepEqual(plain(context.window.layoutCore.readPref(context.window)), DEFAULTS);
    assert.deepEqual(calls, []);
});

test('write and read give the same preference', () => {
    const { core } = load();
    const host = { localStorage: memoryStorage() };
    const pref = { ...DEFAULTS, buddyWidth: 260, buddySide: 'right', mapWidth: 420, transferHeight: 180, transfersShown: false };
    assert.equal(core.writePref(host, pref), true);
    assert.deepEqual(plain(core.readPref(host)), pref);
    assert.deepEqual(plain(JSON.parse(host.localStorage.getItem(KEY))), pref);
});

test('the responsive defaults are the old breakpoints', () => {
    const { core } = load();
    assert.equal(core.responsiveDefaults(560, 480).buddyWidth, 148);
    assert.equal(core.responsiveDefaults(600, 480).buddyWidth, 148);
    assert.equal(core.responsiveDefaults(800, 600).buddyWidth, 192);
    assert.equal(core.responsiveDefaults(1099, 600).buddyWidth, 192);
    assert.equal(core.responsiveDefaults(1280, 800).buddyWidth, 236);
    assert.equal(core.responsiveDefaults(800, 600).transferHeight, 90);
    assert.equal(core.responsiveDefaults(800, 700).transferHeight, 150);
    assert.equal(core.responsiveDefaults(800, 900).transferHeight, 210);
    // 36 % of the chat body (1280 - 2 x 6), between 320 and 500.
    assert.equal(core.responsiveDefaults(1280, 800).mapWidth, 456);
    assert.equal(core.responsiveDefaults(1000, 800).mapWidth, 356);
    assert.equal(core.responsiveDefaults(2000, 800).mapWidth, 500);
});

test('clamp at 1280 x 800: defaults, docked map and requested sizes', () => {
    const { core } = load();
    const view = { width: 1280, height: 800, chromeH: 220, mapOpen: true };
    const eff = core.effectiveLayout(core.defaultPref(), view);
    assert.equal(eff.buddyMode, 'docked');
    assert.equal(eff.buddyWidth, 236);
    assert.equal(eff.mapDocked, true);
    assert.equal(eff.mapWidth, 456);
    assert.equal(eff.transferHeight, 150);
    assert.equal(eff.transferSet, false);
    assertComposerRoom(core, eff, view.height);
    // The chat column keeps its minimum width.
    const chatW = view.width - 2 * core.PAD - eff.buddyWidth - eff.mapWidth - 2 * core.PAD;
    assert.ok(chatW >= core.CHAT_MIN_W);

    // Saved sizes that fit come back exactly.
    const saved = { ...DEFAULTS, buddyWidth: 300, mapWidth: 400, transferHeight: 200 };
    const back = core.effectiveLayout(saved, view);
    assert.equal(back.buddyWidth, 300);
    assert.equal(back.mapWidth, 400);
    assert.equal(back.transferHeight, 200);
    assert.equal(back.transferSet, true);

    // Too large requested sizes: the map shrinks first, Buddies keeps room for the chat, Transfers keeps the composer.
    const big = { ...DEFAULTS, buddyWidth: 480, mapWidth: 900, transferHeight: 800 };
    const clamped = core.effectiveLayout(big, view);
    assert.equal(clamped.mapWidth, clamped.mapMax);
    assert.ok(clamped.buddyWidth <= clamped.buddyMax);
    assert.ok(view.width - 2 * core.PAD - clamped.buddyWidth - clamped.mapWidth - 2 * core.PAD >= core.CHAT_MIN_W);
    assert.equal(clamped.transferHeight, 800 - 220 - core.CHAT_MIN_H);
    assertComposerRoom(core, clamped, view.height);
});

test('clamp at 800 x 600: the map is an overlay and the composer keeps its room', () => {
    const { core } = load();
    for (const view of [
        { width: 800, height: 600, chromeH: 220, mapOpen: true },
        { width: 784, height: 561, chromeH: 220, mapOpen: true },  // The content size of the 800 x 600 window.
        { width: 784, height: 561, chromeH: 300, mapOpen: true },  // A wrapped tool band.
    ]) {
        const eff = core.effectiveLayout(core.defaultPref(), view);
        assert.equal(eff.mapDocked, false);
        assert.equal(eff.buddyMode, 'docked');
        assert.equal(eff.buddyWidth, 192);
        assertComposerRoom(core, eff, view.height);
        const full = core.effectiveLayout({ ...DEFAULTS, transferHeight: 800, buddyWidth: 480 }, view);
        assertComposerRoom(core, full, view.height);
        assert.ok(view.width - 2 * core.PAD - full.buddyWidth - core.PAD >= core.CHAT_MIN_W);
    }
});

test('clamp at 560 x 480: the composer keeps its room, also with a full transfer list', () => {
    const { core } = load();
    for (const chromeH of [220, 260, 340, 420]) {
        const view = { width: 560, height: 480, chromeH, mapOpen: true };
        const eff = core.effectiveLayout(core.defaultPref(), view);
        assert.equal(eff.mapDocked, false);
        assert.equal(eff.buddyMode, 'docked');
        assert.equal(eff.buddyWidth, 148);
        assertComposerRoom(core, eff, view.height);
        const full = core.effectiveLayout({ ...DEFAULTS, transferHeight: 800 }, view);
        assertComposerRoom(core, full, view.height);
        assert.ok(full.transferMin <= full.transferMax);
    }
});

test('a window too narrow for Buddies and the chat gives the Buddies drawer', () => {
    const { core } = load();
    const eff = core.effectiveLayout(core.defaultPref(), { width: 400, height: 480, chromeH: 220 });
    assert.equal(eff.buddyMode, 'drawer');
    assert.ok(eff.buddyWidth >= core.LIMITS.buddyWidth.min);
    const hidden = core.effectiveLayout({ ...DEFAULTS, buddiesShown: false }, { width: 400, height: 480 });
    assert.equal(hidden.buddyMode, 'hidden');
});

test('a narrow viewport does not change the requested values, and the wide layout comes back', () => {
    const { core } = load();
    const wide = { width: 1280, height: 800, chromeH: 220, mapOpen: true };
    const pref = Object.freeze({ ...DEFAULTS, buddyWidth: 300, buddySide: 'right', mapWidth: 420, transferHeight: 260 });
    const before = plain(pref);
    for (const view of [
        { width: 560, height: 480, chromeH: 220, mapOpen: true },
        { width: 400, height: 300, chromeH: 260, mapOpen: true },
        { width: 0, height: 0 },
        { width: NaN, height: Infinity, chromeH: NaN },
    ]) {
        const eff = core.effectiveLayout(pref, view);
        assert.ok(Number.isFinite(eff.buddyWidth) && Number.isFinite(eff.transferHeight) && Number.isFinite(eff.mapWidth));
    }
    assert.deepEqual(plain(pref), before);
    const back = core.effectiveLayout(pref, wide);
    assert.equal(back.buddyWidth, 300);
    assert.equal(back.buddySide, 'right');
    assert.equal(back.mapWidth, 420);
    assert.equal(back.transferHeight, 260);
});

test('withSize clamps to the given limits and does not change the input', () => {
    const { core } = load();
    const pref = Object.freeze(core.defaultPref());
    const next = core.withSize(pref, 'buddyWidth', 1000, 120, 300);
    assert.equal(next.buddyWidth, 300);
    assert.equal(pref.buddyWidth, null);
    assert.equal(core.withSize(pref, 'transferHeight', 10, 32, 200).transferHeight, 32);
    assert.equal(core.withSize(pref, 'mapWidth', 333.4).mapWidth, 333);
    assert.equal(core.withSize(pref, 'mapWidth', NaN).mapWidth, null);
});

test('keyDelta: arrow steps and Shift steps', () => {
    const { core } = load();
    assert.equal(core.keyDelta('ArrowRight', false, ['ArrowRight'], ['ArrowLeft']), core.STEP);
    assert.equal(core.keyDelta('ArrowLeft', false, ['ArrowRight'], ['ArrowLeft']), -core.STEP);
    assert.equal(core.keyDelta('ArrowRight', true, ['ArrowRight'], ['ArrowLeft']), core.BIG_STEP);
    assert.equal(core.keyDelta('a', false, ['ArrowRight'], ['ArrowLeft']), 0);
});

test('the default preference is the reset state', () => {
    const { core } = load();
    assert.deepEqual(plain(core.defaultPref()), DEFAULTS);
    assert.notEqual(core.defaultPref(), core.defaultPref());
});
