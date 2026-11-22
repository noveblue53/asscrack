import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs'

test('room header and slash commands share the live topic and availability controls', async () => {
    const f = await loadRoomWindow({ send: async () => { throw new Error('command leaked to chat') } })
    const topics = []
    const states = []
    Object.assign(f.window.asscrack, {
        getTopic: async () => ({ available: false, text: '' }),
        setTopic: async text => topics.push(text),
        setPresence: async v => { states.push(v); return v }
    })
    await f.login('Me')
    assert.equal(f.el('topic-edit').disabled, true)
    async function command(s) {
        f.el('message-input').value = s
        f.el('send').click()
        await settle()
    }
    await command('/topic no host')
    assert.match(f.el('status').textContent, /Can't edit the topic right now/)
    assert.equal(f.el('message-input').value, '/topic no host')
    f.handlers.onTopic({ available: true, text: 'Past' })
    f.el('topic-edit').click()
    assert.equal(f.el('topic-input').value, 'Past')
    f.el('topic-input').value = 'A race'
    f.el('topic-save').click()
    await settle()
    assert.equal(f.el('topic-value').textContent, 'Past', 'wait for host confirmation')
    f.handlers.onTopic({ available: true, text: 'A race' })
    await command('/topic hello')
    await command('/topic')
    assert.deepEqual(topics, ['A race', 'hello', ''])
    await command('/away ' + '🦊'.repeat(81))
    assert.equal(states.at(-1).state, 'away')
    assert.equal([...states.at(-1).note].length, 80)
    f.el('presence-state').value = 'available'
    f.el('presence-set').click()
    await settle()
    assert.equal(states.at(-1).state, 'available')
    assert.equal(f.rows().length, 0)
})
