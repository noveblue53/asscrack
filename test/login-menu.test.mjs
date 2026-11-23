// G5 (gap E5): the Settings menu (until 1.0.5 the View menu) on the login screen. The menu lines come from the real
// index.html (test/helpers/settings-menu.mjs). layout.js runs in the fake DOM of test/helpers/fake-dom.mjs. Electron
// does not start. All results are 127.0.0.1 results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMenu } from './helpers/settings-menu.mjs';

// window.updatesUi (updates-ui.js) is there in the app: the line "Check for updates…" shows.
const APP = { globals: { updatesUi: { refreshAbout() {} } } };
const LOGIN_LINES = ['Theme…', 'Sound & notifications…', 'Native title bar', 'Check for updates…',
    'Keyboard shortcuts…', 'Save diagnostics…', 'About ASSCRACK…', 'Quit'];

test('the Settings menu on the login screen has the login lines, and the arrow keys skip the other lines', () => {
    const r = loadMenu(APP);
    r.toggle.click();
    assert.equal(r.menu.hidden, false);
    assert.deepEqual(r.visible(), LOGIN_LINES);
    // A group with no visible line is hidden (no empty heading).
    for (const group of r.menu.querySelectorAll('[role="group"]')) {
        const lines = group.querySelectorAll('[role^="menuitem"]').filter(r.shows);
        assert.equal(r.shows(group), lines.length > 0, group.getAttribute('aria-labelledby'));
    }
    // The focus goes through the login lines only, and back to the first one.
    const seen = [r.document.activeElement.textContent];
    for (let i = 0; i < LOGIN_LINES.length; i++) {
        r.key('ArrowDown');
        seen.push(r.document.activeElement.textContent);
    }
    assert.deepEqual(seen, [...LOGIN_LINES, LOGIN_LINES[0]]);
    r.key('End');
    assert.equal(r.document.activeElement.textContent, 'Quit');
});

test('in a room the Settings menu shows the room lines again', () => {
    const r = loadMenu(APP);
    r.document.body.classList.add('chat');
    r.toggle.click();
    const lines = r.visible();
    for (const text of LOGIN_LINES) assert.ok(lines.includes(text), text);
    for (const text of ['Buddies', 'Pin Transfers', 'Voice controls', 'Compact mode', 'Reset layout', 'Minimize to tray',
        'Close to tray', 'Availability…', 'Voice settings…']) assert.ok(lines.includes(text), text);
    assert.ok(!lines.includes('Open Buddies'), 'the drawer line shows only in the drawer mode');
    // Back on the login screen (after Leave room the window reloads; this checks the same rule).
    r.toggle.click();
    r.document.body.classList.remove('chat');
    r.toggle.click();
    assert.deepEqual(r.visible(), LOGIN_LINES);
});
