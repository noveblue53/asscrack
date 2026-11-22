// Goal G3: the keys of the message box (gap D3: Up and Down recall the sent texts; gap D4: Tab completes a buddy
// name). The pure part (window.composerKeysCore) and the room window (test/helpers/renderer-fixture.mjs) run in node:vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const source = await readFile(new URL('../src/application/composer-keys.js', import.meta.url), 'utf8');

function loadCore() {
    const window = {};
    vm.runInNewContext(source, { window }, { filename: 'composer-keys.js' });
    return window.composerKeysCore;
}

test('recall: Up goes older, Down goes newer and then to the empty box; a changed text stops the recall', () => {
    const recall = loadCore().createRecall();
    assert.equal(recall.up(''), null, 'no text yet');
    recall.remember('one');
    recall.remember('/topic two');
    recall.remember('three');
    assert.equal(recall.up('draft'), null, 'Up in a box with a new text moves the caret');
    assert.equal(recall.up(''), 'three');
    assert.equal(recall.up('three'), '/topic two');
    assert.equal(recall.up('/topic two'), 'one');
    assert.equal(recall.up('one'), 'one', 'the oldest text stays');
    assert.equal(recall.down('one'), '/topic two');
    assert.equal(recall.down('/topic two'), 'three');
    assert.equal(recall.down('three'), '');
    assert.equal(recall.down(''), null);
    assert.equal(recall.up(''), 'three');
    assert.equal(recall.up('three!'), null, 'a changed text stops the recall');
    assert.equal(recall.down('three!'), null);
    assert.equal(recall.recalling(), false);
});

test('recall keeps the last 50 texts, and the same text two times in sequence is one entry', () => {
    const recall = loadCore().createRecall();
    for (let i = 1; i <= 60; i++) recall.remember(`line ${i}`);
    recall.remember('line 60');
    assert.equal(recall.size(), 50);
    let value = '';
    for (let i = 0; i < 60; i++) value = recall.up(value);
    assert.equal(value, 'line 11');
    recall.remember('   ');
    assert.equal(recall.size(), 50, 'an empty text is not kept');
});

test('completion: a word at the caret that starts a buddy name; the start of a line gives "Name: ", else "Name "', () => {
    const core = loadCore();
    const names = ['alice', 'Bob', 'bobby', 'Carol Ann', 'Bob'];
    const c = core.createCompletion();
    assert.deepEqual({ ...c.tab({ value: 'bo', caret: 2, names, ownName: 'alice' }) }, { value: 'Bob: ', caret: 5 });
    assert.deepEqual({ ...c.tab({ value: 'Bob: ', caret: 5, names, ownName: 'alice' }) }, { value: 'bobby: ', caret: 7 });
    assert.deepEqual({ ...c.tab({ value: 'bobby: ', caret: 7, names, ownName: 'alice' }) }, { value: 'Bob: ', caret: 5 });
    const d = core.createCompletion();
    assert.deepEqual({ ...d.tab({ value: 'hi CA there', caret: 5, names, ownName: 'alice' }) }, { value: 'hi Carol Ann  there', caret: 13 });
    assert.deepEqual({ ...d.tab({ value: 'x\nbob', caret: 5, names: ['Bob'], ownName: '' }) }, { value: 'x\nBob: ', caret: 7 });
    assert.equal(d.tab({ value: 'al', caret: 2, names, ownName: 'alice' }), null, 'not the own name');
    assert.equal(d.tab({ value: 'zed', caret: 3, names, ownName: 'alice' }), null, 'no match');
    assert.equal(d.tab({ value: 'bob', caret: 1, names, ownName: 'alice' }), null, 'the caret is inside the word');
    assert.equal(d.tab({ value: 'bo ', caret: 3, names, ownName: 'alice' }), null, 'the caret is after a space');
    assert.equal(d.tab({ value: '', caret: 0, names, ownName: 'alice' }), null, 'an empty box');
    // One match: a second Tab with no change moves the focus.
    const e = core.createCompletion();
    const first = e.tab({ value: 'car', caret: 3, names, ownName: 'alice' });
    assert.equal(first.value, 'Carol Ann: ');
    assert.equal(e.tab({ value: first.value, caret: first.caret, names, ownName: 'alice' }), null);
});

// A room window with the buddies Bob and Bobby. The fake textarea has no selection API: the tests set the caret.
async function openRoom() {
    const sent = [];
    const room = await loadRoomWindow({ send: async text => { sent.push(text); return { id: `m${sent.length}`, time: Date.now(), accepted: 1 }; } });
    await room.login('alice');
    for (const [peerId, name] of [['p1', 'Bob'], ['p2', 'Bobby']]) {
        room.handlers.onPeerJoined({ peerId });
        room.handlers.onPeerName({ peerId, name });
    }
    const input = room.el('message-input');
    const put = (value, caret = value.length) => {
        input.value = value;
        input.selectionStart = caret;
        input.selectionEnd = caret;
    };
    return { room, input, sent, put };
}

test('room window: Up and Down recall the texts that Enter sent', async () => {
    const { room, input, sent, put } = await openRoom();
    for (const text of ['first', 'second']) {
        put(text);
        room.key(input, 'Enter');
        await settle();
    }
    assert.deepEqual(sent, ['first', 'second']);
    assert.equal(input.value, '');
    let event = room.key(input, 'ArrowUp');
    assert.equal(event.defaultPrevented, true);
    assert.equal(input.value, 'second');
    room.key(input, 'ArrowUp');
    assert.equal(input.value, 'first');
    room.key(input, 'ArrowDown');
    assert.equal(input.value, 'second');
    room.key(input, 'ArrowDown');
    assert.equal(input.value, '');
    event = room.key(input, 'ArrowDown');
    assert.equal(event.defaultPrevented, false);
    // A changed text: Up moves the caret as usual.
    room.key(input, 'ArrowUp');
    put('second, changed');
    event = room.key(input, 'ArrowUp');
    assert.equal(event.defaultPrevented, false);
    assert.equal(input.value, 'second, changed');
    // Shift+Up selects text as usual.
    put('');
    assert.equal(room.key(input, 'ArrowUp', { shiftKey: true }).defaultPrevented, false);
    assert.deepEqual(room.errors, []);
});

test('room window: Tab completes a buddy name and prevents the event; with no match the Tab moves the focus', async () => {
    const { room, input, put } = await openRoom();
    put('bo');
    let event = room.key(input, 'Tab');
    assert.equal(event.defaultPrevented, true);
    assert.equal(input.value, 'Bob: ');
    event = room.key(input, 'Tab');
    assert.equal(event.defaultPrevented, true);
    assert.equal(input.value, 'Bobby: ');
    put('thanks bobb');
    room.key(input, 'Tab');
    assert.equal(input.value, 'thanks Bobby ');
    put('no match here');
    assert.equal(room.key(input, 'Tab').defaultPrevented, false);
    assert.equal(input.value, 'no match here');
    put('ali');
    assert.equal(room.key(input, 'Tab').defaultPrevented, false, 'the own name does not complete');
    put('bo');
    assert.equal(room.key(input, 'Tab', { shiftKey: true }).defaultPrevented, false, 'Shift+Tab always moves the focus');
    assert.equal(input.value, 'bo');
    put('bo', 1);
    assert.equal(room.key(input, 'Tab').defaultPrevented, false, 'the caret is inside the word');
    assert.deepEqual(room.errors, []);
});
