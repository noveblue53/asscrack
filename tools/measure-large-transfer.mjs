// node tools/measure-large-transfer.mjs direct|relay /path/to/representative-file
// Uses a temporary download directory, real loopback TCP, and the production file protocol.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAsscrackNode } from '../src/network/node.mjs';
import { newRoomKey } from '../src/network/invite.mjs';

const [route, original] = process.argv.slice(2);
if (!['direct', 'relay'].includes(route) || !original) throw Error('Usage: node tools/measure-large-transfer.mjs direct|relay <file>');
const size = statSync(original).size;
assert.ok(size > 0, 'Expected a nonempty original');
const relayed = route === 'relay';
const listen = ['/ip4/127.0.0.1/tcp/0'];
const room = { room: 'transfer-measurement', roomKey: newRoomKey(), discovery: false, upnp: false };
const downloadDir = await mkdtemp(path.join(os.tmpdir(), 'ac-bench-'));
const nodes = [];
const now = () => performance.now();
const elapsed = start => Math.round(now() - start);
const highWaterKiB = () => process.resourceUsage().maxRSS;
const localAddress = node => node.getMultiaddrs().find(address => address.startsWith('/ip4/127.0.0.1/') && !address.includes('p2p-circuit'));

function loopbackTx() {
    // Linux interface count, including ACKs, framing and both legs of a relayed route. Run in a quiet namespace.
    try { return Number(readFileSync('/proc/net/dev', 'utf8').match(/^\s*lo:\s*(.*)$/m)[1].trim().split(/\s+/)[8]); }
    catch { return null; }
}
async function waitFor(test, label, milliseconds = 60000) {
    for (const end = now() + milliseconds; now() < end;) {
        if (await test()) return;
        await delay(25);
    }
    throw Error('Timed out waiting for ' + label);
}
async function member(options) {
    const node = await createAsscrackNode({ ...room, ...options });
    nodes.push(node);
    return node;
}
async function digest(file) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest('hex');
}
try {
    const relay = relayed ? await member({ listen, fullNode: true }) : null;
    const options = relayed ? { relayOnly: true, fullNode: false } : { listen, fullNode: false };
    const sender = await member(options);
    const receiver = await member({ ...options, downloadDir });
    if (relay) {
        await sender.connect(localAddress(relay));
        await receiver.connect(localAddress(relay));
    } else await receiver.connect(localAddress(sender));
    const connected = () => sender.peers().includes(receiver.peerId) && receiver.peers().includes(sender.peerId);
    const connections = () => receiver.libp2p.getConnections().filter(c => c.remotePeer.toString() === sender.peerId && c.status === 'open');
    const results = [];
    for (const cut of [true, false]) {
        await waitFor(connected, 'authenticated room session');
        const paths = connections().map(c => c.remoteAddr.toString());
        assert.ok(paths.length > 0 && paths.every(addr => addr.includes('/p2p-circuit') === relayed && addr.includes('127.0.0.1')));
        const result = { mode: cut ? 'interrupt' : 'fresh-retry', route, paths, size,
            receiverBytes: 0, senderLastProgressBytes: 0 };
        let senderOutcome, receiverOutcome, began, cutTime;
        const start = now();
        const initialTx = loopbackTx();
        const offer = ({ offerId }) => { began = now(); assert.ok(receiver.acceptFile(offerId)); };
        const sent = e => { result.senderLastProgressBytes = e.bytes; };
        const received = e => {
            result.receiverBytes = e.bytes;
            if (cut && !cutTime && e.bytes >= .4 * size) {
                cutTime = now();
                result.receiverBytesAtCut = e.bytes;
                result.diskBytesAtCut = statSync(path.join(downloadDir, '.asscrack-' + e.offerId + '.part')).size;
                for (const c of connections()) c.abort(Error('Loopback transfer interrupted'));
            }
        };
        const finishSend = e => { senderOutcome = e; };
        const finishReceive = e => { receiverOutcome = e; };
        receiver.events.on('file-offer', offer);
        sender.events.on('file-progress', sent);
        receiver.events.on('file-progress', received);
        for (const type of ['file-failed', 'file-done']) {
            sender.events.on(type, finishSend); receiver.events.on(type, finishReceive);
        }
        const offered = await sender.offerFile(original, receiver.peerId);
        await waitFor(() => senderOutcome && receiverOutcome, 'transfer outcome', 15 * 60000);
        result.offerToOutcomeMs = elapsed(start);
        result.acceptToOutcomeMs = elapsed(began);
        const finalTx = loopbackTx();
        if (initialTx !== null && finalTx !== null) result.loopbackTxBytes = finalTx - initialTx;
        result.senderOutcome = senderOutcome.reason ?? (senderOutcome.confirmed ? 'confirmed' : 'unconfirmed');
        result.receiverOutcome = receiverOutcome.reason ?? 'saved';
        result.senderReceiverRelayProcessPeakKiB = highWaterKiB();
        for (const type of ['file-failed', 'file-done']) {
            sender.events.off(type, finishSend); receiver.events.off(type, finishReceive);
        }
        sender.events.off('file-progress', sent);
        receiver.events.off('file-progress', received);
        receiver.events.off('file-offer', offer);
        if (cut) {
            assert.ok(cutTime && senderOutcome.reason && receiverOutcome.reason);
            result.acceptToCutMs = Math.round(cutTime - began);
            await waitFor(async () => !(await readdir(downloadDir)).length, 'partial cleanup');
            result.remainingFiles = await readdir(downloadDir);
            if (!relay && !connected()) await receiver.connect(localAddress(sender));
        } else {
            assert.equal(senderOutcome.confirmed, true);
            assert.equal(result.senderLastProgressBytes, size);
            assert.equal(result.receiverBytes, size);
            assert.equal(statSync(receiverOutcome.path).size, size);
            result.sha256 = await digest(receiverOutcome.path);
            assert.equal(result.sha256, offered.sha256);
        }
        console.log('127.0.0.1 ' + JSON.stringify(result));
        results.push(result);
    }
    assert.equal(results.length, 2);
} finally {
    await Promise.allSettled(nodes.map(node => node.stop()));
    await rm(downloadDir, { recursive: true, force: true });
}
