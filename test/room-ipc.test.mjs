// OI2 (P10b): at Quit, the room window closes while node.stop() still sends events. refreshInvite then calls
// asscrack:invite from a frame that the check does not accept. That call must get null and no error line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function fakeIpc() {
    const handlers = new Map(), listeners = new Map();
    return { handlers, listeners,
        handle: (channel, fn) => handlers.set(channel, fn),
        on: (channel, fn) => listeners.set(channel, fn) };
}

test('a room query from a closed frame gets null, and a room handle call gets an error', async () => {
    const { createRoomIpc } = await import('../src/application/room-ipc.mjs');
    const ipc = fakeIpc();
    let open = true;
    const room = createRoomIpc(ipc, event => open && event.ok === true);
    room.query('q', (_event, x) => ({ x }));
    room.handle('h', (_event, x) => x * 2);
    const heard = [];
    room.on('o', (_event, x) => heard.push(x));
    assert.deepEqual(ipc.handlers.get('q')({ ok: true }, 1), { x: 1 });
    assert.equal(ipc.handlers.get('h')({ ok: true }, 2), 4);
    ipc.listeners.get('o')({ ok: true }, 'a');
    open = false;
    assert.equal(ipc.handlers.get('q')({ ok: true }, 1), null);
    assert.throws(() => ipc.handlers.get('h')({ ok: true }, 2), /Unknown room window/);
    ipc.listeners.get('o')({ ok: true }, 'b');
    assert.deepEqual(heard, ['a']);
});

test('main.js registers asscrack:invite as a room query, not as a room handle call', async () => {
    const source = await readFile(new URL('../src/application/main.js', import.meta.url), 'utf8');
    assert.ok(source.includes("queryRoomIpc('asscrack:invite'"), 'asscrack:invite is not a query');
    assert.ok(!source.includes("handleRoomIpc('asscrack:invite'"), 'asscrack:invite is still a handle call');
});
