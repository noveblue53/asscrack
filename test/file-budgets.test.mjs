import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { pushable } from 'it-pushable'
import { createFileTransfer, safeFileName } from '../src/network/file-transfer.mjs'

test('file requests do not read before room admission and unanswered admitted requests release their slots', async t => {
    const files = createFileTransfer({ events: new EventEmitter(), sendTo: () => true,
        openPeers: () => ['friend'], peerNames: () => ({}), fileOpenTimeout: 25 })
    t.after(() => files.stop())
    function request(peerId) {
        const input = pushable()
        const observation = { reads: 0, reason: null }
        files.handleStream({ connection: { remotePeer: peerId }, stream: {
            get source() { observation.reads++; return input },
            abort(error) { if (!observation.reason) { observation.reason = error.message; input.end(error) } }
        } })
        return observation
    }

    const unadmitted = request('unknown')
    assert.deepEqual(unadmitted, { reads: 0, reason: 'File request not admitted' })
    const first = request('friend'), second = request('friend')
    assert.equal(first.reads, 1)
    assert.equal(second.reads, 1)
    const waiting = request('friend')
    assert.deepEqual(waiting, { reads: 0, reason: 'File request not admitted' })
    await delay(70)
    assert.equal(first.reason, 'File request timed out')
    assert.equal(second.reason, 'File request timed out')
    assert.equal(request('friend').reads, 1)
})

test('a full pending inbox releases room membership capacity when one offer is refused', async t => {
    const events = new EventEmitter(), offered = [], sent = []
    events.on('file-offer', offer => offered.push(offer))
    const files = createFileTransfer({ events, sendTo(peer, control) { sent.push({ peer, ...control }); return true },
        openPeers: () => ['friend'], peerNames: () => ({ friend: 'Friend' }) })
    t.after(() => files.stop())
    const sha256 = createHash('sha256').update('example').digest('hex')
    const incoming = () => ({ type: 'file-offer', offerId: randomUUID(), name: 'fixture.txt', sha256, size: 7 })
    for (let i = 0; i < 16; i++) assert.equal(files.handleControl('friend', incoming()), true)
    const next = incoming()
    assert.equal(files.handleControl('friend', next), undefined)
    assert.equal(offered.length, 16)
    assert.deepEqual(sent[0], { peer: 'friend', type: 'file-refuse', offerId: next.offerId, reason: 'capacity' })
    assert.equal(files.refuseFile(offered[0].offerId), true)
    assert.equal(files.handleControl('friend', next), true)
    assert.equal(offered.at(-1).offerId, next.offerId)
})

test('download names avoid Windows console and superscript device aliases', () => {
    assert.equal(safeFileName('CONIN$.txt'), '_CONIN$.txt')
    assert.equal(safeFileName('COM¹ .txt'), '_COM¹ .txt')
    assert.equal(safeFileName('lpt².txt'), '_lpt².txt')
    assert.equal(safeFileName('ordinary-1.txt'), 'ordinary-1.txt')
})
