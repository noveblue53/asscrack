// Room music (src/network/music.mjs): the link parser, the music line, the queue at the DJ, the requests of the
// members, the limits, the hand-over to the next DJ and two DJs in one channel. No network: a fake bus between the
// modules. The results are not LAN results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRoomMusic, parseMusicLine, parseYouTubeLink, musicTitle, MUSIC_LIMITS } from '../src/network/music.mjs'

const V1 = 'dQw4w9WgXcQ'
const V2 = 'aqz-KE-bpKQ'
const V3 = 'jNQXAC9IVRw'
const LIST = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'

// A room of music modules. ids: the peer IDs (the order is not the sort order). Each peer has a session with each
// other peer. setVoice(id, inVoice, channel) changes the voice state that all modules see.
function harness(ids, { resolve, allowAdd } = {}) {
    // voice: what the other nodes know; selfVoice: what a node knows of itself (it changes first, MU-4).
    const voice = new Map()
    const selfVoice = new Map()
    const queue = []
    const notices = []
    const views = new Map()
    let clock = 1_000_000
    const resolved = []
    const tracks = []
    const fakeResolve = resolve ?? (async request => {
        resolved.push(request)
        if (request.video) return [{ video: request.video, title: `Title ${request.video}`, dur: 200 }]
        return Array.from({ length: 80 }, (_, i) => ({ video: `vid${String(i).padStart(8, '0')}`, title: `List item ${i}`, dur: 100 }))
    })
    const modules = new Map()
    ids.forEach((id, n) => {
        let counter = 0
        modules.set(id, createRoomMusic({
            selfId: id,
            send: (peer, line) => { queue.push([id, peer, structuredClone(line)]); return true },
            broadcast: line => { for (const p of ids) if (p !== id) queue.push([id, p, structuredClone(line)]); return ids.length - 1 },
            changed: view => views.set(id, view),
            notice: value => notices.push({ at: id, ...value }),
            trackDone: value => tracks.push({ at: id, ...value }),
            voiceOf: p => (p === id ? selfVoice.get(p) : voice.get(p)) ?? { inVoice: false, channel: null },
            voicePeers: () => ids.filter(p => voice.get(p)?.inVoice),
            resolve: fakeResolve,
            allowAdd,
            newId: () => ((n + 1) * 0x1000000 + ++counter).toString(16).padStart(16, '0'),
            now: () => clock,
            setTimer: () => null,
            clearTimer: () => {}
        }))
    })
    async function flush() {
        for (let i = 0; i < 20; i++) {
            while (queue.length) {
                const [from, to, line] = queue.shift()
                modules.get(to).handle(from, line)
            }
            await new Promise(resolve => setImmediate(resolve))
        }
    }
    // The node changes its own state and sends its lines first, then the others get its voice line (node.mjs setVoice).
    async function setVoice(id, inVoice, channel = 'general') {
        const value = { inVoice, channel: inVoice ? channel : null }
        selfVoice.set(id, value)
        modules.get(id).voiceChanged()
        await flush()
        voice.set(id, value)
        for (const [p, m] of modules) if (p !== id) m.voiceChanged()
        await flush()
    }
    return { m: id => modules.get(id), flush, setVoice, notices, views, resolved, queue, tracks,
        tick: ms => { clock += ms }, leave: id => { voice.delete(id); selfVoice.delete(id); for (const [p, m] of modules) if (p !== id) m.peerLeft(id) } }
}

test('link parser: video and playlist links give only the ID', () => {
    assert.deepEqual(parseYouTubeLink(`https://www.youtube.com/watch?v=${V1}`), { video: V1 })
    assert.deepEqual(parseYouTubeLink(`https://youtu.be/${V1}?t=42`), { video: V1 })
    assert.deepEqual(parseYouTubeLink(`youtube.com/shorts/${V1}`), { video: V1 })
    assert.deepEqual(parseYouTubeLink(`https://music.youtube.com/watch?v=${V1}&feature=share`), { video: V1 })
    assert.deepEqual(parseYouTubeLink(`https://m.youtube.com/watch?v=${V1}&list=${LIST}&index=3`), { video: V1 },
        'a video in a playlist gives the video')
    assert.deepEqual(parseYouTubeLink(`  https://www.youtube.com/playlist?list=${LIST}  `), { list: LIST })
})

test('link parser: other hosts, mixes, bad IDs, credentials and long text are refused', () => {
    for (const text of [`https://evil.example/watch?v=${V1}`, `https://youtube.com.evil.example/watch?v=${V1}`,
        `javascript:alert(1)//youtube.com/watch?v=${V1}`, `file:///C:/x?v=${V1}`, `https://www.youtube.com/watch?v=${V1}x`,
        `https://www.youtube.com/watch?v=${V1.slice(0, 10)}%22`, `https://user:pw@www.youtube.com/watch?v=${V1}`,
        `https://www.youtube.com:8443/watch?v=${V1}`, `https://www.youtube.com/channel/UCxyz`, '', 42, null,
        `https://www.youtube.com/watch?v=${V1}&${'a'.repeat(MUSIC_LIMITS.link)}`, `https://youtu.be/${V1}/extra`]) {
        assert.equal(parseYouTubeLink(text).error, 'link', `refused: ${String(text).slice(0, 60)}`)
    }
    assert.deepEqual(parseYouTubeLink(`https://www.youtube.com/watch?list=RD${V1}`), { error: 'mix' })
    assert.deepEqual(parseYouTubeLink('https://www.youtube.com/playlist?list=RDCLAK5uy_abcdefghijklmnop'), { error: 'mix' })
})

test('music line: IDs, limits and titles', () => {
    const item = (over = {}) => ({ id: '0123456789abcdef', src: 'yt', video: V1, title: 'A song', dur: 200, by: 'peerA', ...over })
    const state = (over = {}) => ({ type: 'music', v: 1, op: 'state', seq: 1, now: item(), paused: false, pos: 3, queue: [], ...over })
    assert.equal(parseMusicLine(state()).now.video, V1)
    // An add carries an ID, never a URL.
    assert.deepEqual(parseMusicLine({ type: 'music', v: 1, op: 'add', video: V1 }), { op: 'add', video: V1 })
    assert.equal(parseMusicLine({ type: 'music', v: 1, op: 'add', video: `https://youtu.be/${V1}` }), null)
    assert.equal(parseMusicLine({ type: 'music', v: 1, op: 'add', list: `RD${V1}` }), null)
    assert.equal(parseMusicLine({ type: 'music', v: 1, op: 'add', video: V1, list: LIST }), null)
    assert.equal(parseMusicLine({ type: 'music', v: 2, op: 'add', video: V1 }), null)
    // The queue has at most 100 items.
    assert.equal(parseMusicLine(state({ queue: Array.from({ length: MUSIC_LIMITS.queue }, () => item()) })).queue.length, 100)
    assert.equal(parseMusicLine(state({ queue: Array.from({ length: MUSIC_LIMITS.queue + 1 }, () => item()) })), null)
    // One bad item makes the line invalid.
    assert.equal(parseMusicLine(state({ queue: [item({ video: 'bad' })] })), null)
    assert.equal(parseMusicLine(state({ queue: [item({ id: 'ZZZ' })] })), null)
    assert.equal(parseMusicLine(state({ queue: [item({ src: 'http' })] })), null)
    // A file item has no video and no path on the wire.
    assert.deepEqual(parseMusicLine(state({ now: item({ src: 'file', video: undefined, local: 'C:\\x.mp3' }) })).now,
        { id: '0123456789abcdef', src: 'file', title: 'A song', dur: 200, by: 'peerA' })
    // Titles: no control or hidden characters, at most 200 code points.
    const parsed = parseMusicLine(state({ now: item({ title: `a\u0000b\u202ec\n${'x'.repeat(500)}` }) })).now.title
    assert.equal([...parsed].length, MUSIC_LIMITS.title)
    assert.ok(!/[\u0000\u202e\n]/.test(parsed))
    assert.equal(musicTitle('   '), 'Untitled')
    assert.equal(musicTitle(5), null)
    assert.equal(parseMusicLine({ type: 'music', v: 1, op: 'notice', kind: 'other' }), null)
    assert.equal(parseMusicLine({ type: 'music', v: 1, op: 'pause', paused: 'yes' }), null)
})

test('the first member who adds is the DJ; a member add goes to the DJ, which resolves it', async () => {
    const h = harness(['pB', 'pA', 'pC'])
    for (const id of ['pA', 'pB', 'pC']) await h.setVoice(id, true)
    // Not in voice: no add.
    const outside = harness(['pX'])
    await assert.rejects(outside.m('pX').add({ video: V1 }), /Join voice first/)
    assert.equal((await h.m('pB').add({ video: V1 })).ok, true)
    await h.flush()
    assert.equal(h.m('pB').state().mine, true)
    assert.equal(h.m('pA').state().dj, 'pB')
    assert.equal(h.m('pA').state().now.video, V1)
    // A member add: the line goes to the DJ, the DJ resolves it, all members see the queue.
    assert.deepEqual(await h.m('pC').add({ video: V2 }), { ok: true, sent: true })
    await h.flush()
    assert.deepEqual(h.resolved.map(r => r.video), [V1, V2], 'only the DJ resolves')
    for (const id of ['pA', 'pB', 'pC']) assert.deepEqual(h.m(id).state().queue.map(x => [x.video, x.by]), [[V2, 'pC']])
    // A member in a different channel cannot add to this DJ.
    await h.setVoice('pA', true, 'other')
    await h.m('pA').add({ video: V3 })
    await h.flush()
    assert.equal(h.m('pA').state().mine, true, 'pA is the DJ of its own channel')
    assert.equal(h.m('pB').state().queue.length, 1, 'the queue of pB did not change')
})

test('only the DJ adds files and moves items; a member removes only its own items; skip needs the current item', async () => {
    const h = harness(['pA', 'pB', 'pC'])
    for (const id of ['pA', 'pB', 'pC']) await h.setVoice(id, true)
    h.m('pA').addLocal([{ title: 'song.mp3', local: 'k1' }, { title: 'two.flac', local: 'k2' }])
    await h.flush()
    assert.equal(h.m('pA').playing().local, 'k1', 'the DJ has the local key')
    assert.equal(h.m('pB').state().now.local, undefined, 'the members never get the local key')
    assert.equal(h.m('pB').state().now.src, 'file')
    assert.throws(() => h.m('pB').addLocal([{ title: 'x', local: 'k9' }]), /Only the DJ can add files/)
    await h.m('pB').add({ video: V1 })
    await h.m('pC').add({ video: V2 })
    await h.flush()
    const queue = h.m('pB').state().queue
    assert.deepEqual(queue.map(x => x.title), ['two.flac', `Title ${V1}`, `Title ${V2}`])
    // pB cannot remove the item of pC (the window refuses, and the DJ refuses a line).
    assert.throws(() => h.m('pB').remove(queue[2].id), /Only the DJ can remove/)
    h.m('pA').handle('pB', { type: 'music', v: 1, op: 'remove', item: queue[2].id })
    h.m('pB').remove(queue[1].id)
    await h.flush()
    assert.deepEqual(h.m('pC').state().queue.map(x => x.title), ['two.flac', `Title ${V2}`])
    assert.throws(() => h.m('pB').move(queue[2].id, 0), /Only the DJ can move/)
    h.m('pA').move(queue[2].id, 0)
    await h.flush()
    assert.deepEqual(h.m('pC').state().queue.map(x => x.title), [`Title ${V2}`, 'two.flac'])
    // A skip line for an item that is not the current one (a late second click) does nothing.
    h.m('pA').handle('pC', { type: 'music', v: 1, op: 'skip', item: queue[2].id })
    assert.equal(h.m('pA').state().now.title, 'song.mp3')
    h.m('pC').skip()
    await h.flush()
    assert.equal(h.m('pB').state().now.title, `Title ${V2}`)
    // Pause from a member.
    h.m('pB').pause(true)
    await h.flush()
    assert.equal(h.m('pA').state().paused, true)
    assert.equal(h.m('pC').state().paused, true)
})

test('limits: 100 items in the queue, 50 videos of a playlist, a full notice for the requester', async () => {
    const h = harness(['pA', 'pB'])
    await h.setVoice('pA', true)
    await h.setVoice('pB', true)
    await h.m('pA').add({ list: LIST })
    await h.flush()
    // One item plays, 49 wait.
    assert.equal(h.m('pB').state().queue.length, MUSIC_LIMITS.playlist - 1)
    await h.m('pB').add({ list: LIST })
    await h.flush()
    assert.equal(h.m('pB').state().queue.length, MUSIC_LIMITS.playlist * 2 - 1)
    await h.m('pB').add({ list: LIST })
    await h.flush()
    assert.equal(h.m('pA').state().queue.length, MUSIC_LIMITS.queue)
    assert.ok(h.notices.some(n => n.at === 'pB' && n.kind === 'full' && n.from === 'pA'), 'pB got the full notice')
    assert.ok(!h.notices.some(n => n.at === 'pA' && n.kind === 'full'), 'the DJ got no full notice for an add of pB')
})

test('limits: the add rate limit of the DJ and at most 4 resolves at the same time', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    let calls = 0
    const h = harness(['pA', 'pB'], {
        resolve: async request => { calls++; await gate; return [{ video: request.video, title: 't', dur: 1 }] },
        allowAdd: (() => { let n = 0; return () => ++n <= 6 })()
    })
    await h.setVoice('pA', true)
    await h.setVoice('pB', true)
    void h.m('pA').add({ video: V1 })
    await h.flush()
    for (let i = 0; i < 8; i++) await h.m('pB').add({ video: V2 })
    await h.flush()
    assert.equal(calls, 4, 'at most 4 resolves at the same time')
    assert.ok(h.notices.filter(n => n.at === 'pB' && n.kind === 'limit').length >= 4, 'pB got limit notices')
    release()
    await h.flush()
    assert.equal(h.m('pB').state().adding, 0)
})

test('hand-over: the DJ leaves voice; the smallest peer ID in its channel continues with the YouTube items and the position', async () => {
    const h = harness(['pD', 'pC', 'pB', 'pE'])
    for (const id of ['pD', 'pC', 'pB']) await h.setVoice(id, true)
    await h.setVoice('pE', true, 'other')
    await h.m('pD').add({ video: V1 })
    h.m('pD').addLocal([{ title: 'local.mp3', local: 'k1' }])
    await h.m('pD').add({ video: V2 })
    await h.flush()
    const firstId = h.m('pD').state().now.id
    h.m('pD').progress(firstId, 30)
    h.tick(10000)
    h.m('pD').pause(false)
    await h.flush()
    h.tick(5000)
    // The DJ leaves voice: pB (smaller than pC; pE is in a different channel) is the next DJ.
    await h.setVoice('pD', false)
    await h.flush()
    assert.equal(h.m('pB').state().mine, true, 'pB is the DJ')
    assert.equal(h.m('pC').state().dj, 'pB')
    assert.equal(h.m('pE').state().dj, null, 'nothing changes in the other channel')
    const view = h.m('pB').state()
    assert.equal(view.now.id, firstId, 'the same track continues')
    assert.ok(view.pos >= 44 && view.pos <= 46, `position ${view.pos} near 45 s`)
    assert.deepEqual(view.queue.map(x => x.video), [V2], 'the local file of the old DJ is not taken')
    assert.equal(h.m('pD').state().dj, null)
})

test('hand-over: a DJ that goes away with no line; a Stop of the DJ ends the music with no hand-over', async () => {
    const h = harness(['pA', 'pB', 'pC'])
    for (const id of ['pA', 'pB', 'pC']) await h.setVoice(id, true)
    await h.m('pC').add({ video: V1 })
    await h.flush()
    h.leave('pC')
    await h.flush()
    assert.equal(h.m('pA').state().mine, true)
    assert.equal(h.m('pB').state().dj, 'pA')
    h.m('pA').stop()
    await h.flush()
    assert.equal(h.m('pA').state().dj, null)
    assert.equal(h.m('pB').state().dj, null, 'no hand-over after Stop')
    assert.throws(() => h.m('pB').stop(), /Only the DJ/)
})

test('two DJs in one channel: the larger peer ID gives its YouTube items to the smaller one', async () => {
    const h = harness(['pA', 'pB'])
    await h.setVoice('pA', true)
    await h.setVoice('pB', true)
    // Both add before a state line arrives.
    await h.m('pB').add({ video: V1 })
    await h.m('pA').add({ video: V2 })
    await h.flush()
    assert.equal(h.m('pA').state().mine, true)
    assert.equal(h.m('pB').state().mine, false)
    assert.equal(h.m('pB').state().dj, 'pA')
    const all = [h.m('pA').state().now.video, ...h.m('pA').state().queue.map(x => x.video)]
    assert.deepEqual(all.sort(), [V1, V2].sort(), 'the item of pB is in the queue of pA')
})

test('a refused video gives a notice and the next item plays; with no YouTube source the local files still play', async () => {
    const h = harness(['pA', 'pB'], {
        resolve: async request => {
            if (request.video === V3) throw Object.assign(new Error('x'), { kind: 'unavailable' })
            return [{ video: request.video, title: 't', dur: 10 }]
        }
    })
    await h.setVoice('pA', true)
    await h.setVoice('pB', true)
    await h.m('pA').add({ video: V1 })
    await h.m('pA').add({ video: V2 })
    await h.flush()
    h.m('pA').failed(h.m('pA').state().now.id, 'refused')
    await h.flush()
    assert.ok(h.notices.some(n => n.at === 'pB' && n.kind === 'refused' && n.from === 'pA'))
    assert.equal(h.m('pB').state().now.video, V2)
    assert.deepEqual(await h.m('pA').add({ video: V3 }), { ok: false, kind: 'unavailable' })
    await h.flush()
    assert.equal(h.m('pB').state().yt, false, 'the members see that YouTube does not work at the DJ')
    assert.deepEqual(h.m('pA').addLocal([{ title: 'f.ogg', local: 'k' }]), { ok: true, count: 1 })
    h.m('pA').ended(h.m('pA').state().now.id)
    await h.flush()
    assert.equal(h.m('pB').state().now.title, 'f.ogg')
    // The last item ends: the music ends, the DJ role ends.
    h.m('pA').ended(h.m('pA').state().now.id)
    await h.flush()
    assert.equal(h.m('pA').state().dj, null)
    assert.equal(h.m('pB').state().dj, null)
})

test('journal hook: the DJ reports the end, a skip (also of a member), an error and a Stop, with no title', async () => {
    const h = harness(['pA', 'pB'])
    await h.setVoice('pA', true)
    await h.setVoice('pB', true)
    h.m('pA').addLocal([{ title: 'one', local: 'k1' }, { title: 'two', local: 'k2' }, { title: 'three', local: 'k3' }])
    await h.m('pA').add({ video: V1 })
    await h.flush()
    h.m('pA').ended(h.m('pA').state().now.id)
    await h.flush()
    h.m('pB').skip()
    await h.flush()
    h.m('pA').failed(h.m('pA').state().now.id, 'error')
    h.m('pA').stop()
    await h.flush()
    assert.deepEqual(h.tracks.map(({ at, source, reason }) => [at, source, reason]),
        [['pA', 'file', 'end'], ['pA', 'file', 'skip'], ['pA', 'file', 'error'], ['pA', 'youtube', 'stop']])
    assert.ok(h.tracks.every(t => Object.keys(t).sort().join() === 'at,reason,source'), 'no title in the hook')
})
