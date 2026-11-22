// P9C: peers spread the news of an update (src/network/update-spread.mjs) on real nodes, with a real updater on each
// side (fake GitHub: no request). All results of this file are 127.0.0.1 results, not LAN results.
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { createUpdateSpread } from '../src/network/update-spread.mjs'
import { createUpdater, releaseSource } from '../src/application/updater.mjs'

async function waitFor(check, what) {
    for (let attempt = 0; attempt < 300; attempt++) {
        if (check()) return
        await delay(25)
    }
    assert.ok(check(), `Timed out waiting for ${what}`)
}

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ format: 'jwk' }).x
function signed(version, key = keys.privateKey) {
    const bytes = Buffer.from(JSON.stringify({ product: 'ASSCRACK', format: 1, version, date: '2026-12-01', notes: 'n',
        files: { portable: { name: `ASSCRACK-${version}-portable.exe`, size: 5, sha256: 'a'.repeat(64) } } }))
    return { text: bytes.toString('utf8'), signature: sign(null, bytes, key).toString('base64') }
}

function updater(currentVersion, logs) {
    return createUpdater({ currentVersion, kind: null, publicKey, source: releaseSource('http://127.0.0.1:9'),
        fetch: async () => { throw new Error('no request in this test') }, folders: {}, store: { read: () => ({ enabled: false }), write: () => {} },
        log: (level, text) => logs.push(`${level} ${text}`), setTimer: () => 1, clearTimer: () => {} })
}
const hubOf = u => ({ version: u.view().current, offer: v => u.offerFor(v), received: (_p, m) => u.receivePeer(m), onShare: l => u.onShare(l) })
const opts = (name, updates) => ({ room: 'update-spread-test', name, listen: ['/ip4/127.0.0.1/tcp/0'], discovery: false, updates })

test('127.0.0.1: a node with a newer signed manifest gives it to an older peer; a bad one gives no update', { timeout: 30000 }, async () => {
    const logs = { a: [], b: [], c: [] }
    const ua = updater('1.0.0-test', logs.a)
    const ub = updater('1.0.0-test', logs.b)
    const uc = updater('1.0.1-test', logs.c)
    // A learns of 1.0.1-test (for example from GitHub). B has the check off and learns it only from A.
    assert.equal(ua.receivePeer(signed('1.0.1-test')), true)
    const a = await createAsscrackNode(opts('Ann', hubOf(ua)))
    const b = await createAsscrackNode(opts('Ben', hubOf(ub)))
    const c = await createAsscrackNode(opts('Cy', hubOf(uc)))
    const seen = { b: [], c: [] }
    const tap = (node, list) => {
        const original = node.events.emit.bind(node.events)
        node.events.emit = (type, ...rest) => { list.push(type); return original(type, ...rest) }
    }
    tap(b, seen.b)
    try {
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => ub.view().update?.version === '1.0.1-test', 'the manifest on B')
        assert.equal(ub.view().update.from, 'peer')
        // C has the version of the manifest: it gets no manifest, and it does not give one to A or B (no newer one).
        await c.connect(a.getMultiaddrs()[0])
        await c.connect(b.getMultiaddrs()[0])
        await waitFor(() => c.peers().length === 2, 'the sessions of C')
        await delay(300)
        assert.equal(uc.view().update, null)
        assert.ok(!logs.c.some(line => /found/.test(line)), 'C got nothing')
        // The window gets no event for the update lines.
        assert.ok(!seen.b.includes('message'))

        // A bad signature from a peer: no update. Only the first manifest of a session counts.
        const d = updater('0.9.0', logs.c)
        const spread = createUpdateSpread(hubOf(d))
        const sent = []
        const session = { send: line => sent.push(JSON.parse(line)) }
        spread.opened('p', session)
        assert.deepEqual(sent, [{ type: 'app-version', v: 1, version: '0.9.0' }])
        assert.equal(spread.handle('p', session, { type: 'update-manifest', v: 1, ...signed('1.0.1-test', generateKeyPairSync('ed25519').privateKey) }), true)
        assert.equal(spread.handle('p', session, { type: 'update-manifest', v: 1, ...signed('1.0.1-test') }), true)
        assert.equal(d.view().update, null, 'the second manifest of the session is ignored')
        const other = { send: () => {} }
        const big = { type: 'update-manifest', v: 1, text: 'x'.repeat(9000), signature: 'AAAA' }
        assert.equal(spread.handle('p', other, big), true)
        assert.equal(d.view().update, null, 'a line above the size limit is ignored')
        assert.equal(spread.handle('p', { send: () => {} }, { type: 'update-manifest', v: 1, ...signed('1.0.1-test') }), true)
        assert.equal(d.view().update?.version, '1.0.1-test')

        // The node of the terminal demo (no hub) sends no update line.
        const none = createUpdateSpread(null)
        const quiet = []
        none.opened('p', { send: line => quiet.push(line) })
        assert.deepEqual(quiet, [])
    } finally {
        await Promise.all([a.stop(), b.stop(), c.stop()])
    }
})

test('127.0.0.1: a manifest that a node gets later goes to the open sessions of older peers (one time)', { timeout: 30000 }, async () => {
    const logs = []
    const ua = updater('1.0.0-test', logs)
    const ub = updater('1.0.0-test', logs)
    const a = await createAsscrackNode(opts('Ann', hubOf(ua)))
    const b = await createAsscrackNode(opts('Ben', hubOf(ub)))
    try {
        await b.connect(a.getMultiaddrs()[0])
        await waitFor(() => a.peers().length === 1 && b.peers().length === 1, 'the session')
        await delay(200)
        assert.equal(ub.view().update, null)
        assert.equal(ua.receivePeer(signed('1.0.1-test')), true)
        await waitFor(() => ub.view().update?.version === '1.0.1-test', 'the shared manifest on B')
    } finally {
        await Promise.all([a.stop(), b.stop()])
    }
})
