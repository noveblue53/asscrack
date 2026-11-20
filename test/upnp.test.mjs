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
    const otherPort = { publicPort: 1234, localPort: 1234, localAddress: '192.0.2.1', protocol: 'TCP' }
    client.openPorts.push(otherPort)
    const map = client.map.bind(client)
    const unmap = client.unmap.bind(client)
    const actions = []
    let attempts = 0
    let portsBeforeUnmap
    client.map = async opts => {
        if (++attempts === 2) throw new Error('renewal rejected')
        await map(opts)
        actions.push('mapped')
    }
    client.unmap = async opts => {
        portsBeforeUnmap = [...client.openPorts]
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
        assert.equal(portsBeforeUnmap.length, 2, 'one record per mapping after renewal')
        assert.ok(portsBeforeUnmap.includes(otherPort))
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
import { installUpnpGuard } from '${url('../src/network/upnp-guard.mjs')}'
import { createAsscrackNode } from '${url('../src/network/node.mjs')}'
import { startIgd, fakeClient } from '${url('./helpers/fake-igd.mjs')}'
let seen
const line = new Promise(r => { seen = r })
installUpnpGuard({ log: text => { console.log(text); seen() } })
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
const CHILD_OTHER_ERROR = `
import { installUpnpGuard } from '${url('../src/network/upnp-guard.mjs')}'
installUpnpGuard()
installUpnpGuard()
setTimeout(() => { throw new Error('Request failed: 500 but not from the router') }, 10)
setTimeout(() => {}, 5000)
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

test('HTTP 500 on AddPortMapping: the guard logs router-error and the process exits with code 0', { timeout: 30000 }, async () => {
    const result = await runChild(CHILD_ROUTER_ERROR, 20000)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /upnp none reason=router-error error="Request failed: 500"/)
    assert.equal(result.stdout.match(/reason=router-error/g).length, 1, result.stdout)
    assert.equal(result.stdout.match(/event none router-error/g)?.length, 1, result.stdout)
    assert.doesNotMatch(result.stdout, /timeout/)
    assert.ok(Number(/stop ms (\d+)/.exec(result.stdout)[1]) < 1000, result.stdout)
    assert.match(result.stdout, /child stopped/)
})

test('an error that does not match the guard filter still exits with code 1', { timeout: 30000 }, async () => {
    const result = await runChild(CHILD_OTHER_ERROR, 20000)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Request failed: 500 but not from the router/)
    assert.doesNotMatch(result.stdout, /router-error/)
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
