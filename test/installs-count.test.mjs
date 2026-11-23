// The number of the installs badge (tools/installs-count.mjs, workflow .github/workflows/installs-badge.yml).
// fixtures/github-releases.json: the releases of noveblue53/asscrack from GET /repos/{owner}/{repo}/releases on
// 2026-11-23 (the fields of the API, some fields removed), with two drafts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { badgeJson, countInstalls, fetchReleases, isInstallFile } from '../tools/installs-count.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'github-releases.json');
const releases = JSON.parse(readFileSync(FIXTURE, 'utf8'));

const asset = (name, download_count) => ({ name, download_count, state: 'uploaded' });
const rel = (tag, assets, draft = false) => ({ tag_name: tag, draft, prerelease: false, assets });

test('only the -setup.exe and -portable.exe files count, not the update files and not the download copies', () => {
    for (const name of ['ASSCRACK-1.0.4-setup.exe', 'ASSCRACK-1.0.4-portable.exe']) assert.equal(isInstallFile(name), true, name);
    for (const name of ['update.json', 'update.json.sig', 'ASSCRACK-1.0.5-update.exe', 'ASSCRACK-1.0.5-portable-update.exe',
        'ASSCRACK-1.0.4-setup.exe.blockmap', 'ASSCRACK-0.7.0-friend-pilot-rc1-42cf3c6-windows-runner-x64.exe', '', null]) {
        assert.equal(isInstallFile(name), false, String(name));
    }
});

test('the count of the fixture of the real API is the sum of the install files of the releases that are not drafts', () => {
    // v1.0.1 to v1.0.4: setup 1 + 5 + 3 + 3, portable 1 + 1 + 1 + 1. The update.json files (46) and the drafts are out.
    assert.equal(countInstalls(releases), 16);
    // The pages of gh api --paginate --slurp give the same number.
    assert.equal(countInstalls([releases.slice(0, 3), releases.slice(3)]), 16);
});

test('a draft and a release with no draft field do not count; a pre-release counts; a bad count stops the run', () => {
    const list = [
        rel('v1.0.5', [asset('ASSCRACK-1.0.5-setup.exe', 4), asset('ASSCRACK-1.0.5-update.exe', 9), asset('ASSCRACK-1.0.5-portable.exe', 2),
            asset('ASSCRACK-1.0.5-portable-update.exe', 7), asset('update.json', 30), asset('update.json.sig', 30)]),
        rel('v1.0.6', [asset('ASSCRACK-1.0.6-setup.exe', 100)], true),
        { tag_name: 'v1.0.7', assets: [asset('ASSCRACK-1.0.7-setup.exe', 100)] },
        { ...rel('v1.1.0-beta', [asset('ASSCRACK-1.1.0-beta-setup.exe', 1)]), prerelease: true },
        rel('v1.1.0', [])
    ];
    assert.equal(countInstalls(list), 7);
    assert.equal(countInstalls([]), 0);
    assert.throws(() => countInstalls([rel('v1', [asset('ASSCRACK-1.0.0-setup.exe', -1)])]), TypeError);
    assert.throws(() => countInstalls([rel('v1', [asset('ASSCRACK-1.0.0-setup.exe', '5')])]), TypeError);
    assert.throws(() => countInstalls({}), TypeError);
});

test('the badge JSON is the shields.io endpoint format', () => {
    assert.deepEqual(JSON.parse(badgeJson(16)), { schemaVersion: 1, label: 'installs', message: '16', color: '07536b' });
    assert.doesNotMatch(badgeJson(16), /\n/);
    assert.throws(() => badgeJson(-1), TypeError);
    assert.throws(() => badgeJson(1.5), TypeError);
});

test('the API read gets all pages with the token, and stops on an error status', async () => {
    const pages = [Array.from({ length: 100 }, (_, i) => rel(`v0.0.${i}`, [asset(`ASSCRACK-0.0.${i}-setup.exe`, 1)])),
        [rel('v1.0.0', [asset('ASSCRACK-1.0.0-portable.exe', 5)])]];
    const calls = [];
    const fetchFn = async (url, options) => {
        calls.push({ url, auth: options.headers.Authorization });
        const page = Number(new URL(url).searchParams.get('page'));
        return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
    };
    const list = await fetchReleases({ api: 'https://api.example', repository: 'noveblue53/asscrack', token: 't', fetchFn });
    assert.equal(countInstalls(list), 105);
    assert.deepEqual(calls.map(c => c.url), ['https://api.example/repos/noveblue53/asscrack/releases?per_page=100&page=1',
        'https://api.example/repos/noveblue53/asscrack/releases?per_page=100&page=2']);
    assert.ok(calls.every(c => c.auth === 'Bearer t'));
    await assert.rejects(fetchReleases({ api: 'https://api.example', repository: 'noveblue53/asscrack', token: '',
        fetchFn: async () => new Response('no', { status: 403 }) }), /403/);
    await assert.rejects(fetchReleases({ api: 'https://api.example', repository: '../x', fetchFn }), TypeError);
});

test('the script reads a file and prints the number or the badge JSON', () => {
    const script = path.join(ROOT, 'tools', 'installs-count.mjs');
    assert.equal(execFileSync(process.execPath, [script, '--file', FIXTURE], { encoding: 'utf8' }).trim(), '16');
    const json = execFileSync(process.execPath, [script, '--file', FIXTURE, '--json'], { encoding: 'utf8' }).trim();
    assert.deepEqual(JSON.parse(json), { schemaVersion: 1, label: 'installs', message: '16', color: '07536b' });
});
