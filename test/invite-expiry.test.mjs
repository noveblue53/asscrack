// L4 (P10a): an asscrack3 invite holds a grant for one device. The grant did not expire. An unused grant stayed valid
// until the owner removed the device. The fix: a signed expiry time in each new grant (7 days). The owner refuses an
// expired grant, and a grant with no expiry, at the first admission. Results of this file are results of this PC
// (module level) and 127.0.0.1 results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import * as membershipModule from '../src/network/room-membership.mjs'
import { makeMemberInvite, newRoomKey, readInvite } from '../src/network/invite.mjs'
import { loginErrorText } from '../src/application/login-errors.mjs'
import { createAsscrackNode } from '../src/network/node.mjs'

const { createDeviceIdentity, createRoomMembership, restoreRoomMembership } = membershipModule
const DAY = 24 * 60 * 60 * 1000
const EXPIRED = 'This invite has expired. Ask the room owner for a new invite.'

test('L4: the owner refuses an expired grant at the first admission; a new invite of the same device works', () => {
    let clock = Date.UTC(2026, 10, 22)
    const room = 'L4 room', roomKey = newRoomKey()
    const owner = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, now: () => clock })
    const device = createDeviceIdentity()
    const first = owner.issue(device.id, false)
    assert.equal(first.grant.expires, clock + 7 * DAY, 'the grant has an expiry time of 7 days')
    clock += 7 * DAY + 1
    assert.throws(() => owner.admit({ deviceId: device.id, grant: first.grant }), { message: EXPIRED })
    // A new invite for the same device: a new grant with a new expiry time. The old grant stays refused.
    const second = owner.issue(device.id, false)
    assert.notEqual(second.grant.signature, first.grant.signature)
    assert.equal(second.grant.expires, clock + 7 * DAY)
    assert.equal(typeof owner.admit({ deviceId: device.id, grant: second.grant }), 'string')
    clock += 30 * DAY
    assert.throws(() => owner.admit({ deviceId: device.id, grant: first.grant }), { message: EXPIRED })
})

// An old grant: the fields of version 2, with no expiry time. The test signs it with the owner identity.
function oldGrant(ownerIdentity, room, roomKey, deviceId) {
    const id = createHash('sha256').update(JSON.stringify(['asscrack-room-membership/2', room, roomKey, ownerIdentity.id, false])).digest('base64url')
    const grant = { deviceId, canHost: false, signature: ownerIdentity.sign(['asscrack-room-grant/2', id, deviceId, false]) }
    return { grant, admission: ownerIdentity.sign(['asscrack-room-admission/2', id, grant.signature]) }
}

test('L4: a grant with no expiry time is refused at the first admission; an admitted device with such a grant keeps access', () => {
    const room = 'L4 old room', roomKey = newRoomKey()
    const ownerIdentity = createDeviceIdentity()
    const owner = createRoomMembership({ identity: ownerIdentity, room, roomKey })
    const unused = createDeviceIdentity()
    const { grant } = oldGrant(ownerIdentity, room, roomKey, unused.id)
    assert.throws(() => owner.admit({ deviceId: unused.id, grant }), { message: EXPIRED })
    // A saved room of an admitted member with an old grant: its proof is still valid.
    const member = createDeviceIdentity()
    const old = oldGrant(ownerIdentity, room, roomKey, member.id)
    const descriptor = { v: 2, owner: ownerIdentity.id, lan: false, grant: old.grant, admission: old.admission,
        revocations: owner.snapshot().revocations }
    const saved = restoreRoomMembership({ identity: member, room, roomKey, descriptor })
    assert.equal(saved.admitted(), true)
    const proof = saved.memberProof('nonce-1234567890abcdef', 'sender', 'receiver')
    const checked = owner.verifyMember(proof, 'nonce-1234567890abcdef', 'sender', 'receiver')
    assert.equal(checked?.hasAdmission, true)
})

test('L4: the asscrack3 code carries the expiry time; a code that expired more than 1 hour ago gives the expired text', () => {
    let clock = Date.now()
    const room = 'L4 code room', roomKey = newRoomKey()
    const owner = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, now: () => clock })
    const nodes = [{ id: '12D3KooWGpponMzJoSX1usSBzTdUmp9iaNvRFkvtJh75io6goVuA', addrs: ['/ip4/203.0.113.5/tcp/47000'] }]
    const fresh = owner.issue(createDeviceIdentity().id, false)
    const code = makeMemberInvite({ room, key: roomKey, nodes, membership: fresh })
    assert.equal(readInvite(code).membership.grant.expires, fresh.grant.expires)
    clock -= 7 * DAY + 2 * 60 * 60 * 1000
    const old = owner.issue(createDeviceIdentity().id, false)
    const oldCode = makeMemberInvite({ room, key: roomKey, nodes, membership: old })
    let err = null
    try { readInvite(oldCode) } catch (e) { err = e }
    assert.ok(err, 'an expired code is refused')
    assert.equal(loginErrorText(err), EXPIRED)
})

test('L4: 127.0.0.1: the owner node does not admit a device with an expired invite', { timeout: 20000 }, async t => {
    let clock = Date.now()
    const room = 'L4 node room', roomKey = newRoomKey()
    const fast = { room, roomKey, discovery: false, listen: ['/ip4/127.0.0.1/tcp/0'], fullNode: false, heartbeatInterval: 100, hostTimeout: 700, electionDelay: 300 }
    const ownerMembership = createRoomMembership({ identity: createDeviceIdentity(), room, roomKey, lan: true, now: () => clock })
    const O = await createAsscrackNode({ ...fast, membership: ownerMembership })
    t.after(() => O.stop())
    const identity = createDeviceIdentity()
    const invite = readInvite(O.createMemberInvite(identity.id))
    // Eight days later on the clock of the owner. The member reads the code before the expiry.
    clock += 8 * DAY
    const M = await createAsscrackNode({ ...fast, membership: restoreRoomMembership({ identity, room, roomKey, descriptor: invite.membership }) })
    t.after(() => M.stop())
    await M.connect(O.getMultiaddrs().find(a => a.startsWith('/ip4/127.0.0.1/'))).catch(() => {})
    await delay(1500)
    assert.equal(M.memberState().admitted, false)
    assert.ok(!O.peers().includes(M.peerId))
})
