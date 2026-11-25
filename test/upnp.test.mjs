// UPnP by hand (brief P3 round 2). All results are 127.0.0.1 results with a fake router. No LAN result.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { createAsscrackNode } from '../src/network/node.mjs'
import { DIALBACK_PROTOCOL } from '../src/network/fullnode.mjs'
import { startIgd, fakeClient } from './helpers/fake-igd.mjs'

const PUBLIC_IP = '93.184.216.34'
const LISTEN = ['/ip4/127.0.0.1/tcp/0']

async function waitFor(check, ms = 5000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (check()) return
        await delay(25)
    }
    assert.ok(check(), 'Timed out waiting for expected node behavior')
}

function upnpEvents(node) {
    const list = []
    node.events.on('upnp', e => list.push(e))
    return list
}

function portOf(node) {
    return Number(/\/tcp\/(\d+)/.exec(node.getMultiaddrs()[0])[1])
}

test('a public IP maps the listen port, and stop() unmaps it', { timeout: 15000 }, async () => {
    const igd = await startIgd({ externalIp: PUBLIC_IP })
    const a = await createAsscrackNode({ room: 'u1', listen: LISTEN, discovery: false, roomKey: 'k'.repeat(43), upnp: true, upnpClient: fakeClient(igd.port) })
    try {
        const events = upnpEvents(a)
        await waitFor(() => events.length === 1)
        const port = portOf(a)
        assert.equal(events[0].state, 'mapped')
        assert.equal(events[0].ip, PUBLIC_IP)
        assert.equal(events[0].port, port)
        assert.deepEqual(igd.log.map(r => r.action), ['GetExternalIPAddress', 'AddPortMapping'])
        assert.equal(igd.log[1].extPort, String(port))
        assert.equal(igd.log[1].intPort, String(port))
        assert.equal(igd.log[1].proto, 'TCP')
        assert.deepEqual(a.publicAddrs(), [`/ip4/${PUBLIC_IP}/tcp/${port}`])
        const invite = a.invite()
        assert.ok(invite, 'invite code expected')
        const { readInvite } = await import('../src/network/invite.mjs')
        assert.deepEqual(readInvite(invite).nodes, [{ id: a.peerId, addrs: [`/ip4/${PUBLIC_IP}/tcp/${port}`] }])
        assert.equal(a.fullNode(), false)
        await a.stop()
        assert.deepEqual(igd.log.map(r => r.action), ['GetExternalIPAddress', 'AddPortMapping', 'DeletePortMapping'])
        assert.equal(igd.log[2].extPort, String(port))
        assert.equal(events.at(-1).state, 'unmapped')
    } finally {
        await a.stop().catch(() => {})
        await igd.close()
    }
})

test('renew the same UPnP lease, retry a failure and stop renewing after unmap', { timeout: 15000 }, async t => {
    const igd = await startIgd({ externalIp: PUBLIC_IP, addDelay: 100 })
    const client = fakeClient(igd.port)
    const map = client.map.bind(client)
    const unmap = client.unmap.bind(client)
    const actions = []
    let attempts = 0
    client.map = async opts => {
        if (++attempts === 2) throw new Error('renewal rejected')
        await map(opts)
        actions.push('mapped')
    }
    client.unmap = async opts => {
        actions.push('unmap')
        await unmap(opts)
    }
    const warnings = t.mock.method(console, 'warn')
    const a = await createAsscrackNode({ room: 'renew', listen: LISTEN, discovery: false, upnp: true, upnpLeaseSeconds: 1, upnpClient: client })
    try {
        const maps = () => igd.log.filter(r => r.action === 'AddPortMapping')
        // The third attempt has reached the router. Stop while its response is still in flight.
        await waitFor(() => maps().length === 2)
        await a.stop()
        assert.deepEqual(actions, ['mapped', 'mapped', 'unmap'])
        assert.equal(igd.log.at(-1).action, 'DeletePortMapping')
        assert.deepEqual(maps()[1], maps()[0])
        assert.equal(maps()[0].ttl, '1')
        const failures = warnings.mock.calls.map(call => call.arguments[0]).filter(line => line.includes('upnp renew-failed'))
        assert.equal(failures.length, 1)
        assert.match(failures[0], /renewal rejected/)
        await delay(650) // past the next half-lease
        assert.equal(attempts, 3)
    } finally {
        await a.stop()
        await igd.close()
    }
})

test('a CGNAT external IP does not map', { timeout: 15000 }, async () => {
    const igd = await startIgd({ externalIp: '100.64.1.5' })
    const a = await createAsscrackNode({ room: 'u2', listen: LISTEN, discovery: false, upnp: true, upnpClient: fakeClient(igd.port) })
    try {
        const events = upnpEvents(a)
        await waitFor(() => events.length === 1)
        await delay(200)
        assert.equal(events.length, 1)
        assert.equal(events[0].state, 'none')
        assert.equal(events[0].reason, 'private-ip')
        assert.deepEqual(igd.log.map(r => r.action), ['GetExternalIPAddress'])
        assert.deepEqual(a.publicAddrs(), [])
    } finally {
        await a.stop()
        await igd.close()
    }
    assert.deepEqual(igd.log.map(r => r.action), ['GetExternalIPAddress'])
})

test('no gateway: the node starts and chat works', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode({ room: 'u3', listen: LISTEN, discovery: false, upnp: true, upnpClient: fakeClient(1, { fail: 'Could not discover gateway' }) })
    const events = upnpEvents(a)
    const b = await createAsscrackNode({ room: 'u3', listen: LISTEN, discovery: false })
    try {
        const got = []
        b.events.on('message', m => got.push(m.text))
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => a.peers().length === 1)
        assert.equal(a.send('hello'), 1)
        await waitFor(() => got.length === 1)
        assert.deepEqual(got, ['hello'])
        await waitFor(() => events.length === 1)
        assert.equal(events[0].state, 'none')
        assert.equal(events[0].reason, 'no-gateway')
    } finally {
        await b.stop()
        await a.stop()
    }
})

test('the task timeout gives reason timeout', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode({ room: 'u3t', listen: LISTEN, discovery: false, upnp: true, upnpTimeout: 200, upnpClient: fakeClient(1, { delay: 5000 }) })
    try {
        const events = upnpEvents(a)
        await waitFor(() => events.length === 1)
        assert.equal(events[0].reason, 'timeout')
    } finally {
        await a.stop()
    }
})

// The child process: the node:test runner can have its own uncaughtException listener.
const url = p => pathToFileURL(path.resolve(import.meta.dirname, p)).href
const CHILD_ROUTER_ERROR = `
import { createAsscrackNode } from ${JSON.stringify(url('../src/network/node.mjs'))}
import { startIgd, fakeClient } from ${JSON.stringify(url('./helpers/fake-igd.mjs'))}
let seen
const line = new Promise(r => { seen = r })
const igd = await startIgd({ externalIp: '${PUBLIC_IP}', addStatus: 500 })
const node = await createAsscrackNode({ room: 'u4', listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false, upnp: true, upnpTimeout: 500, upnpClient: fakeClient(igd.port) })
node.events.on('upnp', e => { console.log('event ' + e.state + ' ' + (e.reason ?? '')); seen() })
await line
await new Promise(r => setTimeout(r, 300))
const t0 = Date.now()
await node.stop()
console.log('stop ms ' + (Date.now() - t0))
await igd.close()
console.log('child stopped')
`
function runChild(code, ms) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', c => { stdout += c })
        child.stderr.on('data', c => { stderr += c })
        const timer = setTimeout(() => { child.kill(); reject(new Error(`child did not exit in ${ms} ms: ${stdout} ${stderr}`)) }, ms)
        child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    })
}

test('HTTP 500 on AddPortMapping: the mapper reports router-error and the process exits with code 0', { timeout: 30000 }, async () => {
    const result = await runChild(CHILD_ROUTER_ERROR, 20000)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /upnp none reason=router-error error="Action not authorized"/)
    assert.equal(result.stdout.match(/reason=router-error/g).length, 1, result.stdout)
    assert.equal(result.stdout.match(/event none router-error/g)?.length, 1, result.stdout)
    assert.doesNotMatch(result.stdout, /timeout/)
    assert.ok(Number(/stop ms (\d+)/.exec(result.stdout)[1]) < 1000, result.stdout)
    assert.match(result.stdout, /child stopped/)
})

test('a stop during a slow AddPortMapping unmaps before stop() returns', { timeout: 15000 }, async () => {
    const igd = await startIgd({ externalIp: PUBLIC_IP, addDelay: 500 })
    const a = await createAsscrackNode({ room: 'u5', listen: LISTEN, discovery: false, upnp: true, upnpClient: fakeClient(igd.port) })
    try {
        await waitFor(() => igd.log.some(r => r.action === 'AddPortMapping'))
        await a.stop()
        assert.deepEqual(igd.log.map(r => r.action), ['GetExternalIPAddress', 'AddPortMapping', 'DeletePortMapping'])
    } finally {
        await igd.close()
    }
})

test('a stop during a slow discovery sends no AddPortMapping', { timeout: 15000 }, async () => {
    const igd = await startIgd({ externalIp: PUBLIC_IP })
    const a = await createAsscrackNode({ room: 'u5b', listen: LISTEN, discovery: false, upnp: true, upnpClient: fakeClient(igd.port, { delay: 1000 }) })
    await delay(100)
    await a.stop()
    await delay(1500)
    assert.deepEqual(igd.log.map(r => r.action), [])
    await igd.close()
})

test('the dial-back request carries the mapped public port', { timeout: 15000 }, async () => {
    const igd = await startIgd({ externalIp: PUBLIC_IP })
    const a = await createAsscrackNode({ room: 'u6', listen: LISTEN, discovery: false, upnp: true, upnpClient: fakeClient(igd.port) })
    const b = await createAsscrackNode({ room: 'u6', listen: LISTEN, discovery: false, fullNode: false })
    try {
        const events = upnpEvents(a)
        await waitFor(() => events.length === 1)
        assert.equal(events[0].state, 'mapped')
        // B records the request value and does not dial (the fake public IP cannot be reached).
        const ports = []
        await b.libp2p.unhandle(DIALBACK_PROTOCOL)
        await b.libp2p.handle(DIALBACK_PROTOCOL, async ({ stream }) => {
            let text = ''
            for await (const chunk of stream.source) {
                text += Buffer.from(chunk.subarray()).toString('utf8')
                if (text.includes('\n')) break
            }
            ports.push(JSON.parse(text.split('\n')[0]).port)
            await stream.sink([new TextEncoder().encode(JSON.stringify({ ok: false }) + '\n')])
        }, { runOnTransientConnection: true })
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => ports.length === 1)
        assert.deepEqual(ports, [events[0].port])
        assert.equal(a.fullNode(), false)
    } finally {
        await b.stop()
        await a.stop()
        await igd.close()
    }
})

test('upnp false: no UPnP service', { timeout: 15000 }, async () => {
    const a = await createAsscrackNode({ room: 'u7', listen: LISTEN, discovery: false })
    try {
        assert.equal(a.libp2p.services.upnp, undefined)
    } finally {
        await a.stop()
    }
})

// Goal G1 (N2): an owner can turn on UPnP in a running room. All results are 127.0.0.1 results with a fake router.
async function protectedOwner(roomName, options) {
    const { newRoomKey } = await import('../src/network/invite.mjs')
    const { createDeviceIdentity, createRoomMembership } = await import('../src/network/room-membership.mjs')
    const roomKey = newRoomKey()
    const membership = createRoomMembership({ identity: createDeviceIdentity(), room: roomName, roomKey })
    const node = await createAsscrackNode({ room: roomName, roomKey, membership, listen: LISTEN, discovery: false, ...options })
    return { node, deviceId: createDeviceIdentity().id }
}

test('enableUpnp() maps a port for a running owner node that started with upnp false', { timeout: 15000 }, async () => {
    const igd = await startIgd({ externalIp: PUBLIC_IP })
    const { node: a, deviceId } = await protectedOwner('u8', { upnp: false, upnpClient: fakeClient(igd.port) })
    try {
        const events = upnpEvents(a)
        await delay(200)
        assert.deepEqual(igd.log, [], 'no router request before enableUpnp()')
        assert.deepEqual(a.publicAddrs(), [])
        assert.equal(a.upnpPending(), false)
        assert.throws(() => a.createMemberInvite(deviceId), /reachable owner address/)
        assert.equal(a.enableUpnp(), true)
        assert.equal(a.upnpPending(), true)
        await waitFor(() => events.length === 1)
        assert.equal(events[0].state, 'mapped')
        const port = portOf(a)
        assert.deepEqual(a.publicAddrs(), [`/ip4/${PUBLIC_IP}/tcp/${port}`])
        assert.equal(a.upnpPending(), false)
        const { readInvite } = await import('../src/network/invite.mjs')
        const code = a.createMemberInvite(deviceId)
        assert.deepEqual(readInvite(code).nodes, [{ id: a.peerId, addrs: [`/ip4/${PUBLIC_IP}/tcp/${port}`] }])
        // A second call with a mapping in place sends no new router request.
        assert.equal(a.enableUpnp(), true)
        await delay(100)
        assert.deepEqual(igd.log.map(r => r.action), ['GetExternalIPAddress', 'AddPortMapping'])
    } finally {
        await a.stop()
        await igd.close()
    }
    assert.equal(a.enableUpnp(), false, 'a stopped node')
})

test('enableUpnp() runs the UPnP task again after a task that ended with no mapping', { timeout: 15000 }, async () => {
    const mode = { externalIp: '100.64.1.5' }
    const igd = await startIgd(mode)
    const { node: a } = await protectedOwner('u9', { upnp: true, upnpClient: fakeClient(igd.port) })
    try {
        const events = upnpEvents(a)
        await waitFor(() => events.length === 1)
        assert.equal(events[0].state, 'none')
        assert.equal(events[0].reason, 'private-ip')
        assert.equal(a.upnpPending(), false)
        mode.externalIp = PUBLIC_IP
        assert.equal(a.enableUpnp(), true)
        assert.equal(a.upnpPending(), true)
        await waitFor(() => events.length === 2)
        assert.equal(events[1].state, 'mapped')
        assert.deepEqual(igd.log.map(r => r.action), ['GetExternalIPAddress', 'GetExternalIPAddress', 'AddPortMapping'])
        assert.deepEqual(a.publicAddrs(), [`/ip4/${PUBLIC_IP}/tcp/${portOf(a)}`])
    } finally {
        await a.stop()
        await igd.close()
    }
})

test('enableUpnp() is false for a LAN room, a typed address, fullNode not auto and a relay-only node', { timeout: 15000 }, async () => {
    const { newRoomKey } = await import('../src/network/invite.mjs')
    const { createDeviceIdentity, createRoomMembership } = await import('../src/network/room-membership.mjs')
    const nodes = []
    try {
        const lanKey = newRoomKey()
        const lan = createRoomMembership({ identity: createDeviceIdentity(), room: 'u10', roomKey: lanKey, lan: true })
        nodes.push(await createAsscrackNode({ room: 'u10', roomKey: lanKey, membership: lan, listen: LISTEN, discovery: false }))
        nodes.push((await protectedOwner('u11', { announce: ['/ip4/203.0.113.5/tcp/47000'] })).node)
        nodes.push((await protectedOwner('u12', { fullNode: false })).node)
        nodes.push(await createAsscrackNode({ room: 'u13', roomKey: newRoomKey(), relayOnly: true, discovery: false }))
        for (const node of nodes) {
            assert.equal(node.enableUpnp(), false)
            assert.equal(node.upnpPending(), false)
        }
    } finally {
        await Promise.allSettled(nodes.map(node => node.stop()))
    }
})

test('enableUpnp() maps a port for a non-host member without granting relay/full-node role', { timeout: 15000 }, async () => {
    const igd = await startIgd({ externalIp: PUBLIC_IP })
    const { newRoomKey, readInvite } = await import('../src/network/invite.mjs')
    const { createDeviceIdentity, createRoomMembership, restoreRoomMembership } = await import('../src/network/room-membership.mjs')
    const roomKey = newRoomKey()
    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room: 'u14', roomKey })
    const owner = await createAsscrackNode({
        room: 'u14', roomKey, membership: ownerMembership, listen: LISTEN, discovery: false,
        announce: ['/ip4/203.0.113.20/tcp/47000']
    })
    const memberId = createDeviceIdentity()
    const invite = readInvite(owner.createMemberInvite(memberId.id, { canHost: false }))
    const memberMembership = restoreRoomMembership({ identity: memberId, room: 'u14', roomKey, descriptor: invite.membership })
    const member = await createAsscrackNode({
        room: 'u14', roomKey, membership: memberMembership, listen: LISTEN, discovery: false,
        upnp: false, upnpClient: fakeClient(igd.port)
    })
    try {
        const events = upnpEvents(member)
        assert.equal(member.fullNode(), false)
        assert.equal(member.libp2p.services.relay, undefined)
        assert.equal(member.enableUpnp(), true)
        assert.equal(member.upnpPending(), true)
        await waitFor(() => events.length === 1)
        assert.equal(events[0].state, 'mapped')
        const port = portOf(member)
        assert.equal(member.upnpPending(), false)
        assert.deepEqual(member.publicAddrs(), [`/ip4/${PUBLIC_IP}/tcp/${port}`])
        assert.equal(member.fullNode(), false)
        assert.equal(member.libp2p.services.relay, undefined)
    } finally {
        await Promise.allSettled([member.stop(), owner.stop()])
        await igd.close()
    }
})

test('non-host member directAddrs upgrades a relayed session to a direct TCP connection', { timeout: 20000 }, async () => {
    const net = await import('node:net')
    const freePort = () => new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address()
            srv.close(err => (err ? reject(err) : resolve(port)))
        })
    })
    const { newRoomKey, readInvite } = await import('../src/network/invite.mjs')
    const { createDeviceIdentity, createRoomMembership, restoreRoomMembership } = await import('../src/network/room-membership.mjs')
    const roomKey = newRoomKey()
    const oPort = await freePort()
    const bPort = await freePort()
    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room: 'u15', roomKey })
    const owner = await createAsscrackNode({
        room: 'u15', roomKey, membership: ownerMembership, discovery: false,
        listen: [`/ip4/127.0.0.1/tcp/${oPort}`], announce: [`/ip4/127.0.0.1/tcp/${oPort}`],
        fullNode: true, allowPrivateFullNode: true
    })
    const aId = createDeviceIdentity()
    const bId = createDeviceIdentity()
    const aInvite = readInvite(owner.createMemberInvite(aId.id, { canHost: false }))
    const bInvite = readInvite(owner.createMemberInvite(bId.id, { canHost: false }))
    const memberA = await createAsscrackNode({
        room: 'u15', roomKey,
        membership: restoreRoomMembership({ identity: aId, room: 'u15', roomKey, descriptor: aInvite.membership }),
        listen: LISTEN, discovery: false, upnp: false, allowPrivateFullNode: true
    })
    const memberB = await createAsscrackNode({
        room: 'u15', roomKey,
        membership: restoreRoomMembership({ identity: bId, room: 'u15', roomKey, descriptor: bInvite.membership }),
        listen: [`/ip4/127.0.0.1/tcp/${bPort}`], announce: [`/ip4/127.0.0.1/tcp/${bPort}`],
        discovery: false, upnp: false, allowPrivateFullNode: true
    })
    try {
        const leftA = []
        const leftB = []
        const receivedB = []
        memberA.events.on('peer-left', e => leftA.push(e))
        memberB.events.on('peer-left', e => leftB.push(e))
        memberB.events.on('message', m => receivedB.push(m))

        await memberA.connect(`/ip4/127.0.0.1/tcp/${oPort}/p2p/${owner.peerId}`)
        await memberB.connect(`/ip4/127.0.0.1/tcp/${oPort}/p2p/${owner.peerId}`)

        await waitFor(() => memberA.topology().kinds?.[memberA.peerId]?.[memberB.peerId] === 'mesh' &&
            memberB.topology().kinds?.[memberB.peerId]?.[memberA.peerId] === 'mesh', 15000)

        assert.equal(memberA.fullNode(), false)
        assert.equal(memberB.fullNode(), false)
        assert.deepEqual(leftA, [])
        assert.deepEqual(leftB, [])

        memberA.send('hello direct')
        await waitFor(() => receivedB.some(m => m.text === 'hello direct'))
    } finally {
        await Promise.allSettled([memberA.stop(), memberB.stop(), owner.stop()])
    }
})

// NAT-PMP fallback unit tests (fake PMP client, no network packets).
test('NAT-PMP fallback: UPnP no-gateway falls back to NAT-PMP, renews, and stop() unmaps and closes', { timeout: 15000 }, async () => {
    const { EventEmitter } = await import('node:events')
    const calls = []
    let closed = 0
    const pmp = Object.assign(new EventEmitter(), {
        async externalIp() {
            calls.push(['externalIp'])
            return PUBLIC_IP
        },
        async portMapping(opts) {
            calls.push(['portMapping', { ...opts }])
            return opts
        },
        async portUnmapping(opts) {
            calls.push(['portUnmapping', { ...opts }])
        },
        async close() {
            closed++
        }
    })
    let factoryCalls = 0
    const client = fakeClient(1, {
        fail: 'Could not discover gateway',
        pmp: () => { factoryCalls++; return pmp }
    })
    const a = await createAsscrackNode({
        room: 'pmp-1', listen: LISTEN, discovery: false,
        upnp: true, upnpLeaseSeconds: 1, upnpClient: client
    })
    try {
        const events = upnpEvents(a)
        await waitFor(() => events.length === 1)
        const port = portOf(a)
        assert.equal(factoryCalls, 1)
        assert.equal(events[0].state, 'mapped')
        assert.equal(events[0].ip, PUBLIC_IP)
        assert.equal(events[0].port, port)
        assert.deepEqual(a.publicAddrs(), [`/ip4/${PUBLIC_IP}/tcp/${port}`])
        // Wait for at least one renewal via NAT-PMP.
        await waitFor(() => calls.filter(c => c[0] === 'portMapping').length >= 2)
        const firstMap = calls.find(c => c[0] === 'portMapping')[1]
        assert.deepEqual(firstMap, { public: port, private: port, type: 'tcp', ttl: 1 })
        await a.stop()
        assert.equal(events.at(-1).state, 'unmapped')
        const unmap = calls.find(c => c[0] === 'portUnmapping')
        assert.ok(unmap, 'expected portUnmapping call')
        assert.deepEqual(unmap[1], { public: port, private: port, type: 'tcp' })
        assert.equal(closed, 1)
    } finally {
        await a.stop().catch(() => {})
    }
})

test('NAT-PMP fallback: UPnP externalIp router-error falls back to NAT-PMP and succeeds', { timeout: 15000 }, async () => {
    const { EventEmitter } = await import('node:events')
    const { createPortMapper } = await import('../src/network/port-mapper.mjs')
    const calls = []
    const upnp = {
        async externalIp() { throw new Error('router refused GetExternalIPAddress') },
        async portMapping() { throw new Error('should not be called') },
        async portUnmapping() {},
        destroy() {}
    }
    const pmp = Object.assign(new EventEmitter(), {
        async externalIp() { calls.push('externalIp'); return PUBLIC_IP },
        async portMapping(opts) { calls.push(['portMapping', opts]); return opts },
        async portUnmapping(opts) { calls.push(['portUnmapping', opts]) },
        async close() { calls.push('close') }
    })
    const a = await createAsscrackNode({
        room: 'pmp-2', listen: LISTEN, discovery: false,
        upnp: true, upnpClient: createPortMapper(upnp, { pmp: () => pmp })
    })
    try {
        const events = upnpEvents(a)
        await waitFor(() => events.length === 1)
        assert.equal(events[0].state, 'mapped')
        assert.equal(events[0].ip, PUBLIC_IP)
        assert.equal(calls[0], 'externalIp')
        assert.equal(calls[1][0], 'portMapping')
        await a.stop()
        assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'portUnmapping'))
        assert.ok(calls.includes('close'))
    } finally {
        await a.stop().catch(() => {})
    }
})

test('NAT-PMP fallback: HTTP 500 on AddPortMapping falls back to NAT-PMP and unmaps via NAT-PMP on stop()', { timeout: 15000 }, async () => {
    const { EventEmitter } = await import('node:events')
    const igd = await startIgd({ externalIp: PUBLIC_IP, addStatus: 500 })
    const calls = []
    const pmp = Object.assign(new EventEmitter(), {
        async externalIp() { calls.push('externalIp'); return PUBLIC_IP },
        async portMapping(opts) { calls.push(['portMapping', opts]); return opts },
        async portUnmapping(opts) { calls.push(['portUnmapping', opts]) },
        async close() { calls.push('close') }
    })
    const a = await createAsscrackNode({
        room: 'pmp-3', listen: LISTEN, discovery: false,
        upnp: true, upnpClient: fakeClient(igd.port, { pmp: () => pmp })
    })
    try {
        const events = upnpEvents(a)
        await waitFor(() => events.length === 1)
        const port = portOf(a)
        assert.equal(events[0].state, 'mapped')
        assert.equal(events[0].ip, PUBLIC_IP)
        assert.equal(events[0].port, port)
        assert.deepEqual(igd.log.map(r => r.action), ['GetExternalIPAddress', 'AddPortMapping'])
        assert.ok(!calls.includes('externalIp'), 'externalIp already succeeded via UPnP')
        assert.deepEqual(calls[0][1], { public: port, private: port, type: 'tcp', ttl: 1800 })
        await a.stop()
        assert.equal(igd.log.filter(r => r.action === 'DeletePortMapping').length, 0)
        assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'portUnmapping'))
        assert.ok(calls.includes('close'))
    } finally {
        await a.stop().catch(() => {})
        await igd.close()
    }
})

test('NAT-PMP fallback: both UPnP and NAT-PMP fail (timeout, error, or error event) -> original UPnP reason, closes PMP, no crash', { timeout: 15000 }, async () => {
    const { EventEmitter } = await import('node:events')

    // Case 1: no-gateway + PMP timeout
    let closedTimeout = 0
    const timeoutPmp = Object.assign(new EventEmitter(), {
        externalIp: () => new Promise(() => {}),
        portMapping: () => new Promise(() => {}),
        portUnmapping: () => new Promise(() => {}),
        close: async () => { closedTimeout++ }
    })
    const a1 = await createAsscrackNode({
        room: 'pmp-fail-1', listen: LISTEN, discovery: false,
        upnp: true, upnpTimeout: 1000,
        upnpClient: fakeClient(1, { fail: 'Could not discover gateway', pmp: () => timeoutPmp, pmpTimeout: 50 })
    })
    try {
        const events = upnpEvents(a1)
        await waitFor(() => events.length === 1)
        assert.equal(events[0].state, 'none')
        assert.equal(events[0].reason, 'no-gateway')
        assert.equal(closedTimeout, 1)
    } finally {
        await a1.stop()
    }

    // Case 2: router-error (HTTP 500) + PMP emits 'error' event on EventEmitter
    const igd = await startIgd({ externalIp: PUBLIC_IP, addStatus: 500 })
    let closedErr = 0
    const errPmp = Object.assign(new EventEmitter(), {
        externalIp: async () => PUBLIC_IP,
        portMapping() {
            queueMicrotask(() => this.emit('error', new Error('EADDRINUSE')))
            return new Promise(() => {})
        },
        portUnmapping: async () => {},
        close: async () => { closedErr++ }
    })
    const a2 = await createAsscrackNode({
        room: 'pmp-fail-2', listen: LISTEN, discovery: false,
        upnp: true, upnpTimeout: 1000,
        upnpClient: fakeClient(igd.port, { pmp: () => errPmp, pmpTimeout: 500 })
    })
    try {
        const events = upnpEvents(a2)
        await waitFor(() => events.length === 1)
        assert.equal(events[0].state, 'none')
        assert.equal(events[0].reason, 'router-error')
        assert.equal(closedErr, 1)
    } finally {
        await a2.stop()
        await igd.close()
    }
})

test('NAT-PMP fallback: when UPnP succeeds or returns CGNAT IP, NAT-PMP factory is not called', { timeout: 15000 }, async () => {
    let factoryCalls = 0
    const igdOk = await startIgd({ externalIp: PUBLIC_IP })
    const a1 = await createAsscrackNode({
        room: 'pmp-skip-1', listen: LISTEN, discovery: false,
        upnp: true, upnpClient: fakeClient(igdOk.port, { pmp: () => { factoryCalls++; return {} } })
    })
    try {
        const events = upnpEvents(a1)
        await waitFor(() => events.length === 1)
        assert.equal(events[0].state, 'mapped')
        assert.equal(factoryCalls, 0)
    } finally {
        await a1.stop()
        await igdOk.close()
    }

    const igdCgnat = await startIgd({ externalIp: '100.64.1.5' })
    const a2 = await createAsscrackNode({
        room: 'pmp-skip-2', listen: LISTEN, discovery: false,
        upnp: true, upnpClient: fakeClient(igdCgnat.port, { pmp: () => { factoryCalls++; return {} } })
    })
    try {
        const events = upnpEvents(a2)
        await waitFor(() => events.length === 1)
        assert.equal(events[0].state, 'none')
        assert.equal(events[0].reason, 'private-ip')
        assert.equal(factoryCalls, 0)
    } finally {
        await a2.stop()
        await igdCgnat.close()
    }
})
