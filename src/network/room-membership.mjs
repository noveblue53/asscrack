import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

const VERSION = 2
const MAX_MEMBERS = 128

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
    const grantFields = grant => ['asscrack-room-grant/2', id, grant.deviceId, grant.canHost]
    const admissionFields = grant => ['asscrack-room-admission/2', id, grant.signature]
    const revokeFields = state => ['asscrack-room-revocations/2', id, state.sequence, state.devices]
    const proofFields = (nonce, sender, receiver) => ['asscrack-room-peer-proof/2', id, nonce, sender, receiver]
    return { owner, lan, grantFields, admissionFields, revokeFields, proofFields }
}

function inspectGrant(room, value) {
    if (!value || value.deviceId === room.owner || typeof value.canHost !== 'boolean' ||
        !verified(room.owner, room.grantFields(value), value.signature)) return null
    const { deviceId, canHost, signature } = value
    if (!validDeviceId(deviceId)) return null
    return { deviceId, canHost, signature }
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
    return { v: VERSION, owner: access.owner, lan: access.lan, grant, admission, revocations, issued }
}

export function createRoomMembership({ identity, room, roomKey, lan = false }) {
    const access = authority(room, roomKey, identity.id, lan)
    const initial = { sequence: 0, devices: [] }
    const revocations = { ...initial, signature: identity.sign(access.revokeFields(initial)) }
    return restoreRoomMembership({ identity, room, roomKey, descriptor: {
        v: VERSION, owner: identity.id, lan, grant: null, admission: null, revocations, issued: []
    } })
}

export function restoreRoomMembership({ identity, room, roomKey, descriptor }) {
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
        if (!grant) {
            if (current.issued.length >= MAX_MEMBERS) throw new Error('Room member limit reached')
            const fields = { deviceId, canHost: canHost === true }
            grant = { ...fields, signature: identity.sign(access.grantFields(fields)) }
            update({ ...current, issued: [...current.issued, grant] })
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

    return Object.freeze({ id: identity.id, owner, ownerId: access.owner, lan: access.lan,
        hostGrant: owner || current.grant.canHost,
        admitted: () => !revoked(identity.id) && (owner || current.admission !== null),
        canHost: () => !revoked(identity.id) && (owner || (current.admission !== null && current.grant.canHost)),
        snapshot: () => structuredClone(current),
        revocations: () => structuredClone(current.revocations),
        issued: () => current.issued.map(({ deviceId, canHost }) => ({ deviceId, canHost, revoked: revoked(deviceId) })),
        revoked, memberProof, verifyMember, observe, admit, acceptAdmission, issue, revoke,
        setPersistence(callback) { persist = callback },
        onChanged(callback) { changed = callback }
    })
}
