import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

function profile() {
    const data = new Map();
    return { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
}

function scrollBack(f) {
    const list = f.el('messages');
    list.scrollHeight = 800;
    list.clientHeight = 100;
    list.scrollTop = 25;
    list.dispatchEvent(new f.Event('scroll'));
}

test('live nick and keyword highlights navigate in order under DND and keep Find, focus and quoted text intact', async () => {
    const localStorage = profile();
    const f = await loadRoomWindow({ localStorage });
    await f.login('Parker');
    f.el('presence-state').value = 'dnd';
    f.el('presence-set').click();
    await settle();
    assert.equal(f.el('peers').querySelector('.presence-mark').dataset.presence, 'dnd');
    const words = f.el('highlight-words');
    words.value = 'pit stop, C++';
    words.dispatchEvent(new f.Event('input'));
    scrollBack(f);
    const send = (id, text, peerId = 'other') => f.receive({ id, text, from: 'Parker', peerId, time: 100 });
    assert.equal(send('plain', 'Parkerson pits.').querySelector('mark'), null);
    const first = send('first', 'PARKER, now!');
    const quotation = f.window.quoteCore.makeQuote({ from: 'Parker', clock: '12:00', text: 'pit stop' });
    const quotedOnly = f.window.quoteCore.compose(quotation, 'copy that');
    assert.equal(send('quoted', quotedOnly).querySelector('mark'), null);
    const reply = f.window.quoteCore.compose(quotation, 'PIT STOP with C++');
    const second = send('second', reply);
    assert.equal(second.querySelector('.text').textContent, reply);
    assert.deepEqual(second.querySelectorAll('mark').map(m => m.textContent), ['PIT STOP', 'C++']);
    assert.equal(second.querySelector('.quote').querySelector('mark'), null);
    assert.equal(first.querySelector('mark').textContent, 'PARKER');
    assert.equal(send('self', 'Parker', 'self-peer-id').querySelector('mark'), null);
    f.history([{ id: 'second', from: 'Parker', text: reply, time: 100 },
        { id: 'history', from: 'Another', text: 'pit stop', time: 99 }]);
    send('first', 'PARKER, now!');
    assert.equal(f.el('next-highlight').textContent, 'Next highlight (2)');

    const input = f.el('message-input');
    input.focus();
    const unread = f.window.reading.unreadCount();
    f.el('find-input').select = () => {}; // The fixture has no native text selection.
    assert.equal(f.window.findBar.open(), true);
    assert.equal(f.window.findBar.close(), true);
    assert.equal(f.window.reading.unreadCount(), unread);
    const key = f.key(input, 'j', { altKey: true });
    assert.equal(key.defaultPrevented, true);
    assert.equal(f.document.activeElement, input);
    assert.ok(first.classList.contains('selected-highlight'));
    f.el('next-highlight').click();
    assert.ok(second.classList.contains('selected-highlight'));
    assert.equal(first.classList.contains('selected-highlight'), false);
    assert.equal(f.el('next-highlight').disabled, true);

    const reopened = await loadRoomWindow({ localStorage });
    await reopened.login('Other Name');
    assert.equal(reopened.el('highlight-words').value, words.value);
    assert.equal(reopened.receive({ id: 'new', from: 'B', text: 'A pit stop.', peerId: 'B' }).querySelector('mark').textContent, 'pit stop');
    assert.equal(reopened.el('next-highlight').disabled, true, 'a matching live line seen at the bottom is already read');
});

test('whole names and literal keywords respect Unicode word boundaries and Jump to latest clears pending hits', async () => {
    const f = await loadRoomWindow();
    await f.login('Renée W.');
    scrollBack(f);
    const show = (id, text) => f.receive({ id, text, from: 'Alex', peerId: 'b' });
    assert.equal(show('1', '前Renée W.').querySelector('mark'), null);
    assert.equal(show('2', 'Renée W.x').querySelector('mark'), null);
    assert.equal(show('3', '“RENÉE W.”').querySelector('mark').textContent, 'RENÉE W.');
    f.el('jump-latest').click();
    assert.equal(f.el('next-highlight').disabled, true);
});

test('scrolling to the bottom by hand also clears unread highlights', async () => {
    const f = await loadRoomWindow();
    await f.login('Alex');
    scrollBack(f);
    f.receive({ id: 'mention', from: 'Sam', peerId: 'sam', text: 'Hi Alex', time: 1 });
    assert.equal(f.el('next-highlight').textContent, 'Next highlight (1)');
    const list = f.el('messages');
    list.scrollTop = list.scrollHeight - list.clientHeight;
    list.dispatchEvent(new f.Event('scroll'));
    assert.equal(f.window.reading.unreadCount(), 0);
    assert.equal(f.el('next-highlight').disabled, true);
});

test('revealing the first of two highlights at the bottom keeps the second pending', async () => {
    const f = await loadRoomWindow();
    await f.login('Alex');
    scrollBack(f);
    const one = f.receive({ id: 'one', from: 'Sam', peerId: 'sam', text: 'Alex, first', time: 1 });
    f.receive({ id: 'two', from: 'Sam', peerId: 'sam', text: 'Alex, second', time: 2 });
    const list = f.el('messages');
    // Simulate the native scroll event that follows revealLine once the target hits the end.
    one.offsetTop = list.scrollHeight - list.clientHeight / 2;
    f.el('next-highlight').click();
    list.dispatchEvent(new f.Event('scroll'));
    assert.equal(f.el('next-highlight').textContent, 'Next highlight (1)');
});
