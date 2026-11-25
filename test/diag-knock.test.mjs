// Diagnostics hooks of easy-join (1.0.1, DECISIONS.md DG-15): the knock steps go into the journal with a cause code,
// and no name, invite, room code, device ID or raw address goes in. The node test uses real libp2p nodes on 127.0.0.1
// (127.0.0.1 results, not LAN results). The desk test has no network and a fake clock.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { makeMemberInvite, makeRoomCode, newRoomKey, readRoomCode } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, roomCodeAccess } from '../src/network/room-membership.mjs'
import { knockRoom } from '../src/network/knock-client.mjs'
import { createKnockDesk, createKnocker } from '../src/network/knock.mjs'
import { createJournal, redact } from '../src/application/journal.mjs'
import { journalNodeEvents, projectNodeEvent } from '../src/application/diag-events.mjs'
import { createClock } from './helpers/fake-clock.mjs'

const room = 'CanaryKnockRoomQx7'
const NAME = 'CanaryKnockNameQx7'
const timing = { discovery: false, heartbeatInterval: 100, hostTimeout: 700, electionDelay: 350, redialInterval: 500 }

async function waitFor(predicate, description, tries = 500) {
    for (let attempt = 0; attempt < tries; attempt++) {
        if (predicate()) return
        await delay(20)
    }
    assert.fail(description)
}

async function journalLines(dir, journal) {
    await journal.flush()
    journal.flushSync()
    return readdirSync(dir).filter(name => name.endsWith('.jsonl'))
        .flatMap(name => readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)).map(line => JSON.parse(line))
}

test('127.0.0.1: the knock steps of the owner go into the journal with no name, code or address', { timeout: 60000 }, async t => {
    const roomKey = newRoomKey()
    const ownerDevice = createDeviceIdentity()
    const membership = createRoomMembership({ identity: ownerDevice, room, roomKey, lan: true })
    let friend = null
    const owner = await createAsscrackNode({ room, roomKey, listen: ['/ip4/127.0.0.1/tcp/0'], ...timing, membership,
        name: 'Owner', fullNode: false, knock: { isFriend: deviceId => deviceId === friend } })
    t.after(() => owner.stop())
    const dir = mkdtempSync(path.join(tmpdir(), 'asscrack-diag-knock-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const journal = createJournal({ dir, budgets: { default: [1e6, 0] } })
    t.after(() => journal.close())
    journalNodeEvents((type, fn) => owner.events.on(type, fn), (type, fields) => journal.write(type, fields), owner.peerId)
    const raw = []
    owner.events.on('knock-event', data => raw.push(data))

    const { code } = owner.roomCode()
    const parsed = readRoomCode(code)
    // Each knock answers with the given choice (true Allow, false Deny).
    const knockOnce = async (answer, identity = createDeviceIdentity(), roomCode = parsed) => {
        const onKnocks = ({ added }) => { if (added) setImmediate(() => owner.answerKnock(added.id, answer)) }
        owner.events.on('knocks', onKnocks)
        try {
            return await knockRoom({ code: roomCode, identity, name: NAME })
        } finally {
            owner.events.off('knocks', onKnocks)
        }
    }
    const allowed = await knockOnce(true)
    assert.equal(allowed.result, 'allowed')
    const denied = createDeviceIdentity()
    assert.equal((await knockOnce(false, denied)).result, 'denied')
    await delay(300)
    assert.equal((await knockOnce(true, denied)).result, 'denied', 'the cool-down answers with no prompt')
    // "Always allow my friends": a friend device gets in with no prompt.
    owner.setAutoAllowFriends(true)
    const friendDevice = createDeviceIdentity()
    friend = friendDevice.id
    await delay(300)
    assert.equal((await knockOnce(null, friendDevice)).result, 'allowed')
    // An old room code after "New room code".
    owner.roomCode({ renew: true })
    await delay(300)
    assert.deepEqual(await knockOnce(true), { result: 'refused', reason: 'old-code' })
    await waitFor(() => raw.length >= 7, 'seven knock events')

    const knocks = (await journalLines(dir, journal)).filter(line => line.type === 'knock')
    const steps = knocks.map(line => `${line.event}${line.cause ? `:${line.cause}` : ''}`)
    assert.deepEqual(steps, ['received', 'allowed', 'received', 'denied', 'refused:cool-down', 'auto-allowed', 'refused:old-code'])
    for (const line of knocks) {
        assert.equal(line.side, 'owner')
        assert.equal(line.route, 'direct', 'a direct knock: the route class, not the address')
        assert.equal(line.friend, false)
        assert.match(line.peer, /^12D3KooW/)
        assert.deepEqual(Object.keys(line).filter(key => !['v', 'run', 'n', 't', 'm', 'type'].includes(key)).sort(),
            ['event', 'friend', 'peer', 'route', 'side', ...(line.id ? ['id'] : []), ...(line.cause ? ['cause'] : [])].sort())
    }
    // A prompt and its answer have the same knock ID.
    assert.equal(knocks[0].id, knocks[1].id)
    assert.match(knocks[0].id, /^[0-9a-f-]{36}$/)
    // The raw node event has no address either (the desk has the IP address as its via).
    for (const data of raw) assert.ok(!JSON.stringify(data).includes('127.0.0.1'), 'no address in the node event')

    const bytes = Buffer.concat(readdirSync(dir).map(name => readFileSync(path.join(dir, name))))
    const needles = [NAME, room, code, code.slice(10, 50), allowed.invite, allowed.invite.slice(10, 50), denied.id, friendDevice.id,
        ownerDevice.id, '127.0.0.1']
    for (const needle of needles) {
        for (const enc of ['utf8', 'utf16le']) assert.equal(bytes.indexOf(Buffer.from(needle, enc)), -1, `${needle.slice(0, 24)} (${enc}) in the journal`)
    }
})

test('the knock desk reports a knock that closes, a knock with no line in time, a timeout and a rate limit', async () => {
    const clock = createClock()
    const roomKey = newRoomKey()
    const identity = createDeviceIdentity()
    const membership = createRoomMembership({ identity, room, roomKey, lan: true, now: clock.now })
    const PEER = '12D3KooWFYQJyQtUQQSSPCcrznePVTc5jdQqKkQYaaMV5bpn9GQq'
    const { id, expires } = membership.roomCode()
    const code = readRoomCode(makeRoomCode({ room, key: roomKey, owner: identity.id, lan: true, codeId: id, expires, ownerPeer: PEER,
        nodes: [] }, hash => membership.signRoomCode(hash)))
    const reports = []
    const desk = createKnockDesk({ membership, clock, limits: { promptMs: 5000, perVia: 3 },
        makeInvite: deviceId => makeMemberInvite({ room, key: roomKey, nodes: [], membership: membership.issue(deviceId, false) }),
        report: event => reports.push(event) })
    const flush = () => new Promise(resolve => setImmediate(resolve))
    const open = ({ hello = true } = {}) => {
        const knocker = createKnocker({ code, access: roomCodeAccess(code.room, code.key, code.owner, code.lan),
            identity: createDeviceIdentity(), name: NAME })
        let handler = null
        const channel = {
            send(message) {
                const step = knocker.receive(message)
                if (step.send) queueMicrotask(() => handler.receive(step.send))
                return true
            },
            end() {}
        }
        handler = desk.open(channel, { source: PEER, via: '192.0.2.7' })
        if (hello) handler.receive(knocker.hello())
        return handler
    }
    const closing = open()
    await flush()
    closing.closed()
    open({ hello: false })
    clock.advance(10001)
    open()
    await flush()
    clock.advance(5001)
    open()
    const steps = reports.map(r => `${r.event}${r.cause ? `:${r.cause}` : ''}`)
    assert.deepEqual(steps, ['received', 'gone', 'dropped:no-line', 'received', 'timeout', 'refused:rate'])
    assert.ok(reports.every(r => r.source === PEER && r.via === '192.0.2.7' && r.friend === false))
    assert.ok(reports.every(r => !('name' in r) && !('invite' in r) && !('deviceId' in r)))
    // The projection gives the journal fields only; an unknown field of the event does not go in.
    const [type, fields] = projectNodeEvent('knock-event', { event: 'refused', side: 'owner', peerId: PEER, route: 'direct', cause: 'Rate',
        name: NAME, invite: 'asscrack3:abc', deviceId: identity.id })
    assert.equal(type, 'knock')
    assert.deepEqual(redact(type, fields), { type: 'knock', event: 'refused', side: 'owner', peer: PEER, route: 'direct', cause: 'rate' })
    // The join type keeps only its codes.
    assert.deepEqual(redact('join', { event: 'clipboard-prompt', kind: 'room-code', code: 'asscrack3:abc', room }),
        { type: 'join', event: 'clipboard-prompt', kind: 'room-code' })
    assert.deepEqual(redact('join', { event: 'friend-invite-used', result: 'joining', name: NAME }),
        { type: 'join', event: 'friend-invite-used', result: 'joining' })
})

test('main.js writes the knock result of the knocker, the friend invite and the clipboard steps into the journal', () => {
    const main = readFileSync(new URL('../src/application/main.js', import.meta.url), 'utf8')
    for (const pattern of [
        /journal\('knock', \{ event: 'result', side: 'knocker', route: 'room-code', result: outcome\.result, cause: outcome\.reason \}\)/,
        /journal\('knock', \{ event: 'result', side: 'knocker', route: 'friend',/,
        /journal\('join', \{ event: 'friend-invite-used', result: answer\?\.result \}\)/,
        /friendLinks\.events\.on\('invite-sent', \(\{ result \}\) => journal\('join', \{ event: 'friend-invite-sent', result \}\)\)/,
        /journal\('join', \{ event: 'friend-invite-received' \}\)/,
        /journal\('join', \{ event: 'clipboard-prompt', kind \}\)/,
        /journal\('join', \{ event: 'clipboard-join', result: answer\?\.result \}\)/,
        /journal\('join', \{ event: 'clipboard-dismiss' \}\)/
    ]) assert.match(main, pattern)
    const links = readFileSync(new URL('../src/application/friend-links.mjs', import.meta.url), 'utf8')
    assert.match(links, /events\.emit\('invite-sent', \{ result: answer\.result \}\)/)
    const clip = readFileSync(new URL('../src/application/clipboard-join.mjs', import.meta.url), 'utf8')
    assert.match(clip, /notify\(found\.kind\)/)
})
