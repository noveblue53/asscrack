import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { createSharedShelf } from '../src/network/shared-shelf.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

async function waitFor(check, label) {
    for (let attempt = 0; attempt < 300; attempt++) {
        const result = check()
        if (result) return result
        await delay(20)
    }
    assert.fail(label)
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('127.0.0.1: Shared discovers a prior listing, isolates recipient cancel/retry and keeps saved files after source loss', { timeout: 30000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'asscrack-shelf-'))
    const roomKey = newRoomKey(), nodes = [], publicMessages = [], transfers = []
    async function make(name) {
        const downloads = await mkdtemp(path.join(dir, 'downloads-'))
        const node = await createAsscrackNode({ room: 'Shared test', roomKey, name, discovery: false, fullNode: false,
            listen: ['/ip4/127.0.0.1/tcp/0'], downloadDir: downloads })
        nodes.push(node)
        node.events.on('message', message => publicMessages.push(message))
        node.events.on('file-done', data => { if (data.direction === 'receive') transfers.push({ receiver: node.peerId, ...data }) })
        return { node, downloads }
    }
    t.after(async () => {
        await Promise.allSettled(nodes.map(node => node.stop()))
        await rm(dir, { recursive: true, force: true })
    })

    const one = Buffer.alloc(2 * 1024 * 1024, 71)
    const two = Buffer.from('another file with the same visible name')
    const sourceA = path.join(dir, 'a', 'setup.dat'), sourceC = path.join(dir, 'c', 'setup.dat')
    await mkdir(path.dirname(sourceA)); await mkdir(path.dirname(sourceC))
    await writeFile(sourceA, one); await writeFile(sourceC, two)

    const { node: a } = await make('Friend')
    const aFile = await a.publishShelfFile(sourceA)
    const { node: b, downloads: bDownloads } = await make('Laptop')
    const { node: c } = await make('Friend')
    const cFile = await c.publishShelfFile(sourceC)
    await b.connect(a.getMultiaddrs()[0])
    await c.connect(a.getMultiaddrs()[0])
    await b.connect(c.getMultiaddrs()[0])
    const row = (node, peerId, id) => node.shelf().items.find(item => item.peerId === peerId && item.id === id)
    await waitFor(() => row(b, a.peerId, aFile)?.available && row(b, c.peerId, cFile)?.available &&
        row(c, a.peerId, aFile)?.available, 'late lists reached the proper peers')
    assert.deepEqual(b.shelf().items.map(item => item.name), ['setup.dat', 'setup.dat'])
    assert.equal(new Set(b.shelf().items.map(item => item.peerId)).size, 2)
    assert.equal(JSON.stringify(b.shelf()).includes(dir), false)

    let cancelled = false
    b.events.once('file-offer', data => queueMicrotask(() => { cancelled = b.cancelFile(data.offerId) }))
    assert.equal(b.downloadShelfFile(a.peerId, aFile), true)
    assert.equal(b.downloadShelfFile(a.peerId, aFile), false)
    assert.equal(c.downloadShelfFile(a.peerId, aFile), true)
    await waitFor(() => cancelled && row(b, a.peerId, aFile).state === 'cancelled' &&
        row(c, a.peerId, aFile).state === 'saved', 'Laptop cancel and other recipient save')
    assert.deepEqual(await readdir(bDownloads), [])
    const cSaved = transfers.find(item => item.receiver === c.peerId)
    assert.equal(cSaved.size, one.length)
    assert.equal(digest(await readFile(cSaved.path)), digest(one))

    assert.equal(b.downloadShelfFile(a.peerId, aFile), true)
    await waitFor(() => row(b, a.peerId, aFile).state === 'saved', 'Laptop retried the same listing')
    const bSaved = transfers.find(item => item.receiver === b.peerId)
    assert.equal(bSaved.size, one.length)
    assert.equal(digest(await readFile(bSaved.path)), digest(one))
    assert.deepEqual(await readdir(bDownloads), ['setup.dat'])
    assert.equal(publicMessages.length, 0, 'shelf listing and download never create public posts')

    await rm(sourceC)
    await c.refreshShelf()
    await waitFor(() => row(b, c.peerId, cFile)?.available === false, 'changed or missing original is unavailable')
    assert.equal(b.downloadShelfFile(c.peerId, cFile), false)
    assert.equal(c.removeShelfFile(cFile), true)
    await waitFor(() => !row(b, c.peerId, cFile), 'publisher removed its listing')

    await a.stop()
    await waitFor(() => row(b, a.peerId, aFile)?.available === false, 'known listing marked unavailable on source departure')
    const { node: d } = await make('Newcomer')
    await d.connect(b.getMultiaddrs()[0])
    await delay(100)
    assert.equal(row(d, a.peerId, aFile), undefined)
    assert.equal(digest(await readFile(bSaved.path)), digest(one))
    assert.equal(b.downloadShelfFile(a.peerId, aFile), false)
})

test('a Shared grant is bound to the requested peer and exact file before automatic acceptance', async () => {
    const sent = []
    const sessions = new Map(['a', 'other'].map(peer => [peer, { send(line) { sent.push(JSON.parse(line)); return true } }]))
    const shelf = createSharedShelf({ self: 'b', name: 'Laptop', peerName: id => id, sessions, files: {}, events: new EventEmitter() })
    const frame = (peer, op, data) => shelf.handle(peer, sessions.get(peer), { v: 1, op, ...data })
    const descriptor = { id: randomUUID(), name: 'setup.dat', size: 4, sha256: '1'.repeat(64), available: true }
    await frame('a', 'hello'); await frame('other', 'hello')
    await frame('a', 'list', { items: [descriptor] })
    assert.equal(shelf.download('a', descriptor.id), true)
    const { token } = sent.at(-1)
    const offerId = randomUUID()
    await frame('other', 'grant', { id: descriptor.id, token, offerId })
    assert.equal(shelf.transferId('other', offerId), undefined)
    await frame('a', 'grant', { id: descriptor.id, token, offerId })
    const offer = { ...descriptor, offerId, attachmentId: descriptor.id }
    assert.equal(shelf.classifyOffer('other', offer), 'reject')
    assert.equal(shelf.classifyOffer('a', { ...offer, sha256: '2'.repeat(64) }), 'reject')
    assert.equal(shelf.classifyOffer('a', offer), 'requested')
    shelf.closed('a')
    assert.equal(shelf.classifyOffer('a', offer), 'reject')
    assert.equal(shelf.download('a', descriptor.id), false)
    shelf.stop()
})
