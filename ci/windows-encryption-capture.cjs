const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const { gzipSync, gunzipSync } = require('node:zlib');

const host = '127.0.0.1';
const maxCapture = 2 * 1024 * 1024;
const invitePrefix = 'asscrack1:';

async function serveLoopback(callback) {
    const server = net.createServer(callback);
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
    return server;
}

// Forward unchanged TCP bytes on this disposable loopback route. Keep separate
// streams for each direction and connection so decoder checks respect boundaries.
async function observeRoute(port) {
    const connections = [];
    const active = new Set();
    let total = 0;
    const server = await serveLoopback(client => {
        const target = net.connect(port, host);
        const captured = { toTarget: [], toClient: [] };
        connections.push(captured);
        function record(direction, chunk) {
            total += chunk.length;
            if (total <= maxCapture) captured[direction].push(Buffer.from(chunk));
        }
        function close() {
            active.delete(close);
            client.destroy();
            target.destroy();
        }
        active.add(close);
        client.on('data', chunk => record('toTarget', chunk)).on('close', close).on('error', close);
        target.on('data', chunk => record('toClient', chunk)).on('close', close).on('error', close);
        client.pipe(target).pipe(client);
    });
    return {
        port: server.address().port,
        get total() { return total; },
        get connections() { return connections.length; },
        buffers() {
            assert.ok(total <= maxCapture, 'The bounded capture must include all observed bytes');
            return connections.flatMap(({ toTarget, toClient }) => [Buffer.concat(toTarget), Buffer.concat(toClient)]);
        },
        close() {
            for (const close of active) close();
            return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    };
}

function containsGzipMessage(bytes, message) {
    const magic = Buffer.from([0x1f, 0x8b, 0x08]);
    for (let at = bytes.indexOf(magic); at >= 0; at = bytes.indexOf(magic, at + 1)) {
        try {
            if (gunzipSync(bytes.subarray(at), { maxOutputLength: maxCapture }).includes(message)) return true;
        } catch {
            // A matching header in arbitrary wire bytes need not be a gzip member.
        }
    }
    return false;
}

function checkDecoders(buffers, text) {
    const plain = Buffer.from(text);
    const little = Buffer.from(text, 'utf16le');
    const big = Buffer.from(little).swap16();
    const any = check => buffers.some(check);
    const decoded = (pattern, encoding) => any(buffer =>
        [...buffer.toString('latin1').matchAll(pattern)].some(([candidate]) => Buffer.from(candidate, encoding).includes(plain)));
    return {
        utf8: any(buffer => buffer.includes(plain)),
        utf16: any(buffer => buffer.includes(little) || buffer.includes(big)),
        base64: decoded(/[A-Za-z0-9+/_-]{24,}={0,2}/g, 'base64'),
        hex: decoded(/[\da-fA-F]{24,}/g, 'hex'),
        url: any(buffer => {
            const text = buffer.toString('latin1');
            if (!text.includes('%')) return false;
            const unescaped = text.replace(/%([\da-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            return unescaped !== text && Buffer.from(unescaped, 'latin1').includes(plain);
        }),
        gzip: any(buffer => containsGzipMessage(buffer, plain))
    };
}

async function echoThrough(port, bytes) {
    const client = net.connect(port, host);
    try {
        const echoed = new Promise((resolve, reject) => {
            const chunks = [];
            let seen = 0;
            client.setTimeout(5000, () => client.destroy(new Error('Plaintext control timed out')));
            client.on('error', reject).on('data', chunk => {
                chunks.push(chunk);
                seen += chunk.length;
                if (seen >= bytes.length) resolve(Buffer.concat(chunks));
            });
        });
        client.write(bytes);
        assert.ok((await echoed).equals(bytes), 'The observer must forward the control unchanged');
    } finally {
        client.destroy();
    }
}

async function verifyControls() {
    const message = `Plaintext control ${randomBytes(18).toString('hex')} ✓`;
    const plain = Buffer.from(message);
    const samples = {
        utf8: plain,
        utf16: Buffer.from(message, 'utf16le'),
        base64: Buffer.from(plain.toString('base64')),
        hex: Buffer.from(plain.toString('hex')),
        url: Buffer.from(encodeURIComponent(message)),
        gzip: gzipSync(plain)
    };
    const echo = await serveLoopback(socket => socket.on('error', () => {}).pipe(socket));
    const tap = await observeRoute(echo.address().port);
    try {
        for (const sample of Object.values(samples)) await echoThrough(tap.port, sample);
        const results = checkDecoders(tap.buffers(), message);
        assert.ok(Object.values(results).every(Boolean), 'Every decoder must recover the synthetic control through the TCP observer');
        return results;
    } finally {
        await tap.close();
        await new Promise(resolve => echo.close(resolve));
    }
}

function routeInvite(invite, sourcePort, tapPort) {
    assert.ok(invite.startsWith(invitePrefix));
    const data = JSON.parse(Buffer.from(invite.slice(invitePrefix.length), 'base64url').toString());
    assert.equal(data.nodes.length, 1);
    assert.deepEqual(data.nodes[0].addrs, [`/ip4/${host}/tcp/${sourcePort}`]);
    data.nodes[0].addrs = [`/ip4/${host}/tcp/${tapPort}`];
    return { invite: invitePrefix + Buffer.from(JSON.stringify(data)).toString('base64url'), sourceId: data.nodes[0].id };
}

async function post(page, selector, text) {
    const field = page.locator(selector);
    await field.fill(text);
    await field.press('Enter');
}

async function observeDirectEncryption({ launch, quit, login, showInvite, unusedLoopbackPort, waitForMessage }) {
    const controls = await verifyControls();
    const sourcePort = await unusedLoopbackPort();
    const source = await launch('capture-source', ['--full-node', 'off']);
    await login(source, { name: 'Capture Alpha', room: 'Disposable encryption check', port: sourcePort });
    const actualInvite = await showInvite(source.page);
    const tap = await observeRoute(sourcePort);
    try {
        const { invite, sourceId } = routeInvite(actualInvite, sourcePort, tap.port);
        const guest = await launch('capture-guest', ['--relay-only', '--full-node', 'off']);
        await login(guest, { name: 'Capture Beta', invite });
        for (const peer of [source, guest]) {
            await peer.page.waitForFunction(() => document.getElementById('peer-count').textContent === '2');
        }
        assert.ok(await guest.page.evaluate(async id => {
            const { self, kinds } = await window.asscrack.getTopology();
            return kinds[self]?.[id] === 'mesh';
        }, sourceId), 'Expected a directly connected chat peer');
        assert.ok(tap.connections > 0 && tap.total > 0, 'The direct handshake must traverse the byte observer');
        const beforeMessages = tap.total;
        const marker = label => `${label} ${randomBytes(18).toString('hex')} ✓`;
        const publicAlpha = marker('Public alpha');
        const publicBeta = marker('Public beta');
        const privateAlpha = marker('Private alpha');
        const privateBeta = marker('Private beta');
        await post(source.page, '#message-input', publicAlpha);
        await waitForMessage(guest.page, publicAlpha);
        await post(guest.page, '#message-input', publicBeta);
        await waitForMessage(source.page, publicBeta);
        await post(source.page, '#message-input', '/w Capture Beta');
        await source.page.locator('#whisper-draft').waitFor();
        await post(source.page, '#whisper-draft', privateAlpha);
        await guest.page.locator('#peers li[data-whisper-unread="1"]').waitFor();
        await post(guest.page, '#message-input', '/w Capture Alpha');
        await guest.page.locator('#whisper-lines').getByText(privateAlpha, { exact: false }).waitFor();
        await post(guest.page, '#whisper-draft', privateBeta);
        await source.page.locator('#whisper-lines').getByText(privateBeta, { exact: false }).waitFor();

        const buffers = tap.buffers();
        const recovered = [publicAlpha, publicBeta, privateAlpha, privateBeta]
            .map(text => checkDecoders(buffers, text));
        console.log(JSON.stringify({ knownMessagesRecovered: recovered }, null, 2));
        assert.ok(tap.total > beforeMessages, 'Observed wire bytes must increase during delivery');
        assert.ok(recovered.every(result => Object.values(result).every(found => !found)),
            'The passive observer recovered a synthetic message');
        await quit(guest);
        await quit(source);
        return {
            route: 'Direct TCP loopback through a byte-preserving observer',
            controls,
            connections: buffers.length / 2,
            totalBytes: buffers.reduce((sum, bytes) => sum + bytes.length, 0),
            additionalBytesDuringMessaging: buffers.reduce((sum, bytes) => sum + bytes.length, 0) - beforeMessages,
            receivedPublicMessages: 2,
            receivedWhispers: 2,
            recoveredMessageMarkers: 0,
            visibleNoiseProtocolSelector: buffers.some(bytes => bytes.includes(Buffer.from('/noise')))
        };
    } finally {
        await tap.close();
    }
}

module.exports = { observeDirectEncryption };
