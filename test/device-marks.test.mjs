// L3 (P10a, P10b): no key verifies a user name. Two devices can use the same name, also in a friend request. The fix
// shows a short device mark beside each name and a mark when two people in the room use the same name. Results of this
// file are results of this PC (module level and the room window in node:vm).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs'

const sha6 = id => createHash('sha256').update(id).digest('hex').slice(0, 6)
const deviceA = 'A'.repeat(43), deviceB = 'B'.repeat(43)

test('L3: main.js adds the device mark to the name, line and history events of the window', async () => {
    const { withDeviceMarks } = await import('../src/application/peer-marks.mjs')
    const devices = { pA: deviceA, pB: deviceB }
    const protectedNode = { memberState: () => ({ protected: true }), memberDevice: peerId => devices[peerId] ?? null }
    assert.deepEqual(withDeviceMarks('peer-name', { peerId: 'pA', name: 'Sam' }, protectedNode), { peerId: 'pA', name: 'Sam', mark: sha6(deviceA) })
    assert.equal(withDeviceMarks('message', { peerId: 'pB', from: 'Sam', text: 'x' }, protectedNode).mark, sha6(deviceB))
    assert.notEqual(sha6(deviceA), sha6(deviceB))
    const history = withDeviceMarks('history', { messages: [{ id: `${deviceA}.1`, from: 'Sam' }, { id: 'no-prefix', from: 'X' }] }, protectedNode)
    assert.equal(history.messages[0].mark, sha6(deviceA))
    assert.equal(history.messages[1].mark, undefined)
    // A legacy room: the mark of the peer ID. A history line has no peer ID, thus no mark.
    const legacyNode = { memberState: () => ({ protected: false }), memberDevice: () => null }
    assert.equal(withDeviceMarks('peer-name', { peerId: 'peer-1', name: 'Sam' }, legacyNode).mark, sha6('peer-1'))
    assert.equal(withDeviceMarks('history', { messages: [{ id: `${deviceA}.1` }] }, legacyNode).messages[0].mark, undefined)
    // Other events do not change.
    const other = { peerId: 'pA', inVoice: true }
    assert.equal(withDeviceMarks('voice-state', other, protectedNode), other)
})

test('L3: the window shows the device mark and the same-name mark; two devices with one name do not group', async () => {
    const f = await loadRoomWindow()
    await f.login('Reader')
    for (const [peerId, mark] of [['peer-a', 'aaaaaa'], ['peer-b', 'bbbbbb'], ['peer-c', 'cccccc']]) {
        f.handlers.onPeerJoined({ peerId })
        f.handlers.onPeerName({ peerId, name: peerId === 'peer-c' ? 'Cleo' : 'Sam', mark })
    }
    await settle()
    const item = peerId => f.el('peers').children.find(li => li.dataset.peerId === peerId)
    assert.equal(item('peer-a').querySelector('.name').dataset.mark, 'aaaaaa')
    assert.equal(item('peer-a').classList.contains('name-clash'), true)
    assert.equal(item('peer-b').classList.contains('name-clash'), true)
    assert.equal(item('peer-c').classList.contains('name-clash'), false)
    // A name that is the own name is also a clash.
    f.handlers.onPeerName({ peerId: 'peer-c', name: 'Reader', mark: 'cccccc' })
    await settle()
    assert.equal(item('peer-c').classList.contains('name-clash'), true)
    const now = Date.now()
    f.handlers.onMessage({ id: 'm1', from: 'Sam', text: 'one', peerId: 'peer-a', time: now, mark: 'aaaaaa' })
    f.handlers.onMessage({ id: 'm2', from: 'Sam', text: 'two', peerId: 'peer-b', time: now + 1, mark: 'bbbbbb' })
    f.handlers.onMessage({ id: 'm3', from: 'Sam', text: 'three', peerId: 'peer-b', time: now + 2, mark: 'bbbbbb' })
    const row = id => f.rows().find(r => r.dataset.id === id)
    assert.equal(row('m1').querySelector('.from').dataset.mark, 'aaaaaa')
    assert.equal(row('m1').querySelector('.from').textContent, 'Sam', 'the mark is CSS, not text')
    assert.equal(row('m2').classList.contains('cont'), false, 'another device does not group')
    assert.equal(row('m3').classList.contains('cont'), true, 'the same device groups')
    f.history([{ id: 'h1', from: 'Sam', text: 'old', time: now - 1000, mark: 'aaaaaa' }])
    assert.equal(row('h1').querySelector('.from').dataset.mark, 'aaaaaa')
})

test('L3: 127.0.0.1: the friend request event has the device mark of the requester', { timeout: 60000 }, async t => {
    const { makeProfile, protectedRoomPair, randomBasePort, startLinks } = await import('./helpers/friends.mjs')
    const A = makeProfile(t, 'a'), B = makeProfile(t, 'b')
    t.after(() => { A.rooms.close(); B.rooms.close() })
    const { roomA, roomB } = await protectedRoomPair(t, A, B)
    const port = randomBasePort()
    const linksA = await startLinks(t, A, { basePort: port, discovery: false })
    const linksB = await startLinks(t, B, { basePort: port + 50, discovery: false })
    linksA.attachRoom(roomA)
    linksB.attachRoom(roomB)
    const incoming = new Promise(resolve => linksB.events.on('request', e => { if (e.kind === 'incoming') resolve(e) }))
    assert.equal(linksA.request(roomA, roomB.peerId).result, 'sent')
    const event = await incoming
    assert.equal(event.mark, sha6(A.identity.id))
})
