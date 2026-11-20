// Rehearse upgrade of a real 0.7.0 profile. The workflow prepares the isolated
// legacy executable from the earlier source using the matching Windows runtime.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { cp, mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const legacySource = '8dacddd';
const legacyFlags = ['--full-node', 'off'];
const hostFlags = ['--allow-private-full-node', '--full-node', 'on'];

async function send(page, text) {
    await page.locator('#message-input').fill(text);
    await page.locator('#message-input').press('Enter');
}

async function savedRoom(page, name, user) {
    await page.waitForFunction(async ({ name, user }) => {
        const archive = await window.asscrack.listSavedRooms();
        return archive.state === 'open' && archive.rooms.some(room => room.name === name && room.userName === user);
    }, { name, user });
    const rooms = await page.evaluate(async () => (await window.asscrack.listSavedRooms()).rooms);
    const room = rooms.find(item => item.name === name && item.userName === user);
    assert.equal(room.keepHistory, true, 'Keep local history must be enabled');
    return room;
}

async function reopen(page, roomName) {
    await page.locator('.saved-room').filter({ has: page.getByText(roomName, { exact: true }) })
        .getByRole('button', { name: 'Reopen room', exact: true }).click();
    await page.locator('#chat-screen').waitFor();
}

async function countPeers(page, expected) {
    await page.waitForFunction(n => document.getElementById('peer-count').textContent === String(n), expected,
        { timeout: 45_000, polling: 150 });
}

async function useNoiseSuppression(page, choice) {
    await page.locator('#voice-settings-toggle').click();
    if (choice) {
        await page.locator('#vs-ns').selectOption(choice);
        await page.waitForFunction(async value => (await window.asscrack.getVoiceSettings()).noiseSuppression === value, choice);
    }
    const value = await page.locator('#vs-ns').inputValue();
    await page.locator('#vs-close').click();
    return value;
}

async function messageIds(page, lines) {
    await page.waitForFunction(texts => texts.every(text => [...document.querySelectorAll('#messages li[data-id]')]
        .some(row => row.querySelector('.text')?.textContent === text)), lines);
    const ids = await page.locator('#messages li[data-id]').evaluateAll((rows, texts) => texts.map(text =>
        rows.filter(row => row.querySelector('.text')?.textContent === text).map(row => row.dataset.id)), lines);
    assert.deepEqual(ids.map(matches => matches.length), lines.map(() => 1), 'Each public fixture must occur exactly once');
    return ids.map(matches => matches[0]);
}

async function archiveDigests(profile) {
    const files = ['Local State', 'saved-rooms/archive.db', 'saved-rooms/archive.key', 'voice-settings.json'];
    return Promise.all(files.map(async name => createHash('sha256').update(await readFile(path.join(profile, name))).digest('hex')));
}

async function selectChannel(page, name) {
    const choice = page.locator('#channel-select option').filter({ hasText: `#${name}` }).first();
    await choice.waitFor({ state: 'attached' });
    await page.locator('#channel-select').selectOption(await choice.getAttribute('value'));
}

async function verifyLegacyUpgrade({ launch, quit, login, showInvite, waitForMessage, unusedLoopbackPort,
    legacyExecutable, legacyAppDirectory, evidenceDir }) {
    assert.ok(legacyExecutable && path.isAbsolute(legacyExecutable), 'An isolated legacy executable is required');
    const roomName = 'Windows 0.7.0 profile upgrade';
    const hostName = 'Upgrade companion';
    const guestName = 'Returning 0.7.0 friend';
    const oldReceived = 'General message received by the 0.7.0 profile';
    const oldSent = 'General message sent from the 0.7.0 profile';
    const oldLines = [oldReceived, oldSent];
    const namedChannel = 'Upgrade check';
    const newReceived = 'Named channel message saved by the upgraded profile';
    const newSent = 'Reply sent after reopening the upgraded profile';
    const newLines = [newReceived, newSent];

    console.log('Creating a saved 0.7.0 profile with a real mixed-version peer');
    let companion = await launch('upgrade-companion', hostFlags);
    await login(companion, { name: hostName, room: roomName, port: await unusedLoopbackPort() });
    const invite = await showInvite(companion.page);
    const legacy = await launch('legacy-070', legacyFlags, undefined, legacyExecutable, legacyAppDirectory);
    await login(legacy, { name: guestName, invite });
    await countPeers(legacy.page, 2);
    await countPeers(companion.page, 2);
    const oldRoom = await savedRoom(legacy.page, roomName, guestName);
    assert.equal(await useNoiseSuppression(legacy.page, 'off'), 'off');
    await send(companion.page, oldReceived);
    await waitForMessage(legacy.page, oldReceived);
    await send(legacy.page, oldSent);
    await waitForMessage(companion.page, oldSent);
    const oldIds = await messageIds(legacy.page, oldLines);
    await quit(legacy);
    await quit(companion);

    console.log('Opening a closed 0.7.0 profile copy in the exact RC1 application');
    const originalDigests = await archiveDigests(legacy.profile);
    const copy = path.join(path.dirname(legacy.profile), 'upgraded-profile');
    await cp(legacy.profile, copy, { recursive: true, force: false, errorOnExist: true });
    assert.deepEqual(await archiveDigests(copy), originalDigests, 'The closed profile copy must carry the protected archive and settings');

    let upgraded = await launch('upgraded-rc1', legacyFlags, copy);
    const migratedRoom = await savedRoom(upgraded.page, roomName, guestName);
    assert.equal(migratedRoom.roomId, oldRoom.roomId, 'The saved room identity must survive the upgrade');
    await reopen(upgraded.page, roomName);
    await upgraded.page.locator('#waiting-peer').waitFor();
    await countPeers(upgraded.page, 1);
    assert.deepEqual(await messageIds(upgraded.page, oldLines), oldIds, 'Cold reopen must preserve legacy message identities');
    assert.equal(await useNoiseSuppression(upgraded.page), 'off', 'The legacy voice preference must survive upgrade');

    console.log('Rejoining the saved room with the retained credential and writing a new channel');
    companion = await launch('upgrade-companion', hostFlags);
    await reopen(companion.page, roomName);
    await countPeers(upgraded.page, 2);
    await countPeers(companion.page, 2);
    assert.deepEqual(await messageIds(upgraded.page, oldLines), oldIds, 'Network catch-up must not duplicate retained messages');
    await companion.page.locator('#room-options-toggle').click();
    await companion.page.locator('#channel-add').click();
    await companion.page.locator('#channel-name').fill(namedChannel);
    await companion.page.locator('#channel-create-form').getByRole('button', { name: 'Create channel' }).click();
    await selectChannel(companion.page, namedChannel);
    await selectChannel(upgraded.page, namedChannel);
    await send(companion.page, newReceived);
    await waitForMessage(upgraded.page, newReceived);
    await send(upgraded.page, newSent);
    await waitForMessage(companion.page, newSent);
    const newIds = await messageIds(upgraded.page, newLines);
    await quit(upgraded);
    await quit(companion);

    upgraded = await launch('upgraded-rc1', legacyFlags, copy);
    try {
        await reopen(upgraded.page, roomName);
        await countPeers(upgraded.page, 1);
        assert.deepEqual(await messageIds(upgraded.page, oldLines), oldIds);
        await selectChannel(upgraded.page, namedChannel);
        assert.deepEqual(await messageIds(upgraded.page, newLines), newIds, 'New channel history must survive a cold restart of the upgraded copy');
    } finally {
        await quit(upgraded);
    }

    assert.deepEqual(await archiveDigests(legacy.profile), originalDigests, 'The original closed legacy profile must remain unchanged');
    const evidence = {
        legacySource,
        legacyPreparation: 'Earlier application source with the matching Windows Electron and dependency payload',
        liveLegacyToRc1GeneralChat: true,
        originalClosedProfileUnchanged: true,
        coldUpgradeFromProtectedCopy: true,
        preservedRoomIdentity: true,
        preservedKeepHistoryAndVoicePreference: true,
        preservedLegacyMessageIdsAndCounts: oldIds.length,
        rejoinedWithoutPastingAnotherInvite: true,
        newNamedChannelMessageIdsPreservedAfterColdRestart: newIds.length
    };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, 'windows-legacy-upgrade.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
}

module.exports = { verifyLegacyUpgrade };
