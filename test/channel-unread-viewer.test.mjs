// Goal G3: the unread count of the other channels next to the channel menu (gap D5), and the image viewer (gap D7).
// The room window scripts run in node:vm with the fake DOM (test/helpers/renderer-fixture.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const CHANNEL_IDS = ['channel-select', 'channel-add', 'channel-dialog', 'channel-name', 'channel-note', 'channel-error',
    'channel-cancel', 'channel-create-form'];

test('D5: span.count shows the sum of the unread counts of the other channels, and is hidden at 0', async () => {
    const room = await loadRoomWindow({
        scripts: ['channels-ui.js'],
        elements: [...CHANNEL_IDS.map(id => ({ id })), { id: 'channel-unread', tag: 'span', class: 'count', hidden: true }]
    });
    await room.login('alice');
    const count = room.el('channel-unread');
    const ch = room.window.roomChannels;
    room.handlers.onChannels({ channels: [{ id: 'general', name: 'General' }, { id: 'music', name: 'Music' }, { id: 'news', name: 'News' }], available: true });
    assert.equal(count.hidden, true);
    assert.equal(count.textContent, '');
    ch.missed('music');
    ch.missed('music');
    ch.missed('news');
    ch.missed('general'); // the open channel: no count
    assert.equal(count.hidden, false);
    assert.equal(count.textContent, '3');
    assert.equal(count.getAttribute('aria-label'), '3 unread in other channels');
    ch.open('music');
    assert.equal(count.textContent, '1');
    assert.equal(count.getAttribute('aria-label'), '1 unread in other channels');
    ch.open('news');
    assert.equal(count.hidden, true);
    assert.equal(count.getAttribute('aria-label'), null);
    assert.deepEqual(room.errors, []);
});

function viewerElements() {
    return [
        { id: 'view-previews', tag: 'button' },
        { id: 'image-viewer', tag: 'dialog', children: [{ id: 'image-viewer-image', tag: 'img' }, { tag: 'button' }] }
    ];
}

// The fake DOM has no <dialog> methods.
function fakeDialog(room) {
    const dialog = room.el('image-viewer');
    dialog.open = false;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => {
        dialog.open = false;
        dialog.dispatchEvent(new room.Event('close'));
    };
    return dialog;
}

test('D7: a click on a chat image opens the viewer with the original; the row action "View image" opens it too', async () => {
    const infos = { d1: { thumbnailUrl: 'room-media://thumb/d1', originalUrl: 'room-media://original/d1' },
        d2: { thumbnailUrl: 'room-media://thumb/d2', originalUrl: null } };
    const room = await loadRoomWindow({
        scripts: ['chat-media.js'],
        elements: viewerElements(),
        api: { getMediaInfo: async ref => infos[ref.id] ?? {}, requestMediaPreview: async () => ({}) }
    });
    await room.login('alice');
    const dialog = fakeDialog(room);
    const image = room.el('image-viewer-image');
    const row = room.receive({ from: 'bob', text: 'cat.png', peerId: 'p1', id: 'm1' });
    room.window.chatMedia.decorate(row, { id: 'd1', kind: 'image', name: 'cat.png' });
    await settle();
    const thumb = row.querySelector('img');
    assert.equal(thumb.src, 'room-media://thumb/d1');
    thumb.click();
    await settle();
    assert.equal(dialog.open, true);
    assert.equal(image.src, 'room-media://original/d1');
    assert.equal(image.alt, 'cat.png');
    dialog.close();
    assert.equal(image.getAttribute('src'), null);
    // The keyboard: the row menu has "View image".
    const info = room.window.roomActions.rowInfo(row);
    assert.equal(info.image, true);
    assert.ok([...room.window.menuCore.actionsFor(info)].includes('view-image'));
    assert.equal(room.window.menuCore.label('view-image'), 'View image');
    assert.equal(await room.window.roomActions.run('view-image', row), true);
    assert.equal(dialog.open, true);
    dialog.close();
    // No original: the thumbnail.
    const other = room.receive({ from: 'bob', text: 'dog.png', peerId: 'p1', id: 'm2' });
    room.window.chatMedia.decorate(other, { id: 'd2', kind: 'image', name: 'dog.png' });
    await settle();
    other.querySelector('img').click();
    await settle();
    assert.equal(image.src, 'room-media://thumb/d2');
    // A line with no image has no "View image".
    const plain = room.receive({ from: 'bob', text: 'hello', peerId: 'p1', id: 'm3' });
    assert.equal([...room.window.menuCore.actionsFor(room.window.roomActions.rowInfo(plain))].includes('view-image'), false);
    assert.deepEqual(room.errors, []);
});
