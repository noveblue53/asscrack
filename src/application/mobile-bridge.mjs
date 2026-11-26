// Direct desktop-hosted HTTPS bridge for the Phase 1 Mobile Browser Client.
// Uses node:https with a persistent self-signed X.509 cert, SSE for live push, and fetch POST for actions.
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { selectUpnpLocalIpv4, createPortMapper } from '../network/port-mapper.mjs';
import { ensureMobileCert } from './mobile-cert.mjs';
import { renderQrSvg } from './mobile-qr.mjs';
import { createMobileAuth, clearCookieHeader } from './mobile-auth.mjs';

const PORT_MIN = 41000;
const PORT_MAX = 46999;
const MAX_BODY_BYTES = 64 * 1024;
const KEEPALIVE_MS = 20 * 1000;

const STATIC_FILES = new Map([
    ['/', { file: 'index.html', mime: 'text/html; charset=utf-8', html: true }],
    ['/index.html', { file: 'index.html', mime: 'text/html; charset=utf-8', html: true }],
    ['/pair', { file: 'index.html', mime: 'text/html; charset=utf-8', html: true }],
    ['/styles.css', { file: 'styles.css', mime: 'text/css; charset=utf-8', html: false }],
    ['/transport.js', { file: 'transport.js', mime: 'application/javascript; charset=utf-8', html: false }],
    ['/app.js', { file: 'app.js', mime: 'application/javascript; charset=utf-8', html: false }],
    ['/manifest.json', { file: 'manifest.json', mime: 'application/manifest+json; charset=utf-8', html: false }]
]);

const BASE_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
};

const HTML_CSP =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'";

async function isPortFree(port, host = '0.0.0.0') {
    return new Promise(resolve => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, host, () => srv.close(() => resolve(true)));
    });
}

async function pickFreePort(start = PORT_MIN, end = PORT_MAX) {
    for (let p = start; p <= end; p++) {
        if (await isPortFree(p)) return p;
    }
    throw new Error(`No free TCP port available in ${start}-${end}`);
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const ct = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!ct.includes('application/json')) {
            reject(Object.assign(new Error('Expected application/json'), { status: 415 }));
            return;
        }
        const chunks = [];
        let total = 0;
        let done = false;
        req.on('data', chunk => {
            if (done) return;
            total += chunk.length;
            if (total > maxBytes) {
                done = true;
                reject(Object.assign(new Error('Payload too large'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (done) return;
            done = true;
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
            }
        });
        req.on('error', err => {
            if (!done) {
                done = true;
                reject(err);
            }
        });
    });
}

function sendJson(res, status, data, extraHeaders = {}) {
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    res.writeHead(status, {
        ...BASE_HEADERS,
        ...extraHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(body.length)
    });
    res.end(body);
}

function formatHost(host) {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Create the desktop-hosted HTTPS mobile bridge controller.
 */
export function createMobileBridge({
    dir,
    staticDir = path.resolve(import.meta.dirname, '..', 'mobile'),
    bindHost = '0.0.0.0',
    portMapperFactory = () => createPortMapper(),
    selectLanIp = () => selectUpnpLocalIpv4(),
    getState = () => ({}),
    getMessages = () => [],
    openRoom = async () => ({ ok: false, error: 'Not implemented' }),
    leaveRoom = async () => ({ ok: false, error: 'Not implemented' }),
    sendMessage = async () => { throw new Error('Not in a room'); },
    sendWhisper = async () => { throw new Error('Not in a room'); },
    sendTyping = () => {},
    getMediaPreview = async () => null,
    onStateChanged = () => {},
    log = () => {}
} = {}) {
    const auth = createMobileAuth({ dir });
    const sseClients = new Set(); // { res, deviceId }

    let server = null;
    let listeningPort = null;
    let lanIp = null;
    let externalIp = null;
    let upnpStatus = 'off'; // 'off' | 'mapping' | 'mapped' | 'failed'
    let upnpMapper = null;
    let keepaliveTimer = null;
    let starting = null;
    let stopping = false;

    function clientIp(req) {
        return req.socket?.remoteAddress || 'unknown';
    }

    function sendSse(res, event, data) {
        if (res.writableEnded || res.destroyed) return false;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        return res.write(payload);
    }

    function broadcast(event, data) {
        for (const client of sseClients) {
            sendSse(client.res, event, data);
        }
    }

    function closeAllSse(event = null, data = null) {
        for (const client of [...sseClients]) {
            if (event) sendSse(client.res, event, data ?? {});
            try { client.res.end(); } catch { /* ignore */ }
            sseClients.delete(client);
        }
    }

    function closeDeviceSse(deviceId) {
        for (const client of [...sseClients]) {
            if (client.deviceId !== deviceId) continue;
            sendSse(client.res, 'revoked', { reason: 'Device revoked' });
            try { client.res.end(); } catch { /* ignore */ }
            sseClients.delete(client);
        }
    }

    function notifyChanged() {
        try { onStateChanged(getBridgeStatus()); } catch { /* ignore */ }
    }

    function getBridgeStatus() {
        const cfg = auth.getConfig();
        return {
            enabled: cfg.enabled,
            running: Boolean(server && listeningPort),
            port: listeningPort ?? cfg.port,
            savedPort: cfg.port,
            manualHost: cfg.manualHost,
            manualPort: cfg.manualPort,
            lanIp,
            externalIp,
            upnpStatus,
            devices: auth.listDevices(),
            activeClients: sseClients.size
        };
    }

    function buildPairingInfo() {
        if (!server || !listeningPort) return null;
        const cfg = auth.getConfig();
        const { token, expiresAt } = auth.createPairingToken();
        const lanHost = lanIp || '127.0.0.1';
        const lanUrl = `https://${formatHost(lanHost)}:${listeningPort}/pair?t=${encodeURIComponent(token)}`;
        const lanQrSvg = renderQrSvg(lanUrl);

        let remoteHost = cfg.manualHost || externalIp || '';
        const remotePort = cfg.manualPort || listeningPort;
        let remoteUrl = null;
        let remoteQrSvg = null;
        if (remoteHost) {
            remoteUrl = `https://${formatHost(remoteHost)}:${remotePort}/pair?t=${encodeURIComponent(token)}`;
            remoteQrSvg = renderQrSvg(remoteUrl);
        }

        return {
            lanUrl,
            lanQrSvg,
            remoteUrl,
            remoteQrSvg,
            expiresAt
        };
    }

    async function setupUpnp(port) {
        upnpStatus = 'mapping';
        notifyChanged();
        let mapper;
        try {
            mapper = portMapperFactory();
            upnpMapper = mapper;
            const localAddress = selectLanIp() || undefined;
            await mapper.map({ publicPort: port, localPort: port, localAddress, ttl: 0 });
            if (stopping || !server) {
                await mapper.unmap({ publicPort: port, localPort: port, localAddress }).catch(() => {});
                await mapper.close().catch(() => {});
                return;
            }
            const ext = await mapper.externalIp().catch(() => null);
            if (typeof ext === 'string' && net.isIP(ext)) {
                externalIp = ext;
                const cfg = auth.getConfig();
                const sans = ['127.0.0.1', '::1', 'localhost', lanIp || '127.0.0.1', externalIp];
                if (cfg.manualHost) sans.push(cfg.manualHost);
                const updatedCert = ensureMobileCert(dir, { sans });
                if (!updatedCert.reused && server && !stopping) {
                    server.setSecureContext({ cert: updatedCert.certPem, key: updatedCert.keyPem });
                }
            }
            upnpStatus = 'mapped';
            log('INFO', `Mobile bridge UPnP mapped port ${port}${externalIp ? ` (${externalIp})` : ''}`);
        } catch (err) {
            upnpStatus = 'failed';
            log('WARN', `Mobile bridge UPnP mapping failed: ${err?.message ?? err}`);
        }
        notifyChanged();
    }

    function requireAuth(req, res) {
        const ip = clientIp(req);
        const device = auth.authenticateCookie(req.headers.cookie);
        if (device) return device;
        const limit = auth.checkAuthRateLimit(ip, { consume: true });
        if (!limit.allowed) {
            sendJson(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(limit.retryAfterSeconds) });
            return null;
        }
        sendJson(res, 401, { error: 'Authentication required' });
        return null;
    }

    async function handleRequest(req, res) {
        let url;
        try {
            url = new URL(req.url || '/', 'https://localhost');
        } catch {
            sendJson(res, 400, { error: 'Bad URL' });
            return;
        }

        const method = req.method || 'GET';
        const pathname = url.pathname;

        // Static mobile web UI routes
        if (method === 'GET' && STATIC_FILES.has(pathname)) {
            const spec = STATIC_FILES.get(pathname);
            const filePath = path.join(staticDir, spec.file);
            try {
                const content = fs.readFileSync(filePath);
                const headers = {
                    ...BASE_HEADERS,
                    'Content-Type': spec.mime,
                    'Content-Length': String(content.length)
                };
                if (spec.html) headers['Content-Security-Policy'] = HTML_CSP;
                res.writeHead(200, headers);
                res.end(content);
            } catch {
                sendJson(res, 404, { error: 'Not found' });
            }
            return;
        }

        // Pairing token exchange
        if (method === 'POST' && pathname === '/api/pair') {
            const limit = auth.checkAuthRateLimit(clientIp(req), { consume: true });
            if (!limit.allowed) {
                sendJson(res, 429, { error: 'Too many pairing attempts' }, { 'Retry-After': String(limit.retryAfterSeconds) });
                return;
            }
            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, err.status || 400, { error: err.message });
                return;
            }
            const paired = auth.exchangePairingToken(body?.token, {
                label: body?.label,
                userAgent: req.headers['user-agent']
            });
            if (!paired) {
                sendJson(res, 401, { error: 'Invalid or expired pairing token' });
                return;
            }
            notifyChanged();
            sendJson(
                res,
                200,
                { ok: true, device: paired.device },
                { 'Set-Cookie': paired.setCookieHeader }
            );
            return;
        }

        // All remaining /api/* routes require a valid session cookie
        if (!pathname.startsWith('/api/')) {
            sendJson(res, 404, { error: 'Not found' });
            return;
        }

        const device = requireAuth(req, res);
        if (!device) return;

        if (method === 'GET' && pathname === '/api/session') {
            sendJson(res, 200, { ok: true, device, state: getState() });
            return;
        }

        if (method === 'GET' && pathname === '/api/events') {
            res.writeHead(200, {
                ...BASE_HEADERS,
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            const client = { res, deviceId: device.id };
            sseClients.add(client);
            sendSse(res, 'snapshot', getState());
            req.on('close', () => {
                sseClients.delete(client);
                notifyChanged();
            });
            notifyChanged();
            return;
        }

        if (method === 'GET' && pathname === '/api/rooms') {
            const s = getState();
            sendJson(res, 200, {
                savedRooms: s.savedRooms ?? [],
                activeRoom: s.activeRoom ?? null,
                roomSwitchBlocked: s.roomSwitchBlocked === true,
                blockReason: s.blockReason ?? null
            });
            return;
        }

        if (method === 'POST' && pathname === '/api/rooms/open') {
            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, err.status || 400, { error: err.message });
                return;
            }
            const roomId = typeof body?.roomId === 'string' ? body.roomId.trim() : '';
            if (!roomId || roomId.length > 128) {
                sendJson(res, 400, { error: 'Invalid roomId' });
                return;
            }
            try {
                const result = await openRoom(roomId);
                if (result?.blocked) {
                    sendJson(res, 409, { error: result.reason || 'Room switch blocked while voice or screen share is active' });
                    return;
                }
                sendJson(res, 200, { ok: true, state: getState() });
            } catch (err) {
                sendJson(res, err?.status || 400, { error: err?.message || 'Failed to open room' });
            }
            return;
        }

        if (method === 'POST' && pathname === '/api/rooms/leave') {
            try {
                const result = await leaveRoom();
                if (result?.blocked) {
                    sendJson(res, 409, { error: result.reason || 'Room switch blocked while voice or screen share is active' });
                    return;
                }
                sendJson(res, 200, { ok: true });
            } catch (err) {
                sendJson(res, err?.status || 400, { error: err?.message || 'Failed to leave room' });
            }
            return;
        }

        if (method === 'GET' && pathname === '/api/messages') {
            const channelId = url.searchParams.get('channelId') || 'general';
            try {
                const messages = await getMessages(channelId);
                sendJson(res, 200, { channelId, messages });
            } catch (err) {
                sendJson(res, 400, { error: err?.message || 'Failed to load messages' });
            }
            return;
        }

        if (method === 'POST' && pathname === '/api/messages') {
            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, err.status || 400, { error: err.message });
                return;
            }
            try {
                const record = await sendMessage({
                    text: typeof body?.text === 'string' ? body.text : '',
                    channelId: typeof body?.channelId === 'string' && body.channelId ? body.channelId : 'general'
                });
                sendJson(res, 200, { ok: true, record });
            } catch (err) {
                sendJson(res, err?.status || 400, { error: err?.message || 'Failed to send message' });
            }
            return;
        }

        if (method === 'POST' && pathname === '/api/whispers') {
            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, err.status || 400, { error: err.message });
                return;
            }
            try {
                const result = await sendWhisper({
                    peerId: typeof body?.peerId === 'string' ? body.peerId : '',
                    text: typeof body?.text === 'string' ? body.text : ''
                });
                sendJson(res, 200, { ok: true, result });
            } catch (err) {
                sendJson(res, err?.status || 400, { error: err?.message || 'Failed to send whisper' });
            }
            return;
        }

        if (method === 'POST' && pathname === '/api/typing') {
            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, err.status || 400, { error: err.message });
                return;
            }
            try {
                sendTyping(body?.active === true);
                sendJson(res, 200, { ok: true });
            } catch (err) {
                sendJson(res, 400, { error: err?.message || 'Failed to update typing' });
            }
            return;
        }

        if (method === 'GET' && pathname.startsWith('/api/media/')) {
            const id = decodeURIComponent(pathname.slice('/api/media/'.length));
            if (!id || id.length > 128 || id.includes('/')) {
                sendJson(res, 400, { error: 'Invalid media ID' });
                return;
            }
            const messageId = url.searchParams.get('messageId') || '';
            try {
                const media = await getMediaPreview({ id, messageId });
                if (!media?.bytes?.length) {
                    sendJson(res, 404, { error: 'Media preview unavailable' });
                    return;
                }
                const buf = Buffer.isBuffer(media.bytes) ? media.bytes : Buffer.from(media.bytes);
                res.writeHead(200, {
                    ...BASE_HEADERS,
                    'Content-Type': media.mime || 'image/png',
                    'Content-Length': String(buf.length)
                });
                res.end(buf);
            } catch {
                sendJson(res, 404, { error: 'Media preview unavailable' });
            }
            return;
        }

        if (method === 'POST' && pathname === '/api/logout') {
            auth.revokeDevice(device.id);
            closeDeviceSse(device.id);
            notifyChanged();
            sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader() });
            return;
        }

        sendJson(res, 404, { error: 'Not found' });
    }

    async function start() {
        if (server) return getBridgeStatus();
        if (starting) return starting;
        starting = (async () => {
            stopping = false;
            const cfg = auth.getConfig();
            let port = cfg.port;
            if (!port) {
                port = await pickFreePort();
                auth.setConfig({ port });
            } else if (!(await isPortFree(port))) {
                port = await pickFreePort();
                auth.setConfig({ port });
            }

            lanIp = selectLanIp() || '127.0.0.1';
            const sans = ['127.0.0.1', '::1', 'localhost', lanIp];
            if (cfg.manualHost) sans.push(cfg.manualHost);
            const cert = ensureMobileCert(dir, { sans });

            const srv = https.createServer({ cert: cert.certPem, key: cert.keyPem }, (req, res) => {
                void handleRequest(req, res);
            });
            await new Promise((resolve, reject) => {
                srv.once('error', reject);
                srv.listen(port, bindHost, () => {
                    srv.off('error', reject);
                    resolve();
                });
            });
            server = srv;
            listeningPort = srv.address().port;
            keepaliveTimer = setInterval(() => {
                for (const client of sseClients) {
                    if (!client.res.writableEnded && !client.res.destroyed) {
                        client.res.write(': keepalive\n\n');
                    }
                }
            }, KEEPALIVE_MS);
            keepaliveTimer.unref?.();

            log('INFO', `Mobile bridge HTTPS listening on ${bindHost}:${listeningPort}`);
            notifyChanged();

            // Best-effort UPnP port mapping in background
            void setupUpnp(listeningPort);
            return getBridgeStatus();
        })().finally(() => {
            starting = null;
        });
        return starting;
    }

    async function stop() {
        stopping = true;
        if (starting) {
            try { await starting; } catch { /* ignore */ }
        }
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
        auth.clearPairingTokens();
        closeAllSse('bridge-stopped', { reason: 'Mobile bridge turned off' });

        const srv = server;
        const port = listeningPort;
        server = null;
        listeningPort = null;

        if (srv) {
            srv.closeAllConnections?.();
            await new Promise(resolve => srv.close(() => resolve()));
        }

        const mapper = upnpMapper;
        upnpMapper = null;
        upnpStatus = 'off';
        if (mapper) {
            if (port) await mapper.unmap({ publicPort: port, localPort: port, localAddress: lanIp || undefined }).catch(() => {});
            await mapper.close().catch(() => {});
        }
        notifyChanged();
        return getBridgeStatus();
    }

    async function setEnabled(enabled) {
        const next = Boolean(enabled);
        auth.setConfig({ enabled: next });
        if (next) return start();
        return stop();
    }

    async function setConfig(patch = {}) {
        const prev = auth.getConfig();
        const next = auth.setConfig(patch);
        const needsRestart =
            server &&
            (prev.port !== next.port || prev.manualHost !== next.manualHost);
        if (needsRestart) {
            await stop();
            if (next.enabled) await start();
        } else {
            notifyChanged();
        }
        return getBridgeStatus();
    }

    function revokeDevice(id) {
        const ok = auth.revokeDevice(id);
        if (ok) {
            closeDeviceSse(id);
            notifyChanged();
        }
        return ok;
    }

    function revokeAllDevices() {
        const ids = auth.revokeAllDevices();
        for (const id of ids) closeDeviceSse(id);
        if (ids.length > 0) notifyChanged();
        return ids;
    }

    async function init() {
        if (auth.getConfig().enabled) {
            try {
                await start();
            } catch (err) {
                log('WARN', `Mobile bridge failed to auto-start: ${err?.message ?? err}`);
            }
        }
        return getBridgeStatus();
    }

    return {
        init,
        start,
        stop,
        setEnabled,
        setConfig,
        getStatus: getBridgeStatus,
        getPairingInfo: buildPairingInfo,
        revokeDevice,
        revokeAllDevices,
        broadcast,
        // Exposed for unit testing
        _auth: auth
    };
}
