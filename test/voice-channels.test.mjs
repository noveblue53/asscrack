// G6: voice channels. The catalog (pure, with real memberships) and the routing with real protected-room nodes.
// All results of this file are 127.0.0.1 results, not LAN results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey, readInvite } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'
import { createVoiceChannels, checkVoiceCatalog, MAX_VOICE_CHANNELS, ERRORS } from '../src/network/voice-channels.mjs'
import { MOVE_HOLD_MS } from '../src/network/voice-relay.mjs'
import { randomUUID } from 'node:crypto'

const room = 'Voice channel room'

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (await fn()) return
        await sleep(20)
    }
    throw new Error(`timeout: ${what}`)
}

// ---- Catalog (pure) ----

function owned() {
    const roomKey = newRoomKey()
    const ownerId = createDeviceIdentity()
    const owner = createRoomMembership({ identity: ownerId, room, roomKey, lan: true })
    const identity = createDeviceIdentity()
    const member = restoreRoomMembership({ identity, room, roomKey, descriptor: owner.issue(identity.id) })
    return { owner, member }
}

test('the owner creates, renames and deletes voice channels; seq goes up; a member and a legacy room cannot edit', () => {
    const { owner, member } = owned()
    const events = []
    const lines = []
    const own = createVoiceChannels({ membership: owner, send: msg => lines.push(msg), changed: e => events.push(e) })
    assert.deepEqual(own.view(), { owner: true, editable: true, seq: 0, channels: [{ id: 'general', name: 'General' }] })
    assert.equal(own.opened(), null, 'no catalog line at seq 0')
    const raid = own.create('  Raid ')
    assert.equal(own.seq(), 1)
    assert.deepEqual(own.view().channels, [{ id: 'general', name: 'General' }, { id: raid, name: 'Raid' }])
    assert.equal(lines.length, 1)
    assert.equal(lines[0].type, 'voice-channels')
    assert.equal(owner.verifyVoiceChannels(lines[0].catalog), true)
    assert.throws(() => own.create('raid'), { message: ERRORS.exists })
    assert.throws(() => own.create('general'), { message: ERRORS.exists })
    assert.throws(() => own.create(''), { message: ERRORS.name })
    assert.throws(() => own.create('x'.repeat(41)), { message: ERRORS.name })
    own.rename(raid, 'Raid night')
    assert.equal(own.seq(), 2)
    assert.equal(own.view().channels[1].name, 'Raid night')
    assert.throws(() => own.rename('general', 'Lobby'), { message: ERRORS.general })
    assert.throws(() => own.remove('general'), { message: ERRORS.general })
    const other = own.create('Lobby')
    assert.throws(() => own.rename(other, 'RAID NIGHT'), { message: ERRORS.exists })
    own.remove(raid)
    assert.equal(own.seq(), 4)
    assert.deepEqual(own.view().channels.map(c => c.name), ['General', 'Lobby'])
    assert.deepEqual(events.at(-1).removed, [{ id: raid, name: 'Raid night' }])
    assert.equal(events.at(-1).catalog.seq, 4)

    const mine = createVoiceChannels({ membership: member })
    assert.equal(mine.view().editable, false)
    assert.throws(() => mine.create('Mine'), { message: ERRORS.owner })
    assert.throws(() => member.signVoiceChannels({ seq: 1, channels: [] }), { message: ERRORS.owner })
    const legacy = createVoiceChannels({ membership: null })
    assert.throws(() => legacy.create('Raid'), { message: ERRORS.legacy })
    assert.deepEqual(legacy.view().channels, [{ id: 'general', name: 'General' }])
    assert.equal(legacy.receive(lines[0], 'x'), false, 'a legacy room keeps no catalog')
})

test('the owner can make at most 16 voice channels', () => {
    const { owner } = owned()
    const own = createVoiceChannels({ membership: owner })
    for (let i = 0; i < MAX_VOICE_CHANNELS; i++) own.create(`Room ${i}`)
    assert.throws(() => own.create('One more'), { message: ERRORS.limit })
    assert.equal(own.view().channels.length, MAX_VOICE_CHANNELS + 1)
})

test('a member keeps only a valid catalog with a higher seq', () => {
    const { owner, member } = owned()
    const own = createVoiceChannels({ membership: owner })
    const events = []
    const forwarded = []
    const mine = createVoiceChannels({ membership: member, send: (msg, except) => forwarded.push(except), changed: e => events.push(e) })
    own.create('Raid')
    const first = { type: 'voice-channels', v: 1, catalog: own.catalog() }
    assert.equal(mine.receive(first, 'owner-peer'), true)
    assert.deepEqual(forwarded, ['owner-peer'], 'sent on to the other sessions')
    assert.equal(mine.seq(), 1)
    assert.equal(mine.receive(first, 'other'), false, 'the same seq again')
    own.create('Lobby')
    const second = own.catalog()
    // The property order on the wire does not change the signed bytes.
    const shuffled = { ...second, channels: [...second.channels].reverse().map(({ id, name }) => ({ name, id })) }
    assert.equal(mine.receive({ v: 1, catalog: shuffled }, 'x'), true)
    assert.equal(mine.seq(), 2)
    assert.equal(mine.receive({ v: 1, catalog: first.catalog }, 'x'), false, 'a lower seq')

    // A bad signature: a changed name.
    const forged = structuredClone(second)
    forged.seq = 9
    assert.equal(mine.receive({ v: 1, catalog: forged }, 'x'), false, 'a signature over other fields')
    const renamed = structuredClone(second)
    renamed.channels[0].name = 'Evil'
    renamed.seq = 3
    renamed.signature = member.memberProof('n', 'a', 'b').signature
    assert.equal(mine.receive({ v: 1, catalog: renamed }, 'x'), false, 'a member signature')

    // A valid owner signature over a bad structure: 17 channels, or a double name.
    const many = Array.from({ length: 17 }, (_, i) => ({ id: randomUUID(), name: `C${i}` }))
    const big = { v: 1, seq: 10, channels: many, signature: owner.signVoiceChannels({ seq: 10, channels: many }) }
    assert.equal(owner.verifyVoiceChannels(big), true, 'the signature itself is valid')
    assert.equal(checkVoiceCatalog(big), null)
    assert.equal(mine.receive({ v: 1, catalog: big }, 'x'), false, '17 channels')
    const twice = [{ id: randomUUID(), name: 'Raid' }, { id: randomUUID(), name: 'RAID' }]
    const double = { v: 1, seq: 11, channels: twice, signature: owner.signVoiceChannels({ seq: 11, channels: twice }) }
    assert.equal(mine.receive({ v: 1, catalog: double }, 'x'), false, 'a double name')
    const general = [{ id: randomUUID(), name: 'General' }]
    const reserved = { v: 1, seq: 12, channels: general, signature: owner.signVoiceChannels({ seq: 12, channels: general }) }
    assert.equal(mine.receive({ v: 1, catalog: reserved }, 'x'), false, 'the name General')
    assert.equal(mine.seq(), 2)
    assert.equal(events.length, 2)

    // A seed: a valid saved catalog comes back, a forged one does not.
    assert.equal(createVoiceChannels({ membership: member, seed: second }).seq(), 2)
    assert.equal(createVoiceChannels({ membership: member, seed: forged }).seq(), 0)
})

// ---- Nodes ----

const fast = { heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350 }

function localAddress(node) {
    return node.getMultiaddrs().find(value => value.startsWith('/ip4/127.0.0.1/tcp/') && !value.includes('/p2p-circuit'))
}

async function protectedRoom(t, names) {
    const roomKey = newRoomKey()
    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: true })
    const nodes = []
    t.after(() => Promise.allSettled(nodes.map(node => node.stop())))
    async function start(membership, extra = {}) {
        const node = await createAsscrackNode({ room, roomKey, membership, discovery: false,
            listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: false, ...fast, ...extra })
        nodes.push(node)
        return node
    }
    const owner = await start(ownerMembership)
    const identities = new Map()
    async function member(extra = {}) {
        const identity = createDeviceIdentity()
        const invitation = readInvite(owner.createMemberInvite(identity.id, { canHost: false }))
        const membership = restoreRoomMembership({ identity, room, roomKey, descriptor: invitation.membership })
        const node = await start(membership, extra)
        identities.set(node, identity)
        await node.connect(localAddress(owner))
        await waitFor(() => node.peers().includes(owner.peerId) && node.memberState().admitted, 10000, 'member admitted')
        return node
    }
    const members = []
    for (let i = 0; i < names; i++) members.push(await member())
    return { owner, members, member, start, ownerMembership, roomKey, identities }
}

function record(node) {
    const got = []
    node.events.on('voice-frame', f => got.push({ origin: f.origin, seq: f.seq, at: performance.now() }))
    return got
}

const from = (got, node) => got.filter(f => f.origin === node.peerId)

async function talk(node, frames = 30) {
    let out = 0
    for (let i = 0; i < frames; i++) {
        if (node.sendVoiceFrame(new Uint8Array(80).fill(i & 0xff))) out++
        await sleep(20)
    }
    return out
}

test('127.0.0.1: the host forwards only inside a voice channel; direct streams only in one channel; the move hold', { timeout: 90000 }, async t => {
    const { owner: A, members: [B, C, D] } = await protectedRoom(t, 3)
    // A full TCP mesh of B, C and D: each pair can have a direct voice stream.
    for (const [x, y] of [[B, C], [B, D], [C, D]]) await x.connect(localAddress(y))
    await waitFor(() => [B, C, D].every(n => n.peers().length === 3), 15000, 'full mesh')
    await waitFor(() => [A, B, C, D].every(n => n.host()?.peerId === A.peerId), 15000, 'A is the host')

    const X = A.createVoiceChannel('Raid')
    await waitFor(() => [B, C, D].every(n => n.voiceChannels().seq === 1), 5000, 'the catalog reaches each member')
    assert.equal(B.voiceChannels().editable, false)
    assert.deepEqual(C.voiceChannels().channels.map(c => c.name), ['General', 'Raid'])

    const got = { A: record(A), B: record(B), C: record(C), D: record(D) }
    const states = []
    A.events.on('voice-state', s => states.push(s))
    B.setVoice({ inVoice: true, channel: X })
    C.setVoice({ inVoice: true, channel: X })
    D.setVoice({ inVoice: true })
    await waitFor(() => states.filter(s => s.inVoice).length >= 3, 5000, 'three voice lines on the host')
    assert.deepEqual(states.filter(s => s.peerId === B.peerId).at(-1).channel, X)
    assert.deepEqual(states.filter(s => s.peerId === D.peerId).at(-1).channel, 'general')
    await waitFor(() => B.voiceStats().directStreams === 1 && C.voiceStats().directStreams === 1, 10000, 'B-C direct streams')
    await sleep(300)
    assert.equal(D.voiceStats().directStreams, 0, 'D has no direct stream')
    assert.equal(D.voiceStats().directIn, 0, 'D gets no direct stream')
    assert.equal(B.voiceStats().directIn, 1, 'B gets one direct stream (from C)')

    // B talks in X: C gets the frames, D does not (also not through the host).
    await talk(B, 50)
    await waitFor(() => from(got.C, B).length >= 45, 5000, 'C gets the frames of B')
    await sleep(300)
    assert.equal(from(got.D, B).length, 0, 'D gets no frame of B')
    assert.equal(A.voiceStats().forwardedTo[B.peerId]?.[D.peerId], undefined, 'the host forwards no frame of B to D')
    assert.ok(from(got.A, B).length >= 45, 'the host that is not in voice gets the frames (as before)')
    await talk(D, 20)
    await sleep(300)
    assert.equal(from(got.B, D).length + from(got.C, D).length, 0, 'B and C get no frame of D')

    // D moves to X. The frames of the first 250 ms do not go out.
    const heldBefore = D.voiceStats().heldFrames
    const moveAt = performance.now()
    D.setVoice({ inVoice: true, channel: X })
    const attempts = []
    while (performance.now() - moveAt < MOVE_HOLD_MS + 150) {
        attempts.push({ at: performance.now() - moveAt, out: D.sendVoiceFrame(new Uint8Array(80)) })
        await sleep(10)
    }
    const early = attempts.filter(a => a.at < MOVE_HOLD_MS - 5)
    assert.ok(early.length > 5, 'frames in the hold')
    assert.ok(early.every(a => !a.out), 'no frame goes out in the first 250 ms after the move')
    const firstOut = attempts.find(a => a.out)
    assert.ok(firstOut && firstOut.at >= MOVE_HOLD_MS, 'the first frame after the hold goes out')
    console.log(`127.0.0.1 move hold: ${D.voiceStats().heldFrames - heldBefore} frames held, first frame out ` +
        `${firstOut.at.toFixed(0)} ms after the move`)
    await waitFor(() => D.voiceStats().directStreams === 2, 10000, 'D opens direct streams to B and C')
    const dFromB = from(got.D, B).length
    await talk(B, 30)
    await waitFor(() => from(got.D, B).length >= dFromB + 25, 5000, 'D gets the frames of B after the move')

    // B moves out of X to General. No frame that B sends after the move reaches C or D.
    const bSeq = B.voiceStats().seq
    B.setVoice({ inVoice: true, channel: 'general' })
    await sleep(MOVE_HOLD_MS + 20)
    const bOut = await talk(B, 40)
    assert.ok(bOut > 0, 'B sends frames in General (to the host)')
    await sleep(400)
    assert.equal(from(got.C, B).filter(f => f.seq >= bSeq).length, 0, 'C gets no frame of B after the move')
    assert.equal(from(got.D, B).filter(f => f.seq >= bSeq).length, 0, 'D gets no frame of B after the move')
    assert.equal(B.voiceStats().directStreams, 0, 'B closes its direct streams')

    // A host in General plays no frame of X. Its own frames go only to General (B).
    A.setVoice({ inVoice: true })
    await sleep(200)
    const aFromC = from(got.A, C).length
    await talk(C, 30)
    await waitFor(() => from(got.D, C).length >= 25, 5000, 'D gets the frames of C')
    await sleep(300)
    assert.equal(from(got.A, C).length, aFromC, 'the host in General delivers no frame of X')
    assert.equal(from(got.B, C).length > 0 && from(got.B, C).some(f => f.seq >= bSeq), false)
    await talk(A, 30)
    await waitFor(() => from(got.B, A).length >= 25, 5000, 'B gets the frames of the host')
    await sleep(300)
    assert.equal(from(got.C, A).length + from(got.D, A).length, 0, 'C and D get no frame of the host')
})

test('127.0.0.1: a delete moves the members of that channel to General; a late joiner gets the catalog; a seed restores it', { timeout: 60000 }, async t => {
    const { owner: A, members: [B, C], member, start, roomKey, identities } = await protectedRoom(t, 2)
    await waitFor(() => [A, B, C].every(n => n.host()?.peerId === A.peerId), 15000, 'A is the host')
    const X = A.createVoiceChannel('Raid')
    A.renameVoiceChannel(X, 'Raid night')
    await waitFor(() => [B, C].every(n => n.voiceChannels().seq === 2), 5000, 'the catalog reaches each member')
    assert.throws(() => B.createVoiceChannel('Mine'), { message: ERRORS.owner })
    assert.throws(() => B.deleteVoiceChannel(X), { message: ERRORS.owner })

    const lines = []
    A.events.on('voice-state', s => lines.push(s))
    const moved = []
    B.events.on('voice-channels', e => { if (e.movedFrom) moved.push(e.movedFrom) })
    B.setVoice({ inVoice: true, channel: X, muted: true })
    C.setVoice({ inVoice: true })
    await waitFor(() => lines.some(s => s.peerId === B.peerId && s.channel === X), 5000, 'B is in X')
    A.deleteVoiceChannel(X)
    await waitFor(() => lines.some(s => s.peerId === B.peerId && s.inVoice && s.channel === 'general'), 5000,
        'the voice line of B says general')
    assert.equal(B.voiceChannel(), 'general')
    assert.equal(lines.filter(s => s.peerId === B.peerId).at(-1).muted, true, 'the move keeps the mute state')
    assert.deepEqual(moved, [{ id: X, name: 'Raid night' }])
    assert.equal(B.voiceChannels().seq, 3)

    // A late joiner gets the catalog on its new session.
    const Y = A.createVoiceChannel('Lobby')
    const E = await member()
    await waitFor(() => E.voiceChannels().seq === 4, 5000, 'the late joiner gets the catalog')
    assert.deepEqual(E.voiceChannels().channels, [{ id: 'general', name: 'General' }, { id: Y, name: 'Lobby' }])
    // A channel that is not in the catalog is General.
    E.setVoice({ inVoice: true, channel: X })
    assert.equal(E.voiceChannel(), 'general')

    // The saved catalog comes back at a new start of B, with no session (main.js gives it from the archive).
    const saved = B.voiceChannelCatalog()
    const snapshot = B.membershipSnapshot()
    await B.stop()
    const identity = identities.get(B)
    const again = await start(restoreRoomMembership({ identity, room, roomKey, descriptor: snapshot }), { seedVoiceChannels: saved })
    assert.equal(again.peers().length, 0)
    assert.equal(again.voiceChannels().seq, 4)
    assert.deepEqual(again.voiceChannels().channels.map(c => c.name), ['General', 'Lobby'])
    // A forged seed is not kept.
    const forged = { ...saved, seq: 99 }
    const other = await start(restoreRoomMembership({ identity: identities.get(C), room, roomKey, descriptor: C.membershipSnapshot() }),
        { seedVoiceChannels: forged })
    assert.equal(other.voiceChannels().seq, 0)

    // A legacy room has only General.
    const legacy = await createAsscrackNode({ room, roomKey: newRoomKey(), discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'],
        seedVoiceChannels: saved, ...fast })
    t.after(() => legacy.stop())
    assert.deepEqual(legacy.voiceChannels().channels, [{ id: 'general', name: 'General' }])
    assert.throws(() => legacy.createVoiceChannel('Raid'), { message: ERRORS.legacy })
})
