import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { ensureMobileCert, generateSelfSignedCert } from '../src/application/mobile-cert.mjs';

test('generateSelfSignedCert creates valid X.509 v3 cert with IP and DNS SANs', () => {
    const generated = generateSelfSignedCert({
        sans: ['192.168.1.42', '203.0.113.5', 'mybox.duckdns.org']
    });
    const x509 = new crypto.X509Certificate(generated.certPem);
    assert.match(x509.subject, /CN=ASSCRACK Mobile Bridge/);
    assert.match(x509.subjectAltName, /IP Address:127\.0\.0\.1/);
    assert.match(x509.subjectAltName, /IP Address:192\.168\.1\.42/);
    assert.match(x509.subjectAltName, /IP Address:203\.0\.113\.5/);
    assert.match(x509.subjectAltName, /DNS:localhost/);
    assert.match(x509.subjectAltName, /DNS:mybox\.duckdns\.org/);
    assert.equal(x509.ca, false);
    assert.equal(x509.verify(crypto.createPublicKey(generated.certPem)), true);
});

test('ensureMobileCert persists and reuses cert unless SANs change or cert nears expiry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cert-'));
    try {
        const first = ensureMobileCert(dir, { sans: ['192.168.1.50'] });
        assert.equal(first.reused, false);
        const second = ensureMobileCert(dir, { sans: ['192.168.1.50'] });
        assert.equal(second.reused, true);
        assert.equal(second.fingerprint256, first.fingerprint256);

        const third = ensureMobileCert(dir, { sans: ['192.168.1.50', '198.51.100.9'] });
        assert.equal(third.reused, false);
        assert.notEqual(third.fingerprint256, first.fingerprint256);

        const srv = https.createServer({ cert: third.certPem, key: third.keyPem }, (_req, res) => {
            res.writeHead(200);
            res.end('ok');
        });
        await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
        const port = srv.address().port;
        try {
            const body = await new Promise((resolve, reject) => {
                https.get(`https://127.0.0.1:${port}/`, { ca: third.certPem }, res => {
                    let out = '';
                    res.on('data', d => { out += d; });
                    res.on('end', () => resolve(out));
                }).on('error', reject);
            });
            assert.equal(body, 'ok');
        } finally {
            await new Promise(resolve => srv.close(resolve));
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
