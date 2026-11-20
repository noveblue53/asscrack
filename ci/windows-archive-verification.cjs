const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function archiveFiles(profile) {
    const directory = path.join(profile, 'saved-rooms');
    return {
        directory,
        database: path.join(directory, 'archive.db'),
        wrapper: path.join(directory, 'archive.key'),
        temporaryWrapper: path.join(directory, 'archive.key.tmp'),
        localState: path.join(profile, 'Local State')
    };
}

async function digest(file) {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

function verifyCurrentUserDpapi(localState) {
    // Chromium's v10 archive wrapper uses a profile key stored in Local State. Ask
    // Windows to unwrap that key as the current user and keep the bytes in the child.
    const command = `
        $ErrorActionPreference = 'Stop'
        Add-Type -AssemblyName System.Security
        $state = Get-Content -Raw -LiteralPath $env:ASSCRACK_PILOT_LOCAL_STATE | ConvertFrom-Json
        $blob = [Convert]::FromBase64String($state.os_crypt.encrypted_key)
        if ($blob.Length -le 5 -or [Text.Encoding]::ASCII.GetString($blob, 0, 5) -cne 'DPAPI') { exit 2 }
        $key = [Security.Cryptography.ProtectedData]::Unprotect([byte[]]$blob[5..($blob.Length - 1)], $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser)
        try { if ($key.Length -ne 32) { exit 3 } }
        finally { [Array]::Clear($key, 0, $key.Length) }
    `;
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64')], {
        env: { ...process.env, ASSCRACK_PILOT_LOCAL_STATE: localState },
        windowsHide: true,
        stdio: 'ignore',
        timeout: 20_000
    });
    assert.equal(result.status, 0, 'Windows CurrentUser DPAPI must unwrap the Chromium profile key');
}

async function verifyProtectedBytes(files, logDirectory, markers) {
    const envelope = JSON.parse(await fs.readFile(files.wrapper, 'utf8'));
    assert.equal(envelope.v, 1, 'archive key wrapper format');
    assert.equal(typeof envelope.wrapped, 'string');
    const wrapped = Buffer.from(envelope.wrapped, 'base64');
    assert.ok(wrapped.length > 32 && wrapped.subarray(0, 3).toString('ascii') === 'v10',
        'archive key must use the Chromium encrypted wrapper');
    verifyCurrentUserDpapi(files.localState);

    const readOnly = new DatabaseSync(files.database, { readOnly: true });
    try {
        assert.throws(() => readOnly.prepare('SELECT count(*) FROM sqlite_master').get(), /file is not a database/i,
            'ordinary SQLite must be unable to read the archive');
    } finally {
        readOnly.close();
    }

    const archiveEntries = await fs.readdir(files.directory, { withFileTypes: true });
    const logEntries = await fs.readdir(logDirectory, { withFileTypes: true });
    const paths = [files.localState, ...archiveEntries.filter(entry => entry.isFile())
        .map(entry => path.join(files.directory, entry.name)), ...logEntries.filter(entry => entry.isFile())
        .map(entry => path.join(logDirectory, entry.name))];
    for (const file of paths) {
        const bytes = await fs.readFile(file);
        for (const marker of markers) {
            assert.ok(!bytes.includes(Buffer.from(marker, 'utf8')) && !bytes.includes(Buffer.from(marker, 'utf16le')),
                'chat and invite fixtures must be absent from raw archive and log files');
        }
    }
    return paths.length;
}

async function reopenAndRead(page, { selectChannel, waitForMessage, roomName, channelName, publicReceived, publicSent, privateText }) {
    const saved = page.locator('.saved-room').filter({ has: page.getByText(roomName, { exact: true }) });
    await saved.getByRole('button', { name: 'Reopen room', exact: true }).click();
    await page.locator('#waiting-peer').waitFor({ state: 'visible' });
    await selectChannel(page, channelName);
    await waitForMessage(page, publicReceived);
    await waitForMessage(page, publicSent);
    assert.equal(await page.locator('#peer-count').textContent(), '1', 'all other room peers are stopped');
    const observed = await page.locator('#messages > li[data-id]').evaluateAll((rows, expected) => expected.map(text =>
        rows.filter(row => row.querySelector('.text')?.textContent === text).map(row => row.dataset.id)),
    [publicReceived, publicSent, privateText]);
    assert.deepEqual(observed.map(ids => ids.length), [1, 1, 0], 'reopened archive has exactly the public fixture messages');
    assert.notEqual(observed[0][0], observed[1][0]);
    return observed.slice(0, 2).map(ids => ids[0]);
}

async function verifyArchive(options) {
    const { launch, quit, guest, invite, publicReceived, publicSent, privateText, evidenceDir } = options;
    const source = archiveFiles(guest.profile);
    assert.ok(typeof invite === 'string' && invite.startsWith('asscrack1:'), 'a disposable keyed invite is required');
    const { key: roomKey } = JSON.parse(Buffer.from(invite.slice('asscrack1:'.length), 'base64url').toString('utf8'));
    const fixtures = [invite, roomKey, publicReceived, publicSent, privateText];
    assert.ok(fixtures.every(marker => typeof marker === 'string' && marker.length > 0));
    const scannedFiles = await verifyProtectedBytes(source, guest.appLogs, fixtures);

    const cold = await launch(guest.label, ['--full-node', 'off']);
    let initialIds;
    try { initialIds = await reopenAndRead(cold.page, options); }
    finally { await quit(cold); }

    // Only copy the test archive and the state needed to read it under this runner account.
    // The original profile stays closed throughout the destructive portion of the rehearsal.
    const disposable = await fs.mkdtemp(path.join(path.dirname(guest.profile), 'archive-key-recovery-'));
    const copy = archiveFiles(disposable);
    const expectedDatabase = await digest(source.database);
    const expectedWrapper = await digest(source.wrapper);
    try {
        await fs.mkdir(copy.directory);
        await fs.copyFile(source.database, copy.database);
        await fs.copyFile(source.localState, copy.localState);

        const copyLabel = `${guest.label}-wrapper-recovery`;
        const locked = await launch(copyLabel, ['--full-node', 'off'], disposable);
        try {
            const warning = locked.page.locator('#archive-state').filter({ hasText: 'Saved rooms: locked (key-missing)' });
            await warning.waitFor({ state: 'visible' });
            assert.equal(await locked.page.locator('.saved-room').count(), 0);
        } finally { await quit(locked); }
        await assert.rejects(fs.access(copy.wrapper), { code: 'ENOENT' });
        await assert.rejects(fs.access(copy.temporaryWrapper), { code: 'ENOENT' });
        assert.ok(await digest(copy.database) === expectedDatabase, 'missing wrapper must preserve the copied database bytes');

        await fs.copyFile(source.wrapper, copy.wrapper);
        const recovered = await launch(copyLabel, ['--full-node', 'off'], disposable);
        try {
            const recoveredIds = await reopenAndRead(recovered.page, options);
            assert.ok(recoveredIds.every((id, index) => id === initialIds[index]), 'recovery must preserve both message identities');
        } finally { await quit(recovered); }
        assert.ok(await digest(source.database) === expectedDatabase && await digest(source.wrapper) === expectedWrapper,
            'recovery on a copy must leave the original archive and wrapper intact');
    } finally {
        await fs.rm(disposable, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }

    const evidence = {
        windowsCurrentUserDpapi: true,
        unkeyedReadOnlySqliteRejected: true,
        filesScannedForPlaintextFixtures: scannedFiles,
        coldReopenWithOtherPeersStopped: true,
        exactPublicMessageCount: initialIds.length,
        privateMessageAbsent: true,
        missingWrapperLockedAndPreservedDatabase: true,
        copiedProfileRecoveredFromRestoredWrapper: true,
        originalArchiveAndWrapperPreserved: true
    };
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, 'windows-archive-verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
}

module.exports = { verifyArchive };
