// P9C: the signed update manifest (update.json and update.json.sig of a GitHub release). This module has no electron
// import and no network: the updater (updater.mjs), the sign script (tools/sign-update.mjs), the peer line
// (src/network/update-spread.mjs gives the bytes to main) and the tests use it.
//
// Trust rule: the app trusts only the Ed25519 signature of the operator (the public key is in update-key.mjs). It does
// not trust GitHub, TLS or a peer for the content. The signature covers the exact bytes of update.json. The app checks
// the size limit first, then the signature, then it parses the JSON. A file is good only when its size and SHA-256
// agree with the signed manifest.
import { createHash, createPublicKey, verify } from 'node:crypto';

export const PRODUCT = 'ASSCRACK';
export const MANIFEST_FORMAT = 1;
export const MAX_MANIFEST_BYTES = 8192;
export const MAX_SIGNATURE_TEXT = 200;
export const MAX_NOTES = 2000;
// The largest executable that the app downloads (the 0.8.0 portable file is about 90 MB).
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const KINDS = Object.freeze(['setup', 'portable']);

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// A semantic version (major.minor.patch with an optional pre-release part). No build part ("+"), at most 64 chars.
export function parseVersion(text) {
    if (typeof text !== 'string' || text.length > 64) return null;
    const m = VERSION.exec(text);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

// The order of semantic versioning 2.0: 1.0.0-test < 1.0.0 < 1.0.1-test < 1.0.1. Returns -1, 0 or 1.
// An invalid version gives an error (the caller checks with parseVersion first).
export function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) throw new TypeError('Not a valid version');
    for (const part of ['major', 'minor', 'patch']) {
        if (x[part] !== y[part]) return x[part] < y[part] ? -1 : 1;
    }
    if (x.pre.length === 0 || y.pre.length === 0) {
        if (x.pre.length === y.pre.length) return 0;
        return x.pre.length === 0 ? 1 : -1;
    }
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        if (i >= x.pre.length) return -1;
        if (i >= y.pre.length) return 1;
        const p = x.pre[i];
        const q = y.pre[i];
        const pn = /^\d+$/.test(p);
        const qn = /^\d+$/.test(q);
        if (pn && qn) {
            const d = Number(p) - Number(q);
            if (d !== 0) return d < 0 ? -1 : 1;
        } else if (pn !== qn) {
            return pn ? -1 : 1;
        } else if (p !== q) {
            return p < q ? -1 : 1;
        }
    }
    return 0;
}

// The exact file name of each executable of a release (package.json artifactName of the portable and nsis targets).
export function fileName(version, kind) {
    if (!KINDS.includes(kind) || !parseVersion(version)) throw new TypeError('Not a valid file kind or version');
    return `${PRODUCT}-${version}-${kind}.exe`;
}

// The name of the download copy of each executable (the same bytes as fileName). The updater downloads this copy, and
// the release page counts only the fileName downloads as installs. The download copy of the installer is
// ASSCRACK-<v>-update.exe, of the portable file ASSCRACK-<v>-portable-update.exe.
export function updateFileName(version, kind) {
    if (!KINDS.includes(kind) || !parseVersion(version)) throw new TypeError('Not a valid file kind or version');
    return `${PRODUCT}-${version}-${kind === 'setup' ? 'update' : 'portable-update'}.exe`;
}

// The file name that the updater downloads for a manifest entry. The 1.0.1 to 1.0.4 clients ignore "download" and
// download "name". The local copy always has the name "name".
export function downloadName(entry) {
    return entry.download ?? entry.name;
}

// The public key: the base64url text of the 32 raw bytes of an Ed25519 key (JWK "x").
export function publicKeyObject(raw) {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new TypeError('Not a valid update public key');
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

function signatureBytes(text) {
    const value = String(text ?? '').trim();
    if (value.length === 0 || value.length > MAX_SIGNATURE_TEXT || !BASE64.test(value)) return null;
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === 64 ? bytes : null;
}

function checkFields(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
    if (value.product !== PRODUCT) return 'wrong product';
    if (value.format !== MANIFEST_FORMAT) return 'unknown format';
    if (!parseVersion(value.version)) return 'bad version';
    if (typeof value.date !== 'string' || !DATE.test(value.date)) return 'bad date';
    if (typeof value.notes !== 'string' || value.notes.length > MAX_NOTES) return 'bad notes';
    const files = value.files;
    if (files === null || typeof files !== 'object' || Array.isArray(files)) return 'bad files';
    const kinds = Object.keys(files);
    if (kinds.length === 0 || kinds.some(kind => !KINDS.includes(kind))) return 'bad files';
    for (const kind of kinds) {
        const file = files[kind];
        if (file === null || typeof file !== 'object') return 'bad file';
        if (file.name !== fileName(value.version, kind)) return 'bad file name';
        if (file.download !== undefined && file.download !== updateFileName(value.version, kind)) return 'bad download name';
        if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES) return 'bad file size';
        if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) return 'bad file hash';
    }
    return null;
}

// Check a manifest. bytes: the exact bytes of update.json (a Buffer, or the UTF-8 text from a peer).
// signature: the text of update.json.sig (base64). currentVersion: the version of this app.
// Returns { ok: true, manifest, text, signature } or { ok: false, reason }. With newerOnly false, a manifest of the
// same or a lower version is good too (the app keeps the manifest of its own version for the peers).
export function verifyManifest(bytes, signature, { publicKey, currentVersion, newerOnly = true }) {
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    if (!Buffer.isBuffer(data)) return { ok: false, reason: 'no manifest' };
    if (data.length === 0 || data.length > MAX_MANIFEST_BYTES) return { ok: false, reason: 'manifest size' };
    const sig = signatureBytes(signature);
    if (!sig) return { ok: false, reason: 'bad signature' };
    let key;
    try {
        key = typeof publicKey === 'string' ? publicKeyObject(publicKey) : publicKey;
        if (!verify(null, data, key, sig)) return { ok: false, reason: 'bad signature' };
    } catch {
        return { ok: false, reason: 'bad signature' };
    }
    let text;
    let value;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
        value = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'not JSON' };
    }
    // A peer sends the text. The bytes of the text must be the signed bytes.
    if (!Buffer.from(text, 'utf8').equals(data)) return { ok: false, reason: 'not UTF-8' };
    const bad = checkFields(value);
    if (bad) return { ok: false, reason: bad };
    if (newerOnly) {
        if (!parseVersion(currentVersion)) return { ok: false, reason: 'bad own version' };
        if (compareVersions(value.version, currentVersion) <= 0) return { ok: false, reason: 'not newer' };
    }
    return { ok: true, manifest: value, text, signature: sig.toString('base64') };
}

// A downloaded file is good only when its size and its SHA-256 agree with the signed manifest entry.
export function fileMatches(entry, size, sha256) {
    return !!entry && Number.isSafeInteger(size) && size === entry.size && typeof sha256 === 'string' &&
        sha256.toLowerCase() === entry.sha256;
}

export function sha256Hex(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}
