// Exercise the renderer preference and gallery without an Electron process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom, FakeEvent } from './helpers/fake-dom.mjs';

const source = await readFile(new URL('../src/application/themes.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/application/themes.css', import.meta.url), 'utf8');
const key = 'asscrack.theme.v1';
const crtKey = 'asscrack.crt.v1';

function load(store = new Map()) {
    const { window, document } = createDom([
        { id: 'theme-gallery', tag: 'dialog', children: [{ class: 'theme-grid' }, { id: 'theme-crt', tag: 'input' }] },
        { id: 'view-toggle', tag: 'button' }, { id: 'message-input', tag: 'textarea' },
        { id: 'theme-choice', tag: 'template' }
    ]);
    const dialog = document.getElementById('theme-gallery');
    const grid = dialog.querySelector('.theme-grid');
    const template = document.getElementById('theme-choice');
    template.content = { firstElementChild: { cloneNode() {
        const button = document.createElement('button');
        for (const part of ['theme-preview', 'theme-name']) {
            const span = document.createElement('span');
            span.className = part;
            button.append(span);
        }
        return button;
    } } };
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new FakeEvent('close')); };
    const applied = [];
    window.dispatchEvent = event => {
        if (event.type === 'asscrack-theme-changed') applied.push(document.documentElement.dataset.theme);
    };
    let kept = 0;
    window.reading = { keepPosition(change) { kept++; change(); } };
    const localStorage = { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) };
    vm.runInNewContext(source, { window, document, localStorage, Event: FakeEvent,
        getComputedStyle: () => ({ gridTemplateColumns: '150px 150px 150px' }) });
    return { window, document, dialog, grid, applied, kept: () => kept };
}

test('gallery uses Classic for a new or unknown preference and restores a valid profile choice', () => {
    const store = new Map();
    const first = load(store);
    assert.deepEqual(first.applied, ['aero-classic']);
    assert.equal(first.grid.children[0].getAttribute('aria-pressed'), 'true');
    assert.deepEqual(first.grid.children.map(el => el.querySelector('.theme-name').textContent),
        ['Aero Classic', 'Aero Night', 'Aero Black', 'Aero Midnight', 'Pearl', 'Amber Terminal',
            'Winamp Slate & Amber', 'CRT Phosphor Green', 'Classic mIRC']);
    const draft = first.document.getElementById('message-input');
    draft.value = 'unsent';
    first.window.roomThemes.open(draft);
    assert.equal(first.document.activeElement, first.grid.children[0]);
    first.grid.children[4].click();
    assert.deepEqual(first.applied, ['aero-classic', 'pearl']);
    assert.equal(first.kept(), 1);
    assert.equal(first.dialog.open, false);
    assert.equal(first.document.activeElement, draft);
    assert.equal(draft.value, 'unsent');
    assert.equal(store.get(key), 'pearl');
    assert.equal(first.grid.children.filter(el => el.getAttribute('aria-pressed') === 'true').length, 1);
    const second = load(store);
    assert.equal(second.grid.children[4].getAttribute('aria-pressed'), 'true');
    assert.deepEqual(load(new Map([[key, 'unknown']])).applied, ['aero-classic']);
});

test('gallery keyboard navigation previews all choices and Escape preserves the current palette', () => {
    const { window, document, dialog, grid, applied } = load();
    const opener = document.getElementById('view-toggle');
    window.roomThemes.open(opener);
    for (const [key, index] of [['ArrowDown', 3], ['ArrowLeft', 2], ['ArrowUp', 8], ['ArrowRight', 0]]) {
        document.activeElement.dispatchEvent(new FakeEvent('keydown', { key }));
        assert.equal(document.activeElement, grid.children[index]);
    }
    document.activeElement.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    assert.equal(dialog.open, false);
    assert.deepEqual(applied, ['aero-classic']);
    assert.equal(document.activeElement, opener);
});

test('retro skins apply, persist, and restore across reloads', () => {
    const retro = [
        ['winamp-slate', 6],
        ['crt-phosphor', 7],
        ['classic-mirc', 8]
    ];
    for (const [id, index] of retro) {
        const store = new Map();
        const first = load(store);
        first.window.roomThemes.open();
        first.grid.children[index].click();
        assert.equal(first.document.documentElement.dataset.theme, id);
        assert.equal(store.get(key), id);
        const second = load(store);
        assert.equal(second.document.documentElement.dataset.theme, id);
        assert.equal(second.grid.children[index].getAttribute('aria-pressed'), 'true');
    }
});

test('CRT glow & scanlines toggle defaults to off, persists, and restores', () => {
    const store = new Map();
    const first = load(store);
    const toggle = first.document.getElementById('theme-crt');
    assert.equal(toggle.checked, false);
    assert.equal(first.document.documentElement.dataset.crt, undefined);

    toggle.checked = true;
    toggle.dispatchEvent(new FakeEvent('change'));
    assert.equal(first.document.documentElement.dataset.crt, 'true');
    assert.equal(store.get(crtKey), 'true');

    const second = load(store);
    assert.equal(second.document.documentElement.dataset.crt, 'true');
    assert.equal(second.document.getElementById('theme-crt').checked, true);

    second.window.roomThemes.setCrt(false);
    assert.equal(second.document.documentElement.dataset.crt, undefined);
    assert.equal(store.get(crtKey), 'false');
});

test('CRT overlay uses pointer-events: none and respects reduced motion; retro skins pass WCAG AA contrast', () => {
    const overlayStart = css.indexOf(':root[data-crt="true"] body::after');
    assert.ok(overlayStart >= 0, 'CRT overlay rule exists');
    const overlayBlock = css.slice(overlayStart, css.indexOf('}', overlayStart));
    assert.match(overlayBlock, /pointer-events:\s*none\b/);
    assert.match(css, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[\s\S]*:root\[data-crt="true"\]\s*body::after\s*\{\s*animation:\s*none;/);

    const parseHex = text => text.length === 4 ? [1, 2, 3].map(i => parseInt(text[i] + text[i], 16))
        : [1, 3, 5].map(i => parseInt(text.slice(i, i + 2), 16));
    const luminance = rgb => {
        const [r, g, b] = rgb.map(v => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
        const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (l1 + 0.05) / (l2 + 0.05);
    };

    for (const theme of ['winamp-slate', 'crt-phosphor', 'classic-mirc']) {
        const start = css.indexOf(`[data-theme="${theme}"] {`);
        assert.ok(start >= 0, `palette of ${theme}`);
        const block = css.slice(start, css.indexOf('}', start));
        const vars = {};
        for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/gi)) vars[m[1]] = parseHex(m[2]);
        for (const [fg, bg] of [
            ['--ink', '--chat'],
            ['--ink', '--surface'],
            ['--ink', '--surface-raised'],
            ['--ink-soft', '--surface'],
            ['--frame-ink', '--frame-mid']
        ]) {
            const ratio = contrast(vars[fg], vars[bg]);
            assert.ok(ratio >= 4.5, `${theme} ${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
        }
    }
});
