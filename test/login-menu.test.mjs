// G5 (gap E5): the View menu on the login screen. The menu lines come from the real index.html. layout.js runs in
// the fake DOM of test/helpers/fake-dom.mjs. Electron does not start. All results are 127.0.0.1 results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom } from './helpers/fake-dom.mjs';

const html = await readFile(new URL('../src/application/index.html', import.meta.url), 'utf8');
const layoutSource = await readFile(new URL('../src/application/layout.js', import.meta.url), 'utf8');
// What's new (2026-11-23): the notes line is also a login line (no data-room-only).
const LOGIN_LINES = ['Theme…', 'Sound & notifications…', 'Keyboard shortcuts…', 'About ASSCRACK…', "What's new…",
    'Native title bar', 'Quit'];

// The <li> lines of #view-menu in index.html: { id, attrs, hidden, text }.
function menuLines() {
    const menu = /<ul id="view-menu"[^>]*>([\s\S]*?)<\/ul>/.exec(html)[1];
    return [...menu.matchAll(/<li([^>]*)>([^<]*)<\/li>/g)].map(([, attrs, text]) => ({
        id: /\sid="([^"]+)"/.exec(attrs)?.[1] ?? null,
        attrs: [...attrs.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? '']),
        text: text.replace(/&amp;/g, '&')
    }));
}

function load() {
    const { document, window, Event } = createDom([
        { id: 'chat-body' }, { id: 'buddy-panel' }, { id: 'transfer-panel' }, { id: 'frame-transfers', tag: 'button' },
        { id: 'transfers', tag: 'ul' }, { id: 'map-toggle', tag: 'button' }, { id: 'view-toggle', tag: 'button' },
        { id: 'view-menu', tag: 'ul', hidden: true }
    ]);
    const menu = document.getElementById('view-menu');
    for (const line of menuLines()) {
        const li = document.createElement('li');
        for (const [name, value] of line.attrs) {
            if (name === 'hidden') li.hidden = true;
            else if (name === 'id') li.id = value;
            else li.setAttribute(name, value);
        }
        li.textContent = line.text;
        menu.append(li);
    }
    // The fake DOM has no layout: the transfer list has no boxes.
    document.getElementById('transfers').getClientRects = () => [];
    // window-frame.js shows this line on Windows.
    document.getElementById('view-system-buttons').hidden = false;
    const storage = new Map();
    Object.assign(window, {
        document,
        localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
        requestAnimationFrame: () => 0,
        innerWidth: 800,
        innerHeight: 600
    });
    window.window = window;
    const context = { window, document, console, setTimeout: () => 0, clearTimeout() {},
        MutationObserver: class { observe() {} disconnect() {} } };
    vm.createContext(context);
    vm.runInContext(layoutSource, context, { filename: 'layout.js' });
    const visible = () => menu.children.filter(li => li.getAttribute('role')?.startsWith('menuitem') && !li.hidden)
        .map(li => li.textContent);
    const key = name => {
        const event = new Event('keydown', { key: name });
        menu.dispatchEvent(event);
    };
    return { document, window, menu, visible, key, toggle: document.getElementById('view-toggle') };
}

test('the View menu on the login screen has the seven login lines, and the arrow keys skip the other lines', () => {
    const r = load();
    r.toggle.click();
    assert.equal(r.menu.hidden, false);
    assert.deepEqual(r.visible(), LOGIN_LINES);
    // No separator of a room group shows (no empty rules).
    const rules = r.menu.children.filter(li => li.getAttribute('role') === 'separator' && !li.hidden);
    assert.equal(rules.length, 1);
    // The focus goes through the seven lines only, and back to the first one.
    const seen = [r.document.activeElement.textContent];
    for (let i = 0; i < LOGIN_LINES.length; i++) {
        r.key('ArrowDown');
        seen.push(r.document.activeElement.textContent);
    }
    assert.deepEqual(seen, [...LOGIN_LINES, LOGIN_LINES[0]]);
    r.key('End');
    assert.equal(r.document.activeElement.textContent, 'Quit');
});

test('in a room the View menu shows the room lines again', () => {
    const r = load();
    r.document.body.classList.add('chat');
    r.toggle.click();
    const lines = r.visible();
    for (const text of LOGIN_LINES) assert.ok(lines.includes(text), text);
    for (const text of ['Buddies', 'Pin Transfers', 'Voice controls', 'Compact mode', 'Reset layout', 'Minimize to tray',
        'Close to tray']) assert.ok(lines.includes(text), text);
    assert.ok(!lines.includes('Open Buddies'), 'the drawer line shows only in the drawer mode');
    // Back on the login screen (after Leave room the window reloads; this checks the same rule).
    r.toggle.click();
    r.document.body.classList.remove('chat');
    r.toggle.click();
    assert.deepEqual(r.visible(), LOGIN_LINES);
});
