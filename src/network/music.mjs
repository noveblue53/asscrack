// Room music (DECISIONS.md, 2026-11-23, MU-1 to MU-12). One DJ for each voice channel plays the queue on its own
// computer and sends one stereo Opus stream (MUSIC_PROTOCOL, a second voice relay, voice-relay.mjs). This module is
// the queue and the control line of the chat session: { type: 'music', v: 1, op, ... }.
// - MU-1: the member who starts the music is the DJ. Two DJs in one channel: the smaller peer ID stays DJ, and the
//   other one gives its YouTube items to it as add requests.
// - MU-3: the DJ sends its state (now playing, the queue, pause, the position) to each session, at each change and
//   each STATE_PERIOD_MS while a track plays. The members send requests to the DJ: add (a YouTube video or playlist
//   ID, never a URL), skip, pause and remove (only an item that the member added). Only the DJ moves items and adds
//   local files (the files of its own computer).
// - MU-4: the DJ leaves voice, moves to a different channel or goes away: the member with the smallest peer ID in that
//   channel takes the last state and continues as DJ. The local files of the old DJ are not on its computer, thus it
//   takes only the YouTube items. A Stop of the DJ ends the music for all.
// - MU-6 (P10): the only data from a peer for YouTube is a video ID or a playlist ID (VIDEO_ID, LIST_ID). A title from
//   the DJ is peer text: displayText, no control characters, at most TITLE_MAX code points.
// Pure: the clock, the timers, the rate limits, the sends and the YouTube resolver are parameters.
import { displayText } from './text-safety.mjs'

export const MUSIC_PROTOCOL = '/asscrack/music/1.0.0'
export const MUSIC_DIRECT_PROTOCOL = '/asscrack/music-direct/1.0.0'

export const MUSIC_LIMITS = Object.freeze({
    // The items in the queue after the current one.
    queue: 100,
    // The videos that one playlist add puts in the queue.
    playlist: 50,
    // The code points of a title.
    title: 200,
    // The characters of a link that the window gives.
    link: 2048,
    // Add requests of one peer and of all peers each minute. Each one can make the DJ ask YouTube.
    addsPerPeer: 20,
    addsPerRoom: 60,
    // All music lines of one peer and of all peers each minute.
    linesPerPeer: 120,
    linesPerRoom: 600,
    // Add requests that the DJ resolves at the same time.
    resolving: 4,
    // The longest track and position, in seconds.
    maxSeconds: 86400
})
export const STATE_PERIOD_MS = 15000
// The kinds of a notice line (the DJ tells the members about a skipped or a refused item).
export const MUSIC_NOTICES = Object.freeze(['refused', 'unavailable', 'error', 'full', 'limit'])

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
// MU-6: playlists (PL), album playlists (OLAK5uy_) and the upload lists of a channel (UU). No mixes (RD): a mix has no
// end and its items change for each person.
export const LIST_ID = /^(?:PL|OLAK5uy_|UU)[A-Za-z0-9_-]{10,62}$/
const ITEM_ID = /^[0-9a-f]{16}$/
const PEER_ID = /^[A-Za-z0-9]{1,128}$/
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f' + String.fromCharCode(0x2028, 0x2029) + ']', 'gu')
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])

// A link from the window: { video } or { list }, or { error: 'mix' | 'link' }. A link with a video and a list gives the
// video (the link of one video in a playlist). Only the IDs leave this function.
export function parseYouTubeLink(text) {
    if (typeof text !== 'string') return { error: 'link' }
    const value = text.trim()
    if (!value || value.length > MUSIC_LIMITS.link) return { error: 'link' }
    let url
    try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`) } catch { return { error: 'link' } }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.port) return { error: 'link' }
    const host = url.hostname.toLowerCase()
    const parts = url.pathname.split('/').filter(Boolean)
    let video = null
    if (host === 'youtu.be') video = parts.length === 1 ? parts[0] : null
    else if (YOUTUBE_HOSTS.has(host)) {
        if (parts.length === 1 && parts[0] === 'watch') video = url.searchParams.get('v')
        else if (parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0])) video = parts[1]
        else if (!(parts.length === 1 && parts[0] === 'playlist')) return { error: 'link' }
    } else return { error: 'link' }
    if (video !== null) return VIDEO_ID.test(video) ? { video } : { error: 'link' }
    const list = url.searchParams.get('list')
    if (typeof list === 'string' && /^RD/.test(list)) return { error: 'mix' }
    return typeof list === 'string' && LIST_ID.test(list) ? { list } : { error: 'link' }
}

// A title from YouTube, a file name or a peer: no hidden or control characters, trimmed, at most TITLE_MAX code points.
// Returns null for a value that is not a string.
export function musicTitle(value) {
    if (typeof value !== 'string' || value.length > MUSIC_LIMITS.title * 8) return null
    const text = [...displayText(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()]
    return text.length ? text.slice(0, MUSIC_LIMITS.title).join('') : 'Untitled'
}

const seconds = value => Number.isFinite(value) && value >= 0 ? Math.min(MUSIC_LIMITS.maxSeconds, value) : 0

// An item of a state line, or null.
function parseItem(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x) || typeof x.id !== 'string' || !ITEM_ID.test(x.id)) return null
    const title = musicTitle(x.title)
    if (title === null) return null
    const dur = Number.isInteger(x.dur) ? Math.round(seconds(x.dur)) : 0
    const by = typeof x.by === 'string' && PEER_ID.test(x.by) ? x.by : null
    if (x.src === 'yt') return typeof x.video === 'string' && VIDEO_ID.test(x.video) ? { id: x.id, src: 'yt', video: x.video, title, dur, by } : null
    if (x.src === 'file') return { id: x.id, src: 'file', title, dur, by }
    return null
}

// The wire form of an item: never the local key of a file.
function wireItem(item) {
    if (!item) return null
    const out = { id: item.id, src: item.src, title: item.title, dur: item.dur, by: item.by }
    if (item.src === 'yt') out.video = item.video
    return out
}

// Returns the valid line, or null.
export function parseMusicLine(m) {
    if (!m || typeof m !== 'object' || m.type !== 'music' || m.v !== 1) return null
    switch (m.op) {
        case 'state': {
            if (!Number.isInteger(m.seq) || m.seq < 0 || m.seq > 2 ** 31) return null
            if (!Array.isArray(m.queue) || m.queue.length > MUSIC_LIMITS.queue) return null
            const queue = []
            for (const x of m.queue) {
                const item = parseItem(x)
                if (!item) return null
                queue.push(item)
            }
            const now = m.now === null || m.now === undefined ? null : parseItem(m.now)
            if (m.now !== null && m.now !== undefined && !now) return null
            return { op: 'state', seq: m.seq, now, paused: m.paused === true, pos: seconds(m.pos), queue, yt: m.yt !== false }
        }
        case 'add':
            if (typeof m.video === 'string' && m.list === undefined) return VIDEO_ID.test(m.video) ? { op: 'add', video: m.video } : null
            if (typeof m.list === 'string' && m.video === undefined) return LIST_ID.test(m.list) ? { op: 'add', list: m.list } : null
            return null
        case 'skip':
        case 'remove':
            return typeof m.item === 'string' && ITEM_ID.test(m.item) ? { op: m.op, item: m.item } : null
        case 'pause':
            return typeof m.paused === 'boolean' ? { op: 'pause', paused: m.paused } : null
        case 'end':
            return { op: 'end', next: m.next === true }
        case 'notice':
            return MUSIC_NOTICES.includes(m.kind) ? { op: 'notice', kind: m.kind } : null
        default:
            return null
    }
}

const line = (op, fields = {}) => ({ type: 'music', v: 1, op, ...fields })
// A peer error for the window: the text is for the user.
const userError = text => Object.assign(new Error(text), { user: true })

// options:
// - selfId; send(peerId, line) and broadcast(line) send an object line; changed(view) gets each new view;
//   notice({ kind, from }) gets each notice for this window.
// - voiceOf(peerId): { inVoice, channel } of a peer with a session or of this node. voicePeers(): the peer IDs in voice
//   with a session, and this node when it is in voice.
// - resolve({ video } | { list }): a promise of [{ video, title, dur }] (the DJ asks YouTube). It throws an error with
//   kind 'refused' (YouTube refused this video or list) or 'unavailable' (the YouTube source does not work).
// - allowLine(peerId), allowAdd(peerId): the rate limits. newId(): 16 hex characters. now(), setTimer, clearTimer.
export function createRoomMusic({ selfId, send = () => false, broadcast = () => 0, changed = () => {}, notice = () => {},
    voiceOf = () => ({ inVoice: false, channel: null }), voicePeers = () => [],
    resolve = async () => { throw Object.assign(new Error('No YouTube source'), { kind: 'unavailable' }) },
    allowLine = () => true, allowAdd = () => true,
    newId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join(''),
    now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, statePeriodMs = STATE_PERIOD_MS }) {
    // The own DJ state, or null: { channel, seq, now, paused, pos, posAt, queue, yt, sent }.
    let own = null
    // peerId -> { state, at, channel } of the other DJs (their last state line).
    const djs = new Map()
    let resolving = 0
    let timer = null
    let stopped = false

    const voice = peerId => voiceOf(peerId) ?? { inVoice: false, channel: null }
    const selfVoice = () => voice(selfId)

    function estimate(state, at) {
        if (!state.now || state.paused) return state.pos
        const pos = state.pos + Math.max(0, now() - at) / 1000
        return state.now.dur > 0 ? Math.min(state.now.dur, pos) : seconds(pos)
    }

    // The DJ of the own voice channel: this node, the smallest peer ID of the DJs there, or null.
    function activeDj() {
        const me = selfVoice()
        if (!me.inVoice) return null
        if (own && own.channel === me.channel) return selfId
        let best = null
        for (const peerId of djs.keys()) {
            const v = voice(peerId)
            if (v.inVoice && v.channel === me.channel && (best === null || peerId < best)) best = peerId
        }
        return best
    }

    function view() {
        const me = selfVoice()
        const dj = activeDj()
        const empty = { self: selfId, dj: null, mine: false, inVoice: me.inVoice === true, now: null, paused: false, pos: 0,
            queue: [], yt: true, adding: 0 }
        if (!dj) return empty
        if (dj === selfId) {
            return { ...empty, dj, mine: true, now: wireItem(own.now), paused: own.paused, pos: estimate(own, own.posAt),
                queue: own.queue.map(wireItem), yt: own.yt, adding: resolving }
        }
        const d = djs.get(dj)
        return { ...empty, dj, now: d.state.now, paused: d.state.paused, pos: estimate(d.state, d.at), queue: d.state.queue,
            yt: d.state.yt }
    }

    const emit = () => { if (!stopped) changed(view()) }

    function stateLine() {
        return line('state', { seq: own.seq, now: wireItem(own.now), paused: own.paused, pos: estimate(own, own.posAt),
            queue: own.queue.map(wireItem), yt: own.yt })
    }

    function share() {
        if (!own) return
        own.seq++
        own.sent = true
        broadcast(stateLine())
    }

    function arm() {
        clearTimer(timer)
        timer = setTimer(() => {
            timer = null
            if (!own || stopped) return
            if (own.now && !own.paused) share()
            arm()
        }, statePeriodMs)
        timer?.unref?.()
    }

    // The members know the new DJ at once, also while its first add resolves.
    function becomeDj(channel) {
        own = { channel, seq: 0, now: null, paused: false, pos: 0, posAt: now(), queue: [], yt: true, sent: false }
        arm()
        share()
    }

    // next: true when the members must choose the next DJ (MU-4), false for a Stop.
    function endDj(next) {
        if (!own) return
        // The next DJ continues at the current position.
        if (next && own.now && own.sent) share()
        const sent = own.sent
        own = null
        clearTimer(timer)
        timer = null
        if (sent) broadcast(line('end', { next }))
    }

    function noticeAll(kind) {
        broadcast(line('notice', { kind }))
        notice({ kind, from: selfId })
    }

    function noticeTo(peerId, kind) {
        if (peerId === selfId) notice({ kind, from: selfId })
        else send(peerId, line('notice', { kind }))
    }

    // The next item of the queue starts. With no item and no add in progress, the music ends.
    function next() {
        own.now = own.queue.shift() ?? null
        own.pos = 0
        own.posAt = now()
        own.paused = false
        if (!own.now && resolving === 0) endDj(false)
        else share()
        emit()
    }

    function pushItems(items, by) {
        if (!own) return
        const room = MUSIC_LIMITS.queue - own.queue.length
        if (items.length > room) noticeTo(by, 'full')
        own.queue.push(...items.slice(0, Math.max(0, room)))
        if (!own.now) next()
        else {
            share()
            emit()
        }
    }

    // A YouTube add at the DJ. Returns { ok, kind }.
    async function resolveAdd(request, by) {
        if (resolving >= MUSIC_LIMITS.resolving) {
            noticeTo(by, 'limit')
            return { ok: false, kind: 'limit' }
        }
        resolving++
        emit()
        let result
        try {
            result = await resolve(request.video ? { video: request.video } : { list: request.list })
        } catch (err) {
            resolving--
            const kind = err?.kind === 'refused' ? 'refused' : 'unavailable'
            if (own) {
                if (kind === 'unavailable') own.yt = false
                noticeTo(by, kind)
                if (!own.now && own.queue.length === 0 && resolving === 0) endDj(false)
                else share()
            }
            emit()
            return { ok: false, kind }
        }
        resolving--
        if (stopped) return { ok: false, kind: 'stopped' }
        if (!own) {
            // This node stopped as DJ while the add resolved (MU-1): the add goes to the DJ of the channel.
            const dj = activeDj()
            if (dj && dj !== selfId) send(dj, line('add', request.video ? { video: request.video } : { list: request.list }))
            return { ok: Boolean(dj), sent: true }
        }
        own.yt = true
        const items = []
        for (const x of Array.isArray(result) ? result.slice(0, MUSIC_LIMITS.playlist) : []) {
            if (typeof x?.video !== 'string' || !VIDEO_ID.test(x.video)) continue
            items.push({ id: newId(), src: 'yt', video: x.video, title: musicTitle(x.title) ?? 'YouTube video',
                dur: Number.isFinite(x.dur) ? Math.round(seconds(x.dur)) : 0, by })
        }
        if (items.length === 0) {
            noticeTo(by, 'refused')
            if (!own.now && own.queue.length === 0 && resolving === 0) endDj(false)
            emit()
            return { ok: false, kind: 'refused' }
        }
        pushItems(items, by)
        return { ok: true, count: items.length }
    }

    function setPaused(paused) {
        if (!own?.now || own.paused === paused) return
        own.pos = estimate(own, own.posAt)
        own.posAt = now()
        own.paused = paused
        share()
        emit()
    }

    // MU-1: a DJ with a smaller peer ID in the same channel. This node gives its YouTube items to it and stops.
    function yieldTo(dj) {
        const items = [own.now, ...own.queue].filter(x => x?.src === 'yt').slice(0, MUSIC_LIMITS.addsPerPeer)
        for (const item of items) send(dj, line('add', { video: item.video }))
        endDj(false)
    }

    // MU-4: the DJ of the last state d went away. The member with the smallest peer ID in its channel continues.
    function handover(dj, d) {
        const channel = d.channel
        const me = selfVoice()
        if (own || !channel || !me.inVoice || me.channel !== channel) return
        for (const peerId of djs.keys()) {
            const v = voice(peerId)
            if (peerId !== dj && v.inVoice && v.channel === channel) return
        }
        const candidates = new Set(voicePeers().filter(p => p !== dj && voice(p).inVoice && voice(p).channel === channel))
        candidates.add(selfId)
        if ([...candidates].sort()[0] !== selfId) return
        const state = d.state
        const items = [state.now, ...state.queue].filter(x => x?.src === 'yt').map(x => ({ ...x }))
        if (items.length === 0) return
        becomeDj(channel)
        own.now = items.shift()
        own.queue = items
        const same = state.now && own.now.id === state.now.id
        own.pos = same ? estimate(state, d.at) : 0
        own.posAt = now()
        own.paused = same && state.paused
        own.yt = state.yt
        share()
    }

    // ---- The lines of the peers ----

    function handle(peerId, raw) {
        if (stopped || typeof peerId !== 'string' || peerId === selfId) return
        const m = parseMusicLine(raw)
        if (!m || !allowLine(peerId)) return
        if (m.op === 'state') {
            const v = voice(peerId)
            djs.set(peerId, { state: m, at: now(), channel: v.inVoice ? v.channel : djs.get(peerId)?.channel ?? null })
            if (own && v.inVoice && v.channel === own.channel && peerId < selfId) yieldTo(peerId)
            emit()
            return
        }
        if (m.op === 'end') {
            const d = djs.get(peerId)
            djs.delete(peerId)
            if (d && m.next) handover(peerId, d)
            emit()
            return
        }
        if (m.op === 'notice') {
            if (djs.has(peerId) && activeDj() === peerId) notice({ kind: m.kind, from: peerId })
            return
        }
        // A request of a member: only for the DJ, only from a member in the channel of the DJ.
        const v = voice(peerId)
        if (!own || !v.inVoice || v.channel !== own.channel) return
        if (m.op === 'add') {
            if (!allowAdd(peerId)) {
                noticeTo(peerId, 'limit')
                return
            }
            void resolveAdd(m, peerId)
        } else if (m.op === 'skip') {
            if (own.now?.id === m.item) next()
        } else if (m.op === 'pause') {
            setPaused(m.paused)
        } else if (m.op === 'remove') {
            const i = own.queue.findIndex(x => x.id === m.item)
            if (i >= 0 && own.queue[i].by === peerId) {
                own.queue.splice(i, 1)
                share()
                emit()
            }
        }
    }

    // A new session to this peer: the own state.
    function opened(peerId) {
        if (stopped || !own || !own.sent) return
        send(peerId, stateLine())
    }

    // A voice line of a peer or a change of the own voice state.
    function voiceChanged() {
        if (stopped) return
        const me = selfVoice()
        if (own && (!me.inVoice || me.channel !== own.channel)) endDj(true)
        for (const [peerId, d] of [...djs]) {
            const v = voice(peerId)
            if (d.channel === null && v.inVoice) {
                d.channel = v.channel
                continue
            }
            if (!v.inVoice || v.channel !== d.channel) {
                djs.delete(peerId)
                handover(peerId, d)
            }
        }
        emit()
    }

    function peerLeft(peerId) {
        if (stopped) return
        const d = djs.get(peerId)
        djs.delete(peerId)
        if (d) handover(peerId, d)
        emit()
    }

    // ---- The own window ----

    function checkInVoice() {
        if (stopped) throw new Error('The node is stopped')
        const me = selfVoice()
        if (!me.inVoice) throw userError('Join voice first.')
        return me
    }

    // A YouTube add ({ video } or { list }). The DJ resolves it; this node is the DJ when the channel has none.
    async function add(request) {
        const me = checkInVoice()
        const req = request?.video !== undefined ? { video: request.video } : { list: request?.list }
        if (req.video !== undefined ? !VIDEO_ID.test(req.video) : !LIST_ID.test(req.list ?? '')) throw userError('Not a YouTube link.')
        const dj = activeDj()
        if (dj && dj !== selfId) {
            send(dj, line('add', req))
            return { ok: true, sent: true }
        }
        if (!own) becomeDj(me.channel)
        return resolveAdd(req, selfId)
    }

    // Local files of this computer: [{ title, local }] (local: the key of the main process). Only the DJ.
    function addLocal(files) {
        const me = checkInVoice()
        const dj = activeDj()
        if (dj && dj !== selfId) throw userError('Only the DJ can add files.')
        const items = (Array.isArray(files) ? files : []).filter(f => typeof f?.local === 'string' && f.local)
            .map(f => ({ id: newId(), src: 'file', title: musicTitle(f.title) ?? 'Untitled', dur: 0, by: selfId, local: f.local }))
        if (items.length === 0) return { ok: false }
        if (!own) becomeDj(me.channel)
        pushItems(items, selfId)
        return { ok: true, count: items.length }
    }

    function skip() {
        checkInVoice()
        const dj = activeDj()
        if (dj === selfId) {
            if (own.now) next()
        } else if (dj) {
            const current = djs.get(dj).state.now
            if (current) send(dj, line('skip', { item: current.id }))
        }
        return view()
    }

    function pause(paused) {
        checkInVoice()
        const dj = activeDj()
        const value = paused === undefined ? !view().paused : paused === true
        if (dj === selfId) setPaused(value)
        else if (dj) send(dj, line('pause', { paused: value }))
        return view()
    }

    function remove(itemId) {
        checkInVoice()
        const dj = activeDj()
        if (dj === selfId) {
            const i = own.queue.findIndex(x => x.id === itemId)
            if (i >= 0) {
                own.queue.splice(i, 1)
                share()
                emit()
            }
        } else if (dj) {
            const item = djs.get(dj).state.queue.find(x => x.id === itemId)
            if (!item || item.by !== selfId) throw userError('Only the DJ can remove this.')
            send(dj, line('remove', { item: itemId }))
        }
        return view()
    }

    // The DJ moves an item of the queue to the index `to`.
    function move(itemId, to) {
        checkInVoice()
        if (activeDj() !== selfId) throw userError('Only the DJ can move items.')
        const i = own.queue.findIndex(x => x.id === itemId)
        if (i < 0 || !Number.isInteger(to)) return view()
        const [item] = own.queue.splice(i, 1)
        own.queue.splice(Math.max(0, Math.min(own.queue.length, to)), 0, item)
        share()
        emit()
        return view()
    }

    // Stop: the DJ ends the music for all.
    function stopMusic() {
        if (activeDj() !== selfId) throw userError('Only the DJ can stop the music.')
        endDj(false)
        emit()
        return view()
    }

    // ---- The player of the own window (the DJ) ----

    // The current item of this DJ with its local key, or null.
    const playing = () => own?.now ? { ...own.now } : null

    function ended(itemId) {
        if (own?.now?.id === itemId) next()
    }

    // kind: 'refused' (YouTube refused the video), 'unavailable' (the YouTube source does not work) or 'error'.
    function failed(itemId, kind) {
        if (own?.now?.id !== itemId) return
        const k = ['refused', 'unavailable'].includes(kind) ? kind : 'error'
        if (k === 'unavailable') own.yt = false
        noticeAll(k)
        next()
    }

    function progress(itemId, pos) {
        if (own?.now?.id !== itemId || !Number.isFinite(pos)) return
        own.pos = seconds(pos)
        own.posAt = now()
    }

    // G5 leaveRoom() and stop(): no DJ state, no line.
    function reset() {
        own = null
        clearTimer(timer)
        timer = null
        djs.clear()
        resolving = 0
        emit()
    }

    function stop() {
        reset()
        stopped = true
    }

    return { handle, opened, voiceChanged, peerLeft, add, addLocal, skip, pause, remove, move, stop: stopMusic,
        playing, ended, failed, progress, state: view, reset, close: stop, isDj: () => own !== null }
}
