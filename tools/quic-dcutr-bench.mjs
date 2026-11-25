import { setTimeout as delay } from 'node:timers/promises'
import { multiaddr } from '@multiformats/multiaddr'
import {
    QUIC_PROBE_PROTOCOL,
    createQuicPeer,
    echoOverStream,
    extractUdpPort,
    registerEchoHandler,
    runLoopbackProbe,
    waitForDirectConnection
} from '../src/network/quic-dcutr-prototype.mjs'

function parseArgs(argv = process.argv.slice(2)) {
    const out = {
        role: null,
        port: 0,
        announceIp: null,
        relay: null,
        target: null,
        timeoutMs: 15000
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--role') out.role = argv[++i]
        else if (arg === '--port') out.port = Number(argv[++i])
        else if (arg === '--announce-ip') out.announceIp = argv[++i]
        else if (arg === '--relay') out.relay = argv[++i]
        else if (arg === '--target') out.target = argv[++i]
        else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i])
        else if (arg === '--help' || arg === '-h') out.help = true
        else throw new Error(`Unknown argument: ${arg}`)
    }
    return out
}

function usage() {
    console.log([
        'Usage:',
        '  node tools/quic-dcutr-bench.mjs --role loopback [--timeout-ms 10000]',
        '  node tools/quic-dcutr-bench.mjs --role relay [--port 4001] [--announce-ip <public-ip>]',
        '  node tools/quic-dcutr-bench.mjs --role responder --relay <relay-quic-multiaddr> [--port 0]',
        '  node tools/quic-dcutr-bench.mjs --role initiator --relay <relay-quic-multiaddr> --target <responder-circuit-multiaddr> [--port 0] [--timeout-ms 15000]'
    ].join('\n'))
}

async function waitForObservedAddr(node, relayPeerId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const peer = await node.peerStore.get(node.peerId).catch(() => null)
        const addrs = peer?.addresses?.map(a => a.multiaddr.toString()) ?? []
        const circuit = node.getMultiaddrs().find(ma => ma.toString().includes(`/p2p/${relayPeerId}/p2p-circuit`))?.toString() ?? null
        if (circuit) return { circuit, addrs }
        await delay(100)
    }
    return { circuit: null, addrs: [] }
}

async function runRelay(opts) {
    const listen = [`/ip4/0.0.0.0/udp/${opts.port}/quic-v1`, `/ip4/0.0.0.0/tcp/${opts.port}`]
    const announce = opts.announceIp && opts.port
        ? [`/ip4/${opts.announceIp}/udp/${opts.port}/quic-v1`, `/ip4/${opts.announceIp}/tcp/${opts.port}`]
        : []
    const relay = await createQuicPeer({ listen, announce, relayServer: true, enableDcutr: false })
    relay.addEventListener('connection:open', ({ detail: conn }) => {
        console.log(`[relay] connection:open peer=${conn.remotePeer.toString()} remote=${conn.remoteAddr.toString()} direction=${conn.direction}`)
    })
    console.log('[relay] peerId:', relay.peerId.toString())
    console.log('[relay] multiaddrs:')
    for (const ma of relay.getMultiaddrs()) console.log(' ', ma.toString())
    console.log('[relay] Press Ctrl+C to stop.')
    await new Promise(resolve => {
        process.once('SIGINT', resolve)
        process.once('SIGTERM', resolve)
    })
    await relay.stop()
}

async function runResponder(opts) {
    if (!opts.relay) throw new Error('--relay is required for responder')
    const relayMa = multiaddr(opts.relay)
    const relayPeerId = relayMa.getComponents().find(c => c.name === 'p2p')?.value
    if (!relayPeerId) throw new Error('--relay must include /p2p/<peerId>')

    const responder = await createQuicPeer({
        listen: [`/ip4/0.0.0.0/udp/${opts.port}/quic-v1`, '/p2p-circuit'],
        enableDcutr: true
    })
    registerEchoHandler(responder)

    const listenQuic = responder.getMultiaddrs().find(ma => ma.toString().includes('/quic-v1'))?.toString() ?? null
    console.log('[responder] local QUIC listen:', listenQuic, 'port=', extractUdpPort(listenQuic))

    responder.addEventListener('connection:open', ({ detail: conn }) => {
        console.log(`[responder] connection:open peer=${conn.remotePeer.toString()} remote=${conn.remoteAddr.toString()} limited=${Boolean(conn.limits)} direction=${conn.direction}`)
    })

    await responder.dial(relayMa)
    const { circuit } = await waitForObservedAddr(responder, relayPeerId, 8000)
    console.log('[responder] relay circuit multiaddr (pass to initiator --target):')
    console.log(circuit)
    console.log('[responder] Waiting for initiator... Press Ctrl+C to stop.')

    await new Promise(resolve => {
        process.once('SIGINT', resolve)
        process.once('SIGTERM', resolve)
    })
    await responder.stop()
}

async function runInitiator(opts) {
    if (!opts.relay || !opts.target) throw new Error('--relay and --target are required for initiator')
    const relayMa = multiaddr(opts.relay)
    const targetMa = multiaddr(opts.target)
    const targetPeerStr = targetMa.getComponents().find(c => c.name === 'p2p')?.value
    if (!targetPeerStr) throw new Error('--target must include /p2p/<responderPeerId>')

    const initiator = await createQuicPeer({
        listen: [`/ip4/0.0.0.0/udp/${opts.port}/quic-v1`, '/p2p-circuit'],
        enableDcutr: true
    })

    const listenQuic = initiator.getMultiaddrs().find(ma => ma.toString().includes('/quic-v1'))?.toString() ?? null
    const summary = {
        role: 'initiator',
        listenQuic,
        listenPort: extractUdpPort(listenQuic),
        relay: opts.relay,
        target: opts.target,
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
            const directConn = await waitForDirectConnection(initiator, initialConn.remotePeer, opts.timeoutMs)
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

    console.log(JSON.stringify(summary, null, 2))
    if (!summary.echoOk) process.exitCode = 1
}

async function main() {
    const opts = parseArgs()
    if (opts.help || !opts.role) {
        usage()
        process.exit(opts.help ? 0 : 1)
    }
    if (opts.role === 'loopback') {
        const report = await runLoopbackProbe({ timeoutMs: opts.timeoutMs })
        console.log(JSON.stringify(report, null, 2))
        if (!report.ok) process.exitCode = 1
        return
    }
    if (opts.role === 'relay') return runRelay(opts)
    if (opts.role === 'responder') return runResponder(opts)
    if (opts.role === 'initiator') return runInitiator(opts)
    throw new Error(`Unsupported --role: ${opts.role}`)
}

main().catch(err => {
    console.error(err?.stack || String(err))
    process.exit(1)
})
