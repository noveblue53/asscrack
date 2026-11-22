// G6: the named voice channels of a protected room. One catalog, signed by the owner device:
// { v: 1, seq, channels: [{ id, name }], signature }. The default channel General ('general') is not in the catalog.
// A receiver keeps a catalog only when its structure and signature are valid and its seq is higher (the method of the
// revocation list). The owner device alone edits it. A legacy room (no membership) has only General.
import { randomUUID } from 'node:crypto'
import { validChannelId, validChannelName } from './channels.mjs'

export const GENERAL_VOICE_CHANNEL = 'general'
export const MAX_VOICE_CHANNELS = 16
const GENERAL = Object.freeze({ id: GENERAL_VOICE_CHANNEL, name: 'General' })

export const ERRORS = Object.freeze({
    legacy: 'Voice channels need a protected room.',
    owner: 'Only the room owner can change voice channels.',
    exists: 'That voice channel name already exists.',
    name: 'Use a name of 1–40 characters.',
    limit: 'A room can have at most 16 voice channels.',
    general: 'The General voice channel cannot be changed.',
    missing: 'That voice channel does not exist.'
})

const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const nameKey = name => name.toLowerCase()

// The structure of a catalog. Returns a new copy (channels sorted by ID) or null. The signature is not checked here.
export function checkVoiceCatalog(value) {
    if (!value || typeof value !== 'object' || value.v !== 1 || !Number.isSafeInteger(value.seq) || value.seq < 1 ||
        typeof value.signature !== 'string' || !Array.isArray(value.channels) ||
        value.channels.length > MAX_VOICE_CHANNELS) return null
    const ids = new Set()
    const names = new Set()
    const channels = []
    for (const row of value.channels) {
        if (!row || !validChannelId(row.id) || !validChannelName(row.name)) return null
        if (ids.has(row.id) || names.has(nameKey(row.name))) return null
        ids.add(row.id)
        names.add(nameKey(row.name))
        channels.push({ id: row.id, name: row.name })
    }
    return { v: 1, seq: value.seq, channels: channels.sort(byId), signature: value.signature }
}

// The input name of an edit: trimmed and NFC. Throws a plain text error for the window.
function cleanName(input) {
    const name = typeof input === 'string' ? input.trim().normalize('NFC') : ''
    if (nameKey(name) === 'general') throw new Error(ERRORS.exists)
    if (!validChannelName(name)) throw new Error(ERRORS.name)
    return name
}

// membership: the room membership or null (legacy room). seed: a saved catalog or null.
// changed({ view, catalog, removed }): after each accepted change. removed: the channels that went away ([{ id, name }]).
// send(msg, exceptPeerId): to all sessions (except one).
// checkLimit: L12 (P10b), the limit of the failed signature checks of each peer ({ allowed(peerId), failed(peerId) },
// see peerFailureLimit). A peer over the limit gets no signature check. The structure and the seq check come first and
// cost no signature check. A valid catalog never counts, thus an owner edit always arrives.
export function createVoiceChannels({ membership = null, seed = null, send = () => {}, changed = () => {},
    checkLimit = null } = {}) {
    let catalog = null

    function valid(value) {
        const next = checkVoiceCatalog(value)
        return next && membership?.verifyVoiceChannels(next) ? next : null
    }
    if (membership && seed) catalog = valid(seed)

    const seq = () => catalog?.seq ?? 0
    const list = () => [GENERAL, ...(catalog?.channels ?? []).map(row => ({ ...row }))]
    const view = () => ({
        owner: membership?.owner === true, editable: membership?.owner === true, seq: seq(), channels: list()
    })
    const line = () => ({ type: 'voice-channels', v: 1, catalog: structuredClone(catalog) })
    const has = id => id === GENERAL_VOICE_CHANNEL || (catalog?.channels.some(row => row.id === id) ?? false)

    function apply(next, source) {
        const before = catalog?.channels ?? []
        catalog = next
        const removed = before.filter(row => !next.channels.some(other => other.id === row.id))
        send(line(), source)
        changed({ view: view(), catalog: structuredClone(catalog), removed })
    }

    function edit(change) {
        if (!membership) throw new Error(ERRORS.legacy)
        if (!membership.owner) throw new Error(ERRORS.owner)
        const channels = change((catalog?.channels ?? []).map(row => ({ ...row })))
        const state = { seq: seq() + 1, channels: channels.sort(byId) }
        apply({ v: 1, ...state, signature: membership.signVoiceChannels(state) }, null)
    }

    function taken(channels, name, except = null) {
        return channels.some(row => row.id !== except && nameKey(row.name) === nameKey(name))
    }

    return {
        view, has, seq,
        catalog: () => (catalog ? structuredClone(catalog) : null),
        // The line for a new session, or null when there is no catalog.
        opened: () => (catalog ? line() : null),
        // A 'voice-channels' line from a peer. Returns true when the catalog was kept.
        receive(msg, source) {
            if (!membership || msg?.v !== 1) return false
            const shape = checkVoiceCatalog(msg.catalog)
            if (!shape || shape.seq <= seq() || (checkLimit && !checkLimit.allowed(source))) return false
            const next = valid(shape)
            if (!next) {
                checkLimit?.failed(source)
                return false
            }
            apply(next, source)
            return true
        },
        create(input) {
            let id = null
            edit(channels => {
                const name = cleanName(input)
                if (taken(channels, name)) throw new Error(ERRORS.exists)
                if (channels.length >= MAX_VOICE_CHANNELS) throw new Error(ERRORS.limit)
                id = randomUUID()
                return [...channels, { id, name }]
            })
            return id
        },
        rename(id, input) {
            edit(channels => {
                if (id === GENERAL_VOICE_CHANNEL) throw new Error(ERRORS.general)
                const row = channels.find(other => other.id === id)
                if (!row) throw new Error(ERRORS.missing)
                const name = cleanName(input)
                if (taken(channels, name, id)) throw new Error(ERRORS.exists)
                row.name = name
                return channels
            })
        },
        remove(id) {
            edit(channels => {
                if (id === GENERAL_VOICE_CHANNEL) throw new Error(ERRORS.general)
                if (!channels.some(row => row.id === id)) throw new Error(ERRORS.missing)
                return channels.filter(row => row.id !== id)
            })
        }
    }
}
