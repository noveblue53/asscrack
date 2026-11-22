// P7c: Resume of a kept part after a restart of the app. The receiver keeps the retry state next to the part, and
// the sender keeps the grant of the paused leg (in a protected room, by the device ID of the receiver). Each restart
// gives a new libp2p peer ID. All results of this file are 127.0.0.1 results on this PC, not LAN results.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { newRoomKey, readInvite } from '../src/network/invite.mjs'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'
import { FILE_PROTOCOLS } from '../src/network/file-transfer.mjs'
import { createGrantStore } from '../src/network/send-grants.mjs'

const MiB = 1024 * 1024
const EVENTS = ['offer', 'progress', 'done', 'failed', 'cancelled', 'paused', 'resumed', 'restarted', 'discarded',
    'retried', 'partials']

async function waitUntil(check, limit, what = 'condition') {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
        if (await check()) return
        await delay(20)
    }
    assert.ok(await check(), `${what} not true within ${limit} ms`)
}

const localAddr = node => node.getMultiaddrs().find(addr => addr.startsWith('/ip4/127.0.0.1/') && !addr.includes('/p2p-circuit'))
const linked = (x, y) => x.peers().includes(y.peerId) && y.peers().includes(x.peerId)
const resumeFiles = dir => fsp.readdir(dir).then(names => names.filter(n => n.startsWith('.asscrack-resume-')))

async function sha(file) {
    const h = createHash('sha256')
    for await (const c of createReadStream(file)) h.update(c)
    return h.digest('hex')
}

async function writeRandom(file, size) {
    const fh = await fsp.open(file, 'w')
    try {
        for (let done = 0; done < size; done += MiB) await fh.write(randomBytes(Math.min(MiB, size - done)))
    } finally {
        await fh.close()
    }
}

// Counts the bytes of each file stream that `node` opens (the receiver side). `onBytes` runs before each write.
function tapFileStreams(node, onBytes = () => {}) {
    const streams = []
    const wrap = connection => {
        if (connection.tapped) return
        connection.tapped = true
        const open = connection.newStream.bind(connection)
        connection.newStream = async (protocol, options) => {
            const stream = await open(protocol, options)
            if (![protocol].flat().some(p => FILE_PROTOCOLS.includes(p))) return stream
            const entry = { protocol: stream.protocol, bytes: 0 }
            streams.push(entry)
            const source = stream.source
            stream.source = (async function* () {
                for await (const chunk of source) {
                    entry.bytes += chunk.byteLength
                    onBytes(entry.bytes, entry)
                    yield chunk
                }
            })()
            return stream
        }
    }
    for (const connection of node.libp2p.getConnections()) wrap(connection)
    node.libp2p.addEventListener('connection:open', ({ detail }) => wrap(detail))
    return streams
}

// A protected room: the owner O, and members with their own device identity. A member keeps its identity, its
// download folder and its grant file over a restart.
async function protectedRoom(ctx) {
    const room = 'Resume restart room'
    const roomKey = newRoomKey()
    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: true })
    const base = { room, roomKey, discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: false,
        heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 300 }
    const dir = async prefix => {
        const d = await fsp.mkdtemp(path.join(os.tmpdir(), `asscrack-p7c-${prefix}-`))
        ctx.dirs.push(d)
        return d
    }
    const owner = await createAsscrackNode({ ...base, membership: ownerMembership, name: 'Owner', downloadDir: await dir('o') })
    ctx.nodes.push(owner)

    async function account(name, { partials = {} } = {}) {
        const identity = createDeviceIdentity()
        const descriptor = readInvite(owner.createMemberInvite(identity.id, { canHost: false })).membership
        const downloadDir = await dir(name)
        const grantsFile = path.join(downloadDir, 'profile', 'resume-grants.json')
        const person = { name, identity, descriptor, dir: downloadDir, grantsFile, node: null }
        person.start = async (options = {}) => {
            const membership = restoreRoomMembership({ identity, room, roomKey, descriptor })
            const node = await createAsscrackNode({ ...base, membership, name, downloadDir,
                partials: { grantsFile, ...partials, ...options.partials } })
            const log = Object.fromEntries(EVENTS.map(k => [k, []]))
            for (const k of EVENTS) node.events.on(`file-${k}`, e => log[k].push(e))
            Object.assign(node, { log, dir: downloadDir })
            ctx.nodes.push(node)
            await node.connect(localAddr(owner))
            await waitUntil(() => linked(node, owner) && node.memberState().admitted, 8000, `${name} admitted`)
            person.node = node
            return node
        }
        return person
    }
    return { owner, account }
}

async function cleanup(ctx) {
    await Promise.allSettled(ctx.nodes.map(n => n.stop()))
    await Promise.allSettled(ctx.dirs.map(d => fsp.rm(d, { recursive: true, force: true })))
}

async function meet(x, y) {
    if (!linked(x, y)) await y.connect(localAddr(x))
    await waitUntil(() => linked(x, y), 8000, 'session between the members')
}

// A sends `size` bytes to B. B pauses near 40 %. Returns the source file, the offer and the pause of B.
async function sendAndPause(a, b, size) {
    const file = path.join(a.dir, 'large.bin')
    await writeRandom(file, size)
    let paused = false
    tapFileStreams(b, total => {
        if (paused || total < size * 0.4) return
        paused = b.pauseFile(b.log.offer.at(-1).offerId)
        assert.equal(paused, true)
    })
    const offer = await a.offerFile(file, b.peerId)
    await waitUntil(() => b.log.offer.length === 1, 5000, 'offer')
    assert.equal(b.acceptFile(offer.offerId), true)
    await waitUntil(() => b.log.paused.length === 1 && a.log.paused.length === 1, 15000, 'paused on both ends')
    return { file, offer, partial: b.log.paused[0] }
}

const replyBytes = offset => Buffer.byteLength(JSON.stringify({ offset }) + '\n')

test('after a restart of the receiver (a new peer ID), Resume of the kept part sends only the remainder (127.0.0.1)',
    { timeout: 90000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { account } = await protectedRoom(ctx)
        const alice = await account('Alice')
        const bob = await account('Bob')
        const a = await alice.start()
        let b = await bob.start()
        await meet(a, b)
        const size = 16 * MiB
        const { offer, partial } = await sendAndPause(a, b, size)
        const oldPeer = b.peerId
        await b.stop()
        b = await bob.start()
        assert.notEqual(b.peerId, oldPeer, 'a restart gives a new peer ID')
        const [kept] = await b.partials()
        assert.equal(kept.key, partial.key)
        assert.equal(kept.bytes, partial.bytes)
        assert.equal(kept.offerId, offer.offerId)
        assert.equal(kept.resumable, true)
        assert.equal(kept.from, 'Alice')
        assert.equal(kept.peerId, a.peerId)
        assert.equal(Object.hasOwn(kept, 'device'), false, 'the window gets no device ID')
        await meet(a, b)
        const streams = tapFileStreams(b)
        assert.equal(b.resumeFile(offer.offerId), true)
        await waitUntil(() => b.log.done.length === 1 && a.log.done.length === 1, 20000, 'resumed transfer done')
        assert.equal(b.log.offer.length, 0, 'Resume needs no new offer and no accept')
        assert.equal(b.log.resumed[0].offset, partial.bytes)
        assert.equal(b.log.resumed[0].resumeOf, offer.offerId)
        assert.equal(a.log.done[0].offset, partial.bytes)
        assert.equal(a.log.done[0].sent, size - partial.bytes)
        assert.equal(streams.at(-1).bytes, size - partial.bytes + replyBytes(partial.bytes))
        assert.equal(await sha(b.log.done[0].path), offer.sha256)
        // The paused row of the sender moves to the new peer ID of the receiver.
        assert.equal(a.log.retried.length, 1)
        assert.equal(a.log.retried[0].retryOf, offer.offerId)
        assert.equal(a.log.retried[0].peerId, b.peerId)
        assert.equal(a.log.retried[0].previousPeerId, oldPeer)
        assert.deepEqual(await resumeFiles(b.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('with the sender offline at the start of the receiver, Resume works when the sender starts again (127.0.0.1)',
    { timeout: 90000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { account } = await protectedRoom(ctx)
        const alice = await account('Alice')
        const bob = await account('Bob')
        let a = await alice.start()
        let b = await bob.start()
        await meet(a, b)
        const size = 16 * MiB
        const { offer, partial } = await sendAndPause(a, b, size)
        await b.stop()
        await a.stop()
        const saved = await createGrantStore({ file: alice.grantsFile }).load()
        assert.equal(saved.length, 1, 'the sender keeps the grant in its profile')
        assert.equal(saved[0].offerId, offer.offerId)
        assert.equal(saved[0].device, bob.identity.id)
        b = await bob.start()
        assert.equal(b.resumeFile(offer.offerId), false, 'the sender is offline')
        a = await alice.start()
        await meet(a, b)
        assert.equal(b.resumeFile(offer.offerId), true, 'the node finds the sender by its device ID')
        await waitUntil(() => b.log.done.length === 1 && a.log.done.length === 1, 20000, 'resumed transfer done')
        assert.equal(a.log.done[0].sent, size - partial.bytes)
        assert.equal(await sha(b.log.done[0].path), offer.sha256)
        assert.equal(a.log.retried[0].previousPeerId, undefined, 'the sender has no row of the last run')
        await waitUntil(async () => (await createGrantStore({ file: alice.grantsFile }).load()).length === 0, 5000,
            'the used grant is removed from the profile')
    } finally {
        await cleanup(ctx)
    }
})

test('another device with a copy of the kept part is refused, and its copy stays (127.0.0.1)', { timeout: 90000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { account } = await protectedRoom(ctx)
        const alice = await account('Alice')
        const bob = await account('Bob')
        const carol = await account('Carol')
        const a = await alice.start()
        const b = await bob.start()
        await meet(a, b)
        const { offer, partial } = await sendAndPause(a, b, 8 * MiB)
        await b.stop()
        // Carol has the files of the kept part of Bob, with the offer ID and the sender of Bob.
        for (const name of await resumeFiles(bob.dir)) await fsp.copyFile(path.join(bob.dir, name), path.join(carol.dir, name))
        const c = await carol.start()
        await meet(a, c)
        assert.equal((await c.partials())[0].resumable, true)
        assert.equal(c.resumeFile(offer.offerId), true, 'the request goes out')
        await waitUntil(() => c.log.failed.length === 1, 10000, 'refusal')
        assert.equal(c.log.failed[0].reason, 'the sender can no longer offer this file')
        assert.equal(a.log.retried.length, 0, 'the sender sent no file to Carol')
        await waitUntil(async () => (await c.partials())[0]?.resumable === undefined, 5000, 'retry state removed')
        const [stays] = await c.partials()
        assert.equal(stays.bytes, partial.bytes, 'the part stays: a new offer can continue it')
        // Bob can still resume: the grant stays with the device of Bob.
        const again = await bob.start()
        await meet(a, again)
        assert.equal(again.resumeFile(offer.offerId), true)
        await waitUntil(() => again.log.done.length === 1, 20000, 'Bob resumed')
        assert.equal(await sha(again.log.done[0].path), offer.sha256)
    } finally {
        await cleanup(ctx)
    }
})

test('an expired grant is refused and the part stays; a changed source deletes the part (127.0.0.1)', { timeout: 90000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const { account } = await protectedRoom(ctx)
        const alice = await account('Alice', { partials: { ttl: 1500 } })
        const bob = await account('Bob')
        const a = await alice.start()
        let b = await bob.start()
        await meet(a, b)
        const first = await sendAndPause(a, b, 8 * MiB)
        await b.stop()
        await delay(1600)
        b = await bob.start()
        await meet(a, b)
        assert.equal(b.resumeFile(first.offer.offerId), true)
        await waitUntil(() => b.log.failed.length === 1, 10000, 'refusal of the expired grant')
        assert.equal(b.log.failed[0].reason, 'the sender can no longer offer this file')
        await waitUntil(async () => (await b.partials())[0]?.resumable === undefined, 5000, 'retry state removed')
        assert.equal((await b.partials())[0].bytes, first.partial.bytes)
        assert.equal(await b.discardPartial(first.partial.key), true)

        // The second file: the source changes while the receiver is away.
        await a.stop()
        const a2 = await alice.start({ partials: { ttl: 60000 } })
        await meet(a2, b)
        b.log.offer.length = 0
        b.log.paused.length = 0
        a2.log.paused.length = 0
        const second = await sendAndPause(a2, b, 8 * MiB)
        await b.stop()
        await fsp.appendFile(second.file, 'changed')
        b = await bob.start()
        await meet(a2, b)
        assert.equal(b.resumeFile(second.offer.offerId), true)
        await waitUntil(() => b.log.failed.length === 1, 10000, 'changed source')
        assert.equal(b.log.failed[0].reason, 'the source file changed')
        await waitUntil(async () => (await b.partials()).length === 0, 5000, 'part deleted')
        assert.deepEqual(await resumeFiles(bob.dir), [])
    } finally {
        await cleanup(ctx)
    }
})

test('a room with no membership keeps no retry state: a restart needs a new offer as before (127.0.0.1)', { timeout: 60000 }, async () => {
    const ctx = { nodes: [], dirs: [] }
    try {
        const base = { room: 'legacy resume', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false,
            heartbeatInterval: 200, hostTimeout: 1000, electionDelay: 300 }
        const mk = async name => {
            const downloadDir = await fsp.mkdtemp(path.join(os.tmpdir(), `asscrack-p7c-${name}-`))
            ctx.dirs.push(downloadDir)
            const node = await createAsscrackNode({ ...base, downloadDir, partials: { grantsFile: path.join(downloadDir, 'g.json') } })
            const log = Object.fromEntries(EVENTS.map(k => [k, []]))
            for (const k of EVENTS) node.events.on(`file-${k}`, e => log[k].push(e))
            Object.assign(node, { log, dir: downloadDir })
            ctx.nodes.push(node)
            return node
        }
        const a = await mk('a')
        const b = await mk('b')
        await meet(a, b)
        const { offer } = await sendAndPause(a, b, 8 * MiB)
        await b.stop()
        const again = await createAsscrackNode({ ...base, downloadDir: b.dir })
        ctx.nodes.push(again)
        const [kept] = await again.partials()
        assert.equal(kept.resumable, undefined)
        assert.equal(again.resumeFile(offer.offerId), false)
        assert.deepEqual(await createGrantStore({ file: path.join(a.dir, 'g.json') }).load(), [], 'no device ID: no saved grant')
    } finally {
        await cleanup(ctx)
    }
})
