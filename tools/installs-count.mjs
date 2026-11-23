// The number of the installs badge in README.md (workflow .github/workflows/installs-badge.yml).
//
// Usage:
//   node tools/installs-count.mjs [--file <releases.json>] [--json]
//
// The number is the sum of download_count of the release files with a name that ends in -setup.exe or -portable.exe,
// over all releases that are not drafts. The update checks (update.json, update.json.sig) and the update downloads
// (ASSCRACK-<v>-update.exe, ASSCRACK-<v>-portable-update.exe, docs/RELEASE_UPDATES.md) are not in the number.
//
// With --file, the script reads the releases from a file: the array of GET /repos/<owner>/<repo>/releases, or an
// array of these pages (gh api --paginate --slurp). Without --file, it reads all pages from the GitHub REST API
// (GITHUB_API_URL, GITHUB_REPOSITORY, and the token in GH_TOKEN or GITHUB_TOKEN; the request only reads).
// Output: the number, or with --json the shields.io endpoint JSON of the badge (one line).
//
// Exit code 0: done. 1: failed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const COUNTED = Object.freeze(['-setup.exe', '-portable.exe']);
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

// True for the name of a file that the badge counts.
export function isInstallFile(name) {
    return typeof name === 'string' && COUNTED.some(end => name.endsWith(end));
}

// The sum of the counted downloads. releases: the releases of the API, or an array of pages of releases.
export function countInstalls(releases) {
    if (!Array.isArray(releases)) throw new TypeError('The releases are not an array');
    let total = 0;
    for (const release of releases.flat()) {
        if (release === null || typeof release !== 'object' || release.draft !== false) continue;
        for (const asset of Array.isArray(release.assets) ? release.assets : []) {
            if (!isInstallFile(asset?.name)) continue;
            const count = asset.download_count;
            if (!Number.isSafeInteger(count) || count < 0) throw new TypeError(`The download count of ${asset.name} is not valid`);
            total += count;
        }
    }
    return total;
}

// The shields.io endpoint JSON (https://shields.io/badges/endpoint-badge).
export function badgeJson(total) {
    if (!Number.isSafeInteger(total) || total < 0) throw new TypeError('The count is not valid');
    return JSON.stringify({ schemaVersion: 1, label: 'installs', message: String(total), color: '07536b' });
}

// All releases of the repository from the API (all pages).
export async function fetchReleases({ api, repository, token, fetchFn = fetch }) {
    if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repository ?? '')) throw new TypeError('The repository name is not valid');
    const releases = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'asscrack-installs-badge' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetchFn(`${api}/repos/${repository}/releases?per_page=${PAGE_SIZE}&page=${page}`, { headers });
        if (!response.ok) throw new Error(`The API gave the status ${response.status}`);
        const list = await response.json();
        if (!Array.isArray(list)) throw new TypeError('The API answer is not an array');
        releases.push(...list);
        if (list.length < PAGE_SIZE) return releases;
    }
    throw new Error(`More than ${MAX_PAGES} pages of releases`);
}

function option(argv, name) {
    const index = argv.indexOf(name);
    return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : null;
}

async function main(argv) {
    const file = option(argv, '--file');
    const releases = file ? JSON.parse(readFileSync(file, 'utf8')) : await fetchReleases({
        api: process.env.GITHUB_API_URL || 'https://api.github.com',
        repository: process.env.GITHUB_REPOSITORY || 'noveblue53/asscrack',
        token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
    });
    const total = countInstalls(releases);
    console.log(argv.includes('--json') ? badgeJson(total) : String(total));
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
        console.error(`Failed: ${err?.message ?? err}`);
        process.exitCode = 1;
    });
}
