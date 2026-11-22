import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'

const VERSION = 2
const MAX_MEMBERS = 128
// L4 (P10a): a new grant (the device invite) has a signed expiry time. The owner refuses an expired grant, and a grant
// with no expiry, at the first admission. An admitted device keeps its access after the expiry time.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const INVITE_EXPIRED = 'This invite has expired. Ask the room owner for a new invite.'
const validExpiry = value => Number.isSafeInteger(value) && value > 0
// easy-join part 2: the ID of the room code of the owner (16 bytes, base64url). "New room code" makes a new ID.
const validCodeId = value => canonicalBytes(value, 16) !== null

function canonicalBytes(value, size) {
    if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3) || !/^[\w-]+$/.test(value)) return null
    const bytes = Buffer.from(value, 'base64url')
    return bytes.length === size && bytes.toString('base64url') === value ? bytes : null
}

export const validDeviceId = value => canonicalBytes(value, 32) !== null

function localIdentity(privateKey) {
    const id = createPublicKey(privateKey).export({ format: 'jwk' }).x
    return Object.freeze({
        id,
        exportPrivate() { return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') },
        sign(fields) { return sign(null, Buffer.from(JSON.stringify(fields)), privateKey).toString('base64url') }
    })
}

export function createDeviceIdentity() {
    return localIdentity(generateKeyPairSync('ed25519').privateKey)
}

export function importDeviceIdentity(serialized) {
    if (typeof serialized !== 'string' || serialized.length > 128 || !/^[\w-]+$/.test(serialized)) throw new Error('Invalid device key')
    const privateKey = createPrivateKey({ key: Buffer.from(serialized, 'base64url'), format: 'der', type: 'pkcs8' })
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Invalid device key')
    return localIdentity(privateKey)
}

function verified(id, fields, signature) {
    const bytes = canonicalBytes(signature, 64)
    if (!validDeviceId(id) || !bytes) return false
    try {
        const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: id }, format: 'jwk' })
        return verify(null, Buffer.from(JSON.stringify(fields)), publicKey, bytes)
    } catch { return false }
}

function authority(room, roomKey, owner, lan) {
    const key = typeof roomKey === 'string' ? roomKey : Buffer.from(roomKey).toString('base64url')
    if (!canonicalBytes(key, 32) || typeof room !== 'string' || !validDeviceId(owner) || typeof lan !== 'boolean') {
        throw new Error('Invalid protected room')
    }
    const id = createHash('sha256').update(JSON.stringify(['asscrack-room-membership/2', room, key, owner, lan])).digest('base64url')
    // L4: a grant with an expiry time signs it too. A grant of an older version has no expiry.
    const grantFields = grant => grant.expires === undefined ? ['asscrack-room-grant/2', id, grant.deviceId, grant.canHost]
        : ['asscrack-room-grant/3', id, grant.deviceId, grant.canHost, grant.expires]
    const admissionFields = grant => ['asscrack-room-admission/2', id, grant.signature]
    const revokeFields = state => ['asscrack-room-revocations/2', id, state.sequence, state.devices]
    const proofFields = (nonce, sender, receiver) => ['asscrack-room-peer-proof/2', id, nonce, sender, receiver]
    // G6: the voice channel catalog. A new copy of each channel, sorted by ID: the signed bytes do not depend on the
    // order of the properties or of the rows on the wire.
    const voiceChannelFields = state => ['asscrack-voice-channels/1', id, state.seq,
        [...state.channels].map(row => ({ id: row.id, name: row.name })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)]
    // easy-join part 2: the room code (the owner signs the SHA-256 of the code bytes), the knock proof of the owner
    // (over the nonce of the knocker) and the knock proof of the knocker device (over the nonce of the owner).
    const roomCodeFields = bodyHash => ['asscrack-room-code/1', id, bodyHash]
    const knockOwnerFields = (codeId, nonce) => ['asscrack-knock-owner/1', id, codeId, nonce]
    const knockFields = (codeId, nonce) => ['asscrack-knock/1', id, codeId, nonce]
    return { id, owner, lan, grantFields, admissionFields, revokeFields, proofFields, voiceChannelFields,
        roomCodeFields, knockOwnerFields, knockFields }
}

// easy-join part 2: the checks of a room code and of a knock for a device that has no membership yet (the knocker).
// The owner device ID comes from the room code. roomId: the ID that the knock lines name.
export function roomCodeAccess(room, roomKey, owner, lan) {
    const access = authority(room, roomKey, owner, lan)
    return Object.freeze({
        roomId: access.id,
        verifyCode: (bodyHash, signature) => verified(access.owner, access.roomCodeFields(bodyHash), signature),
        verifyOwnerKnock: (codeId, nonce, signature) => verified(access.owner, access.knockOwnerFields(codeId, nonce), signature),
        knockProof: (identity, codeId, nonce) => identity.sign(access.knockFields(codeId, nonce))
    })
}

function inspectRoomCode(value) {
    if (value === undefined) return undefined
    if (!value || !validCodeId(value.id) || !validExpiry(value.expires)) throw new Error('Invalid protected room code')
    return { id: value.id, expires: value.expires }
}

function inspectGrant(room, value) {
    if (!value || value.deviceId === room.owner || typeof value.canHost !== 'boolean' ||
        (value.expires !== undefined && !validExpiry(value.expires)) ||
        !verified(room.owner, room.grantFields(value), value.signature)) return null
    const { deviceId, canHost, signature, expires } = value
    if (!validDeviceId(deviceId)) return null
    return expires === undefined ? { deviceId, canHost, signature } : { deviceId, canHost, expires, signature }
}

function inspectRevocations(room, value) {
    if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || value.sequence > MAX_MEMBERS ||
        !Array.isArray(value.devices) || value.devices.length !== value.sequence ||
        new Set(value.devices).size !== value.devices.length || value.devices.some(id => id === room.owner || !validDeviceId(id)) ||
        !verified(room.owner, room.revokeFields(value), value.signature)) return null
    return { sequence: value.sequence, devices: [...value.devices], signature: value.signature }
}

export function inspectMembershipDescriptor(room, roomKey, descriptor, { invite = false } = {}) {
    if (descriptor?.v !== VERSION) throw new Error('Invalid protected room authorization')
    const access = authority(room, roomKey, descriptor.owner, descriptor.lan)
    const grant = descriptor.grant === null && !invite ? null : inspectGrant(access, descriptor.grant)
    const revocations = inspectRevocations(access, descriptor.revocations)
    if ((!grant && (invite || descriptor.grant !== null)) || !revocations) throw new Error('Invalid protected room authorization')
    const admission = descriptor.admission === null ? null : descriptor.admission
    if (admission !== null && (!grant || invite || !verified(access.owner, access.admissionFields(grant), admission))) {
        throw new Error('Invalid protected room admission')
    }
    const issued = []
    if (!invite && grant === null) {
        if (!Array.isArray(descriptor.issued) || descriptor.issued.length > MAX_MEMBERS) throw new Error('Invalid protected room members')
        const seen = new Set()
        for (const candidate of descriptor.issued) {
            const checked = inspectGrant(access, candidate)
            if (!checked || seen.has(checked.deviceId)) throw new Error('Invalid protected room members')
            seen.add(checked.deviceId)
            issued.push(checked)
        }
    }
    // easy-join part 2: only the owner keeps a room code. An older descriptor has none.
    const roomCode = !invite && grant === null ? inspectRoomCode(descriptor.roomCode) : undefined
    return { v: VERSION, owner: access.owner, lan: access.lan, grant, admission, revocations, issued,
        ...(roomCode ? { roomCode } : {}) }
}

export function createRoomMembership({ identity, room, roomKey, lan = false, now = Date.now }) {
    const access = authority(room, roomKey, identity.id, lan)
    const initial = { sequence: 0, devices: [] }
    const revocations = { ...initial, signature: identity.sign(access.revokeFields(initial)) }
    return restoreRoomMembership({ identity, room, roomKey, now, descriptor: {
        v: VERSION, owner: identity.id, lan, grant: null, admission: null, revocations, issued: []
    } })
}

// now: the clock of the expiry check (L4), for the tests.
export function restoreRoomMembership({ identity, room, roomKey, descriptor, now = Date.now }) {
    let current = inspectMembershipDescriptor(room, roomKey, descriptor)
    const access = authority(room, roomKey, current.owner, current.lan)
    const owner = identity.id === current.owner
    if ((owner && current.grant !== null) || (!owner && current.grant?.deviceId !== identity.id)) {
        throw new Error('This invitation is for another device')
    }
    if (current.revocations.devices.includes(identity.id)) throw new Error('This device has been removed from the room')
    let persist = null
    let changed = null
    let revocationsNeedSaving = false

    function update(next) {
        persist?.(structuredClone(next))
        current = next
        revocationsNeedSaving = false
        changed?.()
    }

    const revoked = id => current.revocations.devices.includes(id)
    function persistRevocations() {
        try {
            persist?.(structuredClone(current))
            revocationsNeedSaving = false
        } catch (cause) {
            revocationsNeedSaving = true
            const error = new Error('Could not save the room revocations', { cause })
            error.code = 'ROOM_REVOCATION_PERSIST_FAILED'
            throw error
        }
    }
    function observe(candidate) {
        const next = inspectRevocations(access, candidate)
        if (!next) return false
        if (next.sequence <= current.revocations.sequence) {
            if (next.sequence === current.revocations.sequence && next.signature !== current.revocations.signature) return false
            if (revocationsNeedSaving) persistRevocations()
            return true
        }
        if (current.revocations.devices.some(id => !next.devices.includes(id))) return false
        // Enforce a verified revocation in this process even if the profile cannot save it.
        // Notify sessions after updating the state so they can close and forward the denial.
        current = { ...current, revocations: next }
        try { persistRevocations() }
        finally { changed?.() }
        return true
    }

    function memberProof(nonce, sender, receiver) {
        return {
            deviceId: identity.id,
            grant: current.grant,
            admission: current.admission,
            revocations: current.revocations,
            signature: identity.sign(access.proofFields(nonce, sender, receiver))
        }
    }

    function verifyMember(proof, nonce, sender, receiver) {
        if (!proof || !verified(proof.deviceId, access.proofFields(nonce, sender, receiver), proof.signature)) return null
        const isOwner = proof.deviceId === access.owner
        const grant = isOwner ? null : inspectGrant(access, proof.grant)
        if ((!isOwner && grant?.deviceId !== proof.deviceId) || !observe(proof.revocations) || revoked(proof.deviceId) || revoked(identity.id)) return null
        const hasAdmission = isOwner || verified(access.owner, access.admissionFields(grant), proof.admission)
        if (!hasAdmission && !owner) return null
        return { deviceId: proof.deviceId, canHost: isOwner || grant.canHost, grant, hasAdmission }
    }

    function admit(member) {
        if (!owner || !member?.grant || revoked(member.deviceId)) throw new Error('Membership is unavailable')
        // L4: the first admission needs a grant with an expiry time that is not past.
        if (!validExpiry(member.grant.expires) || now() > member.grant.expires) throw new Error(INVITE_EXPIRED)
        const issued = current.issued.find(grant => grant.deviceId === member.deviceId)
        if (issued && issued.signature !== member.grant.signature) throw new Error('The device grant has changed')
        if (!issued) {
            if (current.issued.length >= MAX_MEMBERS) throw new Error('Room member limit reached')
            update({ ...current, issued: [...current.issued, member.grant] })
        }
        return identity.sign(access.admissionFields(member.grant))
    }

    function acceptAdmission(signature) {
        if (owner || revoked(identity.id) || !verified(access.owner, access.admissionFields(current.grant), signature)) return false
        if (!current.admission) update({ ...current, admission: signature })
        return true
    }

    function issue(deviceId, canHost = false) {
        if (!owner || !validDeviceId(deviceId) || deviceId === identity.id) throw new Error('Choose a different device ID')
        if (revoked(deviceId)) throw new Error('This device has been removed from the room')
        let grant = current.issued.find(value => value.deviceId === deviceId)
        if (grant && grant.canHost !== canHost) throw new Error('This device already has a different role')
        // L4: a grant with no expiry time or with a past expiry time gets a new grant. The new invite replaces the old one.
        const stale = grant && (!validExpiry(grant.expires) || now() > grant.expires)
        if (!grant || stale) {
            if (!grant && current.issued.length >= MAX_MEMBERS) throw new Error('Room member limit reached')
            const fields = { deviceId, canHost: canHost === true, expires: now() + INVITE_TTL_MS }
            grant = { deviceId: fields.deviceId, canHost: fields.canHost, expires: fields.expires,
                signature: identity.sign(access.grantFields(fields)) }
            update({ ...current, issued: [...current.issued.filter(value => value.deviceId !== deviceId), grant] })
        }
        return { v: VERSION, owner: access.owner, lan: access.lan, grant: { ...grant }, admission: null,
            revocations: structuredClone(current.revocations) }
    }

    function revoke(deviceId) {
        if (!owner) throw new Error('Only the room owner can remove a device')
        if (!current.issued.some(grant => grant.deviceId === deviceId) || revoked(deviceId)) return false
        const next = { sequence: current.revocations.sequence + 1, devices: [...current.revocations.devices, deviceId] }
        update({ ...current, revocations: { ...next, signature: identity.sign(access.revokeFields(next)) } })
        return true
    }

    // G6: only the owner device signs the voice channel catalog. The caller checks the structure (voice-channels.mjs).
    function signVoiceChannels({ seq, channels } = {}) {
        if (!owner) throw new Error('Only the room owner can change voice channels.')
        if (!Number.isSafeInteger(seq) || !Array.isArray(channels)) throw new Error('Invalid voice channel catalog')
        return identity.sign(access.voiceChannelFields({ seq, channels }))
    }

    function verifyVoiceChannels(catalog) {
        if (!catalog || !Number.isSafeInteger(catalog.seq) || !Array.isArray(catalog.channels) ||
            !catalog.channels.every(row => row && typeof row === 'object')) return false
        return verified(access.owner, access.voiceChannelFields(catalog), catalog.signature)
    }

    // easy-join part 2: the room code of the owner. renew: "New room code" (the old code stops working). A code that
    // expired also gets a new ID. Returns { id, expires }.
    function roomCode({ renew = false } = {}) {
        if (!owner) throw new Error('Only the room owner can make a room code.')
        const old = current.roomCode
        if (!renew && old && now() <= old.expires) return { ...old }
        const next = { id: randomBytes(16).toString('base64url'), expires: now() + INVITE_TTL_MS }
        update({ ...current, roomCode: next })
        return { ...next }
    }
    // 'ok', 'old-code' (not the current code ID) or 'expired'. The owner clock decides the expiry.
    function checkRoomCode(codeId) {
        if (!owner || !current.roomCode || codeId !== current.roomCode.id) return 'old-code'
        return now() > current.roomCode.expires ? 'expired' : 'ok'
    }
    function signRoomCode(bodyHash) {
        if (!owner || typeof bodyHash !== 'string') throw new Error('Only the room owner can make a room code.')
        return identity.sign(access.roomCodeFields(bodyHash))
    }
    function knockOwnerProof(codeId, nonce) {
        if (!owner) throw new Error('Only the room owner can answer a knock.')
        return identity.sign(access.knockOwnerFields(codeId, nonce))
    }
    const verifyKnock = (deviceId, codeId, nonce, signature) => verified(deviceId, access.knockFields(codeId, nonce), signature)

    return Object.freeze({ id: identity.id, owner, ownerId: access.owner, lan: access.lan, roomId: access.id,
        hostGrant: owner || current.grant.canHost,
        admitted: () => !revoked(identity.id) && (owner || current.admission !== null),
        canHost: () => !revoked(identity.id) && (owner || (current.admission !== null && current.grant.canHost)),
        snapshot: () => structuredClone(current),
        revocations: () => structuredClone(current.revocations),
        issued: () => current.issued.map(({ deviceId, canHost }) => ({ deviceId, canHost, revoked: revoked(deviceId) })),
        revoked, memberProof, verifyMember, observe, admit, acceptAdmission, issue, revoke,
        signVoiceChannels, verifyVoiceChannels,
        roomCode, checkRoomCode, signRoomCode, knockOwnerProof, verifyKnock,
        setPersistence(callback) { persist = callback },
        onChanged(callback) { changed = callback }
    })
}
