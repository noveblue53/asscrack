// The Settings menu (#view-menu) of the real index.html in the fake DOM of fake-dom.mjs, with the real layout.js.
// The menu has nested lists (a group is <li role="none"><span>heading</span><ul role="group">…</ul></li>), thus
// a small tag parser builds the tree. Electron does not start. All results are 127.0.0.1 results.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDom } from './fake-dom.mjs';

const source = await readFile(new URL('../../src/application/index.html', import.meta.url), 'utf8');
export const html = source;
const layoutSource = await readFile(new URL('../../src/application/layout.js', import.meta.url), 'utf8');

function decode(text) {
    return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function attrsOf(source) {
    return [...source.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, decode(value ?? '')]);
}

// The markup inside <ul id="view-menu">, to the </ul> that closes it. The comments go out first (a comment can
// show a tag).
export function menuMarkup() {
    const html = source.replace(/<!--[\s\S]*?-->/g, '');
    const start = /<ul id="view-menu"[^>]*>/.exec(html);
    const tags = /<(\/?)(ul|li|span)\b[^>]*>/g;
    tags.lastIndex = start.index + start[0].length;
    let depth = 1;
    for (let m = tags.exec(html); m; m = tags.exec(html)) {
        if (m[2] !== 'ul') continue;
        depth += m[1] ? -1 : 1;
        if (depth === 0) return { open: start[0], inner: html.slice(start.index + start[0].length, m.index) };
    }
    throw new Error('#view-menu has no end tag');
}

// Build the children of the menu in the fake document.
function buildInto(document, parent, inner) {
    const stack = [parent];
    const re = /<(\/?)(ul|li|span)\b([^>]*)>|([^<]+)|<!--[\s\S]*?-->/g;
    for (const m of inner.matchAll(re)) {
        const top = stack.at(-1);
        if (m[4] !== undefined) {
            const text = decode(m[4]).trim();
            if (text) top.textContent = (top.textContent ?? '') + text;
        } else if (m[2] && m[1]) {
            stack.pop();
        } else if (m[2]) {
            const el = document.createElement(m[2]);
            for (const [name, value] of attrsOf(m[3])) {
                if (name === 'hidden') el.hidden = true;
                else if (name === 'id') el.id = value;
                else if (name === 'class') for (const c of value.split(/\s+/).filter(Boolean)) el.classList.add(c);
                else el.setAttribute(name, value);
            }
            top.append(el);
            stack.push(el);
        }
    }
}

export function loadMenu({ globals = {}, extra = [] } = {}) {
    const { document, window, Event } = createDom([
        { id: 'chat-body' }, { id: 'buddy-panel' }, { id: 'transfer-panel' }, { id: 'frame-transfers', tag: 'button' },
        { id: 'transfers', tag: 'ul' }, { id: 'map-toggle', tag: 'button' }, { id: 'view-toggle', tag: 'button' },
        { id: 'view-menu', tag: 'ul', hidden: true }, ...extra
    ]);
    const menu = document.getElementById('view-menu');
    buildInto(document, menu, menuMarkup().inner);
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
    }, globals);
    window.window = window;
    const context = { window, document, console, setTimeout: () => 0, clearTimeout() {},
        MutationObserver: class { observe() {} disconnect() {} } };
    for (const [name, value] of Object.entries(globals)) context[name] = value;
    vm.createContext(context);
    vm.runInContext(layoutSource, context, { filename: 'layout.js' });
    const items = () => menu.querySelectorAll('[role^="menuitem"]');
    // A line shows when no element from the line up to the menu has the hidden attribute.
    const shows = el => {
        for (let n = el; n && n !== menu; n = n.parentNode) if (n.hidden) return false;
        return true;
    };
    const visible = () => items().filter(shows).map(li => li.textContent);
    const key = (name, init = {}, target = menu) => {
        const event = new Event('keydown', { key: name, ...init });
        target.dispatchEvent(event);
        return event;
    };
    return { document, window, menu, items, shows, visible, key, toggle: document.getElementById('view-toggle') };
}
