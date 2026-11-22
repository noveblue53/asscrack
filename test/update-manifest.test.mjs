// P9C check 1: the trust rules of the signed update manifest (src/application/update-manifest.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { compareVersions, fileMatches, fileName, MAX_MANIFEST_BYTES, parseVersion, verifyManifest } from '../src/application/update-manifest.mjs';
import { UPDATE_PUBLIC_KEY } from '../src/application/update-key.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'jwk' }).x;
const other = generateKeyPairSync('ed25519');
const hash = 'a'.repeat(64);

function manifest(version = '1.0.1', extra = {}) {
    return {
        product: 'ASSCRACK', format: 1, version, date: '2026-12-01', notes: 'Fixes.',
        files: {
            setup: { name: `ASSCRACK-${version}-setup.exe`, size: 1000, sha256: hash },
            portable: { name: `ASSCRACK-${version}-portable.exe`, size: 2000, sha256: hash }
        },
        ...extra
    };
}
const bytesOf = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const signText = (bytes, key = keys.privateKey) => sign(null, bytes, key).toString('base64');
const check = (bytes, sig, currentVersion = '1.0.0', newerOnly = true) =>
    verifyManifest(bytes, sig, { publicKey, currentVersion, newerOnly });

test('the versions sort by semantic versioning, with the pre-release part lower', () => {
    assert.equal(compareVersions('1.0.0-test', '1.0.1-test'), -1);
    assert.equal(compareVersions('1.0.0-test', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
    assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
    assert.equal(parseVersion('1.0'), null);
    assert.equal(parseVersion('01.0.0'), null);
    assert.equal(parseVersion('1.0.0+build'), null);
    assert.equal(parseVersion('1.0.0-' + 'x'.repeat(70)), null);
});

test('a good manifest of a higher version is accepted', () => {
    const bytes = bytesOf(manifest());
    const r = check(bytes, signText(bytes));
    assert.equal(r.ok, true);
    assert.equal(r.manifest.version, '1.0.1');
    assert.equal(r.text, bytes.toString('utf8'));
    // The same text from a peer (a string) is accepted too.
    assert.equal(check(bytes.toString('utf8'), signText(bytes)).ok, true);
});

test('a bad signature, a signature of an other key and a changed byte are refused', () => {
    const bytes = bytesOf(manifest());
    const sig = signText(bytes);
    assert.deepEqual(check(bytes, 'AAAA'), { ok: false, reason: 'bad signature' });
    assert.deepEqual(check(bytes, ''), { ok: false, reason: 'bad signature' });
    assert.deepEqual(check(bytes, signText(bytes, other.privateKey)), { ok: false, reason: 'bad signature' });
    for (const at of [0, 20, bytes.length - 2]) {
        const changed = Buffer.from(bytes);
        changed[at] ^= 0x01;
        assert.deepEqual(check(changed, sig), { ok: false, reason: 'bad signature' }, `byte ${at}`);
    }
    // The size of a file changed in the text (the attacker keeps the old signature).
    const bigger = Buffer.from(bytes.toString('utf8').replace('"size": 1000', '"size": 1001'));
    assert.deepEqual(check(bigger, sig), { ok: false, reason: 'bad signature' });
});

test('a lower and an equal version are refused (no downgrade), and kept only with newerOnly false', () => {
    const equal = bytesOf(manifest('1.0.0'));
    assert.deepEqual(check(equal, signText(equal)), { ok: false, reason: 'not newer' });
    const lower = bytesOf(manifest('0.9.9'));
    assert.deepEqual(check(lower, signText(lower)), { ok: false, reason: 'not newer' });
    const test1 = bytesOf(manifest('1.0.0-test'));
    assert.deepEqual(check(test1, signText(test1)), { ok: false, reason: 'not newer' });
    assert.equal(check(equal, signText(equal), '1.0.0', false).ok, true);
});

test('a manifest above the size limit is refused before the signature check', () => {
    const big = bytesOf(manifest('1.0.1', { notes: 'x'.repeat(MAX_MANIFEST_BYTES) }));
    assert.ok(big.length > MAX_MANIFEST_BYTES);
    assert.deepEqual(check(big, signText(big)), { ok: false, reason: 'manifest size' });
    assert.deepEqual(check(Buffer.alloc(0), 'AAAA'), { ok: false, reason: 'manifest size' });
});

test('a signed manifest with a wrong field is refused (product, file name, size, hash, notes, format)', () => {
    const cases = [
        [{ product: 'OTHER' }, 'wrong product'],
        [{ format: 2 }, 'unknown format'],
        [{ notes: 'x'.repeat(2001) }, 'bad notes'],
        [{ date: 'tomorrow' }, 'bad date'],
        [{ files: {} }, 'bad files'],
        [{ files: { other: { name: 'x', size: 1, sha256: hash } } }, 'bad files'],
        [{ files: { setup: { name: '..\\..\\evil.exe', size: 1, sha256: hash } } }, 'bad file name'],
        [{ files: { setup: { name: 'ASSCRACK-1.0.2-setup.exe', size: 1, sha256: hash } } }, 'bad file name'],
        [{ files: { setup: { name: 'ASSCRACK-1.0.1-setup.exe', size: 0, sha256: hash } } }, 'bad file size'],
        [{ files: { setup: { name: 'ASSCRACK-1.0.1-setup.exe', size: 2 ** 40, sha256: hash } } }, 'bad file size'],
        [{ files: { setup: { name: 'ASSCRACK-1.0.1-setup.exe', size: 1, sha256: 'A'.repeat(64) } } }, 'bad file hash']
    ];
    for (const [extra, reason] of cases) {
        const bytes = bytesOf(manifest('1.0.1', extra));
        assert.deepEqual(check(bytes, signText(bytes)), { ok: false, reason }, reason);
    }
    const notJson = Buffer.from('not json');
    assert.deepEqual(check(notJson, signText(notJson)), { ok: false, reason: 'not JSON' });
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytesOf(manifest())]);
    assert.equal(check(bom, signText(bom)).ok, false);
});

test('a file is good only when the size and the SHA-256 agree with the signed entry', () => {
    const entry = manifest().files.setup;
    assert.equal(fileMatches(entry, 1000, hash), true);
    assert.equal(fileMatches(entry, 999, hash), false);
    assert.equal(fileMatches(entry, 1000, 'b'.repeat(64)), false);
    assert.equal(fileMatches(null, 1000, hash), false);
    assert.equal(fileName('1.0.1', 'portable'), 'ASSCRACK-1.0.1-portable.exe');
    assert.throws(() => fileName('1.0.1', 'zip'));
});

test('the public key in the source is a valid Ed25519 key text', () => {
    assert.match(UPDATE_PUBLIC_KEY, /^[A-Za-z0-9_-]{43}$/);
    const bytes = bytesOf(manifest());
    // The source key did not make this signature.
    assert.equal(verifyManifest(bytes, signText(bytes), { publicKey: UPDATE_PUBLIC_KEY, currentVersion: '1.0.0' }).ok, false);
});
