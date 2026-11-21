// The update text for 0.7.0 users (DECISIONS.md item 100): the window shows it in a protected room (internet and
// LAN) and hides it in a legacy shared-code room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs';

const TEXT = 'People with ASSCRACK 0.7.0 or older cannot join this room. Ask them to get the newest ASSCRACK.';

test('index.html has the update text in the invite panel', async () => {
    const html = await readFile(new URL('../src/application/index.html', import.meta.url), 'utf8');
    const panel = html.slice(html.indexOf('<div id="invite-panel"'), html.indexOf('id="room-members-section"'));
    assert.ok(panel.includes(`<p id="old-version-note" hidden>${TEXT}</p>`));
});

for (const [name, info, shown] of [
    ['protected internet room', { membership: { protected: true, owner: true, admitted: true, lan: false, members: [] } }, true],
    ['protected LAN room', { membership: { protected: true, owner: true, admitted: true, lan: true, members: [] } }, true],
    ['legacy shared-code room', { code: 'asscrack1:legacy', reason: null }, false]
]) {
    test(`the update text is ${shown ? 'shown' : 'hidden'} in a ${name}`, async () => {
        const room = await loadRoomWindow({ elements: [{ id: 'old-version-note', tag: 'p', hidden: true }] });
        room.el('old-version-note').textContent = TEXT;
        room.window.asscrack.getInvite = async () => info;
        room.window.asscrack.login = async () => ({ room: 'test', internet: !info.membership?.lan });
        await room.login('Ann');
        await settle();
        assert.equal(room.el('old-version-note').hidden, !shown);
        assert.deepEqual(room.errors, []);
    });
}
