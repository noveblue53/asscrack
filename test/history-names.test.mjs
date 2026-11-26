// M1 (P10a), items 1 and 2 (a partial fix). A member applied the history of the host with no check of the sender. A
// canHost member could take the host role with a high term and put lines under the name of the owner, or of any
// member, into the history of each member. All results of this file are 127.0.0.1 results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
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

test('M1: 127.0.0.1: a forged history of a canHost host shows the known device names; an unknown device is marked; no prefix is dropped', { timeout: 30000 }, async t => {
    const room = 'M1 room', roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    const start = async opts => { const n = await createAsscrackNode({ room, roomKey, ...fast, ...opts }); nodes.push(n); return n }
    const ownerId = createDeviceIdentity()
    const O = await start({ membership: createRoomMembership({ identity: ownerId, room, roomKey, lan: true }), name: 'Owner' })
    const addr = n => n.getMultiaddrs().find(a => a.startsWith('/ip4/127.0.0.1/'))
    async function member(name, canHost) {
        const identity = createDeviceIdentity()
        const invite = readInvite(O.createMemberInvite(identity.id, { canHost }))
        const n = await start({ membership: restoreRoomMembership({ identity, room, roomKey, descriptor: invite.membership }), name })
        await n.connect(addr(O))
        await waitFor(() => n.peers().includes(O.peerId) && n.memberState().admitted, `${name} admitted`)
        return { n, device: identity.id }
    }
    const { n: M, device: mDevice } = await member('Mallory', true)
    const { n: P } = await member('Pat', false)
    await P.connect(addr(M))
    await waitFor(() => P.peers().includes(M.peerId) && M.peers().includes(P.peerId), 'P and M have a session')
    await waitFor(() => P.peerNames()[O.peerId] === 'Owner' && P.peerNames()[M.peerId] === 'Mallory', 'P knows the names')
    // M takes the host role for P with a high term, then sends a forged replay.
    M.sendTo(P.peerId, { type: 'host', host: M.peerId, term: Number.MAX_SAFE_INTEGER - 2 })
    await waitFor(() => P.host()?.peerId === M.peerId, 'P accepts M as the host')
    const time = Date.now()
    const own = { id: `${mDevice}.${randomUUID()}`, from: 'Owner', text: 'M device, name Owner', time }
    const unknown = { id: `${createDeviceIdentity().id}.${randomUUID()}`, from: 'Owner', text: 'unknown device', time: time + 1 }
    const bare = { id: randomUUID(), from: 'Owner', text: 'no device prefix', time: time + 2 }
    const owner = { id: `${ownerId.id}.${randomUUID()}`, from: 'Someone', text: 'owner device, name Someone', time: time + 3 }
    assert.equal(M.sendTo(P.peerId, { type: 'history', messages: [own, unknown, bare, owner] }), true)
    await waitFor(() => P.history().some(m => m.id === owner.id), 'P applied the history')
    const byId = Object.fromEntries(P.history().map(m => [m.id, m]))
    assert.equal(byId[own.id].from, 'Mallory', 'the name that P knows for the device of M')
    assert.equal(byId[own.id].unverified, undefined)
    assert.equal(byId[owner.id].from, 'Owner', 'the name that P knows for the owner device')
    assert.equal(byId[unknown.id].from, 'Owner')
    assert.equal(byId[unknown.id].unverified, true, 'a device that P does not know is marked')
    assert.equal(byId[bare.id], undefined, 'an item with no device prefix is dropped')
})

// M1: the window marks a history line of an unknown device. The line is never an own line, and it does not group
// with a verified line of the same name.
test('M1: the window marks an unverified history line, never as an own line, and does not group it', async () => {
    const { loadRoomWindow, settle } = await import('./helpers/renderer-fixture.mjs')
    const f = await loadRoomWindow()
    await f.login('Reader')
    f.history([
        { id: 'a', from: 'Owner', text: 'real line', time: 1000 },
        { id: 'b', from: 'Owner', text: 'forged line', time: 1001, unverified: true },
        { id: 'c', from: 'Reader', text: 'forged own line', time: 1002, unverified: true }
    ])
    await settle()
    const row = id => f.rows().find(r => r.dataset.id === id)
    assert.equal(row('a').classList.contains('unverified'), false)
    assert.equal(row('b').classList.contains('unverified'), true)
    assert.equal(row('b').querySelector('.from').classList.contains('unverified'), true)
    assert.equal(row('b').querySelector('.from').textContent, 'Owner', 'the mark is CSS, not text')
    assert.equal(row('b').classList.contains('cont'), false, 'no group with the verified line')
    assert.equal(row('c').classList.contains('own'), false, 'an unverified line with the own name is not an own line')
})

test('M1: 127.0.0.1: host backfill rejects third-party device prefixes and enforces verified session name', { timeout: 30000 }, async t => {
    const room = 'M1 backfill room', roomKey = newRoomKey()
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(n => n.stop())))
    const start = async opts => { const n = await createAsscrackNode({ room, roomKey, ...fast, ...opts }); nodes.push(n); return n }
    const ownerId = createDeviceIdentity()
    const O = await start({ membership: createRoomMembership({ identity: ownerId, room, roomKey, lan: true }), name: 'Owner' })
    const addr = n => n.getMultiaddrs().find(a => a.startsWith('/ip4/127.0.0.1/'))
    async function member(name) {
        const identity = createDeviceIdentity()
        const invite = readInvite(O.createMemberInvite(identity.id, { canHost: false }))
        const n = await start({ membership: restoreRoomMembership({ identity, room, roomKey, descriptor: invite.membership }), name })
        await n.connect(addr(O))
        await waitFor(() => n.peers().includes(O.peerId) && n.memberState().admitted, `${name} admitted`)
        return { n, device: identity.id }
    }
    const { n: P, device: pDevice } = await member('Pat')
    const { n: M, device: mDevice } = await member('Mallory')
    await waitFor(() => O.isHost() && P.host()?.peerId === O.peerId && M.host()?.peerId === O.peerId, 'O is host for both')
    await waitFor(() => O.peerNames()[P.peerId] === 'Pat', 'O knows Pat')

    const time = Date.now()
    const forgedOwner = { id: `${ownerId.id}.${randomUUID()}`, from: 'Owner', text: 'forged owner', time }
    const forgedMallory = { id: `${mDevice}.${randomUUID()}`, from: 'Mallory', text: 'forged mallory', time: time + 1 }
    const forgedUnknown = { id: `${createDeviceIdentity().id}.${randomUUID()}`, from: 'Someone', text: 'forged unknown', time: time + 2 }
    const forgedBare = { id: randomUUID(), from: 'Owner', text: 'forged bare', time: time + 3 }
    const ownFakeFrom = { id: `${pDevice}.${randomUUID()}`, from: 'Owner', text: 'own backfill', time: time + 4 }

    assert.equal(P.sendTo(O.peerId, {
        type: 'history',
        messages: [forgedOwner, forgedMallory, forgedUnknown, forgedBare, ownFakeFrom]
    }), true)

    await waitFor(() => O.history().some(m => m.id === ownFakeFrom.id), 'O accepted Pat own backfill')
    await waitFor(() => M.history().some(m => m.id === ownFakeFrom.id), 'M received forwarded backfill')

    for (const node of [O, M]) {
        const byId = Object.fromEntries(node.history().map(m => [m.id, m]))
        assert.equal(byId[ownFakeFrom.id].from, 'Pat')
        assert.equal(byId[ownFakeFrom.id].unverified, node === O ? undefined : true)
        assert.equal(byId[forgedOwner.id], undefined)
        assert.equal(byId[forgedMallory.id], undefined)
        assert.equal(byId[forgedUnknown.id], undefined)
        assert.equal(byId[forgedBare.id], undefined)
    }
})
