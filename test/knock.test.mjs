// easy-join part 2: the room code, the knock messages, the proofs and the limits of the owner (no network, a fake
// clock). The 127.0.0.1 node tests are in knock-node.test.mjs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createClock } from './helpers/fake-clock.mjs'
import { COMPACT_INVITE_PREFIX, isRoomCode, makeMemberInvite, makeRoomCode, newRoomKey, readInvite, readRoomCode,
    ROOM_CODE_EXPIRED } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, INVITE_TTL_MS, restoreRoomMembership, roomCodeAccess } from '../src/network/room-membership.mjs'
import { checkAllowedInvite, createKnockDesk, createKnocker, KNOCK_LIMITS, knockName } from '../src/network/knock.mjs'
import { knockChannel } from '../src/network/knock-stream.mjs'
import { loginErrorText } from '../src/application/login-errors.mjs'

const room = 'Game night'
const PEER = '12D3KooWFYQJyQtUQQSSPCcrznePVTc5jdQqKkQYaaMV5bpn9GQq'
const NODES = [{ id: PEER, addrs: ['/ip4/203.0.113.5/tcp/47000'] }]

function owner({ lan = false, clock } = {}) {
    const roomKey = newRoomKey()
    const identity = createDeviceIdentity()
    const membership = createRoomMembership({ identity, room, roomKey, lan, ...(clock ? { now: clock.now } : {}) })
    const code = () => {
        const { id, expires } = membership.roomCode()
        return makeRoomCode({ room, key: roomKey, owner: identity.id, lan, codeId: id, expires, ownerPeer: PEER, nodes: lan ? [] : NODES },
            hash => membership.signRoomCode(hash))
    }
    return { roomKey, identity, membership, code }
}

test('a room code: the owner signs it, it names the room, the owner and the code ID, and it is not for one device', () => {
    const { roomKey, identity, membership, code } = owner()
    const text = code()
    assert.ok(text.startsWith(COMPACT_INVITE_PREFIX))
    assert.ok(isRoomCode(text) && isRoomCode(`  ${text.slice(0, 20)}\n${text.slice(20)} `))
    const parsed = readRoomCode(text)
    assert.equal(parsed.room, room)
    assert.equal(parsed.key, roomKey)
    assert.equal(parsed.owner, identity.id)
    assert.equal(parsed.codeId, membership.roomCode().id)
    assert.equal(parsed.ownerPeer, PEER)
    assert.deepEqual(parsed.nodes, NODES)
    assert.equal(parsed.lan, false)
    assert.equal(parsed.roomId, membership.roomId)
    // A device invite is not a room code.
    const device = createDeviceIdentity()
    const invite = makeMemberInvite({ room, key: roomKey, nodes: NODES, membership: membership.issue(device.id) })
    assert.equal(isRoomCode(invite), false)
    assert.equal(isRoomCode('asscrack1:abc'), false)
    // Another key cannot sign a room code of this owner.
    const forged = makeRoomCode({ room, key: roomKey, owner: identity.id, lan: false, codeId: parsed.codeId, expires: parsed.expires,
        ownerPeer: PEER, nodes: NODES }, () => createDeviceIdentity().sign(['x']))
    assert.throws(() => readRoomCode(forged), /bad signature/)
    // A changed byte with a correct checksum: the signature fails.
    const bytes = Buffer.from(text.slice(COMPACT_INVITE_PREFIX.length), 'base64url')
    const signed = bytes.subarray(0, bytes.length - 4)
    signed[signed.length - 70] ^= 1
    const sum = createHash('sha256').update(signed).digest().subarray(0, 4)
    assert.throws(() => readRoomCode(COMPACT_INVITE_PREFIX + Buffer.concat([signed, sum]).toString('base64url')), /bad signature|bad address|damaged/)
    assert.throws(() => readRoomCode(text.slice(0, -3)), /damaged/)
})

test('the device invite parse of this app (the same parse as 1.0.0) refuses a room code with the "different version" text', () => {
    const text = owner().code()
    assert.throws(() => readInvite(text), /unknown version/)
    let error
    try { readInvite(text) } catch (err) { error = err }
    assert.equal(loginErrorText(error), 'This invite comes from a different ASSCRACK version. You and the room owner must use the same version.')
})

test('the room code ID: Copy gives the same ID, "New room code" a new one, an expired code gets a new one, and the ID is saved', () => {
    const clock = createClock()
    const { identity, membership, roomKey } = owner({ clock })
    const saved = []
    membership.setPersistence(snapshot => saved.push(snapshot))
    const first = membership.roomCode()
    assert.equal(first.expires, clock.now() + INVITE_TTL_MS, 'a code expires after 7 days')
    assert.deepEqual(membership.roomCode(), first)
    assert.equal(membership.checkRoomCode(first.id), 'ok')
    assert.equal(saved.at(-1).roomCode.id, first.id)
    const restored = restoreRoomMembership({ identity, room, roomKey, descriptor: saved.at(-1), now: clock.now })
    assert.equal(restored.checkRoomCode(first.id), 'ok', 'the code ID comes back after a restart')
    const renewed = membership.roomCode({ renew: true })
    assert.notEqual(renewed.id, first.id)
    assert.equal(membership.checkRoomCode(first.id), 'old-code')
    assert.equal(saved.at(-1).roomCode.id, renewed.id)
    clock.advance(INVITE_TTL_MS + 1)
    assert.equal(membership.checkRoomCode(renewed.id), 'expired')
    assert.notEqual(membership.roomCode().id, renewed.id, 'Copy after the expiry makes a new code')
    // Only the owner makes a room code.
    const device = createDeviceIdentity()
    const member = restoreRoomMembership({ identity: device, room, roomKey, descriptor: membership.issue(device.id) })
    assert.throws(() => member.roomCode(), /Only the room owner/)
    assert.equal(member.checkRoomCode(renewed.id), 'old-code')
})

test('a room code that expired more than 1 hour ago gives the expiry text', () => {
    const { roomKey, identity, membership } = owner()
    const text = makeRoomCode({ room, key: roomKey, owner: identity.id, lan: false, codeId: membership.roomCode().id,
        expires: Date.now() - 2 * 60 * 60 * 1000, ownerPeer: PEER, nodes: NODES }, hash => membership.signRoomCode(hash))
    assert.throws(() => readRoomCode(text), new RegExp(ROOM_CODE_EXPIRED))
})

// A desk with a fake clock, and a knock with a channel in memory. Returns the lines to the knocker and the result.
function harness(options = {}) {
    const clock = createClock()
    const room1 = owner({ clock, lan: options.lan })
    const events = []
    const desk = createKnockDesk({
        membership: room1.membership, clock, limits: options.limits,
        makeInvite: deviceId => makeMemberInvite({ room, key: room1.roomKey, nodes: NODES, membership: room1.membership.issue(deviceId, false) }),
        changed: event => events.push(event)
    })
    function knock({ identity = createDeviceIdentity(), name = 'Kim', code = room1.code(), source = `peer-${Math.random()}`, via = 'relay-1',
        tamper = null } = {}) {
        const parsed = readRoomCode(code)
        const access = roomCodeAccess(parsed.room, parsed.key, parsed.owner, parsed.lan)
        const knocker = createKnocker({ code: parsed, access, identity, name })
        const run = { lines: [], ended: false, result: null, waiting: 0, identity, parsed }
        const channel = {
            send(message) {
                if (run.ended) return false
                run.lines.push(message)
                const step = knocker.receive(message)
                if (step.waiting) run.waiting++
                if (step.done) run.result = step.done
                if (step.send) queueMicrotask(() => handler.receive(tamper ? tamper(step.send) : step.send))
                return true
            },
            end() { run.ended = true }
        }
        const handler = desk.open(channel, { source, via })
        run.handler = handler
        handler.receive(knocker.hello())
        return run
    }
    return { clock, desk, events, knock, ...room1 }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const prompts = events => events.filter(event => event.added).map(event => event.added)

test('Allow: the owner checks the device proof, shows the name and the device mark, then gives a device invite with no host rights', async () => {
    const h = harness()
    const run = h.knock({ name: ' Kim ‮ ' })
    await flush()
    assert.equal(run.waiting, 1)
    const [prompt] = prompts(h.events)
    assert.equal(prompt.name, 'Kim')
    assert.equal(prompt.deviceId, run.identity.id)
    assert.match(prompt.mark, /^[0-9a-f]{6}$/)
    assert.equal(h.desk.list().length, 1)
    assert.equal(h.desk.answer(prompt.id, true), true)
    assert.equal(run.result.result, 'allowed')
    assert.ok(run.ended)
    const invite = checkAllowedInvite(run.parsed, run.identity, run.result.invite)
    assert.equal(invite.membership.grant.canHost, false)
    assert.equal(invite.membership.grant.deviceId, run.identity.id)
    assert.deepEqual(h.desk.list(), [])
    assert.equal(h.desk.answer(prompt.id, true), false, 'one answer only')
    // The invite is not for another device.
    assert.throws(() => checkAllowedInvite(run.parsed, createDeviceIdentity(), run.result.invite), /not valid/)
})

test('a knock with a wrong device proof gets no prompt and no answer', async () => {
    const h = harness()
    const run = h.knock({ tamper: line => ({ ...line, device: createDeviceIdentity().id }) })
    await flush()
    assert.deepEqual(prompts(h.events), [])
    assert.ok(run.ended)
    assert.equal(run.result, null)
    assert.ok(!run.lines.some(line => line.type === 'knock-result'))
})

test('the knocker refuses a peer that does not prove the owner key', () => {
    const real = owner()
    const parsed = readRoomCode(real.code())
    const knocker = createKnocker({ code: parsed, access: roomCodeAccess(parsed.room, parsed.key, parsed.owner, parsed.lan),
        identity: createDeviceIdentity(), name: 'Kim' })
    const hello = knocker.hello()
    const other = owner()
    const wrong = { type: 'knock-challenge', nonce: 'A'.repeat(24), proof: other.membership.knockOwnerProof(parsed.codeId, hello.nonce) }
    assert.deepEqual(knocker.receive(wrong), { done: { result: 'not-owner' } })
    const second = createKnocker({ code: parsed, access: roomCodeAccess(parsed.room, parsed.key, parsed.owner, parsed.lan),
        identity: createDeviceIdentity(), name: 'Kim' })
    assert.deepEqual(second.receive({ type: 'knock-result', result: 'allowed', invite: 'x' }), { done: { result: 'not-owner' } },
        'no invite before the proof of the owner')
})

test('no answer in 2 minutes: the knocker gets "timeout"; the owner sends a line each 20 s while the prompt shows', async () => {
    const h = harness()
    const run = h.knock()
    await flush()
    assert.equal(KNOCK_LIMITS.promptMs, 120000)
    h.clock.advance(119000)
    assert.equal(run.result, null)
    assert.equal(run.lines.filter(line => line.type === 'knock-wait').length, 1 + 5)
    h.clock.advance(1000)
    assert.deepEqual(run.result, { result: 'timeout' })
    assert.deepEqual(h.desk.list(), [])
})

test('Deny: "denied", then the same device gets "denied" with no prompt for 10 minutes', async () => {
    const h = harness()
    const identity = createDeviceIdentity()
    const first = h.knock({ identity })
    await flush()
    h.desk.answer(prompts(h.events)[0].id, false)
    assert.deepEqual(first.result, { result: 'denied' })
    const second = h.knock({ identity })
    await flush()
    assert.deepEqual(second.result, { result: 'denied' })
    assert.equal(prompts(h.events).length, 1)
    h.clock.advance(KNOCK_LIMITS.coolDownMs)
    h.knock({ identity })
    await flush()
    assert.equal(prompts(h.events).length, 2, 'a prompt after the cool-down')
})

test('limits: 5 prompts at one time, one prompt for each device, and a rate limit for each source and each path', async () => {
    const h = harness()
    const runs = []
    for (let i = 0; i < 5; i++) runs.push(h.knock({ via: `relay-${i}` }))
    await flush()
    assert.equal(h.desk.list().length, 5)
    const sixth = h.knock({ via: 'relay-x' })
    await flush()
    assert.deepEqual(sixth.result, { result: 'refused', reason: 'busy' })
    h.desk.answer(h.desk.list()[0].id, false)
    const again = h.knock({ identity: runs[1].identity, via: 'relay-y' })
    await flush()
    assert.deepEqual(again.result, { result: 'refused', reason: 'pending' })
    assert.equal(prompts(h.events).length, 5)

    const g = harness()
    for (let i = 0; i < 3; i++) g.knock({ source: 'same-peer', via: `relay-${i}` })
    const fourth = g.knock({ source: 'same-peer', via: 'relay-9' })
    assert.deepEqual(fourth.result, { result: 'refused', reason: 'rate' })
    assert.deepEqual(fourth.lines.map(line => line.type), ['knock-result'], 'no challenge over the limit')
    const k = harness({ limits: { maxPending: 50 } })
    for (let i = 0; i < 10; i++) k.knock({ via: 'one-relay' })
    const eleventh = k.knock({ via: 'one-relay' })
    assert.deepEqual(eleventh.result, { result: 'refused', reason: 'rate' })
    k.clock.advance(KNOCK_LIMITS.periodMs)
    const later = k.knock({ via: 'one-relay' })
    await flush()
    assert.equal(later.waiting, 1, 'a new period')
})

test('the owner refuses an old code, an expired code, its own device, a removed device and a device that can host', async () => {
    const h = harness()
    const old = h.code()
    h.membership.roomCode({ renew: true })
    const stale = h.knock({ code: old })
    assert.deepEqual(stale.result, { result: 'refused', reason: 'old-code' })
    const self = h.knock({ identity: h.identity })
    await flush()
    assert.deepEqual(self.result, { result: 'refused', reason: 'owner' })
    const removed = createDeviceIdentity()
    h.membership.issue(removed.id)
    h.membership.revoke(removed.id)
    const gone = h.knock({ identity: removed })
    await flush()
    assert.deepEqual(gone.result, { result: 'refused', reason: 'removed' })
    const host = createDeviceIdentity()
    h.membership.issue(host.id, true)
    const role = h.knock({ identity: host })
    await flush()
    assert.deepEqual(role.result, { result: 'refused', reason: 'role' })
    const fresh = h.code()
    h.clock.advance(INVITE_TTL_MS + 1)
    const expired = h.knock({ code: fresh })
    assert.deepEqual(expired.result, { result: 'refused', reason: 'expired' })
    assert.deepEqual(prompts(h.events), [])
})

test('the prompt goes away when the knocker leaves', async () => {
    const h = harness()
    const run = h.knock()
    await flush()
    assert.equal(h.desk.list().length, 1)
    run.handler.closed()
    assert.deepEqual(h.desk.list(), [])
    assert.deepEqual(h.events.at(-1), { pending: [], added: null })
})

test('knockName: no bidi controls, no control characters, up to 64 characters', () => {
    assert.equal(knockName('A‮B\u0007C'), 'ABC')
    assert.equal(knockName('x'.repeat(100)).length, 64)
    assert.equal(knockName(''), 'Someone')
    assert.equal(knockName(7), 'Someone')
})

test('the knock size cap: the stream closes at a long line, at too many bytes, or at a line that is not JSON', async () => {
    async function feed(chunks, limits = { maxLineBytes: 2048, maxStreamBytes: 8192 }) {
        const lines = []
        let aborted = null
        const stream = {
            source: (async function* () { for (const chunk of chunks) yield chunk })(),
            sink: async source => { for await (const _ of source) { /* sent */ } },
            abort: err => { aborted = err.message }
        }
        const channel = knockChannel(stream, { ...limits, onLine: line => lines.push(line) })
        channel.end()
        await channel.done
        return { lines, aborted }
    }
    const ok = await feed([Buffer.from('{"type":"a"}\n{"type":'), Buffer.from('"b"}\n')])
    assert.deepEqual(ok.lines, [{ type: 'a' }, { type: 'b' }])
    assert.equal(ok.aborted, null)
    assert.equal((await feed([Buffer.alloc(3000, 0x61)])).aborted, 'Knock line cap')
    const many = Array.from({ length: 10 }, () => Buffer.from(`{"type":"${'x'.repeat(1000)}"}\n`))
    const big = await feed(many)
    assert.equal(big.aborted, 'Knock size cap')
    assert.ok(big.lines.length < 10)
    assert.equal((await feed([Buffer.from('not json\n')])).aborted, 'Knock line is not valid')
    assert.equal((await feed([Buffer.from('[1]\n')])).aborted, 'Knock line is not valid')
})

test('the texts of the joiner for each knock result', async () => {
    const { knockResultText } = await import('../src/application/login-errors.mjs')
    assert.equal(knockResultText({ result: 'denied' }), 'The owner did not let you in.')
    assert.equal(knockResultText({ result: 'timeout' }), 'The owner is not online. Try again later.')
    assert.equal(knockResultText({ result: 'offline' }), 'The owner is not online. Try again later.')
    assert.equal(knockResultText({ result: 'refused', reason: 'old-code' }), 'This room code was replaced. Ask the owner for the new one.')
    assert.equal(knockResultText({ result: 'refused', reason: 'busy' }), 'The owner has too many join requests. Try again in a few minutes.')
    assert.equal(knockResultText({ result: 'refused', reason: 'denied' }), 'The owner could not answer. Try again later.')
    assert.equal(knockResultText({ result: 'refused', reason: 'toString' }), 'The owner could not answer. Try again later.')
    // loginErrorText keeps these texts.
    for (const text of ['The owner did not let you in.', 'The owner is not online. Try again later.']) assert.equal(loginErrorText(new Error(text)), text)
})
