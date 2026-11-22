// P9C: the key script and the sign script (tools/update-key.mjs, tools/sign-update.mjs), and the release check of the
// public key. Each key of this file is a new throwaway key in a temporary folder.
//
// The freeze check: `ASSCRACK_RELEASE=1 node --test test/update-release.test.mjs` fails while
// src/application/update-key.mjs has the test key or package.json has a test version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPDATE_KEY_IS_TEST } from '../src/application/update-key.mjs';
import { parseVersion, verifyManifest } from '../src/application/update-manifest.mjs';
import { manifestBytes, releaseProblems, signBytes } from '../tools/sign-update.mjs';
import { insideGitTree } from '../tools/update-key.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...args], { encoding: 'utf8' });

test('the release check stops the test key, a pre-release version and a missing file', () => {
    assert.deepEqual(releaseProblems({ isTestKey: false, version: '1.0.0', kinds: ['setup', 'portable'] }), []);
    const problems = releaseProblems({ isTestKey: true, version: '1.0.1-test', kinds: ['portable'] });
    assert.equal(problems.length, 3);
    assert.match(problems.join(' '), /test key/);
    assert.match(problems.join(' '), /pre-release/);
    assert.match(problems.join(' '), /setup file is missing/);
    // --check-release gives the state of the source key: exit code 1 while the test key is in the source.
    const check = run('sign-update.mjs', ['--check-release']);
    assert.equal(check.status, UPDATE_KEY_IS_TEST ? 1 : 0, check.stderr + check.stdout);
});

test('the freeze check: no test key and no test version in the source (only with ASSCRACK_RELEASE=1)', { skip: process.env.ASSCRACK_RELEASE !== '1' }, () => {
    assert.equal(UPDATE_KEY_IS_TEST, false, 'src/application/update-key.mjs has the test key');
    const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    assert.deepEqual(parseVersion(version)?.pre, [], `package.json has the version ${version}`);
});

test('a signed manifest of the sign script passes the app check, and its exact bytes are signed', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const bytes = manifestBytes({ version: '1.0.1', date: '2026-12-01', notes: 'Line 1\nLine 2',
        files: { setup: { name: 'ASSCRACK-1.0.1-setup.exe', size: 3, sha256: 'b'.repeat(64) } } });
    const sig = signBytes(bytes, privateKey);
    const r = verifyManifest(bytes, sig, { publicKey: publicKey.export({ format: 'jwk' }).x, currentVersion: '1.0.0' });
    assert.equal(r.ok, true);
    assert.equal(r.manifest.notes, 'Line 1\nLine 2');
});

test('the key script refuses a folder in a Git work tree and a key that exists, and never prints the private key', t => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'asscrack-key-test-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    assert.equal(insideGitTree(ROOT), true);
    assert.equal(insideGitTree(path.join(ROOT, 'src')), true);
    const inRepo = run('update-key.mjs', ['--out', path.join(ROOT, 'no-key-here')]);
    assert.equal(inRepo.status, 1);
    assert.match(inRepo.stderr, /Git work tree/);
    assert.equal(existsSync(path.join(ROOT, 'no-key-here')), false);
    if (insideGitTree(folder)) { t.skip('the temporary folder is in a Git work tree on this PC'); return; }
    const made = run('update-key.mjs', ['--out', folder]);
    assert.equal(made.status, 0, made.stderr);
    const pem = readFileSync(path.join(folder, 'update-key.pem'), 'utf8');
    assert.match(pem, /BEGIN PRIVATE KEY/);
    const body = pem.split('\n').filter(line => line && !line.startsWith('-----')).join('');
    assert.ok(!made.stdout.includes(body.slice(0, 20)), 'the private key is not in the output');
    assert.match(made.stdout, /export const UPDATE_PUBLIC_KEY = '[A-Za-z0-9_-]{43}';/);
    assert.match(made.stdout, /export const UPDATE_KEY_IS_TEST = false;/);
    const again = run('update-key.mjs', ['--out', folder]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /exists/);
    assert.equal(readFileSync(path.join(folder, 'update-key.pem'), 'utf8'), pem, 'the key did not change');
    const pub = run('update-key.mjs', ['--public', '--out', folder]);
    assert.equal(pub.stdout.split('\n')[0], made.stdout.split('\n').find(line => line.startsWith('export const UPDATE_PUBLIC_KEY')));
});

test('the sign script refuses a key that does not agree with the source key, and refuses a release with the test key', t => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'asscrack-sign-test-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    if (insideGitTree(folder)) { t.skip('the temporary folder is in a Git work tree on this PC'); return; }
    const dist = path.join(folder, 'dist');
    mkdirSync(dist);
    writeFileSync(path.join(dist, 'ASSCRACK-1.0.1-test-portable.exe'), 'portable');
    const key = path.join(folder, 'other.pem');
    writeFileSync(key, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const wrong = run('sign-update.mjs', [dist, '--test', '--version', '1.0.1-test', '--notes', 'n', '--key', key]);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /does not agree with the public key/);
    assert.equal(existsSync(path.join(dist, 'update.json')), false);
    const release = run('sign-update.mjs', [dist, '--version', '1.0.1-test', '--notes', 'n', '--key', key]);
    assert.equal(release.status, 1);
    if (UPDATE_KEY_IS_TEST) assert.match(release.stderr, /test key/);
    assert.match(release.stderr, /pre-release/);
    const inRepo = run('sign-update.mjs', [dist, '--test', '--version', '1.0.1-test', '--notes', 'n', '--key', path.join(ROOT, 'package.json')]);
    assert.equal(inRepo.status, 1);
    assert.match(inRepo.stderr, /Git work tree/);
    // The help text of the script runs with no error.
    assert.equal(run('sign-update.mjs', []).status, 1);
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'tools', 'sign-update.mjs')]);
});
