import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createDeviceIdentity,
    createRoomMembership,
    restoreRoomMembership,
    roomCodeAccess
} from '../src/network/room-membership.mjs'
import { checkAllowedInvite, createKnockDesk, createKnocker } from '../src/network/knock.mjs'
import { makeMemberInvite, makeRoomCode, newRoomKey, readRoomCode } from '../src/network/invite.mjs'

function pairChannels(desk, knocker) {
    const a = {
        send: msg => { queueMicrotask(() => knockerReceive(msg)); return true },
        end: () => {}
    }
    let deskHandler
    function knockerReceive(msg) {
        const step = knocker.receive(msg)
        if (step.send) queueMicrotask(() => deskHandler.receive(step.send))
        if (step.done) onDone(step.done)
    }
    let onDone
    const donePromise = new Promise(resolve => { onDone = resolve })
    deskHandler = desk.open(a, { source: 'test-peer', via: 'test' })
    return { start: () => deskHandler.receive(knocker.hello()), donePromise }
}

test('Offline Admin can approve room-code knock with canHost=true and knocker verifies delegation chain', async () => {
    const ownerId = createDeviceIdentity()
    const adminId = createDeviceIdentity()
    const joinerId = createDeviceIdentity()
    const room = 'admin-knock-room'
    const roomKey = newRoomKey()

    const owner = createRoomMembership({ identity: ownerId, room, roomKey, lan: true })
    const adminInvite = owner.issue(adminId.id, false)
    const admin = restoreRoomMembership({ identity: adminId, room, roomKey, descriptor: adminInvite })
    admin.acceptAdmission(owner.admit(adminInvite))
    owner.setMemberRole(adminId.id, 'admin')
    admin.observeRoles(owner.roleRecords())

    const OWNER_PEER = '12D3KooWDpRY63jmCU4sRLm8eVrZ6jY2sKZaLnCxLBEa4fZHBPht'
    const { id: codeId, expires } = owner.roomCode()
    assert.equal(admin.observeRoomCode(owner.roomCodeState()), true)
    const codeText = makeRoomCode({ room, key: roomKey, owner: ownerId.id, lan: true, codeId, expires, ownerPeer: OWNER_PEER, nodes: [] },
        hash => owner.signRoomCode(hash))
    const code = readRoomCode(codeText)
    const access = roomCodeAccess(code.room, code.key, code.owner, code.lan)

    const desk = createKnockDesk({
        membership: admin,
        makeInvite: (deviceId, { canHost = false } = {}) => makeMemberInvite({
            room, key: roomKey, nodes: [], membership: admin.issue(deviceId, canHost)
        }),
        changed: ({ added }) => {
            if (added) desk.answer(added.id, true, { canHost: true })
        }
    })
    const knocker = createKnocker({ code, access, identity: joinerId, name: 'Joiner' })
    const { start, donePromise } = pairChannels(desk, knocker)
    start()
    const outcome = await donePromise
    assert.equal(outcome.result, 'allowed')
    const parsed = checkAllowedInvite(code, joinerId, outcome.invite)
    assert.equal(parsed.membership.grant.canHost, true)
    assert.equal(parsed.membership.grant.issuer, adminId.id)
})

test('Banned device is refused on knock, and can re-knock after Unban', async () => {
    const ownerId = createDeviceIdentity()
    const adminId = createDeviceIdentity()
    const joinerId = createDeviceIdentity()
    const room = 'ban-unban-knock'
    const roomKey = newRoomKey()

    const owner = createRoomMembership({ identity: ownerId, room, roomKey, lan: true })
    const adminInvite = owner.issue(adminId.id, false)
    const admin = restoreRoomMembership({ identity: adminId, room, roomKey, descriptor: adminInvite })
    admin.acceptAdmission(owner.admit(adminInvite))
    owner.setMemberRole(adminId.id, 'admin')
    admin.observeRoles(owner.roleRecords())

    const OWNER_PEER = '12D3KooWDpRY63jmCU4sRLm8eVrZ6jY2sKZaLnCxLBEa4fZHBPht'
    const { id: codeId, expires } = owner.roomCode()
    admin.observeRoomCode(owner.roomCodeState())
    const code = readRoomCode(makeRoomCode({ room, key: roomKey, owner: ownerId.id, lan: true, codeId, expires, ownerPeer: OWNER_PEER, nodes: [] },
        hash => owner.signRoomCode(hash)))
    const access = roomCodeAccess(code.room, code.key, code.owner, code.lan)

    // Ban joinerId before knock.
    const jInv = admin.issue(joinerId.id, false)
    admin.admit(jInv)
    assert.equal(admin.ban(joinerId.id), true)

    const desk = createKnockDesk({
        membership: admin,
        makeInvite: (deviceId, { canHost = false } = {}) => makeMemberInvite({
            room, key: roomKey, nodes: [], membership: admin.issue(deviceId, canHost)
        }),
        changed: ({ added }) => {
            if (added) desk.answer(added.id, true, { canHost: false })
        }
    })

    const k1 = createKnocker({ code, access, identity: joinerId, name: 'Joiner' })
    const p1 = pairChannels(desk, k1)
    p1.start()
    const res1 = await p1.donePromise
    assert.equal(res1.result, 'refused')
    assert.equal(res1.reason, 'removed')

    // Unban and knock again -> allowed.
    assert.equal(admin.unban(joinerId.id), true)
    const k2 = createKnocker({ code, access, identity: joinerId, name: 'Joiner' })
    const p2 = pairChannels(desk, k2)
    p2.start()
    const res2 = await p2.donePromise
    assert.equal(res2.result, 'allowed')
})
