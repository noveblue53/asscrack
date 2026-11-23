// The Settings menu of the title bar (until 1.0.5 the View menu): the name, the labeled groups, the lines of 1.0.5
// that must stay reachable, the new lines that open existing dialogs, and Ctrl+, . The menu comes from the real
// index.html, layout.js runs in the fake DOM. Electron does not start. All results are 127.0.0.1 results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { html, menuMarkup, loadMenu } from './helpers/settings-menu.mjs';

const css = await readFile(new URL('../src/application/styles.css', import.meta.url), 'utf8');
const themesCss = await readFile(new URL('../src/application/themes.css', import.meta.url), 'utf8');
const appShell = await readFile(new URL('../src/application/app-shell.js', import.meta.url), 'utf8');

// The lines of the View menu at 1.0.5 (05fa933). Each one must stay in the menu.
const LINES_105 = ['view-buddies', 'view-buddy-drawer', 'view-side', 'view-transfers', 'view-map', 'view-music',
    'view-voice', 'detach-voice', 'view-compact', 'view-typing', 'view-previews', 'view-clear-previews', 'view-theme',
    'view-attention', 'view-shortcuts', 'view-about', 'view-startup', 'view-system-buttons', 'view-reset', 'view-idle',
    'view-close-idle', 'view-quit'];

const GROUPS = [
    ['Appearance', ['view-theme', 'view-compact']],
    ['Layout', ['view-buddies', 'view-buddy-drawer', 'view-side', 'view-transfers', 'view-map', 'view-music', 'view-reset']],
    ['Chat', ['view-previews', 'view-clear-previews']],
    ['Status', ['view-availability', 'view-typing']],
    ['Sound & voice', ['view-attention', 'view-voice-settings', 'view-voice', 'detach-voice']],
    ['System', ['view-startup', 'view-close-idle', 'view-system-buttons', 'view-updates']],
    ['Help', ['view-shortcuts', 'view-diag', 'view-about']]
];

const room = extra => {
    const r = loadMenu(extra);
    r.document.body.classList.add('chat');
    return r;
};

test('the title bar button is Settings, with a gear icon and the key Ctrl+,', () => {
    const button = /<button id="view-toggle"([^>]*)>([^<]*)<\/button>/.exec(html);
    assert.ok(button, '#view-toggle is a button with text only');
    assert.equal(button[2].trim(), 'Settings');
    assert.match(button[1], /aria-haspopup="menu"/);
    assert.match(button[1], /aria-keyshortcuts="Control\+Comma"/);
    assert.match(menuMarkup().open, /role="menu"/);
    assert.match(menuMarkup().open, /aria-labelledby="view-toggle"/);
    // The gear: the default look (a picture) and the themes (a mask in the ink of the label).
    assert.match(css, /#view-toggle::before\s*\{[^}]*icon-gear\.svg/);
    assert.match(themesCss, /#view-toggle\s*\{\s*--glyph:\s*url\('img\/icon-gear\.svg'\)/);
    assert.match(themesCss, /:is\([^)]*#view-toggle[^)]*\)::before/);
    // The shortcuts list has the key.
    assert.match(appShell, /\['Ctrl\+,', 'Settings menu'\]/);
});

test('the menu has the labeled groups in this sequence, and each line of 1.0.5 is still in the menu', () => {
    const r = loadMenu();
    const groups = r.menu.querySelectorAll('[role="group"]');
    const found = groups.map(group => {
        const head = r.document.getElementById(group.getAttribute('aria-labelledby'));
        assert.ok(head, 'the heading of the group exists');
        return [head.textContent, group.querySelectorAll('[role^="menuitem"]').map(li => li.id)];
    });
    assert.deepEqual(found, GROUPS);
    const all = r.items().map(li => li.id);
    for (const id of LINES_105) assert.ok(all.includes(id), id);
    // The window lines: Minimize to tray and Quit, the last lines, after a rule.
    assert.deepEqual(all.slice(-2), ['view-idle', 'view-quit']);
    // No line is twice in the menu.
    assert.equal(new Set(all).size, all.length);
});

test('Ctrl+, opens the Settings menu with the focus on the first line, and closes it again', () => {
    const r = loadMenu();
    const press = () => r.key(',', { ctrlKey: true }, r.document);
    const event = press();
    assert.equal(event.defaultPrevented, true);
    assert.equal(r.menu.hidden, false);
    assert.equal(r.toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(r.document.activeElement.textContent, 'Theme…');
    press();
    assert.equal(r.menu.hidden, true);
    assert.equal(r.document.activeElement, r.toggle);
    // Escape closes it too (the keys of the menu do not change).
    press();
    r.key('Escape');
    assert.equal(r.menu.hidden, true);
    // A comma with no Ctrl, a held key and Ctrl+Shift+, do nothing.
    r.key(',', {}, r.document);
    r.key(',', { ctrlKey: true, repeat: true }, r.document);
    r.key(',', { ctrlKey: true, shiftKey: true }, r.document);
    assert.equal(r.menu.hidden, true);
});

test('Ctrl+, does nothing while a dialog is open', () => {
    const r = loadMenu({ extra: [{ id: 'some-dialog', tag: 'dialog' }] });
    r.document.getElementById('some-dialog').setAttribute('open', '');
    r.key(',', { ctrlKey: true }, r.document);
    assert.equal(r.menu.hidden, true);
});

test('the new lines open the existing dialogs', async () => {
    const calls = [];
    const r = room({
        globals: {
            editAvailability: () => { calls.push('availability'); return true; },
            updatesUi: { refreshAbout() {} },
            appShell: { openAbout: async () => { calls.push('about'); } }
        },
        extra: [{ id: 'voice-settings-toggle', tag: 'button' }, { id: 'join-voice', tag: 'button' }, { id: 'mute', tag: 'button' },
            { id: 'about-update-check', tag: 'button' }, { id: 'about-diag-save', tag: 'button' }]
    });
    const el = id => r.document.getElementById(id);
    el('voice-settings-toggle').setAttribute('aria-expanded', 'false');
    el('voice-settings-toggle').addEventListener('click', () => calls.push('voice'));
    const pick = id => { r.toggle.click(); el(id).click(); };
    pick('view-availability');
    assert.deepEqual(calls, ['availability']);
    assert.equal(r.menu.hidden, true);
    pick('view-voice-settings');
    assert.deepEqual(calls, ['availability', 'voice']);
    pick('view-updates');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.slice(-1), ['about']);
    assert.equal(r.document.activeElement, el('about-update-check'));
    pick('view-diag');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.slice(-1), ['about']);
    assert.equal(r.document.activeElement, el('about-diag-save'));
});

test('Check for updates shows only when the update part of About is there', () => {
    const r = loadMenu();
    r.toggle.click();
    assert.ok(!r.visible().includes('Check for updates…'));
});
