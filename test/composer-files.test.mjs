// Goal G3: the message box and the file draft (gaps D1, N5, N7). The room window scripts run in node:vm with the fake
// DOM (test/helpers/renderer-fixture.mjs). The bridge stubs record each call of send, offerFile and postMedia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const MB = 1024 * 1024;

// A room window with one peer "bob" (peer-bob). calls: the bridge calls in their sequence.
async function openRoom({ peers = 1 } = {}) {
    const calls = [];
    const offer = (file, recipientId) => ({
        offerId: `offer-${calls.length}`, name: file.name, size: file.size,
        peers, recipients: peers ? ['peer-bob'] : [], ...(recipientId ? { recipientId } : {})
    });
    const room = await loadRoomWindow({
        elements: [{ id: 'file-draft-size', tag: 'span' }],
        send: async (text, channelId) => {
            calls.push(['send', text, channelId]);
            return { id: `m-${calls.length}`, time: Date.now(), accepted: 1 };
        },
        api: {
            offerFile: async (file, recipientId) => {
                calls.push(['offerFile', file.name, recipientId]);
                return offer(file, recipientId);
            },
            postMedia: async (file, caption, channelId, recipientId) => {
                calls.push(['postMedia', file.name, caption, channelId, recipientId]);
                const result = { offer: offer(file, recipientId) };
                if (recipientId === undefined) {
                    result.message = { id: 'media-1', from: 'alice', text: `${caption}\n${file.name}`, time: Date.now() };
                }
                return result;
            },
            canSendFile: file => typeof file?.path === 'string' && file.path !== ''
        }
    });
    await room.login('alice');
    room.handlers.onPeerJoined({ peerId: 'peer-bob' });
    room.handlers.onPeerName({ peerId: 'peer-bob', name: 'bob' });
    calls.length = 0;
    const input = room.el('message-input');
    return {
        room, calls, input,
        attach(file) {
            room.el('file-input').files = [file];
            room.el('file-input').dispatchEvent(new room.Event('change'));
        },
        async enter(text) {
            input.value = text;
            const event = room.key(input, 'Enter');
            await settle();
            return event;
        },
        draft: () => (room.el('file-draft').hidden ? null : room.el('file-draft-name').textContent),
        status: () => room.el('status').textContent,
        offerNotes: () => room.notes().filter(n => n.kind === 'offer').map(n => n.text)
    };
}

test('no file draft: Enter sends the text as before', async () => {
    const t = await openRoom();
    await t.enter('hello room');
    assert.deepEqual(t.calls, [['send', 'hello room', undefined]]);
    assert.equal(t.input.value, '');
    assert.deepEqual(t.room.errors, []);
});

test('a media file for the entire room: Enter calls postMedia with the text as the caption, and nothing more', async () => {
    const t = await openRoom();
    t.attach({ name: 'cat.png', type: 'image/png', size: 2048 });
    assert.equal(t.room.el('file-draft-size').textContent, '2.0 KB');
    await t.enter('look at this');
    assert.deepEqual(t.calls, [['postMedia', 'cat.png', 'look at this', 'general', undefined]]);
    assert.equal(t.input.value, '');
    assert.equal(t.draft(), null);
    assert.deepEqual(t.offerNotes(), [], 'a media line is in the chat, thus no offer note');
    assert.ok(t.room.rows().some(r => r.dataset.id === 'media-1'));
    assert.deepEqual(t.room.errors, []);
});

test('an ordinary file for the entire room: the Send button offers the file, then sends the text, and adds the offer note', async () => {
    const t = await openRoom();
    t.attach({ name: 'setup.zip', type: 'application/zip', size: 12 * MB });
    assert.equal(t.room.el('file-draft-size').textContent, '12.0 MB');
    t.input.value = 'the installer';
    t.room.el('send').click();
    await settle();
    assert.deepEqual(t.calls, [['offerFile', 'setup.zip', undefined], ['send', 'the installer', undefined]]);
    assert.equal(t.input.value, '');
    assert.equal(t.draft(), null);
    assert.deepEqual(t.offerNotes(), ['You offered setup.zip (12.0 MB) to the room.']);
    const notes = t.room.el('messages').children.filter(r => r.classList.contains('note') && r.dataset.kind === 'offer');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].dataset.id, undefined, 'a note row has no id');
    assert.equal(t.room.window.roomActions.rowInfo(notes[0]), null, 'a note row has no menu');
    assert.deepEqual(t.room.errors, []);
});

test('an ordinary file for the entire room with an empty box: only the offer', async () => {
    const t = await openRoom();
    t.attach({ name: 'notes.txt', type: 'text/plain', size: 10 });
    await t.enter('');
    assert.deepEqual(t.calls, [['offerFile', 'notes.txt', undefined]]);
    assert.deepEqual(t.offerNotes(), ['You offered notes.txt (10 B) to the room.']);
});

test('an ordinary file for the entire room with 0 peers: no text goes, the text and the draft stay', async () => {
    const t = await openRoom({ peers: 0 });
    t.attach({ name: 'setup.zip', type: 'application/zip', size: 100 });
    await t.enter('the installer');
    assert.deepEqual(t.calls, [['offerFile', 'setup.zip', undefined]]);
    assert.equal(t.input.value, 'the installer');
    assert.equal(t.draft(), 'setup.zip');
    assert.match(t.status(), /No peer received the offer/);
    assert.deepEqual(t.offerNotes(), []);
});

test('a file for one person and an empty box: a private offer and the note "… to bob."', async () => {
    const t = await openRoom();
    t.attach({ name: 'secret.pdf', type: 'application/pdf', size: 3 * 1024 });
    t.room.el('file-recipient').value = 'peer-bob';
    await t.enter('');
    assert.deepEqual(t.calls, [['offerFile', 'secret.pdf', 'peer-bob']]);
    assert.equal(t.draft(), null);
    assert.deepEqual(t.offerNotes(), ['You offered secret.pdf (3.0 KB) to bob.']);
});

test('a media file for one person and an empty box: postMedia makes no chat line, thus the offer note comes', async () => {
    const t = await openRoom();
    t.attach({ name: 'cat.jpg', type: 'image/jpeg', size: 1024 });
    t.room.el('file-recipient').value = 'peer-bob';
    await t.enter('');
    assert.deepEqual(t.calls, [['postMedia', 'cat.jpg', '', 'general', 'peer-bob']]);
    assert.deepEqual(t.offerNotes(), ['You offered cat.jpg (1.0 KB) to bob.']);
});

test('a file for one person and text in the box: only the text goes to the room, the draft stays, and the status says so', async () => {
    const t = await openRoom();
    t.attach({ name: 'secret.pdf', type: 'application/pdf', size: 3 * 1024 });
    t.room.el('file-recipient').value = 'peer-bob';
    await t.enter('hello all');
    assert.deepEqual(t.calls, [['send', 'hello all', undefined]]);
    assert.equal(t.input.value, '');
    assert.equal(t.draft(), 'secret.pdf');
    assert.equal(t.room.el('file-recipient').value, 'peer-bob');
    assert.equal(t.status(), 'The file for bob is still attached. Select “Send file” to send it.');
    // The button "Send file" then sends the file.
    t.room.el('send-file').click();
    await settle();
    assert.deepEqual(t.calls.at(-1), ['offerFile', 'secret.pdf', 'peer-bob']);
    assert.equal(t.draft(), null);
    assert.deepEqual(t.room.errors, []);
});

test('N7: a paste of one file with a local path attaches it; a file with no path does not; a clipboard PNG still attaches', async () => {
    const t = await openRoom();
    const paste = clipboardData => {
        const event = new t.room.Event('paste', { clipboardData });
        t.input.dispatchEvent(event);
        return event;
    };
    const copied = { name: 'report.docx', type: '', size: 5000, path: 'C:\\Users\\x\\report.docx' };
    const event = paste({ files: [copied], items: [{ kind: 'file', type: '', getAsFile: () => copied }] });
    assert.equal(event.defaultPrevented, true);
    assert.equal(t.draft(), 'report.docx');
    t.room.el('file-remove').click();
    // Two files: no attach.
    assert.equal(paste({ files: [copied, { ...copied, name: 'b.txt' }], items: [] }).defaultPrevented, false);
    assert.equal(t.draft(), null);
    // A file with no path (canSendFile gives false) and no PNG: the paste is not prevented.
    assert.equal(paste({ files: [{ name: 'x.txt', size: 3 }], items: [] }).defaultPrevented, false);
    assert.equal(t.draft(), null);
    // A screenshot: a PNG with no path attaches as before.
    const png = { name: 'image.png', type: 'image/png', size: 400 };
    assert.equal(paste({ files: [png], items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }] }).defaultPrevented, true);
    assert.equal(t.draft(), 'image.png');
    // Plain text: nothing happens.
    t.room.el('file-remove').click();
    assert.equal(paste({ files: [], items: [{ kind: 'string', type: 'text/plain' }] }).defaultPrevented, false);
    assert.equal(t.draft(), null);
    assert.deepEqual(t.room.errors, []);
});
