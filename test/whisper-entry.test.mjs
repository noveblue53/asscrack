import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRoomWindow } from './helpers/renderer-fixture.mjs';

test('room Enter and Send route addressed commands to whispers and only clear a consumed command', async () => {
    const posts = [];
    const room = await loadRoomWindow({ send: async text => posts.push(text) });
    await room.login('Me');
    const input = room.el('message-input');
    const commands = [];
    let accepted = false;
    room.window.whispers = { command(raw) { commands.push(raw); return accepted; } };
    const ambiguous = '  /w Sam a private draft';
    input.value = ambiguous;
    room.key(input, 'Enter');
    assert.equal(input.value, ambiguous);
    accepted = true;
    for (const raw of ['/w', '/MSG John', '/whisper John a draft']) {
        input.value = raw;
        room.el('send').click();
        assert.equal(input.value, '');
    }
    assert.deepEqual(commands, [ambiguous, '/w', '/MSG John', '/whisper John a draft']);
    assert.deepEqual(posts, []);
});

test('the buddy menu and /w reopen the same private draft without choosing a same-name peer', async () => {
    const pane = { id: 'whisper-pane', hidden: true, children:
        ['title', 'picker', 'close', 'peer', 'draft', 'lines', 'status', 'send'].map(name => ({ id: 'whisper-' + name })) };
    const elements = [pane, { id: 'whisper-open' }];
    const room = await loadRoomWindow({ elements, scripts: ['whispers.js'] });
    await room.login('Me');
    const input = room.el('message-input');
    input.value = 'keep the public draft';
    for (const peerId of ['first-sam', 'second-sam']) {
        room.handlers.onPeerJoined({ peerId });
        room.handlers.onPeerName({ peerId, name: 'Sam' });
        room.handlers.onWhisperCapability({ peerId, available: true });
    }
    const row = room.el('peers').querySelector('[data-peer-id="second-sam"]');
    assert.ok(room.window.contextMenu.open(row, row));
    const item = room.el('row-menu').querySelector('[data-action="whisper"]');
    assert.equal(item.textContent, 'Whisper');
    item.click();
    assert.equal(room.window.whispers.isViewing('second-sam'), true);
    assert.equal(room.window.whispers.isViewing('first-sam'), false);
    room.el('whisper-draft').value = 'private draft for the second Sam';
    room.el('whisper-draft').dispatchEvent(new room.Event('input'));
    room.el('whisper-close').click();
    assert.equal(input.value, 'keep the public draft');
    input.value = '/w second-sam';
    room.key(input, 'Enter');
    assert.equal(input.value, '');
    assert.equal(room.window.whispers.isViewing('second-sam'), true);
    assert.equal(room.el('whisper-draft').value, 'private draft for the second Sam');
    room.handlers.onPeerLeft({ peerId: 'second-sam' });
    assert.equal(room.window.roomActions.run('whisper', row), false);
    assert.equal(room.el('whisper-send').disabled, true);
    room.key(room.el('whisper-draft'), 'Escape');
    assert.equal(room.window.whispers.isOpen(), false);
    assert.equal(room.document.activeElement, input);
    input.value = '/w';
    room.key(input, 'Enter');
    assert.equal(room.document.activeElement, room.el('whisper-peer'));
    room.key(room.el('whisper-peer'), 'Escape');
    assert.equal(room.window.whispers.isOpen(), false);
    assert.equal(room.document.activeElement, input);
});

test('a whisper command cannot become a room attachment caption or leak via a hidden public composer', async () => {
    const posts = [];
    const room = await loadRoomWindow({ send: async text => posts.push(text) });
    await room.login('Me');
    const input = room.el('message-input');
    const file = { name: 'room.png', size: 5 };
    room.el('file-input').files = [file];
    room.el('file-input').dispatchEvent(new room.Event('change'));
    let privateView = false;
    const commands = [];
    room.window.whispers = {
        command(raw) { commands.push(raw); privateView = true; return true; },
        isOpen() { return privateView; }
    };
    input.value = '/w John secret caption';
    room.el('send-file').click();
    assert.deepEqual(commands, ['/w John secret caption']);
    input.value = 'public draft';
    room.el('send').click();
    room.el('send-file').click();
    const drop = new room.Event('drop', { dataTransfer: { files: [{ name: 'private.png' }], types: ['Files'] } });
    room.el('message-panel').dispatchEvent(drop);
    assert.equal(drop.dataTransfer.dropEffect, 'none');
    assert.equal(room.el('file-draft-name').textContent, 'room.png');
    assert.deepEqual(room.calls.filter(x => x.name === 'postMedia' || x.name === 'offerFile'), []);
    assert.deepEqual(posts, []);
    assert.equal(input.value, 'public draft');
    room.key(input, 'f', { ctrlKey: true });
    assert.equal(room.window.findBar.isOpen(), false);
    const roomLine = room.receive({ id: 'room-mention', from: 'Sam', peerId: 'sam', text: 'Me, one moment?' });
    room.window.chatHighlights.note(roomLine, 'Me, one moment?', true);
    assert.equal(room.el('next-highlight').disabled, false);
    assert.equal(room.key(input, 'j', { altKey: true }).defaultPrevented, false);
    assert.equal(roomLine.classList.contains('selected-highlight'), false);
});
