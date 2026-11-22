// The one Escape dispatcher of renderer.js, with the real scripts in the fake DOM (test/helpers/renderer-fixture.mjs).
// Each Escape closes only the top layer, in this sequence: the context menu, the layout layer (View menu, drawer), a
// focused whisper pane, the find bar, the quote chip (only with the focus in the composer), the voice settings, the
// invite panel, the map. These tests replace the source-text checks of the sequence in test/app-events.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow } from './helpers/renderer-fixture.mjs';

const PEER = '12D3KooWsamAAAAAAaaaa01';
const LAYERS = ['menu', 'layout', 'whisper', 'find', 'quote', 'voice', 'invite', 'map'];

// A room with all the layers open. layout.js, whispers.js and the voice panel do not load in the fixture: small stubs
// with an open flag take their place. The dispatcher reads window.layout, window.whispers and window.voicePanel when
// the key comes, thus a stub that the test sets after the load is used.
async function roomWithLayers() {
    const f = await loadRoomWindow({ elements: [
        { id: 'whisper-pane', children: [{ id: 'whisper-input', tag: 'input' }] },
        { id: 'voice-settings' }, { id: 'voice-settings-toggle', tag: 'button' }, { id: 'view-toggle', tag: 'button' }
    ] });
    await f.login('Me');
    f.handlers.onPeerJoined({ peerId: PEER });
    f.handlers.onPeerName({ peerId: PEER, name: 'Sam' });
    const row = f.receive({ from: 'Sam', text: 'hello', peerId: PEER, id: 'a1' });
    const stub = { layout: false, whisper: false, voice: false };
    f.window.layout = { closeTopLayer: () => (stub.layout ? !(stub.layout = false) : false) };
    f.window.whispers = { isOpen: () => stub.whisper, close: () => { stub.whisper = false; } };
    f.window.voicePanel = { isOpen: () => stub.voice, close: () => { stub.voice = false; } };

    const open = () => ({
        menu: f.window.contextMenu.isOpen(),
        layout: stub.layout,
        whisper: stub.whisper,
        find: f.window.findBar.isOpen(),
        quote: !f.el('quote-chip').hidden,
        voice: stub.voice,
        invite: !f.el('invite-panel').hidden,
        map: f.document.body.classList.contains('map-open')
    });
    // Open the layers with the controls of the window. The find bar does not open while a whisper pane is open.
    f.el('map-toggle').click();
    f.el('invite-panel').hidden = true; // As in index.html: the panel starts closed.
    f.el('invite-toggle').click();
    row.querySelector('.btn-quote').click();
    f.el('find-input').select = () => {}; // The fixture has no native text selection.
    assert.equal(f.window.findBar.open(), true);
    assert.equal(f.window.contextMenu.open(row, row), true);
    Object.assign(stub, { layout: true, whisper: true, voice: true });
    return { f, row, stub, open };
}

// Press Escape on the focused element. The event goes up to the document listener.
function escape(f, focus) {
    if (focus) focus.focus();
    return f.key(f.document.activeElement ?? f.document.body, 'Escape');
}

test('each Escape closes only the top layer, in the sequence of the dispatcher', async () => {
    const { f, open } = await roomWithLayers();
    assert.deepEqual(Object.values(open()), LAYERS.map(() => true), 'all the layers are open at the start');
    f.el('message-input').value = 'my draft';
    // The focus for each press: the whisper pane closes only with the focus in it, the quote chip only with the focus
    // in the composer.
    const focus = { whisper: f.el('whisper-input'), quote: f.el('message-input') };
    for (const [i, layer] of LAYERS.entries()) {
        const event = escape(f, focus[layer] ?? null);
        assert.equal(event.defaultPrevented, true, `Escape ${i + 1} is used`);
        const expected = Object.fromEntries(LAYERS.map((name, j) => [name, j > i]));
        assert.deepEqual(open(), expected, `Escape ${i + 1} closes the ${layer} layer only`);
    }
    // With no layer open, Escape does nothing.
    assert.equal(escape(f, f.el('message-input')).defaultPrevented, false);
    assert.equal(f.el('message-input').value, 'my draft');
    assert.deepEqual(f.errors, []);
});

test('with the focus out of the composer, Escape keeps the quote chip and closes the next layer', async () => {
    const { f, row, open } = await roomWithLayers();
    // Close the layers above the quote chip.
    escape(f);
    escape(f);
    escape(f, f.el('whisper-input'));
    escape(f);
    assert.deepEqual(open(), { menu: false, layout: false, whisper: false, find: false,
        quote: true, voice: true, invite: true, map: true });
    // The focus is on the message row, not in the composer.
    const event = escape(f, row);
    assert.equal(event.defaultPrevented, true);
    assert.equal(open().quote, true, 'the quote chip stays');
    assert.equal(open().voice, false, 'the voice settings close');
    escape(f, row);
    escape(f, row);
    assert.deepEqual(open(), { menu: false, layout: false, whisper: false, find: false,
        quote: true, voice: false, invite: false, map: false });
    // Now the focus goes into the composer: the next Escape removes the chip.
    assert.equal(escape(f, f.el('message-input')).defaultPrevented, true);
    assert.equal(open().quote, false);
    assert.deepEqual(f.errors, []);
});

test('a whisper pane closes only with the focus in it; with the focus out of it, Escape closes the next layer', async () => {
    const { f, open } = await roomWithLayers();
    escape(f);
    escape(f);
    // The focus is in the message box, not in the whisper pane: the find bar closes.
    escape(f, f.el('message-input'));
    assert.equal(open().whisper, true);
    assert.equal(open().find, false);
});

test('Escape does nothing while a modal dialog is open', async () => {
    const { f, open } = await roomWithLayers();
    const before = open();
    f.el('availability-dialog').setAttribute('open', '');
    const event = escape(f, f.el('message-input'));
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(open(), before);
    f.el('availability-dialog').removeAttribute('open');
    escape(f);
    assert.equal(open().menu, false);
});

test('Escape that a control already used does not close a layer', async () => {
    const { f, open } = await roomWithLayers();
    const before = open();
    const event = new f.Event('keydown', { key: 'Escape' });
    event.preventDefault();
    f.document.body.dispatchEvent(event);
    assert.deepEqual(open(), before);
});
