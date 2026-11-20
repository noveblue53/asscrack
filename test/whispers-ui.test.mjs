import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createDom } from './helpers/fake-dom.mjs'
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs'

test('private composer binds drafts, acknowledgements and notification clicks to the selected peer ID', async () => {
    const ids = ['pane', 'title', 'picker', 'open', 'close', 'peer', 'draft', 'lines', 'status', 'send']
        .map(name => ({ id: 'whisper-' + name, hidden: name === 'pane' }))
    const { document, window, Event } = createDom([...ids, { id: 'channel-select' }])
    document.getElementById('channel-select').selectedOptions = [{ textContent: '#Paddock' }]
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
    assert.equal(el('close').textContent, '← #Paddock')
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
    assert.equal(el('lines').textContent, 'You — only for B')
    assert.match(el('lines').children[0].getAttribute('aria-label'), /received by peer/)
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
        assert.match(room.el('status').textContent, /Whispers are unavailable/)
    }
    assert.deepEqual(posts, [])
})

test('whisper commands resolve live and retained names without overwriting drafts or sending the command to a peer', () => {
    const ids = ['pane', 'title', 'picker', 'open', 'close', 'peer', 'draft', 'lines', 'status', 'send']
        .map(key => ({ id: 'whisper-' + key, hidden: key === 'pane' }))
    const { document, window, Event } = createDom([...ids, { id: 'message-input' }])
    const events = {}
    const posts = []
    window.asscrack = { sendWhisper: (...args) => { posts.push(args); return 'received' } }
    for (const name of ['PeerName', 'PeerJoined', 'PeerLeft', 'WhisperCapability', 'Whisper']) {
        window.asscrack['on' + name] = fn => { events[name] = fn }
    }
    vm.runInNewContext(readFileSync(new URL('../src/application/whispers.js', import.meta.url), 'utf8'),
        { window, document, crypto: { randomUUID } })
    function join(peerId, name) {
        events.PeerJoined({ peerId })
        events.PeerName({ peerId, name })
        events.WhisperCapability({ peerId, available: true })
    }
    const el = name => document.getElementById('whisper-' + name)
    const room = document.getElementById('message-input')
    const edit = text => { el('draft').value = text; el('draft').dispatchEvent(new Event('input')) }
    join('john-original', 'John Kramer')
    join('sam-original', 'Sam')
    const w = window.whispers
    assert.equal(w.command('/w'), true)
    assert.equal(el('peer').value, '')
    assert.equal(el('send').disabled, true)
    assert.equal(w.command('/w John Kramer first line'), true)
    assert.ok(w.isViewing('john-original'))
    assert.equal(el('draft').value, 'first line')
    assert.equal(w.command('/msg "John Kramer" second line'), false)
    assert.equal(el('draft').value, 'first line')
    events.PeerLeft({ peerId: 'john-original' })
    join('john-new', 'John Kramer')
    room.value = '/W John saved for John'
    assert.equal(w.command(room.value), false)
    assert.deepEqual(el('peer').children.map(opt => opt.value), ['', 'john-original', 'john-new'])
    assert.equal(w.isViewing('john-new'), false)
    el('peer').value = 'john-new'
    el('peer').dispatchEvent(new Event('change'))
    assert.ok(w.isViewing('john-new'))
    assert.equal(el('draft').value, 'saved for John')
    assert.equal(room.value, '')
    w.open('john-original')
    assert.equal(el('draft').value, 'first line')
    edit('/w Sam from an offline thread')
    assert.equal(el('send').disabled, false)
    el('send').click()
    assert.ok(w.isViewing('sam-original'))
    assert.equal(el('draft').value, 'from an offline thread')
    events.Whisper({ peerId: 'john-new', text: 'here?', id: randomUUID() })
    assert.equal(w.isViewing('sam-original'), true)
    assert.equal(el('draft').value, 'from an offline thread')
    assert.match(el('open').textContent, /1/)
    assert.equal(w.command('/w nobody unmatched'), false)
    assert.equal(el('send').disabled, true)
    assert.deepEqual(posts, [])
})
