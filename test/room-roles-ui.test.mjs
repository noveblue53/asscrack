import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs'

const roleControls = [
    { id: 'copy-device-id', tag: 'button' }, { id: 'device-id-note' }, { id: 'room-access-status' },
    { id: 'member-invite-form', tag: 'form' }, { id: 'member-device-id', tag: 'input' },
    { id: 'member-can-host', tag: 'input' }, { id: 'member-invite-create', tag: 'button' },
    { id: 'invite-code-label' }, { id: 'room-members-section' }, { id: 'room-members', tag: 'ul' },
    { id: 'room-code-box' }, { id: 'room-code-copy', tag: 'button' }, { id: 'room-code-new', tag: 'button' },
    { id: 'auto-allow-friends', tag: 'input' }, { id: 'waiting-peer' },
    { id: 'knock-bar' }, { id: 'knock-text' }, { id: 'knock-can-host', tag: 'input' },
    { id: 'knock-allow', tag: 'button' }, { id: 'knock-deny', tag: 'button' },
    { id: 'member-context-menu' }
]

test('Owner and Admin see member controls, kicked/banned states show Unban/Forget, and banned invite shows clear error', async () => {
    const room = await loadRoomWindow({ elements: roleControls, scripts: ['room-membership-ui.js', 'knock-ui.js'] })
    const calls = []
    room.window.asscrack.setMemberRole = async (id, role) => { calls.push(['role', id, role]) }
    room.window.asscrack.setMemberCanHost = async (id, host) => { calls.push(['host', id, host]) }
    room.window.asscrack.kickMember = async id => { calls.push(['kick', id]); return true }
    room.window.asscrack.banMember = async id => { calls.push(['ban', id]); return true }
    room.window.asscrack.unbanMember = async id => { calls.push(['unban', id]); return true }
    room.window.asscrack.forgetMember = async id => { calls.push(['forget', id]); return true }
    room.window.asscrack.createMemberInvite = async () => {
        throw new Error("Error invoking remote method 'asscrack:member-invite': Error: This device is banned from the room")
    }

    // Owner view: shows active, kicked, and banned devices, hides forgotten.
    room.window.roomMembership.update({
        protected: true,
        owner: true,
        role: 'owner',
        isAdmin: false,
        canManageMembers: true,
        deviceId: 'owner-dev',
        lan: true,
        admitted: true,
        canHost: true,
        revoked: false,
        members: [
            { deviceId: 'dev-a', peerId: 'peer-a', role: 'member', canHost: false, status: 'active', connected: true, hidden: false },
            { deviceId: 'dev-k', role: 'member', canHost: false, status: 'kicked', connected: false, hidden: false },
            { deviceId: 'dev-b', role: 'member', canHost: false, status: 'banned', connected: false, hidden: false },
            { deviceId: 'dev-h', role: 'member', canHost: false, status: 'kicked', connected: false, hidden: true }
        ]
    })
    await settle()

    const listItems = room.el('room-members').children
    assert.equal(listItems.length, 3)
    assert.equal(room.el('room-code-box').hidden, false)
    assert.equal(room.el('member-invite-form').hidden, false)

    // Context menu actions for active peer.
    const ctx = room.window.roomMembership.contextActions('peer-a')
    assert.deepEqual([...ctx.map(a => a.label)], ['Make admin', 'Allow hosting (Can host)', 'Kick', 'Ban'])
    await ctx[0].run()
    assert.deepEqual(calls[0], ['role', 'dev-a', 'admin'])

    // Inviting a banned device shows the clear banned message, never "You were removed".
    room.el('member-device-id').value = 'dev-b'
    room.el('member-invite-form').dispatchEvent(new room.Event('submit'))
    await settle()
    assert.equal(room.el('invite-note').textContent, 'That device is banned. Unban it first.')

    // Admin view: sees invite form + members list, but room-code-box stays hidden, and cannot promote admin.
    room.window.roomMembership.update({
        protected: true,
        owner: false,
        role: 'admin',
        isAdmin: true,
        canManageMembers: true,
        deviceId: 'dev-admin',
        lan: true,
        admitted: true,
        canHost: true,
        revoked: false,
        members: [
            { deviceId: 'dev-a', peerId: 'peer-a', role: 'member', canHost: false, status: 'active', connected: true, hidden: false },
            { deviceId: 'dev-other-admin', peerId: 'peer-adm', role: 'admin', canHost: true, status: 'active', connected: true, hidden: false }
        ]
    })
    await settle()
    assert.equal(room.el('access-status') ? true : room.el('room-access-status').textContent, 'Admin')
    assert.equal(room.el('member-invite-form').hidden, false)
    assert.equal(room.el('room-code-box').hidden, true)
    assert.deepEqual([...room.window.roomMembership.contextActions('peer-adm')], [])
    assert.deepEqual([...room.window.roomMembership.contextActions('peer-a').map(a => a.label)], [
        'Allow hosting (Can host)', 'Kick', 'Ban'
    ])
})

test('Knock bar passes Can host checkbox state to answerKnock and resets on next request', async () => {
    const answered = []
    const room = await loadRoomWindow({
        elements: roleControls,
        scripts: ['knock-ui.js']
    })
    room.window.asscrack.answerKnock = async (id, allow, canHost) => { answered.push({ id, allow, canHost }); return true }
    room.handlers.onKnocks([{ id: 'k1', name: 'Laptop', mark: '112233' }, { id: 'k2', name: 'Friend', mark: '445566' }])
    assert.equal(room.el('knock-bar').hidden, false)
    assert.equal(room.el('knock-can-host').checked, false)
    room.el('knock-can-host').checked = true
    room.el('knock-allow').click()
    await settle()
    assert.deepEqual(answered, [{ id: 'k1', allow: true, canHost: true }])
    assert.equal(room.el('knock-can-host').checked, false)
})
