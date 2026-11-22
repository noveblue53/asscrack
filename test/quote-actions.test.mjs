// The Quote controls and the send path of renderer.js, with the real scripts in the fake DOM
// (test/helpers/renderer-fixture.mjs): the visible Quote button and the row menu run the same action, a draft stays,
// and a failed send keeps the edited draft and the quote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const SAM_A = '12D3KooWsamAAAAAAaaaa01';
const SAM_B = '12D3KooWsamBBBBBBbbbb02';

async function room(options) {
    const f = await loadRoomWindow(options);
    await f.login('Me');
    for (const [peerId, name] of [[SAM_A, 'Sam'], [SAM_B, 'Sam']]) {
        f.handlers.onPeerJoined({ peerId });
        f.handlers.onPeerName({ peerId, name });
    }
    return f;
}

function menuQuote(f, row) {
    assert.equal(f.window.contextMenu.open(row, row), true);
    const item = f.document.getElementById('row-menu').querySelector('[data-action="quote"]');
    assert.ok(item, 'the row menu has Quote');
    item.click();
}

test('the Quote button and the row menu pick the same line, show the same chip and keep the draft', async () => {
    const f = await room();
    f.receive({ from: 'Sam', text: 'from the first Sam', peerId: SAM_A, id: 'a1' });
    const row = f.receive({ from: 'Sam', text: 'from the second Sam', peerId: SAM_B, id: 'b1' });
    const input = f.el('message-input');
    input.value = 'my draft';

    row.querySelector('.btn-quote').click();
    const byButton = f.chip();
    assert.equal(byButton.hidden, false);
    // The tag is the one of the second Sam (the sender of this row), not of the first Sam.
    assert.equal(byButton.from, 'Sam (bbbb02)');
    assert.equal(byButton.excerpt, 'from the second Sam');
    assert.equal(input.value, 'my draft');

    f.el('quote-remove').click();
    assert.equal(f.chip().hidden, true);
    assert.equal(input.value, 'my draft');

    menuQuote(f, row);
    assert.deepEqual(f.chip(), byButton);
    assert.equal(input.value, 'my draft');

    // Escape with the focus in the composer removes the chip and keeps the typed reply.
    input.focus();
    const event = f.key(input, 'Escape');
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.chip().hidden, true);
    assert.equal(input.value, 'my draft');
    assert.deepEqual(f.errors, []);
});

test('the Quote button goes through the row action dispatcher', async () => {
    const f = await room();
    const row = f.receive({ from: 'Sam', text: 'x', peerId: SAM_A, id: 'a1' });
    // When the row has no menu now (the user left the room view), the dispatcher and both controls do nothing.
    const before = f.chip();
    row.remove();
    row.querySelector('.btn-quote').click();
    assert.deepEqual(f.chip(), before);
    assert.equal(f.window.roomActions.run('quote', row), false);
});

test('a replayed line with no peer ID gets the name alone, never the tag of this user', async () => {
    const f = await loadRoomWindow();
    await f.login('Sam');
    f.handlers.onPeerJoined({ peerId: SAM_A });
    f.handlers.onPeerName({ peerId: SAM_A, name: 'Sam' });
    f.history([{ id: 'h1', from: 'Sam', text: 'an old line', time: Date.now() - 60000 }]);
    const row = f.rows().find(r => r.dataset.id === 'h1');
    row.querySelector('.btn-quote').click();
    assert.equal(f.chip().from, 'Sam');
});

test('a failed send keeps the full edited draft and the quote, and no line appears', async () => {
    let reject;
    const f = await room({ send: () => new Promise((_, no) => { reject = no; }) });
    const row = f.receive({ from: 'Sam', text: 'the original', peerId: SAM_A, id: 'a1' });
    row.querySelector('.btn-quote').click();
    const quoted = f.chip();
    const input = f.el('message-input');
    input.value = 'first part';
    const rowsBefore = f.rows().length;
    f.key(input, 'Enter');
    await settle();
    assert.equal(typeof reject, 'function', 'the send is pending');
    // The user types more while the send waits.
    input.value += ' and more';
    reject(new Error('Not logged in'));
    await settle();
    assert.equal(input.value, 'first part and more');
    assert.deepEqual(f.chip(), quoted);
    assert.equal(f.rows().length, rowsBefore);
    assert.equal(f.el('status').textContent, 'Not sent: Not in a room.');
});

test('Shift+Enter does not send; Enter sends the quote and clears the draft', async () => {
    const sent = [];
    const f = await room({ send: async text => { sent.push(text); return 2; } });
    const row = f.receive({ from: 'Sam', text: 'hello', peerId: SAM_A, id: 'a1' });
    row.querySelector('.btn-quote').click();
    const input = f.el('message-input');
    input.value = 'line one';
    const shift = f.key(input, 'Enter', { shiftKey: true });
    assert.equal(shift.defaultPrevented, false);
    await settle();
    assert.equal(sent.length, 0);
    f.key(input, 'Enter');
    await settle();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^> Sam \(aaaa01\) at \d{1,2}:\d{2}, 1 line:\n> hello\nline one$/);
    assert.equal(input.value, '');
    assert.equal(f.chip().hidden, true);
});
