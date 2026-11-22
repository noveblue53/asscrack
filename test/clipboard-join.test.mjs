// Goal easy-join part 3, item 3: a device invite in the clipboard (clipboard-join.mjs, friend-join.mjs joinCode(),
// clipboard-join-ui.js). Pure logic and a fake DOM: no network, no Electron. Each module loads in the test, thus on a
// SHA with no module each test fails alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { makeMemberInvite, newRoomKey } from '../src/network/invite.mjs';
import { createDeviceIdentity, createRoomMembership } from '../src/network/room-membership.mjs';
import { createDom } from './helpers/fake-dom.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NODES = [{ id: '12D3KooWGpponMzJoSX1usSBzTdUmp9iaNvRFkvtJh75io6goVuA', addrs: ['/ip4/203.0.113.5/tcp/47000'] }];
const load = () => import('../src/application/clipboard-join.mjs');

const owner = createDeviceIdentity();
const self = createDeviceIdentity();
const other = createDeviceIdentity();

// A device invite of the owner for a device.
function inviteFor(deviceId, { now = Date.now, room = 'Game night' } = {}) {
    const roomKey = newRoomKey();
    const membership = createRoomMembership({ identity: owner, room, roomKey, now });
    return { room, roomKey, code: makeMemberInvite({ room, key: roomKey, nodes: NODES, membership: membership.issue(deviceId, false) }) };
}

function profile(t) {
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-clip-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'clipboard-asked.json');
}

// A controller with a clipboard text. Returns the controller, the log lines, the notify count and the join calls.
async function controller(t, { text, file = profile(t), current = null, busy = false, selfId = self.id } = {}) {
    const { createClipboardJoin, createAskedStore } = await load();
    const state = { text, log: [], notified: 0, joins: [], reads: 0 };
    const log = (level, line) => state.log.push(`${level} ${line}`);
    const join = createClipboardJoin({
        // Electron 45: clipboard.readText() gives a promise.
        readText: async () => { state.reads++; return state.text; },
        selfId: () => selfId,
        currentRoom: () => current,
        busy: () => busy,
        store: createAskedStore(file, { log }),
        notify: (...args) => { state.notified++; assert.equal(args.length, 0); },
        join: async (code, room, leave) => { state.joins.push({ code, room, leave }); return { result: 'joining', room }; },
        log
    });
    return { join, state, file };
}

test('clipboard: a device invite for this device asks one time, also after a restart of the store', async t => {
    const invite = inviteFor(self.id);
    const first = await controller(t, { text: invite.code });
    assert.equal(await first.join.check(), true);
    assert.equal(first.state.notified, 1);
    assert.equal(first.join.take().room, 'Game night');
    // The next focus with the same code, also with white space around it: no second prompt.
    assert.equal(await first.join.check(), false);
    first.state.text = `  ${invite.code.slice(0, 40)}\r\n${invite.code.slice(40)}\n`;
    assert.equal(await first.join.check(), false);
    assert.equal(first.state.notified, 1);
    // A restart: a new store on the same profile file.
    const second = await controller(t, { text: invite.code, file: first.file });
    assert.equal(await second.join.check(), false);
    assert.equal(second.join.take(), null);
    assert.equal(second.state.notified, 0);
    // A new code asks. Two checks at the same time (the focus and the load) give one prompt.
    second.state.text = inviteFor(self.id, { room: 'Lobby' }).code;
    assert.deepEqual((await Promise.all([second.join.check(), second.join.check()])).sort(), [false, true]);
    assert.equal(second.state.notified, 1);
    assert.equal(second.join.take().room, 'Lobby');
});

test('clipboard: a code for another device, an expired code, a damaged text and the room of now give no prompt', async t => {
    const { clipboardKind } = await load();
    const good = inviteFor(self.id);
    const body = good.code.slice('asscrack3:'.length);
    const middle = Math.floor(body.length / 2);
    const flipped = 'asscrack3:' + body.slice(0, middle) + (body[middle] === 'A' ? 'B' : 'A') + body.slice(middle + 1);
    const texts = {
        'other device': inviteFor(other.id).code,
        expired: inviteFor(self.id, { now: () => Date.now() - 8 * DAY }).code,
        'flipped character': flipped,
        'cut code': good.code.slice(0, -6),
        'plain text': 'hello, this is a note',
        'legacy room code': 'asscrack1:' + Buffer.from(JSON.stringify({ v: 1, room: 'x', key: newRoomKey(), nodes: NODES })).toString('base64url'),
        'too long': good.code + ' '.repeat(20 * 1024),
        empty: ''
    };
    for (const [what, text] of Object.entries(texts)) {
        assert.equal(clipboardKind(text, { selfId: self.id }), null, what);
        const c = await controller(t, { text });
        assert.equal(await c.join.check(), false, what);
        assert.equal(c.join.take(), null, what);
        assert.equal(c.state.notified, 0, what);
        assert.deepEqual(c.state.log, [], `${what}: no log line`);
    }
    assert.equal(clipboardKind(good.code, { selfId: self.id }).kind, 'device-invite');

    // The room of now: no prompt, and the code is not recorded (after Leave room it asks).
    const file = profile(t);
    const inRoom = await controller(t, { text: good.code, file, current: { room: good.room, roomKey: good.roomKey } });
    assert.equal(await inRoom.join.check(), false);
    assert.equal(inRoom.state.notified, 0);
    const otherRoom = await controller(t, { text: good.code, file, current: { room: good.room, roomKey: newRoomKey() } });
    assert.equal(await otherRoom.join.check(), true);

    // A login or a Leave room runs: no prompt now, it asks at the next focus.
    const busyFile = profile(t);
    const busy = await controller(t, { text: good.code, file: busyFile, busy: true });
    assert.equal(await busy.join.check(), false);
    assert.equal(await (await controller(t, { text: good.code, file: busyFile })).join.check(), true);

    // No device identity (protected storage locked): the clipboard is not read.
    const locked = await controller(t, { text: good.code, selfId: null });
    assert.equal(await locked.join.check(), false);
    assert.equal(locked.state.reads, 0);
});

test('clipboard: the log, the profile file and the window get no code text', async t => {
    const invite = inviteFor(self.id);
    const body = invite.code.slice('asscrack3:'.length);
    const c = await controller(t, { text: invite.code });
    assert.equal(await c.join.check(), true);
    const prompt = c.join.take();
    assert.deepEqual(Object.keys(prompt).sort(), ['id', 'room']);
    const outputs = [JSON.stringify(prompt), ...c.state.log, readFileSync(c.file, 'utf8')];
    for (const out of outputs) {
        assert.ok(!out.includes('asscrack3:'), 'no prefix');
        for (let i = 0; i + 16 <= body.length; i += 8) assert.ok(!out.includes(body.slice(i, i + 16)), 'no part of the code');
        assert.ok(!out.includes(invite.roomKey), 'no room key');
    }
    assert.equal(c.state.log.length, 1);
    // Join gives the code to friend-join only, and an unknown id gives 'gone'.
    assert.equal((await c.join.join('not-the-id')).result, 'gone');
    assert.equal((await c.join.join(prompt.id)).result, 'joining');
    assert.deepEqual(c.state.joins, [{ code: invite.code, room: 'Game night', leave: false }]);
    assert.equal(c.join.take(), null);
    assert.equal((await c.join.join(prompt.id)).result, 'gone');
});

test('clipboard: Not now closes the prompt, and the store keeps the last 50 codes', async t => {
    const { createAskedStore, codeHash, ASKED_CAP } = await load();
    assert.equal(ASKED_CAP, 50);
    const invite = inviteFor(self.id);
    const c = await controller(t, { text: invite.code });
    assert.equal(await c.join.check(), true);
    c.join.dismiss(c.join.take().id);
    assert.equal(c.join.take(), null);
    assert.equal(await c.join.check(), false);

    const file = profile(t);
    const store = createAskedStore(file);
    const hashes = Array.from({ length: 55 }, (_, i) => codeHash(`code-${i}`));
    for (const h of hashes) store.add(h);
    assert.equal(store.size(), 50);
    const again = createAskedStore(file);
    assert.equal(again.size(), 50);
    assert.equal(again.has(hashes[4]), false);
    assert.equal(again.has(hashes[5]), true);
    assert.equal(again.has(hashes[54]), true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).hashes.length, 50);
});

test('clipboard: joinCode of friend-join gives a one-time token, and asks "Leave <room> and join?" in a room', async () => {
    const { createFriendJoins } = await import('../src/application/friend-join.mjs');
    let current = 'Lobby';
    const events = [];
    const joins = createFriendJoins({
        links: { inviteCode: () => ({ state: 'gone' }) }, room: () => current,
        leave: async () => { events.push('leave'); current = null; return true; }, reload: () => events.push('reload'),
        show: () => events.push('show'), notify: () => events.push('notify'), name: () => 'Ben'
    });
    assert.equal(typeof joins.joinCode, 'function');
    assert.deepEqual(await joins.joinCode('asscrack3:CODE', 'Game night'), { result: 'confirm', room: 'Game night', current: 'Lobby' });
    assert.equal(joins.take(), null);
    assert.deepEqual(await joins.joinCode('asscrack3:CODE', 'Game night', true), { result: 'joining', room: 'Game night' });
    assert.deepEqual(events, ['leave', 'reload', 'show']);
    const taken = joins.take();
    assert.equal(taken.room, 'Game night');
    assert.ok(!JSON.stringify(taken).includes('CODE'));
    assert.equal(joins.take(), null);
    assert.equal(joins.code(taken.token), 'asscrack3:CODE');
    assert.equal(joins.code(taken.token), null);
});

test('clipboard window: "Join <room>?" with Join and Not now, the username step and "Leave <room> and join?"', async () => {
    const source = await readFile(new URL('../src/application/clipboard-join-ui.js', import.meta.url), 'utf8');
    const { document, window } = createDom([{ id: 'login-screen' }, { id: 'chat-screen', hidden: true }, { id: 'username', tag: 'input', value: '' }]);
    const calls = [];
    const answers = [{ result: 'confirm', room: 'Game night', current: 'Lobby' }, { result: 'joining', room: 'Game night' }];
    let listener = null;
    let prompt = { id: 'p1', room: 'Game night' };
    window.clipboardJoin = {
        take: async () => prompt,
        join: async (id, leave) => { calls.push([id, leave]); return answers.shift(); },
        dismiss: async id => { calls.push(['dismiss', id]); },
        onPrompt: callback => { listener = callback; }
    };
    window.window = window;
    vm.runInNewContext(source, { window, document, console, Promise });
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    await tick();
    const bar = document.getElementById('clipboard-join-bar');
    const text = () => document.getElementById('clipboard-join-text').textContent;
    const buttons = () => bar.querySelectorAll('button');
    assert.equal(bar.hidden, false);
    assert.equal(text(), 'Join Game night?');
    assert.deepEqual(buttons().map(b => b.textContent), ['Join', 'Not now']);
    // No username on the login screen: no Join call.
    buttons()[0].click();
    await tick();
    assert.equal(text(), 'Enter a username, then select Join.');
    assert.deepEqual(calls, []);
    document.getElementById('username').value = 'Ben';
    buttons()[0].click();
    await tick();
    assert.equal(text(), 'Leave Lobby and join Game night?');
    assert.deepEqual(buttons().map(b => b.textContent), ['Leave and join', 'Cancel']);
    buttons()[0].click();
    await tick();
    assert.deepEqual(calls, [['p1', false], ['p1', true]]);
    assert.equal(bar.hidden, true);
    // A new prompt, then Not now.
    prompt = { id: 'p2', room: 'Lobby' };
    listener(null);
    await tick();
    assert.equal(text(), 'Join Lobby?');
    buttons()[1].click();
    await tick();
    assert.equal(bar.hidden, true);
    assert.deepEqual(calls.at(-1), ['dismiss', 'p2']);
});
