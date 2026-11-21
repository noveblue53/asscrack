import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { createDom } from './helpers/fake-dom.mjs'

test('map distinguishes locally observed routes, peer reports, conflicts, and voice membership', () => {
    const { document, window } = createDom([{ id: 'node-map' }, { id: 'map-legend', children:
        ['relay', 'direct', 'relayed', 'unknown', 'full', 'voice', 'speaking', 'file'].map(key => ({ id: key })) }])
    const legend = document.getElementById('map-legend')
    for (const key of legend.children) key.dataset.legend = key.id
    document.createElementNS = (_, name) => document.createElement(name)
    window.matchMedia = () => ({ matches: true })
    class ResizeObserver { observe() {} }
    const source = readFileSync(new URL('../src/application/nodemap.js', import.meta.url), 'utf8')
    let clearHighlight
    runInNewContext(source, { document, window, ResizeObserver,
        setTimeout(fn) { clearHighlight = fn; return 1 }, clearTimeout() {} })
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
    assert.deepEqual(legend.children.filter(key => !key.hidden).map(key => key.id),
        ['relay', 'direct', 'relayed', 'unknown', 'voice'])

    const orb = id => document.querySelector(`[data-node="${id}"]`)
    const orbPosition = id => orb(id).getAttribute('transform')
    window.nodeMap.select('b')
    assert.equal(window.nodeMap.highlight('c'), true)
    clearHighlight()
    assert.equal(orb('c').getAttribute('data-highlight'), null)
    assert.equal(orb('b').getAttribute('data-selected'), 'true')
    const positions = ['a', 'b', 'c'].map(orbPosition)
    state.nodes.push({ id: 'aa' })
    window.nodeMap.update(state)
    assert.deepEqual(['a', 'b', 'c'].map(orbPosition), positions)
    assert.ok(!positions.includes(orbPosition('aa')))
    assert.equal(orb('b').getAttribute('data-selected'), 'true')
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
    window.nodeMap.select('c')
    assert.equal(orb('b').getAttribute('data-selected'), null)
    assert.equal(orb('c').getAttribute('data-selected'), 'true')
})
