import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createDom } from './helpers/fake-dom.mjs'
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs'

test('private composer binds drafts, acknowledgements and notification clicks to the selected peer ID', async () => {
    const { document, window, Event } = createDom(['dialog', 'open', 'close', 'peer', 'draft', 'lines', 'identity', 'status', 'send']
        .map(name => ({ id: 'whisper-' + name })))
    const el = name => document.getElementById('whisper-' + name)
    const events = {}, privateSends = [], attention = []
    let complete
    window.asscrack = {
        sendWhisper(peerId, text, id) {
            privateSends.push({ peerId, text, id })
            return new Promise(resolve => { complete = resolve })
        },
        getWhisperPeers: async () => []
    }
    for (const name of ['PeerName', 'PeerJoined', 'PeerLeft', 'WhisperCapability', 'Whisper']) {
        window.asscrack['on' + name] = fn => { events[name] = fn }
    }
    window.roomAttention = { incoming: event => attention.push(JSON.stringify(event)), viewChanged() {} }
    const dialog = el('dialog')
    dialog.showModal = () => { dialog.open = true }
    dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')) }
    // The fake DOM has no layout to scroll. A successful click must still point at a retained message.
    const create = document.createElement.bind(document)
    document.createElement = tag => Object.assign(create(tag), { scrollIntoView() {} })
    vm.runInNewContext(readFileSync(new URL('../src/application/whispers.js', import.meta.url), 'utf8'),
        { window, document, crypto: { randomUUID } })
    const edit = text => { el('draft').value = text; el('draft').dispatchEvent(new Event('input')) }
    function join(peerId) {
        events.PeerJoined({ peerId })
        events.PeerName({ peerId, name: 'same' })
        events.WhisperCapability({ peerId, available: true })
    }
    join('identity-b')
    join('identity-c')
    window.whispers.open('identity-b')
    edit('only for B')
    el('send').click()
    events.PeerLeft({ peerId: 'identity-b' })
    complete('unconfirmed')
    await settle()
    assert.equal(el('draft').value, 'only for B')
    assert.equal(el('send').disabled, true)
    assert.equal(el('lines').children.length, 0)
    join('new-id-same-name')
    window.whispers.open('new-id-same-name')
    assert.equal(el('draft').value, '')
    edit('different draft')
    join('identity-b')
    assert.equal(privateSends.length, 1, 'no automatic replay')
    window.whispers.open('identity-b')
    assert.equal(el('draft').value, 'only for B')
    el('send').click()
    assert.deepEqual(privateSends[0], privateSends[1], 'manual retry bound to identical recipient and ID')
    window.whispers.open('new-id-same-name')
    complete('received')
    await settle()
    assert.equal(el('draft').value, 'different draft')
    assert.equal(el('lines').children.length, 0)
    window.whispers.open('identity-b')
    assert.equal(el('draft').value, '')
    assert.match(el('lines').textContent, /received by peer.*only for B/)
    window.whispers.close()
    const id = randomUUID()
    events.Whisper({ peerId: 'identity-c', text: 'private incoming marker', id })
    assert.deepEqual(attention, [JSON.stringify({ kind: 'whisper', peerId: 'identity-c', id })])
    assert.match(el('open').textContent, /1/)
    assert.equal(window.whispers.open('identity-b', id), false)
    assert.ok(window.whispers.open('identity-c', id))
    assert.equal(window.whispers.isViewing('identity-c'), true)
    assert.match(el('lines').textContent, /private incoming marker/)
    window.whispers.close()
    events.WhisperCapability({ peerId: 'identity-c', available: false })
    assert.equal(window.whispers.open('identity-c', id), false)
    assert.equal(window.whispers.isOpen(), false)
})

test('public composer keeps private-looking slash commands as a local draft', async () => {
    const posts = []
    const room = await loadRoomWindow({ send: async text => posts.push(text) })
    await room.login('sender')
    for (const text of ['/w same secret', '/WHISPER same private', '  /msg same text']) {
        room.el('message-input').value = text
        room.el('send').click()
        await settle()
        assert.equal(room.el('message-input').value, text)
        assert.match(room.el('status').textContent, /open Whispers/)
    }
    assert.deepEqual(posts, [])
})
