// G4 (C2): the deafened field of the voice line. A 127.0.0.1 result, not a LAN result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAsscrackNode } from '../src/network/node.mjs';
import { newRoomKey } from '../src/network/invite.mjs';

async function waitFor(check, what) {
    const end = Date.now() + 5000;
    while (!check() && Date.now() < end) await delay(20);
    assert.ok(check(), what);
}

test('127.0.0.1: setVoice with deafened true gives a voice-state event with deafened true on the other node', { timeout: 20000 }, async () => {
    const options = { room: 'deafen', roomKey: newRoomKey(), listen: ['/ip4/127.0.0.1/tcp/0'],
        heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 500, discovery: false };
    const nodes = [];
    try {
        const host = await createAsscrackNode({ ...options, fullNode: true });
        nodes.push(host);
        const member = await createAsscrackNode({ ...options, relayOnly: true, fullNode: false });
        nodes.push(member);
        await member.connect(host.getMultiaddrs()[0]);
        await waitFor(() => nodes.every(node => node.host()?.peerId === host.peerId), 'one host');
        const states = [];
        host.events.on('voice-state', state => { if (state.peerId === member.peerId) states.push(state); });

        member.setVoice({ inVoice: true, muted: true, deafened: true });
        await waitFor(() => states.length === 1, 'first voice state');
        assert.equal(states[0].inVoice, true);
        assert.equal(states[0].muted, true);
        assert.equal(states[0].deafened, true);

        member.setVoice({ inVoice: true, muted: false });
        await waitFor(() => states.length === 2, 'second voice state');
        assert.equal(states[1].deafened, false, 'no deafened field: false');

        // Out of voice a node is not deafened.
        member.setVoice({ inVoice: false, deafened: true });
        await waitFor(() => states.length === 3, 'third voice state');
        assert.equal(states[2].inVoice, false);
        assert.equal(states[2].deafened, false);
    } finally {
        await Promise.allSettled(nodes.map(node => node.stop()));
    }
});
