// Ready check (milestone 9): the pure state of src/network/ready-check.mjs with the clock of fake-clock.mjs.
// No network: each "peer" is a peer ID and the lines go into a list. These are results of this PC (no network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClock } from './helpers/fake-clock.mjs'
import { createReadyCheck, parseReadyLine, readyText, READY_RESULT_MS, READY_GRACE_MS } from '../src/network/ready-check.mjs'

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

function make(selfId = 'me', { peers = ['a', 'b', 'c'], allow, ids = [ID1, ID2] } = {}) {
    const clock = createClock()
    const sent = []
    const views = []
    const queue = [...ids]
    const r = createReadyCheck({
        selfId, peers: () => peers, allow,
        send: (peerId, line) => { sent.push({ to: peerId, line }); return true },
        broadcast: line => { sent.push({ to: '*', line }); return peers.length },
        changed: v => views.push(v),
        newId: () => queue.shift(),
        now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout
    })
    return { r, clock, sent, views, last: () => views.at(-1) }
}
const open = (id, text = 'Race in five?') => ({ type: 'ready', v: 1, op: 'open', id, text })
const vote = (id, v) => ({ type: 'ready', v: 1, op: 'vote', id, vote: v })
const close = id => ({ type: 'ready', v: 1, op: 'close', id })

test('ready check: an open line gives one open check with no votes; the people are self and the peers', () => {
    const { r, last } = make()
    r.handle('a', open(ID1))
    const v = last()
    assert.deepEqual(v.people, ['me', 'a', 'b', 'c'])
    assert.equal(v.checks.length, 1)
    assert.deepEqual({ id: v.checks[0].id, from: v.checks[0].from, text: v.checks[0].text, open: v.checks[0].open, mine: v.checks[0].mine },
        { id: ID1, from: 'a', text: 'Race in five?', open: true, mine: false })
    assert.deepEqual(v.checks[0].votes, {})
})

test('ready check: votes count by peer ID; a changed vote replaces the previous vote; the same name counts two times', () => {
    const { r, last, sent } = make()
    r.handle('a', open(ID1))
    // b and c have the same display name: the module does not know names, only the peer IDs.
    r.handle('b', vote(ID1, 'ready'))
    r.handle('c', vote(ID1, 'ready'))
    r.handle('b', vote(ID1, 'minute'))
    r.vote(ID1, 'ready')
    assert.deepEqual(last().checks[0].votes, { b: 'minute', c: 'ready', me: 'ready' })
    assert.deepEqual(sent.at(-1), { to: '*', line: { type: 'ready', v: 1, op: 'vote', id: ID1, vote: 'ready' } })
    r.vote(ID1, 'minute')
    assert.deepEqual(last().checks[0].votes, { b: 'minute', c: 'ready', me: 'minute' })
    assert.throws(() => r.vote(ID1, 'maybe'), TypeError)
    assert.throws(() => r.vote(ID2, 'ready'), /not open/)
})

test('ready check: open with no text gives "Ready?"; the text is trimmed and has at most 120 characters', () => {
    const { r, sent, last } = make()
    r.open('')
    assert.deepEqual(sent[0], { to: '*', line: { type: 'ready', v: 1, op: 'open', id: ID1, text: 'Ready?' } })
    assert.equal(last().checks[0].mine, true)
    r.open('  Race in five?  ')
    assert.equal(sent[1].line.text, 'Race in five?')
    // A second own open replaces the first.
    assert.equal(last().checks.length, 1)
    assert.equal(last().checks[0].id, ID2)
    assert.throws(() => r.open('x'.repeat(121)), TypeError)
    assert.equal(readyText('\u{1F600}'.repeat(120)), '\u{1F600}'.repeat(120))
    assert.equal(readyText('a\nb'), null)
})

test('ready check: the initiator closes; the result shows for 10 s, then the check goes away', () => {
    const { r, clock, sent, last } = make()
    r.open('Go?')
    assert.throws(() => r.close(ID2), /no open/)
    r.close(ID1)
    assert.deepEqual(sent.at(-1), { to: '*', line: { type: 'ready', v: 1, op: 'close', id: ID1 } })
    assert.equal(last().checks[0].open, false)
    assert.throws(() => r.vote(ID1, 'ready'), /not open/)
    clock.advance(READY_RESULT_MS - 1)
    assert.equal(last().checks.length, 1)
    clock.advance(1)
    assert.equal(last().checks.length, 0)
})

test('ready check: a close line from a peer that is not the initiator does nothing', () => {
    const { r, clock, last } = make()
    r.handle('a', open(ID1))
    r.handle('b', close(ID1))
    assert.equal(last().checks[0].open, true)
    r.handle('a', close(ID1))
    assert.equal(last().checks[0].open, false)
    clock.advance(READY_RESULT_MS)
    assert.equal(last().checks.length, 0)
})

test('ready check: the check expires at once when the initiator leaves with a bye line', () => {
    const { r, last } = make()
    r.handle('a', open(ID1))
    r.handle('b', vote(ID1, 'ready'))
    r.left('a', true)
    assert.equal(last().checks.length, 0)
    // It never comes back: a late open line of the same ID is ignored.
    r.handle('a', open(ID1))
    assert.equal(last().checks.length, 0)
})

test('ready check: with no bye, the check expires after 10 s; a voter that goes loses its vote', () => {
    const { r, clock, last, views } = make()
    r.handle('a', open(ID1))
    r.handle('b', vote(ID1, 'ready'))
    r.left('b', false)
    assert.deepEqual(last().checks[0].votes, {})
    r.left('a', false)
    clock.advance(READY_GRACE_MS - 1)
    assert.equal(last().checks.length, 1)
    clock.advance(1)
    assert.equal(last().checks.length, 0)
    const count = views.length
    r.handle('a', open(ID1))
    assert.equal(views.length, count, 'an expired check does not show again')
})

test('ready check: the initiator comes back in 10 s and sends the open line again: the check stays', () => {
    const { r, clock, last } = make()
    r.handle('a', open(ID1))
    r.left('a', false)
    clock.advance(4000)
    r.opened('a')
    r.handle('a', open(ID1))
    clock.advance(READY_GRACE_MS * 3)
    assert.equal(last().checks.length, 1)
    assert.equal(last().checks[0].open, true)
})

test('ready check: the initiator closed the check while I was away and comes back in 10 s: the check closes', () => {
    const { r, clock, last } = make()
    r.handle('a', open(ID1))
    r.left('a', false)
    clock.advance(3000)
    // The new session: the initiator sends the close line of its last check, not the open line.
    r.opened('a')
    r.handle('a', close(ID1))
    assert.equal(last().checks[0].open, false)
    clock.advance(READY_RESULT_MS)
    assert.equal(last().checks.length, 0)
    r.handle('a', open(ID1))
    assert.equal(last().checks.length, 0)
})

test('ready check: a new session of the initiator with no open line again (it started again): the check expires', () => {
    const { r, clock, last } = make()
    r.handle('a', open(ID1))
    r.opened('a')
    clock.advance(READY_GRACE_MS)
    assert.equal(last().checks.length, 0)
})

test('ready check: a new session gets the own open check and the own votes', () => {
    const { r, sent } = make('me', { ids: [ID2] })
    r.handle('a', open(ID1))
    r.vote(ID1, 'minute')
    r.open('Mine?')
    sent.length = 0
    r.opened('d')
    assert.deepEqual(sent, [
        { to: 'd', line: { type: 'ready', v: 1, op: 'open', id: ID2, text: 'Mine?' } },
        { to: 'd', line: { type: 'ready', v: 1, op: 'vote', id: ID1, vote: 'minute' } }
    ])
    // After a close, a new session gets the close line.
    r.close()
    sent.length = 0
    r.opened('e')
    assert.equal(sent[0].line.op, 'close')
    assert.equal(sent[0].to, 'e')
})

test('ready check: a vote that comes before the open line counts when the open line comes', () => {
    const { r, last } = make()
    r.handle('b', vote(ID1, 'ready'))
    r.handle('a', open(ID1))
    assert.deepEqual(last().checks[0].votes, { b: 'ready' })
})

test('ready check: one open check for each initiator; a second open replaces the first and the first never comes back', () => {
    const { r, last } = make()
    r.handle('a', open(ID1, 'One'))
    r.handle('b', open(ID2, 'Two'))
    assert.equal(last().checks.length, 2)
    const ID3 = '33333333-3333-4333-8333-333333333333'
    r.handle('a', open(ID3, 'Three'))
    assert.deepEqual(last().checks.map(c => c.text).sort(), ['Three', 'Two'])
    r.handle('a', open(ID1, 'One'))
    assert.deepEqual(last().checks.map(c => c.text).sort(), ['Three', 'Two'])
})

test('ready check: lines that are not valid are ignored', () => {
    const { r, views } = make()
    const bad = [
        null, 'text', { type: 'ready', v: 2, op: 'open', id: ID1 }, { type: 'ready', v: 1, op: 'open', id: 'x' },
        { type: 'ready', v: 1, op: 'open', id: ID1, text: 'x'.repeat(121) }, { type: 'ready', v: 1, op: 'open', id: ID1, text: 5 },
        { type: 'ready', v: 1, op: 'open', id: ID1, text: 'a\u0007b' }, { type: 'ready', v: 1, op: 'vote', id: ID1, vote: 'yes' },
        { type: 'ready', v: 1, op: 'kick', id: ID1 }, { type: 'ready', v: 1, op: 'open', id: 42 }
    ]
    for (const line of bad) {
        assert.equal(parseReadyLine(line), null, JSON.stringify(line))
        r.handle('a', line)
    }
    assert.equal(views.length, 0)
    // A line that says it is from me is not mine: the session decides the peer.
    r.handle('me', open(ID1))
    assert.equal(views.length, 0)
    // An open line with no text gives "Ready?".
    assert.deepEqual(parseReadyLine({ type: 'ready', v: 1, op: 'open', id: ID1.toUpperCase() }), { op: 'open', id: ID1, text: 'Ready?' })
})

test('ready check: the rate limit of a peer drops its lines', () => {
    let left = 2
    const { r, last } = make('me', { allow: () => left-- > 0 })
    r.handle('a', open(ID1))
    r.handle('b', vote(ID1, 'ready'))
    r.handle('c', vote(ID1, 'ready'))
    assert.deepEqual(last().checks[0].votes, { b: 'ready' })
})

test('ready check: reset removes the checks, and a removed check does not show again', () => {
    const { r, last } = make()
    r.handle('a', open(ID1))
    r.reset()
    assert.equal(last().checks.length, 0)
    r.handle('a', open(ID1))
    assert.equal(last().checks.length, 0)
})
