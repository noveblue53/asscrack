import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createDom } from './helpers/fake-dom.mjs'

test('typing labels count peers by ID and input sends only booleans', async () => {
    const { document, window, Event } = createDom([{ id: 'view-typing' }, { id: 'typing-status' }, { id: 'message-input', tag: 'textarea' }])
    const line = document.getElementById('typing-status')
    const input = document.getElementById('message-input')
    const ids = ['id-aaaaaa', 'id-bbbbbb', 'id-cccccc']
    const peerNames = new Map(ids.map(id => [id, 'Sam']))
    const sent = []
    let typing, left
    window.asscrack = {
        getShareTyping: async () => true, setShareTyping: async value => value,
        onPeerName() {}, onPeerLeft(fn) { left = fn }, onTyping(fn) { typing = fn },
        typingEdit(value) { sent.push(value) }
    }
    const script = await readFile(new URL('../src/application/typing.js', import.meta.url), 'utf8')
    vm.runInNewContext(script, { window, document, peerNames, peerItems: new Set(ids), messageInput: input })
    await new Promise(r => setImmediate(r))
    typing({ peerId: 'self-or-stranger', active: true })
    assert.equal(line.textContent, '')
    typing({ peerId: ids[0], active: true })
    assert.equal(line.textContent, 'Sam is typing…')
    typing({ peerId: ids[1], active: true })
    assert.equal(line.textContent, 'Sam (aaaaaa) and Sam (bbbbbb) are typing…')
    typing({ peerId: ids[2], active: true })
    assert.equal(line.textContent, '3 people are typing…')
    left({ peerId: ids[0] })
    left({ peerId: ids[1] })
    assert.equal(line.textContent, 'Sam is typing…')
    typing({ peerId: ids[2], active: false })
    assert.equal(line.textContent, '')
    for (const text of ['draft never transmitted', '  /command', '  ']) {
        input.value = text
        input.dispatchEvent(new Event('input'))
    }
    assert.deepEqual(sent, [true, false, false])
    await window.typingUi.toggleShare()
    input.value = 'another private draft'
    input.dispatchEvent(new Event('input'))
    assert.deepEqual(sent, [true, false, false])
})
