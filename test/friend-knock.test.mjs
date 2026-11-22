// easy-join part 3: the friend knock (friend row Join), with no network. The friend link is an in-memory pipe here. The
// 127.0.0.1 node tests are in friend-knock-node.test.mjs.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import { makeMemberInvite, newRoomKey } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, knockAccess } from '../src/network/room-membership.mjs'
import { checkFriendAllowedInvite, createKnockDesk, createKnocker, FRIEND_KNOCK_CODE } from '../src/network/knock.mjs'
import { createKnockRelay, isFriendKnockLine, readRoomLine, roomLine, startFriendKnock } from '../src/network/friend-knock.mjs'
import { deviceMark } from '../src/network/device-mark.mjs'
import { knockResultText } from '../src/application/login-errors.mjs'

const room = 'Game night'
const NODES = [{ id: '12D3KooWFYQJyQtUQQSSPCcrznePVTc5jdQqKkQYaaMV5bpn9GQq', addrs: ['/ip4/203.0.113.5/tcp/47000'] }]
const tick = () => new Promise(resolve => setImmediate(resolve))

function ownerRoom({ lan = true } = {}) {
    const roomKey = newRoomKey()
    const identity = createDeviceIdentity()
    const membership = createRoomMembership({ identity, room, roomKey, lan })
    return { roomKey, identity, membership, lan }
}

// The owner desk with the device invite of Allow (as node.mjs makes it).
function desk(o, options = {}) {
    const prompts = []
    const d = createKnockDesk({
        membership: o.membership,
        makeInvite: deviceId => makeMemberInvite({ room, key: o.roomKey, nodes: o.lan ? [] : NODES, membership: o.membership.issue(deviceId, false) }),
        changed: ({ added }) => { if (added) prompts.push(added) },
        ...options
    })
    return { desk: d, prompts }
}

// The joiner, a friend relay and a route to the owner, joined by in-memory pipes. route(handlers) is the connect of the
// relay (the own desk of the owner, a forward, or null).
function pipe({ o, joiner = createDeviceIdentity(), name = 'Ben', connect, relayLimits }) {
    const wire = []
    let knock = null
    const relay = createKnockRelay({
        send: line => { wire.push({ to: 'joiner', line }); queueMicrotask(() => knock.handle(line)); return true },
        connect, limits: relayLimits
    })
    const states = []
    knock = startFriendKnock({
        room: { id: o.membership.roomId, owner: o.identity.id, name: room, route: 'owner' }, identity: joiner, name,
        send: line => { wire.push({ to: 'friend', line }); queueMicrotask(() => relay.handle(line)); return true },
        onState: state => states.push(state)
    })
    return { knock, relay, wire, states, joiner }
}

// The connect of the owner: the own desk with { friend: true }.
const ownDesk = (d, source = 'friend:x') => ({ toJoiner, ended }) => {
    const handler = d.open({ send: line => { toJoiner(line); return true }, end: () => ended() }, { source, via: 'friend', friend: true })
    return { send: line => handler.receive(line), end: () => handler.closed() }
}

test('friend knock to the owner: the same proofs; Allow gives a device invite for the joiner with no host rights', async () => {
    const o = ownerRoom()
    const { desk: d, prompts } = desk(o)
    const p = pipe({ o, connect: ownDesk(d) })
    await tick()
    assert.equal(prompts.length, 1, 'the owner sees the prompt')
    assert.equal(prompts[0].name, 'Ben')
    assert.equal(prompts[0].mark, deviceMark(p.joiner.id))
    assert.equal(prompts[0].deviceId, p.joiner.id)
    assert.deepEqual(p.states, ['waiting'])
    // The hello names the room ID and the friend code, never a room code ID.
    const hello = p.wire.find(w => w.to === 'friend').line
    assert.equal(hello.op, 'knock')
    assert.equal(hello.line.type, 'knock-hello')
    assert.equal(hello.line.code, FRIEND_KNOCK_CODE)
    assert.equal(hello.line.room, o.membership.roomId)
    assert.equal(d.answer(prompts[0].id, true), true)
    const outcome = await p.knock.result
    assert.equal(outcome.result, 'allowed')
    const invite = checkFriendAllowedInvite({ roomId: o.membership.roomId, owner: o.identity.id }, p.joiner, outcome.invite)
    assert.equal(invite.membership.grant.deviceId, p.joiner.id)
    assert.equal(invite.membership.grant.canHost, false)
    // The answer for another room ID, another owner or another device is refused.
    assert.throws(() => checkFriendAllowedInvite({ roomId: ownerRoom().membership.roomId, owner: o.identity.id }, p.joiner, outcome.invite), /not valid/)
    assert.throws(() => checkFriendAllowedInvite({ roomId: o.membership.roomId, owner: createDeviceIdentity().id }, p.joiner, outcome.invite), /not valid/)
    assert.throws(() => checkFriendAllowedInvite({ roomId: o.membership.roomId, owner: o.identity.id }, createDeviceIdentity(), outcome.invite), /not valid/)
    await tick()
    assert.equal(p.relay.count(), 0, 'the relay has no open knock after the end')
})

test('friend knock to the owner: Deny gives "The owner declined."', async () => {
    const o = ownerRoom()
    const { desk: d, prompts } = desk(o)
    const p = pipe({ o, connect: ownDesk(d) })
    await tick()
    d.answer(prompts[0].id, false)
    const outcome = await p.knock.result
    assert.deepEqual(outcome, { result: 'denied' })
    assert.equal(knockResultText(outcome), 'The owner declined.')
})

test('friend knock: no route to the owner (the owner is not online) gives "Owner is offline. Try again later."', async () => {
    const o = ownerRoom()
    const p = pipe({ o, connect: () => null })
    const outcome = await p.knock.result
    assert.deepEqual(outcome, { result: 'offline' })
    assert.equal(knockResultText(outcome), 'Owner is offline. Try again later.')
    // An async route that resolves null: the same.
    const q = pipe({ o, connect: async () => null })
    assert.deepEqual(await q.knock.result, { result: 'offline' })
})

test('the code field: only a channel with { friend: true } takes FRIEND_KNOCK_CODE; a room code channel gets old-code', async () => {
    const o = ownerRoom()
    const { desk: d, prompts } = desk(o)
    const sent = []
    const channel = { send: line => { sent.push(line); return true }, end: () => {} }
    // A knock stream of a peer that is not admitted (node.mjs opens it with no friend flag).
    const handler = d.open(channel, { source: 'p1', via: '1.2.3.4' })
    const knocker = createKnocker({ code: { codeId: FRIEND_KNOCK_CODE }, access: knockAccess(o.membership.roomId, o.identity.id),
        identity: createDeviceIdentity(), name: 'Eve' })
    handler.receive(knocker.hello())
    assert.deepEqual(sent, [{ type: 'knock-result', result: 'refused', reason: 'old-code' }])
    // A friend channel refuses a real code ID (only the friend code).
    const sent2 = []
    const friend = d.open({ send: line => { sent2.push(line); return true }, end: () => {} }, { source: 'f', via: 'friend', friend: true })
    o.membership.roomCode()
    friend.receive({ type: 'knock-hello', v: 1, room: o.membership.roomId, code: o.membership.roomCode().id, nonce: 'n'.repeat(24) })
    assert.deepEqual(sent2, [{ type: 'knock-result', result: 'refused', reason: 'old-code' }])
    assert.equal(prompts.length, 0)
})

test('the room announce line: room ID, owner device ID, name and route; no key, no code and no address', () => {
    const o = ownerRoom()
    const line = roomLine({ id: o.membership.roomId, owner: o.identity.id, name: room, route: 'owner' })
    assert.equal(isFriendKnockLine(line), true)
    const text = JSON.stringify(line)
    assert.ok(!text.includes(o.roomKey) && !text.includes('asscrack3:') && !text.includes('/ip4/'), 'no key, no code, no address')
    assert.deepEqual(readRoomLine(line), { id: o.membership.roomId, owner: o.identity.id, name: room, route: 'owner' })
    assert.equal(readRoomLine(roomLine(null)), null)
    assert.equal(readRoomLine({ room: { id: 'x', owner: o.identity.id, name: room, route: 'owner' } }), null)
    assert.equal(readRoomLine({ room: { id: o.membership.roomId, owner: o.identity.id, name: room, route: 'host' } }), null)
    assert.equal(readRoomLine({ room: { id: o.membership.roomId, owner: o.identity.id, name: '‮  ', route: 'none' } }), null)
    assert.equal(isFriendKnockLine({ type: 'pm', v: 1, op: 'msg' }), false)
})

test('friend relay limits: one open knock for each friend link, the line cap, and the end when the session closes', async () => {
    const o = ownerRoom()
    const sent = []
    const opened = []
    const relay = createKnockRelay({ send: line => { sent.push(line); return true },
        connect: () => { const route = { lines: [], ended: false, send: line => route.lines.push(line), end: () => { route.ended = true } }; opened.push(route); return route } })
    const hello = kid => ({ type: 'pm', v: 1, op: 'knock', kid, line: { type: 'knock-hello', v: 1, room: o.membership.roomId, code: FRIEND_KNOCK_CODE, nonce: 'a'.repeat(24) } })
    const kid1 = 'A'.repeat(22), kid2 = 'B'.repeat(22)
    relay.handle(hello(kid1))
    await tick()
    assert.equal(opened.length, 1)
    assert.equal(opened[0].lines.length, 1, 'the relay does not change the line')
    assert.deepEqual(opened[0].lines[0], hello(kid1).line)
    relay.handle(hello(kid2))
    assert.deepEqual(sent.slice(-2), [{ type: 'pm', v: 1, op: 'knock', kid: kid2, line: { type: 'knock-result', result: 'refused', reason: 'pending' } },
        { type: 'pm', v: 1, op: 'knock-end', kid: kid2 }])
    // A line over the cap ends the knock.
    relay.handle({ type: 'pm', v: 1, op: 'knock', kid: kid1, line: { type: 'knock', pad: 'x'.repeat(3000) } })
    assert.equal(opened[0].ended, true)
    assert.equal(relay.count(), 0)
    // The session closes: each knock ends with no line.
    relay.handle(hello(kid2))
    await tick()
    const before = sent.length
    relay.closed()
    assert.equal(opened[1].ended, true)
    assert.equal(sent.length, before)
    // A line that is not a hello with an unknown kid: no route.
    relay.handle({ type: 'pm', v: 1, op: 'knock', kid: 'C'.repeat(22), line: { type: 'knock' } })
    assert.equal(opened.length, 2)
})

test('window: the friend row texts, the Join and "Ask" states, the menu item', async () => {
    const load = async file => {
        const context = { window: {} }
        vm.createContext(context)
        vm.runInContext(await readFile(new URL(`../src/application/${file}`, import.meta.url), 'utf8'), context)
        return context.window
    }
    const { friendsCore } = await load('friends-ui.js')
    assert.equal(friendsCore.stateText({ state: 'online', join: { room: 'Game night', ask: false } }), 'Online · in Game night')
    assert.equal(friendsCore.stateText({ state: 'online', availability: 'away', note: '', join: { room: 'R', ask: true } }), 'Online · Away · in R')
    assert.equal(friendsCore.askText('Ann'), 'Ask Ann for an invite')
    assert.equal(friendsCore.knockStateText('looking', 'R'), 'Looking for the owner of R…')
    assert.equal(friendsCore.knockStateText('waiting', 'R'), 'Waiting for the owner of R…')
    assert.equal(friendsCore.joinText({ result: 'joining', room: 'R' }, 'Ann'), 'Allowed. Joining R…')
    assert.equal(friendsCore.joinText({ result: 'knock', text: 'The owner declined.' }, 'Ann'), 'The owner declined.')
    assert.equal(friendsCore.joinText({ result: 'ask' }, 'Ann'), 'Ask Ann for an invite.')
    const { menuCore } = await load('menu.js')
    assert.equal(JSON.stringify(menuCore.actionsFor({ kind: 'friend', join: true, invite: false })),
        JSON.stringify(['friend-open', 'friend-join', 'friend-rename', 'friend-remove', 'friend-block']))
    assert.equal(menuCore.label('friend-join'), 'Join room')
})

test('friend-join.mjs knock(): in a room it asks first; the room stays during the knock; Allow leaves and gives a one-time token', async () => {
    const { createFriendJoins } = await import('../src/application/friend-join.mjs')
    let current = 'Lobby', left = 0, reloads = 0, notes = 0
    const flags = []
    let answer = { result: 'allowed', invite: 'asscrack3:CODE', room: 'Game night' }
    const target = { F1: { state: 'ok', room: 'Game night', roomId: 'r1' }, F2: { state: 'ask', room: 'Other', roomId: 'r2' },
        F3: { state: 'ok', room: 'Saved', roomId: 'saved' } }
    const links = {
        joinTarget: id => target[id] ?? { state: 'gone', room: '', roomId: null },
        knock: async (id, { name }) => { flags.push(['knock', id, name, current]); return answer }
    }
    const joins = createFriendJoins({ links, room: () => current, leave: async () => { left += 1; current = null; return true },
        reload: () => { reloads += 1 }, notify: () => { notes += 1 }, name: () => 'Ben',
        knocking: on => flags.push(['knocking', on]), savedRoom: roomId => roomId === 'saved' })
    assert.deepEqual(await joins.knock('F1'), { result: 'confirm', room: 'Game night', current: 'Lobby' })
    assert.deepEqual(await joins.knock('F2'), { result: 'ask', room: 'Other' })
    assert.deepEqual(await joins.knock('F9'), { result: 'gone', room: '' })
    assert.deepEqual(await joins.knock('F3', true), { result: 'saved', room: 'Saved' })
    assert.equal(flags.length, 0, 'no knock before the user agreed')
    // Deny: the room stays, no token.
    answer = { result: 'denied', room: 'Game night' }
    assert.deepEqual(await joins.knock('F1', true), { result: 'knock', outcome: { result: 'denied' }, room: 'Game night' })
    assert.deepEqual(flags, [['knocking', true], ['knock', 'F1', 'Ben', 'Lobby'], ['knocking', false]])
    assert.equal(left, 0)
    assert.equal(joins.take(), null)
    // Allow: leave the room after the answer, reload, then a one-time token for the device invite.
    answer = { result: 'allowed', invite: 'asscrack3:CODE', room: 'Game night' }
    assert.deepEqual(await joins.knock('F1', true), { result: 'joining', room: 'Game night' })
    assert.deepEqual([left, reloads, notes], [1, 1, 0])
    const taken = joins.take()
    assert.equal(taken.room, 'Game night')
    assert.equal(JSON.stringify(taken).includes('CODE'), false)
    assert.equal(joins.code(taken.token), 'asscrack3:CODE')
    // On the login screen: no confirm, no Leave.
    assert.deepEqual(await joins.knock('F1'), { result: 'joining', room: 'Game night' })
    assert.deepEqual([left, reloads, notes], [1, 1, 1])
    // A login that runs now: busy, no knock.
    const busy = createFriendJoins({ links, room: () => null, busy: () => true, leave: async () => true, reload: () => {} })
    assert.equal((await busy.knock('F1')).result, 'busy')
})
