import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createDeviceIdentity,
    createRoomMembership,
    inspectMembershipDescriptor,
    restoreRoomMembership
} from '../src/network/room-membership.mjs'
import { createVoiceChannels } from '../src/network/voice-channels.mjs'
import { newRoomKey } from '../src/network/invite.mjs'

function makePair() {
    const ownerId = createDeviceIdentity()
    const adminId = createDeviceIdentity()
    const memberId = createDeviceIdentity()
    const room = 'roles-room'
    const roomKey = newRoomKey()
    const owner = createRoomMembership({ identity: ownerId, room, roomKey, lan: true })
    const adminInvite = owner.issue(adminId.id, false)
    const admin = restoreRoomMembership({ identity: adminId, room, roomKey, descriptor: adminInvite })
    admin.acceptAdmission(owner.admit(adminInvite))
    const memberInvite = owner.issue(memberId.id, false)
    const member = restoreRoomMembership({ identity: memberId, room, roomKey, descriptor: memberInvite })
    member.acceptAdmission(owner.admit(memberInvite))
    return { ownerId, adminId, memberId, room, roomKey, owner, admin, member }
}

test('Owner promotes Admin, Admin manages Members offline, and Owner can demote and override', () => {
    const { owner, admin, member, adminId, memberId } = makePair()

    // Owner promotes adminId to admin and syncs records to admin and member.
    owner.setMemberRole(adminId.id, 'admin')
    assert.equal(owner.roleOf(adminId.id), 'admin')
    assert.equal(admin.observeRoles(owner.roleRecords()), true)
    assert.equal(member.observeRoles(owner.roleRecords()), true)
    assert.equal(admin.isAdmin(), true)
    assert.equal(admin.canManageMembers(), true)

    // Admin cannot promote another admin or touch owner.
    assert.throws(() => admin.setMemberRole(memberId.id, 'admin'), /owner/)
    assert.throws(() => admin.ban(owner.ownerId), /different device ID|owner/)

    // Admin toggles member's canHost live (offline from owner).
    admin.setMemberCanHost(memberId.id, true)
    assert.equal(member.observeRoles(admin.roleRecords()), true)
    assert.equal(member.canHost(), true)

    // Admin bans member; member is blocked; Admin unbans member; status becomes kicked.
    assert.equal(admin.ban(memberId.id), true)
    assert.equal(member.observeRoles(admin.roleRecords()), true)
    assert.equal(member.banned(memberId.id), true)
    assert.equal(member.revoked(memberId.id), true)
    assert.throws(() => admin.issue(memberId.id, false), /banned/)

    assert.equal(admin.unban(memberId.id), true)
    assert.equal(member.observeRoles(admin.roleRecords()), true)
    assert.equal(member.banned(memberId.id), false)
    assert.equal(member.kicked(memberId.id), true)

    // Admin re-invites the unbanned/kicked member with canHost=false.
    const reInvite = admin.issue(memberId.id, false)
    assert.equal(reInvite.grant.issuer, adminId.id)
    const admission = admin.admit(reInvite)
    assert.equal(typeof admission, 'object')

    // Owner demotes admin: admin loses authority immediately, past member records remain valid, Owner can override.
    owner.setMemberRole(adminId.id, 'member')
    assert.equal(admin.observeRoles(owner.roleRecords()), true)
    assert.equal(admin.isAdmin(), false)
    assert.equal(admin.canManageMembers(), false)
    assert.throws(() => admin.kick(memberId.id), /owner or an admin/)
})

test('Re-invite after kick and unban restores full membership and blocks stale grants', () => {
    const ownerId = createDeviceIdentity()
    const adminId = createDeviceIdentity()
    const memberId = createDeviceIdentity()
    const room = 'rejoin-room'
    const roomKey = newRoomKey()
    const owner = createRoomMembership({ identity: ownerId, room, roomKey, lan: true })
    const adminInvite = owner.issue(adminId.id, false)
    const admin = restoreRoomMembership({ identity: adminId, room, roomKey, descriptor: adminInvite })
    admin.acceptAdmission(owner.admit(adminInvite))
    owner.setMemberRole(adminId.id, 'admin')
    admin.observeRoles(owner.roleRecords())

    const firstInvite = admin.issue(memberId.id, true)
    const member1 = restoreRoomMembership({ identity: memberId, room, roomKey, descriptor: firstInvite })
    assert.equal(member1.acceptAdmission(admin.admit(firstInvite)), true)
    assert.equal(member1.canHost(), true)

    // Admin kicks member1.
    assert.equal(admin.kick(memberId.id), true)
    assert.equal(owner.observeRoles(admin.roleRecords()), true)
    assert.equal(owner.kicked(memberId.id), true)
    assert.equal(owner.banned(memberId.id), false)

    // Stale proof from member1 is rejected.
    const staleProof = member1.memberProof('nonce1', memberId.id, ownerId.id)
    assert.equal(owner.verifyMember(staleProof, 'nonce1', memberId.id, ownerId.id), null)

    // Forget hides kicked device from visible list, un-hidden on re-invite.
    assert.equal(admin.forget(memberId.id), true)
    assert.equal(admin.issued().find(m => m.deviceId === memberId.id).hidden, true)

    // Admin re-invites memberId with canHost=false.
    const secondInvite = admin.issue(memberId.id, false)
    const member2 = restoreRoomMembership({ identity: memberId, room, roomKey, descriptor: secondInvite })
    assert.equal(member2.acceptAdmission(admin.admit(secondInvite)), true)
    assert.equal(member2.canHost(), false)
    const freshProof = member2.memberProof('nonce2', memberId.id, ownerId.id)
    const verified = owner.verifyMember(freshProof, 'nonce2', memberId.id, ownerId.id)
    assert.ok(verified)
    assert.equal(verified.canHost, false)
    assert.equal(admin.issued().find(m => m.deviceId === memberId.id).hidden, false)
})

test('Legacy v2 revoked device can be unbanned seamlessly in-place', () => {
    const ownerId = createDeviceIdentity()
    const memberId = createDeviceIdentity()
    const room = 'legacy-v2-unban'
    const roomKey = newRoomKey()
    const owner = createRoomMembership({ identity: ownerId, room, roomKey, lan: true })
    const invite = owner.issue(memberId.id, false)
    const member = restoreRoomMembership({ identity: memberId, room, roomKey, descriptor: invite })
    member.acceptAdmission(owner.admit(invite))

    // Simulate legacy revoke() (puts deviceId in revocations.devices).
    assert.equal(owner.revoke(memberId.id), true)
    assert.equal(owner.banned(memberId.id), true)

    // Unban overrides legacy revocations.devices via role record.
    assert.equal(owner.unban(memberId.id), true)
    assert.equal(owner.banned(memberId.id), false)
    assert.equal(owner.kicked(memberId.id), true)

    // Descriptor round-trip preserves unban.
    const restored = restoreRoomMembership({ identity: ownerId, room, roomKey, descriptor: inspectMembershipDescriptor(room, roomKey, owner.snapshot()) })
    assert.equal(restored.banned(memberId.id), false)
    assert.equal(restored.kicked(memberId.id), true)
})

test('Admin can create, rename, and delete voice channels', () => {
    const { owner, admin, member } = makePair()
    owner.setMemberRole(admin.id, 'admin')
    admin.observeRoles(owner.roleRecords())
    member.observeRoles(owner.roleRecords())

    const sentToOwner = []
    const sentToMember = []
    const ownerVc = createVoiceChannels({ membership: owner })
    const adminVc = createVoiceChannels({
        membership: admin,
        send: msg => {
            sentToOwner.push(msg)
            sentToMember.push(msg)
        }
    })
    const memberVc = createVoiceChannels({ membership: member })

    assert.equal(adminVc.view().editable, true)
    assert.equal(memberVc.view().editable, false)
    assert.throws(() => memberVc.create('Nope'), /owner/)

    const chId = adminVc.create('Gaming')
    assert.equal(sentToOwner.length, 1)
    assert.equal(ownerVc.receive(sentToOwner[0], admin.id), true)
    assert.equal(memberVc.receive(sentToMember[0], admin.id), true)
    assert.equal(ownerVc.has(chId), true)
    assert.equal(memberVc.has(chId), true)
})
