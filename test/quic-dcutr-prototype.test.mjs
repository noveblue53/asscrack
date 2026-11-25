import test from 'node:test'
import assert from 'node:assert/strict'
import {
    QUIC_PROBE_PROTOCOL,
    createQuicPeer,
    echoOverStream,
    probeOutboundPortReuse,
    registerEchoHandler,
    resolveNativeBinaryPath,
    runLoopbackProbe
} from '../src/network/quic-dcutr-prototype.mjs'

test('QUIC native binary resolves on win32-x64', () => {
    const info = resolveNativeBinaryPath()
    assert.equal(info.error, null)
    assert.ok(info.path && info.path.endsWith('.node'))
})

test('QUIC direct dial and stream echo over 127.0.0.1', async () => {
    const nodeA = await createQuicPeer({ enableDcutr: false })
    const nodeB = await createQuicPeer({ enableDcutr: false })
    try {
        registerEchoHandler(nodeB)
        const target = nodeB.getMultiaddrs().find(ma => ma.toString().includes('/quic-v1'))
        assert.ok(target, 'Node B should expose a /quic-v1 multiaddr')
        const stream = await nodeA.dialProtocol(target, QUIC_PROBE_PROTOCOL)
        const ok = await echoOverStream(stream, 'hello-quic')
        assert.equal(ok, true)
    } finally {
        await Promise.allSettled([nodeA.stop(), nodeB.stop()])
    }
})

test('probeOutboundPortReuse measures listener vs outbound UDP port', async () => {
    const res = await probeOutboundPortReuse()
    assert.equal(res.directQuicOk, true)
    assert.equal(typeof res.listenerPort, 'number')
    assert.equal(typeof res.observedRemotePort, 'number')
    assert.equal(typeof res.portReused, 'boolean')
    console.log('Measured portReuse:', JSON.stringify(res))
})

test('runLoopbackProbe completes relay + DCUtR probe cleanly', async () => {
    const report = await runLoopbackProbe({ timeoutMs: 4000 })
    console.log('Loopback probe report:', JSON.stringify(report))
    assert.equal(report.ok, true, report.error ?? 'Expected loopback probe to succeed')
    assert.equal(report.directQuicOk, true)
    assert.equal(report.echoOk, true)
    assert.equal(report.dcutrUpgrade.initialWasLimited, true)
})
