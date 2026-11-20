// Exercise the renderer preference and gallery without an Electron process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom, FakeEvent } from './helpers/fake-dom.mjs';

const source = await readFile(new URL('../src/application/themes.js', import.meta.url), 'utf8');
const key = 'asscrack.theme.v1';

function load(store = new Map()) {
    const { window, document } = createDom([
        { id: 'theme-gallery', tag: 'dialog', children: [{ class: 'theme-grid' }] },
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
        ['Aero Classic', 'Aero Night', 'Aero Black', 'Aero Midnight', 'Pearl', 'Amber Terminal']);
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
    for (const [key, index] of [['ArrowDown', 3], ['ArrowLeft', 2], ['ArrowUp', 5], ['ArrowRight', 0]]) {
        document.activeElement.dispatchEvent(new FakeEvent('keydown', { key }));
        assert.equal(document.activeElement, grid.children[index]);
    }
    document.activeElement.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    assert.equal(dialog.open, false);
    assert.deepEqual(applied, ['aero-classic']);
    assert.equal(document.activeElement, opener);
});
