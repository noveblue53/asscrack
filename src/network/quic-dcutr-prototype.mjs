import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { quic } from '@chainsafe/libp2p-quic'
import { dcutr } from '@libp2p/dcutr'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { multiaddr } from '@multiformats/multiaddr'
import { createStreamCompatibleLibp2p } from './libp2p-streams.mjs'

export const QUIC_PROBE_PROTOCOL = '/asscrack/quic-probe/1.0.0'

const require = createRequire(import.meta.url)

/**
 * Resolve the platform QUIC native binary path and whether it sits in app.asar.unpacked.
 */
export function resolveNativeBinaryPath() {
    const specifier = '@chainsafe/libp2p-quic-win32-x64-msvc/libp2p-quic.win32-x64-msvc.node'
    try {
        const resolved = require.resolve(specifier)
        return {
            specifier,
            path: resolved,
            unpackedInAsar: resolved.includes('app.asar.unpacked'),
            error: null
        }
    } catch (err) {
        return {
            specifier,
            path: null,
            unpackedInAsar: false,
            error: err?.message ?? String(err)
        }
    }
}

/**
 * Create a libp2p node configured with QUIC, circuit-relay transport, identify, and optional DCUtR / relay server.
 */
export async function createQuicPeer({
    listen = null,
    announce = [],
    relayServer = false,
    enableDcutr = true
} = {}) {
    const listenAddrs = listen ?? (relayServer
        ? ['/ip4/127.0.0.1/udp/0/quic-v1']
        : ['/ip4/127.0.0.1/udp/0/quic-v1', '/p2p-circuit'])
    const services = { identify: identify() }
    if (relayServer) {
        services.relay = circuitRelayServer({
            reservations: { maxReservations: 32 }
        })
    }
    if (enableDcutr) {
        services.dcutr = dcutr()
    }
    return createStreamCompatibleLibp2p({
        start: true,
        addresses: { listen: listenAddrs, announce },
        transports: [quic(), circuitRelayTransport()],
        services,
        streamMuxers: [yamux()],
        connectionEncrypters: [noise()],
        connectionManager: { minConnections: 0, maxConnections: 32 }
    })
}

export function extractUdpPort(addr) {
    const match = /\/udp\/(\d+)\//.exec(String(addr ?? ''))
    return match ? Number(match[1]) : null
}

/**
 * Measure whether an outbound QUIC dial reuses the node's QUIC listener UDP port.
 */
export async function probeOutboundPortReuse() {
    const nodeA = await createQuicPeer({ enableDcutr: false })
    const nodeB = await createQuicPeer({ enableDcutr: false })
    try {
        const listenerAddr = nodeA.getMultiaddrs().find(ma => ma.toString().includes('/quic-v1'))?.toString() ?? null
        const listenerPort = extractUdpPort(listenerAddr)
        const targetAddr = nodeB.getMultiaddrs().find(ma => ma.toString().includes('/quic-v1'))
        if (!targetAddr) throw new Error('Node B has no QUIC listen address')

        const inboundPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out waiting for inbound connection on Node B')), 5000)
            nodeB.addEventListener('connection:open', ({ detail: conn }) => {
                if (conn.remotePeer.equals(nodeA.peerId)) {
                    clearTimeout(timer)
                    resolve(conn)
                }
            })
        })

        await nodeA.dial(targetAddr)
        const connOnB = await inboundPromise
        const observedRemoteAddr = connOnB.remoteAddr.toString()
        const observedRemotePort = extractUdpPort(observedRemoteAddr)

        return {
            directQuicOk: true,
            listenerAddr,
            listenerPort,
            observedRemoteAddr,
            observedRemotePort,
            portReused: listenerPort !== null && observedRemotePort !== null && listenerPort === observedRemotePort
        }
    } finally {
        await Promise.allSettled([nodeA.stop(), nodeB.stop()])
    }
}

/**
 * Send an echo payload over a libp2p stream and verify the exact round-trip bytes.
 */
export async function echoOverStream(stream, payload = 'quic-probe-ping') {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const expected = encoder.encode(payload)
    if (!stream.send(expected)) await stream.onDrain()
    await stream.close()

    const chunks = []
    for await (const chunk of stream) {
        chunks.push(chunk.subarray ? chunk.subarray() : Uint8Array.from(chunk))
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
        out.set(c, offset)
        offset += c.length
    }
    return decoder.decode(out) === payload
}

/**
 * Register the echo handler used by the prototype probe and benchmark.
 */
export function registerEchoHandler(node) {
    node.handle(QUIC_PROBE_PROTOCOL, async ({ stream }) => {
        try {
            for await (const chunk of stream) {
                const bytes = chunk.subarray ? chunk.subarray() : Uint8Array.from(chunk)
                if (!stream.send(bytes)) await stream.onDrain()
            }
            await stream.close()
        } catch (err) {
            stream.abort(err)
        }
    }, { runOnLimitedConnection: true })
}

async function waitForCircuitAddr(node, relayPeerId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const found = node.getMultiaddrs().find(ma => {
            const s = ma.toString()
            return s.includes(`/p2p/${relayPeerId}/p2p-circuit`)
        })
        if (found) return found.toString()
        await delay(50)
    }
    throw new Error('Timed out waiting for relay circuit reservation multiaddr')
}

export async function waitForDirectConnection(node, remotePeerId, timeoutMs = 15000) {
    const existing = node.getConnections(remotePeerId).find(c => !c.limits && !c.remoteAddr.toString().includes('/p2p-circuit'))
    if (existing) return existing

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            node.removeEventListener('connection:open', onOpen)
            reject(new Error(`Timed out after ${timeoutMs}ms waiting for direct DCUtR connection`))
        }, timeoutMs)

        function onOpen({ detail: conn }) {
            if (conn.remotePeer.equals(remotePeerId) && !conn.limits && !conn.remoteAddr.toString().includes('/p2p-circuit')) {
                clearTimeout(timer)
                node.removeEventListener('connection:open', onOpen)
                resolve(conn)
            }
        }
        node.addEventListener('connection:open', onOpen)
    })
}

/**
 * Run a full loopback probe: native binary check, outbound port reuse, and relay -> DCUtR upgrade + echo.
 */
export async function runLoopbackProbe({ timeoutMs = 10000 } = {}) {
    const nativeBinary = resolveNativeBinaryPath()
    const runtime = {
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        platform: process.platform,
        arch: process.arch
    }

    let portReuse = null
    let relay = null
    let peerA = null
    let peerB = null
    let error = null
    let directQuicOk = false
    let initialWasLimited = null
    let upgraded = false
    let elapsedMs = null
    let directAddr = null
    let upgradeError = null
    let echoOk = false
    let echoVia = null

    try {
        portReuse = await probeOutboundPortReuse()
        directQuicOk = Boolean(portReuse.directQuicOk)

        relay = await createQuicPeer({ relayServer: true, enableDcutr: false })
        peerA = await createQuicPeer({ enableDcutr: true })
        peerB = await createQuicPeer({ enableDcutr: true })
        registerEchoHandler(peerB)

        const relayAddr = relay.getMultiaddrs().find(ma => ma.toString().includes('/quic-v1'))
        if (!relayAddr) throw new Error('Relay has no QUIC listen address')

        await Promise.all([peerA.dial(relayAddr), peerB.dial(relayAddr)])
        const circuitAddr = await waitForCircuitAddr(peerB, relay.peerId.toString(), 5000)

        const dialStart = Date.now()
        const initialConn = await peerA.dial(multiaddr(circuitAddr))
        initialWasLimited = Boolean(initialConn.limits)

        let activeConn = initialConn
        try {
            const directConn = await waitForDirectConnection(peerA, peerB.peerId, timeoutMs)
            upgraded = true
            elapsedMs = Date.now() - dialStart
            directAddr = directConn.remoteAddr.toString()
            activeConn = directConn
        } catch (err) {
            upgradeError = err?.message ?? String(err)
            elapsedMs = Date.now() - dialStart
        }

        const stream = await activeConn.newStream(QUIC_PROBE_PROTOCOL, { runOnLimitedConnection: true })
        echoOk = await echoOverStream(stream)
        echoVia = upgraded ? 'direct-quic' : 'relayed-circuit'
    } catch (err) {
        error = err?.message ?? String(err)
    } finally {
        await Promise.allSettled([
            peerA?.stop(),
            peerB?.stop(),
            relay?.stop()
        ])
    }

    return {
        ok: Boolean(directQuicOk && echoOk && !error),
        runtime,
        nativeBinary,
        directQuicOk,
        portReuse,
        dcutrUpgrade: {
            initialWasLimited,
            upgraded,
            elapsedMs,
            directAddr,
            error: upgradeError
        },
        echoOk,
        echoVia,
        error
    }
}

/**
 * Run an initiator probe against a remote relay and circuit target, waiting for DCUtR upgrade and running echo.
 */
export async function runInitiatorProbe({ relay, target, port = 0, timeoutMs = 15000 } = {}) {
    if (!relay || !target) throw new Error('relay and target are required')
    const relayMa = multiaddr(relay)
    const targetMa = multiaddr(target)
    const initiator = await createQuicPeer({
        listen: [`/ip4/0.0.0.0/udp/${port}/quic-v1`, '/p2p-circuit'],
        enableDcutr: true
    })
    const listenQuic = initiator.getMultiaddrs().find(ma => ma.toString().includes('/quic-v1'))?.toString() ?? null
    const summary = {
        role: 'initiator',
        runtime: {
            node: process.versions.node,
            electron: process.versions.electron ?? null,
            platform: process.platform,
            arch: process.arch
        },
        listenQuic,
        listenPort: extractUdpPort(listenQuic),
        relay,
        target,
        initialWasLimited: null,
        upgraded: false,
        elapsedMs: null,
        directAddr: null,
        echoOk: false,
        echoVia: null,
        error: null
    }
    try {
        await initiator.dial(relayMa)
        const start = Date.now()
        const initialConn = await initiator.dial(targetMa)
        summary.initialWasLimited = Boolean(initialConn.limits)

        let activeConn = initialConn
        try {
            const directConn = await waitForDirectConnection(initiator, initialConn.remotePeer, timeoutMs)
            summary.upgraded = true
            summary.elapsedMs = Date.now() - start
            summary.directAddr = directConn.remoteAddr.toString()
            activeConn = directConn
        } catch (err) {
            summary.elapsedMs = Date.now() - start
            summary.error = err?.message ?? String(err)
        }

        const stream = await activeConn.newStream(QUIC_PROBE_PROTOCOL, { runOnLimitedConnection: true })
        summary.echoOk = await echoOverStream(stream, 'dcutr-2nat-ping')
        summary.echoVia = summary.upgraded ? 'direct-quic' : 'relayed-circuit'
    } catch (err) {
        summary.error = err?.message ?? String(err)
    } finally {
        await initiator.stop()
    }
    return summary
}
