import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createDom } from './helpers/fake-dom.mjs'

test('peer details disambiguate names and sample received voice only while inspecting that origin', async () => {
    const ids = ['peer-details', 'peer-search', 'peer-choices', 'peer-detail-name', 'peer-detail-facts',
        'peer-audio-rate', 'map-panel', 'peer-detail-close', 'peer-detail-activity', 'map-close', 'map-toggle', 'transfer-panel']
    const { window, document } = createDom(ids.map(id => ({ id, hidden: id === 'peer-details' })))
    const el = id => document.getElementById(id)
    el('map-toggle').addEventListener('click', () => document.body.classList.toggle('map-open'))
    let bytes = 0
    let now = 100
    let tick = null
    let marked = null
    let transfersShown = false
    let activityRequest
    window.roomActivity = { openPeer: (...args) => { activityRequest = args } }
    window.voice = { stats: async () => ({ two: { bytesReceived: bytes } }) }
    window.nodeMap = { highlight: id => { marked = id } }
    window.layout = { showTransfers: () => { transfersShown = true } }
    const source = readFileSync(new URL('../src/application/peer-inspector.js', import.meta.url), 'utf8')
    runInNewContext(source, { window, document, performance: { now: () => now },
        setInterval: fn => { tick = fn; return 1 }, clearInterval: () => { tick = null } })
    const state = { nodes: [{ id: 'one', name: 'Sam' }, { id: 'two', name: 'Sam', inVoice: true,
        linkToYou: 'Relayed (observed here)' }], transfers: [{ from: 'two', to: 'self' }] }
    window.peerInspector.update(state)
    assert.equal(window.peerInspector.command('/whois Sam'), true)
    assert.deepEqual(el('peer-choices').children.map(b => b.title), ['one', 'two'])
    el('peer-choices').children[1].click()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(marked, 'two')
    el('peer-detail-activity').click()
    assert.deepEqual(activityRequest, ['two', 'Sam', el('peer-detail-activity')])
    assert.match(el('peer-detail-facts').textContent, /Relayed \(observed here\)/)
    assert.match(el('peer-detail-facts').textContent, /0 sending, 1 receiving/)
    assert.match(el('peer-audio-rate').textContent, /unavailable/)
    bytes = 2000
    now += 2000
    await tick()
    assert.match(el('peer-audio-rate').textContent, /8\.0 kbit\/s over 2\.0 s/)
    window.peerInspector.update({ nodes: [state.nodes[0]], transfers: [] })
    assert.equal(el('peer-detail-name').textContent, 'Peer left')
    assert.equal(tick, null)
    assert.equal(window.peerInspector.command('/something'), false)
    assert.equal(window.peerInspector.command('/transfers'), true)
    assert.ok(transfersShown)
    assert.equal(document.activeElement, el('transfer-panel'))
})
