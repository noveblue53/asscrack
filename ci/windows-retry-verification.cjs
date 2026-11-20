const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { readFile, readdir, stat, unlink, writeFile } = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { Transform } = require('node:stream');

const MiB = 1024 * 1024;
const invitePrefix = 'asscrack1:';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// A byte-transparent local TCP route. Hold encrypted traffic after a real partial
// has had time to reach Laptop, then cut both sockets from outside the app.
async function openRoute(targetPort) {
    const connections = new Set();
    let enabled = true;
    let holdAfter = Infinity;
    let transferred = 0;
    let held = false;
    let opened = 0;
    const server = net.createServer(receiver => {
        if (!enabled) {
            receiver.destroy();
            return;
        }
        const source = net.connect(targetPort, '127.0.0.1');
        const outbound = new Transform({
            transform(chunk, _encoding, callback) {
                this.push(chunk);
                transferred += chunk.length;
                held = transferred >= holdAfter;
                if (!held) callback();
            }
        });
        const close = () => {
            connections.delete(close);
            outbound.destroy();
            source.destroy();
            receiver.destroy();
        };
        connections.add(close);
        opened++;
        for (const socket of [source, receiver]) socket.on('close', close).on('error', close);
        receiver.pipe(source).pipe(outbound).pipe(receiver);
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const cut = () => {
        enabled = false;
        for (const close of connections) close();
    };
    return {
        port: server.address().port,
        hold() { transferred = 0; holdAfter = MiB; },
        held: () => held,
        opens: () => opened,
        cut,
        restore() { holdAfter = Infinity; held = false; enabled = true; },
        close() {
            cut();
            return new Promise(resolve => server.close(resolve));
        }
    };
}

function redirectInvite(invite, targetPort, proxyPort) {
    assert.ok(invite.startsWith(invitePrefix));
    const room = JSON.parse(Buffer.from(invite.slice(invitePrefix.length), 'base64url'));
    assert.equal(room.nodes.length, 1, 'retry fixture must start with one source');
    assert.deepEqual(room.nodes[0].addrs, [`/ip4/127.0.0.1/tcp/${targetPort}`]);
    room.nodes[0].addrs = [`/ip4/127.0.0.1/tcp/${proxyPort}`];
    return { invite: invitePrefix + Buffer.from(JSON.stringify(room)).toString('base64url'), sourceId: room.nodes[0].id };
}

const peerCount = (page, count) => page.waitForFunction(expected =>
    document.getElementById('peer-count').textContent === String(expected), count);

async function verifyRetry({ launch, quit, login, showInvite, unusedLoopbackPort, until, attach, confirmOffer, sandbox, evidenceDir }) {
    const port = await unusedLoopbackPort();
    // The source can announce an explicit address with full-node forwarding off.
    // Laptop has no listener or mDNS. The proxy is its only room destination.
    const source = await launch('retry-source', ['--full-node', 'off']);
    await login(source, { name: 'Retry source', room: 'Windows download retry', port });
    const sourceInvite = await showInvite(source.page);
    const route = await openRoute(port);
    try {
        const { invite, sourceId } = redirectInvite(sourceInvite, port, route.port);
        const laptop = await launch('retry-laptop', ['--relay-only', '--full-node', 'off']);
        await login(laptop, { name: 'Laptop', invite });
        await Promise.all([peerCount(source.page, 2), peerCount(laptop.page, 2)]);
        const roster = laptop.page.locator(`#peers li[data-peer-id="${sourceId}"]`);
        await roster.waitFor();
        const direct = await laptop.page.evaluate(async peerId => {
            const { self, kinds } = await window.asscrack.getTopology();
            return kinds[self][peerId] === 'mesh';
        }, sourceId);
        assert.ok(direct && route.opens() > 0, 'the observed source route must be direct TCP through the proxy');

        const name = 'pilot-interrupted-original.bin';
        const original = randomBytes(16 * MiB);
        const filename = path.join(sandbox, name);
        const sha256 = digest(original);
        await writeFile(filename, original);
        await attach(source, filename);
        await source.page.locator('#send-file').click();
        await confirmOffer(source);
        const card = laptop.page.locator('#messages .file-card').filter({ has: laptop.page.getByText(name, { exact: true }) });
        const oldOffer = await card.getAttribute('data-offer-id');
        assert.match(oldOffer, /^[0-9a-f-]{36}$/i);
        const originalCard = await card.elementHandle();
        const partial = path.join(laptop.downloads, `.asscrack-${oldOffer}.part`);
        route.hold();
        await card.getByRole('button', { name: 'Accept', exact: true }).click();
        const partialBytes = await until(async () => {
            if (!route.held()) return false;
            const bytes = (await stat(partial).catch(error => {
                if (error.code === 'ENOENT') return null;
                throw error;
            }))?.size;
            return bytes >= 256 * 1024 && bytes < original.length && bytes;
        }, 'a substantial on-disk partial before breaking the TCP link');
        assert.equal(await card.getAttribute('data-state'), 'receiving');
        const priorOpens = route.opens();
        route.cut();
        await Promise.all([peerCount(source.page, 1), peerCount(laptop.page, 1)]);
        const offline = card.getByRole('button', { name: 'Sender offline', exact: true });
        await offline.waitFor();
        assert.equal(await offline.isDisabled(), true);
        await offline.evaluate(button => button.click());
        assert.equal(await card.getAttribute('data-state'), 'failed');
        assert.equal(await card.getAttribute('data-offer-id'), oldOffer);
        assert.deepEqual(await readdir(laptop.downloads), [], 'failed attempt must remove its partial');
        await laptop.page.screenshot({ path: path.join(evidenceDir, 'windows-retry-offline.png') });

        const stale = 'previous attempt partial fixture';
        await writeFile(partial, stale);
        route.restore();
        // No app restart or test-only dial. The saved live peer route must redial itself.
        await Promise.all([peerCount(source.page, 2), peerCount(laptop.page, 2), roster.waitFor()]);
        assert.ok(route.opens() > priorOpens, 'the same invite path reconnected');
        const retry = card.getByRole('button', { name: 'Retry', exact: true });
        await retry.waitFor();
        assert.equal(await retry.isEnabled(), true);
        await laptop.page.screenshot({ path: path.join(evidenceDir, 'windows-retry-available.png') });
        // After the real click, repeat the original button callback twice while the next attempt is pending.
        await retry.evaluate(button => {
            button.addEventListener('click', () => queueMicrotask(() => { button.click(); button.click(); }), { once: true });
        });
        await retry.click();
        await card.getByRole('button', { name: 'Show in Explorer', exact: true }).waitFor({ timeout: 45_000 });
        assert.equal(await card.count(), 1);
        assert.ok(await originalCard.evaluate(row => row.isConnected && row.dataset.state === 'done'), 'the original card is reused');
        assert.notEqual(await card.getAttribute('data-offer-id'), oldOffer);
        assert.equal(await laptop.page.locator('#transfers .transfer').filter({ hasText: name }).count(), 1);
        const saved = await readFile(path.join(laptop.downloads, name));
        assert.equal(saved.length, original.length);
        assert.equal(digest(saved), sha256);
        assert.deepEqual((await readdir(laptop.downloads)).sort(), [name, path.basename(partial)].sort());
        assert.equal(await readFile(partial, 'utf8'), stale);
        await unlink(partial);
        assert.deepEqual(await readdir(laptop.downloads), [name]);
        await laptop.page.screenshot({ path: path.join(evidenceDir, 'windows-retry-verified.png') });
        await quit(laptop);
        await quit(source);
        return {
            route: 'direct TCP loopback through an external controllable proxy', bytes: saved.length, sha256, partialBytes,
            initialPartialRemoved: true, sourceIdentityPreserved: true, offlineRetryDisabled: true,
            retryClicks: 3, sameCardAndOneTransferRow: true, stalePartialUntouched: true, verifiedCopies: 1
        };
    } finally {
        await route.close();
    }
}

module.exports = { verifyRetry };
