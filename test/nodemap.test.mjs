import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { createDom } from './helpers/fake-dom.mjs'

test('map distinguishes locally observed routes, peer reports, conflicts, and voice membership', () => {
    const { document, window } = createDom([{ id: 'node-map' }])
    document.createElementNS = (_, name) => document.createElement(name)
    window.matchMedia = () => ({ matches: true })
    class ResizeObserver { observe() {} }
    const source = readFileSync(new URL('../src/application/nodemap.js', import.meta.url), 'utf8')
    runInNewContext(source, { document, window, ResizeObserver })
    const state = {
        self: 'a', host: 'a',
        nodes: [{ id: 'a' }, { id: 'b', inVoice: true }, { id: 'c' }],
        links: { a: ['b', 'c'], b: ['c'] },
        kinds: { a: { b: 'mesh' }, b: { c: 'relay' } }
    }
    const edge = (from, to, kind) =>
        document.querySelector(`[data-from="${from}"][data-to="${to}"][data-kind="${kind}"]`)
    window.nodeMap.update(state)
    assert.equal(edge('a', 'b', 'mesh').textContent, 'Direct (observed here)')
    assert.equal(edge('b', 'c', 'relay').textContent, 'Relayed (peer-reported)')
    assert.equal(edge('a', 'c', 'unknown').textContent, 'Unknown (route unavailable)')
    assert.equal(edge('b', 'a', 'voice').textContent, 'Voice membership')

    const orbPosition = id => document.querySelector(`[data-node="${id}"]`).getAttribute('transform')
    const positions = ['a', 'b', 'c'].map(orbPosition)
    state.nodes.push({ id: 'aa' })
    window.nodeMap.update(state)
    assert.deepEqual(['a', 'b', 'c'].map(orbPosition), positions)
    assert.ok(!positions.includes(orbPosition('aa')))
    state.nodes.pop()
    window.nodeMap.update(state)
    assert.deepEqual(['a', 'b', 'c'].map(orbPosition), positions)

    state.kinds.b.a = 'relay'
    window.nodeMap.update(state)
    assert.equal(edge('a', 'b', 'unknown').textContent, 'Unknown (conflicting reports)')
    assert.equal(edge('a', 'b', 'mesh'), null)
    delete state.kinds.a.b
    window.nodeMap.update(state)
    assert.equal(edge('a', 'b', 'relay').textContent, 'Relayed (peer-reported)')
    state.kinds.a.b = 'relay'
    window.nodeMap.update(state)
    assert.equal(edge('a', 'b', 'relay').textContent, 'Relayed (observed here)')
})
