import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createDeviceIdentity, createRoomMembership, restoreRoomMembership } from '../src/network/room-membership.mjs'

test('a learned revocation denies immediately and its latest state is saved on retry', () => {
    const room = 'Membership persistence'
    const roomKey = randomBytes(32)
    const owner = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey })
    const identity = createDeviceIdentity()
    const member = restoreRoomMembership({ identity, room, roomKey, descriptor: owner.issue(identity.id, true) })
    const nonce = randomBytes(16).toString('base64url')
    const proof = member.memberProof(nonce, 'member-peer', 'owner-peer')
    assert.equal(member.acceptAdmission(owner.admit(owner.verifyMember(proof, nonce, 'member-peer', 'owner-peer'))), true)
    assert.equal(member.canHost(), true)

    const older = member.revocations()
    let allowedAfterChange
    member.onChanged(() => { allowedAfterChange = member.admitted() })
    member.setPersistence(() => { throw new Error('Disk full') })
    assert.equal(owner.revoke(identity.id), true)
    const revoked = owner.revocations()

    assert.throws(() => member.observe(revoked), { code: 'ROOM_REVOCATION_PERSIST_FAILED' })
    assert.equal(allowedAfterChange, false)
    assert.equal(member.admitted(), false)
    assert.equal(member.canHost(), false)
    assert.deepEqual(member.revocations(), revoked)

    let stored
    member.setPersistence(snapshot => { stored = snapshot })
    assert.equal(member.observe(older), true)
    assert.deepEqual(stored.revocations, revoked)
    assert.equal(member.admitted(), false)
    assert.throws(() => restoreRoomMembership({ identity, room, roomKey, descriptor: stored }), /removed from the room/)
})
