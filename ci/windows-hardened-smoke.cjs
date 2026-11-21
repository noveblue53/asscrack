const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');

async function until(read, timeout = 35_000) {
    const deadline = Date.now() + timeout;
    do {
        const result = await read();
        if (result) return result;
        await delay(150);
    } while (Date.now() < deadline);
    throw new Error('Timed out waiting for the packaged window');
}

async function loopbackPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

function runnerEnvironment(temp) {
    // The tested app does not inherit Github tokens or workflow/service settings.
    const names = new Set(['appdata', 'comspec', 'homedrive', 'homepath', 'localappdata', 'path', 'pathext',
        'programdata', 'programfiles', 'programfiles(x86)', 'systemdrive', 'systemroot', 'userdomain', 'username', 'userprofile', 'windir']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toLowerCase())));
    return { ...env, TEMP: temp, TMP: temp };
}

function makeLauncher(executable, root, chromium) {
    const clients = new Set();
    const failures = [];

    async function launch(label, flags = []) {
        const home = path.join(root, label);
        const profile = path.join(home, 'profile');
        const downloads = path.join(home, 'downloads');
        const temp = await fs.mkdtemp(path.join(root, 'unpack-'));
        await fs.mkdir(profile, { recursive: true });
        await fs.mkdir(downloads, { recursive: true });
        const debugPort = await loopbackPort();
        const origin = `http://127.0.0.1:${debugPort}`;
        const child = spawn(executable, [
            `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1',
            '--disable-gpu', '--force-device-scale-factor=1', '--profile', profile, '--downloads', downloads, ...flags
        ], { cwd: path.dirname(executable), env: runnerEnvironment(temp), stdio: 'ignore', windowsHide: false });
        const client = { child, profile, temp, browser: null, page: null, exited: false, exitCode: null, error: null };
        clients.add(client);
        child.on('exit', code => { client.exited = true; client.exitCode = code; });
        child.on('error', error => { client.error = error; });
        await until(async () => {
            if (client.error) throw client.error;
            if (client.exited) throw new Error('The portable launcher exited during startup');
            return fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
        }, 90_000);
        client.browser = await chromium.connectOverCDP(origin, { isLocal: true, timeout: 20_000 });
        client.page = await until(() => client.browser.contexts().flatMap(context => context.pages())
            .find(page => /^file:\/\/\/[^?#]+\/resources\/app\.asar\/src\/application\/index\.html$/i.test(page.url())));
        client.page.setDefaultTimeout(30_000);
        client.page.on('pageerror', () => { failures.push('renderer exception'); });
        await client.page.locator('#login').waitFor();
        return client;
    }

    async function quit(client) {
        await client.page.locator('#view-toggle').click();
        await client.page.locator('#view-quit').click();
        await until(() => client.exited);
        assert.equal(client.exitCode, 0);
        await client.browser.close().catch(() => {});
        clients.delete(client);
    }

    async function clean() {
        for (const client of clients) {
            if (!client.exited && client.child.pid) spawnSync('taskkill.exe', ['/PID', String(client.child.pid), '/T', '/F'],
                { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
            await client.browser?.close().catch(() => {});
        }
    }
    return { launch, quit, clean, failures };
}

function readNativeClipboard() {
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA',
        '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, 0, 'Native Windows clipboard could not be read');
    return result.stdout.trim();
}

function verifyDpapi(localState) {
    const command = `
        $ErrorActionPreference = 'Stop'
        Add-Type -AssemblyName System.Security
        $state = Get-Content -Raw -LiteralPath $env:ASSCRACK_SMOKE_LOCAL_STATE | ConvertFrom-Json
        $data = [Convert]::FromBase64String($state.os_crypt.encrypted_key)
        if ($data.Length -le 5 -or [Text.Encoding]::ASCII.GetString($data, 0, 5) -cne 'DPAPI') { exit 2 }
        [byte[]]$payload = $data[5..($data.Length - 1)]
        [byte[]]$key = [Security.Cryptography.ProtectedData]::Unprotect($payload, $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser)
        try { if ($key.Length -ne 32) { exit 3 } }
        finally { [Array]::Clear($key, 0, $key.Length) }
    `;
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64')], {
        env: { ...process.env, ASSCRACK_SMOKE_LOCAL_STATE: localState }, windowsHide: true, stdio: 'ignore', timeout: 25_000
    });
    assert.equal(result.status, 0, 'The native CurrentUser DPAPI profile key did not unwrap');
}

async function verifyArchive(profile, fixtures) {
    const archive = path.join(profile, 'saved-rooms');
    const database = path.join(archive, 'archive.db');
    const localState = path.join(profile, 'Local State');
    const { v, wrapped } = JSON.parse(await fs.readFile(path.join(archive, 'archive.key'), 'utf8'));
    assert.equal(v, 1);
    const wrapper = Buffer.from(wrapped, 'base64');
    assert.ok(wrapper.length > 32 && wrapper.subarray(0, 3).toString('ascii') === 'v10');
    verifyDpapi(localState);

    const readOnly = new DatabaseSync(database, { readOnly: true });
    try {
        assert.throws(() => readOnly.prepare('SELECT count(*) FROM sqlite_master').get(), /file is not a database/i);
    } finally { readOnly.close(); }
    const files = (await fs.readdir(archive, { withFileTypes: true })).filter(entry => entry.isFile())
        .map(entry => path.join(archive, entry.name));
    const markers = fixtures.flatMap(value => [Buffer.from(value, 'utf8'), Buffer.from(value, 'utf16le')]);
    for (const file of [...files, localState]) {
        const bytes = await fs.readFile(file);
        assert.ok(!markers.some(marker => bytes.includes(marker)), 'An archive file contained a plaintext fixture');
    }
    return { currentUserDpapi: true, chromiumEncryptedWrapper: true, ordinarySqliteRejected: true, plaintextFixturesAbsent: true };
}

async function exerciseVisibleRoom({ launch, quit, clipboard, verifyAtRest, begin, checks }) {
    const inviteHost = ['--full-node', 'on', '--allow-private-full-node'];
    const guestFlags = ['--full-node', 'off'];
    const publicPort = await loopbackPort();
    const token = randomUUID();
    const room = `Protected smoke ${token.slice(0, 8)}`;
    const hostName = 'Pilot Host';
    const guestName = 'Pilot Guest';
    const sentByHost = `Protected smoke host ${token}`;
    const sentByGuest = `Protected smoke guest ${token}`;
    let host, guest;
    const control = (client, id) => client.page.locator(`#${id}`);
    const visibleText = (client, root, text) => client.page.locator(root).getByText(text, { exact: true });
    async function loginRoomVisible(client) {
        const heading = control(client, 'chat-room').filter({ hasText: room });
        await heading.waitFor();
        assert.equal((await heading.textContent()).trim(), room);
    }
    const peerCount = (client, count) => until(async () => (await control(client, 'peer-count').textContent()).trim() === String(count));
    async function send(client, text) {
        const input = control(client, 'message-input');
        await input.fill(text);
        await input.press('Enter');
    }
    async function reopen(client) {
        const row = client.page.locator('.saved-room').filter({ has: client.page.getByText(room, { exact: true }) });
        await row.getByRole('button', { name: 'Reopen room', exact: true }).click();
        await loginRoomVisible(client);
    }

    begin('portable owner and guest launch');
    host = await launch('host', inviteHost);
    guest = await launch('guest', guestFlags);
    checks.portableTwoProfiles = true;
    await control(guest, 'username').fill(guestName);
    await control(guest, 'room-type').selectOption('join');
    await control(guest, 'copy-device-id').click();
    await until(async () => (await control(guest, 'device-id-note').textContent()).includes('copied'));
    const guestDeviceId = await clipboard();
    assert.match(guestDeviceId, /^[a-zA-Z0-9_-]{32,128}$/);

    begin('device invite and protected room admission');
    await control(host, 'username').fill(hostName);
    await control(host, 'room-type').selectOption('new');
    await control(host, 'room').fill(room);
    await control(host, 'public-address').fill(`127.0.0.1:${publicPort}`);
    assert.equal(await control(host, 'allow-upnp').isChecked(), false);
    await control(host, 'save-room').check();
    await control(host, 'login').click();
    await loginRoomVisible(host);
    await control(host, 'invite-toggle').click();
    await control(host, 'member-device-id').fill(guestDeviceId);
    await control(host, 'member-invite-create').click();
    await control(host, 'invite-code').waitFor({ state: 'visible' });
    const invite = await control(host, 'invite-code').inputValue();
    assert.ok(invite.startsWith('asscrack2:'));
    const roomKey = JSON.parse(Buffer.from(invite.slice('asscrack2:'.length), 'base64url').toString('utf8')).key;
    assert.match(roomKey, /^[A-Za-z0-9_-]{43}$/);
    await control(host, 'invite-toggle').click();
    await control(guest, 'invite-input').fill(invite);
    await control(guest, 'save-room').check();
    await control(guest, 'login').click();
    await loginRoomVisible(guest);
    await peerCount(host, 2);
    await peerCount(guest, 2);
    await control(guest, 'invite-toggle').click();
    await visibleText(guest, '#invite-panel', 'This device is admitted.').waitFor();
    await control(guest, 'invite-toggle').click();
    checks.protectedDeviceAdmission = true;

    begin('two-way room messages');
    await send(host, sentByHost);
    await visibleText(guest, '#messages', sentByHost).waitFor();
    await send(guest, sentByGuest);
    await visibleText(host, '#messages', sentByGuest).waitFor();
    checks.twoWayPublicChat = true;
    await quit(guest);
    await quit(host);

    begin('native saved profile protection');
    Object.assign(checks, await verifyAtRest(guest.profile, [sentByHost, sentByGuest, invite, roomKey]));
    begin('cold reopen without a live peer');
    guest = await launch('guest', guestFlags);
    await reopen(guest);
    await peerCount(guest, 1);
    await visibleText(guest, '#messages', sentByHost).waitFor();
    await visibleText(guest, '#messages', sentByGuest).waitFor();
    assert.equal(await visibleText(guest, '#messages', sentByHost).count(), 1);
    assert.equal(await visibleText(guest, '#messages', sentByGuest).count(), 1);
    checks.offlineColdReopenedExactMessages = true;

    begin('owner cold reopen and device revocation');
    host = await launch('host', inviteHost);
    await reopen(host);
    await peerCount(host, 2);
    await peerCount(guest, 2);
    await control(host, 'invite-toggle').click();
    const guestDevice = control(host, 'room-members').getByRole('listitem')
        .filter({ has: host.page.getByText(guestDeviceId, { exact: true }) });
    await guestDevice.getByRole('button', { name: /^Revoke / }).click();
    await guestDevice.getByRole('button', { name: 'Confirm revoke' }).click();
    await guestDevice.getByText('Revoked', { exact: true }).waitFor();
    await peerCount(host, 1);
    await peerCount(guest, 1);
    checks.revocationDisconnectedDevice = true;

    begin('revoked device cold reopen');
    await quit(guest);
    guest = await launch('guest', guestFlags);
    await reopen(guest);
    await peerCount(guest, 1);
    await control(guest, 'invite-toggle').click();
    await visibleText(guest, '#invite-panel', 'This device’s access was revoked.').waitFor();
    assert.equal((await control(host, 'peer-count').textContent()).trim(), '1');
    checks.revokedDeviceRemainedExcludedAfterRestart = true;
    await quit(guest);
    await quit(host);
}

async function main() {
    assert.equal(process.platform, 'win32');
    assert.equal(process.arch, 'x64');
    const { ASSCRACK_SMOKE_EXE: executable, ASSCRACK_SMOKE_ROOT: root, ASSCRACK_SMOKE_SHA256: expected } = process.env;
    assert.ok(executable && root && /^[\da-f]{64}$/i.test(expected));
    assert.equal(path.dirname(executable), root);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(executable)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    assert.equal(sha256, expected.toLowerCase(), 'The pinned candidate changed after download');
    const { chromium } = require('playwright-core');
    const launcher = makeLauncher(executable, root, chromium);
    const checks = {};
    let stage = 'startup';
    const begin = value => { stage = value; };
    try {
        await exerciseVisibleRoom({ ...launcher, clipboard: readNativeClipboard, verifyAtRest: verifyArchive, begin, checks });
        assert.equal(launcher.failures.length, 0);
        console.log(JSON.stringify({ platform: 'native Windows x64', pinnedPortable: true, outcome: 'passed', checks }));
    } catch (error) {
        console.error(JSON.stringify({ platform: 'native Windows x64', outcome: 'failed', stage, type: error.name, checks }));
        process.exitCode = 1;
    } finally {
        await launcher.clean();
    }
}

if (require.main === module) main().catch(error => {
    console.error(JSON.stringify({ outcome: 'failed', stage: 'validation', type: error.name }));
    process.exitCode = 1;
});

module.exports = { exerciseVisibleRoom };
