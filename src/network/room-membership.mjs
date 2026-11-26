import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'

const VERSION = 2
const MAX_MEMBERS = 128
const VALID_ROLES = new Set(['admin', 'member'])
const VALID_STATUSES = new Set(['active', 'kicked', 'banned'])
// L4 (P10a): a new grant (the device invite) has a signed expiry time. The owner refuses an expired grant, and a grant
// with no expiry, at the first admission. An admitted device keeps its access after the expiry time.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const INVITE_EXPIRED = 'This invite has expired. Ask the room owner for a new invite.'
const validExpiry = value => Number.isSafeInteger(value) && value > 0
const validEpoch = value => Number.isSafeInteger(value) && value >= 1
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
    const grantFields = grant => {
        if (grant.epoch !== undefined) {
            return ['asscrack-room-grant/4', id, grant.deviceId, grant.canHost, grant.expires, grant.epoch, grant.issuer]
        }
        return grant.expires === undefined
            ? ['asscrack-room-grant/2', id, grant.deviceId, grant.canHost]
            : ['asscrack-room-grant/3', id, grant.deviceId, grant.canHost, grant.expires]
    }
    const admissionFields = grant => ['asscrack-room-admission/2', id, grant.signature]
    const revokeFields = state => ['asscrack-room-revocations/2', id, state.sequence, state.devices]
    const roleFields = rec => ['asscrack-room-role/1', id, rec.deviceId, rec.role, rec.canHost, rec.status, rec.epoch,
        rec.issuer, rec.issuerEpoch, rec.hidden === true]
    const proofFields = (nonce, sender, receiver) => ['asscrack-room-peer-proof/2', id, nonce, sender, receiver]
    // G6: the voice channel catalog. A new copy of each channel, sorted by ID: the signed bytes do not depend on the
    // order of the properties or of the rows on the wire.
    const voiceChannelFields = state => ['asscrack-voice-channels/1', id, state.seq,
        [...state.channels].map(row => ({ id: row.id, name: row.name })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)]
    // easy-join part 2: the room code (the owner signs the SHA-256 of the code bytes), the knock proof of the owner
    // (over the nonce of the knocker) and the knock proof of the knocker device (over the nonce of the owner).
    const roomCodeFields = bodyHash => ['asscrack-room-code/1', id, bodyHash]
    const knockOwnerFields = (codeId, nonce) => knockOwnerFieldsOf(id, codeId, nonce)
    const knockFields = (codeId, nonce) => knockFieldsOf(id, codeId, nonce)
    const roomCodeStateFields = (codeId, expires) => ['asscrack-room-code-state/1', id, codeId, expires]
    return { id, owner, lan, grantFields, admissionFields, revokeFields, roleFields, proofFields, voiceChannelFields,
        roomCodeFields, roomCodeStateFields, knockOwnerFields, knockFields }
}

// easy-join part 2: the signed fields of the two knock proofs. Part 3 (the friend knock) uses them with a room ID only.
const knockOwnerFieldsOf = (roomId, codeId, nonce) => ['asscrack-knock-owner/1', roomId, codeId, nonce]
const knockFieldsOf = (roomId, codeId, nonce) => ['asscrack-knock/1', roomId, codeId, nonce]
export const validRoomId = value => canonicalBytes(value, 32) !== null

function verifyDelegatedAdminKnock(roomId, owner, codeId, nonce, proof) {
    if (typeof proof === 'string') return verified(owner, knockOwnerFieldsOf(roomId, codeId, nonce), proof)
    if (!proof || typeof proof !== 'object' || typeof proof.signature !== 'string' || !validDeviceId(proof.issuer)) return false
    const roleStub = {
        owner,
        roleFields: rec => ['asscrack-room-role/1', roomId, rec.deviceId, rec.role, rec.canHost, rec.status, rec.epoch,
            rec.issuer, rec.issuerEpoch, rec.hidden === true]
    }
    const adminRec = inspectRoleRecord(roleStub, proof.issuerProof)
    if (!adminRec || adminRec.issuer !== owner || adminRec.deviceId !== proof.issuer ||
        adminRec.role !== 'admin' || adminRec.status !== 'active') return false
    return verified(proof.issuer, knockOwnerFieldsOf(roomId, codeId, nonce), proof.signature)
}

// easy-join part 3: the knock proofs for a knocker that knows only the room ID and the owner device ID (a friend knock:
// the friend tells the room ID, never the room key). The same fields as roomCodeAccess.
export function knockAccess(roomId, owner) {
    if (!validRoomId(roomId) || !validDeviceId(owner)) throw new Error('Invalid protected room')
    return Object.freeze({
        roomId,
        verifyOwnerKnock: (codeId, nonce, signature) => verified(owner, knockOwnerFieldsOf(roomId, codeId, nonce), signature),
        verifyResponderKnock: (codeId, nonce, proof) => verifyDelegatedAdminKnock(roomId, owner, codeId, nonce, proof),
        knockProof: (identity, codeId, nonce) => identity.sign(knockFieldsOf(roomId, codeId, nonce))
    })
}

// easy-join part 2: the checks of a room code and of a knock for a device that has no membership yet (the knocker).
// The owner device ID comes from the room code. roomId: the ID that the knock lines name.
export function roomCodeAccess(room, roomKey, owner, lan) {
    const access = authority(room, roomKey, owner, lan)
    return Object.freeze({
        roomId: access.id,
        verifyCode: (bodyHash, signature) => verified(access.owner, access.roomCodeFields(bodyHash), signature),
        verifyOwnerKnock: (codeId, nonce, signature) => verified(access.owner, access.knockOwnerFields(codeId, nonce), signature),
        verifyResponderKnock: (codeId, nonce, proof) => verifyDelegatedAdminKnock(access.id, access.owner, codeId, nonce, proof),
        knockProof: (identity, codeId, nonce) => identity.sign(access.knockFields(codeId, nonce))
    })
}

function inspectRoomCode(value, access) {
    if (value === undefined) return undefined
    if (!value || !validCodeId(value.id) || !validExpiry(value.expires)) throw new Error('Invalid protected room code')
    const out = { id: value.id, expires: value.expires }
    if (typeof value.signature === 'string' && access &&
        verified(access.owner, access.roomCodeStateFields(value.id, value.expires), value.signature)) {
        out.signature = value.signature
    }
    return out
}

function inspectRoleRecord(room, value) {
    if (!value || typeof value !== 'object' || !validDeviceId(value.deviceId) || value.deviceId === room.owner ||
        !VALID_ROLES.has(value.role) || typeof value.canHost !== 'boolean' || !VALID_STATUSES.has(value.status) ||
        !validEpoch(value.epoch) || !validDeviceId(value.issuer) ||
        !Number.isSafeInteger(value.issuerEpoch) || value.issuerEpoch < 0 ||
        (value.hidden !== undefined && typeof value.hidden !== 'boolean')) return null
    const hidden = value.hidden === true
    const rec = {
        deviceId: value.deviceId,
        role: value.role,
        canHost: value.canHost,
        status: value.status,
        epoch: value.epoch,
        issuer: value.issuer,
        issuerEpoch: value.issuerEpoch,
        hidden,
        signature: value.signature
    }
    if (rec.issuer === room.owner) {
        if (rec.issuerEpoch !== 0 || !verified(room.owner, room.roleFields(rec), rec.signature)) return null
        return rec
    }
    if (rec.role !== 'member' || rec.issuerEpoch < 1) return null
    const proof = inspectRoleRecord(room, value.issuerProof)
    if (!proof || proof.issuer !== room.owner || proof.deviceId !== rec.issuer ||
        proof.role !== 'admin' || proof.status !== 'active' || proof.epoch !== rec.issuerEpoch) return null
    if (!verified(rec.issuer, room.roleFields(rec), rec.signature)) return null
    return { ...rec, issuerProof: proof }
}

function recordWins(room, candidate, existing) {
    if (!existing) return true
    if (candidate.epoch !== existing.epoch) return candidate.epoch > existing.epoch
    const candOwner = candidate.issuer === room.owner
    const existOwner = existing.issuer === room.owner
    if (candOwner !== existOwner) return candOwner
    if (candidate.issuer !== existing.issuer) return candidate.issuer > existing.issuer
    return candidate.signature > existing.signature
}

function inspectGrant(room, value) {
    if (!value || value.deviceId === room.owner || typeof value.canHost !== 'boolean' || !validDeviceId(value.deviceId) ||
        (value.expires !== undefined && !validExpiry(value.expires))) return null
    if (value.epoch !== undefined) {
        if (!validEpoch(value.epoch) || !validExpiry(value.expires) || !validDeviceId(value.issuer)) return null
        if (value.issuer === room.owner) {
            if (!verified(room.owner, room.grantFields(value), value.signature)) return null
            return { deviceId: value.deviceId, canHost: value.canHost, expires: value.expires,
                epoch: value.epoch, issuer: value.issuer, signature: value.signature }
        }
        const proof = inspectRoleRecord(room, value.issuerProof)
        if (!proof || proof.issuer !== room.owner || proof.deviceId !== value.issuer ||
            proof.role !== 'admin' || proof.status !== 'active') return null
        if (!verified(value.issuer, room.grantFields(value), value.signature)) return null
        return { deviceId: value.deviceId, canHost: value.canHost, expires: value.expires,
            epoch: value.epoch, issuer: value.issuer, issuerProof: proof, signature: value.signature }
    }
    if (!verified(room.owner, room.grantFields(value), value.signature)) return null
    const { deviceId, canHost, signature, expires } = value
    return expires === undefined ? { deviceId, canHost, signature } : { deviceId, canHost, expires, signature }
}

function verifyAdmission(room, grant, admission) {
    if (typeof admission === 'string') {
        return verified(room.owner, room.admissionFields(grant), admission)
    }
    if (!admission || typeof admission !== 'object' || typeof admission.signature !== 'string' || !validDeviceId(admission.issuer)) {
        return false
    }
    if (admission.issuer === room.owner) {
        return verified(room.owner, room.admissionFields(grant), admission.signature)
    }
    const proof = inspectRoleRecord(room, admission.issuerProof)
    if (!proof || proof.issuer !== room.owner || proof.deviceId !== admission.issuer ||
        proof.role !== 'admin' || proof.status !== 'active') return false
    return verified(admission.issuer, room.admissionFields(grant), admission.signature)
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
    if (admission !== null && (!grant || invite || !verifyAdmission(access, grant, admission))) {
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
    const recordsMap = new Map()
    if (descriptor.records !== undefined) {
        if (!Array.isArray(descriptor.records) || descriptor.records.length > MAX_MEMBERS) throw new Error('Invalid protected room roles')
        for (const candidate of descriptor.records) {
            const checked = inspectRoleRecord(access, candidate)
            if (!checked) throw new Error('Invalid protected room roles')
            const existing = recordsMap.get(checked.deviceId)
            if (recordWins(access, checked, existing)) recordsMap.set(checked.deviceId, checked)
        }
    }
    // easy-join part 2: only the owner keeps a room code. An older descriptor has none.
    const roomCode = !invite && grant === null ? inspectRoomCode(descriptor.roomCode, access) : undefined
    // easy-join part 3: "Always allow my friends", an owner setting. Only the value true is kept (off is the default).
    const autoAllowFriends = !invite && grant === null && descriptor.autoAllowFriends === true
    return { v: VERSION, owner: access.owner, lan: access.lan, grant, admission, revocations, issued,
        ...(recordsMap.size > 0 ? { records: [...recordsMap.values()] } : {}),
        ...(roomCode ? { roomCode } : {}), ...(autoAllowFriends ? { autoAllowFriends: true } : {}) }
}

export function createRoomMembership({ identity, room, roomKey, lan = false, now = Date.now }) {
    const access = authority(room, roomKey, identity.id, lan)
    const initial = { sequence: 0, devices: [] }
    const revocations = { ...initial, signature: identity.sign(access.revokeFields(initial)) }
    return restoreRoomMembership({ identity, room, roomKey, now, descriptor: {
        v: VERSION, owner: identity.id, lan, grant: null, admission: null, revocations, issued: [], records: []
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
    const effectiveRecord = id => current.records?.find(r => r.deviceId === id) ?? null
    const statusOf = id => {
        if (id === access.owner) return 'active'
        const rec = effectiveRecord(id)
        if (rec) return rec.status
        return current.revocations.devices.includes(id) ? 'banned' : 'active'
    }
    const banned = id => statusOf(id) === 'banned'
    const kicked = id => statusOf(id) === 'kicked'
    const revoked = id => banned(id) || kicked(id)
    const roleOf = id => id === access.owner ? 'owner' : (effectiveRecord(id)?.role ?? 'member')
    const isAdmin = (id = identity.id) => id !== access.owner && roleOf(id) === 'admin' && !revoked(id)
    const canManageMembers = () => owner || (admitted() && isAdmin())
    const admitted = () => !revoked(identity.id) && (owner || current.admission !== null)
    const selfCanHost = () => !revoked(identity.id) && (owner || (current.admission !== null &&
        (effectiveRecord(identity.id)?.canHost ?? current.grant.canHost)))

    if (revoked(identity.id)) throw new Error('This device has been removed from the room')
    let persist = null
    let changed = null
    let revocationsNeedSaving = false

    function update(next) {
        persist?.(structuredClone(next))
        current = next
        revocationsNeedSaving = false
        changed?.()
    }

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

    function mergeRoleRecords(candidates) {
        if (!Array.isArray(candidates) || candidates.length === 0) return { valid: true, updated: false }
        if (candidates.length > MAX_MEMBERS) return { valid: false, updated: false }
        const map = new Map((current.records ?? []).map(r => [r.deviceId, r]))
        let updated = false
        for (const raw of candidates) {
            const checked = inspectRoleRecord(access, raw)
            if (!checked) return { valid: false, updated: false }
            const existing = map.get(checked.deviceId)
            if (checked.issuer !== access.owner && existing?.role === 'admin') continue
            if (recordWins(access, checked, existing)) {
                map.set(checked.deviceId, checked)
                updated = true
            }
        }
        if (updated) current = { ...current, records: [...map.values()] }
        return { valid: true, updated }
    }

    function observeRoles(candidates) {
        if (candidates === undefined) return true
        const { valid, updated } = mergeRoleRecords(candidates)
        if (!valid) return false
        if (!updated) return true
        try { persistRevocations() }
        finally { changed?.() }
        return true
    }

    function ownAdminProof() {
        const rec = effectiveRecord(identity.id)
        if (!rec || rec.issuer !== access.owner || rec.role !== 'admin' || rec.status !== 'active') return null
        return structuredClone(rec)
    }

    function signRoleRecord({ deviceId, role, canHost, status, epoch, hidden = false }) {
        const issuerEpoch = owner ? 0 : ownAdminProof()?.epoch
        if (issuerEpoch === undefined || issuerEpoch === null) throw new Error('Only the room owner or an admin can manage members')
        const fields = { deviceId, role, canHost: canHost === true, status, epoch, issuer: identity.id, issuerEpoch, hidden: hidden === true }
        const signature = identity.sign(access.roleFields(fields))
        if (owner) return { ...fields, signature }
        return { ...fields, issuerProof: ownAdminProof(), signature }
    }

    function writeRoleRecord(deviceId, mutator) {
        if (!canManageMembers()) throw new Error('Only the room owner or an admin can manage members')
        if (!validDeviceId(deviceId) || deviceId === access.owner) throw new Error('Choose a different device ID')
        const existing = effectiveRecord(deviceId)
        const baseEpoch = existing?.epoch ?? 0
        const currentRole = existing?.role ?? 'member'
        if (!owner && (deviceId === identity.id && mutator.role !== undefined && mutator.role !== currentRole)) {
            throw new Error('Only the room owner can change admin roles')
        }
        if (!owner && currentRole === 'admin' && deviceId !== identity.id) {
            throw new Error('Only the room owner can manage admins')
        }
        const knownGrant = current.issued.find(g => g.deviceId === deviceId) ?? (current.grant?.deviceId === deviceId ? current.grant : null)
        const nextRole = mutator.role ?? currentRole
        if (!owner && nextRole === 'admin' && currentRole !== 'admin') {
            throw new Error('Only the room owner can promote an admin')
        }
        const nextCanHost = mutator.canHost ?? existing?.canHost ?? knownGrant?.canHost ?? false
        const nextStatus = mutator.status ?? statusOf(deviceId)
        const nextHidden = mutator.hidden ?? (nextStatus === 'active' || nextStatus === 'banned' ? false : (existing?.hidden ?? false))
        const next = signRoleRecord({
            deviceId,
            role: nextRole,
            canHost: nextCanHost,
            status: nextStatus,
            epoch: baseEpoch + 1,
            hidden: nextHidden
        })
        const nextRecords = [...(current.records ?? []).filter(r => r.deviceId !== deviceId), next]
        update({ ...current, records: nextRecords })
        return next
    }

    function setMemberRole(deviceId, role) {
        if (!owner) throw new Error('Only the room owner can change admin roles')
        if (!VALID_ROLES.has(role)) throw new Error('Invalid role')
        if (banned(deviceId)) throw new Error('Unban this device first')
        return writeRoleRecord(deviceId, { role })
    }

    function setMemberCanHost(deviceId, canHost) {
        if (!canManageMembers()) throw new Error('Only the room owner or an admin can change host access')
        if (banned(deviceId)) throw new Error('Unban this device first')
        if (!owner && roleOf(deviceId) === 'admin' && deviceId !== identity.id) {
            throw new Error('Only the room owner can manage admins')
        }
        return writeRoleRecord(deviceId, { canHost: canHost === true })
    }

    function kick(deviceId) {
        if (!canManageMembers()) throw new Error('Only the room owner or an admin can kick a device')
        if (!owner && roleOf(deviceId) === 'admin') throw new Error('Only the room owner can kick an admin')
        if (banned(deviceId)) return false
        if (kicked(deviceId) && effectiveRecord(deviceId)) return false
        writeRoleRecord(deviceId, { status: 'kicked', hidden: false })
        return true
    }

    function ban(deviceId) {
        if (!canManageMembers()) throw new Error('Only the room owner or an admin can ban a device')
        if (!owner && roleOf(deviceId) === 'admin') throw new Error('Only the room owner can ban an admin')
        if (banned(deviceId)) return false
        writeRoleRecord(deviceId, { role: 'member', status: 'banned', hidden: false })
        return true
    }

    function unban(deviceId) {
        if (!canManageMembers()) throw new Error('Only the room owner or an admin can unban a device')
        if (!banned(deviceId)) return false
        writeRoleRecord(deviceId, { role: 'member', status: 'kicked', hidden: false })
        return true
    }

    function forget(deviceId) {
        if (!canManageMembers()) throw new Error('Only the room owner or an admin can forget a device')
        if (!kicked(deviceId)) return false
        if (effectiveRecord(deviceId)?.hidden === true) return false
        writeRoleRecord(deviceId, { status: 'kicked', hidden: true })
        return true
    }

    function memberProof(nonce, sender, receiver) {
        return {
            deviceId: identity.id,
            grant: current.grant,
            admission: current.admission,
            revocations: current.revocations,
            roles: current.records ?? [],
            signature: identity.sign(access.proofFields(nonce, sender, receiver))
        }
    }

    function verifyMember(proof, nonce, sender, receiver) {
        if (!proof || !verified(proof.deviceId, access.proofFields(nonce, sender, receiver), proof.signature)) return null
        const isOwner = proof.deviceId === access.owner
        const grant = isOwner ? null : inspectGrant(access, proof.grant)
        if ((!isOwner && grant?.deviceId !== proof.deviceId) || !observe(proof.revocations) ||
            !observeRoles(proof.roles) || revoked(proof.deviceId) || revoked(identity.id)) return null
        const rec = isOwner ? null : effectiveRecord(proof.deviceId)
        if (!isOwner && rec && grant.epoch !== undefined && rec.epoch > grant.epoch && rec.status !== 'active') return null
        if (!isOwner && rec && grant.epoch === undefined && rec.status !== 'active') return null
        const hasAdmission = isOwner || verifyAdmission(access, grant, proof.admission)
        if (!hasAdmission && !canManageMembers()) return null
        return {
            deviceId: proof.deviceId,
            role: roleOf(proof.deviceId),
            canHost: isOwner || (rec?.canHost ?? grant.canHost),
            grant,
            hasAdmission
        }
    }

    function admit(member) {
        const targetId = member?.deviceId ?? member?.grant?.deviceId
        if (!canManageMembers() || !member?.grant || !validDeviceId(targetId) || banned(targetId)) {
            throw new Error('Membership is unavailable')
        }
        // L4: the first admission needs a grant with an expiry time that is not past.
        if (!validExpiry(member.grant.expires) || now() > member.grant.expires) throw new Error(INVITE_EXPIRED)
        const issued = current.issued.find(grant => grant.deviceId === targetId)
        const incomingEpoch = member.grant.epoch ?? 0
        const existingEpoch = issued?.epoch ?? 0
        if (issued && issued.signature !== member.grant.signature && incomingEpoch <= existingEpoch) {
            throw new Error('The device grant has changed')
        }
        let next = current
        if (!issued || issued.signature !== member.grant.signature) {
            if (!issued && next.issued.length >= MAX_MEMBERS) throw new Error('Room member limit reached')
            next = { ...next, issued: [...next.issued.filter(g => g.deviceId !== targetId), member.grant] }
        }
        const rec = effectiveRecord(targetId)
        if (rec && rec.status !== 'active') {
            if (member.grant.epoch === undefined || member.grant.epoch <= rec.epoch) throw new Error('Membership is unavailable')
            const activeRec = signRoleRecord({
                deviceId: targetId,
                role: rec.role,
                canHost: member.grant.canHost,
                status: 'active',
                epoch: Math.max(rec.epoch + 1, member.grant.epoch),
                hidden: false
            })
            next = { ...next, records: [...(next.records ?? []).filter(r => r.deviceId !== targetId), activeRec] }
        }
        if (next !== current) update(next)
        const sig = identity.sign(access.admissionFields(member.grant))
        return owner ? sig : { signature: sig, issuer: identity.id, issuerProof: ownAdminProof() }
    }

    function acceptAdmission(admission) {
        if (owner || revoked(identity.id) || !verifyAdmission(access, current.grant, admission)) return false
        if (!current.admission) update({ ...current, admission })
        return true
    }

    function issue(deviceId, canHost = false) {
        if (!canManageMembers() || !validDeviceId(deviceId) || deviceId === access.owner || deviceId === identity.id) {
            throw new Error('Choose a different device ID')
        }
        if (banned(deviceId)) throw new Error('This device is banned from the room')
        const rec = effectiveRecord(deviceId)
        if (!owner && rec?.role === 'admin') throw new Error('Only the room owner can manage admins')
        let grant = current.issued.find(value => value.deviceId === deviceId)
        const wasKicked = kicked(deviceId)
        const roleChanged = grant && grant.canHost !== (canHost === true)
        // L4: a grant with no expiry time or with a past expiry time gets a new grant. The new invite replaces the old one.
        const stale = grant && (!validExpiry(grant.expires) || now() > grant.expires)
        if (!grant || stale || wasKicked || roleChanged) {
            if (!grant && current.issued.length >= MAX_MEMBERS) throw new Error('Room member limit reached')
            const nextEpoch = rec ? rec.epoch + 1 : 1
            const useV4 = !owner || wasKicked || roleChanged || Boolean(rec)
            const fields = useV4
                ? { deviceId, canHost: canHost === true, expires: now() + INVITE_TTL_MS, epoch: nextEpoch, issuer: identity.id }
                : { deviceId, canHost: canHost === true, expires: now() + INVITE_TTL_MS }
            grant = { ...fields, signature: identity.sign(access.grantFields(fields)) }
            if (!owner) grant.issuerProof = ownAdminProof()
            let nextRecords = current.records ?? []
            if (wasKicked || roleChanged || rec) {
                const activeRec = signRoleRecord({
                    deviceId,
                    role: rec?.role ?? 'member',
                    canHost: canHost === true,
                    status: 'active',
                    epoch: nextEpoch,
                    hidden: false
                })
                nextRecords = [...nextRecords.filter(r => r.deviceId !== deviceId), activeRec]
            }
            update({ ...current, issued: [...current.issued.filter(value => value.deviceId !== deviceId), grant], records: nextRecords })
        }
        return { v: VERSION, owner: access.owner, lan: access.lan, grant: { ...grant }, admission: null,
            revocations: structuredClone(current.revocations),
            ...(grant.epoch !== undefined && (current.records?.length ?? 0) > 0 ? { records: structuredClone(current.records) } : {}) }
    }

    function revoke(deviceId) {
        if (!canManageMembers()) throw new Error('Only the room owner can remove a device')
        if (!knownMember(deviceId) || banned(deviceId)) return false
        if (owner && !current.revocations.devices.includes(deviceId)) {
            const nextRev = { sequence: current.revocations.sequence + 1, devices: [...current.revocations.devices, deviceId] }
            const revocations = { ...nextRev, signature: identity.sign(access.revokeFields(nextRev)) }
            const existing = effectiveRecord(deviceId)
            const nextRec = signRoleRecord({
                deviceId,
                role: 'member',
                canHost: existing?.canHost ?? false,
                status: 'banned',
                epoch: (existing?.epoch ?? 0) + 1,
                hidden: false
            })
            update({ ...current, revocations, records: [...(current.records ?? []).filter(r => r.deviceId !== deviceId), nextRec] })
            return true
        }
        return ban(deviceId)
    }

    function knownMember(deviceId) {
        return current.issued.some(g => g.deviceId === deviceId) ||
            (current.records ?? []).some(r => r.deviceId === deviceId) ||
            current.revocations.devices.includes(deviceId)
    }

    // G6: owner or active admin signs the voice channel catalog. The caller checks the structure (voice-channels.mjs).
    function signVoiceChannels({ seq, channels } = {}) {
        if (!canManageMembers()) throw new Error('Only the room owner can change voice channels.')
        if (!Number.isSafeInteger(seq) || !Array.isArray(channels)) throw new Error('Invalid voice channel catalog')
        const signature = identity.sign(access.voiceChannelFields({ seq, channels }))
        if (owner) return signature
        return { signature, issuer: identity.id, issuerProof: ownAdminProof() }
    }

    function verifyVoiceChannels(catalog) {
        if (!catalog || !Number.isSafeInteger(catalog.seq) || !Array.isArray(catalog.channels) ||
            !catalog.channels.every(row => row && typeof row === 'object')) return false
        if (typeof catalog.issuer === 'string' && catalog.issuer !== access.owner) {
            const proof = inspectRoleRecord(access, catalog.issuerProof)
            if (!proof || proof.issuer !== access.owner || proof.deviceId !== catalog.issuer ||
                proof.role !== 'admin' || proof.status !== 'active') return false
            if (revoked(catalog.issuer)) return false
            return verified(catalog.issuer, access.voiceChannelFields(catalog), catalog.signature)
        }
        return verified(access.owner, access.voiceChannelFields(catalog), catalog.signature)
    }

    // easy-join part 2: the room code of the owner. renew: "New room code" (the old code stops working). A code that
    // expired also gets a new ID. Returns { id, expires }.
    function roomCode({ renew = false } = {}) {
        if (!owner) throw new Error('Only the room owner can make a room code.')
        const old = current.roomCode
        if (!renew && old && now() <= old.expires && old.signature) return { ...old }
        const id = !renew && old && now() <= old.expires ? old.id : randomBytes(16).toString('base64url')
        const expires = !renew && old && now() <= old.expires ? old.expires : now() + INVITE_TTL_MS
        const next = { id, expires, signature: identity.sign(access.roomCodeStateFields(id, expires)) }
        update({ ...current, roomCode: next })
        return { ...next }
    }
    function roomCodeState() {
        const rc = current.roomCode
        return rc?.signature ? { ...rc } : null
    }
    function observeRoomCode(candidate) {
        if (!candidate) return true
        let checked
        try { checked = inspectRoomCode(candidate, access) } catch { return false }
        if (!checked?.signature) return false
        if (current.roomCode?.id === checked.id && current.roomCode?.expires === checked.expires &&
            current.roomCode?.signature === checked.signature) return true
        current = { ...current, roomCode: checked }
        try { persistRevocations() }
        finally { changed?.() }
        return true
    }
    // 'ok', 'old-code' (not the current code ID) or 'expired'. The owner clock decides the expiry.
    function checkRoomCode(codeId) {
        if (!canManageMembers() || !current.roomCode || codeId !== current.roomCode.id) return 'old-code'
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
    function knockResponderProof(codeId, nonce) {
        if (!canManageMembers()) throw new Error('Only the room owner or an admin can answer a knock.')
        const signature = identity.sign(access.knockOwnerFields(codeId, nonce))
        if (owner) return signature
        return { signature, issuer: identity.id, issuerProof: ownAdminProof() }
    }
    const verifyKnock = (deviceId, codeId, nonce, signature) => verified(deviceId, access.knockFields(codeId, nonce), signature)
    // easy-join part 3: "Always allow my friends" (owner only, off by default). The saved room keeps it.
    const autoAllowFriends = () => owner && current.autoAllowFriends === true
    function setAutoAllowFriends(on) {
        if (!owner) throw new Error('Only the room owner can change this setting.')
        if ((on === true) === autoAllowFriends()) return autoAllowFriends()
        const next = { ...current }
        if (on === true) next.autoAllowFriends = true
        else delete next.autoAllowFriends
        update(next)
        return autoAllowFriends()
    }

    function listMembers() {
        const byId = new Map()
        for (const grant of current.issued) {
            byId.set(grant.deviceId, { deviceId: grant.deviceId, canHost: grant.canHost })
        }
        for (const rec of current.records ?? []) {
            byId.set(rec.deviceId, { deviceId: rec.deviceId, canHost: rec.canHost })
        }
        for (const id of current.revocations.devices) {
            if (!byId.has(id)) byId.set(id, { deviceId: id, canHost: false })
        }
        const out = []
        for (const entry of byId.values()) {
            const rec = effectiveRecord(entry.deviceId)
            const status = statusOf(entry.deviceId)
            const hidden = status === 'kicked' && rec?.hidden === true
            out.push({
                deviceId: entry.deviceId,
                role: roleOf(entry.deviceId),
                canHost: rec ? rec.canHost : entry.canHost,
                status,
                hidden,
                revoked: status !== 'active',
                banned: status === 'banned',
                kicked: status === 'kicked'
            })
        }
        return out
    }

    return Object.freeze({ id: identity.id, owner, ownerId: access.owner, lan: access.lan, roomId: access.id,
        hostGrant: owner || (effectiveRecord(identity.id)?.canHost ?? current.grant.canHost),
        role: () => roleOf(identity.id),
        roleOf,
        isAdmin,
        canManageMembers,
        admitted,
        canHost: selfCanHost,
        snapshot: () => structuredClone(current),
        revocations: () => structuredClone(current.revocations),
        roleRecords: () => structuredClone(current.records ?? []),
        issued: listMembers,
        banned, kicked, revoked,
        memberProof, verifyMember, observe, observeRoles, admit, acceptAdmission,
        issue, revoke, setMemberRole, setMemberCanHost, kick, ban, unban, forget,
        signVoiceChannels, verifyVoiceChannels,
        roomCode, roomCodeState, observeRoomCode, checkRoomCode, signRoomCode, knockOwnerProof, knockResponderProof,
        verifyKnock, autoAllowFriends, setAutoAllowFriends,
        setPersistence(callback) { persist = callback },
        onChanged(callback) { changed = callback }
    })
}
