// Pairing tokens, per-device hashed session cookies, persistent config/devices, and auth rate limiting.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const COOKIE_NAME = 'asscrack_mobile';
const STATE_FILE = 'state.json';
const MAX_PAIRING_TOKENS = 16;
const LAST_SEEN_PERSIST_MS = 60 * 1000;

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingEqualHex(aHex, bHex) {
    if (typeof aHex !== 'string' || typeof bHex !== 'string' || aHex.length !== bHex.length) return false;
    return crypto.timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'));
}

function writeAtomicJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
}

export function deriveDeviceLabel(explicitLabel, userAgent) {
    const clean = typeof explicitLabel === 'string' ? explicitLabel.trim().slice(0, 64) : '';
    if (clean) return clean;
    const ua = String(userAgent ?? '');
    let os = 'Mobile';
    if (/iPhone/i.test(ua)) os = 'iPhone';
    else if (/iPad/i.test(ua)) os = 'iPad';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Macintosh|Mac OS X/i.test(ua)) os = 'Mac';
    else if (/Linux/i.test(ua)) os = 'Linux';

    let browser = 'Browser';
    if (/CriOS|Chrome/i.test(ua) && !/Edg/i.test(ua)) browser = 'Chrome';
    else if (/FxiOS|Firefox/i.test(ua)) browser = 'Firefox';
    else if (/Safari/i.test(ua) && /AppleWebKit/i.test(ua)) browser = 'Safari';
    else if (/Edg/i.test(ua)) browser = 'Edge';
    return `${os} (${browser})`;
}

export function parseCookies(cookieHeader) {
    const out = Object.create(null);
    if (typeof cookieHeader !== 'string' || !cookieHeader) return out;
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const name = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (!name) continue;
        try {
            out[name] = decodeURIComponent(val);
        } catch {
            out[name] = val;
        }
    }
    return out;
}

export function clearCookieHeader() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function sanitizeManualHost(host) {
    if (typeof host !== 'string') return '';
    return host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').slice(0, 253);
}

function sanitizePort(port, allowZero = false) {
    if (port === null || port === undefined || port === '') return allowZero ? 0 : null;
    const n = Number(port);
    if (!Number.isInteger(n)) return allowZero ? 0 : null;
    if (allowZero && n === 0) return 0;
    if (n < 1 || n > 65535) return allowZero ? 0 : null;
    return n;
}

function defaultState() {
    return {
        enabled: false,
        port: 0,
        manualHost: '',
        manualPort: null,
        devices: []
    };
}

/**
 * Manage persistent mobile bridge configuration, single-use pairing tokens,
 * hashed session cookies, device revocation, and per-IP auth rate limiting.
 */
export function createMobileAuth({
    dir,
    pairingTtlMs = 5 * 60 * 1000,
    maxAttempts = 10,
    windowMs = 60 * 1000,
    now = () => Date.now()
} = {}) {
    const statePath = path.join(dir, STATE_FILE);
    const pairingTokens = new Map(); // token -> { expiresAt }
    const rateLimits = new Map(); // ip -> { count, resetAt }
    let lastSeenSavedAt = 0;

    let state = loadState();

    function loadState() {
        try {
            if (!fs.existsSync(statePath)) return defaultState();
            const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            const devices = Array.isArray(raw?.devices)
                ? raw.devices
                      .filter(d => d && typeof d.id === 'string' && typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/i.test(d.tokenHash))
                      .map(d => ({
                          id: d.id,
                          label: String(d.label || 'Mobile Browser').slice(0, 64),
                          tokenHash: d.tokenHash.toLowerCase(),
                          createdAt: Number(d.createdAt) || now(),
                          lastSeenAt: Number(d.lastSeenAt) || Number(d.createdAt) || now()
                      }))
                : [];
            return {
                enabled: raw?.enabled === true,
                port: sanitizePort(raw?.port, true),
                manualHost: sanitizeManualHost(raw?.manualHost),
                manualPort: sanitizePort(raw?.manualPort, false),
                devices
            };
        } catch {
            return defaultState();
        }
    }

    function saveState() {
        writeAtomicJson(statePath, state);
    }

    function pruneExpiredTokens() {
        const t = now();
        for (const [tok, info] of pairingTokens.entries()) {
            if (info.expiresAt <= t) pairingTokens.delete(tok);
        }
    }

    function publicDevice(d) {
        return {
            id: d.id,
            label: d.label,
            createdAt: d.createdAt,
            lastSeenAt: d.lastSeenAt
        };
    }

    function getConfig() {
        return {
            enabled: state.enabled,
            port: state.port,
            manualHost: state.manualHost,
            manualPort: state.manualPort
        };
    }

    function setConfig(patch = {}) {
        let changed = false;
        if (typeof patch.enabled === 'boolean' && patch.enabled !== state.enabled) {
            state.enabled = patch.enabled;
            changed = true;
        }
        if (patch.port !== undefined) {
            const p = sanitizePort(patch.port, true);
            if (p !== state.port) {
                state.port = p;
                changed = true;
            }
        }
        if (patch.manualHost !== undefined) {
            const h = sanitizeManualHost(patch.manualHost);
            if (h !== state.manualHost) {
                state.manualHost = h;
                changed = true;
            }
        }
        if (patch.manualPort !== undefined) {
            const mp = sanitizePort(patch.manualPort, false);
            if (mp !== state.manualPort) {
                state.manualPort = mp;
                changed = true;
            }
        }
        if (changed) saveState();
        return getConfig();
    }

    function listDevices() {
        return state.devices.map(publicDevice);
    }

    function createPairingToken({ ttlMs = pairingTtlMs } = {}) {
        pruneExpiredTokens();
        while (pairingTokens.size >= MAX_PAIRING_TOKENS) {
            const oldest = pairingTokens.keys().next().value;
            pairingTokens.delete(oldest);
        }
        const token = crypto.randomBytes(24).toString('base64url');
        const expiresAt = now() + ttlMs;
        pairingTokens.set(token, { expiresAt });
        return { token, expiresAt };
    }

    function exchangePairingToken(rawToken, { label, userAgent } = {}) {
        pruneExpiredTokens();
        if (typeof rawToken !== 'string' || !rawToken) return null;
        const entry = pairingTokens.get(rawToken);
        if (!entry) return null;
        // Single-use: delete immediately on first attempt.
        pairingTokens.delete(rawToken);
        if (entry.expiresAt <= now()) return null;

        const sessionToken = crypto.randomBytes(32).toString('base64url');
        const tokenHash = sha256Hex(sessionToken);
        const ts = now();
        const device = {
            id: crypto.randomUUID(),
            label: deriveDeviceLabel(label, userAgent),
            tokenHash,
            createdAt: ts,
            lastSeenAt: ts
        };
        state.devices.push(device);
        saveState();

        const setCookieHeader =
            `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
        return {
            device: publicDevice(device),
            sessionToken,
            setCookieHeader
        };
    }

    function authenticateCookie(cookieHeader) {
        const cookies = parseCookies(cookieHeader);
        const token = cookies[COOKIE_NAME];
        if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
        const candidateHash = sha256Hex(token);
        for (const device of state.devices) {
            if (timingEqualHex(candidateHash, device.tokenHash)) {
                const ts = now();
                device.lastSeenAt = ts;
                if (ts - lastSeenSavedAt >= LAST_SEEN_PERSIST_MS) {
                    lastSeenSavedAt = ts;
                    saveState();
                }
                return publicDevice(device);
            }
        }
        return null;
    }

    function revokeDevice(deviceId) {
        const idx = state.devices.findIndex(d => d.id === deviceId);
        if (idx === -1) return false;
        state.devices.splice(idx, 1);
        saveState();
        return true;
    }

    function revokeAllDevices() {
        const ids = state.devices.map(d => d.id);
        if (ids.length === 0) return [];
        state.devices = [];
        saveState();
        return ids;
    }

    function checkAuthRateLimit(ip, { consume = true } = {}) {
        const key = String(ip || 'unknown');
        const ts = now();
        let entry = rateLimits.get(key);
        if (!entry || entry.resetAt <= ts) {
            entry = { count: 0, resetAt: ts + windowMs };
            rateLimits.set(key, entry);
        }
        if (entry.count >= maxAttempts) {
            const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - ts) / 1000));
            return { allowed: false, remaining: 0, retryAfterSeconds };
        }
        if (consume) entry.count++;
        return {
            allowed: true,
            remaining: Math.max(0, maxAttempts - entry.count),
            retryAfterSeconds: 0
        };
    }

    function clearPairingTokens() {
        pairingTokens.clear();
    }

    return {
        getConfig,
        setConfig,
        listDevices,
        createPairingToken,
        exchangePairingToken,
        authenticateCookie,
        revokeDevice,
        revokeAllDevices,
        checkAuthRateLimit,
        clearPairingTokens
    };
}
