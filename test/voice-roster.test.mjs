// M4 (P10b): each member sends its own voice line on each session, and the host forwards voice frames to the members
// that it knows from these lines. A changed client could tell the host "in voice" and tell the other members "not in
// voice". It then got the frames of a channel and stayed hidden. The fix: the host sends its voice roster (the members
// with a voice stream to it) to each session, and the window shows such a member as listening. The host also forwards
// no frame to a member that is deafened in its voice line to the host. All results are 127.0.0.1 results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { multiaddr } from '@multiformats/multiaddr'
import { createAsscrackNode, VOICE_PROTOCOL } from '../src/network/node.mjs'
import { newRoomKey, readInvite } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'

const fast = { discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: false, heartbeatInterval: 100, hostTimeout: 700, electionDelay: 300 }

async function waitFor(check, what, ms = 10000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (check()) return
        await delay(20)
    }
    assert.ok(check(), `timeout: ${what}`)
}

// The owner O is the only host (the members cannot host). M is a member with a changed client: it sends its voice line
// only to O (sendTo) and opens the voice stream to O by hand. P is a member that never gets a voice line of M.
async function room(t) {
    const room = 'M4 room', roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    const start = async opts => { const n = await createAsscrackNode({ room, roomKey, ...fast, ...opts }); nodes.push(n); return n }
    const O = await start({ membership: createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: true }), name: 'Owner' })
    const addr = n => n.getMultiaddrs().find(a => a.startsWith('/ip4/127.0.0.1/'))
    async function member(name) {
        const identity = createDeviceIdentity()
        const invite = readInvite(O.createMemberInvite(identity.id, { canHost: false }))
        const n = await start({ membership: restoreRoomMembership({ identity, room, roomKey, descriptor: invite.membership }), name })
        await n.connect(addr(O))
        await waitFor(() => n.peers().includes(O.peerId) && n.memberState().admitted, `${name} admitted`)
        return n
    }
    const M = await member('Mallory')
    const P = await member('Pat')
    await P.connect(addr(M))
    await waitFor(() => P.peers().includes(M.peerId) && [M, P].every(n => n.host()?.peerId === O.peerId), 'sessions and host')
    return { O, M, P, addr }
}

// M listens: a voice line to O only, then a voice stream to O that stays open.
async function hiddenListener(O, M, addr, extra = {}) {
    assert.equal(M.sendTo(O.peerId, { type: 'voice', inVoice: true, streamId: null, muted: true, deafened: false, channel: 'general', ...extra }), true)
    await delay(100)
    const stream = await M.libp2p.dialProtocol(multiaddr(addr(O)), VOICE_PROTOCOL)
    stream.sink((async function * () { await delay(20000) })()).catch(() => {})
    return stream
}

test('M4: 127.0.0.1: a member that tells only the host that it is in voice is in the roster that the other members get', { timeout: 30000 }, async t => {
    const { O, M, P, addr } = await room(t)
    const rosters = []
    P.events.on('voice-roster', r => rosters.push(r))
    const last = () => rosters.at(-1) ?? { hostId: null, members: [] }
    P.setVoice({ inVoice: true })
    await waitFor(() => last().members.some(m => m.peerId === P.peerId), 'P is in the roster')
    const stream = await hiddenListener(O, M, addr)
    await waitFor(() => last().members.some(m => m.peerId === M.peerId), 'M is in the roster of P')
    assert.deepEqual(last().members.find(m => m.peerId === M.peerId), { peerId: M.peerId, channel: 'general' })
    assert.equal(last().hostId, O.peerId)
    assert.deepEqual(P.voiceRoster(), last())
    // P has no voice line of M: the window shows M as listening (the window test is below).
    stream.abort?.(new Error('done'))
    await waitFor(() => !last().members.some(m => m.peerId === M.peerId), 'M left the roster')
})

test('M4: 127.0.0.1: the host forwards no frame to a member that is deafened in its voice line', { timeout: 30000 }, async t => {
    const { O, M, P, addr } = await room(t)
    P.setVoice({ inVoice: true })
    await hiddenListener(O, M, addr, { deafened: true })
    await waitFor(() => O.voiceStats().streams === 2, 'two voice streams on O')
    let atHost = 0
    O.events.on('voice-frame', f => { if (f.origin === P.peerId) atHost++ })
    for (let i = 0; i < 30; i++) {
        P.sendVoiceFrame(new Uint8Array(80))
        await delay(20)
    }
    await waitFor(() => atHost >= 25, 'O got the frames of P')
    await delay(300)
    assert.equal(O.voiceStats().forwardedTo[P.peerId]?.[M.peerId] ?? 0, 0)
})

test('M4: the window shows a member of the roster with no voice line as listening', async () => {
    const { loadRoomWindow, settle } = await import('./helpers/renderer-fixture.mjs')
    const f = await loadRoomWindow()
    await f.login('Reader')
    f.handlers.onPeerJoined({ peerId: 'peer-m' })
    f.handlers.onPeerName({ peerId: 'peer-m', name: 'Mallory' })
    await settle()
    const state = () => f.el('peers').children.find(li => li.dataset.peerId === 'peer-m').querySelector('.voice-state').textContent
    assert.equal(state(), 'not in voice')
    f.handlers.onVoiceRoster({ hostId: 'host', members: [{ peerId: 'peer-m', channel: 'general' }] })
    await settle()
    assert.match(state(), /^listening \(not in voice for you\)/)
    f.handlers.onVoiceRoster({ hostId: 'host', members: [] })
    await settle()
    assert.equal(state(), 'not in voice')
})
