import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMobileAuth } from '../src/application/mobile-auth.mjs';

test('mobile auth: single-use pairing token, hashed cookie persistence, revocation, and rate limiting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-auth-'));
    let clock = 1_000_000;
    try {
        const auth = createMobileAuth({
            dir,
            pairingTtlMs: 5000,
            maxAttempts: 3,
            windowMs: 10_000,
            now: () => clock
        });

        assert.equal(auth.getConfig().enabled, false);

        // Single-use pairing token
        const { token } = auth.createPairingToken();
        const paired = auth.exchangePairingToken(token, {
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'
        });
        assert.ok(paired);
        assert.equal(paired.device.label, 'iPhone (Safari)');
        assert.match(paired.setCookieHeader, /HttpOnly; Secure; SameSite=Strict/);

        // Replay must fail
        assert.equal(auth.exchangePairingToken(token), null);

        // Expired token must fail
        const expired = auth.createPairingToken();
        clock += 6000;
        assert.equal(auth.exchangePairingToken(expired.token), null);

        // Plaintext token is never written to state.json
        const rawState = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
        assert.equal(rawState.includes(paired.sessionToken), false);

        // Cookie authenticates across reload
        const authReloaded = createMobileAuth({ dir, now: () => clock });
        const dev = authReloaded.authenticateCookie(`asscrack_mobile=${encodeURIComponent(paired.sessionToken)}`);
        assert.equal(dev?.id, paired.device.id);

        // Revoke device
        assert.equal(authReloaded.revokeDevice(paired.device.id), true);
        assert.equal(authReloaded.authenticateCookie(`asscrack_mobile=${encodeURIComponent(paired.sessionToken)}`), null);

        // Revoke all
        const t2 = authReloaded.createPairingToken().token;
        const p2 = authReloaded.exchangePairingToken(t2, { label: 'Pixel' });
        assert.ok(p2);
        assert.deepEqual(authReloaded.revokeAllDevices(), [p2.device.id]);
        assert.equal(authReloaded.listDevices().length, 0);

        // Rate limiting
        assert.equal(auth.checkAuthRateLimit('192.168.1.99').allowed, true);
        assert.equal(auth.checkAuthRateLimit('192.168.1.99').allowed, true);
        assert.equal(auth.checkAuthRateLimit('192.168.1.99').allowed, true);
        const blocked = auth.checkAuthRateLimit('192.168.1.99');
        assert.equal(blocked.allowed, false);
        assert.ok(blocked.retryAfterSeconds >= 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
