// P9C: write update.json and update.json.sig for a release (the operator's step, docs/RELEASE_UPDATES.md).
//
// Usage:
//   node tools/sign-update.mjs <dist folder> (--notes <text> | --notes-file <file>) [--key <pem>] [--version <v>]
//                              [--date YYYY-MM-DD] [--test]
//   node tools/sign-update.mjs --check-release
//
// The script reads ASSCRACK-<v>-setup.exe and ASSCRACK-<v>-portable.exe in the dist folder (v: package.json
// "version" when --version is not given), writes update.json (version, date, notes, and the name, size and SHA-256 of
// each file), and signs its exact bytes with the private key (default %USERPROFILE%\.asscrack-release\update-key.pem).
// Then it checks the signature with the public key of src/application/update-key.mjs: a different key stops the run.
//
// Release checks (always, except with --test): the public key in the source is not the test key, the version has no
// pre-release part, and both files are there. --check-release does only the key check (for the 1.0.0 freeze).
// --test is for the local test release of the P9C checks: a test key, a test version and one file are permitted.
//
// Exit code 0: done. 1: refused or failed.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UPDATE_KEY_IS_TEST, UPDATE_PUBLIC_KEY } from '../src/application/update-key.mjs';
import { fileName, KINDS, MANIFEST_FORMAT, MAX_NOTES, parseVersion, PRODUCT, verifyManifest } from '../src/application/update-manifest.mjs';
import { defaultKeyFolder, insideGitTree, KEY_FILE } from './update-key.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The problems that stop a release. An empty list: the release can go out.
export function releaseProblems({ isTestKey, version, kinds }) {
    const problems = [];
    if (isTestKey) problems.push('The public key in src/application/update-key.mjs is the test key. Put the operator key in it first.');
    const parsed = parseVersion(version);
    if (!parsed) problems.push(`The version ${version} is not valid.`);
    else if (parsed.pre.length > 0) problems.push(`The version ${version} has a pre-release part.`);
    for (const kind of KINDS) if (!kinds.includes(kind)) problems.push(`The ${kind} file is missing.`);
    return problems;
}

// The bytes of update.json. The key order is fixed; the app checks the signature of these exact bytes.
export function manifestBytes({ version, date, notes, files }) {
    const value = { product: PRODUCT, format: MANIFEST_FORMAT, version, date, notes, files };
    return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function signBytes(bytes, privateKey) {
    return sign(null, bytes, privateKey).toString('base64');
}

async function fileEntry(file, name) {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(file)) {
        hash.update(chunk);
        size += chunk.length;
    }
    return { name, size, sha256: hash.digest('hex') };
}

function option(argv, name) {
    const index = argv.indexOf(name);
    return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : null;
}

async function main(argv) {
    if (argv.includes('--check-release')) {
        if (UPDATE_KEY_IS_TEST) {
            console.error('FAIL: the public key in src/application/update-key.mjs is the test key.');
            return 1;
        }
        console.log('PASS: the public key in src/application/update-key.mjs is not the test key.');
        return 0;
    }
    const test = argv.includes('--test');
    const dist = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : null;
    if (!dist || !existsSync(dist) || !statSync(dist).isDirectory()) {
        console.error('Usage: node tools/sign-update.mjs <dist folder> (--notes <text> | --notes-file <file>) [--key <pem>] [--version <v>] [--date YYYY-MM-DD] [--test]');
        return 1;
    }
    const version = option(argv, '--version') ?? JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const notesFile = option(argv, '--notes-file');
    const notes = (notesFile ? readFileSync(notesFile, 'utf8') : option(argv, '--notes') ?? '').replace(/\r\n/g, '\n').trim();
    if (!notes) { console.error('Give the note text with --notes or --notes-file.'); return 1; }
    if (notes.length > MAX_NOTES) { console.error(`The note text has more than ${MAX_NOTES} characters.`); return 1; }
    const date = option(argv, '--date') ?? new Date().toISOString().slice(0, 10);
    const keyFile = path.resolve(option(argv, '--key') ?? path.join(defaultKeyFolder(), KEY_FILE));
    if (insideGitTree(path.dirname(keyFile))) {
        console.error(`Refused: the key ${keyFile} is in a Git work tree. Move it out of each repository.`);
        return 1;
    }
    const kinds = KINDS.filter(kind => existsSync(path.join(dist, fileName(version, kind))));
    const problems = test ? (kinds.length === 0 ? ['No ASSCRACK file of this version is in the folder.'] : [])
        : releaseProblems({ isTestKey: UPDATE_KEY_IS_TEST, version, kinds });
    if (problems.length > 0) {
        for (const problem of problems) console.error(`Refused: ${problem}`);
        return 1;
    }
    const files = {};
    for (const kind of kinds) {
        const name = fileName(version, kind);
        files[kind] = await fileEntry(path.join(dist, name), name);
    }
    const bytes = manifestBytes({ version, date, notes, files });
    const signature = signBytes(bytes, createPrivateKey(readFileSync(keyFile, 'utf8')));
    const check = verifyManifest(bytes, signature, { publicKey: UPDATE_PUBLIC_KEY, newerOnly: false });
    if (!check.ok) {
        console.error(`Refused: the signature does not agree with the public key in src/application/update-key.mjs (${check.reason}).`);
        return 1;
    }
    writeFileSync(path.join(dist, 'update.json'), bytes);
    writeFileSync(path.join(dist, 'update.json.sig'), signature + '\n');
    console.log(`Wrote update.json and update.json.sig for ASSCRACK ${version} (${kinds.join(', ')}) in ${dist}.`);
    for (const kind of kinds) console.log(`  ${files[kind].name}  ${files[kind].size} bytes  SHA-256 ${files[kind].sha256}`);
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
        console.error(`Failed: ${err?.message ?? err}`);
        process.exitCode = 1;
    });
}
