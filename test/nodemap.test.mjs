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

test('map polls traffic at 4 Hz only when open and renders proportional color-coded pulses', async () => {
    const { document, window } = createDom([{ id: 'node-map' }, { id: 'map-legend', children:
        ['relay', 'direct', 'relayed', 'unknown', 'full', 'voice', 'speaking', 'file'].map(key => ({ id: key })) }])
    const legend = document.getElementById('map-legend')
    for (const key of legend.children) key.dataset.legend = key.id
    document.createElementNS = (_, name) => document.createElement(name)
    let reduced = false
    window.matchMedia = () => ({ get matches() { return reduced }, addEventListener() {} })
    class ResizeObserver { observe() {} }

    let now = 1000
    let intervalFn = null
    let intervalMs = 0
    let clearedIntervals = 0
    let rafFn = null
    let cancelledRafs = 0
    const snapshots = [
        { edges: [
            { kind: 'voice', from: 'a', to: 'b', count: 10 },
            { kind: 'music', from: 'b', to: 'a', count: 10 },
            { kind: 'screen', from: 'a', to: 'c', count: 5 },
            { kind: 'transfer', from: 'c', to: 'a', count: 1024 }
        ] },
        { edges: [
            { kind: 'voice', from: 'a', to: 'b', count: 25 },
            { kind: 'music', from: 'b', to: 'a', count: 12 },
            { kind: 'screen', from: 'a', to: 'c', count: 20 },
            { kind: 'transfer', from: 'c', to: 'a', count: 65536 }
        ] },
        { edges: [
            { kind: 'voice', from: 'a', to: 'b', count: 35 }
        ] }
    ]
    let pollCalls = 0
    window.asscrack = {
        getMapTraffic: async () => snapshots[pollCalls++] ?? snapshots.at(-1)
    }

    const source = readFileSync(new URL('../src/application/nodemap.js', import.meta.url), 'utf8')
    runInNewContext(source, {
        document,
        window,
        ResizeObserver,
        performance: { now: () => now },
        setTimeout: () => 1,
        clearTimeout() {},
        setInterval(fn, ms) { intervalFn = fn; intervalMs = ms; return 42 },
        clearInterval(id) { if (id === 42) { clearedIntervals++; intervalFn = null } },
        requestAnimationFrame(fn) { rafFn = fn; return 77 },
        cancelAnimationFrame(id) { if (id === 77) { cancelledRafs++; rafFn = null } }
    })

    window.nodeMap.update({
        self: 'a',
        host: 'a',
        nodes: [{ id: 'a', inVoice: true }, { id: 'b', inVoice: true }, { id: 'c' }],
        links: { a: ['b', 'c'] },
        transfers: [{ id: 't1', from: 'c', to: 'a' }],
        screenEdges: [{ from: 'a', to: 'c' }]
    })

    // Closed: zero polling, zero pulses.
    assert.equal(pollCalls, 0)
    assert.equal(intervalFn, null)
    assert.equal(document.querySelector('[data-kind="screen"][data-from="a"][data-to="c"]').textContent, 'Screen share')

    // Open: starts 250 ms polling; baseline poll spawns 0 pulses.
    window.nodeMap.setOpen(true)
    assert.equal(intervalMs, 250)
    await new Promise(resolve => globalThis.setTimeout(resolve, 0))
    assert.equal(pollCalls, 1)
    assert.equal(document.querySelectorAll('.nm-traffic-pulse').length, 0)

    // Second poll: spawns pulses for each active traffic kind, proportional to rate.
    now += 250
    await intervalFn()
    assert.equal(pollCalls, 2)
    const voicePulses = document.querySelectorAll('.nm-traffic-pulse[data-traffic-kind="voice"]')
    const musicPulses = document.querySelectorAll('.nm-traffic-pulse[data-traffic-kind="music"]')
    const screenPulses = document.querySelectorAll('.nm-traffic-pulse[data-traffic-kind="screen"]')
    const transferPulses = document.querySelectorAll('.nm-traffic-pulse[data-traffic-kind="transfer"]')
    assert.ok(voicePulses.length >= 2)
    assert.equal(musicPulses.length, 1)
    assert.ok(screenPulses.length >= 2)
    assert.ok(transferPulses.length >= 1)
    assert.ok(rafFn !== null)

    // Stepping animation moves pulses along edges and removes them once completed.
    now += 300
    { const fn = rafFn; rafFn = null; fn(now) }
    assert.ok(Number(musicPulses[0].getAttribute('opacity')) > 0)
    assert.ok(rafFn !== null)
    now += 2000
    { const fn = rafFn; rafFn = null; fn(now) }
    assert.equal(document.querySelectorAll('.nm-traffic-pulse').length, 0)
    assert.equal(rafFn, null)

    // Closing stops polling and clears any active pulses.
    now += 250
    await intervalFn()
    assert.ok(document.querySelectorAll('.nm-traffic-pulse').length > 0)
    window.nodeMap.setOpen(false)
    assert.equal(clearedIntervals, 1)
    assert.equal(cancelledRafs, 1)
    assert.equal(document.querySelectorAll('.nm-traffic-pulse').length, 0)

    // Reduced motion prevents polling and pulses even when open.
    reduced = true
    const beforeCalls = pollCalls
    window.nodeMap.setOpen(true)
    assert.equal(pollCalls, beforeCalls)
    assert.equal(intervalFn, null)
})

test('map renders active forwarding edges (Sharer -> Forwarder -> Viewer) with arrows, legend, and node facts', () => {
    const { document, window } = createDom([{ id: 'node-map' }, { id: 'map-legend', children:
        ['relay', 'direct', 'relayed', 'unknown', 'full', 'voice', 'speaking', 'file', 'screen'].map(key => ({ id: key })) }])
    const legend = document.getElementById('map-legend')
    for (const key of legend.children) key.dataset.legend = key.id
    document.createElementNS = (_, name) => document.createElement(name)
    window.matchMedia = () => ({ matches: true })
    class ResizeObserver { observe() {} }
    const source = readFileSync(new URL('../src/application/nodemap.js', import.meta.url), 'utf8')
    runInNewContext(source, { document, window, ResizeObserver, setTimeout: () => 1, clearTimeout() {} })
    window.nodeMap.update({
        self: 's', host: 's',
        nodes: [{ id: 's', name: 'Sharer' }, { id: 'f', name: 'Forwarder' }, { id: 'v', name: 'Viewer' }],
        links: {},
        screenEdges: [
            { from: 's', to: 'f', sharer: 's' },
            { from: 'f', to: 'v', sharer: 's' }
        ]
    })
    const directEdge = document.querySelector('[data-kind="screen"][data-from="s"][data-to="f"]')
    const fwdEdge = document.querySelector('[data-kind="screen"][data-from="f"][data-to="v"]')
    assert.ok(directEdge, 'sharer -> forwarder edge rendered')
    assert.ok(fwdEdge, 'forwarder -> viewer edge rendered')
    assert.equal(directEdge.getAttribute('marker-end'), 'url(#nm-screen-arrow)')
    assert.equal(fwdEdge.getAttribute('marker-end'), 'url(#nm-screen-arrow)')
    assert.equal(directEdge.textContent, 'Screen share')
    assert.equal(fwdEdge.textContent, 'Screen share (forwarded)')
    assert.equal(legend.querySelector('[data-legend="screen"]').hidden, false)
    assert.match(document.querySelector('[data-node="f"]').textContent, /Forwarding to 1/)
    assert.doesNotMatch(document.querySelector('[data-node="s"]').textContent, /Forwarding to/)
})

test('node map renders music forwarding edges and unhides the music legend key', () => {
    const { document, window } = createDom([{ id: 'node-map' }, { id: 'map-legend', children:
        ['relay', 'direct', 'relayed', 'unknown', 'full', 'voice', 'speaking', 'file', 'screen', 'music'].map(key => ({ id: key })) }])
    document.getElementById('node-map')
    const legend = document.getElementById('map-legend')
    for (const key of legend.children) key.dataset.legend = key.id
    document.createElementNS = (_, name) => document.createElement(name)
    window.matchMedia = () => ({ matches: true })
    class ResizeObserver { observe() {} }
    const source = readFileSync(new URL('../src/application/nodemap.js', import.meta.url), 'utf8')
    runInNewContext(source, { document, window, ResizeObserver, setTimeout: () => 1, clearTimeout() {} })
    window.nodeMap.update({
        self: 'dj', host: 'dj',
        nodes: [{ id: 'dj', name: 'DJ' }, { id: 'f', name: 'Forwarder' }, { id: 'l', name: 'Listener' }],
        links: {},
        musicEdges: [
            { from: 'dj', to: 'f', dj: 'dj' },
            { from: 'f', to: 'l', dj: 'dj' }
        ]
    })
    const directEdge = document.querySelector('[data-kind="music"][data-from="dj"][data-to="f"]')
    const fwdEdge = document.querySelector('[data-kind="music"][data-from="f"][data-to="l"]')
    assert.ok(directEdge, 'dj -> forwarder music edge rendered')
    assert.ok(fwdEdge, 'forwarder -> listener music edge rendered')
    assert.equal(directEdge.getAttribute('marker-end'), 'url(#nm-music-arrow)')
    assert.equal(fwdEdge.getAttribute('marker-end'), 'url(#nm-music-arrow)')
    assert.equal(directEdge.textContent, 'Music')
    assert.equal(fwdEdge.textContent, 'Music (forwarded)')
    assert.equal(legend.querySelector('[data-legend="music"]').hidden, false)
})

test('node map renders swarm transfer edges and marks active seeders', () => {
    const { document, window } = createDom([{ id: 'node-map' }, { id: 'map-legend', children:
        ['relay', 'direct', 'relayed', 'unknown', 'full', 'voice', 'speaking', 'file', 'screen', 'music'].map(key => ({ id: key })) }])
    const legend = document.getElementById('map-legend')
    for (const key of legend.children) key.dataset.legend = key.id
    document.createElementNS = (_, name) => document.createElement(name)
    window.matchMedia = () => ({ matches: true })
    class ResizeObserver { observe() {} }
    const source = readFileSync(new URL('../src/application/nodemap.js', import.meta.url), 'utf8')
    runInNewContext(source, { document, window, ResizeObserver, setTimeout: () => 1, clearTimeout() {} })
    window.nodeMap.update({
        self: 'a', host: 'a',
        nodes: [{ id: 'a', name: 'Leecher' }, { id: 'b', name: 'SeederOne' }, { id: 'c', name: 'SeederTwo' }],
        links: {},
        transfers: [
            { id: 'o1|b', from: 'b', to: 'a', swarm: true },
            { id: 'o1|c', from: 'c', to: 'a', swarm: true }
        ]
    })
    const edgeB = document.querySelector('[data-kind="transfer"][data-from="b"][data-to="a"]')
    const edgeC = document.querySelector('[data-kind="transfer"][data-from="c"][data-to="a"]')
    assert.ok(edgeB)
    assert.ok(edgeC)
    assert.equal(edgeB.textContent, 'Swarm transfer')
    assert.equal(edgeC.textContent, 'Swarm transfer')
    assert.equal(document.querySelector('[data-node="b"]').getAttribute('data-seeding'), 'true')
    assert.equal(document.querySelector('[data-node="c"]').getAttribute('data-seeding'), 'true')
    assert.equal(document.querySelector('[data-node="a"]').getAttribute('data-seeding'), null)
    assert.match(document.querySelector('[data-node="b"]').textContent, /Seeding shared file/)
    assert.equal(legend.querySelector('[data-legend="file"]').hidden, false)
})
