// Drive the already-extracted Windows release via its real renderer and IPC.
// The workflow validates and extracts the portable artifact before this script runs.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdir, open, readFile, writeFile } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');
const { verifyArchive } = require('./windows-archive-verification.cjs');

const [executable, sandbox, evidencePath] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok([executable, sandbox, evidencePath].every(value => value && path.isAbsolute(value)),
    'Usage: node ci/windows-packaged-pilot.cjs <absolute ASSCRACK.exe> <absolute sandbox> <absolute evidence JSON>');

const clients = new Set();
const rendererErrors = [];
const evidenceDir = path.join(sandbox, 'screenshots');
const report = {
    platform: process.platform,
    architecture: process.arch,
    windowsRelease: os.release(),
    scope: 'Native Windows, packaged app, two separate disposable profiles, keyed loopback, synthetic audio input',
    checks: {},
    rendererErrors
};
let stage = 'startup';

function begin(name) {
    stage = name;
    console.log(`Checking ${name} on the packaged Windows app`);
}

function exited(child) {
    return child.exitCode !== null || child.signalCode !== null;
}

async function until(check, description, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    do {
        const value = await check();
        if (value) return value;
        await delay(150);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${description}`);
}

async function unusedLoopbackPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function launch(label, extraArgs = [], profileOverride) {
    const home = path.join(sandbox, label);
    const profile = profileOverride ?? path.join(home, 'profile');
    const downloads = path.join(home, 'downloads');
    const appLogs = path.join(home, 'logs');
    for (const dir of [profile, downloads, appLogs]) await mkdir(dir, { recursive: true });
    const debugPort = await unusedLoopbackPort();
    const endpoint = `http://127.0.0.1:${debugPort}`;
    const output = await open(path.join(home, 'electron-output.log'), 'a');
    let child;
    let spawnError;
    try {
        child = spawn(executable, [
            `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1',
            '--disable-gpu', '--force-device-scale-factor=1', '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream', '--profile', profile, '--downloads', downloads,
            '--log-dir', appLogs, ...extraArgs
        ], { cwd: path.dirname(executable), windowsHide: true, stdio: ['ignore', output.fd, output.fd] });
        child.once('error', error => { spawnError = error; });
    } finally {
        await output.close();
    }
    const client = { label, child, profile, downloads, appLogs, browser: null, page: null };
    clients.add(client);
    await until(async () => {
        if (spawnError) throw spawnError;
        if (exited(child)) throw new Error(`${label} quit during startup with code ${child.exitCode}`);
        return fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1500) }).then(response => response.ok).catch(() => false);
    }, `${label} CDP listener`);
    // Electron's file chooser must receive local paths. In remote CDP mode,
    // Playwright substitutes in-memory File objects without a native path.
    client.browser = await chromium.connectOverCDP(endpoint, { isLocal: true, timeout: 20_000 });
    client.page = await until(() => client.browser.contexts().flatMap(context => context.pages())
        .find(page => /\/app\.asar\/src\/application\/index\.html$/i.test(page.url())), `${label} application window`);
    client.page.setDefaultTimeout(20_000);
    client.page.on('pageerror', error => rendererErrors.push(`${label}: ${error.message}`));
    await client.page.locator('#login').waitFor();
    return client;
}

async function quit(client) {
    if (!exited(client.child)) {
        await client.page.evaluate(() => window.asscrack.quit()).catch(() => {});
        await until(() => exited(client.child), `${client.label} clean exit`);
    }
    assert.equal(client.child.exitCode, 0, `${client.label} exit`);
    await client.browser.close();
    clients.delete(client);
}

async function waitForMessage(page, text) {
    const locator = page.locator('#messages .text').and(page.getByText(text, { exact: true }));
    await locator.waitFor();
    return locator;
}

async function selectChannel(page, name) {
    const channel = name.startsWith('#') ? name : `#${name}`;
    const option = page.locator('#channel-select option').filter({ hasText: channel }).first();
    await option.waitFor({ state: 'attached' });
    await page.locator('#channel-select').selectOption(await option.getAttribute('value'));
}

async function send(page, message) {
    await page.locator('#message-input').fill(message);
    await page.locator('#message-input').press('Enter');
}

async function login(client, { name, room, port, invite }) {
    const { page } = client;
    await page.locator('#username').fill(name);
    await page.locator('#room-type').selectOption(invite ? 'join' : 'new');
    if (invite) await page.locator('#invite-input').fill(invite);
    else {
        await page.locator('#room').fill(room);
        await page.locator('#public-address').fill(`127.0.0.1:${port}`);
    }
    await page.locator('#save-room').check();
    await page.locator('#login').click();
    await page.locator('#chat-screen').waitFor();
}

async function showInvite(page) {
    await page.locator('#invite-toggle').click();
    const code = await until(async () => {
        const value = await page.locator('#invite-code').inputValue();
        return value.startsWith('asscrack1:') && value;
    }, 'generated loopback invite');
    await page.locator('#invite-toggle').click();
    return code;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function compareDownload(client, name, source) {
    const received = await readFile(path.join(client.downloads, name));
    const hash = sha256(source);
    assert.equal(received.length, source.length);
    assert.equal(sha256(received), hash);
    return { bytes: received.length, sha256: hash };
}

async function attach(client, filename) {
    await client.page.locator('#file-input').setInputFiles(filename);
    await client.page.locator('#file-draft-name').and(client.page.getByText(path.basename(filename), { exact: true })).waitFor();
}

async function confirmOffer(client) {
    await client.page.waitForFunction(() => document.getElementById('file-draft').hidden ||
        Boolean(document.getElementById('status').textContent));
    assert.ok(await client.page.locator('#file-draft').isHidden(),
        `Sender did not post the file: ${await client.page.locator('#status').textContent()}`);
}

async function exerciseVoice(host, guest) {
    for (const client of [host, guest]) {
        await client.page.locator('#join-voice').click();
        await client.page.locator('#mute').waitFor();
    }
    await guest.page.locator('#mute').click();
    await guest.page.waitForFunction(() => document.getElementById('mute').getAttribute('aria-pressed') === 'true');
    await guest.page.locator('#mute').click();
    await guest.page.waitForFunction(() => document.getElementById('mute').getAttribute('aria-pressed') === 'false');
    await guest.page.locator('#voice-settings-toggle').click();
    await guest.page.locator('#vs-mode-ptt').check();
    // CDP supplies renderer keystrokes. Native/background input is a separate check.
    await guest.page.locator('#vs-ptt-global').uncheck();
    await guest.page.locator('#vs-ptt-set').click();
    await guest.page.keyboard.press('F9');
    await guest.page.locator('#vs-ptt-key').filter({ hasText: 'F9' }).waitFor();
    await guest.page.locator('#vs-close').click();
    await guest.page.keyboard.down('F9');
    await guest.page.locator('#ptt-state[data-held="true"]').waitFor();
    await guest.page.keyboard.up('F9');
    await guest.page.locator('#ptt-state[data-held="false"]').waitFor();
    return 'Both packaged peers joined voice with synthetic input. Mute, unmute and focused-window PTT were exercised.';
}

async function run() {
    await mkdir(evidenceDir, { recursive: true });
    begin('fresh invite join');
    const roomName = 'Windows friend pilot';
    const channelName = 'Paddock';
    const hostName = 'John Asscrack';
    const guestName = 'Laptop';
    const host = await launch('host', ['--allow-private-full-node', '--full-node', 'on']);
    await login(host, { name: hostName, room: roomName, port: await unusedLoopbackPort() });
    const invite = await showInvite(host.page);
    const guest = await launch('guest', ['--full-node', 'off']);
    await login(guest, { name: guestName, invite });
    for (const client of [host, guest]) {
        await client.page.waitForFunction(() => document.getElementById('peer-count').textContent === '2');
    }
    report.checks.invite = 'A fresh packaged Windows profile joined another packaged Windows profile by invite.';

    begin('named public chat');
    const publicReceived = 'Public archive marker from John';
    const publicSent = 'Public archive marker from Laptop';
    await host.page.locator('#room-options-toggle').click();
    await host.page.locator('#channel-add').click();
    await host.page.locator('#channel-name').fill(channelName);
    await host.page.locator('#channel-create-form').getByRole('button', { name: 'Create channel' }).click();
    await selectChannel(host.page, channelName);
    await selectChannel(guest.page, channelName);
    await send(host.page, publicReceived);
    await waitForMessage(guest.page, publicReceived);
    await send(guest.page, publicSent);
    await waitForMessage(host.page, publicSent);
    report.checks.chat = 'Two-way chat in a named room channel.';

    begin('private whisper');
    const privateText = 'Private archive exclusion marker from Laptop';
    const privateReply = 'Private reply from John';
    const draft = 'Unsent public draft';
    await guest.page.locator('#message-input').fill(draft);
    await guest.page.locator('#peers li').filter({ has: guest.page.locator('.name').filter({ hasText: hostName }) }).click({ button: 'right' });
    await guest.page.getByRole('menuitem', { name: 'Whisper', exact: true }).click();
    await guest.page.locator('#whisper-draft').fill(privateText);
    await guest.page.locator('#whisper-draft').press('Enter');
    await host.page.locator('#peers li[data-whisper-unread="1"]').waitFor();
    await send(host.page, `/w ${guestName}`);
    await host.page.locator('#whisper-lines').getByText(privateText, { exact: false }).waitFor();
    await host.page.locator('#whisper-draft').fill(privateReply);
    await host.page.locator('#whisper-draft').press('Enter');
    await guest.page.locator('#whisper-lines').getByText(privateReply, { exact: false }).waitFor();
    await host.page.locator('#whisper-close').click();
    await guest.page.locator('#whisper-close').click();
    assert.equal(await guest.page.locator('#message-input').inputValue(), draft);
    assert.equal(await guest.page.locator('#messages').getByText(privateReply, { exact: false }).count(), 0);
    await guest.page.locator('#message-input').fill('');
    report.checks.whisper = 'Both entry points, two-way receipt, preserved public draft and no private text in the public transcript.';

    begin('ordinary original download');
    await selectChannel(host.page, 'general');
    await selectChannel(guest.page, 'general');
    const fileName = 'pilot-original.bin';
    const source = Buffer.alloc(2 * 1024 * 1024, 'ASSCRACK native Windows loopback original\n');
    const filePath = path.join(sandbox, fileName);
    await writeFile(filePath, source);
    await attach(host, filePath);
    await host.page.locator('#send-file').click();
    await confirmOffer(host);
    const card = guest.page.locator('#messages .file-card').filter({ hasText: fileName });
    await card.getByRole('button', { name: 'Accept', exact: true }).click();
    await card.getByRole('button', { name: 'Show in Explorer', exact: true }).waitFor();
    report.checks.original = await compareDownload(guest, fileName, source);

    begin('inline media and independent original');
    await selectChannel(host.page, channelName);
    await selectChannel(guest.page, channelName);
    const mediaName = 'pilot-image.png';
    const mediaCaption = 'Public file caption';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQCdjyHwADrAIYvvruLQAAAABJRU5ErkJggg==', 'base64');
    const mediaPath = path.join(sandbox, mediaName);
    await writeFile(mediaPath, png);
    await attach(host, mediaPath);
    await host.page.locator('#message-input').fill(mediaCaption);
    await host.page.locator('#send-file').click();
    await confirmOffer(host);
    const media = guest.page.locator('#messages li[data-attachment-id]').filter({ hasText: mediaCaption });
    await media.locator('img').waitFor();
    await media.getByRole('button', { name: 'Download original' }).click();
    await media.getByRole('button', { name: 'Show saved original' }).waitFor();
    report.checks.media = await compareDownload(guest, mediaName, png);

    begin('voice and push to talk');
    try {
        report.checks.voice = { outcome: 'passed', detail: await exerciseVoice(host, guest) };
    } catch (error) {
        report.checks.voice = { outcome: 'failed', detail: error.message };
        console.error('Synthetic voice check:', error.message);
    }
    await guest.page.screenshot({ path: path.join(evidenceDir, 'windows-packaged-room.png') });

    begin('isolated protected archive');
    await quit(guest);
    await quit(host);
    report.checks.archive = await verifyArchive({
        launch, quit, selectChannel, waitForMessage, guest, roomName, channelName, publicReceived, publicSent,
        privateText, privateReply, mediaName, mediaCaption, invite, evidenceDir
    });
    assert.deepEqual(rendererErrors, []);
    if (report.checks.voice.outcome !== 'passed') throw new Error('The synthetic voice check failed. Other completed checks are recorded.');
    report.outcome = 'passed';
    console.log('Native packaged friend-pilot checks passed.');
}

run().catch(async error => {
    report.outcome = 'failed';
    report.failure = { stage, detail: error.message };
    console.error(error);
    report.diagnostics = {};
    await Promise.allSettled([...clients].map(async client => {
        if (!client.page || client.page.isClosed()) return;
        report.diagnostics[client.label] = await client.page.evaluate(() => ({
            peers: document.getElementById('peer-count').textContent,
            channel: document.getElementById('channel-select').selectedOptions[0]?.textContent,
            status: document.getElementById('status').textContent.slice(0, 230),
            voiceError: document.getElementById('voice-error').textContent.slice(0, 230),
            transfers: [...document.querySelectorAll('#transfers .transfer')].map(row => ({
                state: row.dataset.state, text: row.querySelector('.state-text')?.textContent.slice(0, 120)
            }))
        }));
        await client.page.screenshot({ path: path.join(evidenceDir, `${client.label}-failure.png`), timeout: 3000 });
    }));
    process.exitCode = 1;
}).finally(async () => {
    await Promise.allSettled([...clients].map(async client => {
        if (!exited(client.child)) client.child.kill();
        await client.browser?.close();
    }));
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n');
});
