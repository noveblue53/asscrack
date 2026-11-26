import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createMobileBridge } from '../src/application/mobile-bridge.mjs';
import { createRoomMedia } from '../src/application/room-media.mjs';

function httpsReq(url, { method = 'GET', headers = {}, body = null, ca } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers, ca }, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                });
            });
        });
        req.on('error', reject);
        if (body !== null) req.write(body);
        req.end();
    });
}

function fakePngBytes() {
    // Minimal 1x1 PNG header + bytes for roomMedia previewBytes mock
    return Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89
    ]);
}

test('mobile bridge: lifecycle, pairing, SSE, POST actions, media auth gating, room-switch guard, revocation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bridge-'));
    let voiceActive = false;
    let screenActive = false;
    const sentMessages = [];
    const sentWhispers = [];
    const typingStates = [];
    const openedRooms = [];

    const roomMedia = createRoomMedia({});
    const imgDescriptor = {
        id: 'att-1',
        kind: 'image',
        name: 'pic.png',
        size: 33,
        sha256: 'a'.repeat(64)
    };
    const png = fakePngBytes();

    const bridge = createMobileBridge({
        dir,
        bindHost: '127.0.0.1',
        selectLanIp: () => '127.0.0.1',
        portMapperFactory: () => ({
            map: async () => {},
            externalIp: async () => '203.0.113.10',
            unmap: async () => {},
            close: async () => {}
        }),
        getState: () => ({
            savedRooms: [{ roomId: 'r1', name: 'Lounge', protected: true }],
            activeRoom: { roomId: 'r1', name: 'Lounge', topic: 'Welcome' },
            channels: [{ id: 'general', name: 'general' }],
            activeChannelId: 'general',
            messages: [{ id: 'm1', from: 'Host', text: 'hi', time: 1000, channelId: 'general' }],
            members: [{ peerId: 'p1', name: 'Host', isHost: true }],
            roomSwitchBlocked: voiceActive || screenActive,
            blockReason: voiceActive ? 'Voice active' : screenActive ? 'Screen share active' : null
        }),
        openRoom: async roomId => {
            if (voiceActive || screenActive) return { blocked: true, reason: 'Blocked by active call or share' };
            openedRooms.push(roomId);
            return { ok: true };
        },
        sendMessage: ({ text, channelId }) => {
            sentMessages.push({ text, channelId });
            return { id: 'm2', text, channelId, time: 2000 };
        },
        sendWhisper: ({ peerId, text }) => {
            sentWhispers.push({ peerId, text });
            return 'sent';
        },
        sendTyping: active => {
            typingStates.push(active);
        },
        getMediaPreview: async ({ id }) => (id === imgDescriptor.id ? { bytes: png, mime: 'image/png' } : null)
    });

    try {
        // Off by default
        await bridge.init();
        assert.equal(bridge.getStatus().running, false);

        // Toggle ON
        const started = await bridge.setEnabled(true);
        assert.equal(started.running, true);
        const port = started.port;
        // Wait briefly for background UPnP discovery to update cert SANs with externalIp
        for (let i = 0; i < 40 && bridge.getStatus().upnpStatus === 'mapping'; i++) {
            await new Promise(r => setTimeout(r, 15));
        }
        const certPem = JSON.parse(fs.readFileSync(path.join(dir, 'cert.json'), 'utf8')).certPem;
        const x509 = new crypto.X509Certificate(certPem);
        assert.match(x509.subjectAltName, /IP Address:203\.0\.113\.10/);
        const base = `https://127.0.0.1:${port}`;

        // Unauthenticated media & API requests must be rejected with 401
        const unauthMedia = await httpsReq(`${base}/api/media/${imgDescriptor.id}`, { ca: certPem });
        assert.equal(unauthMedia.status, 401);

        // Pair using QR token
        const pairing = bridge.getPairingInfo();
        assert.ok(pairing?.lanUrl && pairing.lanQrSvg.includes('<svg'));
        const token = new URL(pairing.lanUrl).searchParams.get('t');

        const pairRes = await httpsReq(`${base}/api/pair`, {
            method: 'POST',
            ca: certPem,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, label: 'Test Phone' })
        });
        assert.equal(pairRes.status, 200);
        const cookie = pairRes.headers['set-cookie']?.[0]?.split(';')[0];
        assert.ok(cookie?.startsWith('asscrack_mobile='));

        // Open SSE stream and receive snapshot + live event
        const sseEvents = [];
        const sseEnded = new Promise(resolve => {
            const req = https.request(`${base}/api/events`, {
                headers: { Cookie: cookie },
                ca: certPem
            }, res => {
                assert.equal(res.statusCode, 200);
                let buf = '';
                res.on('data', chunk => {
                    buf += chunk.toString('utf8');
                    let idx;
                    while ((idx = buf.indexOf('\n\n')) !== -1) {
                        const frame = buf.slice(0, idx);
                        buf = buf.slice(idx + 2);
                        const evMatch = /^event: (.+)$/m.exec(frame);
                        const dataMatch = /^data: (.+)$/m.exec(frame);
                        if (evMatch && dataMatch) {
                            sseEvents.push({ event: evMatch[1], data: JSON.parse(dataMatch[1]) });
                        }
                    }
                });
                res.on('end', resolve);
                res.on('close', resolve);
            });
            req.end();
        });

        // Wait for initial snapshot
        while (sseEvents.length === 0) await new Promise(r => setTimeout(r, 20));
        assert.equal(sseEvents[0].event, 'snapshot');
        assert.equal(sseEvents[0].data.activeRoom.name, 'Lounge');

        // Live broadcast
        bridge.broadcast('message', { id: 'm99', from: 'Desktop', text: 'hello phone' });
        while (!sseEvents.some(e => e.event === 'message')) await new Promise(r => setTimeout(r, 20));

        // Authenticated POST actions
        const msgRes = await httpsReq(`${base}/api/messages`, {
            method: 'POST',
            ca: certPem,
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ text: 'from phone', channelId: 'general' })
        });
        assert.equal(msgRes.status, 200);
        assert.deepEqual(sentMessages, [{ text: 'from phone', channelId: 'general' }]);

        const whRes = await httpsReq(`${base}/api/whispers`, {
            method: 'POST',
            ca: certPem,
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ peerId: 'p1', text: 'psst' })
        });
        assert.equal(whRes.status, 200);
        assert.deepEqual(sentWhispers, [{ peerId: 'p1', text: 'psst' }]);

        const typRes = await httpsReq(`${base}/api/typing`, {
            method: 'POST',
            ca: certPem,
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ active: true })
        });
        assert.equal(typRes.status, 200);
        assert.deepEqual(typingStates, [true]);

        // Authenticated media preview
        const authMedia = await httpsReq(`${base}/api/media/${imgDescriptor.id}`, {
            ca: certPem,
            headers: { Cookie: cookie }
        });
        assert.equal(authMedia.status, 200);
        assert.equal(authMedia.headers['content-type'], 'image/png');
        assert.deepEqual(authMedia.body, png);
        assert.ok(roomMedia);

        // Room switch allowed when idle, blocked when voice or screen share active
        const openOk = await httpsReq(`${base}/api/rooms/open`, {
            method: 'POST',
            ca: certPem,
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ roomId: 'r2' })
        });
        assert.equal(openOk.status, 200);
        assert.deepEqual(openedRooms, ['r2']);

        voiceActive = true;
        const openBlockedVoice = await httpsReq(`${base}/api/rooms/open`, {
            method: 'POST',
            ca: certPem,
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ roomId: 'r3' })
        });
        assert.equal(openBlockedVoice.status, 409);

        voiceActive = false;
        screenActive = true;
        const openBlockedScreen = await httpsReq(`${base}/api/rooms/open`, {
            method: 'POST',
            ca: certPem,
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ roomId: 'r3' })
        });
        assert.equal(openBlockedScreen.status, 409);

        // Revoking device closes active SSE stream immediately
        const devId = bridge.getStatus().devices[0].id;
        bridge.revokeDevice(devId);
        await sseEnded;
        assert.ok(sseEvents.some(e => e.event === 'revoked'));

        // Turning bridge off stops listener
        const stopped = await bridge.setEnabled(false);
        assert.equal(stopped.running, false);
    } finally {
        await bridge.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
