// Pure-JS persistent self-signed X.509 certificate generator for the desktop-hosted HTTPS bridge.
// Generates an ECDSA P-256 certificate with SANs so mobile browsers only accept the cert warning once.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const CERT_FILE = 'cert.json';
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

function derLength(len) {
    if (len < 0x80) return Buffer.from([len]);
    const bytes = [];
    let n = len;
    while (n > 0) {
        bytes.unshift(n & 0xff);
        n >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag, body) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return Buffer.concat([Buffer.from([tag]), derLength(buf.length), buf]);
}

function derInt(value) {
    let buf;
    if (typeof value === 'number') {
        if (value === 0) return derTag(0x02, Buffer.from([0]));
        const bytes = [];
        let n = value;
        while (n > 0) {
            bytes.unshift(n & 0xff);
            n >>= 8;
        }
        buf = Buffer.from(bytes);
    } else {
        buf = Buffer.from(value);
        let i = 0;
        while (i < buf.length - 1 && buf[i] === 0 && (buf[i + 1] & 0x80) === 0) i++;
        buf = buf.subarray(i);
    }
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
    return derTag(0x02, buf);
}

function derOid(oid) {
    const parts = oid.split('.').map(Number);
    const out = [parts[0] * 40 + parts[1]];
    for (let i = 2; i < parts.length; i++) {
        let v = parts[i];
        if (v < 0x80) {
            out.push(v);
            continue;
        }
        const enc = [v & 0x7f];
        v >>= 7;
        while (v > 0) {
            enc.unshift((v & 0x7f) | 0x80);
            v >>= 7;
        }
        out.push(...enc);
    }
    return derTag(0x06, Buffer.from(out));
}

function derBitString(bytes, unusedBits = 0) {
    return derTag(0x03, Buffer.concat([Buffer.from([unusedBits]), Buffer.from(bytes)]));
}

function derOctetString(bytes) {
    return derTag(0x04, bytes);
}

function derUtf8(str) {
    return derTag(0x0c, Buffer.from(str, 'utf8'));
}

function derIa5(str) {
    return derTag(0x16, Buffer.from(str, 'ascii'));
}

function derBool(val) {
    return derTag(0x01, Buffer.from([val ? 0xff : 0x00]));
}

function derSeq(items) {
    return derTag(0x30, Buffer.concat(items));
}

function derSet(items) {
    return derTag(0x31, Buffer.concat(items));
}

function derContext(tagNum, inner, constructed = true) {
    return derTag((constructed ? 0xa0 : 0x80) | tagNum, inner);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function derTime(date) {
    const year = date.getUTCFullYear();
    const rest =
        pad2(date.getUTCMonth() + 1) +
        pad2(date.getUTCDate()) +
        pad2(date.getUTCHours()) +
        pad2(date.getUTCMinutes()) +
        pad2(date.getUTCSeconds()) +
        'Z';
    if (year >= 1950 && year < 2050) {
        return derTag(0x17, Buffer.from(pad2(year % 100) + rest, 'ascii'));
    }
    return derTag(0x18, Buffer.from(String(year).padStart(4, '0') + rest, 'ascii'));
}

function parseIpv4Bytes(ip) {
    return Buffer.from(ip.split('.').map(Number));
}

function parseIpv6Bytes(ip) {
    const [head, tail] = ip.split('::');
    const headParts = head ? head.split(':').filter(Boolean) : [];
    const tailParts = tail !== undefined ? tail.split(':').filter(Boolean) : [];
    const expandEmbedded = parts => {
        const out = [];
        for (const p of parts) {
            if (p.includes('.')) {
                const b = parseIpv4Bytes(p);
                out.push(((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16));
            } else {
                out.push(p);
            }
        }
        return out;
    };
    const h = expandEmbedded(headParts);
    const t = expandEmbedded(tailParts);
    const missing = tail !== undefined ? Math.max(0, 8 - h.length - t.length) : 0;
    const groups = [...h, ...Array(missing).fill('0'), ...t];
    const buf = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) {
        buf.writeUInt16BE(parseInt(groups[i] || '0', 16), i * 2);
    }
    return buf;
}

/**
 * Normalize and deduplicate SAN entries (always including loopback SANs).
 */
export function normalizeSans(sans = []) {
    const seen = new Set();
    const out = [];
    const add = raw => {
        if (typeof raw !== 'string') return;
        const val = raw.trim().replace(/^\[|\]$/g, '');
        if (!val) return;
        const key = net.isIP(val) ? val.toLowerCase() : val.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(key);
    };
    add('127.0.0.1');
    add('::1');
    add('localhost');
    for (const s of sans) add(s);
    return out;
}

function encodeSanExtension(sans) {
    const entries = [];
    for (const entry of sans) {
        const ipVer = net.isIP(entry);
        if (ipVer === 4) {
            entries.push(derContext(7, parseIpv4Bytes(entry), false));
        } else if (ipVer === 6) {
            entries.push(derContext(7, parseIpv6Bytes(entry), false));
        } else {
            entries.push(derContext(2, Buffer.from(entry, 'ascii'), false));
        }
    }
    return derSeq([derOid('2.5.29.17'), derOctetString(derSeq(entries))]);
}

function toPem(label, der) {
    const b64 = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * Generate a self-signed ECDSA P-256 X.509 v3 certificate in pure JS using Node crypto.
 */
export function generateSelfSignedCert({ sans = [], now = new Date(), validityDays = 397 } = {}) {
    const normalizedSans = normalizeSans(sans);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

    const serial = crypto.randomBytes(16);
    serial[0] = (serial[0] & 0x7f) | 0x01;

    const sigAlg = derSeq([derOid('1.2.840.10045.4.3.2')]); // ecdsa-with-SHA256
    const rdn = derSeq([derSet([derSeq([derOid('2.5.4.3'), derUtf8('ASSCRACK Mobile Bridge')])])]);

    const notBefore = new Date(now.getTime() - 5 * 60 * 1000);
    const notAfter = new Date(now.getTime() + validityDays * 86400 * 1000);
    const validity = derSeq([derTime(notBefore), derTime(notAfter)]);

    const extBasicConstraints = derSeq([
        derOid('2.5.29.19'),
        derBool(true),
        derOctetString(derSeq([]))
    ]);
    const extKeyUsage = derSeq([
        derOid('2.5.29.15'),
        derBool(true),
        derOctetString(derBitString(Buffer.from([0xa0]), 5))
    ]);
    const extExtKeyUsage = derSeq([
        derOid('2.5.29.37'),
        derOctetString(derSeq([derOid('1.3.6.1.5.5.7.3.1')]))
    ]);
    const extSan = encodeSanExtension(normalizedSans);
    const extensions = derContext(3, derSeq([extBasicConstraints, extKeyUsage, extExtKeyUsage, extSan]), true);

    const tbs = derSeq([
        derContext(0, derInt(2), true),
        derInt(serial),
        sigAlg,
        rdn,
        validity,
        rdn,
        spkiDer,
        extensions
    ]);

    const signature = crypto.sign('sha256', tbs, privateKey);
    const certDer = derSeq([tbs, sigAlg, derBitString(signature, 0)]);
    const certPem = toPem('CERTIFICATE', certDer);
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const parsed = new crypto.X509Certificate(certPem);

    return {
        certPem,
        keyPem,
        sans: normalizedSans,
        fingerprint256: parsed.fingerprint256,
        notAfter: notAfter.toISOString()
    };
}

function writeAtomicJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
}

function certMatchesSans(existingSans, neededSans) {
    const have = new Set(normalizeSans(existingSans));
    return neededSans.every(s => have.has(s));
}

/**
 * Load a persisted self-signed certificate from `dir/cert.json`, or generate and persist a new one
 * if missing, corrupt, near expiry, or missing any requested SAN.
 */
export function ensureMobileCert(dir, { sans = [], now = new Date() } = {}) {
    const filePath = path.join(dir, CERT_FILE);
    const neededSans = normalizeSans(sans);
    try {
        if (fs.existsSync(filePath)) {
            const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (stored?.certPem && stored?.keyPem) {
                const parsed = new crypto.X509Certificate(stored.certPem);
                crypto.createPrivateKey(stored.keyPem);
                const expiresAt = Date.parse(parsed.validTo);
                if (
                    Number.isFinite(expiresAt) &&
                    expiresAt - now.getTime() > RENEW_BEFORE_MS &&
                    certMatchesSans(stored.sans, neededSans)
                ) {
                    return {
                        certPem: stored.certPem,
                        keyPem: stored.keyPem,
                        sans: stored.sans,
                        fingerprint256: parsed.fingerprint256,
                        notAfter: new Date(expiresAt).toISOString(),
                        reused: true
                    };
                }
            }
        }
    } catch {
        // Regenerate if stored cert is unreadable or invalid.
    }

    const created = generateSelfSignedCert({ sans: neededSans, now });
    writeAtomicJson(filePath, created);
    return { ...created, reused: false };
}
