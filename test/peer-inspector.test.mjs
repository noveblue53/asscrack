import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createDom } from './helpers/fake-dom.mjs'

test('peer details disambiguate names and sample received voice only while inspecting that origin', async () => {
    const ids = ['peer-details', 'peer-search', 'peer-search-field', 'peer-choices', 'peer-detail-name',
        'peer-detail-facts', 'peer-audio-rate', 'peer-detail-link', 'peer-detail-voice', 'peer-readings', 'map-panel',
        'peer-detail-close', 'peer-detail-activity', 'peer-activity-summary', 'peer-events-status', 'peer-recent-events',
        'peer-detail-map', 'peer-detail-show', 'map-close', 'map-toggle', 'transfer-panel', 'peers']
    const { window, document } = createDom(ids.map(id => ({ id, hidden: id === 'peer-details' })))
    const el = id => document.getElementById(id)
    el('map-toggle').addEventListener('click', () => document.body.classList.toggle('map-open'))
    let bytes = 0
    let now = 100
    let tick = null
    let marked = null
    let transfersShown = false
    let activityRequest
    let activityResolve
    const buddy = document.createElement('li')
    buddy.dataset.peerId = 'two'
    el('peers').append(buddy)
    window.roomActivity = { openPeer: (...args) => { activityRequest = args } }
    window.asscrack = { getRoomActivity: () => new Promise(resolve => { activityResolve = resolve }) }
    window.voice = { stats: async () => ({ two: { bytesReceived: bytes } }) }
    window.nodeMap = { select: id => { marked = id } }
    window.layout = { showTransfers: () => { transfersShown = true } }
    const source = readFileSync(new URL('../src/application/peer-inspector.js', import.meta.url), 'utf8')
    runInNewContext(source, { window, document, performance: { now: () => now },
        setInterval: fn => { tick = fn; return 1 }, clearInterval: () => { tick = null },
        setTimeout: () => 1, clearTimeout() {} })
    const state = { nodes: [{ id: 'one', name: 'Sam' }, { id: 'two', name: 'Sam', inVoice: true,
        linkToYou: 'Relayed (observed here)' }], transfers: [{ from: 'two', to: 'self' }] }
    window.peerInspector.update(state)
    assert.equal(window.peerInspector.command('/whois Sam'), true)
    assert.deepEqual(el('peer-choices').children.map(b => b.title), ['one', 'two'])
    el('peer-choices').children[1].click()
    activityResolve(['2026-11-20T03:55:00.000Z  Old event', '2026-11-20T03:56:00.000Z  Chat opened',
        '2026-11-20T03:57:00.000Z  File saved'])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(marked, 'two')
    assert.equal(buddy.dataset.selected, 'true')
    el('peer-detail-activity').click()
    assert.deepEqual(activityRequest, ['two', 'Sam', el('peer-detail-activity')])
    assert.match(el('peer-detail-link').textContent, /Relayed \(observed here\)/)
    assert.equal(el('peer-detail-voice').textContent, 'In voice')
    assert.match(el('peer-detail-facts').textContent, /0 sending, 1 receiving/)
    assert.match(el('peer-audio-rate').textContent, /Unavailable/)
    // G5 (B5): Recent events shows the local time HH:MM:SS. The title keeps the UTC text of the line.
    const local = stamp => { const d = new Date(stamp); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':') }
    assert.deepEqual(el('peer-recent-events').children.map(item => item.textContent),
        [local('2026-11-20T03:57:00.000Z') + ' File saved', local('2026-11-20T03:56:00.000Z') + ' Chat opened'])
    assert.equal(el('peer-recent-events').children[0].children[0].title, '2026-11-20T03:57:00.000Z')
    el('peer-detail-map').click()
    assert.equal(marked, 'two', 'showing map preserves selection')
    bytes = 2000
    now += 2000
    await tick()
    assert.match(el('peer-audio-rate').textContent, /8\.0 kbit\/s over 2\.0 s/)
    window.peerInspector.update({ nodes: [state.nodes[0]], transfers: [] })
    assert.equal(el('peer-detail-name').textContent, 'Peer left')
    assert.equal(tick, null)
    el('peer-detail-close').click()
    assert.equal(marked, null)
    assert.equal(buddy.dataset.selected, undefined)
    assert.equal(window.peerInspector.command('/something'), false)
    assert.equal(window.peerInspector.command('/transfers'), true)
    assert.ok(transfersShown)
    assert.equal(document.activeElement, el('transfer-panel'))
})
