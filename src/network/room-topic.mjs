// The current election host orders topic edits. A state packet authenticates its
// serving host through the chat session. The record stamp identifies the host/term
// that originally accepted the edit, so a retained clear also survives failover.
const integer = n => Number.isSafeInteger(n) && n >= 0
const validText = text => typeof text === 'string' && text.length <= 320 &&
    [...text].length <= 160 && !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(text)

function validRecord(r) {
    return r && integer(r.term) && typeof r.host === 'string' && r.host.length > 0 && r.host.length <= 128 &&
        integer(r.edit) && r.edit > 0 && validText(r.text)
}

function newer(a, b) {
    if (!b || a.term !== b.term) return !b || a.term > b.term
    if (a.host !== b.host) return a.host < b.host // same tie break as the election
    return a.edit > b.edit
}

export function createRoomTopic({ selfId, send, broadcast, changed }) {
    let host = null
    let term = 0
    let revision = -1
    let record = null
    let visible = ''
    const view = () => ({ available: revision >= 0, text: revision >= 0 ? visible : '' })
    const previousEpoch = r => r.term < term || (r.term === term && r.host > host)
    const packet = (op, data) => ({ type: 'topic', v: 1, host, term, op, ...data })
    const state = () => packet('state', { revision, record })

    function publish(next) {
        // Never forward additional fields supplied by a peer.
        record = { term: next.term, host: next.host, edit: next.edit, text: next.text }
        visible = record.text
        revision++
        broadcast(state())
        changed(view())
    }

    function acceptEdit(text) {
        const edit = record?.host === host && record.term === term ? record.edit + 1 : 1
        publish({ host, term, edit, text })
    }

    function sessionOpened(peerId) {
        if (host === selfId) send(peerId, state())
        else if (host === peerId) send(host, packet('sync', { record }))
    }

    function elected(info) {
        host = info.peerId
        term = info.term
        revision = host === selfId ? 0 : -1
        if (host && record && record.term > term) record = null
        visible = record?.text ?? ''
        changed(view())
        // becomeHost() sends the election announcement after its onChange callback.
        // Queue the topic behind that line on each ordered chat stream.
        queueMicrotask(() => {
            if (host !== info.peerId || term !== info.term || !host) return
            if (host === selfId) broadcast(state())
            else sessionOpened(host)
        })
    }

    function handle(peerId, m) {
        if (!host || m.v !== 1 || m.host !== host || m.term !== term) return
        if (host === selfId) {
            if (m.op === 'set' && validText(m.text)) acceptEdit(m.text.trim())
            if (m.op === 'sync') {
                // An already authenticated member can supply a previous host's retained record.
                // It cannot manufacture an edit of this host's current term.
                const r = m.record
                if (validRecord(r) && previousEpoch(r) && newer(r, record)) publish(r)
                else send(peerId, state())
            }
        } else if (peerId === host && m.op === 'state' && integer(m.revision) && m.revision > revision &&
                   (m.record === null || (validRecord(m.record) && m.record.term <= term))) {
            // A newly elected host might not yet have heard the previous edit. Offer it
            // before accepting an older snapshot, including an initially empty snapshot.
            const r = m.record
            if (record && previousEpoch(record) && (!r || newer(record, r))) {
                // Keep the offer if this host drops before acknowledging it. The window
                // still displays only the snapshot published by the elected host.
                send(host, packet('sync', { record }))
            } else {
                record = r ? { host: r.host, term: r.term, edit: r.edit, text: r.text } : null
            }
            visible = r?.text ?? ''
            revision = m.revision
            changed(view())
        }
    }

    function set(text) {
        if (!validText(text)) throw new Error('Use one line of up to 160 characters for the topic.')
        if (!host || revision < 0) throw new Error('Topic unavailable until a host with topic support is connected.')
        if (host === selfId) acceptEdit(text.trim())
        else if (!send(host, packet('set', { text: text.trim() }))) throw new Error('The topic host disconnected.')
    }

    function sessionClosed(peerId) {
        if (host !== peerId || revision < 0) return
        revision = -1
        changed(view())
    }

    return { view, elected, sessionOpened, sessionClosed, handle, set }
}
