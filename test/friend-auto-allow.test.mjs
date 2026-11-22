// easy-join part 3: "Always allow my friends" (an owner setting for each room, off by default). The desk tests use no
// network. The node tests run real friend nodes and room nodes on 127.0.0.1 on this PC (not a LAN result, not an internet
// result).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import vm from 'node:vm'
import { createAsscrackNode } from '../src/network/node.mjs'
import { makeMemberInvite, newRoomKey, readInvite, readRoomCode } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, knockAccess, restoreRoomMembership } from '../src/network/room-membership.mjs'
import { createKnockDesk, createKnocker, FRIEND_KNOCK_CODE } from '../src/network/knock.mjs'
import { createKnockRelay, startFriendKnock } from '../src/network/friend-knock.mjs'
import { knockRoom } from '../src/network/knock-client.mjs'
import { deviceMark } from '../src/network/device-mark.mjs'
import { joinAdmission } from '../src/application/room-admission.mjs'
import { makeProfile, protectedRoomPair, startLinks, befriend, waitFor, randomBasePort } from './helpers/friends.mjs'

const room = 'Game night'
const tick = () => new Promise(resolve => setImmediate(resolve))
const FAST = { discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: false, heartbeatInterval: 200, electionDelay: 300,
    hostTimeout: 1500 }
const local = node => node.getMultiaddrs().find(addr => addr.startsWith('/ip4/127.0.0.1/') && !addr.includes('/p2p-circuit'))

// ---- The desk (no network) ----

function ownerMembership() {
    const roomKey = newRoomKey()
    const identity = createDeviceIdentity()
    const membership = createRoomMembership({ identity, room, roomKey, lan: true })
    return { roomKey, identity, membership, lan: true }
}

// The owner desk with the device invite of Allow (as node.mjs makes it).
function desk(o, options = {}) {
    const prompts = [], autos = []
    const d = createKnockDesk({
        membership: o.membership,
        makeInvite: deviceId => makeMemberInvite({ room, key: o.roomKey, nodes: [], membership: o.membership.issue(deviceId, false) }),
        changed: ({ added }) => { if (added) prompts.push(added) },
        autoAllowed: view => autos.push(view),
        ...options
    })
    return { desk: d, prompts, autos }
}

// The joiner and the friend relay of the owner, joined by in-memory pipes (the friend link).
function pipe({ o, joiner = createDeviceIdentity(), name = 'Ben', connect }) {
    let knock = null
    const relay = createKnockRelay({ send: line => { queueMicrotask(() => knock.handle(line)); return true }, connect })
    const states = []
    knock = startFriendKnock({
        room: { id: o.membership.roomId, owner: o.identity.id, name: room, route: 'owner' }, identity: joiner, name,
        send: line => { queueMicrotask(() => relay.handle(line)); return true },
        onState: state => states.push(state)
    })
    return { knock, relay, states, joiner }
}

// The connect of the owner: the own desk with { friend: true }.
const ownDesk = (d, source = 'friend:x') => ({ toJoiner, ended }) => {
    const handler = d.open({ send: line => { toJoiner(line); return true }, end: () => ended() }, { source, via: 'friend', friend: true })
    return { send: line => handler.receive(line), end: () => handler.closed() }
}

test('"Always allow my friends": a friend gets Allow with no prompt, only after the device proof; a stranger gets the prompt', async () => {
    const o = ownerMembership()
    const friendDevice = createDeviceIdentity()
    const asked = []
    const { desk: d, prompts, autos } = desk(o, { autoAllow: deviceId => { asked.push(deviceId); return deviceId === friendDevice.id } })
    // A wrong device proof: the desk closes with no answer and never asks autoAllow.
    const sent = []
    let ended = false
    const handler = d.open({ send: line => { sent.push(line); return true }, end: () => { ended = true } }, { source: 's', via: 'friend', friend: true })
    const knocker = createKnocker({ code: { codeId: FRIEND_KNOCK_CODE }, access: knockAccess(o.membership.roomId, o.identity.id),
        identity: createDeviceIdentity(), name: 'Eve' })
    handler.receive(knocker.hello())
    const step = knocker.receive(sent[0])
    handler.receive({ ...step.send, device: friendDevice.id })
    assert.equal(ended, true)
    assert.deepEqual(asked, [], 'no autoAllow check before the device proof')
    assert.equal(sent.length, 1, 'no answer')
    // The friend: Allow with no prompt, and the event for the room line.
    const p = pipe({ o, joiner: friendDevice, name: 'Ben', connect: ownDesk(d) })
    const outcome = await p.knock.result
    assert.equal(outcome.result, 'allowed')
    assert.equal(prompts.length, 0, 'no prompt for the friend')
    assert.deepEqual(autos, [{ name: 'Ben', mark: deviceMark(friendDevice.id), deviceId: friendDevice.id }])
    assert.deepEqual(p.states, [], 'the joiner did not wait for a prompt')
    assert.equal(readInvite(outcome.invite).membership.grant.deviceId, friendDevice.id)
    // A stranger: the prompt.
    const q = pipe({ o, name: 'Sam', connect: ownDesk(d, 'friend:y') })
    await tick()
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].name, 'Sam')
    d.answer(prompts[0].id, false)
    assert.deepEqual(await q.knock.result, { result: 'denied' })
    assert.equal(autos.length, 1)
})

test('"Always allow my friends": off by default, saved with the room of the owner, not in a device invite, owner only', () => {
    const o = ownerMembership()
    assert.equal(o.membership.autoAllowFriends(), false)
    const saved = []
    o.membership.setPersistence(snapshot => saved.push(snapshot))
    assert.equal(o.membership.setAutoAllowFriends(true), true)
    assert.equal(saved.at(-1).autoAllowFriends, true)
    const restored = restoreRoomMembership({ identity: o.identity, room, roomKey: o.roomKey, descriptor: saved.at(-1) })
    assert.equal(restored.autoAllowFriends(), true, 'the setting comes back after a restart')
    const device = createDeviceIdentity()
    const descriptor = o.membership.issue(device.id, false)
    assert.equal('autoAllowFriends' in descriptor, false, 'a device invite does not have the setting')
    const member = restoreRoomMembership({ identity: device, room, roomKey: o.roomKey, descriptor: { ...descriptor, autoAllowFriends: true } })
    assert.equal(member.autoAllowFriends(), false, 'a member never has the setting')
    assert.throws(() => member.setAutoAllowFriends(true), /Only the room owner/)
    assert.equal(o.membership.setAutoAllowFriends(false), false)
    assert.equal('autoAllowFriends' in saved.at(-1), false)
})

test('window: the room line "<name> #<mark> joined (friend)" and the checkbox in the membership card', async () => {
    const context = { window: {} }
    vm.createContext(context)
    vm.runInContext(await readFile(new URL('../src/application/knock-ui.js', import.meta.url), 'utf8'), context)
    assert.equal(context.window.knockCore.autoText({ name: 'Ben', mark: 'a1b2c3' }), 'Ben #a1b2c3 joined (friend)')
    assert.equal(context.window.knockCore.autoText({ name: 'Ben', mark: 'bad' }), 'Ben joined (friend)')
    const html = await readFile(new URL('../src/application/index.html', import.meta.url), 'utf8')
    const box = html.slice(html.indexOf('<div id="room-code-box"'), html.indexOf('</div>', html.indexOf('<div id="room-code-box"')))
    assert.match(box, /<input type="checkbox" id="auto-allow-friends"> Always allow my friends/)
    assert.doesNotMatch(box, /id="auto-allow-friends"[^>]*checked/, 'off by default')
})

// ---- 127.0.0.1: friend links with real nodes ----

// Two profiles that are friends on 127.0.0.1. The friend request room stays the current room of each side.
async function friends(t) {
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b')
    t.after(() => { A.rooms.close(); B.rooms.close() })
    const { roomA, roomB } = await protectedRoomPair(t, A, B)
    const port = randomBasePort()
    const linksA = await startLinks(t, A, { basePort: port, discovery: false, nodeOptions: { allowPrivateFullNode: true } })
    const linksB = await startLinks(t, B, { basePort: port + 50, discovery: false })
    linksA.attachRoom(roomA, { name: 'friends-test' })
    linksB.attachRoom(roomB, { name: 'friends-test' })
    const { friendA, friendB } = await befriend(linksA, linksB, roomA, roomB)
    await waitFor(() => linksA.friend(friendA).state === 'online' && linksB.friend(friendB).state === 'online', 'online')
    return { A, B, linksA, linksB, friendA, friendB }
}

// A LAN protected room of the owner with the knock option of main.js (isFriend of the friend links).
async function friendOwnerRoom(t, identity, links) {
    const name = `game night ${randomUUID().slice(0, 4)}`, roomKey = newRoomKey()
    const membership = createRoomMembership({ identity, room: name, roomKey, lan: true })
    const node = await createAsscrackNode({ ...FAST, room: name, roomKey, membership, name: 'Ann',
        knock: { isFriend: deviceId => links.isFriend(deviceId) } })
    t.after(() => node.stop())
    return { node, room: name, roomKey, membership }
}

function answerPrompts(node, answer) {
    const prompts = []
    node.events.on('knocks', ({ added }) => {
        if (!added) return
        prompts.push(added)
        if (answer !== null) setImmediate(() => node.answerKnock(added.id, answer))
    })
    return prompts
}

async function joinAndChat(t, identity, invite, ownerNode, name = 'Ben') {
    const code = readInvite(invite)
    assert.equal(code.membership.grant.deviceId, identity.id)
    assert.equal(code.membership.grant.canHost, false)
    const M = await createAsscrackNode({ ...FAST, room: code.room, roomKey: code.key, name, membership: joinAdmission(code, identity, null) })
    t.after(() => M.stop())
    await M.connect(local(ownerNode))
    await waitFor(() => M.memberState().admitted === true && ownerNode.deviceOf(M.peerId) === identity.id, 'the joiner is admitted', 30000)
    const atOwner = [], atJoiner = []
    ownerNode.events.on('message', m => atOwner.push(m.text))
    M.events.on('message', m => atJoiner.push(m.text))
    await waitFor(() => ownerNode.peers().includes(M.peerId) && M.peers().includes(ownerNode.peerId), 'chat session')
    M.send(`hi from ${name}`)
    ownerNode.send('hi from the owner')
    await waitFor(() => atOwner.includes(`hi from ${name}`) && atJoiner.includes('hi from the owner'), 'chat in both directions')
}

test('127.0.0.1 "Always allow my friends" off (the default): a friend gets the normal prompt', { timeout: 90000 }, async t => {
    const { A, B, linksA, linksB, friendB } = await friends(t)
    const R = await friendOwnerRoom(t, A.identity, linksA)
    assert.equal(R.node.memberState().autoAllowFriends, false, 'off by default')
    assert.equal(linksA.isFriend(B.identity.id), true)
    const prompts = answerPrompts(R.node, true)
    const autos = []
    R.node.events.on('knock-auto', view => autos.push(view))
    linksA.attachRoom(R.node, { name: R.room })
    await waitFor(() => linksB.friend(friendB).join?.room === R.room, 'B sees Join')
    const outcome = await linksB.knock(friendB, { name: 'Ben' })
    assert.equal(outcome.result, 'allowed')
    assert.equal(prompts.length, 1, 'the prompt')
    assert.equal(autos.length, 0)
})

test('127.0.0.1 "Always allow my friends" on: a friend gets in with no prompt and the room line event; a stranger with the room code gets the prompt', { timeout: 120000 }, async t => {
    const { A, B, linksA, linksB, friendB } = await friends(t)
    const R = await friendOwnerRoom(t, A.identity, linksA)
    assert.equal(R.node.setAutoAllowFriends(true), true)
    assert.equal(R.node.memberState().autoAllowFriends, true)
    const prompts = answerPrompts(R.node, false)
    const autos = []
    R.node.events.on('knock-auto', view => autos.push(view))
    linksA.attachRoom(R.node, { name: R.room })
    await waitFor(() => linksB.friend(friendB).join?.room === R.room, 'B sees Join')
    const states = []
    const outcome = await linksB.knock(friendB, { name: 'Ben', onState: state => states.push(state) })
    assert.equal(outcome.result, 'allowed', JSON.stringify(outcome))
    assert.equal(prompts.length, 0, 'no prompt for a friend')
    assert.deepEqual(states, [])
    assert.deepEqual(autos, [{ name: 'Ben', mark: deviceMark(B.identity.id), deviceId: B.identity.id }])
    await joinAndChat(t, B.identity, outcome.invite, R.node)
    // A stranger with the room code: the normal prompt (Deny here).
    const S = makeProfile(t, 's')
    t.after(() => S.rooms.close())
    const code = readRoomCode(R.node.roomCode().code)
    const stranger = await knockRoom({ code, identity: S.identity, name: 'Sam' })
    assert.equal(stranger.result, 'denied')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].name, 'Sam')
    assert.equal(autos.length, 1)
})

test('127.0.0.1 "Always allow my friends" on: a blocked device gets no admission (the prompt as a stranger, no auto-allow)', { timeout: 120000 }, async t => {
    const { A, B, linksA, linksB, friendA, friendB } = await friends(t)
    const R = await friendOwnerRoom(t, A.identity, linksA)
    R.node.setAutoAllowFriends(true)
    linksA.attachRoom(R.node, { name: R.room })
    await waitFor(() => linksB.friend(friendB).join?.room === R.room, 'B sees Join')
    await linksA.block(friendA)
    assert.equal(linksA.isFriend(B.identity.id), false)
    await waitFor(() => linksB.friend(friendB).join === undefined, 'B has no Join after the block')
    const prompts = answerPrompts(R.node, null)
    const autos = []
    R.node.events.on('knock-auto', view => autos.push(view))
    // B knocks with a room code of R (the only way that is left).
    const code = readRoomCode(R.node.roomCode().code)
    const knock = knockRoom({ code, identity: B.identity, name: 'Ben' })
    await waitFor(() => prompts.length === 1, 'the owner sees a prompt, as for a stranger')
    assert.equal(autos.length, 0, 'no auto-allow for a blocked device')
    assert.equal(R.membership.issued().length, 0, 'no grant with no answer')
    R.node.answerKnock(prompts[0].id, false)
    assert.equal((await knock).result, 'denied')
    await delay(200)
    assert.equal(R.membership.issued().length, 0, 'no admission')
})

